// Holidays (ticket 30): days off the owner or the practitioner marks on /amma, /admin or /app Calendar. On a holiday the bot offers
// no times and nothing new is held or booked (src/slots.ts isHoliday, used by availableSlots, holdSlot, moveSession and bookCredit).
// Bookings already on that day are never cancelled and nobody is messaged: the pages list them with a warning, and a Needs-you item
// (HOLIDAY_BOOKINGS) is raised. Storage: one settings row per day, `holiday:<YYYY-MM-DD>` (India day), value = the team's note (may be
// empty; never shown to customers). No migration. Holidays are for the whole business (one practitioner today).
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Env } from "./env";
import { raiseAttention } from "./send";
import { HOLIDAY_PREFIX, iso, istDay } from "./slots";

export type Holiday = { ymd: string; note: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const realDay = (v: string) => YMD.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && addDays(v, 0) === v;

// A date the form may mark: a real day, from today (India time) to config.holidays.maxDaysAhead days ahead.
export function holidayDate(raw: unknown, nowMs = Date.now()): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!realDay(v)) return null;
  const today = istDay(nowMs);
  return v >= today && v <= addDays(today, config.holidays.maxDaysAhead) ? v : null;
}
// A date the remove form may name: any real day (an old holiday can always be removed).
export const anyDate = (raw: unknown): string | null => (typeof raw === "string" && realDay(raw.trim()) ? raw.trim() : null);

// Upcoming holidays (today and later), in date order. `to` limits the range (inclusive).
export async function holidaysBetween(db: D1Database, from: string, to = "9999-12-31"): Promise<Holiday[]> {
  const { results } = await db
    .prepare("SELECT substr(key, ?3) AS ymd, value AS note FROM settings WHERE key >= ?1 AND key <= ?2 ORDER BY key")
    .bind(HOLIDAY_PREFIX + from, HOLIDAY_PREFIX + to, HOLIDAY_PREFIX.length + 1)
    .all<Holiday>();
  return results;
}
export const upcomingHolidays = (db: D1Database, nowMs = Date.now()) => holidaysBetween(db, istDay(nowMs));

// The bookings that still hold their time on a day: paid calls and confirmed sessions (the ones the team must move by hand).
export type DayBooking = { kind: "CALL" | "SESSION"; id: number; startUtc: string; convId: number; name: string | null; waId: string; service: string; practitionerId: number | null };
export async function bookingsOn(db: D1Database, ymd: string): Promise<DayBooking[]> {
  const from = iso(Date.parse(`${ymd}T00:00:00+05:30`));
  const to = iso(Date.parse(`${ymd}T00:00:00+05:30`) + DAY);
  const cols = "x.id, s.start_utc AS startUtc, c.id AS convId, c.display_name AS name, c.wa_id AS waId, x.service, COALESCE(x.practitioner_id, s.practitioner_id) AS practitionerId";
  const [calls, sessions] = await db.batch([
    db.prepare(`SELECT 'CALL' AS kind, ${cols} FROM intros x JOIN slots s ON s.id = x.slot_id JOIN conversations c ON c.id = x.conversation_id
      WHERE s.kind = 'CALL' AND x.state IN ('PAID','RESCHEDULED') AND s.start_utc >= ?1 AND s.start_utc < ?2`).bind(from, to),
    db.prepare(`SELECT 'SESSION' AS kind, ${cols} FROM sessions x JOIN slots s ON s.id = x.slot_id JOIN conversations c ON c.id = x.conversation_id
      WHERE s.kind = 'SESSION' AND x.state IN ('CONFIRMED','CREDIT_BOOKED') AND s.start_utc >= ?1 AND s.start_utc < ?2`).bind(from, to),
  ]);
  return [...(calls.results as DayBooking[]), ...(sessions.results as DayBooking[])].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

export const ATTENTION_KIND = "HOLIDAY_BOOKINGS";

// Marks the day (a second tap changes nothing). If calls or sessions are booked on it, one Needs-you item is raised.
// Returns whether the day was new, and the bookings on it. `audit` (the console's auditStmt) runs in the same batch, right after the
// change, so it is written only when the day was really added.
export async function addHoliday(env: Env, ymd: string, note: string, audit?: D1PreparedStatement): Promise<{ added: boolean; bookings: DayBooking[] }> {
  const [res] = await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO NOTHING").bind(HOLIDAY_PREFIX + ymd, note.trim().slice(0, 200), iso(Date.now())),
    ...(audit ? [audit] : []),
  ]);
  const bookings = await bookingsOn(env.DB, ymd);
  if (bookings.length) await raiseAttention(env.DB, ATTENTION_KIND, HOLIDAY_PREFIX + ymd);
  return { added: res.meta.changes > 0, bookings };
}

// Opens the day again; its Needs-you item (if any) is closed.
export async function removeHoliday(env: Env, ymd: string, audit?: D1PreparedStatement): Promise<boolean> {
  const [res] = await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(HOLIDAY_PREFIX + ymd), ...(audit ? [audit] : [])]);
  await env.DB
    .prepare("UPDATE attention SET resolved_at = ?2 WHERE kind = ?3 AND target = ?1 AND resolved_at IS NULL")
    .bind(HOLIDAY_PREFIX + ymd, iso(Date.now()), ATTENTION_KIND)
    .run();
  return res.meta.changes > 0;
}

// The date input's bounds: today and the last day that may be marked.
export const holidayBounds = (nowMs = Date.now()) => ({ min: istDay(nowMs), max: addDays(istDay(nowMs), config.holidays.maxDaysAhead) });
