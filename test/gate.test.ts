import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { allCopy, type Lang } from "../src/copy";
import { classifyWithoutAI, gate, isAckWord, type GateMessage } from "../src/gate";
import { budgetUsedUp, isPayingCustomer, recordAiReply } from "../src/noise";
import { detectSafety, hasPhrase, normalize } from "../src/safety";
import { sendMessage } from "../src/send";
import { generateSlots } from "../src/slots";
import { FakeRazorpay, paidEvent, rzpEnv, rzpHeaders } from "./razorpay";
import { newDb } from "./db";

// Many requests per test, so a generous limit (the CI default is 20 seconds).
vi.setConfig({ testTimeout: 120_000 });

// The gatekeeper (ticket 12). All data is synthetic. Mon 2026-10-05, 11:30 IST. Meta, Razorpay and email are mocked: nothing real is called.
const SECRET = "test-app-secret";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const DAY = 86_400_000;
const call = (i: number, ymd = "2026-10-06") => generateSlots(ymd, "CALL")[i];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wa = any;
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let fake: FakeRazorpay;
let emails: { to: string; from: string; subject: string; text: string }[];
let n = 0;
let sends = "true";
let slotNo = 0;

const env = () =>
  ({
    DB: db, SENDS: sends, NEW_BOOKINGS: "true", WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "v", WA_TOKEN: "tok", WA_PHONE_ID: "1000", CHAT_RETENTION_MINUTES: "10",
    DIGEST_TO: "ops@example.invalid", PUBLIC_URL: "https://bot.example.test", EMAIL: { send: async (m: (typeof emails)[number]) => void emails.push(m) }, ...rzpEnv(),
  }) as never;
const sent = (): Wa[] => fetchMock.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com")).map((c) => JSON.parse((c[1] as { body: string }).body));
const last = (): Wa => sent().at(-1);
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const texts = () => sent().map((p) => p.text?.body ?? p.interactive?.body?.text);

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
const wrap = (from: string, extra: object) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: `wamid.G${++n}`, from, timestamp: stamp(), ...extra }] } }] }] });
const typed = (from: string, body: string, extra: object = {}) => post(wrap(from, { type: "text", text: { body }, ...extra }));
const tap = (from: string, id: string) => post(wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } }));
const tapRow = (from: string, id: string) => post(wrap(from, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title: id } } }));
const media = (from: string, type: string) => post(wrap(from, { type, [type]: { id: "media-id-1" } }));

let phone = 919810000000;
const newPhone = () => String(++phone);
const conv = async (from: string) => (await db.prepare("SELECT * FROM conversations WHERE wa_id = ?1").bind(from).first<Wa>())!;
const state = async (from: string) => (await db.prepare("SELECT * FROM person_state WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)").bind(from).first<Wa>())!;
const setState = (from: string, sql: string, ...binds: unknown[]) =>
  db.prepare(`UPDATE person_state SET ${sql} WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)`).bind(from, ...binds).run();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

// A greeted person who has chosen a language, so no booking step is open.
async function greeted(lang: Lang = "en", from = newPhone()) {
  await typed(from, "hi");
  await tap(from, `lang_${lang}`);
  fetchMock.mockClear();
  emails.length = 0;
  return from;
}
const ageOk = (from: string) => db.prepare("UPDATE conversations SET age_ok_at = '2026-01-01T00:00:00Z' WHERE wa_id = ?1").bind(from).run();

// Paid call, paid session, held call: the kinds of customers the filters care about.
async function intro(from: string, state: string, o: { updated?: string; hold?: boolean; payment?: string } = {}) {
  const c = (await conv(from)).id as number;
  const k = slotNo++; // every call gets its own slot: 2:45 pm on Tue 6 Oct, then the next quarter hours, then the next days
  const s = call(3 + (k % 16), ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"][Math.floor(k / 16)]);
  const slot = await db
    .prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state,hold_until) VALUES ('CALL',?1,?2,?3,?4,?5)")
    .bind(s.startUtc, s.endUtc, c, o.hold ? "HELD" : "BOOKED", o.hold ? iso(Date.now() + 600_000) : null)
    .run();
  const i = await db
    .prepare("INSERT INTO intros (conversation_id,slot_id,service,state,created_at,updated_at) VALUES (?1,?2,'HEALING',?3,?4,?4)")
    .bind(c, slot.meta.last_row_id, state, o.updated ?? iso(Date.now()))
    .run();
  if (o.payment) {
    await db
      .prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,amount_paise,state,created_at,updated_at) VALUES ('razorpay','INTRO',?1,?2,9900,?3,?4,?4)")
      .bind(i.meta.last_row_id, `di-intro-g${++n}`, o.payment, o.updated ?? iso(Date.now()))
      .run();
  }
  return { conv: c, introId: i.meta.last_row_id };
}

