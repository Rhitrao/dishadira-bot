// A paid session (₹799): "Choose a time" -> next free SESSION slots -> guarded hold -> sessions row HELD + payment -> link that expires with the hold.
// Payment success is applied by src/pay/apply.ts (bookSession). A session can only be offered after CALLED_SESSION (see outcomes.ts).
import { config } from "./config";
import { copyFor, langOf } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { razorpay } from "./pay/razorpay";
import type { PaymentProvider } from "./pay/provider";
import { loadConv, sendDays, sendTimes } from "./booking";
import { raiseAttention, sendMessage, type Out } from "./send";
import { clearStep, sendStep } from "./steps";
import { formatIstLang, holdSlot, iso, istDay } from "./slots";

const nowIso = () => iso(Date.now());
type Conv = NonNullable<Awaited<ReturnType<typeof loadConv>>>;
export type Session = { id: number; state: string; conversation_id: number; service: string; intro_state: string | null; override_by: string | null; origin: string };

// The session picker is the same day-then-time steps as the call (no age, service or who-for steps):
// sess_offer_<sessionId> -> day buttons sday_<sessionId>_<ymd> -> time list sess_<sessionId>_<startUtc>, whose last row smore_<sessionId> shows the days again.
// Handles all four. Returns false for any other choice.
export async function sessionChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = razorpay(env)): Promise<boolean> {
  const offer = /^sess_offer_(\d+)$/.exec(choice ?? "");
  const pick = /^sess_(\d+)_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(choice ?? "");
  const day = /^sday_(\d+)_(\d{4}-\d{2}-\d{2})$/.exec(choice ?? "");
  const more = /^smore_(\d+)$/.exec(choice ?? "");
  if (!offer && !pick && !day && !more) return false;
  const db = env.DB;
  const conv = await loadConv(db, convId);
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  await clearStep(db, conv.id); // the step that was open is over; the one sent below (if any) becomes the open one

  if (!(await bookingsOpen(env))) {
    await send({ type: "text", text: cp.bookSoon }, "book");
    return true;
  }
  if (await db.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first()) {
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
    return true;
  }
  const sid = Number((offer ?? pick ?? day ?? more)![1]);
  // Only after CALLED_SESSION (or an audited operator override), and only the person it was offered to.
  const ses = await db
    .prepare(
      `SELECT se.id, se.state, se.conversation_id, se.service, i.state AS intro_state, se.override_by, se.origin
       FROM sessions se LEFT JOIN intros i ON i.id = se.intro_id WHERE se.id = ?1`,
    )
    .bind(sid)
    .first<Session>();
  const allowed = ses && ses.conversation_id === conv.id && (ses.intro_state === "CALLED_SESSION" || ses.override_by || ses.origin === "SELF") && ["OFFERED", "HELD", "EXPIRED"].includes(ses.state);
  if (!allowed) {
    await send({ type: "text", text: cp.sessionNotAvailable }, "na");
    await raiseAttention(db, "SESSION_NOT_OFFERABLE", `session:${sid}`);
    return true;
  }
  if (offer || more) {
    await sendSessionDays(env, conv, sid, msgId);
    return true;
  }
  if (day) {
    await showSessionTimes(env, conv, sid, day[2], msgId);
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

async function sendSessionDays(env: Env, conv: Conv, sid: number, msgId: string): Promise<void> {
  if (!(await sendDays(env, conv, "SESSION", (ymd) => `sday_${sid}_${ymd}`, msgId))) await raiseAttention(env.DB, "NO_SESSION_SLOTS", `session:${sid}`); // a person follows up
}

// The times of one day; if the day filled up meanwhile, say so and show the days again.
async function showSessionTimes(env: Env, conv: Conv, sid: number, ymd: string, msgId: string): Promise<void> {
  const ok = await sendTimes(env, conv, "SESSION", ymd, (u) => `sess_${sid}_${u}`, `smore_${sid}`, msgId);
  if (ok) return;
  await sendMessage(env, conv.id, { type: "text", text: copyFor(conv.locale).slotTaken }, `${msgId}:taken`);
  await sendSessionDays(env, conv, sid, `${msgId}:again`);
}

export async function startSession(env: Env, provider: PaymentProvider, conv: Conv, ses: Session, startUtc: string, msgId: string): Promise<void> {
  const db = env.DB;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  const nowMs = Date.now();
  const hold = await holdSlot(db, { kind: "SESSION", startUtc, ownerId: conv.id, nowMs });
  if (!hold.ok) {
    if (hold.reason === "ALREADY_HOLDING") await send({ type: "text", text: cp.alreadyHolding }, "holding");
    else {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      await showSessionTimes(env, conv, ses.id, istDay(Date.parse(startUtc)), `${msgId}:again`);
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

  const linkId = `di-session-${ses.id}-${nowMs}`; // unique per attempt, <= 40 chars (Razorpay reference_id limit)
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay', 'SESSION', ?1, ?2, ?3)")
    .bind(ses.id, linkId, config.prices.single)
    .run();
  const payId = pay.meta.last_row_id;
  try {
    const link = await provider.createLink({
      linkId,
      amountPaise: config.prices.single,
      purpose: "Disha Dira session booking",
      customerName: conv.display_name ?? "Customer",
      customerPhone: conv.wa_id.replace(/\D/g, "").slice(-10),
      expiresAtUtc: hold.holdUntil, // expires with the hold
    });
    await db.prepare("UPDATE payments SET state = 'PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    const p = formatIstLang(startUtc, langOf(conv.locale));
    await sendStep(env, conv.id, "pay", { type: "cta", body: cp.sessionPayBody(p.day, p.time), label: cp.sessionPayLabel, url: link.url }, `${msgId}:pay`, { until: hold.holdUntil });
  } catch {
    await db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await db.prepare("UPDATE sessions SET state = 'OFFERED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(ses.id, nowIso()).run();
    await release();
    await raiseAttention(db, "LINK_CREATE_FAILED", `session:${ses.id}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}
