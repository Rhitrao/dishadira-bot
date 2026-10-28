// Today (/app): "What needs me now?" (docs/CONSOLE-PRD.md, "Today"). In this order: Safety, Waiting for a reply, Approvals (owner),
// Up next, Later, and Loose ends. Owners get a banner only for what affects everyone (bookings paused, payments failing, the bot not run).
// A practitioner sees only their own calls and their own customers' safety cards, and nothing about money.
// Server-rendered, no scripts; every change is a POST with Origin (checked in src/console.ts) + a per-form member CSRF token, and
// every button and every POST asks the same can() (src/auth.ts), through the helpers below, so a hidden button and a refused POST agree.
// Outcome taps use the same write as /amma (recordOutcome in src/outcomes.ts); the cron applies them after the undo window.
import type { D1Result } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { FIRST_BUY } from "./amma";
import { can, canAny, memberById, memberCsrf, type Member } from "./auth";
import { chatTextHidden, hasOwnName } from "./business";
import { config } from "./config";
import { auditStmt, languageCsrf, refused, S, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy, consoleLang, type ConsoleLang } from "./console-copy";
import { rupees, serviceName, type ForWhom } from "./copy";
import type { Env } from "./env";
import { heartbeatStale } from "./mail";
import { isOutcomeValue, recordOutcome, undoOutcome, type OutcomeValue } from "./outcomes";
import { razorpay } from "./pay/razorpay";
import { decideRequest, openRequests, REQUEST_ACTION, requestById, targetId, type Decided, type RequestRow } from "./requests";
import { iso, istDay } from "./slots";
import { bookingsOpen } from "./switches";
import {
  appointmentRow, banner, bookingChip, button, callLangText, clock, confirmStep, consoleFrame, dayName, emptyState, firstName,
  forWhomText, last4, ledger, listRow, roleName, rows as rowList, screenHead, section, statusChip, taskCard,
} from "./ui";

