// Ticket 35: automatic follow-ups, the owner's decisions of 1 Nov 2026 (CONTRACT v8). Someone who sent a real message and hasn't booked
// gets, on the channel they wrote on, one message 60 minutes and one 20 hours after their last real message (a new message starts the
// times again), at most 2 per channel in 7 days. Nothing between 21:00 and 08:00 India time: one that falls due at night goes at 08:00 if
// that is still within 23 hours of their last message (inside Meta's 24-hour window, which all three channels have), otherwise never.
// Free text only, never a template. An illness named (config.router.topics.medical, the words that make the WhatsApp bot answer without
// a booking button, docs/KNOWLEDGE.md §5 59-62): only the gentle check-in at 20 hours, with no price and no booking button.
// This file has the rules and WhatsApp's part; Instagram and Messenger are src/social.ts socialFollowUps. Both run on the 2-minute cron
// (src/index.ts). Stored: times and the follow-up rows (migrations/0015_followups.sql), never message text.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor } from "./copy";
import type { Env } from "./env";
import { classifyWithoutAI, isJobText, type Gate } from "./gate";
import { paidInSql } from "./noise";
import { hasPhrase } from "./safety";
import { sendMessage, type Out } from "./send";
import { iso } from "./slots";
import { switchStates } from "./switches";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const F = config.followUp;

export type Channel = "whatsapp" | "instagram" | "messenger";
type State = "SENT" | "FAILED" | "UNKNOWN";

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// 21:00 to 08:00 India time (India has no daylight saving: always UTC+5:30).
export function atNight(nowMs: number): boolean {
  const d = new Date(nowMs + 330 * MIN);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= minutesOf(F.nightFrom) || m < minutesOf(F.nightUntil);
}

// The follow-up due now for someone whose last real message was at `anchor`: the second from 20 hours (the first is never sent after
// that), the first from 60 minutes; none at night or after 23 hours. An illness named in the last week: only the second, gentle.
export function dueFollowUp(anchor: string, gentleAt: string | null, nowMs: number): { stage: 1 | 2; gentle: boolean } | null {
  const since = nowMs - Date.parse(anchor);
  if (atNight(nowMs) || since > F.lastAfterHours * HOUR) return null;
  const gentle = gentleAt !== null && nowMs - Date.parse(gentleAt) < F.gentleDays * DAY;
  if (since >= F.secondAfterHours * HOUR) return { stage: 2, gentle };
  if (since >= F.firstAfterMinutes * MIN && !gentle) return { stage: 1, gentle };
  return null;
}

// Only while messages can go out (SENDS, and the /admin pause) and bookings are open (the "Amma away" switch closes them too).
export async function followUpsOn(env: Env): Promise<boolean> {
  const sw = await switchStates(env);
  return sw.find((s) => s.name === "SENDS")!.on && sw.find((s) => s.name === "NEW_BOOKINGS")!.on;
}

// The binds every candidate query uses, in this order (pendingSql reads ?3, ?4 and ?7).
export const windowBinds = (nowMs: number) => [
  iso(nowMs - F.lastAfterHours * HOUR), // ?1 the oldest last message still followed up
  iso(nowMs - F.firstAfterMinutes * MIN), // ?2 the newest
  iso(nowMs - F.secondAfterHours * HOUR), // ?3 at or before this, the second is due
  iso(nowMs - 7 * DAY), // ?4 the weekly count starts here
  iso(nowMs), // ?5 now
  50, // ?6 at most this many people a run
  iso(nowMs - F.gentleDays * DAY), // ?7 an illness named since: only the gentle one
] as const;

