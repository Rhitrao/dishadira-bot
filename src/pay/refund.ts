// The one refund path (duplicate payments, "not the right fit", rude reports). refunds.payment_id is UNIQUE, so a payment can
// never have two refunds. The provider call always uses refund-<payment id> as refund_id, so a retry after a crash or a lost
// answer asks Cashfree "do you already have it?" first and only creates it when there is none.
// Payments only move forward: PAID -> REFUND_PENDING -> REFUNDED | REFUND_FAILED (every UPDATE below names the state it leaves).
import { config } from "../config";
import type { Env } from "../env";
import { raiseAttention } from "../send";
import { iso, istDay } from "../slots";
import type { PaymentProvider, RefundResult, RefundStatus } from "./provider";

export type RefundReason = "DUPLICATE" | "NOT_FIT" | "RUDE" | "ADMIN"; // ADMIN: Rohit decided in /admin
export type RefundRequest = "CREATED" | "EXISTS" | "PERSON_LIMIT" | "DAILY_LIMIT";

const nowIso = () => iso(Date.now());
const LEASE_MS = 60_000; // one worker owns a refund for this long; the 2-minute cron then retries it
const STUCK_MS = 30 * 60_000; // still not confirmed after this long: Rohit is told
export const refundIdFor = (paymentId: number) => `refund-${paymentId}`;