// ---------- Today's words, English and Hindi, in the shape of src/console-copy.ts (a later review moves them into the catalogue) ----------
const en = {
  noName: "No name",
  safetyCrisis: (who: string) => `Crisis message from ${who}`,
  safetyEmergency: (who: string) => `Possible medical emergency: ${who}`,
  openPage: "Open their page",
  replyTo: (who: string) => `Reply to ${who}`,
  refundTitle: (amount: string, who: string) => `Refund ${amount} to ${who}`,
  blockTitle: (who: string) => `Block ${who}`,
  markPaidTitle: (amount: string, who: string) => `${amount} received from ${who}, outside Razorpay`,
  askedBy: (name: string, ago: string) => `Asked by ${name}, ${ago}`,
  reasonLine: (r: string) => `Reason: ${r}`,
  refundEffect: (amount: string, who: string) => `${amount} goes back to ${who}'s original payment method. The bank takes a few days.`,
  refundYes: (amount: string) => `Refund ${amount}`,
  blockEffect: (who: string) => `${who} gets no more replies from the bot. You can unblock them on their page.`,
  blockYes: (who: string) => `Block ${who}`,
  markPaidEffect: (amount: string) => `This records that ${amount} was received outside Razorpay and confirms their booking. They get the usual confirmation on WhatsApp.`,
  markPaidYes: (amount: string) => `Record ${amount} as received`,
  kindCall: (min: number) => `${min}-minute call`,
  kindSession: "Session",
  kindSessionPackage: (n: number, size: number) => `Session ${n} of ${size}, from a package`,
  outSESSION: "Book a session",
  outNOT_FIT: "Not a fit",
  outMISSED: "Didn't pick up",
  outRUDE: "Reported behaviour",
  marked: (outcome: string) => `Marked: ${outcome}`,
  noOutcomeYet: "No outcome marked yet",
  reportEffect: (amount: string) => `They're blocked from the bot when the undo time ends, and their ${amount} refund waits for the owner.`,
  reportYes: "Report and block",
  tomorrowLine: (calls: number, sessions: number) =>
    calls + sessions === 0
      ? "Tomorrow: nothing booked"
      : `Tomorrow: ${[calls ? (calls === 1 ? "1 call" : `${calls} calls`) : "", sessions ? (sessions === 1 ? "1 session" : `${sessions} sessions`) : ""].filter(Boolean).join(", ")}`,
  noOutcomeFrom: (day: string) => `${day}: no outcome marked yet`,
  unpaidLinks: (n: number) => (n === 1 ? "1 payment link sent today isn't paid" : `${n} payment links sent today aren't paid`),
  openChats: (n: number) => (n === 1 ? "1 chat is still waiting for a reply" : `${n} chats are still waiting for a reply`),
  notStarted: "This call hasn't started yet. Nothing was saved.",
  tooLateToMark: "More than 24 hours have passed since this call, so it can't be marked here. Nothing was saved.",
  changed: "This booking has changed. Nothing was saved.",
  callTitle: (who: string) => `Call ${who}`,
  callLogged: "Showing the number was recorded.",
  backToday: "Back to Today",
  someone: "someone",
  flashUndone: "Undone. Nothing will happen.",
  flashHandedBack: "Handed back to the bot.",
  flashApproved: "Approved and done.",
  flashDeclined: "Declined. Nothing was changed.",
  flashRecorded: "Recorded as received. Their booking is confirmed.",
  flashLate: "Recorded as received, but that time was taken in the meantime, so nothing was booked. Offer them a new time from the Inbox, or refund them.",
  flashNothing: "Decided. There was nothing left to do.",
  flashAlready: "Someone already decided this. Nothing was changed.",
  flashGone: "Nothing changed: this was already done.",
  ago: (min: number) => (min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`),
};
type TodayCopy = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : string };

const hi: TodayCopy = {
  noName: "नाम नहीं",
  safetyCrisis: (who) => `${who} का संकट वाला संदेश`,
  safetyEmergency: (who) => `शायद मेडिकल इमरजेंसी: ${who}`,
  openPage: "उनका पेज खोलें",
  replyTo: (who) => `${who} को जवाब दें`,
  refundTitle: (amount, who) => `${who} को ${amount} रिफ़ंड`,
  blockTitle: (who) => `${who} को ब्लॉक करें`,
  markPaidTitle: (amount, who) => `${who} से ${amount} मिले, Razorpay के बाहर`,
  askedBy: (name, ago) => `${name} ने पूछा, ${ago}`,
  reasonLine: (r) => `वजह: ${r}`,
  refundEffect: (amount, who) => `${amount} ${who} के उसी पेमेंट तरीक़े में वापस जाएँगे। बैंक को कुछ दिन लगते हैं।`,
  refundYes: (amount) => `${amount} रिफ़ंड करें`,
  blockEffect: (who) => `${who} को बॉट से अब कोई जवाब नहीं मिलेगा। उनके पेज से अनब्लॉक कर सकते हैं।`,
  blockYes: (who) => `${who} को ब्लॉक करें`,
  markPaidEffect: (amount) => `इससे दर्ज होगा कि ${amount} Razorpay के बाहर मिले, और उनकी बुकिंग पक्की हो जाएगी। उन्हें WhatsApp पर हमेशा वाली पुष्टि मिलेगी।`,
  markPaidYes: (amount) => `${amount} मिले, दर्ज करें`,
  kindCall: (min) => `${min} मिनट की कॉल`,
  kindSession: "सेशन",
  kindSessionPackage: (n, size) => `पैकेज का सेशन ${n}/${size}`,
  outSESSION: "सेशन बुक करें",
  outNOT_FIT: "सही नहीं",
  outMISSED: "फ़ोन नहीं उठाया",
  outRUDE: "बुरे बर्ताव की शिकायत",
  marked: (outcome) => `दर्ज: ${outcome}`,
  noOutcomeYet: "अभी कुछ दर्ज नहीं",
  reportEffect: (amount) => `वापस लेने का समय ख़त्म होते ही वे बॉट से ब्लॉक हो जाएँगे, और उनका ${amount} रिफ़ंड मालिक के फ़ैसले का इंतज़ार करेगा।`,
  reportYes: "शिकायत करें और ब्लॉक करें",
  tomorrowLine: (calls, sessions) =>
    calls + sessions === 0 ? "कल: कुछ बुक नहीं" : `कल: ${[calls ? `${calls} कॉल` : "", sessions ? `${sessions} सेशन` : ""].filter(Boolean).join(", ")}`,
  noOutcomeFrom: (day) => `${day}: अभी कुछ दर्ज नहीं`,
  unpaidLinks: (n) => `आज भेजे गए ${n} पेमेंट लिंक का पेमेंट नहीं हुआ`,
  openChats: (n) => `${n} चैट अभी भी जवाब का इंतज़ार कर रही हैं`,
  notStarted: "यह कॉल अभी शुरू नहीं हुई। कुछ सेव नहीं हुआ।",
  tooLateToMark: "इस कॉल को 24 घंटे से ज़्यादा हो गए, इसलिए यहाँ दर्ज नहीं हो सकता। कुछ सेव नहीं हुआ।",
  changed: "यह बुकिंग बदल गई है। कुछ सेव नहीं हुआ।",
  callTitle: (who) => `${who} को कॉल करें`,
  callLogged: "नंबर दिखाना दर्ज कर लिया गया है।",
  backToday: "आज पर वापस",
  someone: "किसी",
  flashUndone: "वापस ले लिया। कुछ नहीं होगा।",
  flashHandedBack: "बॉट को वापस दे दिया।",
  flashApproved: "मंज़ूर हो गया और काम हो गया।",
  flashDeclined: "मना कर दिया। कुछ नहीं बदला।",
  flashRecorded: "मिला हुआ दर्ज कर लिया। उनकी बुकिंग पक्की हो गई।",
  flashLate: "मिला हुआ दर्ज कर लिया, पर इस बीच वह समय किसी और ने ले लिया, इसलिए कुछ बुक नहीं हुआ। इनबॉक्स से उन्हें नया समय दें, या पैसे लौटा दें।",
  flashNothing: "फ़ैसला हो गया। करने को कुछ बचा नहीं था।",
  flashAlready: "किसी ने पहले ही फ़ैसला कर दिया। कुछ नहीं बदला।",
  flashGone: "कुछ नहीं बदला: यह पहले ही हो चुका था।",
  ago: (min) => (min < 1 ? "अभी" : min < 60 ? `${min} मिनट पहले` : min < 48 * 60 ? `${Math.round(min / 60)} घंटे पहले` : `${Math.round(min / 1440)} दिन पहले`),
};

export const TODAY_COPY: Record<ConsoleLang, TodayCopy> = { en, hi };
const todayCopy = (locale: string | null | undefined) => TODAY_COPY[consoleLang(locale)];

// ---------- the bookings Today shows ----------
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const OUTCOME_HOURS = 24; // "How did it go?" from the start time until this many hours later

export type Booking = {
  kind: "CALL" | "SESSION"; id: number; slotId: number; startUtc: string; endUtc: string; state: string;
  convId: number; name: string | null; waId: string; locale: string; service: string; callLang: string | null; forWhom: ForWhom | null;
  practitionerId: number | null; origin: string | null; packSize: number | null; packNo: number | null; firstBuy: number; amount: number | null;
  oid: number | null; value: string | null; tappedAt: string | null; undoUntil: string | null; appliedAt: string | null;
};

const PAID = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
// The same calls and sessions /amma lists, plus whose they are. `where` narrows to a time range or one row; ?3 is the practitioner (NULL = all).
const CALLS_SQL = (where: string) => `SELECT 'CALL' AS kind, i.id, i.slot_id AS slotId, s.start_utc AS startUtc, s.end_utc AS endUtc, i.state,
    c.id AS convId, c.display_name AS name, c.wa_id AS waId, c.locale, i.service, i.call_lang AS callLang, i.for_whom AS forWhom,
    i.practitioner_id AS practitionerId, NULL AS origin, NULL AS packSize, NULL AS packNo, 0 AS firstBuy, ${config.prices.intro} AS amount,
    o.id AS oid, o.value, o.tapped_at AS tappedAt, o.undo_until AS undoUntil, o.applied_at AS appliedAt
  FROM intros i JOIN slots s ON s.id = i.slot_id JOIN conversations c ON c.id = i.conversation_id
  LEFT JOIN outcomes o ON o.intro_id = i.id AND o.slot_id = i.slot_id
  WHERE s.kind = 'CALL' AND i.state IN ('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE') AND (?3 IS NULL OR i.practitioner_id = ?3) AND ${where}`;
const SESSIONS_SQL = (where: string) => `SELECT 'SESSION' AS kind, se.id, se.slot_id AS slotId, s.start_utc AS startUtc, s.end_utc AS endUtc, se.state,
    c.id AS convId, c.display_name AS name, c.wa_id AS waId, c.locale, se.service, COALESCE(se.call_lang, i.call_lang) AS callLang,
    COALESCE(se.for_whom, i.for_whom) AS forWhom, se.practitioner_id AS practitionerId, se.origin,
    (SELECT k.size FROM packages k WHERE k.id = se.package_id) AS packSize,
    (SELECT COUNT(*) FROM credits cr WHERE cr.package_id = se.package_id AND cr.reason = 'BOOK' AND cr.session_id <= se.id) AS packNo,
    ${FIRST_BUY} AS firstBuy,
    COALESCE((SELECT k.price_paise FROM packages k WHERE k.id = se.package_id),
             (SELECT COALESCE(p.paid_paise, p.amount_paise) FROM payments p WHERE p.purpose = 'SESSION' AND p.target_id = se.id AND p.state IN ${PAID} ORDER BY p.id LIMIT 1)) AS amount,
    o.id AS oid, o.value, o.tapped_at AS tappedAt, o.undo_until AS undoUntil, o.applied_at AS appliedAt
  FROM sessions se JOIN slots s ON s.id = se.slot_id JOIN conversations c ON c.id = se.conversation_id
  LEFT JOIN intros i ON i.id = se.intro_id LEFT JOIN outcomes o ON o.session_id = se.id
  WHERE s.kind = 'SESSION' AND se.state IN ('CONFIRMED','CREDIT_BOOKED','NOT_FIT') AND (?3 IS NULL OR se.practitioner_id = ?3) AND ${where}`;

export async function bookingsBetween(env: Env, fromUtc: string, toUtc: string, practitionerId: number | null): Promise<Booking[]> {
  const where = "s.start_utc >= ?1 AND s.start_utc < ?2";
  const [calls, sessions] = await env.DB.batch([
    env.DB.prepare(CALLS_SQL(where)).bind(fromUtc, toUtc, practitionerId),
    env.DB.prepare(SESSIONS_SQL(where)).bind(fromUtc, toUtc, practitionerId),
  ]);
  return [...(calls.results as Booking[]), ...(sessions.results as Booking[])].sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id - b.id);
}

async function bookingOf(env: Env, kind: "CALL" | "SESSION", id: number): Promise<Booking | null> {
  const sql = kind === "CALL" ? CALLS_SQL("i.id = ?1 AND ?2 IS NULL") : SESSIONS_SQL("se.id = ?1 AND ?2 IS NULL");
  return env.DB.prepare(sql).bind(id, null, null).first<Booking>();
}

// ---------- the permission questions, asked the same way by the page and by each POST ----------
const startMs = (b: Booking) => Date.parse(b.startUtc);
// A call may be marked from its start until OUTCOME_HOURS later, by whoever may mark it. A session has one answer, "Not a fit", and only
// on a buyer's very first session (no ₹99 call before it), as on /amma.
const mayMark = (m: Member, b: Booking) => can(m, "mark_outcome", { practitionerId: b.practitionerId }) === "yes";
const outcomeOpen = (b: Booking, now: number) => now >= startMs(b) && now < startMs(b) + OUTCOME_HOURS * HOUR;
const outcomesFor = (b: Booking): OutcomeValue[] =>
  b.kind === "CALL" ? (["PAID", "RESCHEDULED"].includes(b.state) ? ["SESSION", "NOT_FIT", "MISSED", "RUDE"] : []) : ["CONFIRMED", "CREDIT_BOOKED"].includes(b.state) && b.firstBuy === 1 ? ["NOT_FIT"] : [];
// The Call button (an audited reveal of the number) only from 1 hour before the start to 1 hour after the end, for everyone.
export const callAllowed = (m: Member, b: Booking, now: number) =>
  now >= startMs(b) - HOUR && now <= Date.parse(b.endUtc) + HOUR &&
  can(m, "reveal_phone", { practitionerId: b.practitionerId, callStartMs: startMs(b), callEndMs: Date.parse(b.endUtc), nowMs: now }) === "yes";
// Who sees what: an owner or staff member sees every booking (null), a practitioner their own.
const scopeOf = (m: Member) => (can(m, "view_today") === "yes" ? null : m.id);
// Safety text: owners, and the practitioner whose customer it is. Staff see only that an owner is needed.
const seesSafety = (m: Member) => can(m, "read_chat", { safety: true, practitionerId: m.id }) === "yes";

const kindKey = (b: Booking) => (b.kind === "CALL" ? "intro" : "session");
const outScope = (b: Booking, v: string) => `outcome:${kindKey(b)}:${b.id}:${v}`;

// ---------- small text helpers ----------
const who = (name: string | null, waId: string, t: TodayCopy) => `${firstName(name, t.noName)} ${last4(waId)}`;
const agoText = (utc: string, now: number, t: TodayCopy) => t.ago(Math.max(0, Math.round((now - Date.parse(utc)) / 60_000)));
const at = (utc: string, now: number, locale: string) => (istDay(Date.parse(utc)) === istDay(now) ? clock(utc, locale) : `${dayName(utc, locale)}, ${clock(utc, locale)}`);
const outWord = (v: string, t: TodayCopy) => (isOutcomeValue(v) ? (t[`out${v}`] as string) : "");
const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));

// A few lines of layout the shared stylesheet doesn't have: rows wrapped for their anchors keep their dividers.
const TODAY_CSS = raw(`<style>.ledger>.bk+.bk>.appt{border-top:1px solid var(--line)}.bk{scroll-margin-top:16px}.outq{font-weight:600;margin:8px 0 0}
.saved{font-weight:600;margin:0}.saved+.acts{margin-top:8px}details.more{margin-top:8px}details.more>summary{list-style:none}details.more>summary::-webkit-details-marker{display:none}
details.more[open]>summary{margin-bottom:8px}</style>`);

// ---------- one booking row ----------
async function bookingRow(c: ConsoleCtx, b: Booking, now: number) {
  const m = c.get("member");
  const jwt = c.get("jwt");
  const cc = consoleCopy(m.locale);
  const t = todayCopy(m.locale);
  const lang = consoleLang(m.locale);
  const kindText =
    b.kind === "CALL" ? t.kindCall(config.slots.callMinutes) : b.origin === "CREDIT" && b.packSize ? t.kindSessionPackage(b.packNo ?? 0, b.packSize) : t.kindSession;
  const details = [kindText, forWhomText(b.forWhom, m.locale), callLangText(b.callLang ?? b.locale, m.locale)];
  if (istDay(startMs(b)) !== istDay(now)) details.unshift(dayName(b.startUtc, m.locale));
  const action = callAllowed(m, b, now)
    ? { label: cc.call, kind: "primary" as const, post: { action: "/app/today/call", csrf: await memberCsrf(jwt, m, `call:${kindKey(b)}:${b.id}`), fields: { kind: kindKey(b), id: String(b.id) } } }
    : undefined;

  let extra: unknown = "";
  const nowStr = iso(now);
  if (b.oid !== null && b.value) {
    const word = outWord(b.value, t);
    if (!b.appliedAt && (b.undoUntil ?? "") > nowStr) {
      const undo = mayMark(m, b) ? button({ label: cc.undo, post: { action: "/app/today/undo", csrf: await memberCsrf(jwt, m, `undo:${b.oid}`), fields: { outcome: String(b.oid) } } }) : "";
      extra = html`<p class="saved" role="status">${word} · ${cc.savedUndoUntil(clock(b.undoUntil!, m.locale))}</p>${undo ? html`<div class="acts">${undo}</div>` : ""}`;
    } else extra = html`<p class="saved">${t.marked(word)}</p>`;
  } else if (mayMark(m, b) && outcomesFor(b).length && outcomeOpen(b, now)) {
    const vs = outcomesFor(b);
    const amount = rupees(b.amount ?? config.prices.intro);
    const label: Record<OutcomeValue, string> = { SESSION: cc.outcomeSession, NOT_FIT: cc.outcomeNotFit(amount), MISSED: cc.outcomeMissed, RUDE: cc.reportBehaviour };
    const post = async (v: OutcomeValue) => ({ action: "/app/today/outcome", csrf: await memberCsrf(jwt, m, outScope(b, v)), fields: { kind: kindKey(b), id: String(b.id), v } });
    const main = await Promise.all(vs.filter((v) => v !== "RUDE").map(async (v) => button({ label: label[v], post: await post(v), kind: v === "SESSION" ? "primary" : "secondary" })));
    // "Report behaviour" sits under More, away from the outcome buttons, behind a confirm step that says what happens.
    const more = vs.includes("RUDE")
      ? html`<details class="more"><summary class="btn quiet">${cc.tabMore}</summary>${confirmStep({ label: `${cc.reportBehaviour}…`, effect: t.reportEffect(amount), confirm: t.reportYes, post: await post("RUDE") })}</details>`
      : "";
    extra = html`<p class="outq">${cc.howDidItGo}</p><div class="acts">${main}</div>${more}`;
  } else if (b.oid === null && outcomesFor(b).length && now >= startMs(b) + OUTCOME_HOURS * HOUR) {
    extra = statusChip(t.noOutcomeYet, "attention");
  }
  return html`<div class="bk" id="b-${kindKey(b)}-${b.id}">${appointmentRow({
    time: clock(b.startUtc, lang),
    name: firstName(b.name, t.noName),
    waId: b.waId,
    service: serviceName(b.service, lang),
    details,
    status: b.oid === null ? bookingChip(b.state, m.locale) : "",
    action,
    extra,
  })}</div>`;
}

// ---------- the page ----------
type SafetyItem = { id: number; kind: string; createdAt: string; convId: number; name: string | null; waId: string };
type Waiting = { convId: number; name: string | null; waId: string; since: string | null; lastUserAt: string | null };

const FLASH: Record<string, keyof TodayCopy> = {
  undone: "flashUndone", handback: "flashHandedBack", approved: "flashApproved", declined: "flashDeclined", recorded: "flashRecorded",
  nothing: "flashNothing", gone: "flashGone", late: "flashLate",
};

export async function todayPage(c: ConsoleCtx, o: { flash?: string | null; status?: 200 | 403 | 409 | 503 } = {}) {
  const env = c.env;
  const m = c.get("member");
  const now = Date.now();
  const cc = consoleCopy(m.locale);
  const t = todayCopy(m.locale);
  const scope = scopeOf(m);
  const todayYmd = istDay(now);
  const dayStart = dayStartUtc(todayYmd);
  const dayEnd = iso(Date.parse(dayStart) + DAY);
  const isOwner = can(m, "business_settings") === "yes";

  // 1. Safety: an open crisis or emergency item; for a practitioner only their own customers'.
  const safety = (
    await env.DB.prepare(
      `SELECT a.id, a.kind, a.created_at AS createdAt, c.id AS convId, c.display_name AS name, c.wa_id AS waId
       FROM attention a JOIN conversations c ON a.target = 'conv:' || c.id
       WHERE a.kind IN ('CRISIS','EMERGENCY') AND a.resolved_at IS NULL
         AND (?1 IS NULL OR EXISTS (SELECT 1 FROM intros i WHERE i.conversation_id = c.id AND i.practitioner_id = ?1)
                         OR EXISTS (SELECT 1 FROM sessions s WHERE s.conversation_id = c.id AND s.practitioner_id = ?1))
       ORDER BY a.id LIMIT 50`,
    ).bind(scope).all<SafetyItem>()
  ).results;
  const safetyCards = safety.map((s) => {
    const person = who(s.name, s.waId, t);
    if (!seesSafety(m))
      return html`<article class="card danger"><h3>${cc.safetyHidden}</h3><p class="why">${person} · ${at(s.createdAt, now, m.locale)}</p><div class="acts">${button({ label: t.openPage, href: `/app/people/${s.convId}`, kind: "primary" })}</div></article>`;
    const href = canAny(m, "reply_chat") ? `/app/inbox/${s.convId}` : `/app/people/${s.convId}`;
    return html`<article class="card danger"><h3>${s.kind === "CRISIS" ? t.safetyCrisis(person) : t.safetyEmergency(person)}</h3>
<p class="why">${at(s.createdAt, now, m.locale)} · ${cc.safetySent}</p><div class="acts">${button({ label: cc.openChat, href, kind: "danger" })}</div></article>`;
  });

  // 2. Waiting for a reply: every chat handed to the team, oldest first (owners and staff, who reply).
  const replies = canAny(m, "reply_chat");
  const waiting = replies
    ? (
        await env.DB.prepare(
          "SELECT id AS convId, display_name AS name, wa_id AS waId, human_since AS since, last_user_at AS lastUserAt FROM conversations WHERE mode = 'HUMAN' ORDER BY COALESCE(human_since, last_user_at, created_at), id LIMIT 50",
        ).all<Waiting>()
      ).results
    : [];
  // Today shows no message text; when the owner hides chat text from staff, their cards say so before they open the chat.
  const textHidden = replies && waiting.length ? await chatTextHidden(env.DB, m.role) : false;
  const waitingCards = await Promise.all(
    waiting.map(async (w) => {
      const end = w.lastUserAt ? Date.parse(w.lastUserAt) + config.windowHours * HOUR : 0;
      const windowLine = end > now ? cc.replyBy(at(iso(end), now, m.locale)) : cc.windowClosed;
      const why = w.since ? `${cc.askedForPerson(agoText(w.since, now, t))}. ${windowLine}.` : `${windowLine}.`;
      const handBack =
        can(m, "reply_chat") === "yes"
          ? button({ label: cc.handBack, post: { action: "/app/today/handback", csrf: await memberCsrf(c.get("jwt"), m, `handback:${w.convId}`), fields: { conv: String(w.convId) } } })
          : "";
      return html`<article class="card attention"><h3>${t.replyTo(who(w.name, w.waId, t))}</h3><p class="why">${why}</p>${textHidden ? html`<p class="muted">${cc.chatTextHidden}.</p>` : ""}
<div class="acts">${button({ label: cc.reply, href: `/app/inbox/${w.convId}`, kind: "primary" })}${handBack}</div></article>`;
    }),
  );

  // 3. Approvals (owners only): one card per open "ask owner" request.
  const approvals = isOwner ? await approvalCards(c, await openRequests(env, m.workspaceId), now) : [];

  // 4. Up next: today's calls and sessions in time order.
  const day = await bookingsBetween(env, dayStart, dayEnd, scope);
  const dayRows = await Promise.all(day.map((b) => bookingRow(c, b, now)));
  let upNext: unknown;
  if (day.length) upNext = ledger(dayRows);
  else {
    const next = await nextBooking(env, dayEnd, scope);
    upNext = emptyState(next ? cc.noCallsToday(`${dayName(next, m.locale)}, ${clock(next, m.locale)}`) : cc.noCallsBooked, { label: cc.openCalendar, href: "/app/calendar" });
  }

  // 5. Later: tomorrow, with a link to the calendar.
  const tomorrowStart = dayEnd;
  const tomorrow = await bookingsBetween(env, tomorrowStart, iso(Date.parse(tomorrowStart) + DAY), scope);
  const live = (b: Booking) => (b.kind === "CALL" ? ["PAID", "RESCHEDULED"].includes(b.state) : ["CONFIRMED", "CREDIT_BOOKED"].includes(b.state));
  const later = rowList(
    listRow({
      href: "/app/calendar",
      title: t.tomorrowLine(tomorrow.filter((b) => b.kind === "CALL" && live(b)).length, tomorrow.filter((b) => b.kind === "SESSION" && live(b)).length),
      sub: dayName(tomorrowStart, m.locale),
      end: html`<span class="muted" aria-hidden="true">›</span>`,
    }),
  );

  // 6. Loose ends: earlier calls with no outcome (never a block on new bookings: they wait here); after today's last call, also
  // today's unmarked calls, unpaid links and open chats, so the day closes clean.
  const earlier = (await bookingsBetween(env, iso(Date.parse(dayStart) - 7 * DAY), dayStart, scope)).filter((b) => b.kind === "CALL" && b.oid === null && outcomesFor(b).length);
  const loose: unknown[] = await Promise.all(earlier.map((b) => bookingRow(c, b, now)));
  const looseLinks: unknown[] = [];
  const dayClosed = day.every((b) => Date.parse(b.endUtc) <= now);
  if (dayClosed) {
    for (const b of day.filter((b) => b.oid === null && outcomesFor(b).length))
      looseLinks.push(listRow({ href: `#b-${kindKey(b)}-${b.id}`, title: `${clock(b.startUtc, m.locale)} · ${who(b.name, b.waId, t)}`, sub: t.noOutcomeYet }));
    if (scope === null && canAny(m, "move_booking")) {
      const unpaid = (await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE state IN ('CREATING','PENDING') AND created_at >= ?1").bind(dayStart).first<{ n: number }>())!.n;
      if (unpaid) looseLinks.push(listRow({ href: isOwner ? "/app/payments" : "/app/people", title: t.unpaidLinks(unpaid) }));
    }
    if (replies && waiting.length) looseLinks.push(listRow({ href: "/app/inbox", title: t.openChats(waiting.length) }));
  }
  const looseBody = html`${loose.length ? ledger(loose) : ""}${looseLinks.length ? rowList(looseLinks) : ""}`;

  // Banners, owners only, each with its fix.
  const banners: unknown[] = [];
  if (isOwner) {
    if (!(await bookingsOpen(env))) banners.push(banner({ text: cc.bannerPaused, fix: { label: cc.fixPaused, href: "/app/settings" } }));
    if (await env.DB.prepare("SELECT 1 AS x FROM payments WHERE state IN ('UNKNOWN','REFUND_FAILED') LIMIT 1").first())
      banners.push(banner({ text: cc.bannerPayments, fix: { label: cc.fixPayments, href: "/app/payments" }, tone: "danger" }));
    if (await heartbeatStale(env, now)) banners.push(banner({ text: cc.bannerBot, fix: { label: cc.fixBot, href: "/app/settings" }, tone: "danger" }));
  }

  // The owner's one quiet set-up task while the workspace still has the seeded name.
  const ws = await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(m.workspaceId).first<{ name: string }>();
  const nameTask = isOwner && !hasOwnName(ws?.name) ? html`<div class="setup">${taskCard({ title: cc.taskName, why: cc.taskNameWhy, primary: { label: cc.taskNameButton, href: "/app/settings#business", kind: "secondary" } })}</div>` : "";

  const body = html`${TODAY_CSS}${screenHead("today", m.locale)}
${safety.length ? section(cc.secSafety, safetyCards, safety.length) : ""}
${replies && waiting.length ? section(cc.secWaiting, waitingCards, waiting.length) : ""}
${approvals.length ? section(cc.secApprovals, approvals, approvals.length) : ""}
${nameTask}
${section(cc.secUpNext, upNext, day.length)}
${section(cc.secLater, later)}
${loose.length + looseLinks.length ? section(cc.secLooseEnds, looseBody, loose.length + looseLinks.length) : ""}`;

  const code = c.req.query("m") ?? "";
  const joined = ({ joined: S.invite.joined, transferred: S.transferred, transferred_p: S.transferredPractitioner } as Record<string, string>)[code];
  const flash = o.flash ?? (FLASH[code] ? (t[FLASH[code]] as string) : joined ?? null);
  return c.html(
    consoleFrame({
      role: m.role,
      locale: m.locale,
      active: "today",
      title: cc.tabToday,
      body,
      business: ws?.name ?? "",
      member: m.displayName ?? undefined,
      flash,
      banners,
      badges: replies && waiting.length ? { inbox: waiting.length } : undefined,
      language: { csrf: await languageCsrf(c.get("jwt"), m), back: "/app" },
      accent: c.get("accent"),
    }),
    o.status ?? 200,
  );
}

async function nextBooking(env: Env, fromUtc: string, practitionerId: number | null): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT MIN(s.start_utc) AS at FROM slots s WHERE s.start_utc >= ?1 AND (
       (s.kind = 'CALL' AND EXISTS (SELECT 1 FROM intros i WHERE i.slot_id = s.id AND i.state IN ('PAID','RESCHEDULED') AND (?2 IS NULL OR i.practitioner_id = ?2)))
       OR (s.kind = 'SESSION' AND EXISTS (SELECT 1 FROM sessions se WHERE se.slot_id = s.id AND se.state IN ('CONFIRMED','CREDIT_BOOKED') AND (?2 IS NULL OR se.practitioner_id = ?2))))`,
  ).bind(fromUtc, practitionerId).first<{ at: string | null }>();
  return r?.at ?? null;
}

// The customer a request is about, and the amount (the request's own, else what was paid).
async function requestSubject(env: Env, r: RequestRow): Promise<{ name: string | null; waId: string; paise: number | null } | null> {
  const id = targetId(r.target);
  if (r.target.startsWith("conv:"))
    return env.DB.prepare("SELECT display_name AS name, wa_id AS waId, NULL AS paise FROM conversations WHERE id = ?1").bind(id).first();
  if (r.target.startsWith("intro:")) // the Inbox's cash booking: a held call with no payment yet
    return env.DB.prepare("SELECT c.display_name AS name, c.wa_id AS waId, NULL AS paise FROM intros i JOIN conversations c ON c.id = i.conversation_id WHERE i.id = ?1").bind(id).first();
  return env.DB.prepare(
    `SELECT c.display_name AS name, c.wa_id AS waId, COALESCE(p.paid_paise, p.amount_paise) AS paise FROM payments p JOIN conversations c ON c.id = CASE p.purpose
       WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id)
       WHEN 'SESSION' THEN (SELECT conversation_id FROM sessions WHERE id = p.target_id)
       ELSE (SELECT conversation_id FROM packages WHERE id = p.target_id) END WHERE p.id = ?1`,
  ).bind(id).first();
}

async function approvalCards(c: ConsoleCtx, reqs: RequestRow[], now: number) {
  const m = c.get("member");
  const cc = consoleCopy(m.locale);
  const t = todayCopy(m.locale);
  return Promise.all(
    reqs.map(async (r) => {
      if (can(m, REQUEST_ACTION[r.kind]) !== "yes") return "";
      const subject = await requestSubject(c.env, r);
      const person = subject ? who(subject.name, subject.waId, t) : t.noName;
      const amount = rupees(r.amountPaise ?? subject?.paise ?? 0);
      const asker = await memberById(c.env, r.askedBy, m.workspaceId);
      const askerName = asker ? (asker.id === m.id ? cc.byYou : asker.displayName || asker.email) : t.someone;
      const why = html`${t.askedBy(askerName, agoText(r.createdAt, now, t))}${r.reason ? html`<br>${t.reasonLine(r.reason)}` : ""}`;
      const title = r.kind === "REFUND" ? t.refundTitle(amount, person) : r.kind === "BLOCK" ? t.blockTitle(person) : t.markPaidTitle(amount, person);
      const effect = r.kind === "REFUND" ? t.refundEffect(amount, person) : r.kind === "BLOCK" ? t.blockEffect(person) : t.markPaidEffect(amount);
      const yes = r.kind === "REFUND" ? t.refundYes(amount) : r.kind === "BLOCK" ? t.blockYes(person) : t.markPaidYes(amount);
      const post = async (decision: "APPROVED" | "DECLINED") => ({
        action: "/app/today/decide",
        csrf: await memberCsrf(c.get("jwt"), m, `decide:${r.id}:${decision}`),
        fields: { request: String(r.id), decision },
      });
      return html`<article class="card attention"><h3>${title}</h3><p class="why">${why}</p>
