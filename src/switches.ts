// Switches in the settings table. The env flags in wrangler.toml are the master: a setting can only turn something OFF
// that the env allows, never ON. Stored values: NEW_BOOKINGS="false" (paused), SENDS="false" (paused), AMMA_AWAY="true" (away).
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "./env";
import { iso } from "./slots";

export const SWITCHES = ["NEW_BOOKINGS", "AMMA_AWAY", "SENDS"] as const;
export type SwitchName = (typeof SWITCHES)[number];
export const isSwitch = (v: unknown): v is SwitchName => typeof v === "string" && (SWITCHES as readonly string[]).includes(v);

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, value, iso(Date.now()))
    .run();
}

export type SwitchState = { name: SwitchName; envOn: boolean; paused: boolean; on: boolean };

// "paused" means the setting asks for off. "on" is what actually happens: env allows AND the setting does not pause it.
export async function switchStates(env: Env): Promise<SwitchState[]> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('NEW_BOOKINGS','AMMA_AWAY','SENDS')").all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  const away = s.get("AMMA_AWAY") === "true";
  const bookingsPaused = s.get("NEW_BOOKINGS") === "false" || away; // away pauses new bookings too
  const sendsPaused = s.get("SENDS") === "false";
  return [
    { name: "NEW_BOOKINGS", envOn: env.NEW_BOOKINGS === "true", paused: bookingsPaused, on: env.NEW_BOOKINGS === "true" && !bookingsPaused },
    // For AMMA_AWAY "on" means "Amma is away" (the setting is the whole story; the env has no say).
    { name: "AMMA_AWAY", envOn: true, paused: false, on: away },
    { name: "SENDS", envOn: env.SENDS === "true", paused: sendsPaused, on: env.SENDS === "true" && !sendsPaused },
  ];
}

export async function bookingsOpen(env: Env): Promise<boolean> {
  return (await switchStates(env)).find((s) => s.name === "NEW_BOOKINGS")!.on;
}
export async function sendsOn(env: Env): Promise<boolean> {
  return (await switchStates(env)).find((s) => s.name === "SENDS")!.on;
}
