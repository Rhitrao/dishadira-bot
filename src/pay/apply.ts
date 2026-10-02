// Applies a payment fact (verified webhook or provider status read) to our rows.
// Every step is idempotent, so a replay, or a webhook racing the cron, can never double-book, double-refund or double-send.
import { config } from "../config";
import { copyFor } from "../copy";
import type { Env } from "../env";
import { raiseAttention, sendMessage, type Out } from "../send";
import { formatIstParts, iso } from "../slots";
import type { PayStatus, PaymentProvider } from "./provider";

type Payment = { id: number; purpose: string; target_id: number; state: string; amount_paise: number };
type Intro = { id: number; state: string; slot_id: number | null; conversation_id: number };
export type Applied = "BOOKED" | "LATE_NO_SLOT" | "DUPLICATE_REFUNDED" | "MISMATCH" | "CLOSED" | "NOOP" | "UNKNOWN_LINK";

const OPEN = "('CREATING','PENDING','FAILED','UNKNOWN')"; // states a verified success may supersede
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
const nowIso = () => iso(Date.now());

export async function applyStatus(env: Env, provider: PaymentProvider, ev: PayStatus): Promise<Applied> {
  const db = env.DB;
  const pay = await db
    .prepare("SELECT id, purpose, target_id, state, amount_paise FROM payments WHERE provider = 'cashfree' AND provider_link_id = ?1")
    .bind(ev.linkId)
    .first<Payment>();
  if (!pay) {
    await raiseAttention(db, "UNKNOWN_PAYMENT_LINK", ev.linkId);
    return "UNKNOWN_LINK";
  }
  if (pay.state.startsWith("REFUND") || (pay.state === "PAID" && ev.status !== "PAID")) return "NOOP";

  if (ev.status === "EXPIRED" || ev.status === "CANCELLED") return closeUnpaid(env, pay);
  if (ev.status === "PAID") return applyPaid(env, provider, pay, ev);
  if (ev.status === "PARTIALLY_PAID") return mismatch(env, pay, "PARTIAL_PAYMENT");
  return "NOOP"; // ACTIVE / unknown: nothing to do yet
}

// Link expired or cancelled with no payment: payment FAILED, intro EXPIRED, hold freed.
async function closeUnpaid(env: Env, pay: Payment): Promise<Applied> {
  const db = env.DB;
  const moved = await db
    .prepare(`UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING','PENDING')`)
    .bind(pay.id, nowIso())
    .run();
  if (!moved.meta.changes) return "NOOP";
  await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(pay.target_id, nowIso()).run();
  await db
    .prepare("UPDATE slots SET hold_until = ?2 WHERE state = 'HELD' AND id = (SELECT slot_id FROM intros WHERE id = ?1)")
    .bind(pay.target_id, nowIso())
    .run();
  return "CLOSED";
}

async function mismatch(env: Env, pay: Payment, kind: string): Promise<Applied> {
  await env.DB.prepare(`UPDATE payments SET state = 'UNKNOWN', updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING','PENDING','FAILED')`).bind(pay.id, nowIso()).run();
  await raiseAttention(env.DB, kind, `payment:${pay.id}`);
  return "MISMATCH";
}

async function applyPaid(env: Env, provider: PaymentProvider, pay: Payment, ev: PayStatus): Promise<Applied> {
  const db = env.DB;
  const mode = env.PAYMENT_MODE === "live" ? "live" : "test";
  if (pay.purpose !== "INTRO") return mismatch(env, pay, "UNSUPPORTED_PAYMENT");
  if (
    ev.paidPaise !== pay.amount_paise ||
    ev.paidPaise !== config.prices.introPaise ||
    ev.currency !== config.currency ||
    (ev.mode !== undefined && ev.mode !== mode)
  ) {
    return mismatch(env, pay, "PAYMENT_MISMATCH");
  }

  // Claim: a verified success supersedes FAILED/UNKNOWN. Money never moves backwards from PAID.
  await db
    .prepare(
      `UPDATE payments SET state = 'PAID', provider_order_id = COALESCE(provider_order_id, ?2),
         provider_payment_id = COALESCE(provider_payment_id, ?2), updated_at = ?3
       WHERE id = ?1 AND state IN ${OPEN}`,
    )
    .bind(pay.id, ev.orderId ?? null, nowIso())
    .run();

  // The first paid payment for an intro (lowest id) is the real one; any other is a duplicate to refund.
  const first = await db
    .prepare(`SELECT id FROM payments WHERE purpose = 'INTRO' AND target_id = ?1 AND state IN ${PAID_LIKE} ORDER BY id LIMIT 1`)
    .bind(pay.target_id)
    .first<{ id: number }>();
  if (first && first.id !== pay.id) return refundDuplicate(env, provider, pay.id, ev.orderId);

  const intro = await db
    .prepare("SELECT id, state, slot_id, conversation_id FROM intros WHERE id = ?1")
    .bind(pay.target_id)
    .first<Intro>();
  if (!intro) {
    await raiseAttention(db, "PAID_NO_INTRO", `payment:${pay.id}`);
    return "NOOP";
  }
  if (!["HELD", "EXPIRED", "PAID"].includes(intro.state)) {
    await raiseAttention(db, "PAID_INTRO_NOT_BOOKABLE", `intro:${intro.id}`);
    return "NOOP";
  }

  // HELD -> BOOKED. If the hold has lapsed this still works, but only if the row is still ours and nothing active overlaps it.
  const now = nowIso();
  await db
    .prepare(
      `UPDATE slots SET state = 'BOOKED', hold_until = NULL
       WHERE id = ?1 AND owner_id = ?2 AND state = 'HELD'
         AND (hold_until > ?3 OR NOT EXISTS (
           SELECT 1 FROM slots o WHERE o.id != slots.id AND (o.state = 'BOOKED' OR o.hold_until > ?3)
             AND o.start_utc < slots.end_utc AND o.end_utc > slots.start_utc))`,
    )
    .bind(intro.slot_id, intro.conversation_id, now)
    .run();
  const slot = await db
    .prepare("SELECT start_utc, state, owner_id FROM slots WHERE id = ?1")
    .bind(intro.slot_id)
    .first<{ start_utc: string; state: string; owner_id: number }>();

  if (!slot || slot.state !== "BOOKED" || slot.owner_id !== intro.conversation_id) {
    // Never take another person's slot: Rohit decides (new time or refund).
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(intro.id, now).run();
    await raiseAttention(db, "LATE_PAYMENT_NO_SLOT", `intro:${intro.id}`);
    return "LATE_NO_SLOT";
  }

  await db.prepare("UPDATE intros SET state = 'PAID', updated_at = ?2 WHERE id = ?1 AND state IN ('HELD','EXPIRED')").bind(intro.id, now).run();
  await confirm(env, intro.conversation_id, pay.id, slot.start_utc);
  return "BOOKED";
}

