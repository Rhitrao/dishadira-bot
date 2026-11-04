// Phone alerts for the team when a customer books and pays (ticket 45, the owner's choice of 4 Nov 2026): a Web Push notification from the
// home-screen app (src/push.ts), never email. Triggers, from the code that makes them happen (src/pay/apply.ts, src/packages.ts): a paid
// ₹99 call, a paid ₹799 session, a paid package, a session booked from a package. Never a hold, a refund or a duplicate payment.
// Who: the owner, every booking, at once; a practitioner, only their own customers' bookings, and from config.push.quietFrom to quietUntil
// (India time) they wait until the morning (several then go as one "3 new bookings overnight"). Staff get none.
// A lock screen is seen by others: the words name the kind, the amount and the time, never a customer's name, number or what they need help
// with. Each alert is a push_outbox row (one per booking and member), sent by the 2-minute cron (and at once after a webhook), tried
// config.push.maxAttempts times. Settings → "Alerts on this phone" turns a device on and off; this file draws it and takes its forms.
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { can, memberCsrf, sha256Hex, type Member } from "./auth";
import { config } from "./config";
import type { ConsoleCtx, ConsoleVars } from "./console";
import { consoleCopy, consoleLang } from "./console-copy";
import type { Env } from "./env";
import { allowedEndpoint, pushOn, sendPush, validKeys, vapidKeys, type VapidKeys } from "./push";
import { iso, istDay } from "./slots";
import { CONSOLE_CSP, clock, dayName, rows } from "./ui";

const MIN = 60_000;
const DAY = 86_400_000;
const P = config.push;

export type AlertKind = "CALL" | "SESSION" | "PACKAGE" | "CREDIT_SESSION";

