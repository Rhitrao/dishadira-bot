// Ticket 41 (owner's decision, 4 Nov 2026): right after a ₹99 call is paid (after the usual confirmation), three short questions, one at a time,
// each with Skip: (a) the name Shantha Rao should use (the WhatsApp name offered on a button, or typed), (b) their profession or work, typed,
// (c) what they would like help with, from a list (Stress & anxiety ... Something else, then a few typed words).
// Stored: a typed name as the person's name (conversations.display_name, kept from then on: name_given_at), the work and the area code on the
// intro (migration 0018). The "Something else" words are only chat text, wiped with it. Nothing is ever chased: no reminders, and an
// unanswered question simply stays unanswered (the step lapses after config.booking.stepOpenHours). Inside the 24-hour window only (it
// follows the payment), and only while the bot has the chat.
// Out of scope (a sexual-function concern, or a request to cure a serious illness, src/router.ts isOutOfScope) from someone who has paid:
// the kind reply, and one item for the team, "consider a refund" (never an automatic refund).
import { html } from "hono/html";
import { can, type Member } from "./auth";
import { chatTextHidden } from "./business";
import { config } from "./config";
import { consoleLang } from "./console-copy";
import { copyFor, type Copy, type IntentArea } from "./copy";
import type { Env } from "./env";
import { menuOut } from "./menu";
import { isOutOfScope, isSexualHealth, matchTopic, type Topic } from "./router";
import { normalize } from "./safety";
import { raiseAttention, sendMessage, type Out } from "./send";
import { iso } from "./slots";
import { sendStep, type OpenStep } from "./steps";
import { statusChip } from "./ui";

export const OUT_OF_SCOPE = "OUT_OF_SCOPE"; // the attention kind: target intro:<id> (or session:<id>)
export const INTENT_STEPS = ["intent_name", "intent_work", "intent_area", "intent_other"] as const;
export type IntentStep = (typeof INTENT_STEPS)[number];
export const isIntentStep = (s: string | null | undefined): s is IntentStep => (INTENT_STEPS as readonly string[]).includes(s ?? "");
const AREAS = config.intent.areas as readonly IntentArea[];
export const isArea = (v: unknown): v is IntentArea => typeof v === "string" && (AREAS as readonly string[]).includes(v);

// Button and row ids: in_<intro id>_<question>_<answer>. The intro id is checked against the chat on every tap.
const ID = /^in_(\d+)_(name|work|area|other)_([A-Za-z]+)$/;
const id = (introId: number, q: string, a: string) => `in_${introId}_${q}_${a}`;
const nowIso = () => iso(Date.now());

// ---- the questions ----
function nameOut(cp: Copy, introId: number, name: string | null): Out {
  const n = name?.trim() || null;
  const buttons = [...(n ? [{ id: id(introId, "name", "use"), title: cp.btnUseName(n) }] : []), { id: id(introId, "name", "skip"), title: cp.btnSkip }];
  return { type: "buttons", body: cp.intentName(n), buttons };
}
const workOut = (cp: Copy, introId: number): Out => ({ type: "buttons", body: cp.intentWork, buttons: [{ id: id(introId, "work", "skip"), title: cp.btnSkip }] });
const areaOut = (cp: Copy, introId: number): Out => ({
  type: "list",
  body: cp.intentArea,
  button: cp.intentAreaButton,
  rows: [
    ...AREAS.map((a) => ({ id: id(introId, "area", a), title: cp.intentAreas[a], ...(a === "ENERGY" || a === "OTHER" ? { description: cp.intentAreaDesc[a] } : {}) })),
    { id: id(introId, "area", "skip"), title: cp.rowSkip },
  ],
});
const otherOut = (cp: Copy, introId: number): Out => ({ type: "buttons", body: cp.intentOther, buttons: [{ id: id(introId, "other", "skip"), title: cp.btnSkip }] });

type IntroConv = { introId: number; convId: number; locale: string; name: string | null; mode: string };
// The intro, if it is this chat's and still a paid call (not refunded, cancelled or expired).
const introOf = (env: Env, introId: number, convId: number) =>
  env.DB
    .prepare(
      `SELECT i.id AS introId, c.id AS convId, c.locale, c.display_name AS name, c.mode FROM intros i JOIN conversations c ON c.id = i.conversation_id
       WHERE i.id = ?1 AND c.id = ?2 AND i.state IN ('PAID', 'RESCHEDULED', 'CALLED_SESSION', 'CALLED_NOT_FIT', 'MISSED')`,
    )
    .bind(introId, convId)
    .first<IntroConv>();

const ask = (env: Env, x: IntroConv, step: IntentStep, out: Out, q: string) => sendStep(env, x.convId, step, out, `intent:${x.introId}:${q}`);
const thanks = (env: Env, x: IntroConv) => sendMessage(env, x.convId, { type: "text", text: copyFor(x.locale).intentThanks }, `intent:${x.introId}:thanks`);

