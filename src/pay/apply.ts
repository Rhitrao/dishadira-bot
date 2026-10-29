// Applies a payment fact (verified webhook or provider status read) to our rows.
// Every step is idempotent, so a replay, or a webhook racing the cron, can never double-book, double-refund or double-send.
import { DEFAULT_PRICES, priceAt } from "../business";
import { config } from "../config";
import { copyFor, langOf, rupees } from "../copy";
import type { Env } from "../env";
import { paymentCleared, personState, quietActive, noSellActiveFor } from "../noise";
import { creditPackage } from "../packages";
import { REMINDER_AT } from "../remind";
import { raiseAttention, sendMessage, sendOrTemplate } from "../send";
import { formatIstLang, iso, istDay } from "../slots";
import { sendsOn } from "../switches";
import type { PayStatus, PaymentProvider } from "./provider";
import { requestRefund } from "./refund";

type Payment = { id: number; purpose: string; target_id: number; state: string; amount_paise: number; created_at: string };
type Intro = { id: number; state: string; slot_id: number | null; conversation_id: number };
type SlotRow = { start_utc: string; state: string; owner_id: number };
export type Applied = "BOOKED" | "LATE_NO_SLOT" | "DUPLICATE_REFUNDED" | "MISMATCH" | "CLOSED" | "NOOP" | "UNKNOWN_LINK";

const OPEN = "('CREATING','PENDING','FAILED','UNKNOWN')"; // states a verified success may supersede
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
const nowIso = () => iso(Date.now());