// ---------- words (English and Hindi; the Hindi is to be read by a native speaker) ----------
const en = {
  // the notification
  title: "New booking",
  titleMany: "New bookings",
  call: (amount: string, when: string) => `${amount} call · ${when}`,
  session: (amount: string, when: string) => `${amount} session · ${when}`,
  pack: (n: number) => `Package of ${n} paid`,
  credit: (when: string) => `Session from package · ${when}`,
  overnight: (n: number) => `${n} new bookings overnight`,
  tomorrow: "Tomorrow",
  testTitle: "Test alert",
  testBody: "Alerts are working on this phone.",
  // Settings → Alerts on this phone
  sec: "Alerts on this phone",
  whyOwner: "A notification on this phone when a customer books and pays: a ₹99 call, a session, a package, or a session from a package. You get every booking, right away.",
  whyPrac: (from: string, until: string) =>
    `A notification on this phone when one of your customers books and pays: a ₹99 call, a session, or a session from a package. Between ${from} and ${until} they wait until ${until}.`,
  private: "The alert never shows a name, a number or what someone needs help with: a lock screen can be seen by others.",
  iphone: "iPhone: open this from the home-screen icon first; needs iOS 16.4 or later.",
  off: "Alerts aren't set up for this copy of the bot yet (the alert keys are missing). The owner can follow docs/GO-LIVE.md, “Phone alerts”.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  test: "Send a test alert",
  stateOn: "On for this phone.",
  unsupported: "This browser can't show alerts. On iPhone, open the console from the home-screen icon (iOS 16.4 or later). On Android, use Chrome.",
  denied: "Notifications are blocked for this app. Allow them in the phone's settings, then come back here.",
  failed: "That didn't work. Try again; if it keeps failing, close the app and open it from the home-screen icon.",
  devices: "Your devices with alerts",
  noDevices: "No device gets alerts yet.",
  added: (day: string) => `Added ${day}`,
  remove: "Remove",
  // after a form
  flashOn: "Alerts are on for this phone.",
  flashOff: "Alerts are off for this phone.",
  flashRemoved: "Device removed. It gets no more alerts.",
  flashTestSent: "Test alert sent. It should show on your phone in a few seconds.",
  flashTestFailed: "The test alert couldn't be delivered. On that phone, turn alerts off and on again.",
  flashNoDevice: "Turn alerts on first.",
  flashBad: "This phone's alert details weren't accepted. Tap Turn on again.",
  flashTooMany: `You can have up to ${config.push.maxDevices} devices. Remove one first.`,
  flashPushOff: "Alerts aren't set up for this copy of the bot yet.",
};
type Words = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : string };
const hi: Words = {
  title: "नई बुकिंग",
  titleMany: "नई बुकिंग",
  call: (amount, when) => `${amount} कॉल · ${when}`,
  session: (amount, when) => `${amount} सेशन · ${when}`,
  pack: (n) => `${n} सेशन का पैकेज: पेमेंट हो गया`,
  credit: (when) => `पैकेज से सेशन · ${when}`,
  overnight: (n) => `रात में ${n} नई बुकिंग`,
  tomorrow: "कल",
  testTitle: "टेस्ट अलर्ट",
  testBody: "इस फ़ोन पर अलर्ट आ रहे हैं।",
  sec: "इस फ़ोन पर अलर्ट",
  whyOwner: "जब कोई ग्राहक बुक करके पेमेंट करे, तो इस फ़ोन पर सूचना: ₹99 कॉल, सेशन, पैकेज, या पैकेज से सेशन। आपको हर बुकिंग की सूचना तुरंत मिलती है।",
  whyPrac: (from, until) => `जब आपका कोई ग्राहक बुक करके पेमेंट करे, तो इस फ़ोन पर सूचना: ₹99 कॉल, सेशन, या पैकेज से सेशन। ${from} से ${until} के बीच की सूचनाएँ ${until} बजे आती हैं।`,
  private: "सूचना में कभी नाम, नंबर या मदद की बात नहीं दिखती: लॉक स्क्रीन दूसरे भी देख सकते हैं।",
  iphone: "iPhone: पहले इसे होम-स्क्रीन वाले आइकन से खोलें; iOS 16.4 या उसके बाद का चाहिए।",
  off: "बॉट की इस कॉपी में अलर्ट अभी चालू नहीं हुए हैं (अलर्ट की चाबियाँ नहीं डाली गईं)। मालिक docs/GO-LIVE.md का “Phone alerts” हिस्सा देखें।",
  turnOn: "चालू करें",
  turnOff: "बंद करें",
  test: "टेस्ट अलर्ट भेजें",
  stateOn: "इस फ़ोन पर चालू है।",
  unsupported: "यह ब्राउज़र अलर्ट नहीं दिखा सकता। iPhone पर कंसोल को होम-स्क्रीन वाले आइकन से खोलें (iOS 16.4 या बाद का)। Android पर Chrome इस्तेमाल करें।",
  denied: "इस ऐप की सूचनाएँ बंद हैं। फ़ोन की सेटिंग्स में इन्हें चालू करें, फिर यहाँ वापस आएँ।",
  failed: "यह नहीं हो पाया। फिर से कोशिश करें; बार-बार न हो, तो ऐप बंद करके होम-स्क्रीन वाले आइकन से खोलें।",
  devices: "आपके डिवाइस जिन पर अलर्ट आते हैं",
  noDevices: "अभी किसी डिवाइस पर अलर्ट नहीं आते।",
  added: (day) => `${day} को जोड़ा`,
  remove: "हटाएँ",
  flashOn: "इस फ़ोन पर अलर्ट चालू हो गए।",
  flashOff: "इस फ़ोन पर अलर्ट बंद हो गए।",
  flashRemoved: "डिवाइस हटा दिया। उस पर अब अलर्ट नहीं आएँगे।",
  flashTestSent: "टेस्ट अलर्ट भेज दिया। कुछ सेकंड में फ़ोन पर दिखना चाहिए।",
  flashTestFailed: "टेस्ट अलर्ट नहीं पहुँचा। उस फ़ोन पर अलर्ट बंद करके फिर से चालू करें।",
  flashNoDevice: "पहले अलर्ट चालू करें।",
  flashBad: "इस फ़ोन की अलर्ट वाली जानकारी नहीं ली जा सकी। फिर से चालू करें दबाएँ।",
  flashTooMany: `ज़्यादा से ज़्यादा ${config.push.maxDevices} डिवाइस हो सकते हैं। पहले एक हटाएँ।`,
  flashPushOff: "बॉट की इस कॉपी में अलर्ट अभी चालू नहीं हुए हैं।",
};
export const ALERTS_COPY: Record<"en" | "hi", Words> = { en, hi };
const W = (locale: string | null | undefined): Words => ALERTS_COPY[consoleLang(locale)];

// ---------- quiet hours ----------
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// When an alert for this role made now may go: now, or (a practitioner, inside the quiet hours) at the next config.push.quietUntil.
export function dueFor(role: string, nowMs: number): { dueMs: number; held: boolean } {
  if (!(P.quietRoles as readonly string[]).includes(role)) return { dueMs: nowMs, held: false };
  const d = new Date(nowMs + 330 * MIN); // India: always UTC+5:30
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = minutesOf(P.quietFrom);
  const until = minutesOf(P.quietUntil);
  const quiet = from > until ? m >= from || m < until : m >= from && m < until;
  if (!quiet) return { dueMs: nowMs, held: false };
  let at = Date.parse(`${istDay(nowMs)}T${P.quietUntil}:00+05:30`);
  if (at <= nowMs) at += DAY;
  return { dueMs: at, held: true };
}

// ---------- queueing: one row per booking and member ----------
// What each kind's row points at: the payment (a call, a session, a package), or the package session itself (no payment of its own).
const PURPOSE: Record<Exclude<AlertKind, "CREDIT_SESSION">, string> = { CALL: "INTRO", SESSION: "SESSION", PACKAGE: "PACKAGE" };

