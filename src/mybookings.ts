// My bookings (Help list), and moving or cancelling a session. The rules are docs/AGENT.md section 3.1b step 6, counted back from the start of the session:
//   package session: move or cancel at least 3 h before -> the session (or the credit) goes back to the package; later, the credit is used.
//   single session:  move once, at least 3 h before. Cancel at least 24 h before -> full refund (the one refund path, unique per payment).
//                    Between 3 and 24 h: no refund, but it can be moved once. After that, nothing.
//   the 99 call:     only the existing missed-call reschedule (src/outcomes.ts), so a call is listed but has no Move / Cancel.
// Ids: menu_bookings, mv_<sessionId>, cx_<sessionId>, mdy_<sessionId>_<ymd>, mtm_<sessionId>_<utc>, mmo_<sessionId> (Another day).
// Every change is one batch, written only if the session is still in the state the rule needs, so a double tap or a replay changes nothing twice.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor, langOf } from "./copy";
import type { Env } from "./env";
import { loadConv, sendDays, sendTimes } from "./booking";
import { razorpay } from "./pay/razorpay";
import type { PaymentProvider } from "./pay/provider";
import { requestRefund } from "./pay/refund";
import { creditBalance, hasPackage } from "./packages";
import { raiseAttention, sendMessage, type Out } from "./send";
import { clearStep, sendStep } from "./steps";
import { bind, formatIstLang, generateSlots, iso, istDay } from "./slots";

const HOUR = 3_600_000;
const nowIso = () => iso(Date.now());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type SessionRow = { id: number; state: string; origin: string; moves: number; slotId: number; startUtc: string };

async function loadSession(db: D1Database, convId: number, sid: number): Promise<SessionRow | null> {
  return db
    .prepare(
      `SELECT se.id, se.state, se.origin, se.moves, sl.id AS slotId, sl.start_utc AS startUtc
       FROM sessions se JOIN slots sl ON sl.id = se.slot_id WHERE se.id = ?1 AND se.conversation_id = ?2 AND sl.kind = 'SESSION'`,
    )
    .bind(sid, convId)
    .first<SessionRow>();
}
const isLive = (s: SessionRow, nowMs: number) => ["CREDIT_BOOKED", "CONFIRMED"].includes(s.state) && Date.parse(s.startUtc) > nowMs;
const hoursBefore = (s: SessionRow, nowMs: number) => (Date.parse(s.startUtc) - nowMs) / HOUR;
const canMoveAgain = (s: SessionRow) => s.origin === "CREDIT" || s.moves < config.sessionRules.singleMoves;