// SQL for a candidate query: the follow-up due now isn't claimed yet, the weekly limit isn't reached, and someone owed only the gentle
// one isn't listed before its time. `channel`, `person`, `anchor` and `gentle` are column expressions.
export const pendingSql = (channel: string, person: string, anchor: string, gentle: string) => `
  NOT EXISTS (SELECT 1 FROM followups f WHERE f.channel = ${channel} AND f.person = ${person} AND f.anchor = ${anchor}
    AND f.stage = CASE WHEN ${anchor} <= ?3 THEN 2 ELSE 1 END)
  AND (SELECT COUNT(*) FROM followups f WHERE f.channel = ${channel} AND f.person = ${person} AND f.state IN ('SENDING', 'SENT', 'UNKNOWN')
    AND f.created_at >= ?4) < ${F.perWeek}
  AND (${anchor} <= ?3 OR ${gentle} IS NULL OR ${gentle} < ?7)`;

// The claim (CONTRACT "Outbound sends"): the row goes in PENDING (one per person, last message and stage, and only under the weekly
// limit), then one caller moves it to SENDING. False: another run has it, or the limit is reached. It is never sent again.
export async function claimFollowUp(db: D1Database, channel: Channel, person: string, anchor: string, stage: 1 | 2, nowMs: number): Promise<boolean> {
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO followups (channel, person, anchor, stage, created_at) SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM followups WHERE channel = ?1 AND person = ?2 AND state IN ('SENDING', 'SENT', 'UNKNOWN') AND created_at >= ?6) < ?7`,
    )
    .bind(channel, person, anchor, stage, iso(nowMs), iso(nowMs - 7 * DAY), F.perWeek)
    .run();
  if (!ins.meta.changes) return false;
  const claim = await db
    .prepare("UPDATE followups SET state = 'SENDING', updated_at = ?5 WHERE channel = ?1 AND person = ?2 AND anchor = ?3 AND stage = ?4 AND state = 'PENDING'")
    .bind(channel, person, anchor, stage, iso(nowMs))
    .run();
  return claim.meta.changes > 0;
}

// SENT, FAILED (nothing went: an error answer, or they wrote again just now) or UNKNOWN (no answer in time: it may have gone).
export const settleFollowUp = (db: D1Database, channel: Channel, person: string, anchor: string, stage: 1 | 2, state: State, nowMs: number) =>
  db
    .prepare("UPDATE followups SET state = ?5, updated_at = ?6 WHERE channel = ?1 AND person = ?2 AND anchor = ?3 AND stage = ?4")
    .bind(channel, person, anchor, stage, state, iso(nowMs))
    .run();

export const namesIllness = (text: string | null) => !!text && hasPhrase(text, config.router.topics.medical);

// ---- WhatsApp ----
// A real message: anything the bot answers as a person talking (a greeting, "ok", a photo, a tap, a question), not a reaction, spam, an
// insult or a sexual message, a job seeker, a "stop", a safety message, nor anything in a handover to the team or from someone blocked.
const REAL: readonly Gate[] = ["GREETING", "MEDIA", "ACK_WORD", "MENU", "BOOKING_WORD", "CALL_REQUEST", "BUDGET_FALLBACK", "TO_CLASSIFIER", "TAP"];
export const realWhatsAppMessage = (decision: Gate, text: string | null) =>
  REAL.includes(decision) && !(text !== null && (classifyWithoutAI(text) !== "TO_CLASSIFIER" || isJobText(text)));

// src/whatsapp.ts, for each real message: its time, and whether it named an illness.
export async function noteWhatsAppMessage(db: D1Database, convId: number, at: string, text: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE person_state SET real_in_at = CASE WHEN real_in_at IS NULL OR real_in_at < ?2 THEN ?2 ELSE real_in_at END,
         gentle_at = CASE WHEN ?3 = 1 THEN ?2 ELSE gentle_at END WHERE conversation_id = ?1`,
    )
    .bind(convId, at, namesIllness(text) ? 1 : 0)
    .run();
}

