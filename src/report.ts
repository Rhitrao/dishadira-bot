// Numbers and the 9pm summary email, in the console's words (no codes). Everything comes from the database.
import { prices, recipients } from "./business";
import { serviceName } from "./copy";
import { config } from "./config";
import type { Env } from "./env";
import { sendAlerts, sendEmailToEach } from "./mail";
import { formatIstParts, iso, istDay } from "./slots";
import { switchStates } from "./switches";
import { consoleLink } from "./switchover";

const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
const rupees = (paise: number) => `₹${paise / 100}`;

export type Scoreboard = { newChats: number; introPaid: number; callsDone: number; sessionsSuggested: number; sessionPaid: number; refunds: number; refundPaise: number };

export async function scoreboard(env: Env, nowMs = Date.now()): Promise<Scoreboard> {
  const since = iso(nowMs - 7 * 86_400_000);
  const n = async (sql: string) => (await env.DB.prepare(sql).bind(since).first<{ n: number }>())!.n;
  const refunds = (await env.DB
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(p.paid_paise, p.amount_paise)), 0) AS paise FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.state = 'REFUNDED' AND r.created_at >= ?1")
    .bind(since)
    .first<{ n: number; paise: number }>())!;
  return {
    newChats: await n("SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?1"),
    introPaid: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose = 'INTRO' AND state IN ${PAID_LIKE} AND created_at >= ?1`),
    callsDone: await n("SELECT COUNT(*) AS n FROM intros WHERE state IN ('CALLED_SESSION','CALLED_NOT_FIT','RUDE') AND updated_at >= ?1"),
    sessionsSuggested: await n("SELECT COUNT(*) AS n FROM sessions WHERE origin = 'AMMA' AND created_at >= ?1"),
    sessionPaid: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION' AND state IN ${PAID_LIKE} AND created_at >= ?1`),
    refunds: refunds.n,
    refundPaise: refunds.paise,
  };
}

export const scoreLines = (s: Scoreboard) => [
  `New chats: ${s.newChats}`,
  `${rupees(prices().intro)} calls paid: ${s.introPaid}`,
  `Calls done: ${s.callsDone}`,
  `Sessions offered after a call: ${s.sessionsSuggested}`,
  `${rupees(prices().single)} sessions paid: ${s.sessionPaid}`,
  `Refunds: ${s.refunds} (${rupees(s.refundPaise)})`,
];

export type DayItem = { startUtc: string; name: string | null; service: string; kind: "CALL" | "SESSION"; id: number; state: string; convId: number };

// All calls and sessions with a slot between two instants (any status; "Today and tomorrow" and the digest both use this).
export async function bookingsBetween(env: Env, fromUtc: string, toUtc: string): Promise<DayItem[]> {
  const calls = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, i.service, i.id, i.state, c.id AS convId FROM intros i JOIN slots s ON s.id = i.slot_id
       JOIN conversations c ON c.id = i.conversation_id
       WHERE s.kind = 'CALL' AND i.state IN ('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE','CANCELLED_BY_US') AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<DayItem, "kind">>();
  const sessions = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, se.service, se.id, se.state, c.id AS convId FROM sessions se JOIN slots s ON s.id = se.slot_id
       JOIN conversations c ON c.id = se.conversation_id
       WHERE s.kind = 'SESSION' AND se.state IN ('CONFIRMED','CREDIT_BOOKED','COMPLETED','NO_SHOW','CANCELLED','NOT_FIT') AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<DayItem, "kind">>();
  return [...calls.results.map((r) => ({ ...r, kind: "CALL" as const })), ...sessions.results.map((r) => ({ ...r, kind: "SESSION" as const }))].sort((a, b) =>
    a.startUtc.localeCompare(b.startUtc),
  );
}

export const dayRange = (ymd: string, days = 1) => [iso(Date.parse(`${ymd}T00:00:00+05:30`)), iso(Date.parse(`${ymd}T00:00:00+05:30`) + days * 86_400_000)] as const;
export const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || "(no name)";

// Why a number was blocked, in the console's words.
const BLOCK_WORDS: Record<string, string> = {
  NOISE_SEXUAL: "sexual messages", NOISE_ABUSE: "abuse", NOISE_REPEAT: "nuisance messages again after a pause", RUDE: "a rude call", ADMIN: "by the team",
};