beforeEach(async () => {
  ({ db, close } = await newDb());
  sends = "true";
  slotNo = 0;
  emails = [];
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

// ---------------------------------------------------------------------------------------------------------------------------------

describe("normalising and matching", () => {
  it("lower case, NFC, no nukta, chandrabindu read as anusvara, no punctuation, one space", () => {
    expect(normalize("  I   WANT to die!!! ")).toBe("i want to die");
    expect(normalize("मैं मरना चाहता हूँ।")).toBe("मैं मरना चाहता हूं");
    expect(normalize("ज़िंदा नहीं रहना")).toBe("जिंदा नहीं रहना"); // precomposed ज़ (U+095B)
    expect(normalize("ज़िंदा")).toBe("जिंदा"); // ज + nukta
    expect(normalize("can't breathe 😰")).toBe("can t breathe");
    expect(normalize("मर जाऊँगा")).toBe(normalize("मर जाऊंगा"));
  });
  it("phrases match as whole words only", () => {
    expect(hasPhrase("a keystroke", ["stroke"])).toBe(false);
    expect(hasPhrase("it was a stroke.", ["stroke"])).toBe(true);
    expect(hasPhrase("insecure and secure", ["cure"])).toBe(false);
    expect(hasPhrase("mar jaana chahta hoon", config.safety.crisis)).toBe(true);
  });
  it("crisis phrases in English, Roman Hinglish and Devanagari, with nukta and chandrabindu variants", () => {
    const crisis = [
      "I want to die", "I wanna die.", "thinking about suicide", "She said she would kill herself", "I want to END MY LIFE", "there is no reason to live",
      "mar jaana chahta hoon", "Main marna chahti hoon", "mar jana chahti hu", "jeena nahi chahti", "khudkushi", "zinda nahi rehna", "jaan de dunga",
      "मैं मरना चाहता हूँ", "मैं मरना चाहता हूं", "मरना चाहती हूँ", "मर जाऊँगा", "मर जाऊंगी", "आत्महत्या", "ख़ुदकुशी", "ज़िंदा नहीं रहना", "जिंदा नहीं रहना", "अपनी जान दे दूँगा। अपनी जान",
    ];
    for (const t of crisis) expect(detectSafety(t), t).toBe("CRISIS");
    const emergency = ["I can't breathe", "chest pain since morning", "she is unconscious", "saans nahi aa rahi", "सांस नहीं आ रही", "सीने में दर्द है", "वो बेहोश हो गया", "उसने ज़हर खा लिया", "उसने जहर खा लिया", "overdose"];
    for (const t of emergency) expect(detectSafety(t), t).toBe("EMERGENCY");
    for (const t of ["I am very stressed about work", "kitne ka hai", "Can I book for my son?", "मेरी माँ बीमार है", "I am dying to know the price", "keystroke", ""]) expect(detectSafety(t), t).toBeNull();
    expect(detectSafety("I took an overdose and want to die")).toBe("CRISIS"); // when both match, the crisis message (which has 112 too) goes
  });
});

describe("gate(): the order of AGENT.md section 3.2", () => {
  const txt = (text: string): GateMessage => ({ type: "text", text, choice: null });
  const btn = (id: string): GateMessage => ({ type: "interactive", text: null, choice: id });
  const decide = async (from: string, m: GateMessage) => {
    const c = await conv(from);
    return gate(env(), { id: c.id, mode: c.mode, greeted_at: c.greeted_at }, m);
  };
  const setMode = (from: string, mode: string) => db.prepare("UPDATE conversations SET mode = ?2 WHERE wa_id = ?1").bind(from, mode).run();
  const CRISIS = "I want to die";

  it("safety is first: before the greeting, the blocked check, HUMAN mode, the quiet period and the budget", async () => {
    const first = newPhone();
    await db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(first).run(); // never greeted
    expect(await decide(first, txt(CRISIS))).toBe("CRISIS");
    expect(await decide(first, txt("chest pain"))).toBe("EMERGENCY");
    expect(await decide(first, txt("hello"))).toBe("GREETING");
    expect(await decide(first, btn("menu_book"))).toBe("GREETING");

    const from = await greeted();
    await setMode(from, "BLOCKED");
    expect(await decide(from, txt("hello"))).toBe("IGNORE");
    expect(await decide(from, btn("menu_how"))).toBe("IGNORE");
    expect(await decide(from, txt(CRISIS))).toBe("CRISIS");
    await setMode(from, "HUMAN");
    expect(await decide(from, txt(CRISIS))).toBe("CRISIS");
    await setMode(from, "BOT");
    await setState(from, "quiet_until = ?2, ai_day = ?3, ai_count = 99", iso(NOW + DAY), "2026-10-05");
    expect(await decide(from, txt(CRISIS))).toBe("CRISIS");
    expect(await decide(from, txt("मैं मरना चाहता हूँ"))).toBe("CRISIS");
  });

  it("on a Worker whose SENDS env flag is off, safety does not run (nothing can be sent there)", async () => {
    const from = await greeted();
    sends = "false";
    expect(await decide(from, txt(CRISIS))).toBe("TO_CLASSIFIER");
  });

  it("opt-out words, a person, HUMAN mode", async () => {
    const from = await greeted();
    for (const w of ["stop", "STOP!", "Unsubscribe", "बंद करो", "band karo", " Band  Karo. "]) expect(await decide(from, txt(w)), w).toBe("OPT_OUT");
    for (const w of ["please don't stop", "stop calling me names", "I can't stop crying"]) expect(await decide(from, txt(w)), w).not.toBe("OPT_OUT");
    expect(await decide(from, btn("menu_person"))).toBe("HANDOFF");
    for (const w of ["human", "Talk to a human", "I want to talk to a person", "insaan se baat karni hai", "इंसान से बात करनी है", "real person please"]) expect(await decide(from, txt(w)), w).toBe("HANDOFF");
    expect(await decide(from, txt("my sister is a very good person and I would like to book a call for her next week please"))).toBe("TO_CLASSIFIER"); // long: not a request
    await setMode(from, "HUMAN");
    expect(await decide(from, txt("are you there?"))).toBe("HUMAN_WAIT");
    expect(await decide(from, txt("hello"))).toBe("MENU"); // a menu word gets the menu in HUMAN mode too (the mode does not change)
    expect(await decide(from, { type: "image", text: null, choice: null })).toBe("HUMAN_WAIT");
    expect(await decide(from, btn("menu_how"))).toBe("TAP");
    expect(await decide(from, { type: "button", text: null, choice: null })).toBe("TAP"); // a template quick reply
    expect(await decide(from, txt("stop"))).toBe("OPT_OUT");
    expect(await decide(from, txt("human"))).toBe("HANDOFF");
  });

  it("a quiet period: free text is ignored; a person, opt-out, taps, media and 'book' still work; a paying customer is not quiet", async () => {
    const from = await greeted();
    await setState(from, "quiet_until = ?2", iso(NOW + 3 * DAY));
    for (const w of ["hello", "menu", "what is the price", "ok", "🙏"]) expect(await decide(from, txt(w)), w).toBe("IGNORE");
    for (const w of ["book", "BOOK!", "बुक", "Booking"]) expect(await decide(from, txt(w)), w).toBe("BOOKING_WORD");
    expect(await decide(from, txt("human"))).toBe("HANDOFF");
    expect(await decide(from, btn("menu_person"))).toBe("HANDOFF");
    expect(await decide(from, txt("stop"))).toBe("OPT_OUT");
    expect(await decide(from, btn("menu_book"))).toBe("TAP");
    expect(await decide(from, { type: "audio", text: null, choice: null })).toBe("MEDIA");
    await intro(from, "PAID", { payment: "PAID" });
    expect(await decide(from, txt("hello"))).toBe("MENU");
    expect(await decide(from, txt("what is the price"))).toBe("TO_CLASSIFIER");
    await setState(from, "quiet_until = ?2", iso(NOW - 1000)); // the quiet period is over
    await db.prepare("DELETE FROM intros").run();
    await db.prepare("DELETE FROM payments").run();
    expect(await decide(from, txt("hello"))).toBe("MENU");
  });

  it("media, acknowledgements, menu words, 'book', the budget, and the classifier", async () => {
    const from = await greeted();
    for (const type of ["audio", "image", "video", "sticker", "document", "location", "contacts"]) expect(await decide(from, { type, text: null, choice: null }), type).toBe("MEDIA");
    expect(await decide(from, { type: "reaction", text: null, choice: null })).toBe("IGNORE");
    const acks = ["ok", "Okay", "OK!", "thanks", "Thank you", "thank you 🙏", "ty", "ji", "Ji.", "👍", "🙏", "👍🏽", "🙏🙏", "👍 🙏", "धन्यवाद", "शुक्रिया", "ठीक है", "ठीक है।", "धन्यवाद 🙏"];
    for (const w of acks) expect(await decide(from, txt(w)), w).toBe("ACK_WORD");
    for (const w of ["ok but how much", "thanks, one more question", "😡", "...", "?", ""]) expect(isAckWord(w), w).toBe(false);
    for (const w of ["hi", "Hello!", "namaste 🙏", "नमस्ते", "मेनू", "start"]) expect(await decide(from, txt(w)), w).toBe("MENU");
    for (const w of ["book", "बुक", "booking"]) expect(await decide(from, txt(w)), w).toBe("BOOKING_WORD");
    expect(await decide(from, txt("how does this work on the phone?"))).toBe("TO_CLASSIFIER");
    expect(await decide(from, txt("यह कैसे काम करता है?"))).toBe("TO_CLASSIFIER");
    expect(await decide(from, btn("menu_how"))).toBe("TAP");
    expect(await decide(from, btn("faq_price"))).toBe("TAP");
    await setState(from, "ai_day = ?2, ai_count = ?3", "2026-10-05", config.ai.aiRepliesPerPersonPerDay);
    expect(await decide(from, txt("how does this work on the phone?"))).toBe("BUDGET_FALLBACK");
    expect(await decide(from, txt("hello"))).toBe("MENU"); // menu words and acknowledgements come before the budget
  });
});

describe("the AI budgets: counted per India day, checked in the gate", () => {
  it("12 a day for a person, 40 for a paying customer, 300 in all; yesterday's counts do not count", async () => {
    expect([config.ai.aiRepliesPerPersonPerDay, config.ai.aiRepliesPerPayingCustomerPerDay, config.ai.aiRepliesPerDayTotal]).toEqual([12, 40, 300]);
    const from = await greeted();
    const id = (await conv(from)).id as number;
    for (let i = 0; i < 11; i++) await recordAiReply(db, id, NOW);
    expect(await budgetUsedUp(db, id, false, NOW)).toBe(false);
    await recordAiReply(db, id, NOW);
    expect((await state(from)).ai_count).toBe(12);
    expect(await budgetUsedUp(db, id, false, NOW)).toBe(true);
    expect(await budgetUsedUp(db, id, true, NOW)).toBe(false); // a paying customer has 40
    await setState(from, "ai_count = 40");
    expect(await budgetUsedUp(db, id, true, NOW)).toBe(true);
    expect(await budgetUsedUp(db, id, false, NOW + DAY)).toBe(false); // the next India day starts again...
    await recordAiReply(db, id, NOW + DAY);
    expect(await state(from)).toMatchObject({ ai_day: "2026-10-06", ai_count: 1 }); // ...from 1
    // India day, not UTC day: 19:00 UTC is already the next day in India.
    expect(await budgetUsedUp(db, id, true, Date.parse("2026-10-05T19:00:00Z"))).toBe(false);
  });

  it("the global cap covers everybody", async () => {
    const a = await greeted();
    const b = await greeted();
    await setState(b, "ai_day = ?2, ai_count = ?3", "2026-10-05", 300);
    const idA = (await conv(a)).id as number;
    expect(await budgetUsedUp(db, idA, false, NOW)).toBe(true);
    expect(await budgetUsedUp(db, idA, true, NOW)).toBe(true);
    await setState(b, "ai_day = ?2", "2026-10-04");
    expect(await budgetUsedUp(db, idA, false, NOW)).toBe(false);
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: over a cap the person gets the menu with Talk to a person, no AI, and the day is counted for the digest`, async () => {
      const from = await greeted(lang);
      await setState(from, "ai_day = ?2, ai_count = 12", "2026-10-05");
      await typed(from, lang === "en" ? "how does this work on the phone?" : "यह फ़ोन पर कैसे होता है?");
      const c = allCopy[lang];
      expect(sent()).toHaveLength(1);
      expect(last().interactive.body.text).toBe(c.aiFallback);
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["menu_book", "menu_how", "menu_person"]);
      expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BUDGET_FALLBACK'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
    });
  }

  it("while nothing may be sold the fallback has no Book button and no offer of a call", async () => {
    const from = await greeted("en");
    await setState(from, "ai_day = ?2, ai_count = 12, no_sell_until = ?3", "2026-10-05", iso(NOW + DAY));
    await typed(from, "how does this work on the phone?");
    expect(last().interactive.body.text).toBe(allCopy.en.aiFallbackNoSell);
    expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["menu_how", "menu_person"]);
    expect(allCopy.en.aiFallbackNoSell).not.toMatch(/book/i);
    expect(allCopy.hi.aiFallbackNoSell).not.toContain("बुक");
  });
});

describe("safety: crisis and emergency", () => {
  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: the fixed crisis message, an urgent item, one email with only a link, HUMAN mode, no selling for 7 days`, async () => {
      const from = await greeted(lang);
      const text = lang === "en" ? "I don't see the point, I want to die" : "मैं मरना चाहता हूँ";
      await typed(from, text);
      expect(sent()).toHaveLength(1);
      expect(last().type).toBe("text");
      expect(last().text.body).toBe(allCopy[lang].crisis);
      expect(last().text.body).toContain("14416");
      expect(last().text.body).toContain("1-800-891-4416");
      expect(last().text.body).toContain("112");
      const c = await conv(from);
      expect(c.mode).toBe("HUMAN");
      expect((await state(from)).no_sell_until).toBe(iso(NOW + 7 * DAY));
      expect(await db.prepare("SELECT kind, target FROM attention").all()).toMatchObject({ results: [{ kind: "CRISIS", target: `conv:${c.id}` }] });
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toBe("Urgent: crisis message");
      expect(emails[0].text).toBe("A crisis message arrived. Open https://bot.example.test/admin now.");
      expect(emails[0].text).not.toContain(text);
      // The same person writing again while the item is open: the message goes, there is no second item and no second email.
      await typed(from, text);
      expect(sent()).toHaveLength(2);
      expect(emails).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'CRISIS'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CRISIS'")).toBe(2);
    });

    it(`${lang}: a medical emergency gets the fixed message and an item, no menu and no HUMAN mode`, async () => {
      const from = await greeted(lang);
      await typed(from, lang === "en" ? "my father has chest pain" : "सीने में दर्द है");
      expect(sent()).toHaveLength(1);
      expect(last().text.body).toBe(allCopy[lang].emergency);
      expect(last().text.body).toContain("112");
      expect(last().text.body).toContain("108");
      expect((await conv(from)).mode).toBe("BOT");
      expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'EMERGENCY'")).toBe(1);
      expect(emails).toHaveLength(0);
      expect((await state(from)).no_sell_until).toBeNull();
    });
  }

  it("the language: Devanagari in the text is Hindi; otherwise the chosen language; before one is chosen, English", async () => {
    const hindi = await greeted("hi");
    await typed(hindi, "mar jaana chahta hoon");
    expect(last().text.body).toBe(allCopy.hi.crisis); // Hinglish from someone who chose Hindi
    const english = await greeted("en");
    await typed(english, "मैं मरना चाहता हूँ");
    expect(last().text.body).toBe(allCopy.hi.crisis);
    const nobody = newPhone();
    await typed(nobody, "mar jaana chahta hoon");
    expect(last().text.body).toBe(allCopy.en.crisis);
    const nobody2 = newPhone();
    await typed(nobody2, "आत्महत्या");
    expect(last().text.body).toBe(allCopy.hi.crisis);
  });

  it("as the very first message: only the crisis message, no greeting, and the greeting never follows", async () => {
    const from = newPhone();
    await typed(from, "I want to die");
    expect(sent()).toHaveLength(1);
    expect(last().text.body).toBe(allCopy.en.crisis);
    expect((await conv(from)).greeted_at).not.toBeNull();
    expect((await conv(from)).mode).toBe("HUMAN");
    await typed(from, "are you there?");
    expect(sent()).toHaveLength(1); // HUMAN mode: waits for Rohit
    await typed(from, "hello");
    expect(sent()).toHaveLength(2); // a menu word still gets the menu, and after a crisis message it has nothing to sell
    expect(last().interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(["menu_how", "menu_person"]);
    expect((await conv(from)).mode).toBe("HUMAN");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE dedupe_key LIKE 'greet:%'")).toBe(0);
  });

  it("in HUMAN mode, when blocked (and still blocked), during a quiet period, over budget, and while the SENDS switch is paused", async () => {
    const human = await greeted();
    await tap(human, "menu_person");
    fetchMock.mockClear();
    await typed(human, "I want to die");
    expect(last().text.body).toBe(allCopy.en.crisis);

    const blocked = await greeted();
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'NOISE_ABUSE', 'test')").bind(blocked).run();
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1").bind(blocked).run();
    fetchMock.mockClear();
    await typed(blocked, "hello");
    expect(sent()).toHaveLength(0);
    await typed(blocked, "I want to end my life");
    expect(sent()).toHaveLength(1);
    expect(last().text.body).toBe(allCopy.en.crisis);
    expect((await conv(blocked)).mode).toBe("BLOCKED"); // an urgent item for Rohit, but the block stays
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'CRISIS'")).toBe(2);

    const quiet = await greeted();
    await setState(quiet, "quiet_until = ?2, ai_day = '2026-10-05', ai_count = 99", iso(NOW + DAY));
    fetchMock.mockClear();
    await typed(quiet, "मैं मरना चाहता हूँ");
    expect(last().text.body).toBe(allCopy.hi.crisis);

    const paused = await greeted();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('SENDS', 'false')").run();
    fetchMock.mockClear();
    await typed(paused, "hello"); // an ordinary reply is held back...
    expect(sent()).toHaveLength(0);
    await typed(paused, "suicide");
    expect(sent()).toHaveLength(1); // ...the crisis message is not
    expect(last().text.body).toBe(allCopy.en.crisis);
  });

  it("not when the SENDS env flag is off: no message, no item, no email", async () => {
    const from = await greeted();
    sends = "false";
    fetchMock.mockClear();
    await typed(from, "I want to die");
    expect(sent()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'CRISIS'")).toBe(0);
    expect(emails).toHaveLength(0);
  });

  it("inside a burst: the crisis reply is never skipped, even when a newer message from the same person exists", async () => {
    const from = await greeted();
    const t = Math.floor(NOW / 1000);
    await typed(from, "what is the price?", { timestamp: String(t + 10) }); // the newer message is handled first
    fetchMock.mockClear();
    await typed(from, "I want to die", { timestamp: String(t) }); // the older one arrives later
    expect(sent()).toHaveLength(1);
    expect(last().text.body).toBe(allCopy.en.crisis);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE skip_reason IS NOT NULL")).toBe(0);
  });

  it("nothing is sold after a crisis message, but a booking the person starts themselves still works", async () => {
    const from = await greeted();
    await ageOk(from);
    await typed(from, "I want to die");
    fetchMock.mockClear();
    await tap(from, "menu_how");
    await tapRow(from, "faq_price");
    expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["menu_how", "menu_person"]); // the menu has no Book button
    await typed(from, "menu"); // HUMAN mode: free text waits for Rohit
    await tap(from, "menu_book"); // an old Book button, tapped by the person
    expect(last().interactive.body.text).toBe(allCopy.en.chooseService);
    // Rohit clears it; the menu has Book again.
    await setState(from, "no_sell_until = NULL");
    await tap(from, "menu_how");
    await tapRow(from, "faq_price");
    expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["menu_book", "menu_pack", "menu_how"]);
  });
});

describe("paying customers are never filtered", () => {
  it("who is a paying customer: PAID, CONFIRMED or RESCHEDULED in the last 30 days; a hold alone is not", async () => {
    const check = async (state: string, o: { updated?: string; hold?: boolean; payment?: string } = {}) => {
      const from = await greeted();
      const { conv: id } = await intro(from, state, o);
      return isPayingCustomer(db, id, NOW);
    };
    expect(await check("PAID")).toBe(true);
    expect(await check("RESCHEDULED")).toBe(true);
    expect(await check("HELD", { hold: true })).toBe(false); // a hold alone
    expect(await check("HELD", { hold: true, payment: "PENDING" })).toBe(false);
    expect(await check("EXPIRED")).toBe(false);
    expect(await check("PAID", { updated: iso(NOW - 31 * DAY) })).toBe(false);
    expect(await check("PAID", { updated: iso(NOW - 29 * DAY) })).toBe(true);
    expect(await check("CALLED_SESSION", { payment: "PAID" })).toBe(true); // the call is done, the payment is recent
    expect(await check("CALLED_SESSION", { payment: "REFUNDED" })).toBe(false);
    expect(await check("CALLED_SESSION", { payment: "PAID", updated: iso(NOW - 40 * DAY) })).toBe(false);
    const sess = await greeted();
    const c = (await conv(sess)).id as number;
    await db.prepare("INSERT INTO sessions (conversation_id, service, state, created_at, updated_at) VALUES (?1, 'HEALING', 'CONFIRMED', ?2, ?2)").bind(c, iso(NOW - 3 * DAY)).run();
    expect(await isPayingCustomer(db, c, NOW)).toBe(true);
    expect(await isPayingCustomer(db, 99999, NOW)).toBe(false);
  });

  it("a paying customer who sends spam, flirting or abuse gets no strike, no quiet period, no block", async () => {
    const from = await greeted();
    await intro(from, "PAID", { payment: "PAID" });
    for (let i = 0; i < 5; i++) {
      await typed(from, "Earn 5000 daily, click https://example.invalid/x");
      await typed(from, "you idiot");
      await typed(from, "send nudes");
    }
    expect(await state(from)).toMatchObject({ strikes: 0, quiet_until: null, flirt_offences: 0, abuse_offences: 0 });
    expect((await conv(from)).mode).toBe("BOT");
    expect(await count("SELECT COUNT(*) AS n FROM blocks")).toBe(0);
  });

  it("a hold alone does not bypass the filters: strikes count", async () => {
    const from = await greeted();
    await intro(from, "HELD", { hold: true, payment: "PENDING" });
    await typed(from, "Earn 5000 daily, click https://example.invalid/x");
    expect((await state(from)).strikes).toBe(1);
  });
});

describe("strikes, the quiet week, and blocks", () => {
  const SPAM = "Earn 5000 daily, click https://example.invalid/x";

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: three strikes -> the closing line once and 7 quiet days; 'book' works in them without ending them; payment ends them`, async () => {
      const from = await greeted(lang);
      await typed(from, SPAM);
      await typed(from, SPAM);
      expect(sent()).toHaveLength(0); // spam: a strike and no reply
      expect((await state(from)).strikes).toBe(2);
      await typed(from, SPAM);
      expect(sent()).toHaveLength(1);
      expect(last().text.body).toBe(allCopy[lang].quietClose);
      expect(await state(from)).toMatchObject({ strikes: 0, quiet_until: iso(NOW + 7 * DAY), quiet_count_30d: 1, last_quiet_at: iso(NOW) });

      // Quiet: nothing is said to free text, whatever it is.
      fetchMock.mockClear();
      for (const w of ["hello", "what is the price", SPAM, "menu", "ok"]) await typed(from, w);
      expect(sent()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
      expect((await state(from)).strikes).toBe(0); // no new strikes while quiet

      // "book" / "बुक" opens the booking flow (here: the age question), and the quiet period goes on.
      await typed(from, lang === "en" ? "book" : "बुक");
      expect(last().interactive.body.text).toBe(allCopy[lang].ageCheck);
      await tap(from, "age_yes");
      await tap(from, "svc_HEALING");
      await tap(from, "who_HEALING_SELF");
      await tap(from, "day_HEALING_SELF_2026-10-06");
      await tapRow(from, `time_HEALING_SELF_${call(2).startUtc}`);
      expect(last().interactive.type).toBe("cta_url");
      expect((await state(from)).quiet_until).toBe(iso(NOW + 7 * DAY));
      fetchMock.mockClear();
      await typed(from, "hello again");
      expect(sent()).toHaveLength(0);

      // Payment ends it.
      const link = (await db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
      const raw = JSON.stringify(paidEvent(link));
      expect((await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env())).status).toBe(200);
      expect((await state(from)).quiet_until).toBeNull();
      fetchMock.mockClear();
      await typed(from, "hello again");
      expect(sent()).toHaveLength(1); // answered again
    });
  }

  it("strikes clear after 7 days without one", async () => {
    const from = await greeted();
    await typed(from, SPAM);
    await typed(from, SPAM);
    expect((await state(from)).strikes).toBe(2);
    vi.setSystemTime(NOW + 7 * DAY + 1000);
    await typed(from, SPAM);
    expect((await state(from)).strikes).toBe(1); // the old two are gone
    vi.setSystemTime(NOW + 7 * DAY + 60_000);
    await typed(from, SPAM);
    expect((await state(from)).strikes).toBe(2); // within the week: they add up
  });

  it("a second quiet period within 30 days is a block (NOISE_REPEAT); after 30 days it is a new quiet period", async () => {
    const a = await greeted();
    for (let i = 0; i < 3; i++) await typed(a, SPAM);
    expect((await state(a)).quiet_until).not.toBeNull();
    vi.setSystemTime(NOW + 8 * DAY); // the quiet week is over
    fetchMock.mockClear();
    await typed(a, "hello");
    expect(sent()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await typed(a, SPAM);
    expect((await conv(a)).mode).toBe("BLOCKED");
    expect(await db.prepare("SELECT reason, by FROM blocks WHERE wa_id = ?1").bind(a).first()).toEqual({ reason: "NOISE_REPEAT", by: "system" });
    fetchMock.mockClear();
    await typed(a, "hello");
    expect(sent()).toHaveLength(0);

    vi.setSystemTime(NOW);
    const b = await greeted();
    for (let i = 0; i < 3; i++) await typed(b, SPAM);
    vi.setSystemTime(NOW + 31 * DAY);
    for (let i = 0; i < 3; i++) await typed(b, SPAM);
    expect((await conv(b)).mode).toBe("BOT");
    expect(await state(b)).toMatchObject({ quiet_count_30d: 1, quiet_until: iso(NOW + 38 * DAY) });
  });

  it("smalltalk: the first two a day are free, then a strike each", async () => {
    const { applyLabel } = await import("../src/noise");
    const from = await greeted();
    const c = await conv(from);
    const run = async () => applyLabel(env(), { id: c.id, wa_id: c.wa_id, locale: c.locale, consent_at: c.consent_at }, "smalltalk", "how is the weather", { msgId: `m${++n}` });
    expect(await run()).toEqual({ stop: false });
    expect(await run()).toEqual({ stop: false });
    expect((await state(from)).strikes).toBe(0);
    expect(await run()).toEqual({ stop: false });
    expect((await state(from)).strikes).toBe(1);
    vi.setSystemTime(NOW + DAY);
    expect(await run()).toEqual({ stop: false });
    expect((await state(from)).strikes).toBe(1); // a new India day: free again
  });

  it("the other strike labels add a strike and leave the reply to the caller; the normal labels do nothing; the third strike is the quiet week", async () => {
    const { applyLabel } = await import("../src/noise");
    const from = await greeted();
    const c = await conv(from);
    const run = (label: Parameters<typeof applyLabel>[2]) => applyLabel(env(), { id: c.id, wa_id: c.wa_id, locale: c.locale, consent_at: c.consent_at }, label, "text", { msgId: `m${++n}` });
    for (const l of ["relevant_question", "personal_concern", "objection", "booking_intent", "existing_booking", "human_request"] as const) expect(await run(l), l).toEqual({ stop: false });
    expect((await state(from)).strikes).toBe(0);
    expect(await run("off_topic")).toEqual({ stop: false });
    expect(await run("astrology_or_prediction")).toEqual({ stop: false });
    expect((await state(from)).strikes).toBe(2);
    expect(await run("loop")).toEqual({ stop: true }); // the third: the closing line and a quiet week
    expect(last().text.body).toBe(allCopy.en.quietClose);
    expect(await state(from)).toMatchObject({ strikes: 0, quiet_until: iso(NOW + 7 * DAY) });
    const other = await greeted();
    const o = await conv(other);
    expect(await applyLabel(env(), { id: o.id, wa_id: o.wa_id, locale: o.locale, consent_at: o.consent_at }, "prohibited_request", "text", { msgId: `m${++n}` })).toEqual({ stop: false });
    expect((await state(other)).strikes).toBe(1);
  });

  it("flirting: a strike and one line; a block on an explicit word or on a second offence", async () => {
    for (const lang of ["en", "hi"] as const) {
      const a = await greeted(lang);
      await typed(a, lang === "en" ? "can you send pic please" : "फोटो भेजो");
      expect(sent()).toHaveLength(1);
      expect(last().text.body).toBe(allCopy[lang].flirtLine);
      expect(await state(a)).toMatchObject({ strikes: 1, flirt_offences: 1 });
      expect((await conv(a)).mode).toBe("BOT");
      fetchMock.mockClear();
      await typed(a, "i love you");
      expect(sent()).toHaveLength(0); // second offence: blocked, so no line
      expect((await conv(a)).mode).toBe("BLOCKED");
      expect(await db.prepare("SELECT reason FROM blocks WHERE wa_id = ?1").bind(a).first()).toEqual({ reason: "NOISE_SEXUAL" });
    }
    const b = await greeted();
    await typed(b, "send nudes");
    expect(sent()).toHaveLength(0);
    expect((await conv(b)).mode).toBe("BLOCKED"); // an explicit word: at once
    expect(await db.prepare("SELECT reason FROM blocks WHERE wa_id = ?1").bind(b).first()).toEqual({ reason: "NOISE_SEXUAL" });
  });

  it("abuse: a strike and no reply; a block on a strong word or on a second offence", async () => {
    const a = await greeted();
    await typed(a, "you are an idiot");
    expect(sent()).toHaveLength(0);
    expect(await state(a)).toMatchObject({ strikes: 1, abuse_offences: 1 });
    expect((await conv(a)).mode).toBe("BOT");
    await typed(a, "stupid bot");
    expect((await conv(a)).mode).toBe("BLOCKED");
    expect(await db.prepare("SELECT reason FROM blocks WHERE wa_id = ?1").bind(a).first()).toEqual({ reason: "NOISE_ABUSE" });
    const b = await greeted();
    await typed(b, "tum chutiya ho");
    expect((await conv(b)).mode).toBe("BLOCKED");
    const c = await greeted();
    await typed(c, "तुम बेवकूफ हो");
    expect(await state(c)).toMatchObject({ strikes: 1, abuse_offences: 1 });
    expect(sent()).toHaveLength(0);
  });

  it("the word lists do not catch ordinary questions", async () => {
    for (const t of [
      "Is this a scam? Any proof?", "My wife and I have problems in our intimate life", "my boyfriend left me, can you help", "I need to talk to someone about my family",
      "Can I book for my son, he is 10?", "what is the price? see https://example.invalid", "मेरे पति बहुत परेशान हैं", "kitne ka hai", "she is my sister-in-law",
    ]) expect(classifyWithoutAI(t), t).toBe("TO_CLASSIFIER");
    expect(classifyWithoutAI("Earn ₹5000 daily, click here www.example.invalid")).toBe("spam_or_promo");
    expect(classifyWithoutAI("click here for a great offer")).toBe("TO_CLASSIFIER"); // no link
    expect(classifyWithoutAI("my website is example.com and I earn well")).toBe("spam_or_promo");
  });
});

describe("short acknowledgements and the opt-out", () => {
  it("'ok', 'thanks', emoji: no reply, no strike, no item, however many", async () => {
    for (const lang of ["en", "hi"] as const) {
      const from = await greeted(lang);
      for (let i = 0; i < 5; i++) for (const w of ["ok", "Thanks!", "👍", "🙏", lang === "hi" ? "धन्यवाद" : "thank you", "ji"]) await typed(from, w);
      expect(sent()).toHaveLength(0);
      expect(await state(from)).toMatchObject({ strikes: 0 });
    }
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: stop -> confirmed once; no template afterwards; any later message ends it`, async () => {
      const from = await greeted(lang);
      await typed(from, lang === "en" ? "STOP" : "बंद करो");
      expect(sent()).toHaveLength(1);
      expect(last().text.body).toBe(allCopy[lang].optOutConfirm);
      expect((await state(from)).opted_out_at).toBe(iso(NOW));
      await typed(from, "band karo");
      expect(sent()).toHaveLength(1); // confirmed once
      const id = (await conv(from)).id as number;
      expect(await sendMessage(env(), id, { type: "template", name: "reminder", params: ["call", "Mon", "2 pm"] }, "t-opt-1")).toBe("OPTED_OUT");
      expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM messages WHERE dedupe_key = 't-opt-1'")).toBe(0);
      expect(await sendMessage(env(), id, { type: "text", text: "Rohit's reply" }, "t-opt-2")).toBe("SENT"); // a reply inside the window is not a template
      await typed(from, "hello");
      expect((await state(from)).opted_out_at).toBeNull();
      expect(sent().at(-1).interactive.body.text).toBe(allCopy[lang].menuBody);
      expect(await sendMessage(env(), id, { type: "template", name: "reminder", params: ["call", "Mon", "2 pm"] }, "t-opt-3")).toBe("TEMPLATE_UNAPPROVED"); // templates are possible again
    });
  }
});

