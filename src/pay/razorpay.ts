// Razorpay implementation of PaymentProvider (Payment Links API). Docs followed, read 2026-10-17 (razorpay.com/docs):
//  - api/payments/payment-links/create-standard  (POST /v1/payment_links; amount in paise; reference_id <= 40 chars, unique per link;
//    expire_by Unix seconds, "at least 15 minutes in the future"; notify.sms / notify.email false = "you handle the notification";
//    customer.contact 8-14 chars; response id "plink_..." and short_url; status created|partially_paid|expired|cancelled|paid)
//  - api/payments/payment-links/fetch-id-standard  (GET /v1/payment_links/{plink id}; `payments` is null until a payment is captured, then
//    [{payment_id, amount, status: "captured", method, created_at}])
//  - api/payments/payment-links/fetch-all-standard  (GET /v1/payment_links?reference_id=...: lets us find a link by OUR id)
//  - api/refunds/create-normal  (POST /v1/payments/{payment id}/refund; amount, speed, notes, receipt. A repeated `receipt` on the same
//    payment is refused with 400 "Duplicate receipt found for this refund request", which is the documented idempotency handle.)
//  - api/refunds/fetch-multiple-refund-payment  (GET /v1/payments/{id}/refunds?count=100; items carry id, receipt, notes, status pending|processed|failed)
//  - webhooks/validate-test  (header X-Razorpay-Signature = hex HMAC-SHA256 of the RAW body keyed with the webhook secret;
//    header x-razorpay-event-id is unique per event, "use it to spot duplicates")
//  - webhooks/refunds  (refund.processed / refund.failed: payload.refund.entity.{id, payment_id, status, receipt, notes})
// Not confirmed (the payment-links webhook page would not load): the exact payload of payment_link.paid / expired / cancelled. This code
// reads payload.payment_link.entity.{reference_id, amount_paid, currency} and payload.payment.entity.{id, amount, currency}, accepts
// missing pieces, and the cron's status read (getStatus) repairs anything a webhook leaves out.
import { z } from "zod";
import { config } from "../config";
import type { Env } from "../env";
import type { CreateLinkArgs, LinkState, PayStatus, PaymentProvider, RefundResult, RefundStatus, VerifyResult } from "./provider";

const LINK_STATES: Record<string, LinkState> = { created: "ACTIVE", paid: "PAID", partially_paid: "PARTIALLY_PAID", expired: "EXPIRED", cancelled: "CANCELLED" };
const toState = (s: unknown): LinkState => (typeof s === "string" ? LINK_STATES[s] : undefined) ?? "UNKNOWN";
const toRefundStatus = (s: unknown): RefundStatus => (s === "processed" ? "SUCCESS" : s === "failed" ? "FAILED" : "PENDING"); // pending: keep polling

// Test and live keys are told apart by their prefix; the Worker's PAYMENT_MODE must agree with the key it holds.
export const keyMode = (keyId: string | undefined): "test" | "live" | undefined =>
  keyId?.startsWith("rzp_test_") ? "test" : keyId?.startsWith("rzp_live_") ? "live" : undefined;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const paymentEntity = z.object({ id: z.string().optional(), amount: z.number().optional(), currency: z.string().optional() });
const linkEvent = z.object({
  event: z.string(),
  payload: z.object({
    payment_link: z.object({
      entity: z.object({ reference_id: z.string().min(1), amount_paid: z.number().optional(), currency: z.string().optional() }),
    }),
    payment: z.object({ entity: paymentEntity }).optional(),
  }),
});
const refundEvent = z.object({
  event: z.string(),
  payload: z.object({
    refund: z.object({
      entity: z.object({
        id: z.string().min(1),
        status: z.string().optional(),
        receipt: z.string().nullish(),
        notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
      }),
    }),
  }),
});

type LinkRow = { id?: string; reference_id?: string; status?: string; amount_paid?: number; currency?: string; payments?: { payment_id?: string; status?: string }[] | null };
type RefundRow = { id?: string; receipt?: string | null; notes?: unknown; status?: string };

