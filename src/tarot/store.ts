// Ticket 57: the tarot game's data. Logins, sessions, the day's readings, the journal, the collection and the streak, all in D1 and all tied
// to the bot's conversation row (so People → Remove their data takes them too). Tokens and session ids are random 32-byte values; only their
// SHA-256 hashes are stored, so a copy of the database cannot be used to log in.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { iso, istDay } from "../slots";
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

type ReadingRow = { id: number; day: string; kind: SpreadId; theme: ThemeId | null; question: string | null; deck: string | null; cards: string | null; note: string | null; done_at: string | null };

export async function todayRows(db: D1Database, convId: number, day: string): Promise<ReadingRow[]> {
  const r = await db.prepare("SELECT id, day, kind, theme, question, deck, cards, note, done_at FROM tarot_readings WHERE conversation_id = ?1 AND day = ?2").bind(convId, day).all<ReadingRow>();
  return r.results;
}

// Shuffle and cut for today's reading of this kind. A reading already finished today stays as it is (the free reading cannot be re-rolled).
export async function startReading(
  db: D1Database, convId: number, kind: SpreadId, theme: ThemeId | null, question: string | null, pile: number,
  nowMs = Date.now(), below?: (n: number) => number,
): Promise<"started" | "done"> {
  const day = istDay(nowMs);
  const existing = (await todayRows(db, convId, day)).find((r) => r.kind === kind);
  if (existing?.done_at) return "done";
  const deck = JSON.stringify(cutDeck(shuffledDeck(below), pile));
  await db
    .prepare(
      `INSERT INTO tarot_readings (conversation_id, day, kind, theme, question, deck, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (conversation_id, day, kind) DO UPDATE SET theme = ?4, question = ?5, deck = ?6, created_at = ?7 WHERE done_at IS NULL`,
    )
    .bind(convId, day, kind, kind === "daily" ? null : theme, kind === "daily" ? null : question, deck, iso(nowMs))
    .run();
  return "started";
}

// The picks become the reading. Returns the drawn cards, or null for bad picks or no open reading.
export async function finishReading(db: D1Database, convId: number, kind: SpreadId, picks: unknown, nowMs = Date.now()): Promise<{ id: number; cards: Drawn[] } | null> {
  const day = istDay(nowMs);
  const row = (await todayRows(db, convId, day)).find((r) => r.kind === kind);
  if (!row || row.done_at || !row.deck) return null;
  const cards = pickCards(JSON.parse(row.deck) as Drawn[], picks, SPREADS[kind].positions.length);
  if (!cards) return null;
  const res = await db
    .prepare("UPDATE tarot_readings SET cards = ?2, deck = NULL, done_at = ?3 WHERE id = ?1 AND done_at IS NULL")
    .bind(row.id, JSON.stringify(cards), iso(nowMs))
    .run();
  if (res.meta.changes !== 1) return null;
  await db.batch(cards.map((c) => db.prepare("INSERT OR IGNORE INTO tarot_seen (conversation_id, card_id, first_at) VALUES (?1, ?2, ?3)").bind(convId, c.id, iso(nowMs))));
  return { id: row.id, cards };
}

export async function setNote(db: D1Database, convId: number, readingId: number, note: string): Promise<boolean> {
  const clean = note.trim().slice(0, 1000);
  const res = await db
    .prepare("UPDATE tarot_readings SET note = ?3 WHERE id = ?1 AND conversation_id = ?2 AND done_at IS NOT NULL")
    .bind(readingId, convId, clean === "" ? null : clean)
    .run();
  return res.meta.changes === 1;
}

export type JournalEntry = { id: number; day: string; kind: SpreadId; theme: ThemeId | null; question: string | null; cards: Drawn[]; note: string | null };

export async function journal(db: D1Database, convId: number, nowMs = Date.now(), days = JOURNAL_DAYS): Promise<JournalEntry[]> {
  const since = istDay(nowMs - (days - 1) * 86_400_000);
  const r = await db
    .prepare("SELECT id, day, kind, theme, question, cards, note FROM tarot_readings WHERE conversation_id = ?1 AND done_at IS NOT NULL AND day >= ?2 ORDER BY day DESC, id DESC")
    .bind(convId, since)
    .all<ReadingRow>();
  return r.results.map((x) => ({ id: x.id, day: x.day, kind: x.kind, theme: x.theme, question: x.question, cards: JSON.parse(x.cards ?? "[]") as Drawn[], note: x.note }));
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
];

// The daily wipe: everything of a person whose last reading is older than KEEP_DAYS, and expired logins and sessions.
export async function wipeOldTarot(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = iso(nowMs - KEEP_DAYS * 86_400_000);
  const stale = "SELECT conversation_id FROM tarot_readings GROUP BY conversation_id HAVING MAX(created_at) < ?1";
  await db.batch([
    db.prepare(`DELETE FROM tarot_seen WHERE conversation_id IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM tarot_readings WHERE conversation_id IN (${stale})`).bind(cutoff),
    db.prepare("DELETE FROM tarot_sessions WHERE expires_at < ?1").bind(iso(nowMs)),
    db.prepare("DELETE FROM tarot_logins WHERE expires_at < ?1").bind(iso(nowMs - 86_400_000)),
  ]);
}
