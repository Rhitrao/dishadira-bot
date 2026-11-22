// Ticket 52 (CONTRACT v20): the Karmic Coaching front door behind KARMIC_FRONT_DOOR (src/frontdoor.ts): "What would you like help with?",
// the Karmic Clarity Call recommended first, the topic's services to book directly (with NEW_SERVICES on too), the topic kept on the booking
// and shown to the team, the ₹99 call's new name, and the booking_confirmed template behind config. The Tarot reading and the hypnosis
// session exist only in these tests. All data synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { alertPayload } from "../src/alerts";
import { loadPrices } from "../src/business";
import { config } from "../src/config";
import { allCopy, BRAND_LINE, karmicCopy, setFrontDoorWords, type Copy, type Lang } from "../src/copy";
import { cameFor, clarityLabel, TOPICS } from "../src/frontdoor";
import { sendReminders } from "../src/remind";
import { hasPhrase } from "../src/safety";
import { removeOldNames, wipePersonStmts } from "../src/wipe";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";
import { karmicKeys } from "./copydoc";
import { newDb } from "./db";
import { paidEvent, rzpHeaders } from "./razorpay";
import { NOW, Wa, type Json } from "./wa";

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

// The catalogue and the words' flag are module state (set at the start of each request): put back the seeded catalogue and the flag off.
async function reset() {
  const fresh = await newDb();
  await loadPrices({ DB: fresh.db });
  await fresh.close();
  setFrontDoorWords({});
}

