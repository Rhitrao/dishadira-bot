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
    sessionsSuggested: await n("SELECT COUNT(*) AS n FROM sessions WHERE origin = 'AMMA' AND created_at >= ?1"),
    sessionPaid: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION' AND state IN ${PAID_LIKE} AND created_at >= ?1`),
    refunds: refunds.n,
    refundPaise: refunds.paise,
  };
}

export const scoreLines = (s: Scoreboard) => [
  `New chats: ${s.newChats}`,
  `${rupees(config.prices.intro)} paid: ${s.introPaid}`,
  `Calls done: ${s.callsDone}`,
  `Sessions suggested: ${s.sessionsSuggested}`,
  `${rupees(config.prices.single)} paid: ${s.sessionPaid}`,
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

// Counts for the last 24 hours, from the bot's own audit rows and the blocks table. Never any message text.
export async function noiseLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const since = iso(nowMs - 86_400_000);
  const actions = await env.DB.prepare("SELECT action, COUNT(*) AS n FROM audit_log WHERE actor = 'bot' AND at >= ?1 GROUP BY action").bind(since).all<{ action: string; n: number }>();
  const n = (action: string) => actions.results.find((a) => a.action === action)?.n ?? 0;
  const blocks = await env.DB.prepare("SELECT reason, COUNT(*) AS n FROM blocks WHERE created_at >= ?1 GROUP BY reason ORDER BY reason").bind(since).all<{ reason: string; n: number }>();
  return [
    `- Crisis messages: ${n("CRISIS")}`,
    `- Medical emergencies: ${n("EMERGENCY")}`,
    `- Blocks: ${blocks.results.length ? blocks.results.map((b) => `${b.reason} ${b.n}`).join(", ") : "none"}`,
    `- Quiet periods: ${n("QUIET")}`,
    `- Budget fallbacks: ${n("BUDGET_FALLBACK")}`,
    `- Opt-outs: ${n("OPT_OUT")}`,
  ];
}

// The assistant over the last 24 hours: answers it wrote, answers the output check replaced (by reason code), calls that failed (by code). Counts only.
export async function aiLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const rows = await env.DB
    .prepare("SELECT action, detail, COUNT(*) AS n FROM audit_log WHERE actor = 'bot' AND action IN ('AI_REPLY', 'AI_REJECTED', 'AI_FAILED') AND at >= ?1 GROUP BY action, detail ORDER BY action, detail")
    .bind(iso(nowMs - 86_400_000))
    .all<{ action: string; detail: string; n: number }>();
  const total = (a: string) => rows.results.filter((r) => r.action === a).reduce((s, r) => s + r.n, 0);
  const by = (a: string) => {
    const hit = rows.results.filter((r) => r.action === a);
    return hit.length ? hit.map((r) => `${r.detail} ${r.n}`).join(", ") : "none";
  };
  return [`- Answers written: ${total("AI_REPLY")}`, `- Replaced by the output check: ${total("AI_REJECTED")} (${by("AI_REJECTED")})`, `- Calls that failed: ${total("AI_FAILED")} (${by("AI_FAILED")})`];
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
    `- Packages sold: ${sold.results.length ? sold.results.map((r) => `${r.size}-pack ${r.n}`).join(", ") : "none"}`,
    `- Credits used today: ${used?.n ?? 0}`,
    `- Credits outstanding: ${left?.n ?? 0}`,
    `- Manual refunds pending: ${manual?.n ?? 0}`,
  ];
}

export async function digestText(env: Env, nowMs = Date.now()): Promise<string> {
  const attention = await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM attention WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind").all<{ kind: string; n: number }>();
  const tomorrow = istDay(nowMs + 86_400_000);
  const items = await bookingsBetween(env, ...dayRange(tomorrow));
  const off = (await switchStates(env)).filter((s) => (s.name === "AMMA_AWAY" ? s.on : !s.on)).map((s) => (s.name === "AMMA_AWAY" ? "AMMA_AWAY is ON (new bookings paused)" : `${s.name} is OFF${s.envOn ? "" : " (env flag)"}`));
  const leads = await warmLeads(env, nowMs);
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
    "Safety and noise (last 24 hours)",
    ...(await noiseLines(env, nowMs)),
    "",
    "Assistant (last 24 hours)",
    ...(await aiLines(env, nowMs)),
    "",
    "Sessions and packages",
    ...(await packageLines(env, nowMs)),
    "",
    "Warm leads (last 24 hours, not paid yet)",
    ...(leads.length ? leads.map((l) => `- ${firstName(l.name)} · ${env.PUBLIC_URL ?? ""}/admin/conv/${l.id}`) : ["- none"]),
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
