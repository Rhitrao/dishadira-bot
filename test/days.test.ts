// Ticket 30, the customer's side: six days Monday to Saturday as one list, holidays left out of every flow that picks a day, the
// confirmation without the business number, and "call me". All data is synthetic; Meta, Razorpay and Anthropic are fakes (test/wa.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCopy } from "../src/copy";
import { config } from "../src/config";
import { generateSlots } from "../src/slots";
import templatesDoc from "../docs/TEMPLATES.md?raw";
import { type Json, Wa } from "./wa";

const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());

// Mon 5 Oct 2026, 11:30 am in India (test/wa.ts NOW).
const rows = (p: Json): Json[] => p.interactive.action.sections.flatMap((s: Json) => s.rows);
const titles = (p: Json): string[] => rows(p).map((r) => r.title);
const holiday = (ymd: string, note = "") => w.db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)").bind(`holiday:${ymd}`, note).run();
const EN_WEEK = ["Mon, 5 Oct", "Tue, 6 Oct", "Wed, 7 Oct", "Thu, 8 Oct", "Fri, 9 Oct", "Sat, 10 Oct"];
const HI_WEEK = ["सोम, 5 अक्टूबर", "मंगल, 6 अक्टूबर", "बुध, 7 अक्टूबर", "गुरु, 8 अक्टूबर", "शुक्र, 9 अक्टूबर", "शनि, 10 अक्टूबर"];

// Everything WhatsApp enforces on a list message.
function listOk(p: Json) {
  const i = p.interactive;
  expect(i.type).toBe("list");
  expect(i.body.text.length).toBeLessThanOrEqual(1024);
  expect(i.action.button.length).toBeLessThanOrEqual(20);
  for (const s of i.action.sections) expect(s.title.length).toBeLessThanOrEqual(24);
  for (const r of rows(p)) {
    expect(r.title.length).toBeLessThanOrEqual(24);
    expect((r.description ?? "").length).toBeLessThanOrEqual(72);
  }
  expect(rows(p).length).toBeLessThanOrEqual(10);
}

async function seedPackage(conv: number) {
  const pk = await w.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(conv).run();
  await w.db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, 10, 'PURCHASE', '2026-10-05T05:00:00Z', 'system')").bind(pk.meta.last_row_id).run();
}

