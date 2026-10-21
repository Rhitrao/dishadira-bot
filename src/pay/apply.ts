// Applies a payment fact (verified webhook or provider status read) to our rows.
// Every step is idempotent, so a replay, or a webhook racing the cron, can never double-book, double-refund or double-send.
import { config } from "../config";
import { copyFor, langOf } from "../copy";
import type { Env } from "../env";
import { paymentCleared } from "../noise";
import { creditPackage } from "../packages";
import { raiseAttention, sendOrTemplate } from "../send";
import { formatIstLang, iso } from "../slots";
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
    .prepare("SELECT id, purpose, target_id, state, amount_paise FROM payments WHERE provider = 'razorpay' AND provider_link_id = ?1")
    .bind(ev.linkId)
    .first<Payment>();
  if (!pay) {
    await raiseAttention(db, "UNKNOWN_PAYMENT_LINK", ev.linkId);
    return "UNKNOWN_LINK";
  }
  if (pay.state.startsWith("REFUND") || (pay.state === "PAID" && ev.status !== "PAID")) return "NOOP";

  if (ev.status === "EXPIRED" || ev.status === "CANCELLED") return closeUnpaid(env, pay);
  if (ev.status === "PAID") return applyPaid(env, provider, pay, ev);
  if (ev.status === "PARTIALLY_PAID") return mismatch(env, pay, "PARTIAL_PAYMENT", ev.paidPaise);
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
  const table = tableFor(pay.purpose);
  await closePayStep(db, table, pay.target_id);
  if (table === "packages") {
    // A package holds no slot: the unpaid package just expires.
    await db.prepare("UPDATE packages SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING', 'PENDING')").bind(pay.target_id, nowIso()).run();
    return "CLOSED";
  }
  await db.prepare(`UPDATE ${table} SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'`).bind(pay.target_id, nowIso()).run();
  await db
    .prepare(`UPDATE slots SET hold_until = ?2 WHERE state = 'HELD' AND id = (SELECT slot_id FROM ${table} WHERE id = ?1)`)
    .bind(pay.target_id, nowIso())
    .run();
  return "CLOSED";
}

// The payment step of the booking is over (paid, expired or cancelled): a typed message no longer re-sends the pay button.
type Table = "intros" | "sessions" | "packages";
const tableFor = (purpose: string): Table => (purpose === "SESSION" ? "sessions" : purpose === "PACKAGE" ? "packages" : "intros");

async function closePayStep(db: Env["DB"], table: Table, targetId: number): Promise<number | null> {
  const row = await db.prepare(`SELECT conversation_id AS conv FROM ${table} WHERE id = ?1`).bind(targetId).first<{ conv: number }>();
  if (!row) return null;
  await db
    .prepare("UPDATE conversations SET pending_step = NULL, pending_out = NULL, pending_until = NULL, pending_reprompts = 0 WHERE id = ?1 AND pending_step = 'pay'")
    .bind(row.conv)
    .run();
  return row.conv;
}

// paid_paise keeps what the customer really paid, so a refund returns that amount and never the expected price.
async function mismatch(env: Env, pay: Payment, kind: string, paidPaise?: number): Promise<Applied> {
  await env.DB
    .prepare(`UPDATE payments SET state = 'UNKNOWN', paid_paise = COALESCE(?3, paid_paise), updated_at = ?2 WHERE id = ?1 AND state IN ('CREATING','PENDING','FAILED')`)
    .bind(pay.id, nowIso(), paidPaise && paidPaise > 0 ? paidPaise : null)
    .run();
  await raiseAttention(env.DB, kind, `payment:${pay.id}`);
  return "MISMATCH";
}

// What a payment must be for, in paise: the 99 call and the single session from config; a package from the package row (its price when it was created).
async function priceFor(db: Env["DB"], pay: Payment): Promise<number | null> {
  if (pay.purpose === "INTRO") return config.prices.intro;
  if (pay.purpose === "SESSION") return config.prices.single;
  if (pay.purpose === "PACKAGE") {
    const pk = await db.prepare("SELECT size, price_paise AS price FROM packages WHERE id = ?1").bind(pay.target_id).first<{ size: number; price: number }>();
    const known = [config.prices.pack10, config.prices.pack20].find((p) => p.sessions === pk?.size && p.paise === pk?.price);
    return known ? known.paise : null;
  }
  return null;
}

