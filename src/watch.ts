// Cron helpers that raise attention items for Rohit: Amma away, Amma has not tapped an outcome, and the heartbeat.
import { config } from "./config";
import type { Env } from "./env";
import { iso, istDay } from "./slots";
import { HEARTBEAT_KEY } from "./mail";
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
       WHERE se.state = 'CONFIRMED' AND s.kind = 'SESSION' AND s.start_utc > ?3 AND s.start_utc >= ?1 AND s.start_utc < ?2`,
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
