// Ticket 40: "Send session link" (/app/session-link/<conversation id>), the owner's request of 4 Nov 2026. After (or during) a ₹99 call the
// customer and the practitioner may agree on a full session; the team then sends the ₹799 link from the console:
//  - With a time: a free session time they agreed on is held and the payment link goes, on the bot's own code (src/session.ts
//    startSession: the guarded hold, the Razorpay link that expires with the hold, the /p/ link, the release when unpaid). Paid in time, it
//    is a normal paid session: Calendar, Today, the day-before reminder.
//  - Let them choose: the single session's own steps ([Choose a time], then days, times and the link), as when they book themselves.
// Inside the 24-hour window free text; outside it an approved template only: `session_link` for a held time (new, `approved: false` until
// Meta approves it), the approved `session_offer` for "Let them choose" (any reply shows the options). Otherwise nothing goes and the
// team is told which template is missing. No package link: the options list ("Let them choose" outside the window) and the menu sell them.
// Who: someone who may move this customer's bookings (move_booking: owner, staff, the practitioner whose call it was), for a customer
// with a paid ₹99 call (not one marked rude). Refused while bookings are paused, for a blocked or opted-out person, an open safety item,
// the no-selling week, or a time already held. Each POST has its own token and the Origin check (src/console.ts); audited SEND_SESSION_LINK.
import { Hono } from "hono";
import { html } from "hono/html";
import { can, memberCsrf, type Member } from "./auth";
import { loadConv } from "./booking";
import { prices } from "./business";
import { config } from "./config";
import { appPage, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleLang } from "./console-copy";
import { copyFor, rupees } from "./copy";
import type { Env } from "./env";
import { noSellActiveFor, personState } from "./noise";
import { razorpay } from "./pay/razorpay";
import { sendMessage, templateVariant, type TemplateName } from "./send";
import { openOfferId, startSession, type Session } from "./session";
import { availableSlots, generateSlots, isHoliday, iso, istDay, nextWorkingDays, type Slot } from "./slots";
import { bookingsOpen } from "./switches";
import { clock, dayName, emptyState, firstName, last4, section } from "./ui";

const MIN = 60_000;

