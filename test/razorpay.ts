// Shared test helpers for the Razorpay provider: a fake Razorpay API and signed webhook builders.
// Everything here is synthetic: fake ids, fake keys (built from pieces so no scanner mistakes them for real ones), no network.
export const WEBHOOK_SECRET = "test-razorpay-webhook-secret";
export const TEST_KEY_ID = "rzp_" + "test_" + "FAKEKEY00000001";
export const LIVE_KEY_ID = "rzp_" + "live_" + "FAKEKEY00000002";

// The three Razorpay secrets for an Env. `live` picks a live-prefixed key (and the Worker's PAYMENT_MODE must say live too).
export const rzpEnv = (live = false) => ({
  PAYMENT_MODE: live ? "live" : "test",
  RAZORPAY_KEY_ID: live ? LIVE_KEY_ID : TEST_KEY_ID,
  RAZORPAY_KEY_SECRET: "test-razorpay-key-secret",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

type Link = { id: string; reference_id: string; status: string; amount: number; amount_paid: number; currency: string; payments: { payment_id: string; amount: number; status: string }[] | null };
type RefundRow = { id: string; payment_id: string; receipt: string | null; notes: Record<string, string>; amount: number; status: string };

export class FakeRazorpay {
  links = new Map<string, Link>(); // by our reference_id
  refunds: RefundRow[] = [];
  refundDown = false; // unreachable: the POST throws before anything is stored
  refundLostAnswer = false; // Razorpay stores the refund, but the answer never arrives
  refundStatusOnCreate = "pending";
  failRefundWith: { status: number; description: string } | null = null;
  failLinkCreateOnce = false;
  private n = 0;

  posts = (path: string) => this.log.filter((c) => c.method === "POST" && c.url.includes(path));
  log: { method: string; url: string; body: Record<string, unknown> | null; auth: string }[] = [];

  markPaid(ref: string, o: { paymentId?: string; amount?: number; currency?: string } = {}) {
    const l = this.links.get(ref)!;
    const amount = o.amount ?? l.amount;
    l.status = "paid";
    l.amount_paid = amount;
    if (o.currency) l.currency = o.currency;
    l.payments = [{ payment_id: o.paymentId ?? `pay_${ref.replace(/\W/g, "")}`, amount, status: "captured" }];
  }
  setStatus(ref: string, status: string) {
    this.links.get(ref)!.status = status;
  }

  // Returns a Response for a Razorpay URL, or null when the URL is not Razorpay's.
  handle(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Response | null {
    const u = new URL(url);
    if (u.host !== "api.razorpay.com") return null;
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.log.push({ method, url: u.pathname + u.search, body, auth: init.headers?.Authorization ?? "" });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const p = u.pathname.replace(/^\/v1/, "");

    if (method === "POST" && p === "/payment_links") {
      if (this.failLinkCreateOnce) {
        this.failLinkCreateOnce = false;
        return json({ error: { code: "SERVER_ERROR" } }, 500);
      }
      const ref = String(body!.reference_id);
      const link: Link = { id: `plink_FAKE${++this.n}`, reference_id: ref, status: "created", amount: Number(body!.amount), amount_paid: 0, currency: String(body!.currency), payments: null };
      this.links.set(ref, link);
      return json({ ...link, short_url: `https://rzp.io/i/${ref}` });
    }
    if (method === "GET" && p === "/payment_links") {
      const ref = u.searchParams.get("reference_id");
      const items = [...this.links.values()].filter((l) => l.reference_id === ref).map((l) => ({ ...l, payments: undefined })); // list rows omit `payments`
      return json({ entity: "collection", count: items.length, payment_links: items });
    }
    const one = /^\/payment_links\/([^/]+)$/.exec(p);
    if (method === "GET" && one) {
      const l = [...this.links.values()].find((x) => x.id === one[1]);
      return l ? json(l) : json({ error: { code: "BAD_REQUEST_ERROR" } }, 400);
    }
    const refundPost = /^\/payments\/([^/]+)\/refund$/.exec(p);
    if (method === "POST" && refundPost) {
      if (this.refundDown) throw new TypeError("network down");
      if (this.failRefundWith) return json({ error: { code: "BAD_REQUEST_ERROR", description: this.failRefundWith.description } }, this.failRefundWith.status);
      const receipt = String(body!.receipt ?? "");
      if (receipt && this.refunds.some((r) => r.payment_id === refundPost[1] && r.receipt === receipt)) {
        return json({ error: { code: "BAD_REQUEST_ERROR", description: "Duplicate receipt found for this refund request." } }, 400);
      }
      const row: RefundRow = { id: `rfnd_FAKE${++this.n}`, payment_id: refundPost[1], receipt: receipt || null, notes: (body!.notes ?? {}) as Record<string, string>, amount: Number(body!.amount), status: this.refundStatusOnCreate };
      this.refunds.push(row);
      if (this.refundLostAnswer) throw new TypeError("connection reset");
      return json({ ...row, entity: "refund" });
    }
    const refundList = /^\/payments\/([^/]+)\/refunds$/.exec(p);
    if (method === "GET" && refundList) {
      const items = this.refunds.filter((r) => r.payment_id === refundList[1]);
      return json({ entity: "collection", count: items.length, items });
    }
    return json({ error: { code: "BAD_REQUEST_ERROR", description: "unknown path" } }, 404);
  }
}

async function hmacHex(raw: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Headers for a webhook as Razorpay sends it. Same body => same event id, so a plain replay is a replay.
export async function rzpHeaders(raw: string, o: { secret?: string; eventId?: string | null } = {}): Promise<Record<string, string>> {
  const h: Record<string, string> = { "X-Razorpay-Signature": await hmacHex(raw, o.secret ?? WEBHOOK_SECRET) };
  if (o.eventId !== null) h["x-razorpay-event-id"] = o.eventId ?? "evt_" + (await hmacHex(raw, "event-id")).slice(0, 14);
  return h;
}

// Webhook bodies. `ref` is OUR link id (Razorpay's reference_id).
export const paidEvent = (ref: string, o: { amount?: number; paid?: number; currency?: string; paymentId?: string; createdAt?: number } = {}) => ({
  entity: "event",
  account_id: "acc_FAKE",
  event: "payment_link.paid",
  contains: ["payment_link", "payment"],
  payload: {
    payment_link: { entity: { id: "plink_FAKEX", reference_id: ref, status: "paid", amount: o.amount ?? 9900, amount_paid: o.paid ?? o.amount ?? 9900, currency: o.currency ?? "INR" } },
    payment: { entity: { id: o.paymentId ?? `pay_${ref.replace(/\W/g, "")}`, entity: "payment", amount: o.paid ?? o.amount ?? 9900, currency: o.currency ?? "INR", status: "captured" } },
  },
  created_at: o.createdAt ?? 1759644000,
});
export const closedEvent = (ref: string, kind: "expired" | "cancelled", createdAt = 1759644000) => ({
  entity: "event",
  account_id: "acc_FAKE",
  event: `payment_link.${kind}`,
  contains: ["payment_link"],
  payload: { payment_link: { entity: { id: "plink_FAKEX", reference_id: ref, status: kind, amount: 9900, amount_paid: 0, currency: "INR" } } },
  created_at: createdAt,
});
export const refundEvent = (refundId: string | null, status: "processed" | "failed", paymentId = "pay_FAKEREFUNDED", createdAt = 1759644000) => ({
  entity: "event",
  account_id: "acc_FAKE",
  event: `refund.${status}`,
  contains: ["refund", "payment"],
  payload: {
    refund: { entity: { id: "rfnd_FAKEW", entity: "refund", amount: 9900, currency: "INR", payment_id: paymentId, notes: refundId ? { refund_id: refundId } : [], receipt: refundId, status, speed_processed: "normal" } },
    payment: { entity: { id: paymentId, entity: "payment", amount: 9900, currency: "INR", status: "captured" } },
  },
  created_at: createdAt,
});