describe("the day step: one list of six days, Monday to Saturday", () => {
  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: the ₹99 call offers six days with a free time; Saturday yes, Sunday never; "(India time)" in the body`, async () => {
      const c = allCopy[lang];
      const from = await w.greeted(lang);
      await w.ageOk(from);
      await w.tap(from, "who_HEALING_SELF");
      const m = w.last();
      listOk(m);
      expect(m.interactive.body.text).toBe(c.chooseDay);
      expect(m.interactive.body.text).toContain(lang === "en" ? "(India time)" : "(भारतीय समय)");
      expect(m.interactive.action.button).toBe(c.listButtonDays);
      expect(titles(m)).toEqual(lang === "en" ? EN_WEEK : HI_WEEK);
      expect(rows(m)[0]).toEqual({ id: "day_HEALING_SELF_2026-10-05", title: lang === "en" ? "Mon, 5 Oct" : "सोम, 5 अक्टूबर", description: c.rowDayBoth });
    });
  }

  it("a day with only evening times left says so; a full day is skipped and the seventh working day takes its place", async () => {
    const from = await w.greeted("en");
    await w.ageOk(from);
    const other = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES ('919811111111')").run()).meta.last_row_id;
    const book = async (ymd: string, upTo: number) => {
      for (const s of generateSlots(ymd, "CALL").slice(0, upTo)) await w.db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, other).run();
    };
    await book("2026-10-07", 8); // Wednesday: 2 to 4 pm taken, evening left
    await book("2026-10-08", 20); // Thursday: full
    await w.tap(from, "who_HEALING_SELF");
    expect(titles(w.last())).toEqual(["Mon, 5 Oct", "Tue, 6 Oct", "Wed, 7 Oct", "Fri, 9 Oct", "Sat, 10 Oct", "Mon, 12 Oct"]);
    expect(rows(w.last())[2].description).toBe(allCopy.en.rowDayEvening);
  });

  it("old day buttons from a three-button message still work: they show that day's times", async () => {
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tap(from, "day_HEALING_SELF_2026-10-07");
    expect(w.last().interactive.body.text).toBe(allCopy.en.timesFor("Wed, 7 Oct"));
    await w.tap(from, "day_HEALING_SELF_2026-10-10"); // Saturday, never offered before
    expect(w.last().interactive.body.text).toBe(allCopy.en.timesFor("Sat, 10 Oct"));
  });
});

describe("holidays are left out of every flow that picks a day", () => {
  it("the ₹99 call: the holiday is skipped; its old day and time buttons get 'taken' and nothing is held", async () => {
    await holiday("2026-10-06", "family function");
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tap(from, "who_HEALING_SELF");
    expect(titles(w.last())).toEqual(["Mon, 5 Oct", "Wed, 7 Oct", "Thu, 8 Oct", "Fri, 9 Oct", "Sat, 10 Oct", "Mon, 12 Oct"]);
    expect(JSON.stringify(w.sent())).not.toContain("family function"); // the note is never shown to customers
    await w.tap(from, "day_HEALING_SELF_2026-10-06");
    expect(w.texts()).toContain(allCopy.en.slotTaken);
    expect(titles(w.last())).not.toContain("Tue, 6 Oct");
    await w.tap(from, `time_HEALING_SELF_${generateSlots("2026-10-06", "CALL")[4].startUtc}`);
    expect(w.texts().at(-2)).toBe(allCopy.en.slotTaken);
    expect(await w.count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    expect(await w.count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: a single session (soft gate, Continue) and a package session skip the holiday too`, async () => {
      await holiday("2026-10-05");
      await holiday("2026-10-10");
      const from = await w.greeted(lang);
      await w.ageOk(from);
      await w.tap(from, "gate_s");
      await w.tap(from, "ssv_HEALING");
      await w.tap(from, "swh_HEALING_SELF");
      listOk(w.last());
      const want = lang === "en" ? ["Tue, 6 Oct", "Wed, 7 Oct", "Thu, 8 Oct", "Fri, 9 Oct", "Mon, 12 Oct", "Tue, 13 Oct"] : ["मंगल, 6 अक्टूबर", "बुध, 7 अक्टूबर", "गुरु, 8 अक्टूबर", "शुक्र, 9 अक्टूबर", "सोम, 12 अक्टूबर", "मंगल, 13 अक्टूबर"];
      expect(titles(w.last())).toEqual(want);
      expect(rows(w.last())[0].id).toBe("sdy_HEALING_SELF_2026-10-06");

      const conv = (await w.conv(from)).id as number;
      await seedPackage(conv);
      await w.tap(from, "bk_new");
      await w.tap(from, "bsv_HEALING");
      await w.tap(from, "bwh_HEALING_SELF");
      expect(titles(w.last())).toEqual(want);
      // A time on the holiday from an old message: not booked, no credit used.
      await w.tap(from, `btm_HEALING_SELF_${generateSlots("2026-10-10", "SESSION")[1].startUtc}`);
      expect(await w.count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
      expect(await w.count("SELECT COALESCE(SUM(delta), 0) AS n FROM credits")).toBe(10);
    });
  }

  it("the session offer after a call skips the holiday", async () => {
    await holiday("2026-10-07");
    const from = await w.greeted("en");
    const conv = (await w.conv(from)).id as number;
    const intro = await w.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(conv).run();
    const ses = await w.db.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state) VALUES (?1, ?2, 'HEALING', 'OFFERED')").bind(conv, intro.meta.last_row_id).run();
    await w.tap(from, `sess_offer_${ses.meta.last_row_id}`);
    expect(titles(w.last())).toEqual(["Mon, 5 Oct", "Tue, 6 Oct", "Thu, 8 Oct", "Fri, 9 Oct", "Sat, 10 Oct", "Mon, 12 Oct"]);
  });
});

