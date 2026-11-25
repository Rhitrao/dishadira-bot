// Ticket 57: the tarot game's data. Logins, sessions, the day's readings, the journal, the collection and the streak, all in D1 and all tied
// to the bot's conversation row (so People → Remove their data takes them too). Tokens and session ids are random 32-byte values; only their
// SHA-256 hashes are stored, so a copy of the database cannot be used to log in.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { iso, istDay } from "../slots";
import type { Profile } from "./profile";
import { cutDeck, type Drawn, pickCards, shuffledDeck, SPREADS, type SpreadId, type ThemeId } from "./reading";

export const LOGIN_MINUTES = 15;
export const SESSION_DAYS = 90;
export const KEEP_DAYS = 90; // readings go this long after a person's last one
export const JOURNAL_DAYS = 7; // free journal

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A one-time login link for the bot's "Open your cards" button.
export async function newLoginLink(db: D1Database, convId: number, base: string, nowMs = Date.now()): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO tarot_logins (token_hash, conversation_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), convId, iso(nowMs + LOGIN_MINUTES * 60_000), iso(nowMs))
    .run();
  await db.prepare("DELETE FROM tarot_logins WHERE expires_at < ?1").bind(iso(nowMs - 86_400_000)).run(); // old links tidy themselves
  return `${base.replace(/\/+$/, "")}/tarot/in?t=${token}`;
}

// The link's token, once and in time, becomes the person's conversation id; anything else is null.
export async function redeemLogin(db: D1Database, token: string, nowMs = Date.now()): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const res = await db
    .prepare("UPDATE tarot_logins SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING conversation_id")
    .bind(await sha256(token), iso(nowMs))
    .first<{ conversation_id: number }>();
  return res?.conversation_id ?? null;
}

