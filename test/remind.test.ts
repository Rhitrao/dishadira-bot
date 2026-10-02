import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { sendReminders } from "../src/remind";
import { generateSlots } from "../src/slots";
import { setSetting } from "../src/switches";
import { addPerson, newDb } from "./db";

// All data is synthetic. Mon 2026-10-05, 18:30 IST (13:00 UTC): the reminder cron time. Meta is mocked.
const NOW = Date.parse("2026-10-05T13:00:00Z");
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
const templates = config.templates as unknown as Record<string, { approved: boolean }>;
const env = (o: Record<string, string> = {}) => ({ DB: db, SENDS: "true", WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...o }) as never;
const sent = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

beforeEach(async () => {
  ({ db, close } = await newDb());
  templates.reminder.approved = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let n = 0;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  templates.reminder.approved = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

let wa = 919300000000;
async function person(inWindow: boolean) {
  const id = await addPerson(db, String(++wa));
  await db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(id, inWindow ? "2026-10-05T10:00:00Z" : "2026-10-01T10:00:00Z").run();
  return id;
}
async function call(conv: number, ymd: string, i: number, state = "PAID") {
  const s = generateSlots(ymd, "CALL")[i];
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
  return (await db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state) VALUES (?1,?2,'PROTECTION',?3)").bind(conv, slot.meta.last_row_id, state).run()).meta.last_row_id;
}
async function session(conv: number, ymd: string, i: number, state = "CONFIRMED") {
  const s = generateSlots(ymd, "SESSION")[i];
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
  return (await db.prepare("INSERT INTO sessions (conversation_id,slot_id,service,state) VALUES (?1,?2,'HEALING',?3)").bind(conv, slot.meta.last_row_id, state).run()).meta.last_row_id;
}

describe("day-before reminders", () => {
  it("the cron at 13:00 UTC runs the reminders, once", async () => {
    const conv = await person(true);
    await call(conv, "2026-10-06", 0);
    const e = env({ CASHFREE_APP_ID: "a", CASHFREE_SECRET: "b" });
    await (app as unknown as { scheduled: (ev: { cron: string }, e: unknown) => Promise<void> }).scheduled({ cron: "0 13 * * *" }, e);
    expect(sent()).toHaveLength(1);
    expect(config.windowHours).toBe(24);
  });

  it("sends free text inside 24h and the template outside, for calls and sessions tomorrow only", async () => {
    const a = await person(true);
    const b = await person(false);
    const c = await person(true);
    await call(a, "2026-10-06", 0); // tomorrow, in window: text
    await call(b, "2026-10-06", 1); // tomorrow, outside window: template
    await session(c, "2026-10-06", 0); // tomorrow session
    await call(await person(true), "2026-10-05", 12); // today: no
    await call(await person(true), "2026-10-07", 0); // day after: no
    await call(await person(true), "2026-10-06", 2, "HELD"); // not paid: no
    await call(await person(true), "2026-10-06", 3, "EXPIRED"); // no
    await session(await person(true), "2026-10-06", 1, "HELD"); // no
    expect(await sendReminders(env())).toBe(3);
    const out = sent();
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe("text");
    expect(out[0].text.body).toMatch(/^Reminder: your call with Shantha Rao is tomorrow, Tue 6 Oct at 2:00pm/);
    expect(out[1].type).toBe("template");
    expect(out[1].template.name).toBe("reminder");
    expect(out[1].template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["call", "Tue 6 Oct", "2:15pm"]);
    expect(out[2].text.body).toContain("your session with Shantha Rao is tomorrow");
  });

  it("is once per booking: a second run, or a re-run at midnight, sends nothing new", async () => {
    await call(await person(true), "2026-10-06", 0);
    await session(await person(false), "2026-10-06", 0);
    expect(await sendReminders(env())).toBe(2);
    expect(await sendReminders(env())).toBe(0);
    expect(await sendReminders(env(), NOW + 60_000)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE dedupe_key LIKE 'reminder:%'")).toBe(2);
  });

  it("is skipped while SENDS is paused (env off or paused in settings) and is sent once sends resume", async () => {
    await call(await person(true), "2026-10-06", 0);
    expect(await sendReminders(env({ SENDS: "false" }))).toBe(0);
    await setSetting(db, "SENDS", "false");
    expect(await sendReminders(env())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) AS n FROM messages")).toBe(0); // nothing recorded, so nothing is blocked later
    await db.prepare("DELETE FROM settings WHERE key = 'SENDS'").run();
    expect(await sendReminders(env())).toBe(1);
  });

  it("an unapproved template raises attention instead of sending; a blocked person gets nothing", async () => {
    templates.reminder.approved = false;
    const out = await person(false);
    await call(out, "2026-10-06", 0);
    const blocked = await person(true);
    await call(blocked, "2026-10-06", 1);
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(blocked).run();
    expect(await sendReminders(env())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(1);
  });
});
