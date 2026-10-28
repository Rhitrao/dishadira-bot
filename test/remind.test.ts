import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app, { runDailyJobs } from "../src/index";
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
const templates = config.templates as unknown as Record<string, { approved: boolean; hi: { name: string; approved: boolean } }>;
const env = (o: Record<string, string> = {}) => ({ DB: db, SENDS: "true", WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...o }) as never;
const sent = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
const scheduled = (ev: { cron: string; scheduledTime?: number }, e: unknown) =>
  (app as unknown as { scheduled: (ev: { cron: string; scheduledTime?: number }, e: unknown) => Promise<void> }).scheduled(ev, e);
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
  templates.reminder.hi.approved = false;
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
  it("the 2-minute cron runs the reminders on its first tick at or after 6:30 pm IST, once a day", async () => {
    const conv = await person(true);
    await call(conv, "2026-10-06", 0);
    const e = env({ RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b" });
    const tick = (ms: number) => scheduled({ cron: "*/2 * * * *", scheduledTime: ms }, e);
    await tick(NOW - 2 * 60_000); // 6:28 pm: too early
    expect(sent()).toHaveLength(0);
    await tick(NOW); // 6:30 pm
    expect(sent()).toHaveLength(1);
    await tick(NOW + 2 * 60_000); // 6:32 pm: already done today
    expect(sent()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'daily:reminders:2026-10-05'")).toBe(1);
    expect(config.windowHours).toBe(24);
  });

  it("a missed 6:30 pm tick only delays the reminders to the next one", async () => {
    await call(await person(true), "2026-10-06", 0);
    await scheduled({ cron: "*/2 * * * *", scheduledTime: NOW + 6 * 60_000 }, env());
    expect(sent()).toHaveLength(1);
  });

  it("while sends are paused nothing is claimed, so resuming the same evening still sends", async () => {
    await call(await person(true), "2026-10-06", 0);
    await setSetting(db, "SENDS", "false");
    expect(await runDailyJobs(env(), NOW)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'daily:%'")).toBe(0);
    await db.prepare("DELETE FROM settings WHERE key = 'SENDS'").run();
    expect(await runDailyJobs(env(), NOW + 30 * 60_000)).toEqual(["reminders"]);
    expect(sent()).toHaveLength(1);
  });

  it("the 9 pm digest runs once a day on the same cron, and old cron names do nothing", async () => {
    expect(await runDailyJobs(env(), NOW + 2 * 3_600_000)).toEqual(["reminders"]); // 8:30 pm
    expect(await runDailyJobs(env(), NOW + 2.5 * 3_600_000)).toEqual(["digest"]); // 9 pm
    expect(await runDailyJobs(env(), NOW + 2.6 * 3_600_000)).toEqual([]);
    expect(await runDailyJobs(env(), NOW + 24 * 3_600_000)).toEqual(["reminders"]); // the next day
    await scheduled({ cron: "0 13 * * *", scheduledTime: NOW + 48 * 3_600_000 }, env());
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'daily:%:2026-10-07'")).toBe(0);
  });

  it("a failed job gives its claim back, so the next tick tries again", async () => {
    await call(await person(true), "2026-10-06", 0);
    const broken = { ...(env() as object), DB: new Proxy(db, { get: (t, k) => (k === "prepare" ? (sql: string) => (/FROM intros/.test(sql) ? (() => { throw new Error("db down"); })() : t.prepare(sql)) : Reflect.get(t, k)) }) } as never;
    expect(await runDailyJobs(broken, NOW)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'daily:%'")).toBe(0);
    expect(await runDailyJobs(env(), NOW + 2 * 60_000)).toEqual(["reminders"]);
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
    expect(out[0].text.body).toMatch(/^Reminder: your call with Shantha Rao is tomorrow, Tue, 6 Oct at 2:00 pm/);
    expect(out[1].type).toBe("template");
    expect(out[1].template.name).toBe("reminder");
    expect(out[1].template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["call", "Tue, 6 Oct", "2:15 pm"]);
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

describe("Hindi reminders (ticket 11)", () => {
  const hindi = async (inWindow: boolean) => {
    const id = await person(inWindow);
    await db.prepare("UPDATE conversations SET locale = 'hi' WHERE id = ?1").bind(id).run();
    return id;
  };
  const params = (p: { template: { components: { parameters: { text: string }[] }[] } }) => p.template.components[0].parameters.map((x) => x.text);

  it("inside the window: Hindi text with Hindi day and time, for calls and for sessions", async () => {
    await call(await hindi(true), "2026-10-06", 0);
    await session(await hindi(true), "2026-10-06", 2); // 4:00 pm
    expect(await sendReminders(env())).toBe(2);
    expect(sent()[0].text.body).toBe("याद दिला दें: शांता राव जी के साथ आपकी कॉल कल, मंगल, 6 अक्टूबर को दोपहर 2:00 बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।");
    expect(sent()[1].text.body).toBe("याद दिला दें: शांता राव जी के साथ आपका सेशन कल, मंगल, 6 अक्टूबर को शाम 4:00 बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।");
  });

  it("outside the window: the Hindi template when its own flag is approved, with Hindi values", async () => {
    templates.reminder.approved = false; // the English one need not be approved
    templates.reminder.hi.approved = true;
    await call(await hindi(false), "2026-10-06", 0);
    expect(await sendReminders(env())).toBe(1);
    expect(sent()[0].template.name).toBe("reminder_hi");
    expect(sent()[0].template.language.code).toBe("hi");
    expect(params(sent()[0])).toEqual(["कॉल", "मंगल, 6 अक्टूबर", "दोपहर 2:00"]);
  });

  it("outside the window and the Hindi template is not approved: the English template with English values", async () => {
    templates.reminder.approved = true;
    templates.reminder.hi.approved = false;
    await call(await hindi(false), "2026-10-06", 0);
    expect(await sendReminders(env())).toBe(1);
    expect(sent()[0].template.name).toBe("reminder");
    expect(sent()[0].template.language.code).toBe("en");
    expect(params(sent()[0])).toEqual(["call", "Tue, 6 Oct", "2:00 pm"]);
  });

  it("neither approved: attention for Rohit, nothing sent; an English person never gets the Hindi template", async () => {
    templates.reminder.approved = false;
    await call(await hindi(false), "2026-10-06", 0);
    expect(await sendReminders(env())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(1);

    templates.reminder.hi.approved = true; // Hindi approved, English not
    await call(await person(false), "2026-10-06", 1);
    expect(await sendReminders(env())).toBe(1); // only the Hindi person (their reminder was never recorded as sent)
    expect(sent().map((p) => p.template.name)).toEqual(["reminder_hi"]);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(2);
  });

  it("every template has a Hindi version in the registry with its own flag, off by default", () => {
    for (const [name, t] of Object.entries(config.templates)) {
      expect(t.hi.name, name).toBe(`${name}_hi`);
      expect(t.hi.language).toBe("hi");
      expect(t.hi.approved, name).toBe(false);
    }
  });
});
