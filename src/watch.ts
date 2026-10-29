// Cron helpers that raise attention items for Rohit: Amma away, Amma has not tapped an outcome, and the heartbeat.
import { config } from "./config";
import type { Env } from "./env";
import { iso, istDay } from "./slots";
import { copyFor } from "./copy";
import { HEARTBEAT_KEY, sendEmail } from "./mail";
import { menuOut } from "./menu";
import { noSellActive } from "./noise";
import { sendMessage } from "./send";
import { consoleLink } from "./switchover";
import { setSetting, switchStates } from "./switches";

const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));
const DAY = 86_400_000;

// Raised once per kind + target, ever: resolving an item must not bring it back on the next cron run.
async function raiseOnce(env: Env, kind: string, target: string): Promise<void> {
  await env.DB
    .prepare("INSERT INTO attention (kind, target) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM attention WHERE kind = ?1 AND target = ?2)")
    .bind(kind, target)
    .run();
}

export const recordHeartbeat = (env: Env, nowMs = Date.now()) => setSetting(env.DB, HEARTBEAT_KEY, iso(nowMs));

// While Amma is away: one item per call or session still ahead today and tomorrow, so Rohit can offer a new time or a refund.
export async function raiseAwayItems(env: Env, nowMs = Date.now()): Promise<number> {
  if (!(await switchStates(env)).find((s) => s.name === "AMMA_AWAY")!.on) return 0;
  const from = dayStartUtc(istDay(nowMs));
  const to = dayStartUtc(istDay(nowMs + 2 * DAY));
  const now = iso(nowMs);
  const calls = await env.DB
    .prepare(
      `SELECT i.id FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.state IN ('PAID','RESCHEDULED') AND s.kind = 'CALL' AND s.start_utc > ?3 AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(from, to, now)
    .all<{ id: number }>();
  const sessions = await env.DB
    .prepare(
      `SELECT se.id FROM sessions se JOIN slots s ON s.id = se.slot_id
       WHERE se.state IN ('CONFIRMED','CREDIT_BOOKED') AND s.kind = 'SESSION' AND s.start_utc > ?3 AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(from, to, now)
    .all<{ id: number }>();
  for (const r of calls.results) await raiseOnce(env, "AMMA_AWAY_CALL", `intro:${r.id}`);
  for (const r of sessions.results) await raiseOnce(env, "AMMA_AWAY_SESSION", `session:${r.id}`);
  return calls.results.length + sessions.results.length;
}

// A call that started more than ammaTapReminderHours ago (within the last week) with no outcome tapped.
export async function raiseTapReminders(env: Env, nowMs = Date.now()): Promise<number> {
  const { results } = await env.DB
    .prepare(
      `SELECT i.id FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.state IN ('PAID','RESCHEDULED') AND s.kind = 'CALL' AND s.start_utc <= ?1 AND s.start_utc >= ?2
         AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.intro_id = i.id AND o.slot_id = i.slot_id)`,
    )
    .bind(iso(nowMs - config.limits.ammaTapReminderHours * 3_600_000), iso(nowMs - 7 * DAY))
    .all<{ id: number }>();
  for (const r of results) await raiseOnce(env, "AMMA_NO_TAP", `intro:${r.id}`);
  return results.length;
}

// A chat in HUMAN mode goes back to the bot config.handoff.autoReturnHours after the handoff, unless Rohit has sent a reply from /admin since. The
// attention item stays open. Ticket 31 (I14): the customer is told once, honestly ("Sorry we couldn't reply in time…" with the menu): now if
// the 24-hour window is still open, otherwise on their next message (a settings row handback:<conv>). The owner gets one email. Not during
// the no-selling week after a crisis message (the notice offers booking; the crisis item and email already went to the owner).
export const HANDBACK_KEY = (convId: number) => `handback:${convId}`;
export async function returnStaleHumans(env: Env, nowMs = Date.now()): Promise<number> {
  const { results } = await env.DB
    .prepare(
      `UPDATE conversations SET mode = 'BOT', human_since = NULL
       WHERE mode = 'HUMAN' AND human_since IS NOT NULL AND human_since <= ?1
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.direction = 'OUT'
                           AND m.dedupe_key LIKE 'admin-reply:%' AND m.created_at >= conversations.human_since)
       RETURNING id, locale, last_user_at AS lastUserAt`,
    )
    .bind(iso(nowMs - config.handoff.autoReturnHours * 3_600_000))
    .all<{ id: number; locale: string; lastUserAt: string | null }>();
  for (const r of results) {
    if (await noSellActive(env.DB, r.id, nowMs)) continue;
    await sendEmail(env, "A chat went back to the bot", `A customer asked for a person ${config.handoff.autoReturnHours} hours ago and had no reply, so the chat is back with the bot and they have been told. Open ${consoleLink(env, `/admin/conv/${r.id}`, `/app/inbox/${r.id}`)}`).catch(() => undefined);
    const inWindow = r.lastUserAt !== null && nowMs - Date.parse(r.lastUserAt) < config.windowHours * 3_600_000;
    if (inWindow) await sendMessage(env, r.id, menuOut(copyFor(r.locale), false, copyFor(r.locale).handbackNotice, true), `handback:${r.id}:${iso(nowMs)}`);
    else await setSetting(env.DB, HANDBACK_KEY(r.id), iso(nowMs));
  }
  return results.length;
}

// The notice owed from returnStaleHumans(), taken once: true if this person is still to be told.
export async function takeHandback(env: Env, convId: number): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(HANDBACK_KEY(convId)).run();
  return res.meta.changes > 0;
}
