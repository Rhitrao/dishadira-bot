// Ticket 40: after the call, the owner's requests of 4 Nov 2026 (CONTRACT v10). Two one-to-one messages, each to one customer about their own
// call or session, never a broadcast; both on the 2-minute cron (src/index.ts), each claimed atomically in the after_call table
// (migrations/0017_after_call.sql: PENDING -> SENDING -> SENT | FAILED | UNKNOWN, or SKIPPED) so it goes at most once.
//  1. The session reminder: Amma marked the ₹99 call "Session", the offer went out, and 48 hours later nothing is paid or booked: one gentle
//     reminder with the same three options (inside the 24-hour window the list; outside it the `session_reminder` template, whose button, or
//     any reply, shows the list again, as `session_offer`'s does).
//  2. The review and referral ask: the morning after a paid session (from 10:00 India time), one thank-you with the Google review link (when
//     config has one) and a wa.me link with a prefilled "referred by a friend" message to pass on. At most once per person in 90 days.
//     No incentive of any kind for a review (Google's policy).
// Neither goes at night (config.followUp, as the automatic follow-ups), while messages or bookings are paused or Amma is away, to a chat the
// team has, a blocked or rude person, anyone who said stop, after a crisis or emergency message, or in the no-selling week. A template not
// yet approved by Meta is skipped (and counted in the digest), never sent and never tried again for that offer or session.
// The owner turns each on or off in Settings (/app/settings, and /admin while the console is off); stored as two settings rows.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor } from "./copy";
import type { Env } from "./env";
import { atNight, followUpsOn } from "./followup";
import { sessionOfferOut } from "./packages";
import { sendMessage, templateVariant, type Out } from "./send";
import { iso, istDay } from "./slots";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const A = config.afterCall;

// ---- the owner's two switches ----
export const AFTER_SWITCHES = ["reminder", "review"] as const;
export type AfterSwitch = (typeof AFTER_SWITCHES)[number];
export const isAfterSwitch = (v: unknown): v is AfterSwitch => typeof v === "string" && (AFTER_SWITCHES as readonly string[]).includes(v);
export const afterKey = (name: AfterSwitch) => `after.${name}`;
// The reminder is on unless the owner turned it off; the review ask is off until the owner turns it on (once the review link is in config).
const DEFAULT_ON: Record<AfterSwitch, boolean> = { reminder: true, review: false };

export async function afterSwitches(db: D1Database): Promise<Record<AfterSwitch, boolean>> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('after.reminder', 'after.review')").all<{ key: string; value: string }>();
  const v = (name: AfterSwitch) => {
    const r = results.find((x) => x.key === afterKey(name))?.value;
    return r === "on" ? true : r === "off" ? false : DEFAULT_ON[name];
  };
  return { reminder: v("reminder"), review: v("review") };
}

// The statement that sets a switch (joined with its audit row by the caller); changes nothing when it already has that value.
export const setAfterSwitchStmt = (db: D1Database, name: AfterSwitch, on: boolean, nowMs = Date.now()) =>
  db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE settings.value != ?2")
    .bind(afterKey(name), on ? "on" : "off", iso(nowMs));

// The link a customer can pass on: WhatsApp to the business number, with the friend's first message filled in.
export const referralLink = () => `https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=${encodeURIComponent(A.referralText)}`;

// ---- what both share ----
type Kind = "REMINDER" | "REVIEW";
type State = "SENT" | "FAILED" | "UNKNOWN";

// Never to: a chat with the team or blocked (or on the block list), "stop", a quiet period after strikes, an insult or sexual message, the
// no-selling week, a crisis or emergency message in the last `safetyDays` days or its item still open, "Talk to a person" still open.
// ?1 is now, ?2 the start of the safety look-back. `c` is conversations, `ps` the LEFT JOINed person_state.
const peopleSql = `c.mode = 'BOT' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.wa_id = c.wa_id)
  AND (ps.conversation_id IS NULL OR (ps.opted_out_at IS NULL AND ps.abuse_offences = 0 AND ps.flirt_offences = 0
    AND (ps.quiet_until IS NULL OR ps.quiet_until <= ?1) AND (ps.no_sell_until IS NULL OR ps.no_sell_until <= ?1)))
  AND NOT EXISTS (SELECT 1 FROM attention a WHERE a.target = 'conv:' || c.id AND a.kind IN ('HUMAN_REQUEST', 'CRISIS', 'EMERGENCY', 'THREAT')
    AND (a.resolved_at IS NULL OR a.created_at >= ?2))
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'OUT' AND m.created_at >= ?2
    AND (m.dedupe_key LIKE '%:crisis' OR m.dedupe_key LIKE '%:emergency'))`;