// The practitioner(s) whose customer this is, or null when the booking doesn't stand (not paid, refunded, not booked).
async function whoseBooking(db: Env["DB"], kind: AlertKind, id: number): Promise<number[] | null> {
  if (kind === "CREDIT_SESSION") {
    const s = await db.prepare("SELECT practitioner_id AS p FROM sessions WHERE id = ?1 AND state = 'CREDIT_BOOKED' AND origin = 'CREDIT'").bind(id).first<{ p: number | null }>();
    return s ? (s.p === null ? [] : [s.p]) : null;
  }
  const pay = await db.prepare("SELECT target_id AS t FROM payments WHERE id = ?1 AND purpose = ?2 AND state = 'PAID'").bind(id, PURPOSE[kind]).first<{ t: number }>();
  if (!pay) return null;
  if (kind === "CALL" || kind === "SESSION") {
    const r = await db.prepare(`SELECT practitioner_id AS p FROM ${kind === "CALL" ? "intros" : "sessions"} WHERE id = ?1`).bind(pay.t).first<{ p: number | null }>();
    return r?.p == null ? [] : [r.p];
  }
  // A package has no practitioner of its own: the practitioners this buyer has (or had) a call or session with (as People decides).
  const { results } = await db
    .prepare(
      `SELECT DISTINCT p FROM (
         SELECT i.practitioner_id AS p FROM intros i JOIN packages k ON k.conversation_id = i.conversation_id WHERE k.id = ?1 AND i.state NOT IN ('HELD','EXPIRED')
         UNION SELECT se.practitioner_id FROM sessions se JOIN packages k ON k.conversation_id = se.conversation_id WHERE k.id = ?1 AND se.state NOT IN ('OFFERED','HELD','EXPIRED')
       ) WHERE p IS NOT NULL`,
    )
    .bind(pay.t)
    .all<{ p: number }>();
  return results.map((r) => r.p);
}