// Counts for the last 24 hours, from the bot's own audit rows and the blocks table. Never any message text.
export async function noiseLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const since = iso(nowMs - 86_400_000);
  const actions = await env.DB.prepare("SELECT action, COUNT(*) AS n FROM audit_log WHERE actor = 'bot' AND at >= ?1 GROUP BY action").bind(since).all<{ action: string; n: number }>();
  const n = (action: string) => actions.results.find((a) => a.action === action)?.n ?? 0;
  const blocks = await env.DB.prepare("SELECT reason, COUNT(*) AS n FROM blocks WHERE created_at >= ?1 GROUP BY reason ORDER BY reason").bind(since).all<{ reason: string; n: number }>();
  return [
    `- Crisis messages: ${n("CRISIS")}`,
    `- Medical emergencies: ${n("EMERGENCY")}`,
    `- Numbers blocked: ${blocks.results.length ? blocks.results.map((b) => `${BLOCK_WORDS[b.reason] ?? "other"} ${b.n}`).join(", ") : "none"}`,
    `- Paused for a week after nuisance messages: ${n("QUIET")}`,
    `- Reached the assistant's daily limit: ${n("BUDGET_FALLBACK")}`,
    `- Asked to stop messages: ${n("OPT_OUT")}`,
  ];
}

// Why the output check replaced an answer, in the console's words.
const REJECT_WORDS: Record<string, string> = {
  TOO_LONG: "too long", SCRIPT: "unexpected characters", META: "talked about itself", LINK: "had a link", EMAIL: "had an email address",
  PHONE: "had a phone number", BANNED_WORD: "a word we never use", NUMBER: "a number we don't quote",
};

// The assistant over the last 24 hours: answers it wrote, answers the output check replaced (and why), times it couldn't answer. Counts only.
export async function aiLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const rows = await env.DB
    .prepare("SELECT action, detail, COUNT(*) AS n FROM audit_log WHERE actor = 'bot' AND action IN ('AI_REPLY', 'AI_REJECTED', 'AI_FAILED') AND at >= ?1 GROUP BY action, detail ORDER BY action, detail")
    .bind(iso(nowMs - 86_400_000))
    .all<{ action: string; detail: string; n: number }>();
  const total = (a: string) => rows.results.filter((r) => r.action === a).reduce((s, r) => s + r.n, 0);
  const why = rows.results.filter((r) => r.action === "AI_REJECTED").map((r) => `${REJECT_WORDS[r.detail] ?? "other"} ${r.n}`);
  return [
    `- Answers written: ${total("AI_REPLY")}`,
    `- Answers replaced by a fixed reply: ${total("AI_REJECTED")}${why.length ? ` (${why.join(", ")})` : ""}`,
    `- Times it couldn't answer: ${total("AI_FAILED")}`,
  ];
}