// The claim (CONTRACT "Outbound sends"): the row goes in PENDING (once per kind and target; `extra` is a further condition on the insert,
// e.g. the 90-day limit), then one caller moves it to SENDING. False: another run has it, it was done before, or `extra` refused it.
async function claim(db: D1Database, kind: Kind, target: number, conv: number, nowMs: number, extra = "1 = 1", binds: unknown[] = []): Promise<boolean> {
  const ins = await db
    .prepare(`INSERT OR IGNORE INTO after_call (kind, target, conversation_id, created_at) SELECT ?1, ?2, ?3, ?4 WHERE ${extra}`)
    .bind(kind, target, conv, iso(nowMs), ...binds)
    .run();
  if (!ins.meta.changes) return false;
  const res = await db
    .prepare("UPDATE after_call SET state = 'SENDING', updated_at = ?3 WHERE kind = ?1 AND target = ?2 AND state = 'PENDING'")
    .bind(kind, target, iso(nowMs))
    .run();
  return res.meta.changes > 0;
}
const settle = (db: D1Database, kind: Kind, target: number, state: State | "SKIPPED", nowMs: number, why: string | null = null) =>
  db.prepare("UPDATE after_call SET state = ?3, skip_reason = ?4, updated_at = ?5 WHERE kind = ?1 AND target = ?2").bind(kind, target, state, why, iso(nowMs)).run();

const inWindow = (lastUserAt: string | null, nowMs: number) => !!lastUserAt && nowMs - Date.parse(lastUserAt) < config.windowHours * HOUR;

// One message: the free text inside the 24-hour window, else the template when Meta has approved it (else SKIPPED with the reason, for
// the digest). The one send path records it (dedupe key `after:<kind>:<target>`) and refuses outside the window.
async function deliver(env: Env, kind: Kind, target: number, r: { conv: number; locale: string; lastUserAt: string | null }, text: Out, template: Extract<Out, { type: "template" }> | null, nowMs: number): Promise<State | "SKIPPED"> {
  let out: Out = text;
  let skip: string | null = null;
  if (!inWindow(r.lastUserAt, nowMs)) {
    if (!template) skip = "NO_REVIEW_LINK";
    else if (!templateVariant(template, r.locale).approved) skip = "TEMPLATE_UNAPPROVED";
    else out = template;
  }
  if (skip) {
    await settle(env.DB, kind, target, "SKIPPED", nowMs, skip);
    return "SKIPPED";
  }
  const res = await sendMessage(env, r.conv, out, `after:${kind.toLowerCase()}:${target}`).catch(() => "UNKNOWN" as const);
  const state: State = res === "SENT" ? "SENT" : res === "UNKNOWN" || res === "DUPLICATE" ? "UNKNOWN" : "FAILED";
  await settle(env.DB, kind, target, state, nowMs);
  return state;
}

// ---- 1. the session reminder ----
type Offer = { introId: number; conv: number; locale: string; lastUserAt: string | null; sid: number; offeredAt: string };