// Called where the booking happens. `id`: the payment id (CALL, SESSION, PACKAGE) or the session id (CREDIT_SESSION). Returns the rows
// queued. A replay queues nothing more (UNIQUE target + member); a member with no device gets no row; with push off, nothing at all.
export async function queueBookingAlert(env: Env, kind: AlertKind, id: number, nowMs = Date.now()): Promise<number> {
  if (!(await pushOn(env))) return 0;
  const db = env.DB;
  const whose = await whoseBooking(db, kind, id);
  if (!whose) return 0;
  const { results: members } = await db
    .prepare(
      `SELECT m.id, m.role FROM members m WHERE m.workspace_id = 1 AND m.status = 'active'
         AND (m.role = 'OWNER' OR (m.role = 'PRACTITIONER' AND m.id IN (SELECT value FROM json_each(?1))))
         AND EXISTS (SELECT 1 FROM push_subs s WHERE s.member_id = m.id)`,
    )
    .bind(JSON.stringify(whose))
    .all<{ id: number; role: string }>();
  if (!members.length) return 0;
  const target = `${kind === "CREDIT_SESSION" ? "session" : "payment"}:${id}`;
  const now = iso(nowMs);
  const res = await db.batch(
    members.map((m) => {
      const due = dueFor(m.role, nowMs);
      return db
        .prepare("INSERT OR IGNORE INTO push_outbox (member_id, kind, target, state, due_at, held, created_at, updated_at) VALUES (?1, ?2, ?3, 'PENDING', ?4, ?5, ?6, ?6)")
        .bind(m.id, kind, target, iso(due.dueMs), due.held ? 1 : 0, now);
    }),
  );
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// The alert a webhook just queued goes at once, after the reply to the webhook (waitUntil), not two minutes later. Never delays the reply.
export function pushSoon(c: Context<{ Bindings: Env }>): void {
  if (!c.env?.VAPID_PUBLIC_KEY || !c.env?.VAPID_PRIVATE_KEY) return;
  try {
    c.executionCtx.waitUntil(sendPushAlerts(c.env).catch(() => 0));
  } catch {
    // no execution context (tests, or a call outside a request): the cron sends it
  }
}

// ---------- what an alert says ----------
export type Payload = { title: string; body: string; url: string; tag: string };
type Facts = { kind: AlertKind; amount?: number; bookingId?: number; startUtc?: string | null; size?: number; conv?: number };

// The booking as it stands now, or null when it no longer does (refunded since, cancelled, gone).
async function factsOf(db: Env["DB"], kind: AlertKind, target: string): Promise<Facts | null> {
  const id = Number(target.split(":")[1]);
  if (kind === "CREDIT_SESSION") {
    const r = await db
      .prepare("SELECT se.id AS bookingId, s.start_utc AS startUtc FROM sessions se LEFT JOIN slots s ON s.id = se.slot_id WHERE se.id = ?1 AND se.state = 'CREDIT_BOOKED'")
      .bind(id)
      .first<{ bookingId: number; startUtc: string | null }>();
    return r ? { kind, ...r } : null;
  }
  if (kind === "PACKAGE") {
    const r = await db
      .prepare("SELECT k.size, k.conversation_id AS conv FROM payments p JOIN packages k ON k.id = p.target_id WHERE p.id = ?1 AND p.purpose = 'PACKAGE' AND p.state = 'PAID'")
      .bind(id)
      .first<{ size: number; conv: number }>();
    return r ? { kind, ...r } : null;
  }
  const table = kind === "CALL" ? "intros" : "sessions";
  const r = await db
    .prepare(
      `SELECT p.amount_paise AS amount, b.id AS bookingId, s.start_utc AS startUtc FROM payments p JOIN ${table} b ON b.id = p.target_id LEFT JOIN slots s ON s.id = b.slot_id
       WHERE p.id = ?1 AND p.purpose = ?2 AND p.state = 'PAID'`,
    )
    .bind(id, PURPOSE[kind])
    .first<{ amount: number; bookingId: number; startUtc: string | null }>();
  return r ? { kind, ...r } : null;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
// "Today, 4:15 pm" / "Tomorrow, 2:00 pm" / "Thu, 5 Nov, 3:00 pm" in the member's language (the console's own day and clock words).
function whenText(startUtc: string, locale: string, nowMs: number): string {
  const w = W(locale);
  const day = istDay(Date.parse(startUtc));
  const word = day === istDay(nowMs) ? consoleCopy(locale).calToday : day === istDay(nowMs + DAY) ? w.tomorrow : dayName(startUtc, locale);
  return `${word}, ${clock(startUtc, locale)}`;
}

// Where a tap goes: today's booking on Today (its card), another day's on the Calendar's day; a package on the person's page.
function urlOf(f: Facts, nowMs: number): string {
  if (f.kind === "PACKAGE") return `/app/people/${f.conv}`;
  if (!f.startUtc) return "/app";
  const day = istDay(Date.parse(f.startUtc));
  if (day === istDay(nowMs)) return `/app#b-${f.kind === "CALL" ? "intro" : "session"}-${f.bookingId}`;
  return `/app/calendar?view=day&d=${day}`;
}

export function alertPayload(f: Facts, locale: string, rowId: number, nowMs = Date.now()): Payload {
  const w = W(locale);
  const when = f.startUtc ? whenText(f.startUtc, locale, nowMs) : "";
  const body =
    f.kind === "CALL" ? w.call(rupees(f.amount ?? 0), when)
    : f.kind === "SESSION" ? w.session(rupees(f.amount ?? 0), when)
    : f.kind === "PACKAGE" ? w.pack(f.size ?? 0)
    : w.credit(when);
  return { title: w.title, body, url: urlOf(f, nowMs), tag: `booking-${rowId}` };
}
export const overnightPayload = (n: number, locale: string): Payload => ({ title: W(locale).titleMany, body: W(locale).overnight(n), url: "/app", tag: "bookings-overnight" });
export const testPayload = (locale: string): Payload => ({ title: W(locale).testTitle, body: W(locale).testBody, url: "/app/settings#alerts", tag: "test" });

// ---------- sending ----------
type Delivery = "SENT" | "NONE" | "RETRY";

// One notification to every device of a member. A device the push service says is gone (404/410) is deleted; a delivered one is marked.
export async function deliver(env: Env, keys: VapidKeys, memberId: number, payload: Payload, nowMs = Date.now()): Promise<{ result: Delivery; sent: number; gone: number; failed: number }> {
  const db = env.DB;
  const { results: subs } = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subs WHERE member_id = ?1 ORDER BY id").bind(memberId).all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  let sent = 0;
  let gone = 0;
  let failed = 0;
  for (const s of subs) {
    const r = await sendPush(keys, s, payload, nowMs);
    if (r.ok) {
      sent++;
      await db.prepare("UPDATE push_subs SET last_success_at = ?2, failure_count = 0 WHERE id = ?1").bind(s.id, iso(nowMs)).run();
    } else if (r.gone) {
      gone++;
      await db.prepare("DELETE FROM push_subs WHERE id = ?1").bind(s.id).run();
    } else {
      failed++;
      await db.prepare("UPDATE push_subs SET failure_count = failure_count + 1 WHERE id = ?1").bind(s.id).run();
    }
  }
  return { result: sent ? "SENT" : failed ? "RETRY" : "NONE", sent, gone, failed };
}

type Row = { id: number; memberId: number; kind: AlertKind; target: string; held: number; attempts: number; locale: string | null; role: string | null; status: string | null };

// The 2-minute cron (and pushSoon): every alert that is due, claimed atomically so two runs never send one twice. With the keys missing
// it does nothing (the rows wait, and are deleted after config.push.keepDays).
export async function sendPushAlerts(env: Env, nowMs = Date.now()): Promise<number> {
  const keys = await vapidKeys(env);
  if (!keys) return 0;
  const db = env.DB;
  const now = iso(nowMs);
  await db.prepare("DELETE FROM push_outbox WHERE created_at < ?1").bind(iso(nowMs - P.keepDays * DAY)).run();
  // A claim left by a run that stopped half-way counts as one failed try.
  await db
    .prepare(
      `UPDATE push_outbox SET state = CASE WHEN attempts + 1 >= ?2 THEN 'FAILED' ELSE 'PENDING' END, attempts = attempts + 1, claim = NULL, updated_at = ?1
       WHERE state = 'SENDING' AND claimed_at < ?3`,
    )
    .bind(now, P.maxAttempts, iso(nowMs - 10 * MIN))
    .run();
  const claim = crypto.randomUUID();
  await db
    .prepare("UPDATE push_outbox SET state = 'SENDING', claim = ?1, claimed_at = ?2 WHERE id IN (SELECT id FROM push_outbox WHERE state = 'PENDING' AND due_at <= ?2 ORDER BY id LIMIT ?3)")
    .bind(claim, now, P.perRun)
    .run();
  const { results } = await db
    .prepare(
      `SELECT o.id, o.member_id AS memberId, o.kind, o.target, o.held, o.attempts, m.locale, m.role, m.status FROM push_outbox o LEFT JOIN members m ON m.id = o.member_id
       WHERE o.claim = ?1 AND o.state = 'SENDING' ORDER BY o.id`,
    )
    .bind(claim)
    .all<Row>();
  const finish = (ids: number[], state: "SENT" | "SKIPPED") =>
    db.prepare(`UPDATE push_outbox SET state = ?2, claim = NULL, updated_at = ?3${state === "SENT" ? ", sent_at = ?3" : ""} WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids), state, now).run();
  const retry = (ids: number[]) =>
    db
      .prepare(`UPDATE push_outbox SET state = CASE WHEN attempts + 1 >= ?2 THEN 'FAILED' ELSE 'PENDING' END, attempts = attempts + 1, claim = NULL, updated_at = ?3 WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids), P.maxAttempts, now)
      .run();

  // Each member's due alerts: a removed member, a changed role or a booking that no longer stands is skipped.
  const byMember = new Map<number, { row: Row; facts: Facts }[]>();
  for (const r of results) {
    const facts = r.status === "active" && (r.role === "OWNER" || r.role === "PRACTITIONER") ? await factsOf(db, r.kind, r.target) : null;
    if (!facts) {
      await finish([r.id], "SKIPPED");
      continue;
    }
    byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), { row: r, facts }]);
  }
  let sent = 0;
  for (const [memberId, items] of byMember) {
    const locale = items[0].row.locale ?? "en";
    // Several that waited through the quiet hours go as one; the rest one by one.
    const waited = items.filter((x) => x.row.held);
    const groups: { ids: number[]; payload: Payload }[] =
      waited.length > 1
        ? [{ ids: waited.map((x) => x.row.id), payload: overnightPayload(waited.length, locale) }, ...items.filter((x) => !x.row.held).map((x) => ({ ids: [x.row.id], payload: alertPayload(x.facts, locale, x.row.id, nowMs) }))]
        : items.map((x) => ({ ids: [x.row.id], payload: alertPayload(x.facts, locale, x.row.id, nowMs) }));
    for (const g of groups) {
      const d = await deliver(env, keys, memberId, g.payload, nowMs);
      if (d.result === "SENT") {
        await finish(g.ids, "SENT");
        sent += g.ids.length;
      } else if (d.result === "NONE") await finish(g.ids, "SKIPPED"); // no device left
      else await retry(g.ids);
    }
  }
  return sent;
}