// ---------- words (English and Hindi; the Hindi to be read by a native speaker) ----------
const en = {
  title: "Send a session link",
  button: (price: string) => `Send session link (${price})`,
  intro: (price: string, min: number) => `A ${price} session (${min} minutes, by phone). Hold a time you agreed on the call, or let them choose one.`,
  withTime: "With a time",
  withTimeWhy: (min: number) => `The time is held for ${min} minutes and they get the payment link. Paid in time, it is booked and shows on the calendar.`,
  holdButton: "Hold this time and send the link",
  letChoose: "Let them choose",
  letChooseWhy: "They get a message with \"Choose a time\": they pick a free time and pay, as when they book themselves.",
  chooseButton: "Send \"Choose a time\"",
  windowClosed: (name: string) => `WhatsApp window closed: this needs the template "${name}" approved in Meta. Nothing was sent.`,
  windowTemplate: "Their WhatsApp window has closed, so they get the approved \"session offer\" message; any reply shows them the options.",
  noTimes: "No free session times in the next days.",
  sentLink: (when: string, until: string) => `Held ${when} until ${until}. The payment link has gone to them.`,
  sentChoose: "Sent. They can choose a time and pay.",
  paused: "Bookings are paused, so nothing was sent.",
  blocked: "This person is blocked, so nothing was sent.",
  optedOut: "They asked us to stop messaging them, so nothing was sent.",
  safety: "This person has an open safety message, so nothing was sent.",
  noSell: (day: string) => `No selling to this person until ${day} (after a safety message), so nothing was sent.`,
  holding: "They already have a time held. Wait until it is paid or runs out.",
  taken: "That time is no longer free. Choose another.",
  pickTime: "Choose a time first.",
  failed: "The payment link could not be made. Nothing was charged; try again in a few minutes.",
  notSent: "The message could not be sent. Check their chat before trying again.",
  backToPerson: "Back to their page",
};
type Words = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : (typeof en)[K] };
const hi: Words = {
  title: "सेशन का लिंक भेजें",
  button: (price) => `सेशन का लिंक भेजें (${price})`,
  intro: (price, min) => `${price} का सेशन (${min} मिनट, फ़ोन पर)। कॉल पर तय हुआ समय रोकें, या उन्हें खुद समय चुनने दें।`,
  withTime: "समय के साथ",
  withTimeWhy: (min) => `समय ${min} मिनट के लिए रुका रहता है और उन्हें भुगतान का लिंक मिलता है। समय पर भुगतान होने पर बुकिंग पक्की होती है और कैलेंडर पर दिखती है।`,
  holdButton: "यह समय रोकें और लिंक भेजें",
  letChoose: "उन्हें चुनने दें",
  letChooseWhy: "उन्हें \"समय चुनें\" वाला संदेश मिलता है: वे खाली समय चुनकर भुगतान करते हैं, जैसे खुद बुक करते समय।",
  chooseButton: "\"समय चुनें\" भेजें",
  windowClosed: (name) => `WhatsApp की खिड़की बंद है: इसके लिए Meta में "${name}" टेम्पलेट मंज़ूर होना चाहिए। कुछ नहीं भेजा गया।`,
  windowTemplate: "उनकी WhatsApp खिड़की बंद है, इसलिए उन्हें मंज़ूर \"सेशन ऑफ़र\" संदेश जाता है; किसी भी जवाब पर उन्हें विकल्प दिखते हैं।",
  noTimes: "अगले दिनों में सेशन का कोई खाली समय नहीं है।",
  sentLink: (when, until) => `${when} ${until} तक रोका गया। भुगतान का लिंक उन्हें भेज दिया गया है।`,
  sentChoose: "भेज दिया। वे समय चुनकर भुगतान कर सकते हैं।",
  paused: "बुकिंग रुकी हुई है, इसलिए कुछ नहीं भेजा गया।",
  blocked: "यह व्यक्ति ब्लॉक है, इसलिए कुछ नहीं भेजा गया।",
  optedOut: "उन्होंने संदेश बंद करने को कहा है, इसलिए कुछ नहीं भेजा गया।",
  safety: "इस व्यक्ति का एक सुरक्षा संदेश खुला है, इसलिए कुछ नहीं भेजा गया।",
  noSell: (day) => `${day} तक इस व्यक्ति को कुछ नहीं बेचना है (सुरक्षा संदेश के बाद), इसलिए कुछ नहीं भेजा गया।`,
  holding: "उनका एक समय पहले से रुका हुआ है। उसके भुगतान या खत्म होने तक रुकें।",
  taken: "वह समय अब खाली नहीं है। कोई दूसरा चुनें।",
  pickTime: "पहले एक समय चुनें।",
  failed: "भुगतान का लिंक नहीं बन सका। कोई पैसा नहीं कटा; कुछ मिनट बाद फिर कोशिश करें।",
  notSent: "संदेश नहीं जा सका। दोबारा कोशिश करने से पहले उनकी चैट देखें।",
  backToPerson: "उनके पेज पर वापस",
};
export const sessionLinkCopy = (locale: string | null | undefined): Words => (consoleLang(locale) === "hi" ? hi : en);

// ---------- who may, for whom ----------
type Target = { convId: number; waId: string; name: string | null; locale: string; mode: string; lastUserAt: string | null; introId: number; practitionerId: number | null };

// The customer's latest paid ₹99 call (any state but rude), and whether this member may book for them. Null: no button, and a refusal.
export async function sessionLinkTarget(env: Env, m: Member, convId: number): Promise<Target | null> {
  const t = await env.DB
    .prepare(
      `SELECT c.id AS convId, c.wa_id AS waId, c.display_name AS name, c.locale, c.mode, c.last_user_at AS lastUserAt, i.id AS introId, i.practitioner_id AS practitionerId
       FROM conversations c JOIN intros i ON i.conversation_id = c.id
       WHERE c.id = ?1 AND i.state NOT IN ('HELD', 'EXPIRED', 'RUDE', 'CANCELLED_BY_US')
         AND EXISTS (SELECT 1 FROM payments p WHERE p.purpose = 'INTRO' AND p.target_id = i.id AND p.state IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'))
       ORDER BY i.id DESC LIMIT 1`,
    )
    .bind(convId)
    .first<Target>();
  if (!t || can(m, "move_booking", { practitionerId: t.practitionerId }) !== "yes") return null;
  return t;
}
// The button on the person page, the Today call card and the Inbox chat.
export async function sessionLinkButton(env: Env, m: Member, convId: number) {
  if (!(await sessionLinkTarget(env, m, convId))) return "";
  return html`<a class="btn" href="/app/session-link/${convId}">${sessionLinkCopy(m.locale).button(rupees(prices().single))}</a>`;
}