// A call marked "Session" whose offer went out (the `outcome:<id>:offer` message, sent or maybe sent) between 96 and 48 hours ago, the
// session still open to choose (offered, expired, or a hold that lapsed), and since the offer: no session or package paid (or being paid
// right now), no slot held, no package bought.
export async function sessionReminders(env: Env, nowMs = Date.now()): Promise<number> {
  if (atNight(nowMs) || !(await followUpsOn(env)) || !(await afterSwitches(env.DB)).reminder) return 0;
  const now = iso(nowMs);
  const { results } = await env.DB
    .prepare(
      `SELECT i.id AS introId, c.id AS conv, c.locale, c.last_user_at AS lastUserAt, se.id AS sid, m.created_at AS offeredAt
       FROM outcomes o JOIN intros i ON i.id = o.intro_id JOIN conversations c ON c.id = i.conversation_id
       JOIN sessions se ON se.intro_id = i.id LEFT JOIN slots sl ON sl.id = se.slot_id
       JOIN messages m ON m.dedupe_key = 'outcome:' || o.id || ':offer' AND m.direction = 'OUT' AND m.status IN ('SENT', 'UNKNOWN')
       LEFT JOIN person_state ps ON ps.conversation_id = c.id
       WHERE o.value = 'SESSION' AND o.applied_at IS NOT NULL AND i.state = 'CALLED_SESSION'
         AND m.created_at <= ?3 AND m.created_at > ?4
         AND (se.state IN ('OFFERED', 'EXPIRED') OR (se.state = 'HELD' AND (sl.hold_until IS NULL OR sl.hold_until <= ?1)))
         AND NOT EXISTS (SELECT 1 FROM after_call x WHERE x.kind = 'REMINDER' AND x.target = i.id)
         AND NOT EXISTS (SELECT 1 FROM packages k WHERE k.conversation_id = c.id AND k.state IN ('PAID', 'CLOSED'))
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.created_at >= m.created_at AND (p.state IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')
             OR (p.state IN ('CREATING', 'PENDING', 'UNKNOWN') AND p.created_at > ?5)) AND (
           (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = c.id)) OR
           (p.purpose = 'PACKAGE' AND p.target_id IN (SELECT id FROM packages WHERE conversation_id = c.id))))
         AND NOT EXISTS (SELECT 1 FROM sessions s2 WHERE s2.conversation_id = c.id AND s2.state IN ('CONFIRMED', 'CREDIT_BOOKED', 'COMPLETED'))
         AND NOT EXISTS (SELECT 1 FROM slots s3 WHERE s3.owner_id = c.id AND s3.state = 'HELD' AND s3.hold_until > ?1)
         AND ${peopleSql}
       ORDER BY m.created_at LIMIT 25`,
    )
    .bind(now, iso(nowMs - 7 * DAY), iso(nowMs - A.reminderAfterHours * HOUR), iso(nowMs - A.reminderLastHours * HOUR), iso(nowMs - config.sessionRules.packageLinkMinutes * 60_000))
    .all<Offer>();
  let sent = 0;
  for (const r of results) {
    if (!(await claim(env.DB, "REMINDER", r.introId, r.conv, nowMs))) continue;
    const cp = copyFor(r.locale);
    const state = await deliver(env, "REMINDER", r.introId, r, sessionOfferOut(cp, r.sid, cp.sessionReminderBody), { type: "template", name: "session_reminder", params: [] }, nowMs);
    if (state === "SENT" || state === "UNKNOWN") sent++;
  }
  return sent;
}

// ---- 2. the review and referral ask ----
type Done = { sid: number; conv: number; locale: string; lastUserAt: string | null; startUtc: string };