// After the confirmation of a paid ₹99 call (src/pay/apply.ts): the first question, once per intro (the dedupe key), only while the bot has
// the chat (not with the team, not blocked). sendStep sends nothing outside the 24-hour window, and then nothing more happens.
export async function startIntent(env: Env, convId: number, introId: number): Promise<void> {
  const x = await introOf(env, introId, convId);
  if (!x || x.mode !== "BOT") return;
  await ask(env, x, "intent_name", nameOut(copyFor(x.locale), introId, x.name), "name");
}

// A tap on one of the questions' buttons or rows. true: it was ours (even when nothing more is sent).
export async function intentChoice(env: Env, choice: string | null, convId: number): Promise<boolean> {
  const hit = choice ? ID.exec(choice) : null;
  if (!hit) return false;
  const x = await introOf(env, Number(hit[1]), convId);
  if (!x) return true; // an old button of a call that was refunded or cancelled: nothing
  const [, , q, a] = hit;
  await advance(env, x, q, a);
  return true;
}

async function advance(env: Env, x: IntroConv, q: string, a: string): Promise<void> {
  const cp = copyFor(x.locale);
  if (q === "name") {
    await ask(env, x, "intent_work", workOut(cp, x.introId), "work");
    return;
  }
  if (q === "work") {
    await ask(env, x, "intent_area", areaOut(cp, x.introId), "area");
    return;
  }
  if (q === "area" && isArea(a)) {
    await env.DB.prepare("UPDATE intros SET help_area = ?2, updated_at = ?3 WHERE id = ?1").bind(x.introId, a, nowIso()).run();
    if (a === "OTHER") {
      await ask(env, x, "intent_other", otherOut(cp, x.introId), "other");
      return;
    }
  }
  await thanks(env, x); // a chosen area, Skip on the area or on "Something else"
}

// ---- typed answers (src/whatsapp.ts, while one of the questions is the open step) ----
// "done": the answer was taken (and the next question, or the thanks, sent). "pass": it is not an answer (a question, a long message, noise):
// the questions end there and the message goes the usual way. Safety and the noise rules run in the caller (the gatekeeper, before this).
const W = config.router.stepWords;
const oneOf = (text: string, list: readonly string[]) => list.some((w) => normalize(w) === normalize(text));
const LINKISH = /https?:\/\/|www\.|@|\d{3,}/i;
// Topics that mean a question about something else, not an answer ("when is my call?", "price?"). An illness or "Something else" words are answers.
const QUESTION_TOPICS: readonly Topic[] = ["payment_issue", "refund", "my_booking", "abroad", "in_person", "trust", "price", "how_it_works", "timings", "what_is_this", "book", "video"];
const looksLikeQuestion = (text: string) => /[?？]/.test(text) || QUESTION_TOPICS.includes(matchTopic(text) as Topic);
const words = (text: string) => normalize(text).split(" ").filter(Boolean).length;

export function cleanName(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t || [...t].length > config.intent.nameMaxChars || words(t) > config.intent.nameMaxWords) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(t)) return null; // letters, spaces, dots, apostrophes and dashes only
  if (oneOf(t, [...W.yes, ...W.no, ...config.words.ack, ...config.menuWords, "skip"]) || matchTopic(t) !== null || isOutOfScope(t)) return null;
  return t;
}
export function cleanWork(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t || [...t].length > config.intent.workMaxChars || words(t) > config.intent.workMaxWords || LINKISH.test(t) || /[?？]/.test(t) || isOutOfScope(t)) return null;
  if (oneOf(t, [...W.yes, ...W.no, ...config.words.ack, ...config.menuWords])) return null;
  return t;
}

export type IntentSay = (out: Out, step: string) => Promise<unknown>;

export async function intentText(env: Env, convId: number, open: OpenStep, text: string, say: IntentSay): Promise<"done" | "pass"> {
  const introId = introIdOf(open);
  const x = introId !== null ? await introOf(env, introId, convId) : null;
  if (!x || !isIntentStep(open.step)) return "pass";
  const cp = copyFor(x.locale);
  const t = text.trim();
  if (open.step === "intent_name") {
    // "yes" / "ok" with the WhatsApp name on the button: that name. "no": skip.
    if (oneOf(t, W.no)) return advance(env, x, "name", "skip").then(() => "done");
    if (x.name && oneOf(t, [...W.yes, ...config.words.ack])) return advance(env, x, "name", "use").then(() => "done");
    const name = cleanName(t);
    if (!name) return "pass";
    await env.DB.prepare("UPDATE conversations SET display_name = ?2, name_given_at = ?3 WHERE id = ?1").bind(x.convId, name, nowIso()).run();
    await advance(env, x, "name", "typed");
    return "done";
  }
  if (open.step === "intent_work") {
    if (oneOf(t, W.no)) return advance(env, x, "work", "skip").then(() => "done");
    const work = cleanWork(t);
    if (!work) return "pass";
    await env.DB.prepare("UPDATE intros SET profession = ?2, updated_at = ?3 WHERE id = ?1").bind(x.introId, work, nowIso()).run();
    await advance(env, x, "work", "typed");
    return "done";
  }
  // The area list, typed instead of tapped, or the words after "Something else": both are "Something else" in their own words.
  if (open.step === "intent_area" && oneOf(t, W.no)) return advance(env, x, "area", "skip").then(() => "done");
  if (open.step === "intent_other" && oneOf(t, W.no)) return advance(env, x, "other", "skip").then(() => "done");
  if ([...t].length > config.intent.otherMaxChars || (looksLikeQuestion(t) && !isOutOfScope(t))) return "pass";
  await env.DB.prepare("UPDATE intros SET help_area = 'OTHER', updated_at = ?2 WHERE id = ?1").bind(x.introId, nowIso()).run();
  if (isOutOfScope(t)) {
    await raiseOutOfScope(env, x.convId);
    await say(menuOut(cp, true, isSexualHealth(t) ? cp.answerSexualHealth : cp.answerMedical), "intent-scope");
    return "done";
  }
  await thanks(env, x);
  return "done";
}

