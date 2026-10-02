// The ₹700 session: "Choose a time" -> next free SESSION slots -> guarded hold -> sessions row HELD + payment -> link that expires with the hold.
// Payment success is applied by src/pay/apply.ts (bookSession). A session can only be offered after CALLED_SESSION (see outcomes.ts).
import { config } from "./config";
import { copyFor } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { cashfree } from "./pay/cashfree";
import type { PaymentProvider } from "./pay/provider";
import { raiseAttention, sendMessage, type Out } from "./send";
import { availableSlots, formatIst, holdSlot, iso, nextWorkingDays, type Slot } from "./slots";

const nowIso = () => iso(Date.now());
type Conv = { id: number; wa_id: string; display_name: string | null; locale: string };
type Session = { id: number; state: string; conversation_id: number; service: string; intro_state: string | null; override_by: string | null };

// Handles sess_offer_<sessionId> and sess_<sessionId>_<startUtc>. Returns false for any other choice.
export async function sessionChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = cashfree(env)): Promise<boolean> {
  const offer = /^sess_offer_(\d+)$/.exec(choice ?? "");
  const pick = /^sess_(\d+)_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(choice ?? "");
  if (!offer && !pick) return false;
  const db = env.DB;
  const conv = await db.prepare("SELECT id, wa_id, display_name, locale FROM conversations WHERE id = ?1").bind(convId).first<Conv>();
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  if (!(await bookingsOpen(env))) {
    await send({ type: "text", text: cp.bookSoon }, "book");
    return true;
  }
  if (await db.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first()) {
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
    return true;
  }
  const sid = Number((offer ?? pick)![1]);
  // Only after CALLED_SESSION (or an audited operator override), and only the person it was offered to.
  const ses = await db
    .prepare(
      `SELECT se.id, se.state, se.conversation_id, se.service, i.state AS intro_state, se.override_by
       FROM sessions se LEFT JOIN intros i ON i.id = se.intro_id WHERE se.id = ?1`,
    )
    .bind(sid)
    .first<Session>();
  const allowed = ses && ses.conversation_id === conv.id && (ses.intro_state === "CALLED_SESSION" || ses.override_by) && ["OFFERED", "HELD", "EXPIRED"].includes(ses.state);
  if (!allowed) {
    await send({ type: "text", text: cp.sessionNotAvailable }, "na");
    await raiseAttention(db, "SESSION_NOT_OFFERABLE", `session:${sid}`);
    return true;
  }
  if (offer) {
    await sendSlotList(env, conv, sid, msgId);
    return true;
  }
  await startSession(env, provider, conv, ses, pick![2], msgId);
  return true;
}

// The session a customer may still be choosing a time for: OFFERED, EXPIRED, or HELD with a lapsed hold; same rules as sessionChoice.
export async function openOfferId(db: Env["DB"], convId: number): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT se.id FROM sessions se
       LEFT JOIN intros i ON i.id = se.intro_id
       LEFT JOIN slots sl ON sl.id = se.slot_id
       WHERE se.conversation_id = ?1 AND (i.state = 'CALLED_SESSION' OR se.override_by IS NOT NULL)
         AND (se.state IN ('OFFERED','EXPIRED') OR (se.state = 'HELD' AND (sl.hold_until IS NULL OR sl.hold_until <= ?2)))
       ORDER BY se.id DESC LIMIT 1`,
    )
    .bind(convId, nowIso())
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function sendSlotList(env: Env, conv: Conv, sid: number, msgId: string): Promise<void> {
  const cp = copyFor(conv.locale);
  const nowMs = Date.now();
  const free: Slot[] = [];
  for (const ymd of nextWorkingDays(nowMs, 5)) {
    free.push(...(await availableSlots(env.DB, "SESSION", ymd, nowMs + config.booking.leadMinutes * 60_000)));
  }
  const rows = free.slice(0, config.booking.maxListRows).map((s) => ({ id: `sess_${sid}_${s.startUtc}`, title: formatIst(s.startUtc) }));
  if (!rows.length) {
    await sendMessage(env, conv.id, { type: "text", text: cp.noSessionSlots }, `${msgId}:nosessions`);
    await raiseAttention(env.DB, "NO_SESSION_SLOTS", `session:${sid}`);
    return;
  }
  await sendMessage(env, conv.id, { type: "list", body: cp.sessionSlotBody, button: cp.slotListButton, rows }, `${msgId}:sessionslots`);
}

async function startSession(env: Env, provider: PaymentProvider, conv: Conv, ses: Session, startUtc: string, msgId: string): Promise<void> {
  const db = env.DB;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  const nowMs = Date.now();
  const hold = await holdSlot(db, { kind: "SESSION", startUtc, ownerId: conv.id, nowMs });
  if (!hold.ok) {
    if (hold.reason === "ALREADY_HOLDING") await send({ type: "text", text: cp.alreadyHolding }, "holding");
    else {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      await sendSlotList(env, conv, ses.id, `${msgId}:again`);
    }
    return;
  }
  const slot = await db.prepare("SELECT id FROM slots WHERE kind = 'SESSION' AND start_utc = ?1 AND owner_id = ?2").bind(startUtc, conv.id).first<{ id: number }>();
  const slotId = slot?.id ?? 0;
  const release = () => db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(slotId, nowIso()).run();

  // OFFERED/EXPIRED/lapsed HELD -> HELD with the new slot. Refused for anything else (e.g. already CONFIRMED): the hold is freed.
  const moved = await db
    .prepare("UPDATE sessions SET state = 'HELD', slot_id = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ('OFFERED','HELD','EXPIRED')")
    .bind(ses.id, slotId, nowIso())
    .run();
  if (!moved.meta.changes) {
    await release();
    await send({ type: "text", text: cp.sessionNotAvailable }, "na");
    return;
  }

  const linkId = `di-session-${ses.id}-${nowMs}`; // unique per attempt, <= 50 chars
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('cashfree', 'SESSION', ?1, ?2, ?3)")
    .bind(ses.id, linkId, config.prices.sessionPaise)
    .run();
  const payId = pay.meta.last_row_id;
  try {
    const link = await provider.createLink({
      linkId,
      amountPaise: config.prices.sessionPaise,
      purpose: "Disha Dira session booking",
      customerName: conv.display_name ?? "Customer",
      customerPhone: conv.wa_id.replace(/\D/g, "").slice(-10),
      expiresAtUtc: hold.holdUntil, // expires with the hold
    });
    await db.prepare("UPDATE payments SET state = 'PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await send({ type: "cta", body: cp.sessionPayBody, label: cp.sessionPayLabel, url: link.url }, "pay");
  } catch {
    await db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await db.prepare("UPDATE sessions SET state = 'OFFERED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(ses.id, nowIso()).run();
    await release();
    await raiseAttention(db, "LINK_CREATE_FAILED", `session:${ses.id}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}