// From config.afterCall.reviewFrom (India time) on the day after the session, for config.afterCall.reviewDays days, and never at night.
export function reviewDue(sessionStartUtc: string, nowMs: number): boolean {
  const next = istDay(Date.parse(sessionStartUtc) + DAY);
  const from = Date.parse(`${next}T${A.reviewFrom}:00+05:30`);
  if (nowMs < from || nowMs >= from + A.reviewDays * DAY || atNight(nowMs)) return false;
  const ist = new Date(nowMs + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() >= Number(A.reviewFrom.slice(0, 2)) * 60 + Number(A.reviewFrom.slice(3, 5));
}

// A session that took place (marked Completed; or, with config.afterCall.reviewUnmarked, its time passed and nobody marked it No-show or
// Not right fit), paid for (a single session's own payment, or the package it was booked from), and the person has never had "Not right
// fit" or "Rude" on a call or session, nor any refund other than an automatic duplicate-payment one, nor an open item on that session, nor a
// review ask in the last 90 days. The ₹99 call never gets one.
export async function reviewAsks(env: Env, nowMs = Date.now()): Promise<number> {
  if (atNight(nowMs) || !(await followUpsOn(env)) || !(await afterSwitches(env.DB)).review) return 0;
  const now = iso(nowMs);
  const { results } = await env.DB
    .prepare(
      `SELECT se.id AS sid, c.id AS conv, c.locale, c.last_user_at AS lastUserAt, sl.start_utc AS startUtc
       FROM sessions se JOIN slots sl ON sl.id = se.slot_id JOIN conversations c ON c.id = se.conversation_id
       LEFT JOIN person_state ps ON ps.conversation_id = c.id
       WHERE sl.end_utc <= ?1 AND sl.start_utc > ?3
         AND (se.state = 'COMPLETED' OR (?4 = 1 AND se.state IN ('CONFIRMED', 'CREDIT_BOOKED')))
         AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.session_id = se.id)
         AND ((se.origin != 'CREDIT' AND EXISTS (SELECT 1 FROM payments p WHERE p.purpose = 'SESSION' AND p.target_id = se.id AND p.state = 'PAID'))
           OR (se.origin = 'CREDIT' AND EXISTS (SELECT 1 FROM packages k JOIN payments p ON p.id = k.payment_id WHERE k.id = se.package_id AND p.state = 'PAID')))
         AND NOT EXISTS (SELECT 1 FROM after_call x WHERE x.kind = 'REVIEW' AND (x.target = se.id
           OR (x.conversation_id = c.id AND x.state IN ('SENDING', 'SENT', 'UNKNOWN') AND x.created_at >= ?5)))
         AND NOT EXISTS (SELECT 1 FROM intros i WHERE i.conversation_id = c.id AND i.state IN ('CALLED_NOT_FIT', 'RUDE'))
         AND NOT EXISTS (SELECT 1 FROM sessions s2 WHERE s2.conversation_id = c.id AND s2.state = 'NOT_FIT')
         AND NOT EXISTS (SELECT 1 FROM outcomes o2 WHERE o2.value IN ('NOT_FIT', 'RUDE') AND (o2.intro_id IN (SELECT id FROM intros WHERE conversation_id = c.id)
           OR o2.session_id IN (SELECT id FROM sessions WHERE conversation_id = c.id)))
         AND NOT EXISTS (SELECT 1 FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.reason != 'DUPLICATE' AND (
           (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = c.id)) OR
           (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = c.id)) OR
           (p.purpose = 'PACKAGE' AND p.target_id IN (SELECT id FROM packages WHERE conversation_id = c.id))))
         AND NOT EXISTS (SELECT 1 FROM attention a WHERE a.target = 'session:' || se.id AND a.resolved_at IS NULL)
         AND ${peopleSql}
       ORDER BY sl.start_utc LIMIT 25`,
    )
    .bind(now, iso(nowMs - A.reviewEveryDays * DAY), iso(nowMs - (A.reviewDays + 2) * DAY), A.reviewUnmarked ? 1 : 0, iso(nowMs - A.reviewEveryDays * DAY))
    .all<Done>();
  let sent = 0;
  const seen = new Set<number>(); // two sessions of one person: one ask
  for (const r of results) {
    if (seen.has(r.conv) || !reviewDue(r.startUtc, nowMs)) continue;
    seen.add(r.conv);
    // The 90-day limit, again in the claim itself, so two runs at once can't both ask.
    const ok = await claim(
      env.DB, "REVIEW", r.sid, r.conv, nowMs,
      "NOT EXISTS (SELECT 1 FROM after_call WHERE kind = 'REVIEW' AND conversation_id = ?3 AND state IN ('PENDING', 'SENDING', 'SENT', 'UNKNOWN') AND created_at >= ?5)",
      [iso(nowMs - A.reviewEveryDays * DAY)],
    );
    if (!ok) continue;
    const cp = copyFor(r.locale);
    const link = referralLink();
    const review = A.googleReviewUrl;
    const state = await deliver(
      env, "REVIEW", r.sid, r,
      { type: "text", text: cp.reviewAsk(review, link) },
      review ? { type: "template", name: "review_ask", params: [review, link] } : null, // the template always has the review link
      nowMs,
    );
    if (state === "SENT" || state === "UNKNOWN") sent++;
  }
  return sent;
}

// On the 2-minute cron: rows older than 180 days go (the review limit needs 90).
export async function cleanAfterCall(env: Env, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM after_call WHERE created_at < ?1").bind(iso(nowMs - 180 * DAY)).run();
}

// The 9pm digest: what went in the last 24 hours, and what was skipped because its template isn't approved yet (or there is no review link).
export async function afterCallLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const { results } = await env.DB
    .prepare("SELECT kind, state, skip_reason AS why, COUNT(*) AS n FROM after_call WHERE created_at >= ?1 GROUP BY kind, state, skip_reason")
    .bind(iso(nowMs - DAY))
    .all<{ kind: Kind; state: string; why: string | null; n: number }>();
  const n = (kind: Kind, pick: (s: string, why: string | null) => boolean) => results.filter((r) => r.kind === kind && pick(r.state, r.why)).reduce((t, r) => t + r.n, 0);
  const sent = (k: Kind) => n(k, (s) => s === "SENT" || s === "UNKNOWN");
  const tpl = (k: Kind) => n(k, (s, why) => s === "SKIPPED" && why === "TEMPLATE_UNAPPROVED");
  const noLink = n("REVIEW", (s, why) => s === "SKIPPED" && why === "NO_REVIEW_LINK");
  const sw = await afterSwitches(env.DB);
  const line = (label: string, k: Kind, on: boolean) =>
    `- ${label}: ${sent(k)} sent${tpl(k) ? `, ${tpl(k)} not sent (the WhatsApp template isn't approved yet)` : ""}${k === "REVIEW" && noLink ? `, ${noLink} not sent (no Google review link yet)` : ""}${on ? "" : " (switched off in Settings)"}`;
  return [line("Session reminders", "REMINDER", sw.reminder), line("Review and referral asks", "REVIEW", sw.review)];
}