// People who showed interest in the last 24 hours (an expired hold, or a tap on Book) and have never paid. First name and a link only, so Rohit
// can follow up inside the 24-hour window. Nobody who is blocked, opted out, or in the week after a crisis message.
export async function warmLeads(env: Env, nowMs = Date.now()): Promise<{ id: number; name: string | null }[]> {
  const paid = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.display_name AS name FROM conversations c JOIN person_state ps ON ps.conversation_id = c.id
       WHERE c.mode != 'BLOCKED' AND ps.opted_out_at IS NULL AND (ps.no_sell_until IS NULL OR ps.no_sell_until <= ?1)
         AND (ps.book_tap_at >= ?2
           OR EXISTS (SELECT 1 FROM intros i JOIN slots s ON s.id = i.slot_id WHERE i.conversation_id = c.id AND i.created_at >= ?2 AND (i.state = 'EXPIRED' OR (i.state = 'HELD' AND s.hold_until < ?1)))
           OR EXISTS (SELECT 1 FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.conversation_id = c.id AND se.created_at >= ?2 AND (se.state = 'EXPIRED' OR (se.state = 'HELD' AND s.hold_until < ?1)))
           OR EXISTS (SELECT 1 FROM packages k WHERE k.conversation_id = c.id AND k.created_at >= ?2 AND (k.state = 'EXPIRED' OR (k.state = 'PENDING' AND k.created_at < ?3))))
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.state IN ${paid} AND (
           (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = c.id))
           OR (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = c.id))
           OR (p.purpose = 'PACKAGE' AND p.target_id IN (SELECT id FROM packages WHERE conversation_id = c.id))))
       ORDER BY c.id LIMIT 20`,
    )
    .bind(iso(nowMs), iso(nowMs - 86_400_000), iso(nowMs - config.sessionRules.packageLinkMinutes * 60_000))
    .all<{ id: number; name: string | null }>();
  return results;
}

// Packages and credits. Counts only: packages sold in the last 24 hours by size, credits used today (India day), every credit still unused,
// and refunds for old payments that Rohit has to pay by hand.
export async function packageLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const sold = await env.DB
    .prepare("SELECT size, COUNT(*) AS n FROM credits c JOIN packages k ON k.id = c.package_id WHERE c.reason = 'PURCHASE' AND c.at >= ?1 GROUP BY size ORDER BY size")
    .bind(iso(nowMs - 86_400_000))
    .all<{ size: number; n: number }>();
  const dayStart = iso(Date.parse(`${istDay(nowMs)}T00:00:00+05:30`));
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM credits WHERE reason = 'BOOK' AND at >= ?1").bind(dayStart).first<{ n: number }>();
  const left = await env.DB.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM credits").first<{ n: number }>();
  const manual = await env.DB.prepare("SELECT COUNT(*) AS n FROM attention WHERE kind = 'MANUAL_REFUND' AND resolved_at IS NULL").first<{ n: number }>();
  return [
    `- Packages sold: ${sold.results.length ? sold.results.map((r) => `${r.size} sessions ${r.n}`).join(", ") : "none"}`,
    `- Package sessions booked today: ${used?.n ?? 0}`,
    `- Package sessions still owed: ${left?.n ?? 0}`,
    `- Refunds to pay by hand: ${manual?.n ?? 0}`,
  ];
}

// What each kind of open item means, in the console's words (no codes, no names). Kinds not listed count as "Other things to look at".
const NEEDS_WORDS: Record<string, string> = {
  HOLIDAY_BOOKINGS: "Bookings on a day marked as a holiday",
  CRISIS: "Crisis messages to follow up", EMERGENCY: "Possible medical emergencies to check", HUMAN_REQUEST: "Asked for a person",
  FREE_TEXT: "Wrote something the bot couldn't answer", MEDIA_FROM_CUSTOMER: "Sent a photo, voice note or file",
  OUTSIDE_WINDOW: "Couldn't be messaged after WhatsApp's 24 hours", TEMPLATE_UNAPPROVED: "A WhatsApp follow-up message isn't approved yet",
  RUDE_REFUND_APPROVAL: "Refunds waiting for your decision", LATE_PAYMENT_NO_SLOT: "Paid after their held time ran out",
  PAYMENT_MISMATCH: "Paid a different amount", PARTIAL_PAYMENT: "Paid only part", UNSUPPORTED_PAYMENT: "Paid for something we don't sell",
  DUPLICATE_PAYMENT: "Paid twice", REFUND_FAILED: "Refunds that didn't go through", REFUND_STUCK: "Refunds not confirmed yet",
  UNKNOWN_REFUND: "Refunds Razorpay reported that we can't match", UNKNOWN_PAYMENT_LINK: "Payments for a link we don't know",
  OUTCOME_FAILED: "Call outcomes that didn't apply", OUTCOME_STALE: "Call outcomes that didn't apply",
  NOT_FIT_REFUND_REFUSED: "Not-a-fit refunds held back by the daily limit", NOT_FIT_NO_PAYMENT: "Not a fit, but no payment found",
  AMMA_NO_TAP: "Calls with no outcome marked", AMMA_AWAY_CALL: "Calls to move while the practitioner is away", AMMA_AWAY_SESSION: "Sessions to move while the practitioner is away",
  MANUAL_REFUND: "Refunds to pay by hand", CANCEL_REFUND_FAILED: "Cancelled sessions whose refund didn't start", CANCEL_NO_PAYMENT: "Cancelled sessions with no payment found",
  PAID_NO_PACKAGE: "Paid, but the booking can't be found", PAID_NO_INTRO: "Paid, but the booking can't be found", PAID_NO_SESSION: "Paid, but the booking can't be found",
  PAID_PACKAGE_NOT_BOOKABLE: "Paid for a booking that's closed", PAID_INTRO_NOT_BOOKABLE: "Paid for a booking that's closed", PAID_SESSION_NOT_BOOKABLE: "Paid for a booking that's closed",
  LINK_CREATE_FAILED: "Payment links that couldn't be made", SESSION_NOT_OFFERABLE: "Sessions that couldn't be offered", NO_SESSION_SLOTS: "No free session times to offer",
  THREAT: "Threatening messages to read", NO_FREE_TIMES: "Wanted to book but found no free times", NO_PHONE: "Wrote from a username without a phone number",
  REFUND_NOT_STARTED: "Refunds Razorpay hasn't taken yet",
};

// The switches that are off, in the words of Settings.
const SWITCH_OFF_WORDS: Record<string, string> = {
  NEW_BOOKINGS: "Bookings are paused: nobody can book.",
  AMMA_AWAY: "The practitioner is marked away: bookings are paused.",
  SENDS: "Messages to customers are paused (safety messages still go).",
  AI_REPLIES: "The assistant is paused: typed questions get a fixed reply.",
};

export async function digestText(env: Env, nowMs = Date.now()): Promise<string> {
  const attention = await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM attention WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind").all<{ kind: string; n: number }>();
  const needs = new Map<string, number>();
  for (const a of attention.results) {
    const w = NEEDS_WORDS[a.kind] ?? "Other things to look at";
    needs.set(w, (needs.get(w) ?? 0) + a.n);
  }
  const tomorrowMs = nowMs + 86_400_000;
  const items = await bookingsBetween(env, ...dayRange(istDay(tomorrowMs)));
  const off = (await switchStates(env))
    .filter((s) => (s.name === "AMMA_AWAY" ? s.on : !s.on))
    .map((s) => `${SWITCH_OFF_WORDS[s.name]}${s.name !== "AMMA_AWAY" && !s.envOn ? " It's off for this copy of the bot; only a deploy turns it on." : ""}`);
  const leads = await warmLeads(env, nowMs);
  const total = attention.results.reduce((t, a) => t + a.n, 0);
  const lines = [
    `Needs you (${total})`,
    ...(needs.size ? [...needs].map(([w, n]) => `- ${w}: ${n}`) : ["- Nothing needs you."]),
    "",
    `Tomorrow, ${formatIstParts(iso(tomorrowMs)).day}`,
    ...(items.length ? items.map((i) => `- ${formatIstParts(i.startUtc).time} · ${i.kind === "CALL" ? "Call" : "Session"} · ${firstName(i.name)} · ${serviceName(i.service, "en")}`) : ["- Nothing booked."]),
    "",
    "Last 7 days",
    ...scoreLines(await scoreboard(env, nowMs)).map((l) => `- ${l}`),
    "",
    "Safety (last 24 hours)",
    ...(await noiseLines(env, nowMs)),
    "",
    "Assistant (last 24 hours)",
    ...(await aiLines(env, nowMs)),
    "",
    "Packages",
    ...(await packageLines(env, nowMs)),
    "",
    "Worth a follow-up (last 24 hours, not paid yet)",
    ...(leads.length ? leads.map((l) => `- ${firstName(l.name)} · ${consoleLink(env, `/admin/conv/${l.id}`)}`) : ["- Nobody."]),
    "",
    "What's switched off",
    ...(off.length ? off.map((o) => `- ${o}`) : ["- Nothing: the bot is taking bookings and answering."]),
  ];
  return lines.join("\n");
}

// The business's name for the subject line (Settings → Business); empty before the console has run.
async function businessName(env: Env): Promise<string> {
  try {
    return (await env.DB.prepare("SELECT name FROM workspaces WHERE id = 1").first<{ name: string }>())?.name ?? "";
  } catch {
    return "";
  }
}

// 9pm IST cron: the summary to the members chosen in Settings (the owner by default), then any alert that is due (including a missing heartbeat).
export async function runDigest(env: Env, nowMs = Date.now()): Promise<void> {
  const name = await businessName(env);
  await sendEmailToEach(env, await recipients(env, "digest"), `Daily summary${name ? `: ${name}` : ""}`, await digestText(env, nowMs));
  await sendAlerts(env, nowMs, { heartbeat: true });
}