// The digest's one line (src/report.ts): alerts sent and not delivered in the last 24 hours.
export async function pushDigestLine(env: Env, nowMs = Date.now()): Promise<string> {
  if (!(await pushOn(env))) return "Phone alerts to the team: off (the alert keys aren't set).";
  const since = iso(nowMs - DAY);
  const r = await env.DB
    .prepare("SELECT COALESCE(SUM(state = 'SENT' AND sent_at >= ?1), 0) AS sent, COALESCE(SUM(state = 'FAILED' AND updated_at >= ?1), 0) AS failed FROM push_outbox")
    .bind(since)
    .first<{ sent: number; failed: number }>();
  return `Phone alerts to the team (last 24 hours): ${r?.sent ?? 0} sent, ${r?.failed ?? 0} not delivered.`;
}

// ---------- Settings → Alerts on this phone ----------
// The Settings page's CSP, only while this section is drawn with its buttons: the strict console CSP plus this one same-origin script
// (/app/alerts.js) and the service worker it registers (/app/sw.js). Every other console page stays script-free.
export const ALERTS_CSP = `${CONSOLE_CSP}; script-src 'self'; worker-src 'self'`;
export const ALERTS_FLASH = ["alertsOn", "alertsOff", "alertsRemoved", "alertsTestSent", "alertsTestFailed", "alertsNoDevice", "alertsBad", "alertsTooMany", "alertsPushOff"] as const;
export type AlertsFlash = (typeof ALERTS_FLASH)[number];
const FLASH_WORD: Record<AlertsFlash, keyof Words> = {
  alertsOn: "flashOn", alertsOff: "flashOff", alertsRemoved: "flashRemoved", alertsTestSent: "flashTestSent", alertsTestFailed: "flashTestFailed",
  alertsNoDevice: "flashNoDevice", alertsBad: "flashBad", alertsTooMany: "flashTooMany", alertsPushOff: "flashPushOff",
};
export const alertsFlash = (code: string | undefined, locale: string): string | null =>
  code && (ALERTS_FLASH as readonly string[]).includes(code) ? (W(locale)[FLASH_WORD[code as AlertsFlash]] as string) : null;