<div class="acts">${confirmStep({ label: `${cc.approve}…`, effect, confirm: yes, post: await post("APPROVED") })}${button({ label: cc.decline, post: await post("DECLINED") })}</div></article>`;
    }),
  ).then((cards) => cards.filter(Boolean));
}

// ---------- routes (mounted at /app by src/console.ts, after its sign-in, membership and Origin checks) ----------
export const today = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

const formOf = async (c: ConsoleCtx) => (await c.req.parseBody()) as Record<string, string | undefined>;
const forbidden = (c: ConsoleCtx) => c.text("Forbidden", 403);
const tokenOk = async (c: ConsoleCtx, given: string | undefined, scope: string) => given === (await memberCsrf(c.get("jwt"), c.get("member"), scope));
// A failed write: nothing shows as done, the page says so.
async function notSaved(c: ConsoleCtx) {
  const cc = consoleCopy(c.get("member").locale);
  try {
    return await todayPage(c, { flash: cc.notSaved, status: 503 });
  } catch {
    return c.text(cc.notSaved, 503);
  }
}
const back = (c: ConsoleCtx, code: string | null, anchor = "") => c.redirect(`/app${code ? `?m=${code}` : ""}${anchor}`, 303);

today.get("/", (c) => todayPage(c));

// "How did it go?": one tap writes the outcome (with its audit row), the row then says "Saved. Undo until <time>".
today.post("/today/outcome", async (c) => {
  const m = c.get("member");
  const f = await formOf(c);
  const kind = f.kind === "intro" ? "CALL" : f.kind === "session" ? "SESSION" : null;
  const id = Number(f.id);
  const v = f.v;
  if (!kind || !Number.isInteger(id) || !isOutcomeValue(v)) return c.text("Bad request", 400);
  if (!(await tokenOk(c, f.csrf, `outcome:${f.kind}:${id}:${v}`))) return forbidden(c);
  const b = await bookingOf(c.env, kind, id);
  if (!b || !mayMark(m, b)) return refused(c);
  const t = todayCopy(m.locale);
  const now = Date.now();
  if (b.oid !== null) return todayPage(c, { flash: await alreadyMarked(c, b), status: 409 });
  if (!outcomesFor(b).includes(v)) return todayPage(c, { flash: t.changed, status: 409 });
  if (now < startMs(b)) return todayPage(c, { flash: t.notStarted, status: 409 });
  if (!outcomeOpen(b, now)) return todayPage(c, { flash: t.tooLateToMark, status: 409 });
  const target = `${kindKey(b)}:${b.id}`;
  let oid: number | null;
  try {
    oid = await recordOutcome(c.env.DB, { ...(kind === "CALL" ? { introId: id } : { sessionId: id }), slotId: b.slotId, value: v, nowMs: now }, [auditStmt(c, "APP_OUTCOME", target, v)]);
  } catch {
    return notSaved(c);
  }
  if (oid === null) return todayPage(c, { flash: await alreadyMarked(c, (await bookingOf(c.env, kind, id)) ?? b), status: 409 });
  return back(c, null, `#b-${target.replace(":", "-")}`);
});

