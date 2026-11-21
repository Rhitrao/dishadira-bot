// The service catalogue (ticket 48, migration 0021): one row per bookable offer, with its name in English and Hindi, its pathway, its
// length and its price. The owner edits it in /app Settings → Services (src/settings.ts). It is seeded with today's two offers, the ₹99
// first call (ENTRY, 15 min) and the ₹799 single session (RELEASE, 60 min); a row the owner adds stays off (active 0) and unoffered by the
// bot (public 0) until a later ticket. Packages are not services: they stay tied to the single session (src/packages.ts).
// The rows are read at the start of every request and cron run (loadPrices in src/business.ts), so the synchronous slot generator
// (src/slots.ts) knows each length. A missing seeded row (or no table yet) falls back to config, so the bot behaves exactly as before.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { SlotKind } from "./slots";

export const PATHWAYS = ["ENTRY", "RELEASE", "UNDERSTAND", "REWIRE"] as const;
export type Pathway = (typeof PATHWAYS)[number];
export const LENGTHS = [15, 30, 60, 90] as const;
export const MAX_DAILY_CAP = 20;

export type Service = {
  key: string; nameEn: string; nameHi: string; pathway: Pathway; minutes: number; pricePaise: number;
  needsCallFirst: boolean; dailyCap: number | null; active: boolean; public: boolean; sort: number;
  updatedAt: string | null; updatedBy: number | null;
  // Ticket 49 (migration 0023): the one question asked after payment (English, Hindi; null: none) and the two yes/no questions before the hold.
  intakeEn: string | null; intakeHi: string | null; screen: boolean;
};

// The two seeded rows' keys. Every intro is the first call; every session made before 0021 (and every session the bot books today) is
// the single session. A slot with no service_key is the one of its kind.
export const CALL_KEY = "first_call";
export const SESSION_KEY = "single_session";

// The seeded rows as config has them: the fallback when a row is missing.
export const SEED: readonly Service[] = [
  {
    key: CALL_KEY, nameEn: "First call", nameHi: "पहली कॉल", pathway: "ENTRY", minutes: config.slots.callMinutes, pricePaise: config.prices.intro,
    needsCallFirst: false, dailyCap: null, active: true, public: true, sort: 10, updatedAt: null, updatedBy: null,
    intakeEn: null, intakeHi: null, screen: false,
  },
  {
    key: SESSION_KEY, nameEn: "Single session", nameHi: "एक सेशन", pathway: "RELEASE", minutes: config.slots.sessionMinutes, pricePaise: config.prices.single,
    needsCallFirst: false, dailyCap: null, active: true, public: true, sort: 20, updatedAt: null, updatedBy: null,
    intakeEn: null, intakeHi: null, screen: false,
  },
];

// The call is a CALL slot (an intro); every other pathway is a SESSION slot (a sessions row). Amma has one calendar either way.
export const slotKindOf = (s: Service): SlotKind => (s.pathway === "ENTRY" ? "CALL" : "SESSION");
// The 5-a-day cap (config.slots.maxSessionsPerDay) counts sessions as before: RELEASE, UNDERSTAND and REWIRE bookings of 60 or 90 minutes.
export const countsAsSession = (s: Service) => s.pathway !== "ENTRY" && s.minutes >= 60;
export const isLength = (n: number) => (LENGTHS as readonly number[]).includes(n);
export const isPathway = (v: unknown): v is Pathway => typeof v === "string" && (PATHWAYS as readonly string[]).includes(v);
export const isSeeded = (key: string) => key === CALL_KEY || key === SESSION_KEY;

type Row = {
  key: string; name_en: string; name_hi: string; pathway: string; minutes: number; price_paise: number; needs_call_first: number;
  daily_cap: number | null; active: number; public: number; sort: number; updated_at: string | null; updated_by: number | null;
  intake_en?: string | null; intake_hi?: string | null; screen?: number | null; // migration 0023
};
const fromRow = (r: Row): Service => ({
  key: r.key, nameEn: r.name_en, nameHi: r.name_hi, pathway: isPathway(r.pathway) ? r.pathway : "RELEASE", minutes: r.minutes, pricePaise: r.price_paise,
  needsCallFirst: r.needs_call_first === 1, dailyCap: r.daily_cap, active: r.active === 1, public: r.public === 1, sort: r.sort,
  updatedAt: r.updated_at, updatedBy: r.updated_by,
  intakeEn: r.intake_en?.trim() || null, intakeHi: r.intake_hi?.trim() || null, screen: r.screen === 1,
});