// ---- the list ----
async function sendBookings(env: Env, convId: number, msgId: string): Promise<void> {
  const db = env.DB;
  const conv = (await loadConv(db, convId))!;
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const now = nowIso();
  const calls = await db
    .prepare(
      `SELECT sl.start_utc AS startUtc FROM intros i JOIN slots sl ON sl.id = i.slot_id
       WHERE i.conversation_id = ?1 AND i.state IN ('PAID', 'RESCHEDULED') AND sl.end_utc > ?2 ORDER BY sl.start_utc`,
    )
    .bind(convId, now)
    .all<{ startUtc: string }>();
  const sessions = await db
    .prepare(
      `SELECT se.id, sl.start_utc AS startUtc FROM sessions se JOIN slots sl ON sl.id = se.slot_id
       WHERE se.conversation_id = ?1 AND se.state IN ('CREDIT_BOOKED', 'CONFIRMED') AND sl.end_utc > ?2 ORDER BY sl.start_utc`,
    )
    .bind(convId, now)
    .all<{ id: number; startUtc: string }>();
  const left = await creditBalance(db, convId);
  const hasPack = await hasPackage(db, convId);
  const when = (startUtc: string) => formatIstLang(startUtc, lang);
  const items = [
    ...calls.results.map((r) => ({ at: r.startUtc, text: cp.bookingItem(cp.wordCall, when(r.startUtc).day, when(r.startUtc).time) })),
    ...sessions.results.map((r) => ({ at: r.startUtc, text: cp.bookingItem(cp.wordSession, when(r.startUtc).day, when(r.startUtc).time) })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const key = (step: string) => `${msgId}:${step}`;
  const bookButton: { id: string; title: string }[] = left > 0 ? [{ id: "bk_new", title: cp.btnBookSession }] : [];

  if (!items.length) {
    const body = hasPack ? `${cp.myBookingsNone} ${cp.creditsLeft(left)}` : cp.myBookingsNone;
    await sendStep(env, convId, "bookings", bookButton.length ? { type: "buttons", body, buttons: bookButton } : { type: "text", text: body }, key("none"));
    return;
  }
  const list = items.map((i) => i.text).join("; ");
  const body = hasPack ? cp.myBookingsBody(list, left) : cp.myBookingsNoPack(list);
  const actions = (id: number) => [
    { id: `mv_${id}`, title: cp.btnMove },
    { id: `cx_${id}`, title: cp.btnCancel },
  ];
  if (sessions.results.length === 1 && !calls.results.length) {
    await sendStep(env, convId, "bookings", { type: "buttons", body, buttons: actions(sessions.results[0].id) }, key("list"));
    return;
  }
  await sendMessage(env, convId, { type: "text", text: body }, key("list"));
  for (const s of sessions.results) {
    const p = when(s.startUtc);
    await sendStep(env, convId, "bookings", { type: "buttons", body: cp.sessionActions(p.day, p.time), buttons: actions(s.id) }, key(`s${s.id}`));
  }
}

// ---- the handler ----
export async function bookingsChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = razorpay(env)): Promise<boolean> {
  if (!choice) return false;
  const [tag, a, b] = choice.split("_");
  const ok =
    choice === "menu_bookings" ||
    ((tag === "mv" || tag === "cx" || tag === "mmo") && /^\d+$/.test(a ?? "") && b === undefined) ||
    (tag === "mdy" && /^\d+$/.test(a ?? "") && YMD.test(b ?? "")) ||
    (tag === "mtm" && /^\d+$/.test(a ?? "") && UTC.test(b ?? ""));
  if (!ok) return false;
  const db = env.DB;
  const conv = await loadConv(db, convId);
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  await clearStep(db, conv.id); // the step that was open is over; the one sent below (if any) becomes the open one

  if (choice === "menu_bookings") {
    await sendBookings(env, conv.id, msgId);
    return true;
  }
  const sid = Number(a);
  const now = Date.now();
  const ses = await loadSession(db, conv.id, sid);
  if (!ses || !isLive(ses, now)) {
    await send({ type: "text", text: cp.bookingNotFound }, "gone");
    return true;
  }
  const hours = hoursBefore(ses, now);

  // ---- Move: the same day and time steps ----
  if (tag === "mv" || tag === "mdy" || tag === "mmo" || tag === "mtm") {
    if (hours < config.sessionRules.changeBeforeHours) {
      await send({ type: "text", text: cp.moveTooLate }, "late");
      return true;
    }
    if (!canMoveAgain(ses)) {
      await send({ type: "buttons", body: cp.moveOnlyOnce, buttons: [{ id: "menu_person", title: cp.btnPerson }] }, "once");
      return true;
    }
    if (tag === "mv" || tag === "mmo") {
      await sendDays(env, conv, "SESSION", (ymd) => `mdy_${sid}_${ymd}`, msgId);
      return true;
    }
    if (tag === "mdy") {
      const sent = await sendTimes(env, conv, "SESSION", b, (u) => `mtm_${sid}_${u}`, `mmo_${sid}`, msgId);
      if (!sent) {
        await send({ type: "text", text: cp.slotTaken }, "taken");
        await sendDays(env, conv, "SESSION", (ymd) => `mdy_${sid}_${ymd}`, `${msgId}:again`);
      }
      return true;
    }
    const moved = await moveSession(db, conv.id, ses, b, now);
    if (moved) {
      const p = formatIstLang(b, lang);
      await send({ type: "text", text: cp.moved(p.day, p.time) }, "moved");
    } else {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      await sendTimes(env, conv, "SESSION", istDay(Date.parse(b)), (u) => `mtm_${sid}_${u}`, `mmo_${sid}`, `${msgId}:again`);
    }
    return true;
  }

  // ---- Cancel ----
  if (hours < config.sessionRules.changeBeforeHours) {
    await send({ type: "text", text: cp.moveTooLate }, "late");
    return true;
  }
  if (ses.origin === "CREDIT") {
    if (await cancelCredit(db, conv.id, sid, now)) await send({ type: "text", text: cp.cancelledCredit(await creditBalance(db, conv.id)) }, "cancelled");
    else await send({ type: "text", text: cp.bookingNotFound }, "gone");
    return true;
  }
  if (hours < config.sessionRules.singleRefundBeforeHours) {
    // No refund, but it can be moved once: offer that instead.
    const buttons = canMoveAgain(ses) ? [{ id: `mv_${sid}`, title: cp.btnMove }, { id: "book_keep", title: cp.btnKeep }] : [{ id: "menu_person", title: cp.btnPerson }];
    await send({ type: "buttons", body: canMoveAgain(ses) ? cp.cancelledSingleNoRefund : cp.moveOnlyOnce, buttons }, "norefund");
    return true;
  }
  const payId = await cancelSingle(db, conv.id, sid, now);
  if (payId === null) {
    await send({ type: "text", text: cp.bookingNotFound }, "gone");
    return true;
  }
  if (payId > 0) {
    try {
      await requestRefund(env, provider, payId, "CANCEL", "customer");
    } catch {
      await raiseAttention(db, "CANCEL_REFUND_FAILED", `session:${sid}`); // cancelled but the refund row could not be written: Rohit refunds by hand
    }
  } else {
    await raiseAttention(db, "CANCEL_NO_PAYMENT", `session:${sid}`); // a single session with no paid payment to refund
  }
  await send({ type: "text", text: cp.cancelledSingleRefund }, "cancelled");
  return true;
}

// ---- the guarded writes ----

// A package session cancelled at least 3 h before: the session is CANCELLED, the slot is freed and +1 goes back on the ledger, in one batch.
export async function cancelCredit(db: D1Database, convId: number, sid: number, nowMs: number): Promise<boolean> {
  const p = { sid, conv: convId, now: iso(nowMs), min: iso(nowMs + config.sessionRules.changeBeforeHours * HOUR) };
  const [moved] = await db.batch([
    bind(
      db,
      `UPDATE sessions SET state = 'CANCELLED', updated_at = :now
       WHERE id = :sid AND conversation_id = :conv AND state = 'CREDIT_BOOKED' AND origin = 'CREDIT'
         AND slot_id IN (SELECT id FROM slots WHERE start_utc >= :min)`,
      p,
    ),
    bind(
      db,
      `INSERT INTO credits (package_id, delta, reason, session_id, at, by)
       SELECT package_id, 1, 'CANCEL_RETURN', id, :now, 'customer' FROM sessions
       WHERE id = :sid AND state = 'CANCELLED' AND origin = 'CREDIT' AND package_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM credits WHERE session_id = :sid AND reason = 'CANCEL_RETURN')
         AND EXISTS (SELECT 1 FROM sessions WHERE id = :sid AND updated_at = :now)`,
      p,
    ),
    bind(db, `UPDATE slots SET state = 'HELD', hold_until = :now WHERE id = (SELECT slot_id FROM sessions WHERE id = :sid AND state = 'CANCELLED' AND updated_at = :now) AND state = 'BOOKED'`, p),
  ]);
  return moved.meta.changes > 0;
}

// A single session cancelled at least 24 h before: CANCELLED and the slot freed. Returns the id of the payment to refund (0: none found), or null if nothing changed.
export async function cancelSingle(db: D1Database, convId: number, sid: number, nowMs: number): Promise<number | null> {
  const p = { sid, conv: convId, now: iso(nowMs), min: iso(nowMs + config.sessionRules.singleRefundBeforeHours * HOUR) };
  const [moved] = await db.batch([
    bind(
      db,
      `UPDATE sessions SET state = 'CANCELLED', updated_at = :now
       WHERE id = :sid AND conversation_id = :conv AND state = 'CONFIRMED' AND origin != 'CREDIT'
         AND slot_id IN (SELECT id FROM slots WHERE start_utc >= :min)`,
      p,
    ),
    bind(db, `UPDATE slots SET state = 'HELD', hold_until = :now WHERE id = (SELECT slot_id FROM sessions WHERE id = :sid AND state = 'CANCELLED' AND updated_at = :now) AND state = 'BOOKED'`, p),
  ]);
  if (!moved.meta.changes) return null;
  const pay = await db.prepare("SELECT id FROM payments WHERE purpose = 'SESSION' AND target_id = ?1 AND state = 'PAID' ORDER BY id LIMIT 1").bind(sid).first<{ id: number }>();
  return pay?.id ?? 0;
}

// Moving: the new slot is booked, the session points at it, and the old slot is freed, in one batch. It only happens if the session is still live
// with at least 3 h to go, can still be moved, and the new time is free. false when the new time was taken (or the session changed meanwhile).
export async function moveSession(db: D1Database, convId: number, ses: SessionRow, startUtc: string, nowMs: number): Promise<boolean> {
  const slot = generateSlots(istDay(Date.parse(startUtc)), "SESSION").find((s) => s.startUtc === startUtc);
  if (!slot || startUtc <= iso(nowMs + config.booking.leadMinutes * 60_000) || slot.startUtc === ses.startUtc) return false;
  const p = {
    sid: ses.id, conv: convId, now: iso(nowMs), start: slot.startUtc, end: slot.endUtc, old: ses.slotId,
    min: iso(nowMs + config.sessionRules.changeBeforeHours * HOUR), maxMoves: config.sessionRules.singleMoves,
  };
  await db.batch([
    // The new slot, only if it is free and the session may be moved right now.
    bind(
      db,
      `INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until)
       SELECT 'SESSION', :start, :end, :conv, 'BOOKED', NULL
       WHERE NOT EXISTS (SELECT 1 FROM slots WHERE (state = 'BOOKED' OR hold_until > :now) AND start_utc < :end AND end_utc > :start)
         AND EXISTS (SELECT 1 FROM sessions se JOIN slots o ON o.id = se.slot_id
                     WHERE se.id = :sid AND se.conversation_id = :conv AND se.state IN ('CREDIT_BOOKED', 'CONFIRMED') AND se.slot_id = :old
                       AND o.start_utc >= :min AND (se.origin = 'CREDIT' OR se.moves < :maxMoves))
       ON CONFLICT (kind, start_utc) DO UPDATE SET owner_id = :conv, state = 'BOOKED', hold_until = NULL, end_utc = :end
         WHERE NOT (slots.state = 'BOOKED' OR slots.hold_until > :now)`,
      p,
    ),
    // The session points at it (only the slot just booked, which no session uses yet).
    bind(
      db,
      `UPDATE sessions SET slot_id = (SELECT n.id FROM slots n WHERE n.kind = 'SESSION' AND n.start_utc = :start AND n.owner_id = :conv AND n.state = 'BOOKED'
                                      AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.slot_id = n.id AND x.state IN ('HELD', 'CONFIRMED', 'CREDIT_BOOKED'))),
         moves = moves + 1, updated_at = :now
       WHERE id = :sid AND conversation_id = :conv AND state IN ('CREDIT_BOOKED', 'CONFIRMED') AND slot_id = :old
         AND EXISTS (SELECT 1 FROM slots n WHERE n.kind = 'SESSION' AND n.start_utc = :start AND n.owner_id = :conv AND n.state = 'BOOKED'
                     AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.slot_id = n.id AND x.state IN ('HELD', 'CONFIRMED', 'CREDIT_BOOKED')))`,
      p,
    ),
    // The old slot is free again.
    bind(db, `UPDATE slots SET state = 'HELD', hold_until = :now WHERE id = :old AND state = 'BOOKED' AND EXISTS (SELECT 1 FROM sessions WHERE id = :sid AND slot_id != :old)`, p),
    // A slot booked above that no session uses (cannot happen, but must never stay taken).
    bind(db, `UPDATE slots SET state = 'HELD', hold_until = :now WHERE kind = 'SESSION' AND start_utc = :start AND owner_id = :conv AND state = 'BOOKED' AND NOT EXISTS (SELECT 1 FROM sessions WHERE slot_id = slots.id AND state IN ('HELD', 'CONFIRMED', 'CREDIT_BOOKED'))`, p),
  ]);
  const now = await db.prepare("SELECT slot_id AS slotId FROM sessions WHERE id = ?1").bind(ses.id).first<{ slotId: number }>();
  return now !== null && now.slotId !== ses.slotId;
}
