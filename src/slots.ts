import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { countsAsSession, defaultService, serviceOf, slotKindOf, SLOT_SERVICE_SQL, type Service } from "./catalogue";
import { dayLabel, timeLabel, type Lang } from "./copy";

export type SlotKind = "CALL" | "SESSION";
export type Slot = { kind: SlotKind; startUtc: string; endUtc: string };

// India has no daylight saving, so IST is a fixed +05:30 offset from UTC.
const IST_OFFSET_MINUTES = 330;

export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

// Whose calendar a new call or session is on (practitioner_id on slots, intros and sessions; migration 0010). Phase 1 has one
// practitioner: the active one who already has the most slots (so an owner who hands over and stays on as Practitioner, ticket 26,
// doesn't take over the calendar), then the first by id; NULL before the console's one-time seed (which then fills the NULLs).
export const PRACTITIONER_SQL =
  "(SELECT pm.id FROM members pm WHERE pm.workspace_id = 1 AND pm.role = 'PRACTITIONER' AND pm.status = 'active' ORDER BY (SELECT COUNT(*) FROM slots ps WHERE ps.practitioner_id = pm.id) DESC, pm.id LIMIT 1)";
const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

// The service a slot of `kind` is for: `key` from the catalogue (src/catalogue.ts), or the first call / single session when no key is given.
// undefined for an unknown key, or one whose pathway makes the other kind of slot.
export function slotService(kind: SlotKind, key?: string | null): Service | undefined {
  const svc = key ? serviceOf(key) : defaultService(kind);
  return svc && slotKindOf(svc) === kind ? svc : undefined;
}

// All slots for one IST calendar day ("YYYY-MM-DD"), each as long as its service (15, 30, 60 or 90 minutes; ticket 48), back to back from
// opening. Empty on days Amma doesn't work. A session (countsAsSession) day lists at most config.slots.maxSessionsPerDay, as before.
export function generateSlots(ymd: string, kind: SlotKind, key?: string | null): Slot[] {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dayMs = Date.UTC(y, mo - 1, d);
  if (!(config.hours.days as readonly number[]).includes(new Date(dayMs).getUTCDay())) return [];
  const svc = slotService(kind, key);
  if (!svc) return [];

  const length = svc.minutes;
  const open = hhmm(config.hours.start);
  const close = hhmm(config.hours.end);
  const slots: Slot[] = [];
  for (let t = open; t + length <= close; t += length) {
    if (countsAsSession(svc) && slots.length >= config.slots.maxSessionsPerDay) break;
    const start = dayMs + (t - IST_OFFSET_MINUTES) * 60_000;
    slots.push({ kind, startUtc: iso(start), endUtc: iso(start + length * 60_000) });
  }
  return slots;
}

// IST calendar day ("YYYY-MM-DD") that contains a UTC instant.
export const istDay = (ms: number) => new Date(ms + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// IST wording for customers: { day: "Mon 6 Oct", time: "2:30pm" }.
export function formatIstParts(utc: string): { day: string; time: string } {
  const d = new Date(Date.parse(utc) + IST_OFFSET_MINUTES * 60_000);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    day: `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`,
    time: `${h % 12 || 12}:${mm}${h < 12 ? "am" : "pm"}`,
  };
}

// What a customer sees, in their language: { day: "Wed, 21 Oct", time: "2:30 pm" } / { day: "बुध, 21 अक्टूबर", time: "दोपहर 2:30" }.
export function formatIstLang(utc: string, lang: Lang): { day: string; time: string } {
  const d = new Date(Date.parse(utc) + IST_OFFSET_MINUTES * 60_000);
  return {
    day: dayLabel(lang, d.getUTCDay(), d.getUTCDate(), d.getUTCMonth()),
    time: timeLabel(lang, d.getUTCHours(), d.getUTCMinutes()),
  };
}

// The same day label from an IST calendar day ("YYYY-MM-DD").
export function dayLabelFor(ymd: string, lang: Lang): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return dayLabel(lang, new Date(Date.UTC(y, m - 1, d)).getUTCDay(), d, m - 1);
}