// Every row, in the owner's order; a seeded row that is missing comes from config. The table's CHECKs keep every row's values allowed.
export async function readCatalogue(db: D1Database): Promise<Service[]> {
  const { results } = await db.prepare("SELECT * FROM services ORDER BY sort, key").all<Row>();
  const rows = results.map(fromRow);
  for (const s of SEED) if (!rows.some((r) => r.key === s.key)) rows.push({ ...s });
  return rows.sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

// The catalogue in force for this request. If the read fails (no table yet) the last good one (or config's) stays.
let current: Service[] = SEED.map((s) => ({ ...s }));
export const catalogue = (): Service[] => current;
export async function loadCatalogue(db: D1Database): Promise<Service[]> {
  try {
    current = await readCatalogue(db);
  } catch {
    // keep the last good catalogue
  }
  return current;
}

// Ticket 49 (CONTRACT v19): the NEW_SERVICES env flag ("true" on test only until Razorpay's written go-ahead and Rohit's).
export const newServicesOn = (env: { NEW_SERVICES?: string }) => env.NEW_SERVICES === "true";
// A service other than the seeded two that the bot offers right now: the flag is "true" and the row is active and public. With the flag off
// the bot offers exactly what it did before ticket 49, whatever the rows say.
export const isOffered = (env: { NEW_SERVICES?: string }, s: Service | undefined): s is Service =>
  !!s && newServicesOn(env) && !isSeeded(s.key) && s.active && s.public && s.pathway !== "ENTRY";
export const offeredServices = (env: { NEW_SERVICES?: string }): Service[] => current.filter((s) => isOffered(env, s));
// The question after payment in the customer's language (the English one when the Hindi one is empty), or null.
export const intakeOf = (s: Service | undefined, lang: "en" | "hi"): string | null => (s ? (lang === "hi" ? s.intakeHi ?? s.intakeEn : s.intakeEn ?? s.intakeHi) : null);

export const serviceOf = (key: string | null | undefined): Service | undefined => (key ? current.find((s) => s.key === key) : undefined);
// The service a booking of this kind is when nothing else says: the first call or the single session.
export const defaultService = (kind: SlotKind): Service => serviceOf(kind === "CALL" ? CALL_KEY : SESSION_KEY) ?? SEED[kind === "CALL" ? 0 : 1];
export const minutesFor = (kind: SlotKind) => defaultService(kind).minutes;
// A slot's service key in SQL: its own, or (a slot made before 0021) the one of its kind. `t` is the slots table's name or alias.
export const SLOT_SERVICE_SQL = (t: string) => `COALESCE(${t}.service_key, CASE ${t}.kind WHEN 'CALL' THEN '${CALL_KEY}' ELSE '${SESSION_KEY}' END)`;

// A booking's words in the console for a service that isn't one of the seeded two (those keep their own words, so today's screens read
// exactly as before): its name ("Tarot reading"), and with its length ("Tarot reading · 30 min"). null for the seeded two.
export function otherServiceName(key: string | null | undefined, lang: "en" | "hi"): string | null {
  const s = serviceOf(key);
  if (!s || isSeeded(s.key)) return null;
  return lang === "hi" ? s.nameHi : s.nameEn;
}
export function otherServiceLabel(key: string | null | undefined, lang: "en" | "hi"): string | null {
  const name = otherServiceName(key, lang);
  const min = serviceOf(key)?.minutes;
  return name && `${name} · ${lang === "hi" ? `${min} मिनट` : `${min} min`}`;
}

// A seeded row, written if it is missing (the catalogue fell back to config for it), so an edit always has a row to change.
export const seedRowStmt = (db: D1Database, key: string) => {
  const s = SEED.find((x) => x.key === key)!;
  return db
    .prepare(
      "INSERT OR IGNORE INTO services (key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, daily_cap, active, public, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, 1, 1, ?7)",
    )
    .bind(s.key, s.nameEn, s.nameHi, s.pathway, s.minutes, s.pricePaise, s.sort);
};

// A stable key for a new service, from its English name: "Tarot reading (30 min)" -> "tarot_reading_30_min", then _2, _3 if taken.
export function newKey(nameEn: string, taken: string[]): string {
  const word = nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const base = word.length >= 2 ? word : `service${word ? `_${word}` : ""}`;
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}
