// Cashfree implementation of PaymentProvider (Payment Links API).
// Docs followed (docs.cashfree.com now redirects to www.cashfree.com/docs), read 2026-10-02:
//  - api-reference/payments/latest/payment-links/create-payment-link  (POST /pg/links; link_id <= 50 chars [A-Za-z0-9_-];
//    link_amount in rupees with up to 2 decimals; link_expiry_time ISO 8601; response has link_url, link_status)
//  - api-reference/payments/latest/payment-links/get-orders-for-link  (GET /pg/links/{id}/orders; order_status ACTIVE|PAID|EXPIRED)
//  - api-reference/payments/latest/payment-links/webhooks  (type PAYMENT_LINK_EVENT; link_status PAID|PARTIALLY_PAID|EXPIRED|CANCELLED;
//    amounts are rupee strings; `order` is null for expired/cancelled links)
//  - payments/online/webhooks/signature-verification  (headers x-webhook-timestamp + x-webhook-signature;
//    signature = base64(HMAC-SHA256(timestamp + rawBody)) keyed with the PG SECRET KEY)
//  - api-reference/payments/latest/refunds/create-refund  (POST /pg/orders/{order_id}/refunds; refund_id, refund_amount, refund_note, refund_speed)
// Not confirmed in the docs: the exact minimum link expiry (config.cashfree.minLinkExpiryMinutes is an assumption)
// and the GET /pg/links/{id} response shape beyond the create response (same fields are assumed).
import { z } from "zod";
import { config } from "../config";
import type { Env } from "../env";
import type { CreateLinkArgs, LinkState, PayStatus, PaymentProvider, VerifyResult } from "./provider";

const STATES: LinkState[] = ["ACTIVE", "PAID", "PARTIALLY_PAID", "EXPIRED", "CANCELLED"];
const toState = (s: unknown): LinkState => (STATES.includes(s as LinkState) ? (s as LinkState) : "UNKNOWN");
const toPaise = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const modeOf = (url: unknown): "test" | "live" | undefined =>
  typeof url !== "string" ? undefined : /payments-test\./.test(url) ? "test" : "live";

// Cashfree wants an offset time; IST is a fixed +05:30.
function istStamp(utc: string): string {
  const d = new Date(Date.parse(utc) + 330 * 60_000);
  return d.toISOString().slice(0, 19) + "+05:30";
}

const webhookSchema = z.object({
  type: z.string(),
  event_time: z.string().optional(),
  data: z.object({
    link_id: z.string().min(1),
    link_status: z.string(),
    link_currency: z.string().optional(),
    link_amount_paid: z.union([z.string(), z.number()]).optional(),
    link_url: z.string().optional(),
    order: z.object({ order_id: z.string().optional(), transaction_id: z.union([z.string(), z.number()]).optional() }).nullish(),
  }),
});

export function cashfree(env: Env): PaymentProvider {
  const base = env.PAYMENT_MODE === "live" ? config.cashfree.liveBase : config.cashfree.sandboxBase;
  const headers = () => ({
    "x-api-version": config.cashfree.apiVersion,
    "x-client-id": env.CASHFREE_APP_ID,
    "x-client-secret": env.CASHFREE_SECRET,
    "Content-Type": "application/json",
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(`cashfree ${method} ${path.split("?")[0]} -> ${res.status}`);
    return data;
  };

  return {
    async createLink(a: CreateLinkArgs) {
      const data = await call("POST", "/links", {
        link_id: a.linkId,
        link_amount: a.amountPaise / 100,
        link_currency: config.currency,
        link_purpose: a.purpose,
        customer_details: { customer_name: a.customerName, customer_phone: a.customerPhone },
        link_partial_payments: false,
        link_expiry_time: istStamp(a.expiresAtUtc),
        link_auto_reminders: false,
        link_notify: { send_sms: false, send_email: false },
      });
      const url = data?.link_url;
      if (typeof url !== "string" || !url) throw new Error("cashfree createLink: no link_url");
      return { linkId: a.linkId, url };
    },

    async getStatus(linkId: string): Promise<PayStatus> {
      const link = await call("GET", `/links/${encodeURIComponent(linkId)}`);
      const status = toState(link?.link_status);
      const out: PayStatus = {
        linkId,
        status,
        paidPaise: toPaise(link?.link_amount_paid),
        currency: String(link?.link_currency ?? ""),
        mode: modeOf(link?.link_url),
      };
      if (status === "PAID" || status === "PARTIALLY_PAID") {
        const orders = (await call("GET", `/links/${encodeURIComponent(linkId)}/orders?status=PAID`)) as unknown;
        const list = (Array.isArray(orders) ? orders : ((orders as { data?: unknown[] } | null)?.data ?? [])) as { order_id?: string; order_status?: string }[];
        out.orderId = list.find((o) => o.order_status === "PAID")?.order_id;
      }
      return out;
    },

    async verifyWebhook(raw: string, h: Headers): Promise<VerifyResult> {
      const ts = h.get("x-webhook-timestamp");
      const sig = h.get("x-webhook-signature");
      // Cashfree signs with the PG secret key, not a separate webhook secret (see STATUS.md).
      if (!env.CASHFREE_SECRET || !ts || !sig) return { ok: false, reason: "SIGNATURE" };
      let sigBytes: Uint8Array;
      try {
        sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
      } catch {
        return { ok: false, reason: "SIGNATURE" };
      }
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CASHFREE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      // subtle.verify compares in constant time.
      if (!(await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(ts + raw)))) return { ok: false, reason: "SIGNATURE" };

      let parsed;
      try {
        parsed = webhookSchema.safeParse(JSON.parse(raw));
      } catch {
        return { ok: false, reason: "PAYLOAD" };
      }
      if (!parsed.success || parsed.data.type !== "PAYMENT_LINK_EVENT") return { ok: false, reason: "PAYLOAD" };
      const d = parsed.data.data;
      const orderId = d.order?.order_id;
      return {
        ok: true,
        event: {
          key: [d.link_id, d.link_status, d.order?.transaction_id ?? orderId ?? "-", parsed.data.event_time ?? ts].join(":"),
          linkId: d.link_id,
          status: toState(d.link_status),
          paidPaise: toPaise(d.link_amount_paid),
          currency: d.link_currency ?? "",
          orderId,
          mode: modeOf(d.link_url),
        },
      };
    },

    async refund(a) {
      const data = await call("POST", `/orders/${encodeURIComponent(a.orderId)}/refunds`, {
        refund_id: a.refundId,
        refund_amount: a.amountPaise / 100,
        refund_note: a.note,
        refund_speed: "STANDARD",
      });
      const id = data?.cf_refund_id;
      return { providerRefundId: id === undefined ? a.refundId : String(id), done: data?.refund_status === "SUCCESS" };
    },
  };
}