async function confirm(env: Env, conversationId: number, paymentId: number, startUtc: string): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale, last_user_at FROM conversations WHERE id = ?1").bind(conversationId).first<{ locale: string; last_user_at: string | null }>();
  const { day, time } = formatIstParts(startUtc);
  const inWindow = conv?.last_user_at && Date.now() - Date.parse(conv.last_user_at) < config.windowHours * 3600_000;
  const out: Out = inWindow
    ? { type: "text", text: copyFor(conv?.locale ?? "en").confirmed(day, time, config.businessNumber) }
    : { type: "template", name: "call_booked", params: [day, time, config.businessNumber] };
  await sendMessage(env, conversationId, out, `paid:${paymentId}`); // dedupe key: one confirmation per payment
}

// refunds.payment_id is UNIQUE: only the caller that inserts the row talks to the provider.
async function refundDuplicate(env: Env, provider: PaymentProvider, paymentId: number, orderId: string | undefined): Promise<Applied> {
  const db = env.DB;
  const now = nowIso();
  await raiseAttention(db, "DUPLICATE_PAYMENT", `payment:${paymentId}`);
  const row = await db
    .prepare("SELECT provider_order_id, amount_paise FROM payments WHERE id = ?1")
    .bind(paymentId)
    .first<{ provider_order_id: string | null; amount_paise: number }>();
  const ins = await db
    .prepare("INSERT OR IGNORE INTO refunds (payment_id, reason, requested_by) VALUES (?1, 'DUPLICATE', 'system')")
    .bind(paymentId)
    .run();
  if (!ins.meta.changes) return "DUPLICATE_REFUNDED";
  await db.prepare("UPDATE payments SET state = 'REFUND_PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'PAID'").bind(paymentId, now).run();

  const order = orderId ?? row?.provider_order_id;
  try {
    if (!order) throw new Error("no provider order id");
    const r = await provider.refund({ orderId: order, amountPaise: row!.amount_paise, refundId: `refund-${paymentId}`, note: "Duplicate payment" });
    await db.prepare("UPDATE refunds SET provider_refund_id = ?2, state = ?3, updated_at = ?4 WHERE payment_id = ?1").bind(paymentId, r.providerRefundId, r.done ? "REFUNDED" : "PENDING", nowIso()).run();
    if (r.done) await db.prepare("UPDATE payments SET state = 'REFUNDED', updated_at = ?2 WHERE id = ?1").bind(paymentId, nowIso()).run();
  } catch {
    await db.prepare("UPDATE refunds SET state = 'FAILED', updated_at = ?2 WHERE payment_id = ?1").bind(paymentId, nowIso()).run();
    await db.prepare("UPDATE payments SET state = 'REFUND_FAILED', updated_at = ?2 WHERE id = ?1").bind(paymentId, nowIso()).run();
    await raiseAttention(db, "REFUND_FAILED", `payment:${paymentId}`);
  }
  return "DUPLICATE_REFUNDED";
}

// Cron: payments still PENDING after config.cashfree.pollAfterMinutes get a status read, then the same logic as the webhook.
export async function reconcile(env: Env, provider: PaymentProvider, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - config.cashfree.pollAfterMinutes * 60_000);
  const { results } = await env.DB
    .prepare(
      `SELECT provider_link_id FROM payments WHERE provider = 'cashfree' AND purpose = 'INTRO' AND state = 'PENDING'
         AND provider_link_id IS NOT NULL AND COALESCE(updated_at, created_at) < ?1 ORDER BY id LIMIT 25`,
    )
    .bind(cutoff)
    .all<{ provider_link_id: string }>();
  let applied = 0;
  for (const r of results) {
    try {
      const st = await provider.getStatus(r.provider_link_id);
      if ((await applyStatus(env, provider, st)) !== "NOOP") applied++;
    } catch {
      // Leave it PENDING; the next run tries again.
    }
  }
  return applied;
}
