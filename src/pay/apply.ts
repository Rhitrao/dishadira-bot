// Applies a payment fact (verified webhook or provider status read) to our rows.
// Every step is idempotent, so a replay, or a webhook racing the cron, can never double-book, double-refund or double-send.
import { config } from "../config";
import { copyFor } from "../copy";
import type { Env } from "../env";
import { raiseAttention, sendOrTemplate } from "../send";
import { formatIstParts, iso } from "../slots";
import type { PayStatus, PaymentProvider } from "./provider";
import { requestRefund } from "./refund";

type Payment = { id: number; purpose: string; target_id: number; state: string; amount_paise: number };
type Intro = { id: number; state: string; slot_id: number | null; conversation_id: number };
type SlotRow = { start_utc: string; state: string; owner_id: number };
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

// Link expired or cancelled with no payment: payment FAILED, intro/session EXPIRED, hold freed.
async function closeUnpaid(env: Env, pay: Payment): Promise<Applied> {
  const db = env.DB;
  const moved = await db
    .prepare(`UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING','PENDING')`)
    .bind(pay.id, nowIso())
    .run();
  if (!moved.meta.changes) return "NOOP";
  const table = pay.purpose === "SESSION" ? "sessions" : "intros";
  await db.prepare(`UPDATE ${table} SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'`).bind(pay.target_id, nowIso()).run();
  await db
    .prepare(`UPDATE slots SET hold_until = ?2 WHERE state = 'HELD' AND id = (SELECT slot_id FROM ${table} WHERE id = ?1)`)
    .bind(pay.target_id, nowIso())
    .run();
  return "CLOSED";
}

async function mismatch(env: Env, pay: Payment, kind: string): Promise<Applied> {
  await env.DB.prepare(`UPDATE payments SET state = 'UNKNOWN', updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING','PENDING','FAILED')`).bind(pay.id, nowIso()).run();
  await raiseAttention(env.DB, kind, `payment:${pay.id}`);
  return "MISMATCH";
}

const priceFor = (purpose: string) => (purpose === "INTRO" ? config.prices.introPaise : purpose === "SESSION" ? config.prices.sessionPaise : null);

async function applyPaid(env: Env, provider: PaymentProvider, pay: Payment, ev: PayStatus): Promise<Applied> {
  const db = env.DB;
  const mode = env.PAYMENT_MODE === "live" ? "live" : "test";
  const price = priceFor(pay.purpose);
  if (price === null) return mismatch(env, pay, "UNSUPPORTED_PAYMENT");
  if (
    ev.paidPaise !== pay.amount_paise ||
    ev.paidPaise !== price ||
    ev.currency !== config.currency ||
    (ev.mode !== undefined && ev.mode !== mode)
  ) {
    return mismatch(env, pay, "PAYMENT_MISMATCH");
  }

  // Claim: a verified success supersedes FAILED/UNKNOWN. Money never moves backwards from PAID.
  await db
    .prepare(
      `UPDATE payments SET state = 'PAID', provider_order_id = COALESCE(provider_order_id, ?2),
         provider_payment_id = COALESCE(provider_payment_id, ?2), payer_ref = COALESCE(payer_ref, ?4), updated_at = ?3
       WHERE id = ?1 AND state IN ${OPEN}`,
    )
    .bind(pay.id, ev.orderId ?? null, nowIso(), ev.payerRef ?? null)
    .run();

  // The first paid payment for a target (lowest id) is the real one; any other is a duplicate to refund.
  const first = await db
    .prepare(`SELECT id FROM payments WHERE purpose = ?1 AND target_id = ?2 AND state IN ${PAID_LIKE} ORDER BY id LIMIT 1`)
    .bind(pay.purpose, pay.target_id)
    .first<{ id: number }>();
  if (first && first.id !== pay.id) {
    await raiseAttention(db, "DUPLICATE_PAYMENT", `payment:${pay.id}`);
    await requestRefund(env, provider, pay.id, "DUPLICATE", "system");
    return "DUPLICATE_REFUNDED";
  }
  return pay.purpose === "SESSION" ? bookSession(env, pay) : bookIntro(env, pay);
}