export function razorpay(env: Env): PaymentProvider {
  const base = config.razorpay.baseUrl;
  const auth = () => "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const mode = keyMode(env.RAZORPAY_KEY_ID);

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: auth(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`razorpay ${method} ${path.split("?")[0]} -> ${r.status}`);
    return r.data;
  };

  // The refund we made for this payment with this receipt, if Razorpay has one (receipt, or the same id in notes).
  const findRefund = async (paymentId: string, refundId: string): Promise<RefundRow | null> => {
    const data = await ok("GET", `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    const items = (Array.isArray(data?.items) ? data.items : []) as RefundRow[];
    return items.find((r) => r.receipt === refundId || (r.notes as { refund_id?: unknown } | null | undefined)?.refund_id === refundId) ?? null;
  };
  const asResult = (r: RefundRow, refundId: string): RefundResult => ({ providerRefundId: r.id || refundId, status: toRefundStatus(r.status) });

  return {
    async createLink(a: CreateLinkArgs) {
      if (!mode || mode !== (env.PAYMENT_MODE === "live" ? "live" : "test")) throw new Error("razorpay createLink: key does not match PAYMENT_MODE");
      const data = await ok("POST", "/payment_links", {
        amount: a.amountPaise,
        currency: config.currency,
        accept_partial: false,
        reference_id: a.linkId, // our id; Razorpay makes its own plink_ id
        description: a.purpose,
        customer: { name: a.customerName, contact: a.customerPhone },
        notify: { sms: false, email: false }, // we send the link on WhatsApp
        reminder_enable: false,
        expire_by: Math.floor(Date.parse(a.expiresAtUtc) / 1000),
        notes: { link_id: a.linkId },
      });
      const url = data?.short_url;
      if (typeof url !== "string" || !url) throw new Error("razorpay createLink: no short_url");
      return { linkId: a.linkId, url };
    },

    // linkId is OUR id: the link is found by reference_id (Razorpay's own plink_ id is not stored).
    async getStatus(linkId: string): Promise<PayStatus> {
      const list = await ok("GET", `/payment_links?reference_id=${encodeURIComponent(linkId)}`);
      const rows = (Array.isArray(list?.payment_links) ? list.payment_links : []) as LinkRow[];
      let link = rows.find((r) => r.reference_id === linkId);
      if (!link) return { linkId, status: "UNKNOWN", paidPaise: 0, currency: "", mode };
      const status = toState(link.status);
      if ((status === "PAID" || status === "PARTIALLY_PAID") && !link.payments?.length && link.id) {
        link = ((await ok("GET", `/payment_links/${encodeURIComponent(link.id)}`)) as LinkRow | null) ?? link;
      }
      // The payment id is what a refund needs, so it travels as orderId.
      const orderId = link.payments?.find((p) => p.status === "captured")?.payment_id;
      return { linkId, status, paidPaise: Number(link.amount_paid ?? 0), currency: String(link.currency ?? ""), orderId, mode };
    },

    async verifyWebhook(raw: string, h: Headers): Promise<VerifyResult> {
      const sig = h.get("x-razorpay-signature");
      if (!env.RAZORPAY_WEBHOOK_SECRET || !sig || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "SIGNATURE" };
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.RAZORPAY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      const sigBytes = Uint8Array.from(sig.match(/../g)!, (x) => parseInt(x, 16));
      // subtle.verify compares in constant time; nothing is parsed before it passes.
      if (!(await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(raw)))) return { ok: false, reason: "SIGNATURE" };

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "PAYLOAD" };
      }
      const event = (json as { event?: unknown } | null)?.event;
      // Replays are told apart by x-razorpay-event-id; without it the body itself is the key (same body = same event).
      const key2 = h.get("x-razorpay-event-id") || `body:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))}`;

      if (event === "refund.processed" || event === "refund.failed") {
        const r = refundEvent.safeParse(json);
        if (!r.success) return { ok: false, reason: "PAYLOAD" };
        const e = r.data.payload.refund.entity;
        const noteId = Array.isArray(e.notes) ? undefined : e.notes?.refund_id;
        const refundId = e.receipt || (typeof noteId === "string" ? noteId : e.id); // unknown to us -> UNKNOWN_REFUND attention
        return { ok: true, refund: { key: key2, refundId, status: event === "refund.processed" ? "SUCCESS" : "FAILED" } };
      }
      const status = event === "payment_link.paid" ? "PAID" : event === "payment_link.expired" ? "EXPIRED" : event === "payment_link.cancelled" ? "CANCELLED" : null;
      if (!status) return { ok: true, ignored: true }; // signed, but an event we do not act on
      const p = linkEvent.safeParse(json);
      if (!p.success) return { ok: false, reason: "PAYLOAD" };
      const link = p.data.payload.payment_link.entity;
      const pay = p.data.payload.payment?.entity;
      return {
        ok: true,
        event: {
          key: key2,
          linkId: link.reference_id,
          status,
          paidPaise: status === "PAID" ? (link.amount_paid ?? pay?.amount ?? 0) : 0,
          currency: link.currency ?? pay?.currency ?? "",
          orderId: pay?.id,
          // No mode here: a webhook is signed with this account's secret, and getStatus reports the mode from the key.
        },
      };
    },

    // orderId is the payment id (pay_...). receipt = our refundId: Razorpay refuses a second refund with the same receipt on a payment.
    async refund(a) {
      const r = await call("POST", `/payments/${encodeURIComponent(a.orderId)}/refund`, {
        amount: a.amountPaise,
        speed: "normal",
        receipt: a.refundId,
        notes: { refund_id: a.refundId, reason: a.note },
      });
      if (r.status >= 200 && r.status < 300) return asResult({ id: String(r.data?.id ?? ""), status: String(r.data?.status ?? "") }, a.refundId);
      const description = String((r.data?.error as { description?: unknown } | undefined)?.description ?? "");
      if (r.status === 400 && /duplicate receipt/i.test(description)) {
        // We already made this refund (a retry after a lost answer): report it, never make a second one.
        const existing = await findRefund(a.orderId, a.refundId);
        if (existing) return asResult(existing, a.refundId);
      }
      throw new Error(`razorpay POST /payments/refund -> ${r.status}`);
    },

    async getRefund(orderId, refundId) {
      const found = await findRefund(orderId, refundId);
      return found ? asResult(found, refundId) : { status: "NOT_FOUND" };
    },
  };
}