// IST minutes since midnight of a UTC instant.
export const istMinutes = (utc: string) => ((Date.parse(utc) + IST_OFFSET_MINUTES * 60_000) % 86_400_000) / 60_000;

// The spread rule for the time list: one time per half hour, :00 and :30 first; when that one is taken, the next free
// quarter (:15 or :45) stands in for it. Time order, and only the first `max` (the latest are dropped).
export function spreadTimes(free: Slot[], max: number): Slot[] {
  const byHalfHour = new Map<number, Slot>();
  for (const s of [...free].sort((a, b) => a.startUtc.localeCompare(b.startUtc))) {
    const half = Math.floor(istMinutes(s.startUtc) / 30);
    if (!byHalfHour.has(half)) byHalfHour.set(half, s); // earliest in the half hour: :00 / :30 beats :15 / :45
  }
  return [...byHalfHour.values()].slice(0, max);
}

// The next `count` working days (IST "YYYY-MM-DD"), starting with today. Holidays are still in the list: availableSlots() and
// holdSlot() skip them (they need the database).
export function nextWorkingDays(nowMs: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 7 * count + 7; i++) {
    const ymd = istDay(nowMs + i * 86_400_000);
    if (generateSlots(ymd, "CALL").length) out.push(ymd);
  }
  return out;
}

// Holidays (ticket 30): one settings row per day off, `holiday:<YYYY-MM-DD>` (IST), value = the owner's note (may be empty).
// Marked and removed in src/holidays.ts; a holiday has no free times and takes no new hold. Bookings already on it stay.
export const HOLIDAY_PREFIX = "holiday:";
export async function isHoliday(db: D1Database, ymd: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM settings WHERE key = ?1").bind(HOLIDAY_PREFIX + ymd).first()) !== null;
}