describe("first-message and media logic, now in the gate", () => {
  it("a first message is only the greeting; a question in it is kept and answered after the language tap", async () => {
    const from = newPhone();
    await typed(from, "What is pranic healing?");
    expect(sent()).toHaveLength(1);
    expect(last().interactive.body.text).toBe(allCopy.en.greeting);
    expect((await conv(from)).first_question_msg).not.toBeNull();
    expect((await conv(from)).greeted_at).toBe(iso(NOW));
    await tap(from, "lang_hi");
    expect(sent()[1].text.body).toBe(allCopy.hi.ack);
    expect((await conv(from)).last_ack_at).toBe(iso(NOW));
  });

  it("media: the notice and menu once a day, kept on the person, not in the messages", async () => {
    const from = await greeted();
    await media(from, "audio");
    expect(sent()).toHaveLength(2);
    expect((await state(from)).media_notice_day).toBe("2026-10-05");
    await media(from, "image");
    expect(sent()).toHaveLength(2);
    vi.setSystemTime(NOW + DAY);
    await media(from, "image");
    expect(sent()).toHaveLength(4);
    expect((await state(from)).media_notice_day).toBe("2026-10-06");
  });

  it("the ack is once per 24 hours, kept on the conversation", async () => {
    const from = await greeted();
    await typed(from, "can you tell me more about how this works");
    expect(sent()).toHaveLength(1);
    expect(last().text.body).toBe(allCopy.en.ack);
    expect((await conv(from)).last_ack_at).toBe(iso(NOW));
    await typed(from, "hello? anyone there");
    expect(sent()).toHaveLength(1);
    vi.setSystemTime(NOW + 25 * 3_600_000);
    await typed(from, "hello? anyone there?");
    expect(sent()).toHaveLength(2);
  });
});