const inWindow = (t: Target, nowMs: number) => !!t.lastUserAt && nowMs - Date.parse(t.lastUserAt) < config.windowHours * 3_600_000;
const approved = (name: TemplateName, locale: string) => templateVariant({ type: "template", name, params: [] }, locale).approved;

// Why nothing may go to this person now (the same checks on the page and in each POST), or null.
async function refusal(env: Env, t: Target, w: Words, locale: string, nowMs: number): Promise<string | null> {
  if (!(await bookingsOpen(env))) return w.paused;
  if (t.mode === "BLOCKED" || (await env.DB.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(t.waId).first())) return w.blocked;
  const st = await personState(env.DB, t.convId);
  if (st.optedOutAt) return w.optedOut;
  if (await env.DB.prepare("SELECT 1 FROM attention WHERE target = ?1 AND resolved_at IS NULL AND kind IN ('CRISIS', 'EMERGENCY')").bind(`conv:${t.convId}`).first()) return w.safety;
  if (noSellActiveFor(st, nowMs)) return w.noSell(dayName(st.noSellUntil!, locale));
  return null;
}
const holdingNow = (env: Env, convId: number, nowMs: number) => env.DB.prepare("SELECT 1 FROM slots WHERE owner_id = ?1 AND state = 'HELD' AND hold_until > ?2").bind(convId, iso(nowMs)).first();

// The session they can pay for: the one already offered to them (after "Session", or an earlier link), else a new one for the team's
// link (override_by names the member, the audited operator override src/session.ts accepts), for the practitioner of their call.
async function sessionFor(env: Env, t: Target, m: Member): Promise<Session> {
  const db = env.DB;
  let sid = await openOfferId(db, t.convId);
  if (sid === null) {
    sid = (
      await db
        .prepare(
          `INSERT INTO sessions (conversation_id, service, practitioner_id, for_whom, call_lang, origin, override_by)
           SELECT conversation_id, service, practitioner_id, for_whom, call_lang, 'AMMA', ?2 FROM intros WHERE id = ?1`,
        )
        .bind(t.introId, `member:${m.id}`)
        .run()
    ).meta.last_row_id;
  }
  return (await db
    .prepare("SELECT se.id, se.state, se.conversation_id, se.service, i.state AS intro_state, se.override_by, se.origin FROM sessions se LEFT JOIN intros i ON i.id = se.intro_id WHERE se.id = ?1")
    .bind(sid)
    .first<Session>())!;
}

// Free session times, as the Inbox's picker shows them.
async function freeTimes(env: Env, nowMs: number): Promise<{ ymd: string; slots: Slot[] }[]> {
  const out: { ymd: string; slots: Slot[] }[] = [];
  for (const ymd of nextWorkingDays(nowMs, config.booking.lookaheadDays)) {
    if (out.length >= config.booking.workingDays) break;
    const free = await availableSlots(env.DB, "SESSION", ymd, nowMs + config.booking.leadMinutes * MIN, nowMs);
    if (free.length) out.push({ ymd, slots: free });
  }
  return out;
}

// ---------- the screen ----------
const CSS = html`<style>.pick fieldset{border:0;margin:0 0 16px;padding:0;min-width:0}.pick legend{font-weight:600;padding:0;margin:0 0 8px}
.opts{display:flex;flex-wrap:wrap;gap:8px}.opts label{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer}
.opts input{width:20px;height:20px;margin:0;accent-color:var(--accent);flex:none}.opts label:has(input:checked){border-color:var(--accent);background:var(--accent-tint)}.pick .btn{width:100%}</style>`;
const token = (c: ConsoleCtx, action: string, convId: number) => memberCsrf(c.get("jwt"), c.get("member"), `slink-${action}:${convId}`);
// The audit row, written after the hold or the message (both their own writes, so not changes()-guarded).
const audit = (c: ConsoleCtx, convId: number, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) VALUES (?1, 'SEND_SESSION_LINK', ?2, ?3, ?4, ?5)")
    .bind(c.get("email"), `conv:${convId}`, detail, c.get("member").workspaceId, c.get("member").id)
    .run();
