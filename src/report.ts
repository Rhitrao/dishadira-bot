// Numbers and the 9pm digest. Everything comes from the database.
import { config } from "./config";
import type { Env } from "./env";
import { sendAlerts, sendEmail } from "./mail";
import { formatIstParts, iso, istDay } from "./slots";
import { switchStates } from "./switches";

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
    sessionsSuggested: await n("SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?1"),
    sessionPaid: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION' AND state IN ${PAID_LIKE} AND created_at >= ?1`),
    refunds: refunds.n,
    refundPaise: refunds.paise,
  };
}

export const scoreLines = (s: Scoreboard) => [
  `New chats: ${s.newChats}`,
  `${rupees(config.prices.introPaise)} paid: ${s.introPaid}`,
  `Calls done: ${s.callsDone}`,
  `Sessions suggested: ${s.sessionsSuggested}`,
  `${rupees(config.prices.sessionPaise)} paid: ${s.sessionPaid}`,
  `Refunds: ${s.refunds} (${rupees(s.refundPaise)})`,
];

export type DayItem = { startUtc: string; name: string | null; service: string; kind: "CALL" | "SESSION"; id: number; state: string };

// All calls and sessions with a slot between two instants (any status; "Today and tomorrow" and the digest both use this).
export async function bookingsBetween(env: Env, fromUtc: string, toUtc: string): Promise<DayItem[]> {
  const calls = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, i.service, i.id, i.state FROM intros i JOIN slots s ON s.id = i.slot_id
       JOIN conversations c ON c.id = i.conversation_id
       WHERE s.kind = 'CALL' AND i.state IN ('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE','CANCELLED_BY_US') AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<DayItem, "kind">>();
  const sessions = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, se.service, se.id, se.state FROM sessions se JOIN slots s ON s.id = se.slot_id
       JOIN conversations c ON c.id = se.conversation_id
       WHERE s.kind = 'SESSION' AND se.state IN ('CONFIRMED','COMPLETED','NO_SHOW','CANCELLED') AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<DayItem, "kind">>();
  return [...calls.results.map((r) => ({ ...r, kind: "CALL" as const })), ...sessions.results.map((r) => ({ ...r, kind: "SESSION" as const }))].sort((a, b) =>
    a.startUtc.localeCompare(b.startUtc),
  );
}

export const dayRange = (ymd: string, days = 1) => [iso(Date.parse(`${ymd}T00:00:00+05:30`)), iso(Date.parse(`${ymd}T00:00:00+05:30`) + days * 86_400_000)] as const;
export const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || "(no name)";

export async function digestText(env: Env, nowMs = Date.now()): Promise<string> {
  const attention = await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM attention WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind").all<{ kind: string; n: number }>();
  const tomorrow = istDay(nowMs + 86_400_000);
  const items = await bookingsBetween(env, ...dayRange(tomorrow));
  const off = (await switchStates(env)).filter((s) => (s.name === "AMMA_AWAY" ? s.on : !s.on)).map((s) => (s.name === "AMMA_AWAY" ? "AMMA_AWAY is ON (new bookings paused)" : `${s.name} is OFF${s.envOn ? "" : " (env flag)"}`));
  const lines = [
    "Open attention items",
    ...(attention.results.length ? attention.results.map((a) => `- ${a.kind}: ${a.n}`) : ["- none"]),
    "",
    `Tomorrow (${tomorrow})`,
    ...(items.length ? items.map((i) => `- ${formatIstParts(i.startUtc).time} ${i.kind === "CALL" ? "call" : "session"} · ${firstName(i.name)} · ${i.service}`) : ["- nothing booked"]),
    "",
    "Last 7 days",
    ...scoreLines(await scoreboard(env, nowMs)).map((l) => `- ${l}`),
    "",
    "Switches that are off",
    ...(off.length ? off.map((o) => `- ${o}`) : ["- none"]),
  ];
  return lines.join("\n");
}

// 9pm IST cron: the digest, then any alert that is due (including a missing heartbeat).
export async function runDigest(env: Env, nowMs = Date.now()): Promise<void> {
  await sendEmail(env, "Disha Dira daily digest", await digestText(env, nowMs));
  await sendAlerts(env, nowMs, { heartbeat: true });
}