const token = (c: ConsoleCtx) => memberCsrf(c.get("jwt"), c.get("member"), "settings-alerts");
// The audit row, as auditStmt in src/console.ts (written only if the change before it in the batch changed a row). Not imported from
// there: the payment and package code import this file, and src/console.ts imports most of the console.
const auditStmt = (c: ConsoleCtx, action: string, target: string, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() > 0").bind(
    c.get("email"), action, target, detail, c.get("member").workspaceId, c.get("member").id,
  );
// The first 16 hex of SHA-256 of an endpoint: the page tells the script which of this member's devices are on, without the address itself.
export const endpointTag = async (endpoint: string) => (await sha256Hex(endpoint)).slice(0, 16);
const hidden = (name: string, value = "") => html`<input type="hidden" name="${name}" value="${value}">`;

// The card for the signed-in owner or practitioner (staff never reach it). `scripted`: whether the page must carry ALERTS_CSP.
export async function alertsSection(c: ConsoleCtx): Promise<{ html: unknown; scripted: boolean }> {
  const m = c.get("member");
  const w = W(m.locale);
  const keys = await vapidKeys(c.env);
  const why = m.role === "OWNER" ? w.whyOwner : w.whyPrac(clockOf(P.quietFrom, m.locale), clockOf(P.quietUntil, m.locale));
  if (!keys) return { html: html`<div class="card" id="alerts"><p class="why">${why}</p><p><b>${w.off}</b></p></div>`, scripted: false };
  const { results: subs } = await c.env.DB.prepare("SELECT id, endpoint, ua, created_at AS createdAt FROM push_subs WHERE member_id = ?1 ORDER BY id").bind(m.id).all<{ id: number; endpoint: string; ua: string; createdAt: string }>();
  const csrf = await token(c);
  const tags = (await Promise.all(subs.map((s) => endpointTag(s.endpoint)))).join(",");
  const list = subs.length
    ? rows(subs.map(
        (s) => html`<div class="row"><div><p class="t">${s.ua || "—"}</p><p class="s">${w.added(dayName(s.createdAt, m.locale))}</p></div>
<form method="post" action="/app/settings/alerts/remove">${hidden("csrf", csrf)}${hidden("id", String(s.id))}<button class="btn" type="submit">${w.remove}</button></form></div>`,
      ))
    : html`<p class="note">${w.noDevices}</p>`;
  const body = html`<div class="card" id="alerts"><style>#alerts [hidden]{display:none!important}</style><p class="why">${why}</p><p class="why">${w.private}</p><p class="note">${w.iphone}</p>
<div id="push" data-key="${keys.publicKey}" data-known="${tags}">
<p data-state="on" hidden><b>${w.stateOn}</b></p><p data-state="unsupported" hidden>${w.unsupported}</p><p data-state="denied" hidden>${w.denied}</p><p data-state="error" hidden>${w.failed}</p>
<div class="acts"><form id="push-on" data-state="off" method="post" action="/app/settings/alerts/on" hidden>${hidden("csrf", csrf)}${hidden("endpoint")}${hidden("p256dh")}${hidden("auth")}<button class="btn primary" type="submit">${w.turnOn}</button></form>
<form id="push-off" data-state="on" method="post" action="/app/settings/alerts/off" hidden>${hidden("csrf", csrf)}${hidden("endpoint")}<button class="btn" type="submit">${w.turnOff}</button></form>
${subs.length ? html`<form method="post" action="/app/settings/alerts/test">${hidden("csrf", csrf)}<button class="btn" type="submit">${w.test}</button></form>` : ""}</div></div>
<h3 style="margin-top:16px">${w.devices}</h3>${list}</div>${raw('<script src="/app/alerts.js" defer></script>')}`;
  return { html: body, scripted: true };
}
export const alertsTitle = (locale: string) => W(locale).sec;
// "21:00" as the console writes a time ("9:00 pm" / "रात 9:00").
const clockOf = (hhmm: string, locale: string) => clock(`2026-01-01T${hhmm}:00+05:30`, locale);

