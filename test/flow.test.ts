import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { allCopy } from "../src/copy";
import { isMenuWord, plainWord } from "../src/whatsapp";
import { generateSlots, holdSlot, nextWorkingDays, spreadTimes, type Slot } from "../src/slots";
import { applySql, migrations, newDb } from "./db";
import { FakeRazorpay, paidEvent, rzpEnv, rzpHeaders } from "./razorpay";

// English + Hindi, the booking steps, media, menu words, HUMAN mode and the first-message question (ticket 11).
// All data is synthetic. Mon 2026-10-05, 11:30 IST. Meta and Razorpay are mocked: nothing is sent anywhere.
const SECRET = "test-app-secret";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const DAY = 86_400_000;
const call = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "CALL")[i];
const sessionSlot = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "SESSION")[i];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wa = any;
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let fake: FakeRazorpay;
let n = 0;
let sends = "true";

const env = () => ({ DB: db, SENDS: sends, NEW_BOOKINGS: "true", WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "v", WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...rzpEnv() }) as never;
const sent = (): Wa[] => fetchMock.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com")).map((c) => JSON.parse((c[1] as { body: string }).body));
const last = (): Wa => sent().at(-1);
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

async function sign(raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw) } }, env());
}
const stamp = () => String(Math.floor(Date.now() / 1000));
const wrap = (from: string, extra: object) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: `wamid.T${++n}`, from, timestamp: stamp(), ...extra }] } }] }] });
const typed = (from: string, body: string) => post(wrap(from, { type: "text", text: { body } }));
const tapButton = (from: string, id: string) => post(wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } }));
const tapRow = (from: string, id: string) => post(wrap(from, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title: id } } }));
const media = (from: string, type: string) => post(wrap(from, { type, [type]: { id: "media-id-1" } }));

// Everything WhatsApp enforces on a message we send.
function violations(p: Wa): string[] {
  const v: string[] = [];
  if (p.type === "text") return p.text.body.length > 4096 ? ["text over 4096"] : v;
  if (p.type !== "interactive") return v;
  const i = p.interactive;
  if (i.body.text.length > 1024) v.push(`body ${i.body.text.length} > 1024`);
  if (i.type === "button") {
    const b = i.action.buttons;
    if (b.length < 1 || b.length > 3) v.push(`${b.length} buttons`);
    for (const x of b) {
      if (x.reply.title.length < 1 || x.reply.title.length > 20) v.push(`button "${x.reply.title}" > 20`);
      if (x.reply.id.length > 256) v.push("button id > 256");
    }
  } else if (i.type === "list") {
    const secs = i.action.sections;
    const rows = secs.flatMap((s: Wa) => s.rows);
    if (i.action.button.length < 1 || i.action.button.length > 20) v.push(`list button "${i.action.button}" > 20`);
    if (rows.length < 1 || rows.length > 10) v.push(`${rows.length} rows`);
    if (secs.length > 10) v.push("sections > 10");
    for (const s of secs) {
      if (s.rows.length === 0) v.push("empty section");
      if (s.title.length < 1 || s.title.length > 24) v.push(`section "${s.title}" > 24`);
    }
    for (const r of rows) {
      if (r.title.length < 1 || r.title.length > 24) v.push(`row title "${r.title}" > 24`);
      if ((r.description ?? "").length > 72) v.push(`row description "${r.description}" > 72`);
      if (r.id.length > 200) v.push("row id > 200");
    }
  } else if (i.type === "cta_url") {
    if (i.action.parameters.display_text.length > 20) v.push("cta label > 20");
  }
  return v;
}
const allWithinLimits = () => {
  const bad = sent().flatMap((p) => violations(p).map((x) => `${JSON.stringify(p.interactive?.body?.text ?? p.text?.body).slice(0, 40)}: ${x}`));
  expect(bad).toEqual([]);
};
const buttonIds = (p: Wa): string[] => p.interactive.action.buttons.map((b: Wa) => b.reply.id);
const buttonTitles = (p: Wa): string[] => p.interactive.action.buttons.map((b: Wa) => b.reply.title);
const rowsOf = (p: Wa): Wa[] => p.interactive.action.sections.flatMap((s: Wa) => s.rows);

let phone = 919810000000;
const newPhone = () => String(++phone);
async function convOf(from: string) {
  return (await db.prepare("SELECT id, mode, locale, age_ok_at, first_question_msg FROM conversations WHERE wa_id = ?1").bind(from).first<Wa>())!;
}
// A greeted person with a chosen language, ready for the menu.
async function greeted(lang: "en" | "hi" = "en", from = newPhone()) {
  await typed(from, "hi");
  await tapButton(from, `lang_${lang}`);
  fetchMock.mockClear();
  return from;
}
const ageOk = (from: string) => db.prepare("UPDATE conversations SET age_ok_at = '2026-01-01T00:00:00Z' WHERE wa_id = ?1").bind(from).run();

beforeEach(async () => {
  ({ db, close } = await newDb());
  sends = "true";
  fake = new FakeRazorpay();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }), { status: 200 });
    return fake.handle(u, init) ?? new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