describe("burst: a newer message from the same person means the older reply is not sent", () => {
  it("the older message's reply is recorded as SKIPPED / NEWER_MESSAGE and nothing goes out", async () => {
    const from = await greeted();
    const t = Math.floor(NOW / 1000);
    await typed(from, "hello", { timestamp: String(t + 5) }); // the newer message is handled first
    expect(sent()).toHaveLength(1);
    fetchMock.mockClear();
    await typed(from, "and how long is the call?", { timestamp: String(t) }); // the older one arrives afterwards
    expect(sent()).toHaveLength(0);
    const row = await db.prepare("SELECT status, skip_reason, body FROM messages WHERE skip_reason IS NOT NULL").first();
    expect(row).toEqual({ status: "SKIPPED", skip_reason: "NEWER_MESSAGE", body: null });
    // The state changes of the older message still happen (the item for Rohit); only the reply is skipped.
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'FREE_TEXT'")).toBe(1);
    expect((await conv(from)).last_ack_at).toBeNull(); // an acknowledgement that did not go out is not remembered
  });

  it("button taps are never skipped, and a replay does not skip anything new", async () => {
    const from = await greeted();
    const t = Math.floor(NOW / 1000);
    await typed(from, "hello", { timestamp: String(t + 5) });
    fetchMock.mockClear();
    await post(wrap(from, { type: "interactive", timestamp: String(t), interactive: { type: "button_reply", button_reply: { id: "menu_how", title: "x" } } }));
    expect(sent()).toHaveLength(1);
  });
});

