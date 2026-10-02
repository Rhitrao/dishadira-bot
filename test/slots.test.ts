import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "../src/config";
import { availableSlots, generateSlots, holdSlot } from "../src/slots";
import { addPerson, newDb } from "./db";

// 2026-10-05 is a Monday, 2026-10-10 a Saturday, 2026-10-11 a Sunday.
const MON = "2026-10-05";
const NOW = Date.parse("2026-10-05T06:00:00Z"); // 11:30 IST Monday, before opening
const call = (ymd: string, i: number) => generateSlots(ymd, "CALL")[i];
const session = (ymd: string, i: number) => generateSlots(ymd, "SESSION")[i];

describe("slot generator", () => {
  it("makes 20 call slots and 5 session slots on a weekday", () => {
    expect(generateSlots(MON, "CALL")).toHaveLength(20);
    expect(generateSlots(MON, "SESSION")).toHaveLength(config.slots.maxSessionsPerDay);
  });

  it("gives times in IST (14:00 IST = 08:30 UTC, last call 18:45 IST = 13:15 UTC)", () => {
    const calls = generateSlots(MON, "CALL");
    expect(calls[0]).toEqual({ kind: "CALL", startUtc: "2026-10-05T08:30:00Z", endUtc: "2026-10-05T08:45:00Z" });
    expect(calls[19].startUtc).toBe("2026-10-05T13:15:00Z");
    expect(calls[19].endUtc).toBe("2026-10-05T13:30:00Z"); // 19:00 IST
    const sessions = generateSlots(MON, "SESSION");
    expect(sessions[0].startUtc).toBe("2026-10-05T08:30:00Z");
    expect(sessions[4].endUtc).toBe("2026-10-05T13:30:00Z");
  });

  it("never generates weekend slots, and nothing outside 14:00-19:00 IST", () => {
    for (const day of ["2026-10-10", "2026-10-11"]) {
      expect(generateSlots(day, "CALL")).toEqual([]);
      expect(generateSlots(day, "SESSION")).toEqual([]);
    }
    for (const s of [...generateSlots(MON, "CALL"), ...generateSlots(MON, "SESSION")]) {
      expect(s.startUtc >= "2026-10-05T08:30:00Z").toBe(true);
      expect(s.endUtc <= "2026-10-05T13:30:00Z").toBe(true);
    }
  });
});

describe("holds", () => {
  let db: D1Database;
  let close: () => Promise<void>;
  let a: number, b: number;

  beforeEach(async () => {
    ({ db, close } = await newDb());
    a = await addPerson(db, "test-person-a");
    b = await addPerson(db, "test-person-b");
  });
  afterEach(async () => {
    await close?.();
  });

  const hold = (kind: "CALL" | "SESSION", startUtc: string, ownerId: number, nowMs = NOW) =>
    holdSlot(db, { kind, startUtc, ownerId, nowMs });

  it("two simultaneous holds on the same slot: exactly one wins", async () => {
    const s = call(MON, 0);
    const results = await Promise.all([hold("CALL", s.startUtc, a), hold("CALL", s.startUtc, b)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM slots").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("a session overlapping a held call is refused, and the other way round", async () => {
    // 14:15 call lies inside the 14:00-15:00 session.
    expect((await hold("CALL", call(MON, 1).startUtc, a)).ok).toBe(true);
    expect(await hold("SESSION", session(MON, 0).startUtc, b)).toEqual({ ok: false, reason: "UNAVAILABLE" });

    // Fresh calendar: session first, then an overlapping call.
    await db.prepare("DELETE FROM slots").run();
    expect((await hold("SESSION", session(MON, 0).startUtc, a)).ok).toBe(true);
    expect(await hold("CALL", call(MON, 3).startUtc, b)).toEqual({ ok: false, reason: "UNAVAILABLE" });
    // A call after the session ends (15:00 IST) is fine.
    expect((await hold("CALL", call(MON, 4).startUtc, b)).ok).toBe(true);
  });

  it("availability list hides slots that overlap the other kind", async () => {
    await hold("SESSION", session(MON, 0).startUtc, a);
    const calls = await availableSlots(db, "CALL", MON, NOW);
    expect(calls).toHaveLength(16);
    expect(calls[0].startUtc).toBe("2026-10-05T09:30:00Z"); // 15:00 IST
    expect(await availableSlots(db, "SESSION", MON, NOW)).toHaveLength(4);
  });

  it("an expired hold frees the slot, with no cron", async () => {
    const s = call(MON, 0);
    expect((await hold("CALL", s.startUtc, a)).ok).toBe(true);
    expect((await hold("CALL", s.startUtc, b)).ok).toBe(false);
    const later = NOW + (config.holdMinutes + 1) * 60_000;
    expect((await hold("CALL", s.startUtc, b, later)).ok).toBe(true);
    const row = await db.prepare("SELECT owner_id FROM slots WHERE start_utc = ?1").bind(s.startUtc).first<{ owner_id: number }>();
    expect(row?.owner_id).toBe(b);
    // An expired session hold also frees the overlapping call.
    await db.prepare("DELETE FROM slots").run();
    await hold("SESSION", session(MON, 0).startUtc, a);
    expect((await hold("CALL", call(MON, 1).startUtc, b, later)).ok).toBe(true);
  });

  it("one person cannot hold two slots", async () => {
    expect((await hold("CALL", call(MON, 0).startUtc, a)).ok).toBe(true);
    expect(await hold("CALL", call(MON, 5).startUtc, a)).toEqual({ ok: false, reason: "ALREADY_HOLDING" });
    // After expiry they may hold again.
    const later = NOW + (config.holdMinutes + 1) * 60_000;
    expect((await hold("CALL", call(MON, 5).startUtc, a, later)).ok).toBe(true);
  });

  it("a replayed request cannot extend a hold", async () => {
    const s = call(MON, 0);
    const first = await hold("CALL", s.startUtc, a);
    const replay = await hold("CALL", s.startUtc, a, NOW + 5 * 60_000);
    expect(replay).toEqual({ ok: false, reason: "ALREADY_HOLDING" });
    const row = await db.prepare("SELECT hold_until FROM slots").first<{ hold_until: string }>();
    expect(first.ok && row?.hold_until).toBe(first.ok && first.holdUntil);
  });

  it("refuses times that are not generated slots", async () => {
    expect(await hold("CALL", "2026-10-10T08:30:00Z", a)).toEqual({ ok: false, reason: "NOT_A_SLOT" }); // Saturday
    expect(await hold("CALL", "2026-10-05T08:35:00Z", a)).toEqual({ ok: false, reason: "NOT_A_SLOT" }); // off-grid
    expect(await hold("CALL", "2026-10-05T03:30:00Z", a)).toEqual({ ok: false, reason: "NOT_A_SLOT" }); // 09:00 IST
  });
});
