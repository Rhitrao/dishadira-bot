// The business's own settings that the bot reads (ticket 24): prices, who gets the daily summary and the crisis email, whether staff
// read chat text, and the console's accent colour. They live in the `settings` key/value table, written only from Settings (/app/settings,
// owner only). A missing or bad row falls back to config, so with no rows the bot behaves exactly as before.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Env } from "./env";

// ---- the keys in the settings table ----
export const KEYS = {
  intro: "price.intro_paise",
  single: "price.single_paise",
  pack10: "price.pack10_paise",
  pack20: "price.pack20_paise",
  digest: "mail.digest_members", // member ids, comma separated; unset = the owner
  safety: "mail.safety_member", // one member id; unset = the owner
  staffReadChat: "privacy.staff_read_chat", // "false" hides chat text from staff; unset = they read it (safety messages never)
  accent: "business.accent", // one of ACCENTS
  locale: "business.default_locale", // en | hi, for new members
} as const;

// ---- prices ----
export type Pack = { sessions: number; paise: number };
export type Prices = { intro: number; single: number; pack10: Pack; pack20: Pack };
export type PriceName = keyof Prices;
export const PRICE_NAMES: PriceName[] = ["intro", "single", "pack10", "pack20"];

export const DEFAULT_PRICES: Prices = {
  intro: config.prices.intro,
  single: config.prices.single,
  pack10: { ...config.prices.pack10 },
  pack20: { ...config.prices.pack20 },
};

export const MAX_PRICE_PAISE = 10_000_000; // ₹1,00,000

// A price the bot may quote: whole rupees, at least ₹1, at most ₹1,00,000, and for a package a whole rupee per session.
export function validPrice(name: PriceName, paise: number): boolean {
  if (!Number.isInteger(paise) || paise < 100 || paise > MAX_PRICE_PAISE || paise % 100) return false;
  const pack = name === "pack10" || name === "pack20" ? DEFAULT_PRICES[name].sessions : 0;
  return !pack || (paise / 100) % pack === 0;
}

export const pricePaise = (p: Prices, name: PriceName) => (name === "pack10" || name === "pack20" ? p[name].paise : p[name]);

function withPrice(p: Prices, name: PriceName, paise: number): Prices {
  if (name === "pack10" || name === "pack20") return { ...p, [name]: { sessions: p[name].sessions, paise } };
  return { ...p, [name]: paise };
}

// One read of the four price rows; each one falls back to config on its own.
export async function readPrices(db: D1Database): Promise<Prices> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'price.%'").all<{ key: string; value: string }>();
  let p = DEFAULT_PRICES;
  for (const name of PRICE_NAMES) {
    const v = Number(results.find((r) => r.key === KEYS[name])?.value);
    if (validPrice(name, v)) p = withPrice(p, name, v);
  }
  return p;
}

// The prices in force. Read from the database at the start of every request and cron run (src/index.ts), so copyFor() and the
// payment-link code, which are synchronous, quote the owner's prices. If the read fails the last good prices (or config) stay.
let current: Prices = DEFAULT_PRICES;
export const prices = (): Prices => current;
export async function loadPrices(env: Pick<Env, "DB">): Promise<Prices> {
  try {
    current = await readPrices(env.DB);
  } catch {
    // keep the last good prices
  }
  return current;
}

// What a price was when a link was made at `atIso`: the "from" side of the first change after then, or today's price if it hasn't
// changed since. A payment for a link made before a price change is still the right amount.
export async function priceAt(db: D1Database, name: PriceName, atIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT detail FROM audit_log WHERE action = 'PRICE_CHANGED' AND target = ?1 AND at >= ?2 ORDER BY id LIMIT 1")
    .bind(KEYS[name], atIso)
    .first<{ detail: string }>();
  const from = Number(/^(\d+) -> \d+$/.exec(row?.detail ?? "")?.[1]);
  return Number.isInteger(from) && from > 0 ? from : pricePaise(await readPrices(db), name);
}

// ---- who gets the emails ----
type MemberMail = { id: number; email: string; role: string };
const activeMembers = async (db: D1Database) =>
  (await db.prepare("SELECT id, email, role FROM members WHERE workspace_id = 1 AND status = 'active' ORDER BY id").all<MemberMail>()).results;
const idsOf = (v: string | null | undefined) => (v ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);

// The member ids chosen in Settings, or null when the owner hasn't chosen (then it's the owner).
export async function chosenIds(db: D1Database, which: "digest" | "safety"): Promise<number[] | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(KEYS[which]).first<{ value: string }>();
  return r ? idsOf(r.value) : null;
}

// The addresses for the daily summary or the crisis email. The owner is reached at DIGEST_TO, the alert address verified today, so with
// nothing chosen the email goes exactly where it went before. Another member is reached at their sign-in email. Removed members never
// get one; if nobody chosen is still active, it goes to the owner.
export async function recipients(env: Env, which: "digest" | "safety"): Promise<string[]> {
  let members: MemberMail[] = [];
  let chosen: number[] | null = null;
  try {
    chosen = await chosenIds(env.DB, which);
    members = await activeMembers(env.DB);
  } catch {
    // no members table yet: the owner's address only
  }
  const owner = members.find((m) => m.role === "OWNER");
  const ownerTo = env.DIGEST_TO || owner?.email || "";
  const picked = members.filter((m) => chosen?.includes(m.id));
  const list = picked.length ? picked.map((m) => (m.role === "OWNER" ? ownerTo : m.email)) : [ownerTo];
  return [...new Set(list.filter(Boolean))];
}

// ---- privacy ----
// Staff read chat text by default, so they can reply (decided 27 Oct 2026); the owner can turn it off. Safety messages are always hidden.
export async function staffReadsChat(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(KEYS.staffReadChat).first<{ value: string }>();
  return r?.value !== "false";
}

// ---- the console's accent colour ----
// A small fixed set, each checked for contrast in light and dark (test/settings.test.ts), so no choice makes text unreadable.
export const ACCENTS = {
  teal: { light: "#1B6F73", lightTint: "#E6F0EF", dark: "#5CC2BE", darkTint: "#16302F" },
  blue: { light: "#2F5F8A", lightTint: "#E8EFF6", dark: "#8EC1EC", darkTint: "#172634" },
  indigo: { light: "#3F51B5", lightTint: "#ECEEF8", dark: "#A3ACF2", darkTint: "#1E2238" },
  plum: { light: "#7B3F72", lightTint: "#F5ECF3", dark: "#E0A3D6", darkTint: "#2E1C2B" },
} as const;
export type AccentName = keyof typeof ACCENTS;
export const isAccent = (v: unknown): v is AccentName => typeof v === "string" && Object.prototype.hasOwnProperty.call(ACCENTS, v);

export async function accentOf(db: D1Database): Promise<AccentName> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(KEYS.accent).first<{ value: string }>();
  return isAccent(r?.value) ? r.value : "teal";
}

// A style block that sets the accent for one page (the frame's default is teal, so teal adds nothing).
export function accentCss(name: AccentName): string {
  if (name === "teal") return "";
  const a = ACCENTS[name];
  return `<style>:root{--accent:${a.light};--accent-tint:${a.lightTint}}@media (prefers-color-scheme:dark){:root{--accent:${a.dark};--accent-tint:${a.darkTint}}}</style>`;
}