// Creates the refunds row and (unless it waits for approval) talks to the provider.
// NOT_FIT is limited in the INSERT itself: once per person (same conversation/wa_id, or same payer ref) and config.limits.notFitRefundsPerDay.
export async function requestRefund(env: Env, provider: PaymentProvider, paymentId: number, reason: RefundReason, requestedBy: string): Promise<RefundRequest> {
  const db = env.DB;
  const now = nowIso();
  let changes: number;
  if (reason === "NOT_FIT") {
    const who = await db
      .prepare("SELECT i.conversation_id AS conv, p.payer_ref AS payer FROM payments p JOIN intros i ON i.id = p.target_id WHERE p.id = ?1 AND p.purpose = 'INTRO'")
      .bind(paymentId)
      .first<{ conv: number; payer: string | null }>();
    if (!who) throw new Error("refund: payment is not an intro payment");
    const dayStart = iso(Date.parse(`${istDay(Date.now())}T00:00:00+05:30`));
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO refunds (payment_id, reason, requested_by, state, attempt_at, created_at, updated_at)
         SELECT ?1, 'NOT_FIT', ?2, 'PENDING', ?3, ?3, ?3
         WHERE NOT EXISTS (
             SELECT 1 FROM refunds r JOIN payments p2 ON p2.id = r.payment_id JOIN intros i2 ON p2.purpose = 'INTRO' AND i2.id = p2.target_id
             WHERE r.reason = 'NOT_FIT' AND (i2.conversation_id = ?4 OR (?5 IS NOT NULL AND p2.payer_ref = ?5)))
           AND (SELECT COUNT(*) FROM refunds WHERE reason = 'NOT_FIT' AND created_at >= ?6) < ?7`,
      )
      .bind(paymentId, requestedBy, now, who.conv, who.payer, dayStart, config.limits.notFitRefundsPerDay)
      .run();
    changes = res.meta.changes;
    if (!changes) {
      if (await db.prepare("SELECT 1 FROM refunds WHERE payment_id = ?1").bind(paymentId).first()) return "EXISTS";
      const person = await db
        .prepare(
          `SELECT 1 FROM refunds r JOIN payments p2 ON p2.id = r.payment_id JOIN intros i2 ON p2.purpose = 'INTRO' AND i2.id = p2.target_id
           WHERE r.reason = 'NOT_FIT' AND (i2.conversation_id = ?1 OR (?2 IS NOT NULL AND p2.payer_ref = ?2))`,
        )
        .bind(who.conv, who.payer)
        .first();
      return person ? "PERSON_LIMIT" : "DAILY_LIMIT";
    }
  } else {
    // RUDE waits for Rohit's approval (PENDING_APPROVAL); a duplicate goes straight out.
    const state = reason === "RUDE" ? "PENDING_APPROVAL" : "PENDING";
    const res = await db
      .prepare("INSERT OR IGNORE INTO refunds (payment_id, reason, requested_by, state, attempt_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)")
      .bind(paymentId, reason, requestedBy, state, now)
      .run();
    if (!res.meta.changes) return "EXISTS";
    if (state === "PENDING_APPROVAL") return "CREATED";
  }
  await settleRefund(env, provider, paymentId, true); // this caller inserted the row, so it owns the first send
  return "CREATED";
}

// Rohit approves a RUDE refund: the same row moves PENDING_APPROVAL -> PENDING once (a second tap changes nothing), then the one engine sends it.
export async function approveRefund(env: Env, provider: PaymentProvider, paymentId: number): Promise<boolean> {
  const moved = await env.DB
    .prepare("UPDATE refunds SET state = 'PENDING', attempt_at = ?2, updated_at = ?2 WHERE payment_id = ?1 AND state = 'PENDING_APPROVAL'")
    .bind(paymentId, nowIso())
    .run();
  if (!moved.meta.changes) return false;
  await settleRefund(env, provider, paymentId, true);
  return true;
}

// Rohit keeps the money: the row stays as DECLINED (nothing was sent to the provider, and a payment can never get a second refund row).
// The caller writes who declined it to audit_log.
export async function declineRefund(env: Env, paymentId: number): Promise<boolean> {
  const res = await env.DB
    .prepare("UPDATE refunds SET state = 'DECLINED', updated_at = ?2 WHERE payment_id = ?1 AND state = 'PENDING_APPROVAL'")
    .bind(paymentId, nowIso())
    .run();
  return res.meta.changes > 0;
}

// A FAILED refund goes back to PENDING and is asked again with the same refund_id (the provider is looked up first, so no second refund).
export async function retryFailedRefund(env: Env, provider: PaymentProvider, paymentId: number): Promise<boolean> {
  const moved = await env.DB
    .prepare("UPDATE refunds SET state = 'PENDING', attempt_at = ?2, updated_at = ?2 WHERE payment_id = ?1 AND state = 'FAILED'")
    .bind(paymentId, nowIso())
    .run();
  if (!moved.meta.changes) return false;
  await env.DB.prepare("UPDATE payments SET state = 'REFUND_PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'REFUND_FAILED'").bind(paymentId, nowIso()).run();
  await settleRefund(env, provider, paymentId, false);
  return true;
}

// The amount refunded is what was actually paid (paid_paise, recorded on a mismatch), else the price.
// Looks up (unless fresh) and, if the provider has no such refund, creates it; then records what the provider says.
// Any error leaves the refund PENDING: the cron retries with the same refund_id.
async function settleRefund(env: Env, provider: PaymentProvider, paymentId: number, fresh: boolean): Promise<void> {
  const db = env.DB;
  const r = await db
    .prepare(
      `SELECT r.state, r.created_at AS createdAt, p.provider_order_id AS orderId, COALESCE(p.paid_paise, p.amount_paise) AS amount
       FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.payment_id = ?1`,
    )
    .bind(paymentId)
    .first<{ state: string; createdAt: string; orderId: string | null; amount: number }>();
  if (!r || r.state !== "PENDING") return;
  await db.prepare("UPDATE payments SET state = 'REFUND_PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'PAID'").bind(paymentId, nowIso()).run();
  try {
    if (!r.orderId) throw new Error("no provider order id");
    const refundId = refundIdFor(paymentId);
    let res: RefundResult = fresh ? { status: "NOT_FOUND" } : await provider.getRefund(r.orderId, refundId);
    if (res.status === "NOT_FOUND") {
      res = await provider.refund({ orderId: r.orderId, amountPaise: r.amount, refundId, note: "Refund from Disha Dira" });
    }
    await recordRefund(env, paymentId, res.status, res.providerRefundId);
  } catch {
    if (Date.parse(r.createdAt) < Date.now() - STUCK_MS) await raiseAttention(db, "REFUND_STUCK", `payment:${paymentId}`);
  }
}

// Applies a provider refund state (from a status read, a create answer or the webhook). Forward moves only.
export async function recordRefund(env: Env, paymentId: number, status: RefundStatus, providerRefundId?: string): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  if (status === "SUCCESS") {
    // A late success may also repair a FAILED refund: the money did go out.
    await db.prepare("UPDATE refunds SET state = 'REFUNDED', provider_refund_id = COALESCE(provider_refund_id, ?2), updated_at = ?3 WHERE payment_id = ?1 AND state IN ('PENDING','FAILED')").bind(paymentId, providerRefundId ?? null, now).run();
    await db.prepare("UPDATE payments SET state = 'REFUNDED', updated_at = ?2 WHERE id = ?1 AND state IN ('REFUND_PENDING','REFUND_FAILED')").bind(paymentId, now).run();
  } else if (status === "FAILED") {
    const moved = await db.prepare("UPDATE refunds SET state = 'FAILED', updated_at = ?2 WHERE payment_id = ?1 AND state = 'PENDING'").bind(paymentId, now).run();
    await db.prepare("UPDATE payments SET state = 'REFUND_FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'REFUND_PENDING'").bind(paymentId, now).run();
    if (moved.meta.changes) await raiseAttention(db, "REFUND_FAILED", `payment:${paymentId}`);
  } else if (providerRefundId) {
    await db.prepare("UPDATE refunds SET provider_refund_id = COALESCE(provider_refund_id, ?2), updated_at = ?3 WHERE payment_id = ?1 AND state = 'PENDING'").bind(paymentId, providerRefundId, now).run();
  }
}

// Verified refund webhook: refund_id is refund-<payment id>.
export async function applyRefundEvent(env: Env, refundId: string, status: RefundStatus): Promise<void> {
  const m = /^refund-(\d+)$/.exec(refundId);
  const exists = m ? await env.DB.prepare("SELECT 1 FROM refunds WHERE payment_id = ?1").bind(Number(m[1])).first() : null;
  if (!m || !exists) {
    await raiseAttention(env.DB, "UNKNOWN_REFUND", refundId);
    return;
  }
  await recordRefund(env, Number(m[1]), status);
}

// Cron: refunds still PENDING (never sent, unknown result, or waiting for the provider) are retried/polled with the same refund_id.
export async function retryRefunds(env: Env, provider: PaymentProvider, nowMs = Date.now()): Promise<number> {
  const db = env.DB;
  const cutoff = iso(nowMs - LEASE_MS);
  const { results } = await db
    .prepare("SELECT payment_id AS id FROM refunds WHERE state = 'PENDING' AND (attempt_at IS NULL OR attempt_at <= ?1) ORDER BY id LIMIT 25")
    .bind(cutoff)
    .all<{ id: number }>();
  let n = 0;
  for (const { id } of results) {
    const claim = await db
      .prepare("UPDATE refunds SET attempt_at = ?2 WHERE payment_id = ?1 AND state = 'PENDING' AND (attempt_at IS NULL OR attempt_at <= ?3)")
      .bind(id, iso(nowMs), cutoff)
      .run();
    if (!claim.meta.changes) continue;
    await settleRefund(env, provider, id, false);
    n++;
  }
  return n;
}