describe("the open booking step is sent again when someone types (docs/AGENT.md section 3.1c)", () => {
  const reprompt = (lang: Lang, hint: string, original: string) => `${allCopy[lang].reprompt(hint)}\n\n${original}`;
  const hours = (lang: Lang) => allCopy[lang].hintDays;

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: language, age, service, who for, day, time and pay each come back with the re-prompt, and 'Saturday please' gets the hours`, async () => {
      const c = allCopy[lang];
      const ask = lang === "en" ? "Saturday please" : "शनिवार चाहिए";
      const from = newPhone();
      await typed(from, "hello");
      await typed(from, ask); // the language step is open
      expect(last().interactive.body.text).toBe(reprompt("en", "", c.chooseLanguage));
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["lang_en", "lang_hi"]);
      await tap(from, `lang_${lang}`);

      await tap(from, "menu_book");
      await typed(from, ask);
      expect(last().interactive.body.text).toBe(reprompt(lang, "", c.ageCheck));
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["age_yes", "age_no"]);
      await tap(from, "age_yes");
      await typed(from, ask);
      expect(last().interactive.body.text).toBe(reprompt(lang, "", c.chooseService));
      await tap(from, "svc_HEALING");
      await typed(from, ask);
      expect(last().interactive.body.text).toBe(reprompt(lang, "", c.whoFor));
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["who_HEALING_SELF", "who_HEALING_FAMILY", "who_HEALING_PET"]);
      await tap(from, "who_HEALING_SELF");
      const days = last().interactive.action.buttons.map((b: Wa) => b.reply.id);
      await typed(from, ask);
      expect(last().interactive.body.text).toBe(reprompt(lang, hours(lang), c.chooseDay));
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(days);
      await tap(from, days[1]);
      const rows = last().interactive.action.sections.flatMap((s: Wa) => s.rows).map((r: Wa) => r.id);
      await typed(from, ask);
      expect(last().interactive.type).toBe("list");
      expect(last().interactive.body.text).toBe(reprompt(lang, hours(lang), c.timesFor(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर")));
      expect(last().interactive.action.sections.flatMap((s: Wa) => s.rows).map((r: Wa) => r.id)).toEqual(rows);
      await tapRow(from, rows[2]);
      const pay = last();
      expect(pay.interactive.type).toBe("cta_url");
      await typed(from, ask);
      expect(last().interactive.type).toBe("cta_url");
      expect(last().interactive.action.parameters.url).toBe(pay.interactive.action.parameters.url);
      expect(last().interactive.body.text).toBe(reprompt(lang, "", pay.interactive.body.text));
      // none of those was a strike, an item for Rohit or an acknowledgement
      expect((await state(from)).strikes).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
      expect(sent().some((p) => p.text?.body === c.ack)).toBe(false);
    });
  }

  it("the hours hint says when calls and sessions happen, from config", () => {
    expect(allCopy.en.hintDays).toBe("Calls and sessions are Monday to Friday, 2 pm to 7 pm (India time).");
    expect(allCopy.hi.hintDays).toBe("कॉल और सेशन सोमवार से शुक्रवार, दोपहर 2 से शाम 7 बजे तक (भारतीय समय) होते हैं।");
    expect(allCopy.en.reprompt("")).toBe("Please choose from the options below.");
    expect(allCopy.en.reprompt("X.")).toBe("X. Please choose from the options below.");
    expect(allCopy.hi.reprompt("")).toBe("कृपया नीचे दिए विकल्पों में से चुनें।");
  });

  it("after three in a row 'Talk to a person' is added as a second message; a tap starts the count again", async () => {
    const from = await greeted();
    await ageOk(from);
    await tap(from, "menu_book");
    fetchMock.mockClear();
    await typed(from, "one");
    await typed(from, "two");
    expect(sent()).toHaveLength(2);
    await typed(from, "three");
    expect(sent()).toHaveLength(4);
    expect(last().interactive.body.text).toBe(allCopy.en.repromptHelp);
    expect(last().interactive.action.buttons).toEqual([{ type: "reply", reply: { id: "menu_person", title: allCopy.en.btnPerson } }]);
    await typed(from, "four");
    expect(sent()).toHaveLength(6);
    await tap(from, "svc_HEALING");
    expect((await conv(from)).pending_reprompts).toBe(0);
    fetchMock.mockClear();
    await typed(from, "five");
    expect(sent()).toHaveLength(1);
    await tap(from, "menu_person"); // the help button works
    expect((await conv(from)).mode).toBe("HUMAN");
    expect((await conv(from)).pending_step).toBeNull();
  });

  it("safety, a person, 'stop' and menu words are not re-prompts, and a menu word closes the step", async () => {
    const from = await greeted();
    await ageOk(from);
    await tap(from, "menu_book");
    await tap(from, "svc_HEALING");
    fetchMock.mockClear();
    await typed(from, "ok"); // an acknowledgement: no reply
    expect(sent()).toHaveLength(0);
    await typed(from, "hello");
    expect(last().interactive.body.text).toBe(allCopy.en.menuBody);
    expect((await conv(from)).pending_step).toBeNull();
    await tap(from, "menu_book");
    await typed(from, "I can't breathe");
    expect(last().text.body).toBe(allCopy.en.emergency);
    await typed(from, "human");
    expect(last().text.body).toBe(allCopy.en.handoffAck);
    expect((await conv(from)).mode).toBe("HUMAN");
    const other = await greeted();
    await tap(other, "menu_book");
    await ageOk(other);
    await typed(other, "stop");
    expect(last().text.body).toBe(allCopy.en.optOutConfirm);
  });

  it("with no step open (or an old one) typed text gets today's acknowledgement; paying ends the pay step; so does the passing of time", async () => {
    const from = await greeted();
    await ageOk(from);
    await tap(from, "menu_book");
    await tap(from, "svc_HEALING");
    await tap(from, "who_HEALING_SELF");
    await tap(from, "day_HEALING_SELF_2026-10-06");
    await tapRow(from, `time_HEALING_SELF_${call(2).startUtc}`);
    expect((await conv(from)).pending_step).toBe("pay");
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    const raw = JSON.stringify(paidEvent(link));
    await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env());
    expect((await conv(from)).pending_step).toBeNull();
    fetchMock.mockClear();
    await typed(from, "when is my call exactly?");
    expect(last().text.body).toBe(allCopy.en.ack);

    const other = await greeted();
    await ageOk(other);
    await tap(other, "menu_book");
    vi.setSystemTime(NOW + 25 * 3_600_000); // the step is a day old: not open any more
    fetchMock.mockClear();
    await typed(other, "are you there?");
    expect(last().text.body).toBe(allCopy.en.ack);
  });

  it("the session picker's day and time steps are re-sent too", async () => {
    const from = await greeted();
    const c = (await conv(from)).id as number;
    const i = await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(c).run();
    const s = await db.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state) VALUES (?1, ?2, 'HEALING', 'OFFERED')").bind(c, i.meta.last_row_id).run();
    await tap(from, `sess_offer_${s.meta.last_row_id}`);
    expect(last().interactive.body.text).toBe(allCopy.en.chooseDay);
    await typed(from, "Saturday please");
    expect(last().interactive.body.text).toBe(reprompt("en", allCopy.en.hintDays, allCopy.en.chooseDay));
    expect(last().interactive.action.buttons[0].reply.id).toMatch(/^sday_/);
  });
});

describe("Book tapped by someone who already has a call (checked at the tap)", () => {
  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: the already-booked message with [Keep it] [Talk to a person], and nothing else`, async () => {
      const from = await greeted(lang);
      await ageOk(from);
      await intro(from, "PAID", { payment: "PAID" });
      await tap(from, "menu_book");
      expect(sent()).toHaveLength(1);
      const p = last().interactive;
      expect(p.body.text).toBe(allCopy[lang].alreadyBookedStart(lang === "en" ? "Tue, 6 Oct" : "मंगल, 6 अक्टूबर", lang === "en" ? "2:45 pm" : "दोपहर 2:45"));
      expect(p.action.buttons.map((b: Wa) => [b.reply.id, b.reply.title])).toEqual([["book_keep", allCopy[lang].btnKeep], ["menu_person", allCopy[lang].btnPerson]]);
      expect(await count("SELECT COUNT(*) AS n FROM slots WHERE owner_id = (SELECT id FROM conversations WHERE wa_id = '" + from + "') AND state = 'HELD'")).toBe(0);
      await typed(from, "book"); // the word does the same
      expect(sent()).toHaveLength(2);
      expect(last().interactive.action.buttons[0].reply.id).toBe("book_keep");
      await tap(from, "book_keep"); // Keep it: nothing more
      expect(sent()).toHaveLength(2);
      await tap(from, "menu_person");
      expect((await conv(from)).mode).toBe("HUMAN");
    });
  }

  it("a rescheduled call counts; a call that is over, a hold, or someone who never booked does not", async () => {
    const a = await greeted();
    await ageOk(a);
    await intro(a, "RESCHEDULED");
    await tap(a, "menu_book");
    expect(last().interactive.action.buttons[0].reply.id).toBe("book_keep");

    const b = await greeted();
    await ageOk(b);
    const { conv: id } = await intro(b, "PAID");
    await db.prepare("UPDATE slots SET start_utc = '2026-10-04T08:30:00Z', end_utc = '2026-10-04T08:45:00Z' WHERE owner_id = ?1").bind(id).run();
    await tap(b, "menu_book");
    expect(last().interactive.body.text).toBe(allCopy.en.chooseService);

    const c = await greeted();
    await ageOk(c);
    await intro(c, "HELD", { hold: true });
    await tap(c, "menu_book");
    expect(last().interactive.body.text).toBe(allCopy.en.chooseService);

    const d = await greeted();
    await ageOk(d);
    await tap(d, "menu_book");
    expect(last().interactive.body.text).toBe(allCopy.en.chooseService);
  });

  it("while booking is closed an existing booking is still named (not 'Booking opens soon')", async () => {
    const from = await greeted();
    await intro(from, "PAID");
    await db.prepare("INSERT INTO settings (key, value) VALUES ('NEW_BOOKINGS', 'false')").run();
    await tap(from, "menu_book");
    expect(last().interactive.action.buttons[0].reply.id).toBe("book_keep");
  });
});