// "Already marked: Not a fit, by you at 4:05 pm": the outcome, who tapped it (from the audit log) and when.
async function alreadyMarked(c: ConsoleCtx, b: Booking): Promise<string> {
  const m = c.get("member");
  const cc = consoleCopy(m.locale);
  const t = todayCopy(m.locale);
  const by = await c.env.DB.prepare(
    `SELECT a.member_id AS memberId, a.actor, mb.id AS mid, mb.display_name AS displayName, mb.role FROM audit_log a
     LEFT JOIN members mb ON mb.id = a.member_id OR (a.member_id IS NULL AND mb.email = a.actor)
     WHERE a.target = ?1 AND a.action IN ('APP_OUTCOME','AMMA_OUTCOME') ORDER BY a.id DESC LIMIT 1`,
  ).bind(`${kindKey(b)}:${b.id}`).first<{ memberId: number | null; actor: string; mid: number | null; displayName: string | null; role: Member["role"] | null }>();
  const name = !by ? t.someone : by.mid === m.id ? cc.byYou : by.displayName || (by.role ? roleName(by.role, m.locale) : t.someone);
  return cc.alreadyMarked(outWord(b.value ?? "", t), name, b.tappedAt ? clock(b.tappedAt, m.locale) : "");
}

today.post("/today/undo", async (c) => {
  const m = c.get("member");
  const f = await formOf(c);
  const oid = Number(f.outcome);
  if (!Number.isInteger(oid)) return c.text("Bad request", 400);
  if (!(await tokenOk(c, f.csrf, `undo:${oid}`))) return forbidden(c);
  const o = await c.env.DB.prepare("SELECT intro_id AS introId, session_id AS sessionId, value FROM outcomes WHERE id = ?1").bind(oid).first<{ introId: number | null; sessionId: number | null; value: string }>();
  const cc = consoleCopy(m.locale);
  // An undone (deleted) outcome and one too old to undo get the same answer.
  if (!o) return todayPage(c, { flash: cc.tooLateToUndo, status: 409 });
  const b = o.introId !== null ? await bookingOf(c.env, "CALL", o.introId) : await bookingOf(c.env, "SESSION", o.sessionId!);
  if (!b || !mayMark(m, b)) return refused(c);
  const target = o.introId !== null ? `intro:${o.introId}` : `session:${o.sessionId}`;
  let ok: boolean;
  try {
    ok = await undoOutcome(c.env.DB, oid, Date.now(), [auditStmt(c, "APP_UNDO", target, o.value)]);
  } catch {
    return notSaved(c);
  }
  if (!ok) return todayPage(c, { flash: cc.tooLateToUndo, status: 409 });
  return back(c, "undone", `#b-${target.replace(":", "-")}`);
});