export async function newSession(db: D1Database, convId: number, nowMs = Date.now()): Promise<string> {
  const id = randomToken();
  await db
    .prepare("INSERT INTO tarot_sessions (id_hash, conversation_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(id), convId, iso(nowMs + SESSION_DAYS * 86_400_000), iso(nowMs))
    .run();
  return id;
}

export async function sessionConv(db: D1Database, id: string | undefined, nowMs = Date.now()): Promise<number | null> {
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const row = await db
    .prepare(
      `SELECT s.conversation_id AS c FROM tarot_sessions s JOIN conversations v ON v.id = s.conversation_id
       WHERE s.id_hash = ?1 AND s.expires_at > ?2 AND v.mode <> 'BLOCKED'`,
    )
    .bind(await sha256(id), iso(nowMs))
    .first<{ c: number }>();
  return row?.c ?? null;
}

export async function endSession(db: D1Database, id: string | undefined): Promise<void> {
  if (id) await db.prepare("DELETE FROM tarot_sessions WHERE id_hash = ?1").bind(await sha256(id)).run();
}

export type Kind = "daily" | "spread";
type ReadingRow = {
  id: number; day: string; kind: Kind; n: number; spread: SpreadId; theme: ThemeId | null; question: string | null; custom: number;
  deck: string | null; cards: string | null; note: string | null; done_at: string | null; story: string | null;
};
const COLS = "id, day, kind, n, spread, theme, question, custom, deck, cards, note, done_at, story";

export async function todayRows(db: D1Database, convId: number, day: string): Promise<ReadingRow[]> {
  const r = await db.prepare(`SELECT ${COLS} FROM tarot_readings WHERE conversation_id = ?1 AND day = ?2 ORDER BY n`).bind(convId, day).all<ReadingRow>();
  return r.results;
}
// The latest reading of a kind today (a tester can have several).
export const latest = (rows: ReadingRow[], kind: Kind) => rows.filter((r) => r.kind === kind).at(-1);

export type Start = { kind: Kind; spread: SpreadId; theme: ThemeId | null; question: string | null; custom: boolean; pile: number };

// Shuffle and cut for today's reading of this kind. A finished reading stays as it is (no re-roll); a tester (unlimited) gets a new one.
export async function startReading(db: D1Database, convId: number, s: Start, unlimited = false, nowMs = Date.now(), below?: (n: number) => number): Promise<"started" | "done"> {
  const day = istDay(nowMs);
  const last = latest(await todayRows(db, convId, day), s.kind);
  if (last?.done_at && !unlimited) return "done";
  const deck = JSON.stringify(cutDeck(shuffledDeck(below), s.pile));
  const theme = s.kind === "daily" ? null : s.theme;
  const question = s.kind === "daily" ? null : s.question;
  if (last && !last.done_at) {
    await db
      .prepare("UPDATE tarot_readings SET spread = ?2, theme = ?3, question = ?4, custom = ?5, deck = ?6, created_at = ?7 WHERE id = ?1 AND done_at IS NULL")
      .bind(last.id, s.spread, theme, question, s.custom ? 1 : 0, deck, iso(nowMs))
      .run();
    return "started";
  }
  await db
    .prepare(
      `INSERT INTO tarot_readings (conversation_id, day, kind, n, spread, theme, question, custom, deck, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(convId, day, s.kind, (last?.n ?? 0) + 1, s.spread, theme, question, s.custom ? 1 : 0, deck, iso(nowMs))
    .run();
  return "started";
}

// The picks become the reading. Returns the row and the drawn cards, or null for bad picks or no open reading.
export async function finishReading(db: D1Database, convId: number, kind: Kind, picks: unknown, nowMs = Date.now()): Promise<{ row: ReadingRow; cards: Drawn[] } | null> {
  const row = latest(await todayRows(db, convId, istDay(nowMs)), kind);
  if (!row || row.done_at || !row.deck) return null;
  const cards = pickCards(JSON.parse(row.deck) as Drawn[], picks, SPREADS[row.spread].positions.length);
  if (!cards) return null;
  const res = await db
    .prepare("UPDATE tarot_readings SET cards = ?2, deck = NULL, done_at = ?3 WHERE id = ?1 AND done_at IS NULL")
    .bind(row.id, JSON.stringify(cards), iso(nowMs))
    .run();
  if (res.meta.changes !== 1) return null;
  await db.batch(cards.map((c) => db.prepare("INSERT OR IGNORE INTO tarot_seen (conversation_id, card_id, first_at) VALUES (?1, ?2, ?3)").bind(convId, c.id, iso(nowMs))));
  return { row: { ...row, cards: JSON.stringify(cards), deck: null, done_at: iso(nowMs), story: null }, cards };
}

export async function setNote(db: D1Database, convId: number, readingId: number, note: string): Promise<boolean> {
  const clean = note.trim().slice(0, 1000);
  const res = await db
    .prepare("UPDATE tarot_readings SET note = ?3 WHERE id = ?1 AND conversation_id = ?2 AND done_at IS NOT NULL")
    .bind(readingId, convId, clean === "" ? null : clean)
    .run();
  return res.meta.changes === 1;
}

export type JournalEntry = { id: number; day: string; kind: Kind; spread: SpreadId; theme: ThemeId | null; question: string | null; custom: boolean; cards: Drawn[]; note: string | null; story?: string | null };
const entry = (x: ReadingRow): JournalEntry => ({
  id: x.id, day: x.day, kind: x.kind, spread: x.spread, theme: x.theme, question: x.question, custom: x.custom === 1, cards: JSON.parse(x.cards ?? "[]") as Drawn[], note: x.note, story: x.story,
});
export const asEntry = entry;

export async function journal(db: D1Database, convId: number, nowMs = Date.now(), days = JOURNAL_DAYS): Promise<JournalEntry[]> {
  const since = istDay(nowMs - (days - 1) * 86_400_000);
  const r = await db
    .prepare(`SELECT ${COLS} FROM tarot_readings WHERE conversation_id = ?1 AND done_at IS NOT NULL AND day >= ?2 ORDER BY day DESC, id DESC LIMIT 60`)
    .bind(convId, since)
    .all<ReadingRow>();
  return r.results.map(entry);
}

// One finished reading of this person's, or null (ticket 59).
export async function readingById(db: D1Database, convId: number, id: number): Promise<JournalEntry | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM tarot_readings WHERE id = ?1 AND conversation_id = ?2 AND done_at IS NOT NULL`).bind(id, convId).first<ReadingRow>();
  return r ? entry(r) : null;
}

// Cards drawn in the 30 days before a reading (not counting it): what the personal lines look back on.
export async function history(db: D1Database, convId: number, beforeId: number, nowMs = Date.now()): Promise<Drawn[]> {
  const r = await db
    .prepare("SELECT cards FROM tarot_readings WHERE conversation_id = ?1 AND done_at IS NOT NULL AND id <> ?2 AND id < ?2 AND day >= ?3")
    .bind(convId, beforeId, istDay(nowMs - 29 * 86_400_000))
    .all<{ cards: string }>();
  return r.results.flatMap((x) => JSON.parse(x.cards) as Drawn[]);
}

// ---------- the profile (ticket 58) ----------
type ProfileRow = { name: string; dob: string; birth_time: string | null; tz_minutes: number; birth_place: string | null };
export async function getProfile(db: D1Database, convId: number): Promise<Profile | null> {
  const r = await db.prepare("SELECT name, dob, birth_time, tz_minutes, birth_place FROM tarot_profiles WHERE conversation_id = ?1").bind(convId).first<ProfileRow>();
  return r ? { name: r.name, dob: r.dob, birthTime: r.birth_time, tzMinutes: r.tz_minutes, birthPlace: r.birth_place } : null;
}

export const MIN_AGE = 18;
// Checks what the form sent. Returns the profile, or a short reason it cannot be saved.
export function parseProfile(b: Record<string, unknown>, nowMs = Date.now()): Profile | { error: string } {
  const name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 80) return { error: "name" };
  const dob = typeof b.dob === "string" ? b.dob : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return { error: "dob" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const when = Date.UTC(y, mo - 1, d);
  if (new Date(when).getUTCDate() !== d || y < 1900 || when > nowMs) return { error: "dob" };
  const today = istDay(nowMs);
  const age = Number(today.slice(0, 4)) - y - (today.slice(5) < dob.slice(5) ? 1 : 0);
  if (age < MIN_AGE) return { error: "age" };
  let birthTime: string | null = null;
  if (typeof b.birthTime === "string" && b.birthTime !== "") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.birthTime)) return { error: "time" };
    birthTime = b.birthTime;
  }
  const tz = b.tzMinutes === undefined || b.tzMinutes === null || b.tzMinutes === "" ? 330 : Number(b.tzMinutes);
  if (!Number.isInteger(tz) || tz < -720 || tz > 840 || tz % 15 !== 0) return { error: "tz" };
  const place = typeof b.birthPlace === "string" ? b.birthPlace.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (b.consent !== true) return { error: "consent" };
  return { name, dob, birthTime, tzMinutes: tz, birthPlace: place === "" ? null : place };
}

