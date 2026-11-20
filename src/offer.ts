// Ticket 49 (CONTRACT v18): booking a catalogue service other than the ₹99 call and the ₹799 session (a Tarot reading, guided hypnosis …),
// behind the NEW_SERVICES env flag. All fixed messages, no AI. With the flag "false" nothing here is ever reached (the Book list, the only
// way in, is not shown) and an old button of it gets the menu.
//   Book list row cat_<key> -> age check (once; age_yes_c_<key>) -> "only after the first call"? -> the two yes/no questions (screen) ->
//   a sessions row (origin SELF, state OFFERED, service_key <key>) -> the session's own day and time steps (sday_<sid>_<ymd>, sess_<sid>_<utc>,
//   src/session.ts) with this service's length, daily cap and price -> hold -> payment link -> paid -> confirmation (src/pay/apply.ts) ->
//   the service's one question (intake), answered by typing or skipped.
// The screen's answers are never stored: a "yes" ends the booking with a kind fixed reply recommending the ₹99 call, and only an audited
// outcome code (SCREENED_TO_CALL on the conversation) is kept; a "no" just moves on.
import { intakeOf, isOffered, serviceOf, type Service } from "./catalogue";
import { config } from "./config";
import { ageButtons, loadConv, type Conv } from "./booking";
import { copyFor, langOf, type Copy, type Lang } from "./copy";
import type { Env } from "./env";
import { menuOut, pausedOut } from "./menu";
import { noSellActive } from "./noise";
import { botAudit } from "./safety";
import { sendMessage, type Out } from "./send";
import { sendSessionDays } from "./session";
import { clearStep, sendStep, type OpenStep } from "./steps";
import { bookingsOpen } from "./switches";
import { iso, PRACTITIONER_SQL } from "./slots";

const KEY = "([a-z0-9_]{2,40})";
const CAT = new RegExp(`^cat_${KEY}$`);
const AGE = new RegExp(`^age_(yes|no)_c_${KEY}$`);
const SCREEN = new RegExp(`^scr_${KEY}_([12])_(yes|no)$`);
const INTAKE_SKIP = /^ik_(\d+)_skip$/;
export const SCREENED_TO_CALL = "SCREENED_TO_CALL"; // the audit action: a "yes" sent them to the ₹99 call first (no answer is stored)
const nowIso = () => iso(Date.now());
const nameOf = (s: Service, lang: Lang) => (lang === "hi" ? s.nameHi : s.nameEn);

// The ₹99 call instead, with Help beside it: after "only after the first call", and after a "yes" to the screen.
const callFirstOut = (cp: Copy, body: string): Out => ({ type: "buttons", body, buttons: [{ id: "book_call", title: cp.btnBook }, { id: "menu_how", title: cp.btnHelp }] });
const screenOut = (cp: Copy, key: string, q: 1 | 2): Out => ({
  type: "buttons",
  body: q === 1 ? cp.screenQ1 : cp.screenQ2,
  buttons: [{ id: `scr_${key}_${q}_yes`, title: cp.btnYes }, { id: `scr_${key}_${q}_no`, title: cp.btnNo }],
});

// A ₹99 call that took place (the practitioner marked it): what "only after the first call" asks for.
async function hadCompletedCall(db: Env["DB"], convId: number): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM intros WHERE conversation_id = ?1 AND state IN ('CALLED_SESSION', 'CALLED_NOT_FIT')").bind(convId).first()) !== null;
}