// Call: the number is shown (and the reveal recorded) only from 1 hour before to 1 hour after the call, for whoever may see it.
today.post("/today/call", async (c) => {
  const m = c.get("member");
  const f = await formOf(c);
  const kind = f.kind === "intro" ? "CALL" : f.kind === "session" ? "SESSION" : null;
  const id = Number(f.id);
  if (!kind || !Number.isInteger(id)) return c.text("Bad request", 400);
  if (!(await tokenOk(c, f.csrf, `call:${f.kind}:${id}`))) return forbidden(c);
  const b = await bookingOf(c.env, kind, id);
  const now = Date.now();
  if (!b || !callAllowed(m, b, now)) return refused(c);
  const target = `${kindKey(b)}:${b.id}`;
  try {
    await c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) VALUES (?1, 'PHONE_REVEAL', ?2, 'call', ?3, ?4, 'call')")
      .bind(c.get("email"), target, m.workspaceId, m.id)
      .run();
  } catch {
    return notSaved(c);
  }
  const t = todayCopy(m.locale);
  const cc = consoleCopy(m.locale);
  const lang = consoleLang(m.locale);
  const digits = b.waId.replace(/\D/g, "");
  const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(m.workspaceId).first<{ name: string }>();
  const body = html`<article class="card"><h3>${t.callTitle(firstName(b.name, t.noName))}</h3>
<p class="why">${clock(b.startUtc, lang)} · ${serviceName(b.service, lang)} · ${callLangText(b.callLang ?? b.locale, m.locale)}</p>
<div class="acts"><a class="btn primary" href="tel:+${digits}">${cc.call} +${digits}</a><a class="link" href="/app#b-${target.replace(":", "-")}">${t.backToday}</a></div>
<p class="muted">${t.callLogged}</p></article>`;
  return c.html(consoleFrame({ role: m.role, locale: m.locale, active: "today", title: cc.call, body, business: ws?.name ?? "", member: m.displayName ?? undefined, accent: c.get("accent") }));
});

