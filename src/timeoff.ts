// Time off for part of a day (ticket 55): the owner, or the practitioner for her own calendar, blocks a range inside the working hours on a
// day (say 4 to 6 pm on Thursday) from /app Calendar → Days off. The stated hours (2 to 7 pm) do not change, so no template, no knowledge
// and no message does. In the block nothing is offered, held or booked (src/slots.ts); bookings already there are never cancelled, nobody is
// messaged, and the list shows them with a warning. Storage: a settings row per block (src/slots.ts TIMEOFF_PREFIX). No migration.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Env } from "./env";
import { bookingsOn, holidayDate } from "./holidays";
import { iso, istDay, parseTimeOffKey, TIMEOFF_PREFIX, type TimeOffBlock } from "./slots";

export const MAX_BLOCKS_PER_DAY = 6;
const hhmm = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};
const clock4 = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}${String(min % 60).padStart(2, "0")}`;
export const clockText = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const keyFor = (ymd: string, startMin: number, endMin: number) => `${TIMEOFF_PREFIX}${ymd}:${clock4(startMin)}-${clock4(endMin)}`;

export type Parsed = { ymd: string; startMin: number; endMin: number };
// A block the form may add: a real day from today to config.holidays.maxDaysAhead, "HH:MM" times, the start before the end, both inside
// the working hours (config.hours), on a 5-minute step.
export function parseBlock(day: unknown, from: unknown, to: unknown, nowMs = Date.now()): Parsed | null {
  const ymd = holidayDate(day, nowMs);
  const ok = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim());
  if (!ymd || !ok(from) || !ok(to)) return null;
  const startMin = hhmm(from.trim());
  const endMin = hhmm(to.trim());
  if (startMin % 5 || endMin % 5 || startMin >= endMin) return null;
  if (startMin < hhmm(config.hours.start) || endMin > hhmm(config.hours.end)) return null;
  return { ymd, startMin, endMin };
}

export async function upcomingTimeOff(db: D1Database, nowMs = Date.now()): Promise<TimeOffBlock[]> {
  const { results } = await db
    .prepare("SELECT key, value AS note FROM settings WHERE key >= ?1 AND key < ?2 ORDER BY key")
    .bind(`${TIMEOFF_PREFIX}${istDay(nowMs)}:`, `${TIMEOFF_PREFIX}~`)
    .all<{ key: string; note: string }>();
  return results.flatMap((r) => {
    const k = parseTimeOffKey(r.key);
    return k ? [{ key: r.key, note: r.note, ...k }] : [];
  });
}

// Adds a block. A repeat of the same block changes nothing. At most MAX_BLOCKS_PER_DAY a day. `audit` runs in the same batch.
export async function addTimeOff(env: Env, b: Parsed, note: string, audit?: D1PreparedStatement): Promise<"ADDED" | "EXISTS" | "FULL"> {
  const prefix = `${TIMEOFF_PREFIX}${b.ymd}:`;
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key >= ?1 AND key < ?2").bind(prefix, `${TIMEOFF_PREFIX}${b.ymd};`).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_BLOCKS_PER_DAY) return "FULL";
  const [res] = await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO NOTHING").bind(keyFor(b.ymd, b.startMin, b.endMin), note.trim().slice(0, 200), iso(Date.now())),
    ...(audit ? [audit] : []),
  ]);
  return res.meta.changes > 0 ? "ADDED" : "EXISTS";
}

export async function removeTimeOff(env: Env, key: string, audit?: D1PreparedStatement): Promise<boolean> {
  if (!parseTimeOffKey(key)) return false;
  const [res] = await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key), ...(audit ? [audit] : [])]);
  return res.meta.changes > 0;
}

// The bookings that still hold their time inside a block (for the warning on its card).
export async function bookingsInBlock(db: D1Database, b: TimeOffBlock) {
  const base = Date.parse(`${b.ymd}T00:00:00+05:30`);
  return (await bookingsOn(db, b.ymd)).filter((x) => (Date.parse(x.startUtc) - base) / 60_000 < b.endMin && (Date.parse(x.startUtc) - base) / 60_000 + 15 > b.startMin);
}

// ---------- words (English and Hindi; the Hindi is to be read by a native speaker) ----------
export const TIMEOFF_COPY = {
  en: {
    title: "Time off for part of a day",
    intro: "Block a time inside the working hours, for example 4 to 6 pm on Thursday. Customers will not be offered those times. Bookings already there stay: move them by hand.",
    date: "Day", from: "From", to: "To", note: "Note (only you see it)", mark: "Block this time", remove: "Remove",
    upcoming: "Blocked times", none: "No part-day time off.",
    range: (a: string, b: string) => `${a} to ${b}`,
    warn: (n: number) => `${n} ${n === 1 ? "booking is" : "bookings are"} in this time. Move ${n === 1 ? "it" : "them"} by hand.`,
    added: "Time blocked.", removed: "Time opened again.", bad: "Check the day and times. They must be inside the working hours, the start before the end.", full: "That day already has the most blocked times.",
  },
  hi: {
    title: "दिन के कुछ हिस्से की छुट्टी",
    intro: "काम के घंटों के भीतर कोई समय रोकिए, जैसे गुरुवार को शाम 4 से 6 बजे। ग्राहकों को वे समय नहीं दिखेंगे। वहाँ पहले से लगी बुकिंग रहती हैं: उन्हें हाथ से बदलिए।",
    date: "दिन", from: "से", to: "तक", note: "नोट (सिर्फ़ आपको दिखता है)", mark: "यह समय रोकें", remove: "हटाएँ",
    upcoming: "रोके गए समय", none: "दिन के हिस्से की कोई छुट्टी नहीं।",
    range: (a: string, b: string) => `${a} से ${b}`,
    warn: (n: number) => `इस समय में ${n} बुकिंग है। उसे हाथ से बदलिए।`,
    added: "समय रोक दिया गया।", removed: "समय फिर से खुल गया।", bad: "दिन और समय जाँचिए। वे काम के घंटों के भीतर हों और शुरू का समय अंत से पहले हो।", full: "उस दिन के लिए रोके गए समय की सीमा पूरी हो चुकी है।",
  },
} as const;