const introIdOf = (open: OpenStep): number | null => {
  const out = open.out;
  const ids = out.type === "buttons" ? out.buttons.map((b) => b.id) : out.type === "list" ? (out.sections?.flatMap((s) => s.rows) ?? out.rows ?? []).map((r) => r.id) : [];
  for (const i of ids) {
    const hit = ID.exec(i);
    if (hit) return Number(hit[1]);
  }
  return null;
};

// ---- the team's item ----
// A paying customer: a paid ₹99 call not yet held, or a session booked and not yet held. The item names that booking ("Check this booking").
// Nothing before a payment. Returns true when a new item was opened.
export async function raiseOutOfScope(env: Env, convId: number, nowMs = Date.now()): Promise<boolean> {
  const now = iso(nowMs);
  const intro = await env.DB
    .prepare("SELECT i.id FROM intros i JOIN slots s ON s.id = i.slot_id WHERE i.conversation_id = ?1 AND i.state IN ('PAID', 'RESCHEDULED') AND s.end_utc > ?2 ORDER BY s.start_utc LIMIT 1")
    .bind(convId, iso(nowMs - 24 * 3_600_000))
    .first<{ id: number }>();
  if (intro) return raiseAttention(env.DB, OUT_OF_SCOPE, `intro:${intro.id}`);
  const ses = await env.DB
    .prepare("SELECT se.id FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.conversation_id = ?1 AND se.state IN ('CONFIRMED', 'CREDIT_BOOKED') AND s.end_utc > ?2 ORDER BY s.start_utc LIMIT 1")
    .bind(convId, now)
    .first<{ id: number }>();
  return ses ? raiseAttention(env.DB, OUT_OF_SCOPE, `session:${ses.id}`) : false;
}

// ---- what the team sees (the Today call card and the person page in /app) ----
// Their work and what they would like help with, and the open "consider a refund" item, for whoever may read this customer's chat text
// (the owner; the practitioner for their own customers; staff while Settings → Privacy lets them read chats). Never on /amma.
const ABOUT = {
  en: {
    work: (w: string) => `Work: ${w}`,
    area: (a: string) => `Wants help with: ${a}`,
    scope: "Check this booking: the concern may be outside what we offer — consider a refund.",
  },
  hi: {
    work: (w: string) => `काम: ${w}`,
    area: (a: string) => `किस बात में मदद चाहिए: ${a}`,
    scope: "इस बुकिंग को देखें: यह बात शायद हमारी सेवा से बाहर है — रिफ़ंड पर विचार करें।",
  },
} as const;

export type About = { profession: string | null; helpArea: string | null; outOfScope: number | boolean | null };

export async function seesAbout(db: Env["DB"], m: Member, practitionerId: number | null): Promise<boolean> {
  return can(m, "read_chat", { practitionerId }) === "yes" && !(await chatTextHidden(db, m.role));
}

export function aboutHtml(a: About, locale: string | null | undefined) {
  const lang = consoleLang(locale);
  const w = ABOUT[lang];
  const parts = [a.profession ? w.work(a.profession) : "", isArea(a.helpArea) ? w.area(copyFor(lang).intentAreas[a.helpArea]) : ""].filter(Boolean);
  if (!parts.length && !a.outOfScope) return "";
  return html`${parts.length ? html`<p class="muted about">${parts.join(" · ")}</p>` : ""}${a.outOfScope ? html`<p>${statusChip(w.scope, "attention")}</p>` : ""}`;
}

// The person page: the latest answers they gave, and whether any of their bookings has an open item.
export const aboutPerson = (db: Env["DB"], convId: number) =>
  db
    .prepare(
      `SELECT (SELECT profession FROM intros WHERE conversation_id = ?1 AND profession IS NOT NULL ORDER BY id DESC LIMIT 1) AS profession,
         (SELECT help_area FROM intros WHERE conversation_id = ?1 AND help_area IS NOT NULL ORDER BY id DESC LIMIT 1) AS helpArea,
         EXISTS (SELECT 1 FROM attention a WHERE a.kind = '${OUT_OF_SCOPE}' AND a.resolved_at IS NULL AND (
           a.target IN (SELECT 'intro:' || id FROM intros WHERE conversation_id = ?1) OR a.target IN (SELECT 'session:' || id FROM sessions WHERE conversation_id = ?1))) AS outOfScope`,
    )
    .bind(convId)
    .first<About>();