// "Chrome on Android", "Safari on iPhone": the only thing kept about the device, from its User-Agent.
export function deviceName(ua: string | undefined): string {
  const u = ua ?? "";
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /CrOS/.test(u) ? "Chromebook" : /Windows/.test(u) ? "Windows" : /Mac OS X|Macintosh/.test(u) ? "Mac" : /Linux/.test(u) ? "Linux" : "";
  const browser = /EdgA?\/|EdgiOS/.test(u) ? "Edge" : /SamsungBrowser/.test(u) ? "Samsung Internet" : /Firefox|FxiOS/.test(u) ? "Firefox" : /OPR\//.test(u) ? "Opera" : /CriOS|Chrome\//.test(u) ? "Chrome" : /Safari|iPhone|iPad|Macintosh/.test(u) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || "Browser";
}

// ---- the forms (under /app/settings/alerts; src/settings.ts lets the owner and the practitioner in, never staff) ----
export const alertRoutes = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();
const back = (c: ConsoleCtx, code: AlertsFlash) => c.redirect(`/app/settings?m=${code}#alerts`, 303);
const form = async (c: ConsoleCtx) => (await c.req.parseBody()) as Record<string, string | undefined>;

// Every form: the member may (phone_alerts), the token is this member's, and push is set up.
alertRoutes.use("*", async (c, next) => {
  if (can(c.get("member"), "phone_alerts") !== "yes") return c.text("Forbidden", 403);
  const f = await form(c);
  if ((f.csrf ?? "") !== (await token(c))) return c.text("Forbidden", 403);
  if (!(await pushOn(c.env))) return back(c, "alertsPushOff");
  await next();
});