describe("the whole booking, in both languages, within WhatsApp's limits", () => {
  it("the limits checker itself catches a bad message", () => {
    const long = (n: number) => "x".repeat(n);
    expect(violations({ type: "interactive", interactive: { type: "button", body: { text: "b" }, action: { buttons: [{ reply: { id: "a", title: long(21) } }] } } })).toHaveLength(1);
    expect(violations({ type: "interactive", interactive: { type: "list", body: { text: long(1025) }, action: { button: long(21), sections: [{ title: long(25), rows: [{ id: "a", title: long(25), description: long(73) }] }, { title: "t", rows: [] }] } } }).length).toBeGreaterThanOrEqual(6);
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: greeting, menu, FAQ list, language row, age, service, who for, days, times, pay`, async () => {
      const c = allCopy[lang];
      const from = newPhone();
      await typed(from, "hello");
      expect(sent()).toHaveLength(1); // one greeting message
      expect(buttonTitles(last())).toEqual(["English", "हिंदी"]);
      expect(last().interactive.body.text).toBe(allCopy.en.greeting);

      await tapButton(from, `lang_${lang}`);
      expect(last().interactive.body.text).toBe(c.menuBody);
      expect(buttonTitles(last())).toEqual([c.btnBook, c.btnPackages, c.btnHelp]);
      expect(buttonIds(last())).toEqual(["menu_book", "menu_pack", "menu_how"]);

      await tapButton(from, "menu_how");
      const faq = rowsOf(last());
      expect(faq.map((r) => r.id)).toEqual([...config.faqIds.map((id) => `faq_${id}`), "menu_bookings", "menu_person", "menu_lang"]);
      expect(faq.at(-1).title).toBe(c.changeLanguageRow);
      expect(faq[0].title).toBe(c.faqTitles.what_is_this);
      await tapRow(from, "menu_lang");
      expect(buttonTitles(last())).toEqual(["English", "हिंदी"]);
      expect(last().interactive.body.text).toBe(c.chooseLanguage);
      await tapRow(from, "faq_timings");
      expect(last().interactive.body.text).toBe(c.faqAnswers.timings); // ticket 18: the answer and the menu buttons in one message
      expect(buttonIds(last())).toEqual(["menu_book", "menu_pack", "menu_how"]);

      await tapButton(from, "menu_book");
      expect(last().interactive.body.text).toBe(c.ageCheck);
      expect(buttonTitles(last())).toEqual([c.btnYes, c.btnNo]);
      await tapButton(from, "age_yes");
      expect(last().interactive.body.text).toBe(c.chooseService);
      expect(buttonTitles(last())).toEqual([c.btnHealing, c.btnCleansing]);
      expect(buttonIds(last())).toEqual(["svc_HEALING", "svc_PROTECTION"]);
      await tapButton(from, "svc_PROTECTION");
      expect(last().interactive.body.text).toBe(c.whoFor);
      expect(buttonTitles(last())).toEqual([c.btnMe, c.btnFamily, c.btnPet]);
      await tapButton(from, "who_PROTECTION_PET");
      expect(last().interactive.body.text).toBe(c.chooseDay);
      expect(buttonTitles(last())).toEqual(lang === "en" ? ["Mon, 5 Oct", "Tue, 6 Oct", "Wed, 7 Oct"] : ["सोम, 5 अक्टूबर", "मंगल, 6 अक्टूबर", "बुध, 7 अक्टूबर"]);
      await tapButton(from, buttonIds(last())[1]); // Tuesday
      const times = last();
      expect(times.interactive.body.text).toBe(c.timesFor(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर"));
      expect(times.interactive.action.button).toBe(c.listButtonTimes);
      expect(times.interactive.action.sections.map((s: Wa) => s.title)).toEqual([c.sectionAfternoon, c.sectionEvening]);
      const rows = rowsOf(times);
      expect(rows).toHaveLength(10);
      expect(rows[0]).toEqual({ id: `time_PROTECTION_PET_${call(0, "2026-10-06").startUtc}`, title: lang === "en" ? "2:00 pm" : "दोपहर 2:00", description: c.rowCall });
      expect(rows.at(-1)).toEqual({ id: "more_PROTECTION_PET", title: c.anotherDay });
      expect(rows.at(-2).title).toBe(lang === "en" ? "6:00 pm" : "शाम 6:00");

      await tapRow(from, rows[2].id); // 3:00 pm
      const pay = last();
      expect(pay.interactive.type).toBe("cta_url");
      expect(pay.interactive.body.text).toBe(c.payBody(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर", lang === "en" ? "3:00 pm" : "दोपहर 3:00"));
      expect(pay.interactive.action.parameters.display_text).toBe(c.payLabel);
      expect(await db.prepare("SELECT service, for_whom, call_lang FROM intros").first()).toEqual({ service: "PROTECTION", for_whom: "PET", call_lang: lang });
      allWithinLimits();
    });
  }

  it("the longest Hindi dates still fit: day buttons and time rows in September, February and December", async () => {
    const from = await greeted("hi");
    await ageOk(from);
    const seen: string[] = [];
    for (const day of [Date.UTC(2026, 8, 1, 6, 0), Date.UTC(2027, 1, 1, 6, 0), Date.UTC(2027, 11, 28, 6, 0)]) {
      vi.setSystemTime(day);
      await tapButton(from, "who_HEALING_SELF");
      seen.push(...buttonTitles(last()));
      await tapButton(from, buttonIds(last())[0]);
    }
    expect(seen).toContain("मंगल, 1 सितंबर");
    expect(seen).toContain("सोम, 1 फ़रवरी");
    allWithinLimits();
  }, 60_000);
});

describe("the time list: the spread rule, sections and full days", () => {
  const slotsOf = (ymd: string): Slot[] => generateSlots(ymd, "CALL");
  const hhmm = (s: Slot) => new Date(Date.parse(s.startUtc) + 330 * 60_000).toISOString().slice(11, 16);

  it("one time per half hour, :00 and :30 first; a taken half hour is filled by :15 or :45; at most 9, latest dropped", () => {
    const all = slotsOf("2026-10-06");
    expect(spreadTimes(all, 9).map(hhmm)).toEqual(["14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"]);
    const without = (...times: string[]) => all.filter((s) => !times.includes(hhmm(s)));
    expect(spreadTimes(without("14:00"), 9).map(hhmm).slice(0, 3)).toEqual(["14:15", "14:30", "15:00"]);
    expect(spreadTimes(without("14:30"), 9).map(hhmm).slice(0, 3)).toEqual(["14:00", "14:45", "15:00"]);
    expect(spreadTimes(without("14:00", "14:15"), 9).map(hhmm).slice(0, 2)).toEqual(["14:30", "15:00"]); // no time left in that half hour
    expect(spreadTimes(without("14:30", "14:45"), 9).map(hhmm).slice(0, 2)).toEqual(["14:00", "15:00"]);
    expect(spreadTimes(without("14:00", "14:30"), 9).map(hhmm).slice(0, 3)).toEqual(["14:15", "14:45", "15:00"]);
    expect(spreadTimes(without("14:00", "14:15", "14:30", "14:45"), 9).map(hhmm)[0]).toBe("15:00");
    expect(spreadTimes(all, 9)).toHaveLength(9);
    expect(spreadTimes(all.slice(0, 3), 9).map(hhmm)).toEqual(["14:00", "14:30"]); // 14:00, 14:15 and 14:30
  });

  it("in the chat: 9 times and 'Another day' make 10 rows, in two sections, with the latest times dropped", async () => {
    const from = await greeted("en");
    await ageOk(from);
    await tapButton(from, "day_HEALING_SELF_2026-10-06");
    const l = last();
    expect(l.interactive.action.sections.map((s: Wa) => s.title)).toEqual(["Afternoon", "Evening"]);
    expect(l.interactive.action.sections[0].rows.map((r: Wa) => r.title)).toEqual(["2:00 pm", "2:30 pm", "3:00 pm", "3:30 pm"]); // before 4 pm
    expect(l.interactive.action.sections[1].rows.map((r: Wa) => r.title)).toEqual(["4:00 pm", "4:30 pm", "5:00 pm", "5:30 pm", "6:00 pm", "Another day"]); // from 4 pm
    expect(rowsOf(l)).toHaveLength(10);
    expect(rowsOf(l).some((r) => r.title === "6:30 pm")).toBe(false);
    allWithinLimits();
  });

  it("in the chat: taken quarter-hours are used when a half hour is taken, held slots are not offered", async () => {
    const from = await greeted("en");
    await ageOk(from);
    const [a, b, c] = [newPhone(), newPhone(), newPhone()];
    for (const [who, i] of [[a, 0], [b, 2], [c, 3]] as const) {
      const id = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(who).run()).meta.last_row_id;
      await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(call(i, "2026-10-06").startUtc, call(i, "2026-10-06").endUtc, id).run();
    }
    // 14:00 taken -> 14:15; 14:30 and 14:45 taken -> nothing for that half hour
    await tapButton(from, "day_HEALING_SELF_2026-10-06");
    expect(rowsOf(last()).slice(0, 3).map((r) => r.title)).toEqual(["2:15 pm", "3:00 pm", "3:30 pm"]);
  });

  it("a day with only evening times has no Afternoon section; a day with only afternoon times has no Evening section", async () => {
    const from = await greeted("hi");
    await ageOk(from);
    vi.setSystemTime(Date.parse("2026-10-05T10:30:00Z")); // 16:00 IST: with the 60-minute lead the first bookable time is 17:15
    await tapButton(from, "day_HEALING_SELF_2026-10-05");
    expect(last().interactive.action.sections.map((s: Wa) => s.title)).toEqual(["शाम"]);
    expect(rowsOf(last()).at(-1).title).toBe("दूसरा दिन");
    expect(rowsOf(last())[0].title).toBe("शाम 5:15"); // 5:00 is not far enough ahead, so the quarter stands in

    vi.setSystemTime(NOW);
    const other = await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run();
    for (const s of slotsOf("2026-10-07").filter((x) => hhmm(x) >= "16:00")) {
      await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, other.meta.last_row_id).run();
    }
    await tapButton(from, "day_HEALING_SELF_2026-10-07");
    expect(last().interactive.action.sections.map((s: Wa) => s.title)).toEqual(["दोपहर"]);
    expect(rowsOf(last()).at(-1).title).toBe("दूसरा दिन");
    allWithinLimits();
  });

  it("'Another day' shows the days again; full days are skipped; no free day sends noSlots", async () => {
    const from = await greeted("en");
    await ageOk(from);
    const other = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run()).meta.last_row_id;
    const fill = async (ymd: string) => {
      for (const s of slotsOf(ymd)) await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, other).run();
    };
    await fill("2026-10-06"); // Tuesday is full: the next working day with free times takes its place (ticket 18)
    await tapButton(from, "more_HEALING_SELF");
    expect(buttonTitles(last())).toEqual(["Mon, 5 Oct", "Wed, 7 Oct", "Thu, 8 Oct"]);
    // Tuesday's button is still in the chat: the day is full, so it says so and shows the days again.
    await tapButton(from, "day_HEALING_SELF_2026-10-06");
    expect(sent().at(-2).text.body).toBe(allCopy.en.slotTaken);
    expect(buttonTitles(last())).toEqual(["Mon, 5 Oct", "Wed, 7 Oct", "Thu, 8 Oct"]);
    await fill("2026-10-05");
    await fill("2026-10-07");
    await tapButton(from, "more_HEALING_SELF");
    expect(buttonTitles(last())).toEqual(["Thu, 8 Oct", "Fri, 9 Oct", "Mon, 12 Oct"]);
    for (const ymd of nextWorkingDays(Date.now(), config.booking.lookaheadDays)) if (!["2026-10-05", "2026-10-06", "2026-10-07"].includes(ymd)) await fill(ymd);
    await tapButton(from, "more_HEALING_SELF");
    expect(last().text.body).toBe(allCopy.en.noSlots);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE owner_id IN (SELECT id FROM conversations WHERE wa_id = '" + from + "')")).toBe(0);
  });

  it("a time taken while the person was choosing: 'just taken' and the same day's times again without it, no hold, no payment", async () => {
    const from = await greeted("en");
    await ageOk(from);
    const other = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run()).meta.last_row_id;
    expect((await holdSlot(db, { kind: "CALL", startUtc: call(2, "2026-10-06").startUtc, ownerId: other, nowMs: Date.now() })).ok).toBe(true); // 2:30 pm
    await tapRow(from, `time_HEALING_SELF_${call(2, "2026-10-06").startUtc}`);
    expect(sent().at(-2).text.body).toBe(allCopy.en.slotTaken);
    expect(last().interactive.type).toBe("list");
    expect(rowsOf(last()).slice(0, 3).map((r) => r.title)).toEqual(["2:00 pm", "2:45 pm", "3:00 pm"]); // the held 2:30 is not offered again; 2:45 stands in
    expect(await count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM intros")).toBe(0);
  });

  it("a time someone is holding right now is not offered, even though the hold will lapse before the 60-minute lead is over", async () => {
    const from = await greeted("en");
    await ageOk(from);
    const other = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run()).meta.last_row_id;
    await holdSlot(db, { kind: "CALL", startUtc: call(0, "2026-10-05").startUtc, ownerId: other, nowMs: Date.now() }); // 2:00 pm today
    await tapButton(from, "day_HEALING_SELF_2026-10-05");
    expect(rowsOf(last()).slice(0, 2).map((r) => r.title)).toEqual(["2:15 pm", "2:30 pm"]);
    vi.setSystemTime(NOW + 21 * 60_000); // the hold has lapsed
    await tapButton(from, "day_HEALING_SELF_2026-10-05");
    expect(rowsOf(last())[0].title).toBe("2:00 pm");
  });
});

describe("old and odd button ids never cause an error", () => {
  const failed = () => count("SELECT COUNT(*) AS n FROM events WHERE status = 'FAILED'");

  it("an old slot_ row books that exact time, as before; the person is not asked who it is for", async () => {
    const from = await greeted("en");
    await ageOk(from);
    await tapRow(from, `slot_PROTECTION_${call(2).startUtc}`);
    expect(last().interactive.type).toBe("cta_url");
    expect(last().interactive.body.text).toBe(allCopy.en.payBody("Mon, 5 Oct", "2:30 pm"));
    expect(await db.prepare("SELECT service, for_whom, call_lang, state FROM intros").first()).toEqual({ service: "PROTECTION", for_whom: null, call_lang: "en", state: "HELD" });
    expect(await failed()).toBe(0);
  });

  it("an old slot_ row for a time that is gone: 'just taken', then who the call is for", async () => {
    const from = await greeted("hi");
    await ageOk(from);
    const other = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run()).meta.last_row_id;
    await holdSlot(db, { kind: "CALL", startUtc: call(2).startUtc, ownerId: other, nowMs: Date.now() });
    await tapRow(from, `slot_HEALING_${call(2).startUtc}`);
    expect(sent().at(-2).text.body).toBe(allCopy.hi.slotTaken);
    expect(buttonIds(last())).toEqual(["who_HEALING_SELF", "who_HEALING_FAMILY", "who_HEALING_PET"]);
  });

  it("an old slot_ row from someone who was never asked their age gets the age question first", async () => {
    const from = await greeted("en");
    await tapRow(from, `slot_PROTECTION_${call(2).startUtc}`);
    expect(last().interactive.body.text).toBe(allCopy.en.ageCheck);
    expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
  });

  it("old buttons from the first version still work: lang_kn, menu_ask, svc_PROTECTION", async () => {
    const from = newPhone();
    await typed(from, "hi");
    await tapButton(from, "lang_kn");
    expect((await convOf(from)).locale).toBe("en");
    expect(last().interactive.body.text).toBe(allCopy.en.menuBody);
    await tapButton(from, "menu_ask");
    expect(last().text.body).toBe(allCopy.en.askPrompt);
    await ageOk(from);
    await tapButton(from, "svc_PROTECTION");
    expect(buttonIds(last())[0]).toBe("who_PROTECTION_SELF");
    expect(await failed()).toBe(0);
  });

  it("garbage ids are ignored without an error", async () => {
    const from = await greeted("en");
    await ageOk(from);
    for (const id of [
      "slot_", "slot_PROTECTION_", "slot_PROTECTION_notadate", "slot_NOPE_2026-10-05T08:30:00Z", "slot_protection_2026-10-05T08:30:00Z",
      "time_PROTECTION_ROBOT_2026-10-05T08:30:00Z", "time_PROTECTION_SELF_nope", "day_PROTECTION_SELF_x", "day_NOPE_SELF_2026-10-05",
      "who_PROTECTION_ROBOT", "who_NOPE_SELF", "more_NOPE_SELF", "svc_NOPE", "svc_", "age_maybe", "sday_999_2026-10-05", "smore_999", "sess_999_2026-10-05T08:30:00Z",
      "sess_offer_999", "resched_999_2026-10-05T08:30:00Z", "faq_nope", "menu_nope", "x".repeat(300),
    ]) {
      expect((await tapRow(from, id)).status, id).toBe(200);
    }
    expect(await failed()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    allWithinLimits();
  });

  it("a day button whose date is not a working day shows the day's times as 'taken' and the days again", async () => {
    const from = await greeted("en");
    await ageOk(from);
    await tapButton(from, "day_HEALING_SELF_2026-10-10"); // a Saturday
    expect(sent().at(-2).text.body).toBe(allCopy.en.slotTaken);
    expect(last().interactive.type).toBe("button");
  });
});

describe("the age check is asked once", () => {
  it("menu_book asks; Yes is stored and the next booking goes straight to the service", async () => {
    const from = await greeted("en");
    await tapButton(from, "menu_book");
    expect(last().interactive.body.text).toBe(allCopy.en.ageCheck);
    expect((await convOf(from)).age_ok_at).toBeNull();
    await tapButton(from, "age_yes");
    const stored = (await convOf(from)).age_ok_at;
    expect(stored).toBe("2026-10-05T06:00:00Z");
    expect(buttonIds(last())).toEqual(["svc_HEALING", "svc_PROTECTION"]);
    vi.setSystemTime(NOW + 3 * DAY);
    await tapButton(from, "menu_book");
    expect(buttonIds(last())).toEqual(["svc_HEALING", "svc_PROTECTION"]); // not asked again
    await tapButton(from, "age_yes"); // an old Yes button tapped again keeps the first answer
    expect((await convOf(from)).age_ok_at).toBe(stored);
    expect(sent().filter((p) => p.interactive?.body?.text === allCopy.en.ageCheck)).toHaveLength(1);
  });

  it("No gets the parent message and stops; nothing is stored and no later step works until Yes", async () => {
    const from = await greeted("hi");
    await tapButton(from, "menu_book");
    await tapButton(from, "age_no");
    expect(last().text.body).toBe(allCopy.hi.ageNo);
    expect((await convOf(from)).age_ok_at).toBeNull();
    // An old service, who or day button in the chat cannot skip the question.
    for (const id of ["svc_HEALING", "who_HEALING_SELF", "day_HEALING_SELF_2026-10-06", `time_HEALING_SELF_${call(0).startUtc}`, "more_HEALING_SELF"]) {
      await tapButton(from, id);
      expect(last().interactive.body.text, id).toBe(allCopy.hi.ageCheck);
    }
    expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM intros")).toBe(0);
    await tapButton(from, "age_yes");
    expect(buttonIds(last())).toEqual(["svc_HEALING", "svc_PROTECTION"]);
  });

  it("while booking is closed nothing is asked", async () => {
    const from = await greeted("en");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('NEW_BOOKINGS', 'false')").run();
    await tapButton(from, "menu_book");
    expect(last().text.body).toBe(allCopy.en.bookSoon);
  });
});

describe("photos, voice notes and files", () => {
  const TYPES = ["audio", "image", "video", "sticker", "document", "location", "contacts"];

  it("as the very first message: only the greeting", async () => {
    const from = newPhone();
    await media(from, "image");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].interactive.body.text).toBe(allCopy.en.greeting);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
    expect((await convOf(from)).first_question_msg).toBeNull();
  });

  it("no booking: the first one each day gets the notice and the menu, later ones nothing, and the next day again", async () => {
    for (const lang of ["en", "hi"] as const) {
      const from = await greeted(lang);
      await media(from, "audio");
      expect(sent()).toHaveLength(2);
      expect(sent()[0].text.body).toBe(allCopy[lang].mediaNotice);
      expect(buttonTitles(sent()[1])).toEqual([allCopy[lang].btnBook, allCopy[lang].btnPackages, allCopy[lang].btnHelp]);
      for (const t of TYPES) await media(from, t);
      expect(sent()).toHaveLength(2);
      expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
      vi.setSystemTime(Date.now() + DAY);
      await media(from, "sticker");
      expect(sent()).toHaveLength(4);
      vi.setSystemTime(NOW);
    }
  });

  it("every kind of non-text message counts, and nothing is ever downloaded", async () => {
    for (const t of TYPES) {
      const from = await greeted("en");
      await media(from, t);
      expect(sent()[0].text.body, t).toBe(allCopy.en.mediaNotice);
    }
    for (const c of fetchMock.mock.calls) {
      expect(String(c[0])).toMatch(/graph\.facebook\.com\/v[\d.]+\/1000\/messages$/); // only sending
      expect((c[1] as { method: string }).method).toBe("POST");
    }
  });

  async function withContext(kind: "hold" | "payment" | "booking") {
    const from = await greeted("en");
    const conv = (await convOf(from)).id as number;
    const s = call(4, "2026-10-06");
    if (kind === "hold") await holdSlot(db, { kind: "CALL", startUtc: s.startUtc, ownerId: conv, nowMs: Date.now() });
    else {
      const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state,hold_until) VALUES ('CALL',?1,?2,?3,?4,?5)").bind(s.startUtc, s.endUtc, conv, kind === "booking" ? "BOOKED" : "HELD", kind === "payment" ? "2026-10-05T05:00:00Z" : null).run();
      const intro = await db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state) VALUES (?1,?2,'HEALING',?3)").bind(conv, slot.meta.last_row_id, kind === "booking" ? "PAID" : "HELD").run();
      if (kind === "payment") await db.prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,amount_paise,state,created_at) VALUES ('razorpay','INTRO',?1,'di-intro-x',9900,'PENDING','2026-10-05T05:30:00Z')").bind(intro.meta.last_row_id).run();
    }
    return { from, conv };
  }

  for (const kind of ["hold", "payment", "booking"] as const) {
    it(`with a ${kind}: an attention item for Rohit and the customer notice, no menu, every time`, async () => {
      const { from, conv } = await withContext(kind);
      await media(from, "image");
      expect(sent()).toHaveLength(1);
      expect(sent()[0].text.body).toBe(allCopy.en.mediaNoticeCustomer);
      expect(await db.prepare("SELECT kind, target FROM attention WHERE resolved_at IS NULL").all()).toMatchObject({ results: [{ kind: "MEDIA_FROM_CUSTOMER", target: `conv:${conv}` }] });
      await media(from, "document");
      expect(sent()).toHaveLength(2); // each one is answered; still one open item
      expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(1);
    });
  }

  it("a hold that has lapsed and a booking from months ago do not count", async () => {
    const from = await greeted("en");
    const conv = (await convOf(from)).id as number;
    await holdSlot(db, { kind: "CALL", startUtc: call(4, "2026-10-06").startUtc, ownerId: conv, nowMs: NOW - 3_600_000 }); // lapsed an hour ago
    const old = call(1, "2026-07-06");
    await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(old.startUtc, old.endUtc, conv).run();
    await media(from, "image");
    expect(sent()[0].text.body).toBe(allCopy.en.mediaNotice);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });
});

describe("menu words", () => {
  it("plainWord ignores case, spaces, punctuation and emoji", () => {
    expect(plainWord("  Hello!! 🙏  ")).toBe("hello");
    expect(plainWord("नमस्ते।")).toBe("नमस्ते");
    expect(plainWord("Hi... 😊👍")).toBe("hi");
    expect(plainWord("🙏")).toBe("");
    expect(plainWord("Namaste,\n\n")).toBe("namaste");
  });
  it("only the listed words, and only on their own", () => {
    for (const w of ["hi", "hii", "hello", "hey", "namaste", "namaskar", "menu", "start", "नमस्ते", "नमस्कार", "हाय", "मेनू"]) expect(isMenuWord(w), w).toBe(true);
    for (const w of ["HI", " Hello ", "Menu!", "START.", "namaste 🙏", "नमस्ते!", "HELLO", "Hey!!!", "  hii...  "]) expect(isMenuWord(w), w).toBe(true);
    for (const w of ["hi there", "hello doctor", "हाय हाय", "hello hello", "book", "ok", "", "🙏", "hiii", "help", "menu please"]) expect(isMenuWord(w), w).toBe(false);
  });

  it("after the first greeting, a menu word gets the menu: no attention item and no ack, in both languages", async () => {
    for (const lang of ["en", "hi"] as const) {
      const from = await greeted(lang);
      for (const w of ["hi", "Hello!", " MENU ", "नमस्ते", "Namaste 🙏", "start", "हाय", "मेनू", "Hey."]) {
        fetchMock.mockClear();
        await typed(from, w);
        expect(sent(), w).toHaveLength(1);
        expect(buttonTitles(last()), w).toEqual([allCopy[lang].btnBook, allCopy[lang].btnPackages, allCopy[lang].btnHelp]);
      }
      expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM messages WHERE dedupe_key LIKE '%:ack'")).toBe(0);
    }
  });

  it("anything else is free text: one ack and an attention item", async () => {
    const from = await greeted("en");
    await typed(from, "hi there, I need help");
    expect(last().text.body).toBe(allCopy.en.ack);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'FREE_TEXT'")).toBe(1);
  });
});

describe("talk to a person, and HUMAN mode", () => {
  it("sets HUMAN, raises one HUMAN_REQUEST (however often they tap) and sends the handoff message", async () => {
    for (const lang of ["en", "hi"] as const) {
      const from = await greeted(lang);
      await tapButton(from, "menu_person");
      expect(last().text.body).toBe(allCopy[lang].handoffAck);
      const conv = await convOf(from);
      expect(conv.mode).toBe("HUMAN");
      await tapButton(from, "menu_person");
      expect(await db.prepare("SELECT COUNT(*) AS n FROM attention WHERE kind = 'HUMAN_REQUEST' AND target = ?1 AND resolved_at IS NULL").bind(`conv:${conv.id}`).first()).toEqual({ n: 1 });
    }
  });

  it("free text and photos get no bot reply and no new item; they wait for Rohit. A menu word gets the menu and the chat stays HUMAN", async () => {
    const from = await greeted("en");
    await tapButton(from, "menu_person");
    fetchMock.mockClear();
    await typed(from, "when will someone reply?");
    await media(from, "image");
    await media(from, "audio");
    expect(sent()).toHaveLength(1); // ticket 18: one short acknowledgement for this handoff, nothing more
    expect(last().text.body).toBe(allCopy.en.humanWaitAck);
    await typed(from, "hi");
    await typed(from, "menu");
    expect(sent()).toHaveLength(3); // the menu, twice
    expect(last().interactive.body.text).toBe(allCopy.en.menuBody);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(1); // just the HUMAN_REQUEST
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'IN' AND body LIKE 'when will%'")).toBe(1); // stored, for the reply box
    expect((await convOf(from)).mode).toBe("HUMAN");
  });

  it("button taps still work in HUMAN mode: menu, FAQ, language and the whole booking, and the chat stays HUMAN", async () => {
    const from = await greeted("hi");
    await tapButton(from, "menu_person");
    fetchMock.mockClear();
    await tapButton(from, "menu_how");
    expect(last().interactive.type).toBe("list");
    await tapRow(from, "faq_price");
    expect(last().interactive.body.text).toBe(allCopy.hi.faqAnswers.price);
    await tapRow(from, "menu_lang");
    expect(buttonTitles(last())).toEqual(["English", "हिंदी"]);
    await tapButton(from, "lang_en");
    expect(last().interactive.body.text).toBe(allCopy.en.menuBody);
    await tapButton(from, "menu_book");
    await tapButton(from, "age_yes");
    await tapButton(from, "svc_HEALING");
    await tapButton(from, "who_HEALING_SELF");
    await tapButton(from, "day_HEALING_SELF_2026-10-06");
    await tapRow(from, `time_HEALING_SELF_${call(2, "2026-10-06").startUtc}`);
    expect(last().interactive.type).toBe("cta_url");
    expect(await count("SELECT COUNT(*) AS n FROM intros WHERE state = 'HELD'")).toBe(1);
    expect((await convOf(from)).mode).toBe("HUMAN");
  });

  it("a template quick-reply tap works in HUMAN mode too (the session offer)", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    const intro = await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(conv.id).run();
    await db.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state) VALUES (?1, ?2, 'HEALING', 'OFFERED')").bind(conv.id, intro.meta.last_row_id).run();
    await tapButton(from, "menu_person");
    fetchMock.mockClear();
    await post(wrap(from, { type: "button", button: { payload: "Choose a time", text: "Choose a time" } }));
    expect(rowsOf(last()).map((r) => r.id)).toEqual([expect.stringMatching(/^sess_offer_\d+$/), "go_p10", "go_p20"]); // the options: single, 10 or 20
  });

  it("a blocked person gets nothing, button or not", async () => {
    const from = await greeted("en");
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'test', 'test')").bind(from).run();
    fetchMock.mockClear();
    await tapButton(from, "menu_how");
    await tapButton(from, "menu_person");
    expect(sent()).toHaveLength(0);
  });
});

describe("a question in the very first message", () => {
  it("is kept, and answered (today: the ack and an item for Rohit) after the language tap", async () => {
    const from = newPhone();
    await typed(from, "What is pranic healing? Can it help my mother?");
    expect(sent()).toHaveLength(1); // only the greeting
    const kept = await convOf(from);
    const msgId = (await db.prepare("SELECT wa_message_id AS id FROM messages WHERE conversation_id = ?1 AND direction = 'IN'").bind(kept.id).first<{ id: string }>())!.id;
    expect(kept.first_question_msg).toBe(msgId);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);

    await tapButton(from, "lang_hi");
    expect(sent()).toHaveLength(3);
    expect(sent()[1].text.body).toBe(allCopy.hi.ack); // in the language just chosen
    expect(sent()[2].interactive.body.text).toBe(allCopy.hi.menuBody);
    expect(await count(`SELECT COUNT(*) AS n FROM attention WHERE kind = 'FREE_TEXT' AND target = 'conv:${kept.id}'`)).toBe(1);
    expect((await convOf(from)).first_question_msg).toBeNull();

    await tapButton(from, "menu_lang"); // changing language later does not answer it again
    await tapButton(from, "lang_en");
    expect(sent().filter((p) => p.text?.body === allCopy.hi.ack || p.text?.body === allCopy.en.ack)).toHaveLength(1);
  });

  it("a greeting, menu word, emoji or button as the first message is not a question", async () => {
    for (const first of ["hi", "Hello!", "नमस्ते", "🙏", "...", "menu"]) {
      const from = newPhone();
      await typed(from, first);
      expect((await convOf(from)).first_question_msg, first).toBeNull();
      fetchMock.mockClear();
      await tapButton(from, "lang_en");
      expect(sent(), first).toHaveLength(1); // only the menu
    }
    const from = newPhone();
    await tapButton(from, "menu_book");
    expect((await convOf(from)).first_question_msg).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("if the greeting could not go out (SENDS off), the question is still the first one that counts", async () => {
    sends = "false";
    const from = newPhone();
    await typed(from, "Do you do video calls?");
    await typed(from, "hello?");
    const kept = await convOf(from);
    expect(kept.first_question_msg).not.toBeNull();
    sends = "true";
    await typed(from, "hi");
    await tapButton(from, "lang_en");
    expect(sent().some((p) => p.text?.body === allCopy.en.ack)).toBe(true);
  });
});

describe("dates, times and call language after the payment", () => {
  async function bookAndPay(lang: "en" | "hi") {
    const from = await greeted(lang);
    await tapButton(from, "menu_book");
    await tapButton(from, "age_yes");
    await tapButton(from, "svc_HEALING");
    await tapButton(from, "who_HEALING_FAMILY");
    await tapButton(from, "day_HEALING_FAMILY_2026-10-06");
    await tapRow(from, `time_HEALING_FAMILY_${call(14, "2026-10-06").startUtc}`); // 5:30 pm
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    const raw = JSON.stringify(paidEvent(link));
    const res = await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env());
    expect(res.status).toBe(200);
    return from;
  }

  it("Hindi: the confirmation uses Hindi dates and says the call is in Hindi", async () => {
    await bookAndPay("hi");
    expect(last().text.body).toBe(allCopy.hi.confirmed("मंगल, 6 अक्टूबर", "शाम 5:30", "hi", config.businessNumber));
    expect(last().text.body).toContain("कॉल हिंदी में होगी");
    expect(last().text.body).toContain("शाम 5:30 बजे");
  });
  it("English: Wed-style dates and 'Call in English'", async () => {
    await bookAndPay("en");
    expect(last().text.body).toBe(`Received your ₹99. Shantha Rao will call you on Tue, 6 Oct at 5:30 pm from ${config.businessNumber}. Call in English. That number is for her calls only, so please message us here.`);
  });
  it("the call language is the chat language at booking; changing language later changes the chat, not the booking", async () => {
    const from = newPhone();
    await typed(from, "hi");
    await tapButton(from, "lang_hi");
    await tapButton(from, "menu_book");
    await tapButton(from, "age_yes");
    await tapButton(from, "svc_PROTECTION");
    await tapButton(from, "who_PROTECTION_SELF");
    await tapButton(from, "day_PROTECTION_SELF_2026-10-06");
    await tapRow(from, `time_PROTECTION_SELF_${call(0, "2026-10-06").startUtc}`);
    await tapButton(from, "lang_en"); // the person switches the chat to English before paying
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    const raw = JSON.stringify(paidEvent(link));
    await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env());
    expect(last().text.body).toContain("Tue, 6 Oct at 2:00 pm"); // the message is in the chat language
    expect(last().text.body).toContain("Call in Hindi"); // the call is in the language it was booked in
  });
});

describe("the session picker uses the same day and time steps", () => {
  async function offered(lang: "en" | "hi") {
    const from = await greeted(lang);
    const conv = await convOf(from);
    const intro = await db.prepare("INSERT INTO intros (conversation_id, service, state, for_whom, call_lang) VALUES (?1, 'PROTECTION', 'CALLED_SESSION', 'SELF', ?2)").bind(conv.id, lang).run();
    const ses = await db.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state) VALUES (?1, ?2, 'PROTECTION', 'OFFERED')").bind(conv.id, intro.meta.last_row_id).run();
    return { from, sid: ses.meta.last_row_id };
  }

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: offer -> days -> times with the session wording -> pay; no age, service or who-for step`, async () => {
      const c = allCopy[lang];
      const { from, sid } = await offered(lang);
      await tapButton(from, `sess_offer_${sid}`);
      expect(last().interactive.body.text).toBe(c.chooseDay);
      expect(buttonIds(last())).toEqual([`sday_${sid}_2026-10-05`, `sday_${sid}_2026-10-06`, `sday_${sid}_2026-10-07`]);
      await tapButton(from, `sday_${sid}_2026-10-06`);
      const l = last();
      expect(l.interactive.body.text).toBe(c.sessionTimesFor(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर"));
      expect(rowsOf(l).map((r) => r.id)).toEqual([...[0, 1, 2, 3, 4].map((i) => `sess_${sid}_${sessionSlot(i, "2026-10-06").startUtc}`), `smore_${sid}`]);
      expect(rowsOf(l)[0]).toEqual({ id: `sess_${sid}_${sessionSlot(0, "2026-10-06").startUtc}`, title: lang === "en" ? "2:00 pm" : "दोपहर 2:00", description: c.rowSession });
      await tapRow(from, `smore_${sid}`);
      expect(last().interactive.body.text).toBe(c.chooseDay);
      await tapButton(from, `sday_${sid}_2026-10-06`);
      await tapRow(from, rowsOf(last())[2].id); // 4:00 pm
      expect(last().interactive.type).toBe("cta_url");
      expect(last().interactive.body.text).toBe(c.sessionPayBody(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर", lang === "en" ? "4:00 pm" : "शाम 4:00"));
      expect(last().interactive.action.parameters.display_text).toBe(c.sessionPayLabel);
      expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(sid).first()).toEqual({ state: "HELD" });
      allWithinLimits();
    });
  }

  it("someone else's offer, an unknown session and a full day never cause an error", async () => {
    const { sid } = await offered("en");
    const other = await greeted("en");
    await tapButton(other, `sday_${sid}_2026-10-06`);
    expect(last().text.body).toBe(allCopy.en.sessionNotAvailable);
    await tapButton(other, "sday_999_2026-10-06");
    await tapButton(other, "smore_999");
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE status = 'FAILED'")).toBe(0);
  });

  it("no free session day: the no-times message and an item for Rohit", async () => {
    const { from, sid } = await offered("en");
    const other = (await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(newPhone()).run()).meta.last_row_id;
    for (const ymd of nextWorkingDays(Date.now(), config.booking.lookaheadDays)) {
      for (const s of generateSlots(ymd, "SESSION")) await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, other).run();
    }
    await tapButton(from, `sess_offer_${sid}`);
    expect(last().text.body).toBe(allCopy.en.noSessionSlots);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'NO_SESSION_SLOTS'")).toBe(1);
  });
});

describe("migration 0005", () => {
  it("moves Kannada conversations to English, keeps everything else, and adds the new columns", async () => {
    const old = await newDb(4); // before this ticket
    try {
      for (const [wa, locale] of [["919800000001", "kn"], ["919800000002", "en"], ["919800000003", "kn"]]) {
        await old.db.prepare("INSERT INTO conversations (wa_id, locale) VALUES (?1, ?2)").bind(wa, locale).run();
      }
      await old.db.prepare("INSERT INTO intros (conversation_id, service) VALUES (1, 'HEALING')").run();
      await applySql(old.db, migrations.hindiSql);
      expect((await old.db.prepare("SELECT wa_id, locale, age_ok_at, first_question_msg FROM conversations ORDER BY id").all()).results).toEqual([
        { wa_id: "919800000001", locale: "en", age_ok_at: null, first_question_msg: null },
        { wa_id: "919800000002", locale: "en", age_ok_at: null, first_question_msg: null },
        { wa_id: "919800000003", locale: "en", age_ok_at: null, first_question_msg: null },
      ]);
      expect(await old.db.prepare("SELECT for_whom, call_lang FROM intros").first()).toEqual({ for_whom: null, call_lang: null }); // old bookings stay as they were
      await old.db.prepare("UPDATE intros SET for_whom = 'PET', call_lang = 'hi'").run();
      await expect(old.db.prepare("UPDATE intros SET for_whom = 'ROBOT'").run()).rejects.toThrow();
      await expect(old.db.prepare("UPDATE intros SET call_lang = 'kn'").run()).rejects.toThrow();
    } finally {
      await old.close();
    }
  });
});
