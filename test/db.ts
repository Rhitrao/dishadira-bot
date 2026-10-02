import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import initSql from "../migrations/0001_init.sql?raw";

// A fresh local D1 (real workerd SQLite) with the migrations applied.
export async function newDb(): Promise<{ db: D1Database; close: () => Promise<void> }> {
  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: { DB: "test" } });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  // D1 runs one statement per prepare(); split the migration file on ";" at line ends.
  const statements = initSql
    .replace(/^--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const s of statements) await db.prepare(s).run();
  return { db, close: () => mf.dispose() };
}

export async function addPerson(db: D1Database, waId: string): Promise<number> {
  const r = await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(waId).run();
  return r.meta.last_row_id;
}