alertRoutes.post("/on", async (c) => {
  const m: Member = c.get("member");
  const f = await form(c);
  const endpoint = (f.endpoint ?? "").trim();
  const p256dh = (f.p256dh ?? "").trim();
  const auth = (f.auth ?? "").trim();
  if (!allowedEndpoint(endpoint) || !validKeys(p256dh, auth)) return back(c, "alertsBad");
  const db = c.env.DB;
  const mine = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(endpoint = ?2), 0) AS here FROM push_subs WHERE member_id = ?1").bind(m.id, endpoint).first<{ n: number; here: number }>();
  if (!mine?.here && (mine?.n ?? 0) >= P.maxDevices) return back(c, "alertsTooMany");
  const ua = deviceName(c.req.header("User-Agent"));
  // One row per browser: the same phone turned on again keeps its row (new keys if the browser made new ones); a browser another member
  // turned on before moves to whoever turns it on now.
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_subs (member_id, endpoint, p256dh, auth, ua, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, failure_count = 0
         WHERE push_subs.member_id != excluded.member_id OR push_subs.p256dh != excluded.p256dh OR push_subs.auth != excluded.auth`,
      )
      .bind(m.id, endpoint, p256dh, auth, ua, iso(Date.now())),
    auditStmt(c, "PUSH_SUBSCRIBED", `member:${m.id}`, ua),
  ]);
  return back(c, "alertsOn");
});

alertRoutes.post("/off", async (c) => {
  const m = c.get("member");
  const endpoint = ((await form(c)).endpoint ?? "").trim();
  const row = endpoint ? await c.env.DB.prepare("SELECT id, ua FROM push_subs WHERE member_id = ?1 AND endpoint = ?2").bind(m.id, endpoint).first<{ id: number; ua: string }>() : null;
  if (row) await removeSub(c, row);
  return back(c, "alertsOff");
});

alertRoutes.post("/remove", async (c) => {
  const m = c.get("member");
  const id = Number((await form(c)).id);
  const row = Number.isInteger(id) ? await c.env.DB.prepare("SELECT id, ua FROM push_subs WHERE member_id = ?1 AND id = ?2").bind(m.id, id).first<{ id: number; ua: string }>() : null;
  if (!row) return c.text("Not found", 404); // never another member's device
  await removeSub(c, row);
  return back(c, "alertsRemoved");
});

const removeSub = (c: ConsoleCtx, row: { id: number; ua: string }) =>
  c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM push_subs WHERE id = ?1 AND member_id = ?2").bind(row.id, c.get("member").id),
    auditStmt(c, "PUSH_UNSUBSCRIBED", `member:${c.get("member").id}`, row.ua),
  ]);

alertRoutes.post("/test", async (c) => {
  const m = c.get("member");
  const keys = (await vapidKeys(c.env))!;
  const d = await deliver(c.env, keys, m.id, testPayload(m.locale));
  return back(c, d.sent ? "alertsTestSent" : d.result === "NONE" ? "alertsNoDevice" : "alertsTestFailed");
});

// ---------- the two scripts, served by the Worker (no inline script anywhere, no eval) ----------
// The service worker (scope /app/): shows the notification, and a tap opens (or focuses) the console page it names, only ever under /app.
export const SW_JS = `// Disha Dira console: phone alerts (ticket 45). Shows the alert; a tap opens or focuses the page it names under /app.
"use strict";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
function target(raw) {
  try {
    var u = new URL(raw || "/app", self.location.origin);
    if (u.origin === self.location.origin && (u.pathname === "/app" || u.pathname.indexOf("/app/") === 0)) return u.href;
  } catch (e) {}
  return new URL("/app", self.location.origin).href;
}
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  var title = typeof d.title === "string" && d.title ? d.title : "Disha Dira";
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === "string" ? d.body : "",
    icon: "/app/brand/icon-192.png",
    tag: typeof d.tag === "string" ? d.tag : undefined,
    data: { url: target(d.url) }
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = target(e.notification.data && e.notification.data.url);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].url === url && "focus" in list[i]) return list[i].focus();
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if ("navigate" in c && c.url.indexOf(self.location.origin + "/app") === 0) return c.navigate(url).then(function (w) { return w ? w.focus() : self.clients.openWindow(url); }, function () { return self.clients.openWindow(url); });
    }
    return self.clients.openWindow(url);
  }));
});
`;

// Settings → Alerts on this phone: Turn on asks the browser's permission (a tap, as iPhone requires), subscribes with the server's public
// key and posts the subscription in the page's own form (token + Origin as every form); Turn off unsubscribes and posts the address.
export const ALERTS_JS = `// Disha Dira console: Settings, Alerts on this phone (ticket 45). Loaded only by the Settings page.
"use strict";
(function () {
  var box = document.getElementById("push");
  if (!box) return;
  var onForm = document.getElementById("push-on");
  var offForm = document.getElementById("push-off");
  function show() {
    var names = Array.prototype.slice.call(arguments);
    var els = box.querySelectorAll("[data-state]");
    for (var i = 0; i < els.length; i++) els[i].hidden = names.indexOf(els[i].getAttribute("data-state")) < 0;
  }
  function bytes(s) {
    var b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function tag(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").slice(0, 16);
    });
  }
  function sameKey(sub, key) {
    var k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    var a = new Uint8Array(k), b = bytes(key);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  var key = box.getAttribute("data-key") || "";
  var known = (box.getAttribute("data-known") || "").split(",").filter(Boolean);
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !window.isSecureContext) return show("unsupported");
  if (Notification.permission === "denied") return show("denied");
  navigator.serviceWorker.getRegistration("/app/").then(function (reg) {
    return reg ? reg.pushManager.getSubscription() : null;
  }).then(function (sub) {
    if (!sub || Notification.permission !== "granted") return show("off");
    return tag(sub.endpoint).then(function (t) { show(known.indexOf(t) >= 0 ? "on" : "off"); });
  }).catch(function () { show("off"); });

  onForm.addEventListener("submit", function (e) {
    e.preventDefault();
    Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") { show(perm === "denied" ? "denied" : "off"); return; }
      return navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then(function () {
        return navigator.serviceWorker.ready;
      }).then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          if (sub && !sameKey(sub, key)) return sub.unsubscribe().then(function () { return null; });
          return sub;
        }).then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
        });
      }).then(function (sub) {
        var j = sub.toJSON();
        onForm.elements.endpoint.value = sub.endpoint;
        onForm.elements.p256dh.value = (j.keys && j.keys.p256dh) || "";
        onForm.elements.auth.value = (j.keys && j.keys.auth) || "";
        onForm.submit();
      });
    }).catch(function () { show("error", "off"); });
  });

  offForm.addEventListener("submit", function (e) {
    e.preventDefault();
    navigator.serviceWorker.getRegistration("/app/").then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) {
      if (!sub) { offForm.submit(); return; }
      offForm.elements.endpoint.value = sub.endpoint;
      return sub.unsubscribe().then(function () { offForm.submit(); });
    }).catch(function () { show("error", "on"); });
  });
})();
`;

const on = (c: Context) => (c.env as { CONSOLE_V2?: string } | undefined)?.CONSOLE_V2 === "true";
const script = (body: string, csp: string) =>
  new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": csp } });
// GET /app/sw.js: its own CSP (the worker's): no fetching, its own origin's scripts and the icon only. 404 while CONSOLE_V2 is off.
export const SW_CSP = "default-src 'none'; script-src 'self'; img-src 'self'";
export const serveSw = (c: Context) => (on(c) ? script(SW_JS, SW_CSP) : c.text("Not found", 404));
// GET /app/alerts.js
export const serveAlertsJs = (c: Context) => (on(c) ? script(ALERTS_JS, "default-src 'none'") : c.text("Not found", 404));