const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

async function screen(c: ConsoleCtx, t: Target, flash: string | null = null, status: 200 | 400 | 409 | 503 = 200) {
  const m = c.get("member");
  const loc = m.locale;
  const w = sessionLinkCopy(loc);
  const now = Date.now();
  const open = inWindow(t, now);
  const no = await refusal(c.env, t, w, loc, now);
  const head = html`<p><a class="crumb" href="/app/people/${t.convId}">← ${w.backToPerson}</a></p><div class="card"><h2>${firstName(t.name)} <span class="d">${last4(t.waId)}</span></h2>
<p>${w.intro(rupees(prices().single), config.slots.sessionMinutes)}</p></div>`;
  let body: unknown;
  if (no) body = html`<p class="card attention">${no}</p>`;
  else {
    const days = await freeTimes(c.env, now);
    const timeForm = !open && !approved("session_link", t.locale)
      ? html`<p class="card attention">${w.windowClosed("session_link")}</p>`
      : days.length
        ? html`<form class="pick card" method="post" action="/app/session-link/${t.convId}/hold">${hidden("csrf", await token(c, "hold", t.convId))}${hidden("n", crypto.randomUUID().slice(0, 12))}
<p class="muted">${w.withTimeWhy(config.holdMinutes)}</p>${days.map(
            (d) => html`<fieldset><legend>${dayName(d.slots[0].startUtc, loc)}</legend><div class="opts">${d.slots.map(
              (s) => html`<label><input type="radio" name="time" value="${s.startUtc}" required><span>${clock(s.startUtc, loc)}</span></label>`,
            )}</div></fieldset>`,
          )}<button class="btn primary" type="submit">${w.holdButton}</button></form>`
        : emptyState(w.noTimes);
    const chooseForm = !open && !approved("session_offer", t.locale)
      ? html`<p class="card attention">${w.windowClosed("session_offer")}</p>`
      : html`<form class="pick card" method="post" action="/app/session-link/${t.convId}/choose">${hidden("csrf", await token(c, "choose", t.convId))}${hidden("n", crypto.randomUUID().slice(0, 12))}
<p class="muted">${w.letChooseWhy}</p>${open ? "" : html`<p class="muted">${w.windowTemplate}</p>`}<button class="btn primary" type="submit">${w.chooseButton}</button></form>`;
    body = html`${section(w.withTime, timeForm)}${section(w.letChoose, chooseForm)}`;
  }
  return appPage(c, { active: "people", title: w.title, body: html`${CSS}<header class="screen"><h1>${w.title}</h1></header>${head}${body}`, flash, back: `/app/session-link/${t.convId}`, status });
}

// ---------- routes ----------
export const sessionLink = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

sessionLink.get("/:id{[0-9]+}", async (c) => {
  const t = await sessionLinkTarget(c.env, c.get("member"), Number(c.req.param("id")));
  return t ? screen(c, t) : refused(c);
});

type Form = Record<string, string | undefined>;
async function guard(c: ConsoleCtx, action: string): Promise<{ t: Target; f: Form; w: Words; m: Member } | Response> {
  const m = c.get("member");
  const id = Number(c.req.param("id"));
  const f = (await c.req.parseBody()) as Form;
  if (!Number.isInteger(id) || f.csrf !== (await token(c, action, id))) return c.text("Forbidden", 403);
  const t = await sessionLinkTarget(c.env, m, id);
  if (!t) return refused(c);
  return { t, f, w: sessionLinkCopy(m.locale), m };
}