describe("the chat wipe (test settings: 10 minutes)", () => {
  const wipe = async (ms: number) => (await import("../src/wipe")).wipeChats(env(), ms);
  const bodies = async () => (await db.prepare("SELECT direction, body, wiped_at FROM messages ORDER BY id").all<{ direction: string; body: string | null; wiped_at: string | null }>()).results;

  it("blanks the text of both directions once the last message is older than the window, and nothing else", async () => {
    const from = await greeted("hi");
    await typed(from, "how does this work on the phone?");
    await intro(from, "PAID", { payment: "PAID" });
    const before = await count("SELECT COUNT(*) AS n FROM messages");
    expect((await bodies()).some((m) => m.body)).toBe(true);
    const idsBefore = (await db.prepare("SELECT dedupe_key FROM messages WHERE dedupe_key IS NOT NULL ORDER BY id").all()).results;

    expect(await wipe(NOW + 9 * 60_000)).toBe(0); // 9 minutes: too early
    expect((await bodies()).some((m) => m.body)).toBe(true);
    const changed = await wipe(NOW + 11 * 60_000);
    expect(changed).toBeGreaterThan(0);
    const after = await bodies();
    expect(after.every((m) => m.body === null)).toBe(true);
    expect(after.filter((m) => m.wiped_at).length).toBe(changed);
    expect(await count("SELECT COUNT(*) AS n FROM messages")).toBe(before); // the rows stay
    expect((await db.prepare("SELECT dedupe_key FROM messages WHERE dedupe_key IS NOT NULL ORDER BY id").all()).results).toEqual(idsBefore);
    expect(await wipe(NOW + 12 * 60_000)).toBe(0); // and it is done once

    // Kept: the money and the booking, the language, the greeted flag, the age check.
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE state = 'PAID'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM intros WHERE state = 'PAID'")).toBe(1);
    expect(await conv(from)).toMatchObject({ locale: "hi", greeted_at: iso(NOW) });
  });

  it("a returning customer is not greeted again, the language is kept, and the chat works as before", async () => {
    const from = await greeted("hi");
    await typed(from, "what is the price");
    await wipe(NOW + 11 * 60_000);
    vi.setSystemTime(NOW + 3 * DAY);
    fetchMock.mockClear();
    await typed(from, "hello");
    expect(sent()).toHaveLength(1);
    expect(last().interactive.body.text).toBe(allCopy.hi.menuBody); // the menu in Hindi, not the greeting
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE dedupe_key LIKE 'greet:%'")).toBe(1);
    await typed(from, "what is the price");
    expect(last().text.body).toBe(allCopy.hi.ack); // the 24h ack check does not need the old rows either
  });

  it("only conversations whose last message is old are wiped; a missing setting means 7 days", async () => {
    const old = await greeted("en");
    vi.setSystemTime(NOW + 20 * 60_000);
    const fresh = await greeted("en");
    await wipe(NOW + 25 * 60_000);
    const bodyOf = (who: string) => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body IS NOT NULL AND conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)").bind(who).first<{ n: number }>();
    expect((await bodyOf(old))!.n).toBe(0);
    expect((await bodyOf(fresh))!.n).toBeGreaterThan(0);
    const { wipeChats, retentionMinutes } = await import("../src/wipe");
    const noSetting = { DB: db } as never;
    expect(retentionMinutes(noSetting)).toBe(10080);
    expect(retentionMinutes({ DB: db, CHAT_RETENTION_MINUTES: "nonsense" } as never)).toBe(10080);
    expect(await wipeChats(noSetting, NOW + 3 * DAY)).toBe(0);
    expect(await wipeChats(noSetting, NOW + 8 * DAY)).toBeGreaterThan(0);
  });

  it("the 2-minute cron does it", async () => {
    const from = await greeted();
    await typed(from, "what is the price");
    vi.setSystemTime(NOW + 11 * 60_000);
    await app.scheduled({ cron: "*/2 * * * *" }, env());
    expect((await bodies()).every((m) => m.body === null)).toBe(true);
  });

  it("names go 90 days after the last booking (or, with no booking, the last message)", async () => {
    const { removeOldNames } = await import("../src/wipe");
    const person = async (name: string, lastUser: string, bookingEnd?: string) => {
      const id = (await db.prepare("INSERT INTO conversations (wa_id, display_name, last_user_at) VALUES (?1, ?2, ?3)").bind(newPhone(), name, lastUser).run()).meta.last_row_id;
      if (bookingEnd) await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(iso(Date.parse(bookingEnd) - 15 * 60_000), bookingEnd, id).run();
      return id;
    };
    const day = (d: number) => iso(NOW - d * DAY).replace(/T.*$/, "T09:00:00Z");
    const old = await person("Old Booker", day(200), day(91));
    const recent = await person("Recent Booker", day(200), day(89));
    const upcoming = await person("Upcoming", day(200), iso(NOW + 2 * DAY).replace(/T.*$/, "T09:00:00Z"));
    const quietOld = await person("Never Booked Old", day(91));
    const quietNew = await person("Never Booked New", day(10));
    await removeOldNames({ DB: db } as never, NOW);
    const names = (await db.prepare("SELECT id, display_name FROM conversations").all<{ id: number; display_name: string | null }>()).results;
    const nameOf = (id: number) => names.find((r) => r.id === id)!.display_name;
    expect([nameOf(old), nameOf(recent), nameOf(upcoming), nameOf(quietOld), nameOf(quietNew)]).toEqual([null, "Recent Booker", "Upcoming", null, "Never Booked New"]);
  });
});

