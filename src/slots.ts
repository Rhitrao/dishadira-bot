import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";

export type SlotKind = "CALL" | "SESSION";
export type Slot = { kind: SlotKind; startUtc: string; endUtc: string };

// India has no daylight saving, so IST is a fixed +05:30 offset from UTC.
const IST_OFFSET_MINUTES = 330;

export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

// All slots for one IST calendar day ("YYYY-MM-DD"). Empty on days Amma doesn't work.
export function generateSlots(ymd: string, kind: SlotKind): Slot[] {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dayMs = Date.UTC(y, mo - 1, d);
  if (!(config.hours.days as readonly number[]).includes(new Date(dayMs).getUTCDay())) return [];

  const length = kind === "CALL" ? config.slots.callMinutes : config.slots.sessionMinutes;
  const open = hhmm(config.hours.start);
  const close = hhmm(config.hours.end);
  const slots: Slot[] = [];
  for (let t = open; t + length <= close; t += length) {
    if (kind === "SESSION" && slots.length >= config.slots.maxSessionsPerDay) break;
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
export const formatIst = (utc: string) => {
  const p = formatIstParts(utc);
  return `${p.day}, ${p.time}`;
};

// The next `count` working days (IST "YYYY-MM-DD"), starting with today.
export function nextWorkingDays(nowMs: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 14; i++) {
    const ymd = istDay(nowMs + i * 86_400_000);
    if (generateSlots(ymd, "CALL").length) out.push(ymd);
  }
  return out;
}

// A slot is active (blocks the calendar) when booked, or held and not yet expired.
const ACTIVE = "(state = 'BOOKED' OR hold_until > :now)";

// The per-person limit counts only unexpired HELD rows: a BOOKED call must not stop a later session hold.
const HELD = "(state = 'HELD' AND hold_until > :now)";

export type HoldResult = { ok: true; holdUntil: string } | { ok: false; reason: "NOT_A_SLOT" | "ALREADY_HOLDING" | "UNAVAILABLE" };

// Amma has one calendar: a CALL and a SESSION must never overlap, so the single statement below
// refuses a slot if ANY active slot overlaps it (either kind) or if this person already has an
// unexpired hold. INSERT ... WHERE NOT EXISTS is one atomic write, so concurrent callers get one winner.
// An expired row on the same (kind, start) is taken over by ON CONFLICT; an active one never is,
// so a replay by the same person can never extend a hold (it is refused as ALREADY_HOLDING).
export async function holdSlot(
  db: D1Database,
  args: { kind: SlotKind; startUtc: string; ownerId: number; nowMs: number },
): Promise<HoldResult> {
  const { kind, startUtc, ownerId, nowMs } = args;
  const slot = generateSlots(istDay(Date.parse(startUtc)), kind).find((s) => s.startUtc === startUtc);
  if (!slot) return { ok: false, reason: "NOT_A_SLOT" };

  const now = iso(nowMs);
  const holdUntil = iso(nowMs + config.holdMinutes * 60_000);
  const sql = `
    INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until)
    SELECT :kind, :start, :end, :owner, 'HELD', :until
    WHERE NOT EXISTS (SELECT 1 FROM slots WHERE ${ACTIVE} AND start_utc < :end AND end_utc > :start)
      AND NOT EXISTS (SELECT 1 FROM slots WHERE ${HELD} AND owner_id = :owner)
    ON CONFLICT (kind, start_utc) DO UPDATE
      SET owner_id = :owner, state = 'HELD', hold_until = :until, end_utc = :end
      WHERE NOT (slots.state = 'BOOKED' OR slots.hold_until > :now)`;
  // D1 binds positionally, so named params are rewritten to ?N via the helper below.
  const res = await run(db, sql, { kind, start: slot.startUtc, end: slot.endUtc, owner: ownerId, until: holdUntil, now });
  if (res.meta.changes > 0) return { ok: true, holdUntil };

  const mine = await first(db, `SELECT 1 AS x FROM slots WHERE ${HELD} AND owner_id = :owner`, { owner: ownerId, now });
  return { ok: false, reason: mine ? "ALREADY_HOLDING" : "UNAVAILABLE" };
}

// Slots of one kind on one IST day that a customer could hold right now.
export async function availableSlots(db: D1Database, kind: SlotKind, ymd: string, nowMs: number): Promise<Slot[]> {
  const now = iso(nowMs);
  const out: Slot[] = [];
  for (const s of generateSlots(ymd, kind)) {
    if (s.startUtc <= now) continue;
    const busy = await first(
      db,
      `SELECT 1 AS x FROM slots WHERE ${ACTIVE} AND start_utc < :end AND end_utc > :start`,
      { end: s.endUtc, start: s.startUtc, now },
    );
    if (!busy) out.push(s);
  }
  return out;
}

// --- tiny named-parameter helper (D1 only supports ?N / ? placeholders) ---
function bind(db: D1Database, sql: string, params: Record<string, string | number>) {
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