// Time off for part of a day (ticket 55): one settings row per block, `timeoff:<YYYY-MM-DD>:<HHMM>-<HHMM>` (IST), value = the team's note.
// Marked and removed in src/timeoff.ts. A time that overlaps a block is never offered, held or booked; bookings already there stay.
export const TIMEOFF_PREFIX = "timeoff:";
export type TimeOffBlock = { key: string; ymd: string; startMin: number; endMin: number; note: string };
export const parseTimeOffKey = (key: string): Omit<TimeOffBlock, "note" | "key"> | null => {
  const m = /^timeoff:(\d{4}-\d{2}-\d{2}):(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(key);
  return m ? { ymd: m[1], startMin: Number(m[2]) * 60 + Number(m[3]), endMin: Number(m[4]) * 60 + Number(m[5]) } : null;
};
export async function timeOffOnDay(db: D1Database, ymd: string): Promise<TimeOffBlock[]> {
  const { results } = await db.prepare("SELECT key, value AS note FROM settings WHERE key >= ?1 AND key < ?2 ORDER BY key").bind(`${TIMEOFF_PREFIX}${ymd}:`, `${TIMEOFF_PREFIX}${ymd};`).all<{ key: string; note: string }>();
  return results.flatMap((r) => {
    const k = parseTimeOffKey(r.key);
    return k ? [{ key: r.key, note: r.note, ...k }] : [];
  });
}
// Whether the slot from startUtc to endUtc overlaps a block of time off on its day.
export const overlapsTimeOff = (blocks: readonly TimeOffBlock[], ymd: string, startUtc: string, endUtc: string): boolean => {
  const base = Date.parse(`${ymd}T00:00:00+05:30`);
  const a = (Date.parse(startUtc) - base) / 60_000;
  const b = (Date.parse(endUtc) - base) / 60_000;
  return blocks.some((t) => a < t.endMin && b > t.startMin);
};
export async function isTimeOff(db: D1Database, startUtc: string, endUtc: string): Promise<boolean> {
  const ymd = istDay(Date.parse(startUtc));
  return overlapsTimeOff(await timeOffOnDay(db, ymd), ymd, startUtc, endUtc);
}

// A slot is active (blocks the calendar) when booked, or held and not yet expired.
const ACTIVE = "(state = 'BOOKED' OR hold_until > :now)";

// The per-person limit counts only unexpired HELD rows: a BOOKED call must not stop a later session hold.
const HELD = "(state = 'HELD' AND hold_until > :now)";

export type HoldResult = { ok: true; holdUntil: string } | { ok: false; reason: "NOT_A_SLOT" | "ALREADY_HOLDING" | "UNAVAILABLE" | "TOO_SOON" };

// Amma has one calendar: a CALL and a SESSION must never overlap, so the single statement below
// refuses a slot if ANY active slot overlaps it (either kind) or if this person already has an
// unexpired hold. INSERT ... WHERE NOT EXISTS is one atomic write, so concurrent callers get one winner.
// An expired row on the same (kind, start) is taken over by ON CONFLICT; an active one never is,
// so a replay by the same person can never extend a hold (it is refused as ALREADY_HOLDING).
// Ticket 48: `service` (a catalogue key; default the first call or the single session) sets the length, is written on the slot, and brings
// the day caps (capSql) into the same atomic write.
export async function holdSlot(
  db: D1Database,
  args: { kind: SlotKind; startUtc: string; ownerId: number; nowMs: number; service?: string },
): Promise<HoldResult> {
  const { kind, startUtc, ownerId, nowMs } = args;
  const svc = slotService(kind, args.service);
  const slot = svc && generateSlots(istDay(Date.parse(startUtc)), kind, svc.key).find((s) => s.startUtc === startUtc);
  if (!svc || !slot) return { ok: false, reason: "NOT_A_SLOT" };
  // A time that has passed, or starts inside the booking lead (an old list row tapped later), is never held (ticket 31, B1).
  if (slot.startUtc <= iso(nowMs + config.booking.leadMinutes * 60_000)) return { ok: false, reason: "TOO_SOON" };
  if (await isHoliday(db, istDay(Date.parse(startUtc)))) return { ok: false, reason: "UNAVAILABLE" }; // a day off: nothing new is held
  if (await isTimeOff(db, slot.startUtc, slot.endUtc)) return { ok: false, reason: "UNAVAILABLE" }; // time off (ticket 55): nothing new is held

  const now = iso(nowMs);
  const holdUntil = iso(nowMs + config.holdMinutes * 60_000);
  const cap = capSql(svc, slot.startUtc);
  const sql = `
    INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until, practitioner_id, service_key)
    SELECT :kind, :start, :end, :owner, 'HELD', :until, ${PRACTITIONER_SQL}, :svc
    WHERE NOT EXISTS (SELECT 1 FROM slots WHERE ${ACTIVE} AND start_utc < :end AND end_utc > :start)
      AND NOT EXISTS (SELECT 1 FROM slots WHERE ${HELD} AND owner_id = :owner)${cap.sql}
    ON CONFLICT (kind, start_utc) DO UPDATE
      SET owner_id = :owner, state = 'HELD', hold_until = :until, end_utc = :end, service_key = :svc
      WHERE NOT (slots.state = 'BOOKED' OR slots.hold_until > :now)`;
  // D1 binds positionally, so named params are rewritten to ?N via the helper below.
  const res = await run(db, sql, { kind, start: slot.startUtc, end: slot.endUtc, owner: ownerId, until: holdUntil, now, svc: svc.key, ...cap.params });
  if (res.meta.changes > 0) return { ok: true, holdUntil };

  const mine = await first(db, `SELECT 1 AS x FROM slots WHERE ${HELD} AND owner_id = :owner`, { owner: ownerId, now });
  return { ok: false, reason: mine ? "ALREADY_HOLDING" : "UNAVAILABLE" };
}

// Slots of one kind on one IST day that a customer could hold right now.
// `nowMs` is the earliest start (the caller adds the booking lead time). Holds are judged at `busyAtMs`, the real now: a hold that
// is live right now keeps the slot off the list even when it will have lapsed by the time the lead has passed.
// `service`: a catalogue key (default the first call or the single session); a day whose caps are reached has no free time for it.
export async function availableSlots(db: D1Database, kind: SlotKind, ymd: string, nowMs: number, busyAtMs = nowMs, service?: string): Promise<Slot[]> {
  const svc = slotService(kind, service);
  if (!svc || (await isHoliday(db, ymd))) return [];
  const now = iso(nowMs);
  const busyAt = iso(busyAtMs);
  const slots = generateSlots(ymd, kind, svc.key);
  const cap = capSql(svc, slots[0]?.startUtc ?? dayStartUtc(ymd));
  if (cap.sql && !(await first(db, `SELECT 1 AS x WHERE 1${cap.sql}`, { ...cap.params, now: busyAt }))) return [];
  const off = await timeOffOnDay(db, ymd); // ticket 55
  const out: Slot[] = [];
  for (const s of slots) {
    if (s.startUtc <= now) continue;
    if (overlapsTimeOff(off, ymd, s.startUtc, s.endUtc)) continue;
    const busy = await first(
      db,
      `SELECT 1 AS x FROM slots WHERE ${ACTIVE} AND start_utc < :end AND end_utc > :start`,
      { end: s.endUtc, start: s.startUtc, now: busyAt },
    );
    if (!busy) out.push(s);
  }
  return out;
}

// The day caps for one more booking of `svc` on the IST day of `startUtc` (ticket 48), as " AND ..." conditions for a WHERE, with their
// named parameters (the caller's :now marks what is active, as ACTIVE does). Two caps, each only when it applies:
//   - the sessions cap: fewer than config.slots.maxSessionsPerDay active session slots of 60 or 90 minutes that day (RELEASE, UNDERSTAND,
//     REWIRE; never a call or a 30-minute one), counted from the slots themselves. With today's 60-minute session the generator already
//     makes only 5 a day, so today's numbers are the same;
//   - the service's own daily_cap: fewer than that many active slots of this service that day.
export function capSql(svc: Service, startUtc: string): { sql: string; params: Record<string, string | number> } {
  const from = dayStartUtc(istDay(Date.parse(startUtc)));
  const params: Record<string, string | number> = { dayFrom: from, dayTo: iso(Date.parse(from) + 86_400_000) };
  const inDay = `${ACTIVE} AND start_utc >= :dayFrom AND start_utc < :dayTo`;
  let sql = "";
  if (countsAsSession(svc)) {
    sql += ` AND (SELECT COUNT(*) FROM slots WHERE ${inDay} AND kind = 'SESSION' AND strftime('%s', end_utc) - strftime('%s', start_utc) >= 3600) < :maxSessions`;
    params.maxSessions = config.slots.maxSessionsPerDay;
  }
  if (svc.dailyCap !== null) {
    sql += ` AND (SELECT COUNT(*) FROM slots WHERE ${inDay} AND ${SLOT_SERVICE_SQL("slots")} = :capKey) < :dailyCap`;
    params.capKey = svc.key;
    params.dailyCap = svc.dailyCap;
  }
  return { sql, params };
}
// The UTC instant an IST calendar day ("YYYY-MM-DD") starts.
export const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));

// --- tiny named-parameter helper (D1 only supports ?N / ? placeholders) ---
export function bind(db: D1Database, sql: string, params: Record<string, string | number>) {
  const names: string[] = [];
  const text = sql.replace(/:(\w+)/g, (_, n: string) => {
    let i = names.indexOf(n);
    if (i < 0) i = names.push(n) - 1;
    return `?${i + 1}`;
  });
  return db.prepare(text).bind(...names.map((n) => params[n]));
}
const run = (db: D1Database, sql: string, p: Record<string, string | number>) => bind(db, sql, p).run();
const first = (db: D1Database, sql: string, p: Record<string, string | number>) => bind(db, sql, p).first();