describe("migration 0006", () => {
  it("fills greeted_at, last_ack_at and the media notice day from the old message rows, and only from messages that went out", async () => {
    const old = await newDb(5);
    try {
      const { applySql } = await import("./db");
      const { migrations } = await import("./db");
      for (const wa of ["919800000001", "919800000002"]) await old.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(wa).run();
      const out = (conv: number, key: string, status: string, at: string) =>
        old.db.prepare("INSERT INTO messages (conversation_id, direction, dedupe_key, kind, body, status, created_at) VALUES (?1, 'OUT', ?2, 'text', 'x', ?3, ?4)").bind(conv, key, status, at).run();
      await out(1, "greet:1", "SENT", "2026-09-01T10:00:00Z");
      await out(1, "wamid.A:ack", "SENT", "2026-09-02T10:00:00Z");
      await out(1, "wamid.B:ack", "SKIPPED", "2026-09-03T10:00:00Z");
      await out(1, "media:1:2026-09-02", "SENT", "2026-09-02T11:00:00Z");
      await out(1, "media:1:2026-09-04", "SKIPPED", "2026-09-04T11:00:00Z");
      await out(2, "greet:2", "SKIPPED", "2026-09-01T10:00:00Z");
      await applySql(old.db, migrations.gatekeeperSql);
      expect((await old.db.prepare("SELECT id, greeted_at, last_ack_at FROM conversations ORDER BY id").all()).results).toEqual([
        { id: 1, greeted_at: "2026-09-01T10:00:00Z", last_ack_at: "2026-09-02T10:00:00Z" },
        { id: 2, greeted_at: null, last_ack_at: null },
      ]);
      expect((await old.db.prepare("SELECT conversation_id AS c, media_notice_day AS d, strikes FROM person_state ORDER BY conversation_id").all()).results).toEqual([
        { c: 1, d: "2026-09-02", strikes: 0 },
        { c: 2, d: null, strikes: 0 },
      ]);
    } finally {
      await old.close();
    }
  });
});

