import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import initSql from "../migrations/0001_init.sql?raw";
import messagesSql from "../migrations/0002_messages_skipped.sql?raw";
import outcomesSql from "../migrations/0003_outcomes_refunds.sql?raw";
import paidSql from "../migrations/0004_paid_amount_declined.sql?raw";
import hindiSql from "../migrations/0005_hindi_booking_steps.sql?raw";
import gatekeeperSql from "../migrations/0006_gatekeeper.sql?raw";
import packagesSql from "../migrations/0007_packages.sql?raw";
import handoffSql from "../migrations/0008_handoff.sql?raw";
import adClickSql from "../migrations/0009_ad_click.sql?raw";

// D1 runs one statement per prepare(); split a migration file on ";" at line ends.
export async function applySql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const s of statements) await db.prepare(s).run();
}

export const migrations = { initSql, messagesSql, outcomesSql, paidSql, hindiSql, gatekeeperSql, packagesSql, handoffSql, adClickSql };

// A fresh local D1 (real workerd SQLite) with the migrations applied. `through` stops early (4 = before the Hindi/booking-steps migration, 5 = before the gatekeeper migration, 6 = before the packages migration, 7 = before the handoff migration, 8 = before the ad-click migration).
export async function newDb(through = 9): Promise<{ db: D1Database; close: () => Promise<void> }> {
  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: { DB: "test" } });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySql(db, [initSql, messagesSql, outcomesSql, paidSql, hindiSql, gatekeeperSql, packagesSql, handoffSql, adClickSql].slice(0, through).join("\n"));
  return { db, close: () => mf.dispose() };
}

// Tests of the booking, payment and reminder steps start from someone who has already said they are 18+ (the age gate has its own tests).
export async function addPerson(db: D1Database, waId: string, ageOk = true): Promise<number> {
  const r = await db.prepare("INSERT INTO conversations (wa_id, age_ok_at) VALUES (?1, ?2)").bind(waId, ageOk ? "2026-01-01T00:00:00Z" : null).run();
  return r.meta.last_row_id;
}
