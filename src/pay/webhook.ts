import type { Context } from "hono";
import type { Env } from "../env";
import { iso } from "../slots";
import { applyStatus } from "./apply";
import { applyRefundEvent } from "./refund";
import { cashfree } from "./cashfree";
import type { PaymentProvider } from "./provider";

type C = Context<{ Bindings: Env }>;

export async function cashfreeWebhook(c: C, provider: PaymentProvider = cashfree(c.env)) {
  const raw = await c.req.text(); // raw body first; nothing is parsed or stored before the signature check
  const res = await provider.verifyWebhook(raw, c.req.raw.headers);
  if (!res.ok) return res.reason === "SIGNATURE" ? c.text("invalid signature", 401) : c.text("bad payload", 400);
  const db = c.env.DB;
  const refund = "refund" in res ? res.refund : null;
  const ev = "event" in res ? res.event : null;
  const key = (refund ?? ev!).key;

  const ins = await db
    .prepare("INSERT OR IGNORE INTO events (provider, event_key, payload) VALUES ('cashfree', ?1, ?2)")
    .bind(key, JSON.stringify(refund ? { refund_id: refund.refundId, status: refund.status } : { link_id: ev!.linkId, status: ev!.status, order_id: ev!.orderId ?? null }))
    .run();
  if (!ins.meta.changes) {
    const row = await db.prepare("SELECT status FROM events WHERE provider = 'cashfree' AND event_key = ?1").bind(key).first<{ status: string }>();
    if (row?.status === "PROCESSED") return c.text("ok"); // replay: no effects
  }
  try {
    if (refund) await applyRefundEvent(c.env, refund.refundId, refund.status);
    else await applyStatus(c.env, provider, ev!);
    await db.prepare("UPDATE events SET status = 'PROCESSED', error = NULL, processed_at = ?2 WHERE provider = 'cashfree' AND event_key = ?1").bind(key, iso(Date.now())).run();
    return c.text("ok");
  } catch (e) {
    await db.prepare("UPDATE events SET status = 'FAILED', error = ?2 WHERE provider = 'cashfree' AND event_key = ?1").bind(key, String(e).slice(0, 200)).run();
    return c.text("retry", 500); // Cashfree redelivers; every step is idempotent
  }
}
