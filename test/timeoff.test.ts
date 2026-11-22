// Ticket 55: time off for part of a day. A block inside the working hours takes the times that overlap it off the list and out of every new
// hold or booking, leaves bookings already there alone, and is added and removed in Calendar → Days off by the owner and the practitioner (not
// staff), with the form's token, an audit row and the same refusals as a whole day off. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSlots, holdSlot, availableSlots, isTimeOff } from "../src/slots";
import { parseBlock, keyFor } from "../src/timeoff";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";

const NOW = Date.parse("2026-11-24T04:00:00Z"); // Tue 9:30 am India time
const DAY = "2026-11-25"; // Wednesday
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());
const add = async (as = OWNER, f: Record<string, string> = {}) => h.post("/app/calendar/timeoff", { csrf: await h.tokenFor(as, "timeoff:add"), day: DAY, from: "16:00", to: "17:00", ...f }, as);
const person = async (wa: string) => {
  await h.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(wa).run();
  return (await h.db.prepare("SELECT id FROM conversations WHERE wa_id = ?1").bind(wa).first<{ id: number }>())!.id;
};
const base = Date.parse(`${DAY}T00:00:00+05:30`);
const overlaps = (s: { startUtc: string; endUtc: string }) => (Date.parse(s.startUtc) - base) / 60_000 < 17 * 60 && (Date.parse(s.endUtc) - base) / 60_000 > 16 * 60;

describe("the form's values", () => {
  it("accepts a block inside the hours and refuses the rest", () => {
    expect(parseBlock(DAY, "16:00", "17:00", NOW)).toEqual({ ymd: DAY, startMin: 960, endMin: 1020 });
    for (const [d, a, b] of [[DAY, "17:00", "16:00"], [DAY, "16:00", "16:00"], [DAY, "13:00", "15:00"], [DAY, "18:00", "20:00"], [DAY, "16:02", "17:00"], [DAY, "x", "17:00"], ["2026-11-01", "16:00", "17:00"], ["2027-06-01", "16:00", "17:00"], ["nope", "16:00", "17:00"]])
      expect(parseBlock(d, a, b, NOW), `${d} ${a} ${b}`).toBeNull();
  });
});

describe("the engine", () => {
  it("takes overlapping times off the list, calls and sessions, and keeps the others", async () => {
    await h.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, '', '2026-11-24T00:00:00Z')").bind(keyFor(DAY, 960, 1020)).run();
    for (const kind of ["CALL", "SESSION"] as const) {
      const free = await availableSlots(h.db, kind, DAY, NOW);
      expect(free.length, kind).toBeGreaterThan(0);
      expect(free.some(overlaps), kind).toBe(false);
      const all = generateSlots(DAY, kind);
      expect(all.some(overlaps)).toBe(true);
      expect(free.length).toBeLessThan(all.length);
    }
  });
  it("refuses a hold inside a block and allows one outside it", async () => {
    await h.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, '', '2026-11-24T00:00:00Z')").bind(keyFor(DAY, 960, 1020)).run();
    const owner = await person("919000000001");
    const inside = generateSlots(DAY, "CALL").find(overlaps)!;
    const outside = generateSlots(DAY, "CALL").find((s) => !overlaps(s))!;
    expect(await isTimeOff(h.db, inside.startUtc, inside.endUtc)).toBe(true);
    expect(await holdSlot(h.db, { kind: "CALL", startUtc: inside.startUtc, ownerId: owner, nowMs: NOW })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect((await holdSlot(h.db, { kind: "CALL", startUtc: outside.startUtc, ownerId: owner, nowMs: NOW })).ok).toBe(true);
  });
  it("other days are not affected", async () => {
    await h.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, '', '2026-11-24T00:00:00Z')").bind(keyFor(DAY, 960, 1020)).run();
    const other = generateSlots("2026-11-26", "CALL")[0];
    expect(await isTimeOff(h.db, other.startUtc, other.endUtc)).toBe(false);
  });
});

describe("the console", () => {
  it("the owner adds and removes a block: audited, shown in Days off", async () => {
    const r = await add();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("m=timeoff");
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key = ?1", keyFor(DAY, 960, 1020))).toBe(1);
    expect(await h.audits("TIMEOFF_ADDED")).toHaveLength(1);
    const page = await (await h.get("/app/calendar?view=week")).text();
    expect(page).toContain("Blocked times");
    expect(page).toContain("16:00 to 17:00");
    const key = keyFor(DAY, 960, 1020);
    const rm = await h.post("/app/calendar/timeoff/remove", { csrf: await h.tokenFor(OWNER, `timeoff:remove:${key}`), key });
    expect(rm.status).toBe(303);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'timeoff:%'")).toBe(0);
    expect(await h.audits("TIMEOFF_REMOVED")).toHaveLength(1);
  });
  it("a bad time, a wrong token and staff are refused; the practitioner may", async () => {
    expect((await add(OWNER, { from: "13:00" })).headers.get("location")).toContain("m=timeoffbad");
    expect((await h.post("/app/calendar/timeoff", { csrf: "wrong", day: DAY, from: "16:00", to: "17:00" })).status).toBe(403);
    expect((await add(STAFF)).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'timeoff:%'")).toBe(0);
    expect((await add(PRAC)).status).toBe(303);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'timeoff:%'")).toBe(1);
  });
  it("a repeat changes nothing and a day holds at most six", async () => {
    await add();
    await add();
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'timeoff:%'")).toBe(1);
    for (const [a, b] of [["14:00", "14:15"], ["14:30", "14:45"], ["15:00", "15:15"], ["15:30", "15:45"], ["17:30", "17:45"]]) await add(OWNER, { from: a, to: b });
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'timeoff:%'")).toBe(6);
    expect((await add(OWNER, { from: "18:00", to: "18:15" })).headers.get("location")).toContain("m=timeofffull");
  });
});