async function addServices(db: D1Database, o: { callFirst?: boolean } = {}) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, active, public, sort, intake_en, intake_hi)
         VALUES ('tarot_reading', 'Tarot reading', 'टैरो रीडिंग', 'UNDERSTAND', 30, 49900, ?1, 1, 1, 30, 'What question would you like to bring to your reading?', 'आप अपनी रीडिंग में कौन सा सवाल लाना चाहेंगे?')`,
      )
      .bind(o.callFirst ? 1 : 0),
    db.prepare("INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, active, public, sort) VALUES ('guided_hypnosis', 'Guided hypnosis', 'गाइडेड हिप्नोसिस', 'REWIRE', 60, 150000, 1, 1, 40)"),
  ]);
}

// These drive whole chats through the Worker (two in the first test); CI's 20 seconds a test is too short for them.
vi.setConfig({ testTimeout: 90_000 });

const w = new Wa();
beforeEach(() => w.start());
afterEach(async () => {
  await w.stop();
  await reset();
});

const bodyOf = (p: Json): string => p?.text?.body ?? p?.interactive?.body?.text ?? "";
const rowsOf = (p: Json): Json[] => p.interactive?.action?.rows ?? (p.interactive?.action?.sections ?? []).flatMap((s: Json) => s.rows);
const buttonsOf = (p: Json): string[] => (p.interactive?.action?.buttons ?? []).map((b: Json) => b.reply.id);
const buttonTitles = (p: Json): string[] => (p.interactive?.action?.buttons ?? []).map((b: Json) => b.reply.title);
const pay = async (link: string, amount: number) => {
  const raw = JSON.stringify(paidEvent(link, { amount }));
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, w.env());
};
const linkOf = async () => (await w.db.prepare("SELECT provider_link_id AS l FROM payments ORDER BY id DESC LIMIT 1").first<{ l: string }>())!.l;
const len = (t: string) => [...t].length;

describe("KARMIC_FRONT_DOOR 'false' (live): every message is exactly as before", () => {
  // A whole chat: the greeting, the menu, Book and a ₹99 call booked and paid, My bookings, Sessions & packages, an old topic button, and a
  // reading-safety worry.
  async function chat(): Promise<Json[]> {
    const from = w.newPhone();
    await w.typed(from, "hi");
    await w.tap(from, "lang_en");
    await w.typed(from, "book");
    await w.tap(from, "age_yes");
    await w.tap(from, "svc_HEALING");
    await w.tap(from, "who_HEALING_SELF");
    await w.tapRow(from, "day_HEALING_SELF_2026-10-06");
    await w.tapRow(from, "time_HEALING_SELF_2026-10-06T08:30:00Z");
    await pay(await linkOf(), 9900);
    await w.tap(from, "menu_bookings");
    await w.tap(from, "menu_pack");
    await w.tapRow(from, "pk_single");
    await w.tap(from, "tp_DECISION");
    await w.typed(from, "someone did black magic on me");
    // Ticket 53: the session's "Healing or Energy cleansing?" step, Help and its answers, and an old "Who is it for?" row (nothing).
    await w.tap(from, "gate_s");
    await w.tap(from, "menu_how");
    await w.tapRow(from, "faq_what_is_this");
    await w.tapRow(from, "faq_how_it_works");
    await w.tapRow(from, "faq_who_for");
    return w.sent().map((p: Json) => ({ ...p, to: "x" }));
  }

  it("the same messages, byte for byte, with the flag unset and 'false'; none of the front door's words or ids", async () => {
    const unset = await chat();
    await w.stop();
    await w.start();
    w.frontDoor = "false";
    const off = await chat();
    expect(off).toEqual(unset);
    const all = JSON.stringify(off);
    for (const word of ["Karmic", "कार्मिक", "Coaching", "tp_", "What would you like help with"]) expect(all).not.toContain(word);
    expect(bodyOf(off[0])).toBe(allCopy.en.greeting);
    expect(buttonTitles(off[1])).toEqual([allCopy.en.btnBook, allCopy.en.btnPackages, allCopy.en.btnHelp]);
    expect(buttonTitles(off[1])[0]).toBe("Book ₹99 call");
    expect(bodyOf(off[2])).toBe(allCopy.en.ageCheck); // "book" goes straight to the call's steps
    expect(off.map(bodyOf)).toContain(allCopy.en.confirmed("Tue, 6 Oct", "2:00 pm", "en"));
    expect(off.map(bodyOf)).toContain(allCopy.en.readingSpell);
    // Ticket 53: the call and the session still ask "Which would you like?" [Healing] [Energy cleansing]; Help and its answers are the pranic ones.
    expect(off.filter((p) => bodyOf(p) === allCopy.en.chooseService).map(buttonsOf)).toEqual([["svc_HEALING", "svc_PROTECTION"], ["ssv_HEALING", "ssv_PROTECTION"], ["ssv_HEALING", "ssv_PROTECTION"]]);
    const help = off.find((p) => bodyOf(p) === allCopy.en.helpListBody)!;
    expect(rowsOf(help).map((r) => r.id)).toEqual(["faq_what_is_this", "faq_how_it_works", "faq_price", "faq_timings", "faq_refund", "faq_privacy", "menu_bookings", "menu_person", "menu_lang"]);
    expect(off.map(bodyOf)).toContain(allCopy.en.faqAnswers.what_is_this);
    expect(off.map(bodyOf)).toContain(allCopy.en.faqAnswers.how_it_works);
    expect(allCopy.en.faqAnswers.what_is_this).toContain("no-touch pranic healing by phone with Shantha Rao, a certified Pranic Healer trained in the MCKS system");
    expect(bodyOf(off.at(-1))).toBe(allCopy.en.faqAnswers.how_it_works); // "Who is it for?" does nothing with the flag off
    for (const word of [allCopy.en.faqWhoAnswer, "Release", "pathway"]) expect(all).not.toContain(word);
    expect(await w.count("SELECT COUNT(*) AS n FROM intros WHERE topic IS NOT NULL")).toBe(0);
    expect(await w.count("SELECT COUNT(*) AS n FROM conversations WHERE topic_pick IS NOT NULL")).toBe(0);
  });

  it("with NEW_SERVICES on, Book is still Ticket 49's list, not the front door", async () => {
    w.newServices = "true";
    w.frontDoor = "false";
    await addServices(w.db);
    const from = await w.greeted("en");
    await w.tap(from, "menu_book");
    expect(bodyOf(w.last())).toBe(allCopy.en.offerBody);
  });
});

describe("KARMIC_FRONT_DOOR 'true' (test): the outcome-first menu", () => {
  beforeEach(() => void (w.frontDoor = "true"));

  it("the welcome carries the brand line above the unchanged disclosure; after the language tap, 'What would you like help with?'", async () => {
    for (const lang of ["en", "hi"] as Lang[]) {
      const from = w.newPhone();
      await w.typed(from, "hi");
      const greet = w.last();
      expect(bodyOf(greet)).toBe(karmicCopy.en.greeting);
      expect(bodyOf(greet).startsWith(`${BRAND_LINE}\n\n`)).toBe(true);
      expect(bodyOf(greet)).toBe(`${BRAND_LINE}\n\n${allCopy.en.greeting}`); // the privacy and AI disclosure word for word
      expect(bodyOf(greet)).toContain("automated booking assistant");
      expect(buttonsOf(greet)).toEqual(["lang_en", "lang_hi"]);
      await w.tap(from, `lang_${lang}`);
      const list = w.last();
      const c = karmicCopy[lang];
      expect(list.interactive.type).toBe("list");
      expect(bodyOf(list)).toBe(c.topicBody);
      expect(list.interactive.action.button).toBe(c.topicButton);
      expect(list.interactive.action.sections.map((s: Json) => s.title)).toEqual([c.topicSection, c.topicMoreSection]);
      expect(rowsOf(list).map((r) => r.id)).toEqual(["tp_RELATIONSHIPS", "tp_HEAVY", "tp_DECISION", "tp_HABIT", "tp_NOT_SURE", "menu_pack", "menu_how"]);
      expect(rowsOf(list).length).toBeLessThanOrEqual(10);
      for (const r of rowsOf(list)) {
        expect(len(r.title), r.title).toBeLessThanOrEqual(24);
        if (r.description) expect(len(r.description), r.description).toBeLessThanOrEqual(72);
      }
      for (const s of list.interactive.action.sections) expect(len(s.title)).toBeLessThanOrEqual(24);
      expect(len(list.interactive.action.button)).toBeLessThanOrEqual(20);
    }
  });

  it("every topic recommends the Karmic Clarity Call first, with [Book ₹99 call] [Help]; the topic is kept as a fixed key", async () => {
    const from = await w.greeted("en");
    for (const t of TOPICS) {
      w.fetchMock.mockClear();
      await w.tapRow(from, `tp_${t}`);
      expect(w.sent()).toHaveLength(1); // NEW_SERVICES off: the call only
      expect(bodyOf(w.last())).toBe(`${karmicCopy.en.topicLines[t]}\n\n${karmicCopy.en.clarityPitch}`);
      expect(bodyOf(w.last())).toContain("Karmic Clarity Call (₹99, 15 min)");
      expect(buttonsOf(w.last())).toEqual(["book_call", "menu_how"]);
      expect(buttonTitles(w.last())).toEqual(["Book ₹99 call", "Help"]);
      expect((await w.conv(from)).topic_pick).toBe(t);
    }
    // Hindi.
    const hi = await w.greeted("hi");
    await w.tapRow(hi, "tp_HEAVY");
    expect(bodyOf(w.last())).toContain("कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट)");
    expect(buttonTitles(w.last())).toEqual(["₹99 कॉल बुक करें", "मदद"]);
  });

  it("with NEW_SERVICES on too: 'Or book directly' lists just the topic's pathway(s); the single session is RELEASE; 'Not sure yet' the call only", async () => {
    w.newServices = "true";
    await addServices(w.db);
    await w.db.prepare("INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, active, public, sort) VALUES ('hidden_one', 'Hidden', 'छिपी', 'UNDERSTAND', 60, 100000, 1, 0, 50)").run();
    const from = await w.greeted("en");
    const expected: Record<string, string[]> = {
      RELATIONSHIPS: ["cat_tarot_reading", "pk_single"], HEAVY: ["pk_single"], DECISION: ["cat_tarot_reading"], HABIT: ["cat_guided_hypnosis"], NOT_SURE: [],
    };
    for (const t of TOPICS) {
      w.fetchMock.mockClear();
      await w.tapRow(from, `tp_${t}`);
      const sent = w.sent();
      expect(buttonsOf(sent[0])).toEqual(["book_call", "menu_how"]);
      if (!expected[t].length) {
        expect(sent).toHaveLength(1);
        continue;
      }
      expect(sent).toHaveLength(2);
      expect(bodyOf(sent[1])).toBe(karmicCopy.en.directBody);
      expect(rowsOf(sent[1]).map((r) => r.id)).toEqual(expected[t]);
    }
    await w.tapRow(from, "tp_DECISION");
    expect(rowsOf(w.last())[0]).toEqual({ id: "cat_tarot_reading", title: "Tarot reading", description: "30 min · ₹499 · voice call" });
    await w.tapRow(from, "tp_HEAVY");
    expect(rowsOf(w.last())[0]).toEqual({ id: "pk_single", title: "Single session", description: "60 min · ₹799 · voice call" });
  });

  it("needs_call_first still applies: the row says so, and the tap offers the Karmic Clarity Call instead", async () => {
    w.newServices = "true";
    await addServices(w.db, { callFirst: true });
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "tp_DECISION");
    expect(rowsOf(w.last())[0].description).toBe("30 min · ₹499 · voice call · after the Clarity Call");
    await w.tapRow(from, "cat_tarot_reading");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.offerCallFirst("Tarot reading"));
    expect(buttonTitles(w.last())).toEqual(["Book ₹99 call", "Help"]);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });

  it("the menu reads Book and opens the topics; Sessions & packages, Help and 'book' keep working; the call's own row goes straight to the call", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "menu");
    expect(buttonTitles(w.last())).toEqual(["Book", "Sessions & packages", "Help"]);
    expect(buttonsOf(w.last())).toEqual(["menu_book", "menu_pack", "menu_how"]);
    await w.tap(from, "menu_book");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.topicBody);
    await w.typed(from, "book");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.topicBody);
    await w.tapRow(from, "menu_how");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.helpListBody);
    await w.tapRow(from, "menu_pack");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.packagesBody);
    expect(rowsOf(w.last())[0]).toEqual({ id: "pk_intro", title: "Karmic Clarity Call", description: "₹99 · 15 min · voice call with Shantha Rao (no video)" });
    await w.tapRow(from, "pk_intro");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.ageCheck);
    // The soft nudge before a session: its call button books the call itself.
    await w.tap(from, "menu_pack");
    await w.tapRow(from, "pk_single");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.softGate);
    expect(buttonsOf(w.last())).toEqual(["book_call", "gate_s"]);
    expect(buttonTitles(w.last())).toEqual(["Book ₹99 call", "Continue"]);
  });

  it("free text still works at the topic step; crisis and the reading-safety replies run first", async () => {
    w.aiFlag = "false";
    const from = await w.greeted("en");
    await w.typed(from, "my husband and I keep fighting");
    expect(bodyOf(w.last())).toContain(karmicCopy.en.topicBody); // the re-prompt: the same list again, nothing lost
    expect(rowsOf(w.last())[0].id).toBe("tp_RELATIONSHIPS");
    await w.typed(from, "Relationships & family"); // the row's own words are the tap
    expect(bodyOf(w.last())).toContain(karmicCopy.en.clarityPitch);
    await w.typed(from, "someone did black magic on me");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.readingSpell);
    expect(bodyOf(w.last())).toContain("Karmic Clarity Call (₹99, 15 min)");
    expect(buttonTitles(w.last())).toEqual(["Book ₹99 call", "Help"]);
    await w.typed(from, "will I get pregnant this year?");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.readingPredict);
    await w.tap(from, "menu_book");
    await w.typed(from, "I want to die");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.crisis);
    // While nothing may be sold (the week after a crisis message), the language tap shows the menu without Book, never the topics.
    const after = w.newPhone();
    await w.typed(after, "hi");
    const conv = (await w.conv(after)).id;
    await w.db.prepare("UPDATE person_state SET no_sell_until = '2099-01-01T00:00:00Z' WHERE conversation_id = ?1").bind(conv).run();
    await w.tap(after, "lang_en");
    expect(buttonsOf(w.last())).toEqual(["menu_how", "menu_person"]);
  });

  it("Instagram's prefilled 'book a Karmic Clarity Call', as a first message, gets the topics after the language tap", async () => {
    w.aiFlag = "false";
    const from = w.newPhone();
    await w.typed(from, "Hi, I'd like to book a Karmic Clarity Call");
    await w.tap(from, "lang_en");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.topicBody);
  });

  it("a ₹99 call end to end: the topic, the call's steps, the pay message, the confirmation, My bookings, the reminder and the phone alert name the Karmic Clarity Call", async () => {
    const from = await w.greeted("en");
    await w.tapRow(from, "tp_DECISION");
    await w.tap(from, "book_call");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.ageCheck);
    await w.tap(from, "age_yes");
    // Ticket 53: no "Which would you like? [Healing] [Energy cleansing]": straight to who it is for (unchanged), HEALING kept as the filler.
    expect(bodyOf(w.last())).toBe(karmicCopy.en.whoFor);
    expect(buttonsOf(w.last())).toEqual(["who_HEALING_SELF", "who_HEALING_FAMILY", "who_HEALING_PET"]);
    await w.tap(from, "who_HEALING_SELF");
    await w.tapRow(from, "day_HEALING_SELF_2026-10-06");
    await w.tapRow(from, "time_HEALING_SELF_2026-10-06T08:30:00Z");
    expect(w.sent().map(bodyOf)).not.toContain(karmicCopy.en.chooseService);
    expect(await w.db.prepare("SELECT service, for_whom FROM intros").first()).toEqual({ service: "HEALING", for_whom: "SELF" });
    const payMsg = w.last();
    expect(bodyOf(payMsg).startsWith("Your Karmic Clarity Call (₹99, 15 min): Tue, 6 Oct at 2:00 pm is held for you until")).toBe(true);
    expect(payMsg.interactive.action.parameters.display_text).toBe("Pay ₹99");
    expect(await w.db.prepare("SELECT topic FROM intros").first()).toEqual({ topic: "DECISION" });
    w.fetchMock.mockClear();
    await pay(await linkOf(), 9900);
    expect(bodyOf(w.sent()[0])).toBe(karmicCopy.en.confirmed("Tue, 6 Oct", "2:00 pm", "en"));
    expect(bodyOf(w.sent()[0])).toContain("Thank you, your Karmic Clarity Call (₹99, 15 min) is booked.");
    await w.tap(from, "menu_bookings");
    expect(w.sent().map(bodyOf).join("\n")).toContain("Karmic Clarity Call (₹99, 15 min) on Tue, 6 Oct at 2:00 pm");
    // The day-before reminder the bot writes itself; outside the window the approved template, exactly as today ({{1}} "call").
    setFrontDoorWords({ KARMIC_FRONT_DOOR: "true" });
    w.fetchMock.mockClear();
    await sendReminders(w.env(), Date.parse("2026-10-05T13:00:00Z"));
    expect(bodyOf(w.last())).toBe(karmicCopy.en.reminderCall("Tue, 6 Oct", "2:00 pm"));
    await w.db.prepare("DELETE FROM messages WHERE dedupe_key LIKE 'reminder:%'").run();
    await w.db.prepare("UPDATE conversations SET last_user_at = '2026-10-01T00:00:00Z'").run();
    (config.templates.reminder as { approved: boolean }).approved = true;
    w.fetchMock.mockClear();
    await sendReminders(w.env(), Date.parse("2026-10-05T13:00:00Z"));
    expect(w.last().template.name).toBe("reminder");
    expect(w.last().template.components[0].parameters.map((p: Json) => p.text)).toEqual(["call", "Tue, 6 Oct", "2:00 pm"]);
    // The phone alert.
    expect(alertPayload({ kind: "CALL", amount: 9900, bookingId: 1, startUtc: "2026-10-06T08:30:00Z" }, "en", 1, NOW).body).toBe("Karmic Clarity Call · ₹99 · Tomorrow, 2:00 pm");
    setFrontDoorWords({});
    expect(alertPayload({ kind: "CALL", amount: 9900, bookingId: 1, startUtc: "2026-10-06T08:30:00Z" }, "en", 1, NOW).body).toBe("₹99 call · Tomorrow, 2:00 pm");
  });

  it("a topic is copied only onto a booking started within config.frontDoor.topicHours of the tap", async () => {
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "tp_HABIT");
    await w.db.prepare("UPDATE conversations SET topic_pick_at = '2026-10-03T00:00:00Z'").run();
    await w.tap(from, "book_call");
    await w.tap(from, "svc_HEALING");
    await w.tap(from, "who_HEALING_SELF");
    await w.tapRow(from, "time_HEALING_SELF_2026-10-06T08:30:00Z");
    expect(await w.db.prepare("SELECT topic FROM intros").first()).toEqual({ topic: null });
  });

  it("a Tarot reading booked directly carries the topic too", async () => {
    w.newServices = "true";
    await addServices(w.db);
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "tp_DECISION");
    await w.tapRow(from, "cat_tarot_reading");
    expect(await w.db.prepare("SELECT service_key, topic FROM sessions").first()).toEqual({ service_key: "tarot_reading", topic: "DECISION" });
  });

  it("ticket 53: the ₹799 session reached from the topic menu skips 'Healing or Energy cleansing?'; from Sessions & packages without a topic it still asks", async () => {
    w.newServices = "true";
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "tp_HEAVY");
    await w.tapRow(from, "pk_single");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.softGate);
    await w.tap(from, "gate_s");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.whoFor);
    expect(buttonsOf(w.last())).toEqual(["swh_HEALING_SELF", "swh_HEALING_FAMILY", "swh_HEALING_PET"]);
    await w.tap(from, "swh_HEALING_SELF");
    await w.tapRow(from, "sdy_HEALING_SELF_2026-10-06");
    await w.tapRow(from, "stm_HEALING_SELF_2026-10-06T08:30:00Z");
    expect(await w.db.prepare("SELECT service, for_whom, topic FROM sessions").first()).toEqual({ service: "HEALING", for_whom: "SELF", topic: "HEAVY" });
    // No topic tapped (or one older than topicHours): the session's own step, as before.
    const other = await w.greeted("en");
    await w.ageOk(other);
    await w.tap(other, "menu_pack");
    await w.tapRow(other, "pk_single");
    await w.tap(other, "gate_s");
    expect(bodyOf(w.last())).toBe(karmicCopy.en.chooseService);
    expect(buttonsOf(w.last())).toEqual(["ssv_HEALING", "ssv_PROTECTION"]);
  });

  it("ticket 53: Help adds 'Who is it for?'; What is this, How it works and Who is it for describe Karmic Coaching and end with the Clarity Call (EN, HI)", async () => {
    for (const lang of ["en", "hi"] as Lang[]) {
      const c = karmicCopy[lang];
      const from = await w.greeted(lang);
      await w.tap(from, "menu_how");
      const help = w.last();
      expect(rowsOf(help).map((r) => r.id)).toEqual(["faq_what_is_this", "faq_how_it_works", "faq_who_for", "faq_price", "faq_timings", "faq_refund", "faq_privacy", "menu_bookings", "menu_person", "menu_lang"]);
      expect(rowsOf(help)[2].title).toBe(c.faqWhoTitle);
      for (const r of rowsOf(help)) expect(len(r.title), r.title).toBeLessThanOrEqual(24);
      for (const [row, text] of [["faq_what_is_this", c.faqAnswers.what_is_this], ["faq_how_it_works", c.faqAnswers.how_it_works], ["faq_who_for", c.faqWhoAnswer]] as const) {
        await w.tapRow(from, row);
        expect(bodyOf(w.last())).toBe(text);
        expect(buttonsOf(w.last())).toEqual(["menu_book", "menu_pack", "menu_how"]); // one message, the menu under it
        expect(text).toContain(lang === "hi" ? "कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट)" : "Karmic Clarity Call (₹99, 15 min)");
        expect(len(text)).toBeLessThanOrEqual(450); // short: three to five lines on a phone
      }
      expect(c.faqAnswers.what_is_this).toContain(lang === "hi" ? "रिलीज़ (हीलिंग), समझ (रीडिंग) या रीवायर" : "Release (healing), Understand (readings) or Rewire (mind work)");
      expect(c.faqAnswers.what_is_this).toMatch(lang === "hi" ? /क्लैरिटी कॉल \(₹99, 15 मिनट\) है: .*।$/ : /Karmic Clarity Call \(₹99, 15 min\): .*\.$/);
      expect(c.faqWhoAnswer.endsWith(lang === "hi" ? "कार्मिक क्लैरिटी कॉल (₹99, 15 मिनट) से शुरू करें।" : "Begin with the Karmic Clarity Call (₹99, 15 min).")).toBe(true);
    }
    // Typed, with the assistant off: the same answers (the fixed-answer router).
    w.aiFlag = "false";
    const from = await w.greeted("en");
    await w.typed(from, "what is this?"); // the topic list is open: the answer goes on top of it
    expect(bodyOf(w.last())).toBe(`${karmicCopy.en.faqAnswers.what_is_this}\n\n${karmicCopy.en.topicBody}`);
    await w.typed(from, "how does it work");
    expect(bodyOf(w.last()).startsWith(`${karmicCopy.en.faqAnswers.how_it_works}\n\n${karmicCopy.en.answerCall}`)).toBe(true);
    expect(karmicCopy.en.answerCall).toContain("Karmic Clarity Call (₹99, 15 min)");
  });
});

describe("booking_confirmed (drafted, not submitted): used outside the window only once config says it is approved", () => {
  beforeEach(() => {
    w.newServices = "true";
    w.frontDoor = "true";
  });
  async function paidOutsideWindow(): Promise<{ from: string; conv: number }> {
    await addServices(w.db);
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "cat_tarot_reading");
    const sid = (await w.db.prepare("SELECT id FROM sessions").first<{ id: number }>())!.id;
    await w.tapRow(from, `sess_${sid}_2026-10-06T09:00:00Z`);
    const conv = (await w.conv(from)).id;
    await w.db.prepare("UPDATE conversations SET last_user_at = '2026-10-01T00:00:00Z' WHERE id = ?1").bind(conv).run();
    w.fetchMock.mockClear();
    await pay(await linkOf(), 49900);
    return { from, conv };
  }

  it("not approved (the default): nothing is sent and the team gets the OUTSIDE_WINDOW item, as in Ticket 49", async () => {
    expect(config.templates.booking_confirmed.approved).toBe(false);
    const { conv } = await paidOutsideWindow();
    expect(w.sent()).toHaveLength(0);
    expect(await w.count(`SELECT COUNT(*) AS n FROM attention WHERE kind = 'OUTSIDE_WINDOW' AND target = 'conv:${conv}'`)).toBe(1);
  });

  it("approved: the template, naming the service, the day and the time", async () => {
    (config.templates.booking_confirmed as { approved: boolean }).approved = true;
    await paidOutsideWindow();
    expect(w.last().template.name).toBe("booking_confirmed");
    expect(w.last().template.components[0].parameters.map((p: Json) => p.text)).toEqual(["Tarot reading", "Tue, 6 Oct", "2:30 pm"]);
  });
});

describe("the topic is wiped wherever the name is", () => {
  it("removeOldNames and wipePersonStmts clear the conversation's topic and the bookings'", async () => {
    const conv = (
      await w.db
        .prepare("INSERT INTO conversations (wa_id, display_name, last_user_at, created_at, topic_pick, topic_pick_at) VALUES ('919800000101', 'Test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'HEAVY', '2026-01-01T00:00:00Z')")
        .run()
    ).meta.last_row_id;
    await w.db.batch([
      w.db.prepare("INSERT INTO intros (conversation_id, service, state, topic) VALUES (?1, 'HEALING', 'CALLED_SESSION', 'HEAVY')").bind(conv),
      w.db.prepare("INSERT INTO sessions (conversation_id, service, state, topic) VALUES (?1, 'HEALING', 'COMPLETED', 'HEAVY')").bind(conv),
    ]);
    const left = async () =>
      (await w.count("SELECT COUNT(*) AS n FROM intros WHERE topic IS NOT NULL")) +
      (await w.count("SELECT COUNT(*) AS n FROM sessions WHERE topic IS NOT NULL")) +
      (await w.count("SELECT COUNT(*) AS n FROM conversations WHERE topic_pick IS NOT NULL OR topic_pick_at IS NOT NULL"));
    expect(await left()).toBe(3);
    await removeOldNames(w.env(), NOW);
    expect(await left()).toBe(0);
    await w.db.batch([
      w.db.prepare("UPDATE intros SET topic = 'DECISION'"),
      w.db.prepare("UPDATE sessions SET topic = 'DECISION'"),
      w.db.prepare("UPDATE conversations SET topic_pick = 'DECISION', topic_pick_at = '2026-10-05T00:00:00Z'"),
    ]);
    await w.db.batch(wipePersonStmts(w.db, conv, "2026-10-05T06:00:00Z"));
    expect(await left()).toBe(0);
  });

  it("the chat wipe (message text) leaves a kept booking's topic", async () => {
    const from = await w.greeted("en");
    const conv = (await w.conv(from)).id;
    await w.db.prepare("INSERT INTO intros (conversation_id, service, state, topic) VALUES (?1, 'HEALING', 'PAID', 'DECISION')").bind(conv).run();
    await w.db.prepare("UPDATE conversations SET last_user_at = '2026-10-01T00:00:00Z' WHERE id = ?1").bind(conv).run();
    const { wipeChats } = await import("../src/wipe");
    await wipeChats(w.env(), NOW);
    expect(await w.db.prepare("SELECT topic FROM intros").first()).toEqual({ topic: "DECISION" });
  });
});

describe("the console: 'Came for: …' on Today, the calendar's day view and the person page", () => {
  const T = Date.parse("2026-10-27T08:00:00Z"); // Tue 27 Oct, 1:30 pm India time
  const h = new ConsoleHarness();
  beforeEach(async () => {
    await w.stop(); // this block uses the console harness instead
    await h.start(T);
  });
  afterEach(async () => {
    await h.stop();
    await w.start(); // the file-level afterEach stops it again
  });

  it("the owner and the booking's practitioner see it, staff never; a booking without a topic shows nothing", async () => {
    const prac = (await h.member(PRAC))!.id;
    const conv = (await h.db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES ('919800000101', 'Asha Test')").run()).meta.last_row_id;
    const slot = (
      await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', '2026-10-27T10:30:00Z', '2026-10-27T10:45:00Z', ?1, 'BOOKED', ?2)").bind(conv, prac).run()
    ).meta.last_row_id;
    await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id, topic) VALUES (?1, ?2, 'HEALING', 'PAID', ?3, 'RELATIONSHIPS')").bind(conv, slot, prac).run();
    for (const [as, sees] of [[OWNER, true], [PRAC, true], [STAFF, false]] as const) {
      for (const path of ["/app", "/app/calendar?view=day&d=2026-10-27", `/app/people/${conv}`]) {
        const html = decode(await (await h.get(path, as)).text());
        expect(html.includes("Came for: Relationships &amp; family") || html.includes("Came for: Relationships & family"), `${as} ${path}`).toBe(sees);
        // Ticket 53: the call is named the Karmic Clarity Call there, not "Healing" (the filler stored since it no longer asks).
        expect(html, `${as} ${path}`).toContain("Karmic Clarity Call");
        expect(html, `${as} ${path}`).not.toContain(">Healing<");
      }
    }
    await h.db.prepare("UPDATE intros SET topic = NULL").run();
    for (const path of ["/app", "/app/calendar?view=day&d=2026-10-27", `/app/people/${conv}`]) {
      const html = decode(await (await h.get(path)).text());
      expect(html).not.toContain("Came for:");
      expect(html).not.toContain("Karmic Clarity Call"); // no topic: as before
      expect(html).toContain("Healing");
    }
  });

  it("the words in English and Hindi", () => {
    expect(clarityLabel("CALL", "HABIT", "hi")).toBe("कार्मिक क्लैरिटी कॉल");
    expect(clarityLabel("SESSION", "HABIT", "en")).toBeNull();
    expect(clarityLabel("CALL", null, "en")).toBeNull();
    expect(cameFor("HABIT", "en")).toBe("Came for: A habit or pattern to change");
    expect(cameFor("RELATIONSHIPS", "hi")).toBe("किसलिए आए: रिश्ते और परिवार");
    expect(cameFor("SOMETHING", "en")).toBeNull();
    expect(cameFor(null, "en")).toBeNull();
  });
});

describe("the words", () => {
  const strings = (c: Copy, keys: string[]): [string, string][] =>
    keys.map((k) => {
      const v = k.split(".").reduce<unknown>((o, x) => (o as Record<string, unknown>)[x], c);
      return [k, typeof v === "function" ? String((v as (...a: unknown[]) => string)("Tue, 6 Oct", "2:00 pm", "en", "https://example.invalid/p/1")) : String(v)];
    });
  const topicKeys = [
    "topicBody", "topicButton", "topicSection", "topicMoreSection", "clarityPitch", "directBody", "directButton", "btnBookCall",
    ...TOPICS.flatMap((t) => [`topicTitles.${t}`, `topicDescs.${t}`, `topicLines.${t}`]),
  ];

  it("every key that reads differently with the flag on is shown in docs/COPY.md section 8g; the rest are the same", () => {
    const shown = new Set(karmicKeys());
    for (const lang of ["en", "hi"] as Lang[]) {
      const walk = (a: unknown, b: unknown, path: string) => {
        if (typeof a === "object" && a && typeof b === "object" && b) for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
        else if (typeof a === "function") {
          const args = ["Tue, 6 Oct", "2:00 pm", "en", "https://example.invalid/p/1"];
          const same = (a as (...x: unknown[]) => string)(...args) === (b as (...x: unknown[]) => string)(...args);
          if (!same) expect(shown.has(path), `${lang} ${path}`).toBe(true);
        } else if (a !== b) expect(shown.has(path), `${lang} ${path}`).toBe(true);
      };
      walk(allCopy[lang], karmicCopy[lang], "");
    }
  });

  it("limits: buttons ≤ 20, rows and sections ≤ 24, row lines ≤ 72; and no claim of years, certificates, cures, diagnoses or predictions", () => {
    for (const lang of ["en", "hi"] as Lang[]) {
      const c = karmicCopy[lang];
      for (const b of [c.btnBook, c.btnBookCall, c.topicButton, c.directButton, c.payLabel]) expect(len(b), b).toBeLessThanOrEqual(20);
      for (const r of [c.topicSection, c.topicMoreSection, c.rowIntroTitle, ...Object.values(c.topicTitles)]) expect(len(r), r).toBeLessThanOrEqual(24);
      for (const d of [c.rowIntroDesc, c.offerRowDesc(90, "₹1,00,000", true), ...Object.values(c.topicDescs)]) expect(len(d), d).toBeLessThanOrEqual(72);
      const changed = karmicKeys().filter((k) => k !== "readingSpell"); // readingSpell says what isn't done (checked in offer.test.ts)
      for (const [k, t] of [...strings(c, topicKeys), ...strings(c, changed), ...strings(c, ["faqWhoTitle", "faqWhoAnswer"])]) {
        expect(t, `${lang} ${k}`).not.toMatch(/\d+\s*\+?\s*years|certif|\bcures?\b|\bcured\b|diagnos|predict|guarantee|miracle|प्रमाणित|सर्टिफ|गारंटी|चमत्कार|साल का अनुभव/i);
        expect(hasPhrase(t, config.ai.bannedWords), `${lang} ${k}`).toBe(false);
        expect(hasPhrase(t, config.ai.karmicBannedWords), `${lang} ${k}`).toBe(false); // ticket 53: therapy, predict … (§18)
        expect(len(t)).toBeLessThanOrEqual(1024);
      }
    }
  });
});