// With a time: the bot's own hold and link. A time someone holds is refused here, so the customer never gets "that time was just taken".
sessionLink.post("/:id{[0-9]+}/hold", async (c) => {
  const g = await guard(c, "hold");
  if (g instanceof Response) return g;
  const { t, f, w, m } = g;
  const now = Date.now();
  const startUtc = f.time ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startUtc) || !/^[\w-]{1,40}$/.test(f.n ?? "")) return screen(c, t, w.pickTime, 400);
  const no = await refusal(c.env, t, w, m.locale, now);
  if (no) return screen(c, t, no, 409);
  const open = inWindow(t, now);
  if (!open && !approved("session_link", t.locale)) return screen(c, t, w.windowClosed("session_link"), 409);
  if (await holdingNow(c.env, t.convId, now)) return screen(c, t, w.holding, 409);
  const slot = generateSlots(istDay(Date.parse(startUtc)), "SESSION").find((x) => x.startUtc === startUtc);
  if (!slot) return screen(c, t, w.pickTime, 400);
  if (Date.parse(startUtc) <= now + config.booking.leadMinutes * MIN || (await isHoliday(c.env.DB, istDay(Date.parse(startUtc))))) return screen(c, t, w.taken, 409);
  const busy = await c.env.DB.prepare("SELECT 1 FROM slots WHERE (state = 'BOOKED' OR hold_until > ?3) AND start_utc < ?2 AND end_utc > ?1").bind(slot.startUtc, slot.endUtc, iso(now)).first();
  if (busy) return screen(c, t, w.taken, 409);
  const ses = await sessionFor(c.env, t, m);
  const conv = await loadConv(c.env.DB, t.convId);
  await startSession(c.env, razorpay(c.env), conv!, ses, startUtc, `slink:${t.convId}:${f.n}`, { template: !open });
  const held = await c.env.DB
    .prepare(
      `SELECT sl.hold_until AS until, p.state AS payState, (SELECT status FROM messages WHERE dedupe_key = ?3) AS sent FROM sessions se JOIN slots sl ON sl.id = se.slot_id
       LEFT JOIN payments p ON p.purpose = 'SESSION' AND p.target_id = se.id WHERE se.id = ?1 AND sl.start_utc = ?2 ORDER BY p.id DESC LIMIT 1`,
    )
    .bind(ses.id, startUtc, `slink:${t.convId}:${f.n}:pay`)
    .first<{ until: string | null; payState: string | null; sent: string | null }>();
  if (held?.payState === "FAILED") return screen(c, t, w.failed, 503);
  if (!held || held.payState !== "PENDING" || !held.until || held.until <= iso(now)) return screen(c, t, w.taken, 409);
  await audit(c, t.convId, `session:${ses.id} with a time ${startUtc}${open ? "" : " (template)"}`);
  if (held.sent !== "SENT" && held.sent !== "UNKNOWN") return screen(c, t, w.notSent, 409);
  return screen(c, t, w.sentLink(`${dayName(startUtc, m.locale)}, ${clock(startUtc, m.locale)}`, clock(held.until, m.locale)));
});

// Let them choose: [Choose a time] inside the window (the single session's own steps), the approved session_offer template outside it.
sessionLink.post("/:id{[0-9]+}/choose", async (c) => {
  const g = await guard(c, "choose");
  if (g instanceof Response) return g;
  const { t, f, w, m } = g;
  const now = Date.now();
  if (!/^[\w-]{1,40}$/.test(f.n ?? "")) return screen(c, t, w.pickTime, 400);
  const no = await refusal(c.env, t, w, m.locale, now);
  if (no) return screen(c, t, no, 409);
  const open = inWindow(t, now);
  if (!open && !approved("session_offer", t.locale)) return screen(c, t, w.windowClosed("session_offer"), 409);
  const ses = await sessionFor(c.env, t, m);
  const cp = copyFor(t.locale);
  const res = await sendMessage(
    c.env, t.convId,
    open ? { type: "buttons", body: cp.sessionLinkBody, buttons: [{ id: `sess_offer_${ses.id}`, title: cp.btnChooseTime }] } : { type: "template", name: "session_offer", params: [] },
    `slink:${t.convId}:${f.n}`,
  );
  if (res !== "SENT" && res !== "UNKNOWN") return screen(c, t, w.notSent, 409);
  await audit(c, t.convId, `session:${ses.id} let them choose${open ? "" : " (template)"}`);
  return screen(c, t, w.sentChoose);
});