// Handles cat_<key>, age_yes_c_<key> / age_no_c_<key>, scr_<key>_<1|2>_<yes|no> and ik_<session>_skip. false for any other choice.
export async function offerChoice(env: Env, choice: string | null, convId: number, msgId: string): Promise<boolean> {
  if (!choice) return false;
  const cat = CAT.exec(choice);
  const age = AGE.exec(choice);
  const scr = SCREEN.exec(choice);
  const skip = INTAKE_SKIP.exec(choice);
  if (!cat && !age && !scr && !skip) return false;
  const db = env.DB;
  const conv = await loadConv(db, convId);
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  await clearStep(db, conv.id); // whatever step was open is over; the step sent below (if any) becomes the open one
  if (skip) return true; // the question after payment, skipped: nothing is stored and nothing more is asked

  const key = (cat?.[1] ?? age?.[2] ?? scr?.[1])!;
  const svc = serviceOf(key);
  if (!isOffered(env, svc)) {
    await send(menuOut(cp, await noSellActive(db, conv.id), cp.offerNotAvailable), "notoffered");
    return true;
  }
  if (!(await bookingsOpen(env))) {
    await send(pausedOut(cp), "book");
    return true;
  }
  if (await db.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first()) {
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
    return true;
  }
  // The age check, asked once, as for every booking. "No" is not remembered (a parent writing from the same phone can say Yes later).
  if (age?.[1] === "no") {
    await send({ type: "text", text: cp.ageNo }, "ageno");
    return true;
  }
  if (age) {
    await db.prepare("UPDATE conversations SET age_ok_at = COALESCE(age_ok_at, ?2) WHERE id = ?1").bind(conv.id, nowIso()).run();
    conv.age_ok_at = conv.age_ok_at ?? nowIso();
  }
  if (!conv.age_ok_at) {
    await sendStep(env, conv.id, "age", ageButtons(cp, `_c_${key}`), `${msgId}:age`);
    return true;
  }
  if (svc.needsCallFirst && !(await hadCompletedCall(db, conv.id))) {
    await send(callFirstOut(cp, cp.offerCallFirst(nameOf(svc, lang))), "callfirst");
    return true;
  }

  // The two yes/no questions, before anything is held. Nothing about the answers is stored.
  if (svc.screen && !scr) {
    await sendStep(env, conv.id, "screen", screenOut(cp, key, 1), `${msgId}:screen1`);
    return true;
  }
  if (scr && !svc.screen) {
    // The owner turned the questions off meanwhile: carry on to the times.
  } else if (scr?.[3] === "yes") {
    await botAudit(db, SCREENED_TO_CALL, `conv:${conv.id}`, `service:${key}`);
    await send(callFirstOut(cp, cp.screenToCall(nameOf(svc, lang))), "screened");
    return true;
  } else if (scr?.[2] === "1") {
    await sendStep(env, conv.id, "screen", screenOut(cp, key, 2), `${msgId}:screen2`);
    return true;
  }

  // One reusable OFFERED row per person and service; the session machinery (days, times, hold, link, webhook, refunds) takes it from here.
  const existing = await db
    .prepare("SELECT id FROM sessions WHERE conversation_id = ?1 AND origin = 'SELF' AND service_key = ?2 AND state IN ('OFFERED', 'EXPIRED') ORDER BY id DESC LIMIT 1")
    .bind(conv.id, key)
    .first<{ id: number }>();
  let sid = existing?.id ?? 0;
  if (sid) {
    await db.prepare("UPDATE sessions SET state = 'OFFERED', call_lang = ?2, updated_at = ?3 WHERE id = ?1").bind(sid, lang, nowIso()).run();
  } else {
    // `service` (HEALING / PROTECTION) and who it is for belong to the pranic-healing session; a catalogue service is for the person themself.
    const ins = await db
      .prepare(`INSERT INTO sessions (conversation_id, service, for_whom, call_lang, origin, practitioner_id, service_key) VALUES (?1, 'HEALING', 'SELF', ?2, 'SELF', ${PRACTITIONER_SQL}, ?3)`)
      .bind(conv.id, lang, key)
      .run();
    sid = ins.meta.last_row_id;
  }
  await sendSessionDays(env, conv as Conv, sid, msgId, key);
  return true;
}

// ---- the question after payment (intake) ----
// After the confirmation of a paid catalogue session (src/pay/apply.ts), inside the 24-hour window, while the bot has the chat: the
// service's own question, once (the dedupe key), with Skip. Nothing is chased.
export async function startIntake(env: Env, convId: number, sessionId: number): Promise<void> {
  const row = await env.DB
    .prepare("SELECT se.service_key AS k, c.locale, c.mode FROM sessions se JOIN conversations c ON c.id = se.conversation_id WHERE se.id = ?1 AND c.id = ?2 AND se.state = 'CONFIRMED'")
    .bind(sessionId, convId)
    .first<{ k: string | null; locale: string; mode: string }>();
  if (!row || row.mode !== "BOT") return;
  const lang = langOf(row.locale);
  const q = intakeOf(serviceOf(row.k), lang);
  if (!q) return;
  const cp = copyFor(lang);
  await sendStep(env, convId, "intake", { type: "buttons", body: cp.intakeAsk(q), buttons: [{ id: `ik_${sessionId}_skip`, title: cp.btnSkip }] }, `intake:${sessionId}`);
}

// A typed answer while the question is the open step: kept on the session (up to config.offer.intakeMaxChars), and a short thanks. "pass":
// not ours (another step, an unknown session). Safety, the reading-safety replies and the noise rules have already run (the gatekeeper).
export async function intakeText(env: Env, convId: number, open: OpenStep, text: string): Promise<"done" | "pass"> {
  if (open.step !== "intake" || open.out.type !== "buttons") return "pass";
  const sid = Number(INTAKE_SKIP.exec(open.out.buttons[0]?.id ?? "")?.[1]);
  const t = text.trim().replace(/\s+/g, " ");
  if (!sid || !t) return "pass";
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(convId).first<{ locale: string }>();
  const saved = await env.DB
    .prepare("UPDATE sessions SET intake_answer = ?3, updated_at = ?4 WHERE id = ?1 AND conversation_id = ?2 AND state IN ('CONFIRMED', 'COMPLETED')")
    .bind(sid, convId, [...t].slice(0, config.offer.intakeMaxChars).join(""), nowIso())
    .run();
  if (!saved.meta.changes) return "pass";
  await clearStep(env.DB, convId);
  await sendMessage(env, convId, { type: "text", text: copyFor(conv?.locale).intakeThanks }, `intake:${sid}:thanks`);
  return "done";
}

// ---- what the team sees (Today's card, the person page): the answer, to the owner and the session's practitioner only ----
export const INTAKE_LINE = { en: (a: string) => `Their question: ${a}`, hi: (a: string) => `उनका सवाल: ${a}` } as const;
