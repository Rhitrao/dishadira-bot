// Ticket 36 B: a time typed at the time step. "2pm to 4", "after 4", "shaam 5", "evening" book the earliest free time in that range, on
// the same path as a tap (hold + payment link, every guard); a time outside the hours, "now" or "call me now" get one short line above the
// same list; nothing free in the range says so; the identical re-prompt never goes twice in a row: the second miss hands the chat to
// the team. Hours come from config. All data is synthetic; WhatsApp, Razorpay and email are fakes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCopy } from "../src/copy";
import { generateSlots, iso } from "../src/slots";
import { parseTypedTime } from "../src/steps";
import { NOW, Wa, type Json } from "./wa";

const w = new Wa();
const EN = allCopy.en;
const HI = allCopy.hi;
const DAY = "2026-10-06"; // Tue; NOW is Mon 5 Oct, 11:30 am India time
const body = (p: Json): string => p?.text?.body ?? p?.interactive?.body?.text ?? "";
const rowIds = (p: Json): string[] => p?.interactive?.action?.sections?.flatMap((s: Json) => s.rows.map((r: Json) => r.id)) ?? [];
const at = (hhmm: string, ymd = DAY) => iso(Date.parse(`${ymd}T${hhmm}:00+05:30`));

beforeEach(async () => {
  await w.start();
  w.aiFlag = "false"; // live: the assistant is off
});
afterEach(() => w.stop());

// A greeted, 18+ person looking at the call times for Tue 6 Oct.
async function atTimes(lang: "en" | "hi" = "en") {
  const from = await w.greeted(lang);
  await w.ageOk(from);
  await w.tap(from, "menu_book");
  await w.tap(from, "svc_HEALING");
  await w.tap(from, "who_HEALING_SELF");
  await w.tapRow(from, `day_HEALING_SELF_${DAY}`);
  const list = w.last();
  expect(list.interactive.type).toBe("list");
  w.fetchMock.mockClear();
  return { from, list };
}
// Someone else books these call times.
async function takenBy(...times: string[]) {
  const other = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES ('919800000999')").run()).meta.last_row_id;
  for (const t of times) {
    const s = generateSlots(DAY, "CALL").find((x) => x.startUtc === at(t))!;
    await w.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED')").bind(s.startUtc, s.endUtc, other).run();
  }
}
const heldStart = (from: string) =>
  w.db
    .prepare("SELECT s.start_utc AS s FROM slots s JOIN conversations c ON c.id = s.owner_id WHERE c.wa_id = ?1 AND s.state = 'HELD' AND s.hold_until > ?2")
    .bind(from, iso(Date.now()))
    .first<{ s: string }>()
    .then((r) => r?.s ?? null);

describe("reading a typed time", () => {
  const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  it("English and Hinglish forms", () => {
    const cases: [string, [string, string] | "now" | null][] = [
      ["2", ["14:00", "15:00"]], ["2pm", ["14:00", "15:00"]], ["2 pm", ["14:00", "15:00"]], ["2 P.M.", ["14:00", "15:00"]], ["2:30", ["14:30", "15:30"]],
      ["4.30 pm", ["16:30", "17:30"]], ["14:00", ["14:00", "15:00"]], ["2pm to 4", ["14:00", "16:00"]], ["2pm-4pm", ["14:00", "16:00"]],
      ["between 3 and 5", ["15:00", "17:00"]], ["3 se 5 tak", ["15:00", "17:00"]], ["after 4", ["16:00", "24:00"]], ["4 ke baad", ["16:00", "24:00"]],
      ["before 4", ["00:00", "16:00"]], ["4 baje", ["16:00", "17:00"]], ["shaam 5", ["17:00", "18:00"]], ["शाम 5 बजे", ["17:00", "18:00"]],
      ["दोपहर 3 बजे", ["15:00", "16:00"]], ["evening", ["16:00", "21:00"]], ["afternoon", ["12:00", "16:00"]], ["ok call me at 3", ["15:00", "16:00"]],
      ["morning after 9 am", ["09:00", "12:00"]], ["9", ["09:00", "10:00"]],
      ["now", "now"], ["right now", "now"], ["now r u free call me", "now"], ["abhi", "now"],
      ["what is the price for 2 sessions", null], ["Sunday please", null], ["3 5", null], ["ok call me at", null], ["hello", null],
    ];
    for (const [text, want] of cases) {
      const got = parseTypedTime(text);
      if (want === null || want === "now") expect(got, text).toBe(want);
      else expect(got, text).toEqual({ from: m(want[0]), to: m(want[1]) });
    }
  });
  it("the list's own day may be named; another day is not read as a time", () => {
    expect(parseTypedTime("tuesday 3pm", ["tuesday", "tue"])).toEqual({ from: 900, to: 960 });
    expect(parseTypedTime("tomorrow 3pm", ["tuesday", "tue"])).toBeNull();
  });
});