// HELD -> BOOKED. If the hold has lapsed this still works, but only if the row is still ours and nothing active overlaps it.
async function bookSlot(db: Env["DB"], slotId: number | null, ownerId: number, now: string): Promise<SlotRow | null> {
  await db
    .prepare(
      `UPDATE slots SET state = 'BOOKED', hold_until = NULL
       WHERE id = ?1 AND owner_id = ?2 AND state = 'HELD'
         AND (hold_until > ?3 OR NOT EXISTS (
           SELECT 1 FROM slots o WHERE o.id != slots.id AND (o.state = 'BOOKED' OR o.hold_until > ?3)
             AND o.start_utc < slots.end_utc AND o.end_utc > slots.start_utc))`,
    )
    .bind(slotId, ownerId, now)
    .run();
  const slot = await db.prepare("SELECT start_utc, state, owner_id FROM slots WHERE id = ?1").bind(slotId).first<SlotRow>();
  return slot && slot.state === "BOOKED" && slot.owner_id === ownerId ? slot : null;
}

async function bookIntro(env: Env, pay: Payment): Promise<Applied> {
  const db = env.DB;
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
  const now = nowIso();
  const slot = await bookSlot(db, intro.slot_id, intro.conversation_id, now);
  if (!slot) {
    // Never take another person's slot: Rohit decides (new time or refund).
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(intro.id, now).run();
    await raiseAttention(db, "LATE_PAYMENT_NO_SLOT", `intro:${intro.id}`);
    return "LATE_NO_SLOT";
  }
  await db.prepare("UPDATE intros SET state = 'PAID', updated_at = ?2 WHERE id = ?1 AND state IN ('HELD','EXPIRED')").bind(intro.id, now).run();
  await confirm(env, intro.conversation_id, pay.id, slot.start_utc);
  return "BOOKED";
}

async function bookSession(env: Env, pay: Payment): Promise<Applied> {
  const db = env.DB;
  const ses = await db
    .prepare("SELECT id, state, slot_id, conversation_id FROM sessions WHERE id = ?1")
    .bind(pay.target_id)
    .first<Intro>();
  if (!ses) {
    await raiseAttention(db, "PAID_NO_SESSION", `payment:${pay.id}`);
    return "NOOP";
  }
  if (!["OFFERED", "HELD", "EXPIRED", "CONFIRMED"].includes(ses.state)) {
    await raiseAttention(db, "PAID_SESSION_NOT_BOOKABLE", `session:${ses.id}`);
    return "NOOP";
  }
  const now = nowIso();
  const slot = await bookSlot(db, ses.slot_id, ses.conversation_id, now);
  if (!slot) {
    await db.prepare("UPDATE sessions SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(ses.id, now).run();
    await raiseAttention(db, "LATE_PAYMENT_NO_SLOT", `session:${ses.id}`);
    return "LATE_NO_SLOT";
  }
  await db.prepare("UPDATE sessions SET state = 'CONFIRMED', updated_at = ?2 WHERE id = ?1 AND state IN ('HELD','EXPIRED')").bind(ses.id, now).run();
  const conv = await db.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(ses.conversation_id).first<{ locale: string }>();
  const { day, time } = formatIstParts(slot.start_utc);
  await sendOrTemplate(
    env,
    ses.conversation_id,
    { type: "text", text: copyFor(conv?.locale ?? "en").sessionConfirmed(day, time) },
    { type: "template", name: "session_confirmed", params: [day, time] },
    `paid:${pay.id}`,
  );
  return "BOOKED";
}

async function confirm(env: Env, conversationId: number, paymentId: number, startUtc: string): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(conversationId).first<{ locale: string }>();
  const { day, time } = formatIstParts(startUtc);
  await sendOrTemplate(
    env,
    conversationId,
    { type: "text", text: copyFor(conv?.locale ?? "en").confirmed(day, time, config.businessNumber) },
    { type: "template", name: "call_booked", params: [day, time, config.businessNumber] },
    `paid:${paymentId}`, // dedupe key: one confirmation per payment
  );
}

// Cron: payments still PENDING after config.cashfree.pollAfterMinutes get a status read, then the same logic as the webhook.
export async function reconcile(env: Env, provider: PaymentProvider, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - config.cashfree.pollAfterMinutes * 60_000);
  const { results } = await env.DB
    .prepare(
      `SELECT provider_link_id FROM payments WHERE provider = 'cashfree' AND state = 'PENDING'
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