export async function applyStatus(env: Env, provider: PaymentProvider, ev: PayStatus): Promise<Applied> {
  const db = env.DB;
  const pay = await db
    .prepare("SELECT id, purpose, target_id, state, amount_paise, created_at FROM payments WHERE provider = 'razorpay' AND provider_link_id = ?1")
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

// Money received outside Razorpay (CONTRACT "Flow invariants": the owner records it, or approves a staff member's request): the same
// steps as a verified paid link, by payment id, for the exact amount of the row. Only an open payment moves; see src/requests.ts.
export async function applyReceived(env: Env, provider: PaymentProvider, paymentId: number): Promise<Applied> {
  const pay = await env.DB.prepare("SELECT id, purpose, target_id, state, amount_paise, created_at FROM payments WHERE id = ?1").bind(paymentId).first<Payment>();
  if (!pay || !["CREATING", "PENDING", "FAILED"].includes(pay.state)) return "NOOP";
  return applyPaid(env, provider, pay, { linkId: "", status: "PAID", paidPaise: pay.amount_paise, currency: config.currency });
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
  await tellReleased(env, pay, table);
  return "CLOSED";
}

// A hold that ended unpaid: one short message with a button to choose a time again (ticket 31, I11). Only inside the 24-hour window, with
// SENDS on, for a chat the bot is answering (not blocked, HUMAN, quiet, opted out or in the no-selling week), and not when the person
// has meanwhile held another time or booked a call.
async function tellReleased(env: Env, pay: Payment, table: "intros" | "sessions"): Promise<void> {
  const db = env.DB;
  const nowMs = Date.now();
  const t = await db
    .prepare(`SELECT conversation_id AS conv, ${table === "sessions" ? "intro_id" : "NULL"} AS introId FROM ${table} WHERE id = ?1`)
    .bind(pay.target_id)
    .first<{ conv: number; introId: number | null }>();
  const c = t ? await db.prepare("SELECT id, locale, mode, last_user_at AS lastUserAt FROM conversations WHERE id = ?1").bind(t.conv).first<{ id: number; locale: string; mode: string; lastUserAt: string | null }>() : null;
  if (!t || !c || c.mode !== "BOT" || !c.lastUserAt || nowMs - Date.parse(c.lastUserAt) >= config.windowHours * 3_600_000) return;
  if (!(await sendsOn(env))) return;
  const st = await personState(db, c.id);
  if (quietActive(st, nowMs) || noSellActiveFor(st, nowMs) || st.optedOutAt) return;
  const busy = await db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM slots WHERE owner_id = ?1 AND state = 'HELD' AND hold_until > ?2)
         OR EXISTS (SELECT 1 FROM intros i JOIN slots s ON s.id = i.slot_id WHERE i.conversation_id = ?1 AND i.state IN ('PAID','RESCHEDULED') AND s.end_utc > ?2)`,
    )
    .bind(c.id, iso(nowMs))
    .first();
  if (busy) return;
  const cp = copyFor(c.locale);
  const button =
    table === "intros" ? { id: "menu_book", title: cp.btnBook } : { id: t.introId !== null ? `sess_offer_${pay.target_id}` : "go_s", title: cp.btnChooseTime };
  await sendMessage(env, c.id, { type: "buttons", body: cp.holdReleased, buttons: [button] }, `released:${pay.id}`);
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
  await tellPayer(env, pay.id); // "we're checking it" (ticket 31, I19); the owner's item stays
  return "MISMATCH";
}

// What a payment must be for, in paise: the price of the call, session or package when its link was made (src/business.ts priceAt),
// so a link sent just before the owner changed a price is still the right amount. A package must be one of the two sizes we sell.
async function priceFor(db: Env["DB"], pay: Payment): Promise<number | null> {
  if (pay.purpose === "INTRO") return priceAt(db, "intro", pay.created_at);
  if (pay.purpose === "SESSION") return priceAt(db, "single", pay.created_at);
  if (pay.purpose === "PACKAGE") {
    const pk = await db.prepare("SELECT size, price_paise AS price, created_at AS at FROM packages WHERE id = ?1").bind(pay.target_id).first<{ size: number; price: number; at: string }>();
    const name = (["pack10", "pack20"] as const).find((n) => DEFAULT_PRICES[n].sessions === pk?.size);
    if (!pk || !name) return null;
    return (await priceAt(db, name, pk.at)) === pk.price ? pk.price : null;
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
    await tellPayer(env, pay.id);
    return "DUPLICATE_REFUNDED";
  }
  return pay.purpose === "SESSION" ? bookSession(env, pay) : pay.purpose === "PACKAGE" ? bookPackage(env, pay) : bookIntro(env, provider, pay);
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
  await tellPayer(env, pay.id);
  return "BOOKED";
}

async function confirmPackage(env: Env, convId: number, paymentId: number, size: number): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(convId).first<{ locale: string }>();
  const cp = copyFor(langOf(conv?.locale));
  await sendOrTemplate(
    env,
    convId,
    { type: "buttons", body: cp.packConfirmed(size), buttons: [{ id: "bk_new", title: cp.btnBookSession }] },
    { type: "template", name: "package_confirmed", params: [String(size)], paramsHi: [String(size)] },
    `paid:${paymentId}`, // dedupe key: one confirmation per payment
  );
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

async function bookIntro(env: Env, provider: PaymentProvider, pay: Payment): Promise<Applied> {
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
  // One ₹99 call per person at a time (ticket 31, B3): a second paid call while another is paid and still ahead (a payment that surfaced
  // late, after the person booked and paid again) is a duplicate. Its own hold is let go, the money goes back, the person is told.
  const other = await db
    .prepare(
      `SELECT 1 FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.conversation_id = ?1 AND i.id != ?2 AND i.state IN ('PAID','RESCHEDULED') AND s.end_utc > ?3 LIMIT 1`,
    )
    .bind(intro.conversation_id, intro.id, now)
    .first();
  if (other && intro.state !== "PAID") {
    await db.batch([
      db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(intro.id, now),
      db.prepare("UPDATE slots SET hold_until = ?3 WHERE id = ?1 AND owner_id = ?2 AND state = 'HELD'").bind(intro.slot_id, intro.conversation_id, now),
    ]);
    await raiseAttention(db, "DUPLICATE_PAYMENT", `payment:${pay.id}`);
    await requestRefund(env, provider, pay.id, "DUPLICATE", "system");
    await tellPayer(env, pay.id);
    return "DUPLICATE_REFUNDED";
  }
  const slot = await bookSlot(db, intro.slot_id, intro.conversation_id, now);
  if (!slot) {
    // Never take another person's slot: Rohit decides (new time or refund). The customer is told so (ticket 31, B4).
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(intro.id, now).run();
    await raiseAttention(db, "LATE_PAYMENT_NO_SLOT", `intro:${intro.id}`);
    await tellPayer(env, pay.id);
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
    await tellPayer(env, pay.id);
    return "LATE_NO_SLOT";
  }
  await db.prepare("UPDATE sessions SET state = 'CONFIRMED', updated_at = ?2 WHERE id = ?1 AND state IN ('HELD','EXPIRED')").bind(ses.id, now).run();
  await confirmSession(env, ses.conversation_id, pay.id, slot.start_utc);
  return "BOOKED";
}

// Until the reminder template is approved, the day-before reminder reaches only someone still inside the 24-hour window at reminder time:
// the confirmation promises it only then (ticket 31, I2). Approving the template brings the promise back everywhere.
export function reminderReaches(startUtc: string, nowMs = Date.now()): boolean {
  if (config.templates.reminder.approved) return true;
  const at = Date.parse(`${istDay(Date.parse(startUtc) - 86_400_000)}T${REMINDER_AT}:00+05:30`);
  return at > nowMs && at <= nowMs + (config.windowHours - 2) * 3_600_000;
}

async function confirmSession(env: Env, convId: number, paymentId: number, startUtc: string): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(convId).first<{ locale: string }>();
  const lang = langOf(conv?.locale);
  const en = formatIstLang(startUtc, "en");
  const hi = formatIstLang(startUtc, "hi");
  const p = lang === "hi" ? hi : en;
  await sendOrTemplate(
    env,
    convId,
    { type: "text", text: copyFor(lang).sessionConfirmed(p.day, p.time, reminderReaches(startUtc)) },
    { type: "template", name: "session_confirmed", params: [en.day, en.time], paramsHi: [hi.day, hi.time] },
    `paid:${paymentId}`,
  );
}

// The one message a payment gets (dedupe key paid:<id>), worked out from the rows so the cron can send it again when it was skipped while
// SENDS was paused (ticket 31, I4): the confirmation; "your time was taken after the hold ended" (B4); "a second payment, being refunded"
// (B3); or "we're checking this payment" (I19).
export async function tellPayer(env: Env, paymentId: number): Promise<void> {
  const db = env.DB;
  const p = await db
    .prepare(
      `SELECT p.purpose, p.target_id AS targetId, p.state, COALESCE(p.paid_paise, p.amount_paise) AS paid, r.reason,
         CASE p.purpose WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id)
           WHEN 'SESSION' THEN (SELECT conversation_id FROM sessions WHERE id = p.target_id)
           ELSE (SELECT conversation_id FROM packages WHERE id = p.target_id) END AS conv
       FROM payments p LEFT JOIN refunds r ON r.payment_id = p.id WHERE p.id = ?1`,
    )
    .bind(paymentId)
    .first<{ purpose: string; targetId: number; state: string; paid: number; reason: string | null; conv: number | null }>();
  if (!p || p.conv === null) return;
  const conv = await db.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(p.conv).first<{ locale: string }>();
  const lang = langOf(conv?.locale);
  const cp = copyFor(lang);
  const key = `paid:${paymentId}`;
  const now = nowIso();
  if (p.state === "UNKNOWN") {
    await sendMessage(env, p.conv, { type: "text", text: cp.checkingPayment }, key);
    return;
  }
  if (p.reason === "DUPLICATE") {
    // The booking that stays: the upcoming call (a ₹99 duplicate), or the session itself (a session paid twice).
    const kept = await db
      .prepare(
        p.purpose === "SESSION"
          ? "SELECT s.start_utc AS startUtc FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.id = ?2 AND se.state = 'CONFIRMED' AND s.end_utc > ?3"
          : `SELECT s.start_utc AS startUtc FROM intros i JOIN slots s ON s.id = i.slot_id
             WHERE i.conversation_id = ?1 AND i.state IN ('PAID','RESCHEDULED') AND s.end_utc > ?3 ORDER BY s.start_utc LIMIT 1`,
      )
      .bind(p.conv, p.targetId, now)
      .first<{ startUtc: string }>();
    const amount = rupees(p.paid);
    const when = kept && p.purpose !== "PACKAGE" ? formatIstLang(kept.startUtc, lang) : null;
    const text = when ? `${cp.dupRefund(amount)} ${cp.dupKeeps(when.day, when.time)}` : cp.dupRefund(amount);
    await sendOrTemplate(env, p.conv, { type: "text", text }, { type: "template", name: "payment_update", params: [amount] }, key);
    return;
  }
  if (p.state !== "PAID") return; // refunded since (for example Not right fit): nothing to confirm any more
  if (p.purpose === "PACKAGE") {
    const pk = await db.prepare("SELECT size FROM packages WHERE id = ?1 AND state = 'PAID' AND payment_id = ?2").bind(p.targetId, paymentId).first<{ size: number }>();
    if (pk) await confirmPackage(env, p.conv, paymentId, pk.size);
    return;
  }
  const t = await db
    .prepare(
      `SELECT t.state, s.start_utc AS startUtc, s.end_utc AS endUtc, s.state AS slotState FROM ${p.purpose === "SESSION" ? "sessions" : "intros"} t
       LEFT JOIN slots s ON s.id = t.slot_id AND s.owner_id = t.conversation_id WHERE t.id = ?1`,
    )
    .bind(p.targetId)
    .first<{ state: string; startUtc: string | null; endUtc: string | null; slotState: string | null }>();
  if (!t) return;
  if (t.state === "EXPIRED") {
    // Paid after the hold ended and the time is someone else's: the owner offers a new time or a refund (CONTRACT, late payment).
    await sendMessage(env, p.conv, { type: "text", text: cp.latePaidTaken(rupees(p.paid)) }, key);
    return;
  }
  if (t.slotState !== "BOOKED" || !t.startUtc || !t.endUtc || t.endUtc <= now) return;
  if (p.purpose === "SESSION" && t.state === "CONFIRMED") await confirmSession(env, p.conv, paymentId, t.startUtc);
  else if (p.purpose === "INTRO" && (t.state === "PAID" || t.state === "RESCHEDULED")) await confirm(env, p.conv, paymentId, t.startUtc);
}

// Cron (ticket 31, I4): a payment message that was skipped while SENDS was paused goes out once sends are back, if it is under a day old.
export async function resendSkippedPaid(env: Env, nowMs = Date.now()): Promise<number> {
  if (!(await sendsOn(env))) return 0;
  const { results } = await env.DB
    .prepare("SELECT dedupe_key AS k FROM messages WHERE direction = 'OUT' AND status = 'SKIPPED' AND dedupe_key LIKE 'paid:%' AND created_at > ?1 ORDER BY id LIMIT 25")
    .bind(iso(nowMs - config.windowHours * 3_600_000))
    .all<{ k: string }>();
  let n = 0;
  for (const r of results) {
    const id = Number(/^paid:(\d+)$/.exec(r.k)?.[1]);
    if (!id) continue;
    await tellPayer(env, id);
    n++;
  }
  return n;
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
    { type: "text", text: copyFor(lang).confirmed(p.day, p.time, langOf(intro?.callLang ?? conv?.locale)) },
    { type: "template", name: "call_booked", params: [en.day, en.time], paramsHi: [hi.day, hi.time] },
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