export async function saveProfile(db: D1Database, convId: number, p: Profile, nowMs = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tarot_profiles (conversation_id, name, dob, birth_time, tz_minutes, birth_place, consent_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (conversation_id) DO UPDATE SET name = ?2, dob = ?3, birth_time = ?4, tz_minutes = ?5, birth_place = ?6, updated_at = ?7`,
    )
    .bind(convId, p.name, p.dob, p.birthTime, p.tzMinutes, p.birthPlace, iso(nowMs))
    .run();
}
export async function deleteProfile(db: D1Database, convId: number): Promise<void> {
  await db.prepare("DELETE FROM tarot_profiles WHERE conversation_id = ?1").bind(convId).run();
}

// ---------- testers (ticket 58) ----------
// TAROT_TESTERS, a Worker secret: phone numbers with country code, separated by commas (a 10-digit number is read as Indian, +91). These
// people can draw as often as they like each day. Never in git: the repo is public.
export function testerNumbers(secret: string | undefined): Set<string> {
  return new Set(
    (secret ?? "")
      .split(/[,;\n]+/)
      .map((x) => x.replace(/\D/g, ""))
      .filter((x) => x.length >= 10)
      .map((x) => (x.length === 10 ? `91${x}` : x)),
  );
}
export async function isTester(db: D1Database, convId: number, secret: string | undefined): Promise<boolean> {
  const set = testerNumbers(secret);
  if (set.size === 0) return false;
  const r = await db.prepare("SELECT wa_id FROM conversations WHERE id = ?1").bind(convId).first<{ wa_id: string | null }>();
  return !!r?.wa_id && set.has(r.wa_id.replace(/\D/g, ""));
}

export async function seenCards(db: D1Database, convId: number): Promise<string[]> {
  const r = await db.prepare("SELECT card_id FROM tarot_seen WHERE conversation_id = ?1 ORDER BY first_at").bind(convId).all<{ card_id: string }>();
  return r.results.map((x) => x.card_id);
}

// Days in a row with a finished reading, counting back from today (or from yesterday, when today's is not done yet).
export async function streak(db: D1Database, convId: number, nowMs = Date.now()): Promise<number> {
  const r = await db
    .prepare("SELECT DISTINCT day FROM tarot_readings WHERE conversation_id = ?1 AND done_at IS NOT NULL AND day >= ?2 ORDER BY day DESC")
    .bind(convId, istDay(nowMs - 400 * 86_400_000))
    .all<{ day: string }>();
  const days = new Set(r.results.map((x) => x.day));
  let n = 0;
  let t = nowMs;
  if (!days.has(istDay(t))) t -= 86_400_000;
  while (days.has(istDay(t))) {
    n++;
    t -= 86_400_000;
  }
  return n;
}

// People → Remove their data (src/wipe.ts).
export const tarotWipeStmts = (db: D1Database, convId: number): D1PreparedStatement[] => [
  db.prepare("DELETE FROM tarot_logins WHERE conversation_id = ?1").bind(convId),
  db.prepare("DELETE FROM tarot_sessions WHERE conversation_id = ?1").bind(convId),
  db.prepare("DELETE FROM tarot_readings WHERE conversation_id = ?1").bind(convId),
  db.prepare("DELETE FROM tarot_seen WHERE conversation_id = ?1").bind(convId),
  db.prepare("DELETE FROM tarot_profiles WHERE conversation_id = ?1").bind(convId), // ticket 58
];

// The daily wipe: everything of a person whose last reading is older than KEEP_DAYS, and expired logins and sessions.
export async function wipeOldTarot(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = iso(nowMs - KEEP_DAYS * 86_400_000);
  const stale = "SELECT conversation_id FROM tarot_readings GROUP BY conversation_id HAVING MAX(created_at) < ?1";
  await db.batch([
    db.prepare(`DELETE FROM tarot_seen WHERE conversation_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM tarot_profiles WHERE conversation_id IN (${stale})`).bind(cutoff), // ticket 58
    db.prepare(
      `DELETE FROM tarot_profiles WHERE updated_at < ?1 AND conversation_id NOT IN (SELECT conversation_id FROM tarot_readings WHERE created_at >= ?1)`,
    ).bind(cutoff), // a profile with no reading in 90 days
    db.prepare(`DELETE FROM tarot_readings WHERE conversation_id IN (${stale})`).bind(cutoff),
    db.prepare("DELETE FROM tarot_sessions WHERE expires_at < ?1").bind(iso(nowMs)),
    db.prepare("DELETE FROM tarot_logins WHERE expires_at < ?1").bind(iso(nowMs - 86_400_000)),
  ]);
}