describe("a typed time at the time step", () => {
  it("'2pm to 4' holds the earliest free time in the range, exactly as the tap would (the pay message with the link)", async () => {
    const { from } = await atTimes();
    await w.typed(from, "2pm to 4");
    expect(w.sent()).toHaveLength(1);
    expect(w.last().interactive.type).toBe("cta_url");
    expect(body(w.last())).toContain("Tue, 6 Oct at 2:00 pm is held for you");
    expect(await heldStart(from)).toBe(at("14:00"));
    expect(await w.count("SELECT COUNT(*) AS n FROM payments WHERE state = 'PENDING'")).toBe(1);
    expect((await w.conv(from)).pending_step).toBe("pay");
  });

  it("the earliest free one: 'after 4' with 4:00 taken holds 4:15 (a time the list had no row for counts too)", async () => {
    const { from } = await atTimes();
    await takenBy("16:00");
    await w.typed(from, "after 4");
    expect(body(w.last())).toContain("Tue, 6 Oct at 4:15 pm is held for you");
    expect(await heldStart(from)).toBe(at("16:15"));
  });

  it("'2' at the time step is 2 pm, never the second row; 'shaam 5', 'evening' and '4 baje' too", async () => {
    // One person after another, so each one's hold takes that time from the next: "4 baje" gets 4:15 once "evening" holds 4:00.
    for (const [said, want] of [["2", "14:00"], ["shaam 5", "17:00"], ["evening", "16:00"], ["4 baje", "16:15"]] as const) {
      const { from } = await atTimes();
      await w.typed(from, said);
      expect(await heldStart(from), said).toBe(at(want));
    }
  }, 60_000);

  it("Hindi: 'शाम 5 बजे' holds 5 pm, and the pay message is in Hindi", async () => {
    const { from } = await atTimes("hi");
    await w.typed(from, "शाम 5 बजे");
    expect(await heldStart(from)).toBe(at("17:00"));
    expect(body(w.last())).toContain("मंगल, 6 अक्टूबर");
  });

  it("the guards of the tap still hold: a person already holding a time gets the old hold released, never two", async () => {
    const { from } = await atTimes();
    await w.typed(from, "3pm");
    await w.tap(from, "menu_book");
    await w.tap(from, "svc_HEALING");
    await w.tap(from, "who_HEALING_SELF");
    await w.tapRow(from, `day_HEALING_SELF_${DAY}`);
    await w.typed(from, "5pm");
    expect(await w.count("SELECT COUNT(*) AS n FROM slots WHERE state = 'HELD' AND hold_until > '2026-10-05T06:00:00Z'")).toBe(1);
    expect(await heldStart(from)).toBe(at("17:00"));
  });

  it("nothing free in the range: says so once, above the same list; nothing is held", async () => {
    const { from, list } = await atTimes();
    await takenBy("14:00", "14:15", "14:30", "14:45");
    await w.typed(from, "between 2 and 3");
    expect(w.sent()).toHaveLength(1);
    expect(body(w.last())).toBe(`${EN.timeNoneThen("Tue, 6 Oct")}\n\n${body(list)}`);
    expect(rowIds(w.last())).toEqual(rowIds(list));
    expect(await heldStart(from)).toBeNull();
    expect((await w.conv(from)).pending_reprompts).toBe(1);
  });

  it("outside the hours ('morning after 9 am') and 'now' / 'call me now': one short line with the hours, above the same list", async () => {
    for (const [said, line] of [["morning after 9 am", EN.timeOutside], ["9", EN.timeOutside], ["now r u free call me", EN.timeNow], ["call me now", EN.timeNow], ["ok call me at", EN.timeNow]] as const) {
      const { from, list } = await atTimes();
      await w.typed(from, said);
      expect(w.texts(), said).toEqual([`${line}\n\n${body(list)}`]);
      expect(rowIds(w.last())).toEqual(rowIds(list));
      expect(await heldStart(from)).toBeNull();
    }
    expect(EN.timeOutside).toContain("Monday to Saturday, 2 pm to 7 pm (India time)"); // from config.hours
    expect(HI.timeNow).toContain(HI.hintDays);
  });

  it("the identical re-prompt never goes twice in a row: the second miss hands the chat to the team (HUMAN, the item, the email, the usual message)", async () => {
    const { from } = await atTimes();
    await w.typed(from, "morning after 9 am");
    await w.typed(from, "now r u free call me");
    const texts = w.texts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(EN.timeOutside);
    expect(texts[1]).toBe(EN.handoffAck);
    const c = await w.conv(from);
    expect(c.mode).toBe("HUMAN");
    expect(c.pending_step).toBeNull();
    expect(await w.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'HUMAN_REQUEST' AND resolved_at IS NULL")).toBe(1);
    expect(w.emails.map((e) => e.subject)).toEqual(["A customer needs help choosing a time"]);
    expect(w.emails[0].text).not.toContain("now r u free"); // never what they wrote
    // From here the team answers: the bot sends its one "with our team" note, and nothing else.
    await w.typed(from, "ok call me at");
    await w.typed(from, "2pm to 4");
    expect(w.texts().slice(2)).toEqual([EN.humanWaitAck]);
    expect(await heldStart(from)).toBeNull();
  });

  it("text that isn't a time: the re-prompt once, then the team; never the same message twice", async () => {
    const { from } = await atTimes();
    await w.typed(from, "Sunday please");
    await w.typed(from, "Sunday please");
    const texts = w.texts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(EN.reprompt(EN.hintDays));
    expect(texts[1]).toBe(EN.handoffAck);
    expect(w.sent().some((p) => body(p) === EN.repromptHelp)).toBe(false);
  });

  it("a tap between two misses starts the count again; a question with an answer is not a miss", async () => {
    const { from } = await atTimes();
    await w.typed(from, "9 am");
    await w.tapRow(from, `day_HEALING_SELF_${DAY}`); // the day again: a new time list
    await w.typed(from, "what is the price");
    await w.typed(from, "morning");
    expect((await w.conv(from)).mode).toBe("BOT");
    expect(w.texts().at(-1)).toContain(EN.timeOutside);
  });

  it("the assistant (AI_REPLIES on) is not asked about a typed time", async () => {
    w.aiFlag = "true";
    const { from } = await atTimes();
    await w.typed(from, "2pm to 4");
    expect(w.aiCalls()).toHaveLength(0);
    expect(await heldStart(from)).toBe(at("14:00"));
  });

  it("the session time list understands typed times too", async () => {
    const from = await w.greeted();
    const c = (await w.conv(from)).id as number;
    const i = await w.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(c).run();
    const s = await w.db.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state) VALUES (?1, ?2, 'HEALING', 'OFFERED')").bind(c, i.meta.last_row_id).run();
    await w.tap(from, `sess_offer_${s.meta.last_row_id}`);
    const day = rowIds(w.last()).find((id) => id.endsWith(DAY))!;
    await w.tapRow(from, day);
    expect(rowIds(w.last())[0]).toMatch(/^sess_/);
    await w.typed(from, "after 4");
    expect(w.last().interactive.type).toBe("cta_url");
    expect(await w.count(`SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION' AND state = 'HELD' AND start_utc = '${at("16:00")}'`)).toBe(1);
  });
});

it("NOW is the Monday the tests assume", () => expect(iso(NOW)).toBe("2026-10-05T06:00:00Z"));