// WhatsApp's words: the same as on Instagram and Messenger, with the bot's own [Book ₹99 call] button (menu_book, as on the menu); the
// gentle one says "just reply to this message" and has no button. Never to: a chat with a payment that went through (ever), a chat with
// the team (HUMAN) or blocked, "stop", a quiet period after strikes, an insult or sexual message (any offence), the crisis or emergency
// message in the last week or its item still open, the no-selling week, a slot held for them right now (the payment nudge is theirs).
export async function whatsappFollowUps(env: Env, nowMs = Date.now()): Promise<number> {
  if (atNight(nowMs) || !(await followUpsOn(env))) return 0;
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.locale, ps.real_in_at AS anchor, ps.gentle_at AS gentle FROM conversations c JOIN person_state ps ON ps.conversation_id = c.id
       WHERE ps.real_in_at >= ?1 AND ps.real_in_at <= ?2 AND c.mode = 'BOT' AND ps.opted_out_at IS NULL
         AND ps.abuse_offences = 0 AND ps.flirt_offences = 0
         AND (ps.quiet_until IS NULL OR ps.quiet_until <= ?5) AND (ps.no_sell_until IS NULL OR ps.no_sell_until <= ?5)
         AND NOT ${paidInSql("c.id")}
         AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.owner_id = c.id AND s.state = 'HELD' AND s.hold_until > ?5)
         AND NOT EXISTS (SELECT 1 FROM attention a WHERE a.target = 'conv:' || c.id AND a.resolved_at IS NULL AND a.kind IN ('HUMAN_REQUEST', 'CRISIS', 'EMERGENCY'))
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'OUT' AND m.created_at >= ?4
           AND (m.dedupe_key LIKE '%:crisis' OR m.dedupe_key LIKE '%:emergency'))
         AND ${pendingSql("'whatsapp'", "CAST(c.id AS TEXT)", "ps.real_in_at", "ps.gentle_at")}
       ORDER BY ps.real_in_at LIMIT ?6`,
    )
    .bind(...windowBinds(nowMs))
    .all<{ id: number; locale: string; anchor: string; gentle: string | null }>();
  let sent = 0;
  for (const r of results) {
    const due = dueFollowUp(r.anchor, r.gentle, nowMs);
    const person = String(r.id);
    if (!due || !(await claimFollowUp(env.DB, "whatsapp", person, r.anchor, due.stage, nowMs))) continue;
    // A message from them since the list was read starts the times again: this one is not sent.
    const still = await env.DB.prepare("SELECT 1 FROM person_state WHERE conversation_id = ?1 AND real_in_at = ?2").bind(r.id, r.anchor).first();
    let state: State = "FAILED";
    if (still) {
      const cp = copyFor(r.locale);
      const out: Out = due.gentle
        ? { type: "text", text: cp.autoFollowUpGentle }
        : { type: "buttons", body: due.stage === 1 ? cp.autoFollowUp1 : cp.autoFollowUp2, buttons: [{ id: "menu_book", title: cp.btnBook }] };
      // The one send path: it records the message and refuses outside the 24-hour window.
      const res = await sendMessage(env, r.id, out, `autofollow:${r.id}:${r.anchor}:${due.stage}`).catch(() => "UNKNOWN" as const);
      state = res === "SENT" ? "SENT" : res === "UNKNOWN" || res === "DUPLICATE" ? "UNKNOWN" : "FAILED";
    }
    await settleFollowUp(env.DB, "whatsapp", person, r.anchor, due.stage, state, nowMs);
    if (state !== "FAILED") sent++;
  }
  return sent;
}

// On the 2-minute cron: rows older than 30 days go (the weekly count needs 7).
export async function cleanFollowUps(env: Env, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM followups WHERE created_at < ?1").bind(iso(nowMs - 30 * DAY)).run();
}

// The 9pm digest: how many went in the last 24 hours, per channel.
export async function followUpLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const { results } = await env.DB
    .prepare("SELECT channel, COUNT(*) AS n FROM followups WHERE state IN ('SENT', 'UNKNOWN') AND created_at >= ?1 GROUP BY channel")
    .bind(iso(nowMs - DAY))
    .all<{ channel: Channel; n: number }>();
  const n = (ch: Channel) => results.find((r) => r.channel === ch)?.n ?? 0;
  if (!results.length) return ["- None sent."];
  return [`- Sent: WhatsApp ${n("whatsapp")}, Instagram ${n("instagram")}, Messenger ${n("messenger")}`];
}