// Hand back to the bot: the chat leaves the team's queue (its "talk to a person" item is resolved). A safety item stays open.
today.post("/today/handback", async (c) => {
  const m = c.get("member");
  const f = await formOf(c);
  const conv = Number(f.conv);
  if (!Number.isInteger(conv)) return c.text("Bad request", 400);
  if (!(await tokenOk(c, f.csrf, `handback:${conv}`))) return forbidden(c);
  if (can(m, "reply_chat") !== "yes") return refused(c);
  let res: D1Result[];
  try {
    res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE conversations SET mode = 'BOT', human_since = NULL WHERE id = ?1 AND mode = 'HUMAN'").bind(conv),
      auditStmt(c, "APP_HAND_BACK", `conv:${conv}`, "HUMAN -> BOT"),
      c.env.DB.prepare("UPDATE attention SET resolved_at = ?2 WHERE kind = 'HUMAN_REQUEST' AND target = ?1 AND resolved_at IS NULL AND (SELECT mode FROM conversations WHERE id = ?3) = 'BOT'").bind(`conv:${conv}`, iso(Date.now()), conv),
    ]);
  } catch {
    return notSaved(c);
  }
  return back(c, res[0].meta.changes ? "handback" : "gone");
});

// Approve or decline an "ask owner" request: src/requests.ts runs the existing refund or block code and audits it.
today.post("/today/decide", async (c) => {
  const m = c.get("member");
  const f = await formOf(c);
  const id = Number(f.request);
  const decision = f.decision === "APPROVED" || f.decision === "DECLINED" ? f.decision : null;
  if (!Number.isInteger(id) || !decision) return c.text("Bad request", 400);
  if (!(await tokenOk(c, f.csrf, `decide:${id}:${decision}`))) return forbidden(c);
  const r = await requestById(c.env, id, m.workspaceId);
  if (r && can(m, REQUEST_ACTION[r.kind]) !== "yes") return refused(c);
  if (!r) return back(c, "gone");
  let result: Decided;
  try {
    result = await decideRequest(c.env, razorpay(c.env), m, id, decision);
  } catch {
    return notSaved(c);
  }
  const t = todayCopy(m.locale);
  if (result === "NOT_ALLOWED") return refused(c);
  if (result === "FAILED") return notSaved(c);
  if (result === "ALREADY") return todayPage(c, { flash: t.flashAlready, status: 409 });
  const approved = decision === "APPROVED";
  const code = { DONE: !approved ? "declined" : r.kind === "MARK_PAID" ? "recorded" : "approved", NOTHING: approved ? "nothing" : "declined", LATE: "late", GONE: "gone" }[result];
  return back(c, code);
});