describe('"call me": we don\'t take calls on this number; the ₹99 call, where she calls you', () => {
  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: one message with the line and the menu buttons, and no number`, async () => {
      const c = allCopy[lang];
      for (const text of lang === "en" ? ["Call me", "can I call you?", "phone number please", "Is it a video call?", "number pls"] : ["मुझे कॉल करो", "नंबर दो", "call kar do please"]) {
        const from = await w.greeted(lang);
        await w.typed(from, text);
        const m = w.last();
        expect(m.interactive.body.text, text).toBe(c.callRequest);
        expect(m.interactive.action.buttons.map((b: Json) => b.reply.id), text).toEqual(["menu_book", "menu_pack", "menu_how"]);
        expect(w.sent()).toHaveLength(1);
        expect(JSON.stringify(w.sent())).not.toContain(config.businessNumber.replace(/\D/g, "").slice(-10));
        expect(w.aiCalls()).toHaveLength(0); // decided by code, before the assistant
      }
    });
  }

  it("not in a chat a person has taken over, nor for a blocked or quiet person, nor in the no-selling week, nor with a booking coming up", async () => {
    const human = await w.greeted("en");
    await w.db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = '2026-10-05T05:00:00Z' WHERE wa_id = ?1").bind(human).run();
    await w.typed(human, "call me");
    expect(w.texts()).not.toContain(allCopy.en.callRequest);

    const blocked = await w.greeted("en");
    await w.db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1").bind(blocked).run();
    await w.typed(blocked, "call me");
    expect(w.texts()).not.toContain(allCopy.en.callRequest);

    const quiet = await w.greeted("en");
    await w.setState(quiet, "quiet_until = '2026-10-12T00:00:00Z'");
    await w.typed(quiet, "call me");
    expect(w.texts()).not.toContain(allCopy.en.callRequest);

    const crisis = await w.greeted("en");
    await w.setState(crisis, "no_sell_until = '2026-10-12T00:00:00Z'");
    await w.typed(crisis, "call me");
    expect(w.texts()).not.toContain(allCopy.en.callRequest);

    const booked = await w.greeted("en");
    const conv = (await w.conv(booked)).id as number;
    const s = generateSlots("2026-10-06", "CALL")[0];
    await w.db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
    await w.typed(booked, "call me");

    expect(w.texts()).not.toContain(allCopy.en.callRequest);
  });

  it("a long message that only mentions calling goes to the assistant as before", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "my mother had a bad week and her sleep is poor, will Shantha Rao call me or her when we book the first call");
    expect(w.texts()).not.toContain(allCopy.en.callRequest);
    expect(w.aiCalls()).toHaveLength(1);
  });
});

describe("the confirmation never gives a number to call", () => {
  it("confirmed and rescheduled say she calls the customer's own phone, from a number they may not know; this number is for messages", () => {
    for (const lang of ["en", "hi"] as const) {
      const c = allCopy[lang];
      for (const text of [c.confirmed("Tue, 6 Oct", "5:30 pm", lang), c.rescheduled("Tue, 6 Oct", "5:30 pm")]) {
        expect(text).not.toContain(config.businessNumber);
        expect(text).not.toMatch(/\d{5} ?\d{5}/);
        expect(text).toContain(lang === "en" ? "a number you don't know" : "अनजान नंबर");
        expect(text).toContain(lang === "en" ? "This WhatsApp number is for messages only, not calls." : "यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं।");
      }
    }
  });
});

describe("the call_booked template (docs/TEMPLATES.md) has no number and two variables, as the code sends", () => {
  const block = (heading: string) => {
    const at = templatesDoc.indexOf(heading);
    expect(at, heading).toBeGreaterThan(-1);
    return /```\n([\s\S]*?)\n```/.exec(templatesDoc.slice(at))![1];
  };
  it("English and Hindi: {{1}} day and {{2}} time only; no business number; messages only", () => {
    for (const [heading, words] of [["## 1. call_booked", "This WhatsApp number is for messages only, not calls."], ["### 1. call_booked_hi", "यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं।"]] as const) {
      const body = block(heading);
      expect([...body.matchAll(/\{\{(\d)\}\}/g)].map((m) => m[1]), heading).toEqual(["1", "2"]);
      expect(body).toContain(words);
      expect(body).not.toContain(config.businessNumber);
    }
    expect(templatesDoc).not.toContain("The business number Amma calls from");
    expect(config.templates.call_booked).toMatchObject({ approved: false, hi: { approved: false } });
  });
});