async function applyPaid(env: Env, provider: PaymentProvider, pay: Payment, ev: PayStatus): Promise<Applied> {
  const db = env.DB;
  const mode = env.PAYMENT_MODE === "live" ? "live" : "test";
  const price = await priceFor(db, pay);
  if (price === null) return mismatch(env, pay, "UNSUPPORTED_PAYMENT", ev.paidPaise);
  if (
    ev.paidPaise !== pay.amount_paise ||
    ev.paidPaise !== price ||
    ev.currency !== config.currency ||
    (ev.mode !== undefined && ev.mode !== mode)
  ) {
    return mismatch(env, pay, "PAYMENT_MISMATCH", ev.paidPaise);
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

  // Paying ends the pay step and clears the person's strikes and quiet period.
  const payer = await closePayStep(db, tableFor(pay.purpose), pay.target_id);
  if (payer !== null) await paymentCleared(db, payer);

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
  return pay.purpose === "SESSION" ? bookSession(env, pay) : pay.purpose === "PACKAGE" ? bookPackage(env, pay) : bookIntro(env, pay);
}

// A package payment: the credits are added once (src/packages.ts), then one confirmation with [Book a session].
async function bookPackage(env: Env, pay: Payment): Promise<Applied> {
  const db = env.DB;
  const pk = await db.prepare("SELECT conversation_id AS conv, size, state FROM packages WHERE id = ?1").bind(pay.target_id).first<{ conv: number; size: number; state: string }>();
  if (!pk) {
    await raiseAttention(db, "PAID_NO_PACKAGE", `payment:${pay.id}`);
    return "NOOP";
  }
  if (pk.state === "CLOSED") {
    await raiseAttention(db, "PAID_PACKAGE_NOT_BOOKABLE", `package:${pay.target_id}`);
    return "NOOP";
  }
  await creditPackage(env, pay.id, pay.target_id);
  const conv = await db.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(pk.conv).first<{ locale: string }>();
  const cp = copyFor(langOf(conv?.locale));
  await sendOrTemplate(
    env,
    pk.conv,
    { type: "buttons", body: cp.packConfirmed(pk.size), buttons: [{ id: "bk_new", title: cp.btnBookSession }] },
    { type: "template", name: "package_confirmed", params: [String(pk.size)], paramsHi: [String(pk.size)] },
    `paid:${pay.id}`, // dedupe key: one confirmation per payment
  );
  return "BOOKED";
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
  const lang = langOf(conv?.locale);
  const en = formatIstLang(slot.start_utc, "en");
  const hi = formatIstLang(slot.start_utc, "hi");
  const p = lang === "hi" ? hi : en;
  await sendOrTemplate(
    env,
    ses.conversation_id,
    { type: "text", text: copyFor(lang).sessionConfirmed(p.day, p.time) },
    { type: "template", name: "session_confirmed", params: [en.day, en.time], paramsHi: [hi.day, hi.time] },
    `paid:${pay.id}`,
  );
  return "BOOKED";
}

async function confirm(env: Env, conversationId: number, paymentId: number, startUtc: string): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(conversationId).first<{ locale: string }>();
  const intro = await env.DB
    .prepare("SELECT i.call_lang AS callLang FROM payments p JOIN intros i ON i.id = p.target_id WHERE p.id = ?1 AND p.purpose = 'INTRO'")
    .bind(paymentId)
    .first<{ callLang: string | null }>();
  const lang = langOf(conv?.locale);
  const en = formatIstLang(startUtc, "en");
  const hi = formatIstLang(startUtc, "hi");
  const p = lang === "hi" ? hi : en;
  await sendOrTemplate(
    env,
    conversationId,
    { type: "text", text: copyFor(lang).confirmed(p.day, p.time, langOf(intro?.callLang ?? conv?.locale), config.businessNumber) },
    { type: "template", name: "call_booked", params: [en.day, en.time, config.businessNumber], paramsHi: [hi.day, hi.time, config.businessNumber] },
    `paid:${paymentId}`, // dedupe key: one confirmation per payment
  );
}

// Cron: payments still PENDING after config.razorpay.pollAfterMinutes get a status read, then the same logic as the webhook.
export async function reconcile(env: Env, provider: PaymentProvider, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - config.razorpay.pollAfterMinutes * 60_000);
  const { results } = await env.DB
    .prepare(
      `SELECT provider_link_id FROM payments WHERE provider = 'razorpay' AND state = 'PENDING'
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