describe("the 9pm digest: counts and warm leads, never message text", () => {
  const SECRET_TEXT = "my private sentence about my family";
  it("counts crisis messages, emergencies, blocks by reason, quiet periods, budget fallbacks and opt-outs", async () => {
    const { digestText } = await import("../src/report");
    const a = await greeted();
    await typed(a, "I want to die");
    const b = await greeted();
    await typed(b, "chest pain");
    const c = await greeted();
    await typed(c, "send nudes");
    const d = await greeted();
    for (let i = 0; i < 3; i++) await typed(d, "Earn 5000, click https://example.invalid");
    const e = await greeted();
    await setState(e, "ai_day = '2026-10-05', ai_count = 12");
    await typed(e, SECRET_TEXT);
    const f = await greeted();
    await typed(f, "stop");
    const text = await digestText(env(), NOW);
    expect(text).toContain("Safety and noise (last 24 hours)");
    expect(text).toContain("- Crisis messages: 1");
    expect(text).toContain("- Medical emergencies: 1");
    expect(text).toContain("- Blocks: NOISE_SEXUAL 1");
    expect(text).toContain("- Quiet periods: 1");
    expect(text).toContain("- Budget fallbacks: 1");
    expect(text).toContain("- Opt-outs: 1");
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("want to die");
    expect(await digestText(env(), NOW + 2 * DAY)).toContain("- Crisis messages: 0"); // only the last 24 hours
  });

  it("warm leads: an expired hold or a tap on Book in the last 24 hours and no payment; first name and a link only", async () => {
    const { digestText, warmLeads } = await import("../src/report");
    const people: [string, string][] = []; // [wa_id, name], named at the end because every message from WhatsApp carries a profile name
    const named = async (name: string) => {
      const from = await greeted();
      people.push([from, name]);
      return from;
    };
    const expired = await named("Priya Sharma");
    const { conv: expiredId } = await intro(expired, "EXPIRED");
    const lapsed = await named("Anil Kumar");
    await intro(lapsed, "HELD", { hold: true });
    await db.prepare("UPDATE slots SET hold_until = ?1 WHERE owner_id = (SELECT id FROM conversations WHERE wa_id = ?2)").bind(iso(NOW - 60_000), lapsed).run();
    const tapped = await named("Meera Rao");
    await tap(tapped, "menu_book");
    const typedBook = await named("Kiran Das");
    await ageOk(typedBook);
    await typed(typedBook, "book");
    const paid = await named("Qpaid Person");
    await intro(paid, "PAID", { payment: "PAID" });
    await tap(paid, "menu_book");
    const crisis = await named("Qcrisis Person");
    await tap(crisis, "menu_book");
    await typed(crisis, "I want to die");
    const blocked = await named("Qblocked Person");
    await tap(blocked, "menu_book");
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1").bind(blocked).run();
    const optedOut = await named("Qoptout Person");
    await tap(optedOut, "menu_book");
    await typed(optedOut, "stop");
    const stale = await named("Qstale Person");
    await tap(stale, "menu_book");
    await setState(stale, "book_tap_at = ?2", iso(NOW - 2 * DAY));
    await named("Qnever Tapped");
    for (const [wa, name] of people) await db.prepare("UPDATE conversations SET display_name = ?2 WHERE wa_id = ?1").bind(wa, name).run();

    expect((await warmLeads(env(), NOW)).map((l) => l.name)).toEqual(["Priya Sharma", "Anil Kumar", "Meera Rao", "Kiran Das"]);
    const text = await digestText(env(), NOW);
    expect(text).toContain("Warm leads (last 24 hours, not paid yet)");
    expect(text).toContain(`- Priya · https://bot.example.test/admin/conv/${expiredId}`);
    expect(text).not.toContain("Sharma");
    expect(text.slice(text.indexOf("Warm leads"))).not.toContain("Q"); // none of the people who must not be listed
  });
});
