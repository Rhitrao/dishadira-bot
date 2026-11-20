// Ticket 49 (CONTRACT v18): catalogue services offered by the bot behind NEW_SERVICES (src/offer.ts), the question after payment, the two
// health questions before the hold, and the reading-safety replies in the gatekeeper (src/gate.ts). The Tarot reading here exists only in
// these tests. All data synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { alertPayload } from "../src/alerts";
import { loadPrices } from "../src/business";
import { config } from "../src/config";
import { allCopy } from "../src/copy";
import { readingSafety } from "../src/gate";
import { sendReminders } from "../src/remind";
import { removeOldNames, wipePersonStmts } from "../src/wipe";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";
import { newDb } from "./db";
import { paidEvent, rzpHeaders } from "./razorpay";
import { NOW, Wa, type Json } from "./wa";

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

// The catalogue in force is module state (read at the start of each request): put back the seeded one after a test.
async function resetCatalogue() {
  const fresh = await newDb();
  await loadPrices({ DB: fresh.db });
  await fresh.close();
}

type Tarot = { active?: boolean; public?: boolean; callFirst?: boolean; screen?: boolean; intake?: boolean; cap?: number | null };
async function addTarot(db: D1Database, o: Tarot = {}) {
  await db
    .prepare(
      `INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, daily_cap, active, public, sort, intake_en, intake_hi, screen)
       VALUES ('tarot_reading', 'Tarot reading', 'टैरो रीडिंग', 'UNDERSTAND', 30, 49900, ?1, ?2, ?3, ?4, 30, ?5, ?6, ?7)`,
    )
    .bind(
      o.callFirst ? 1 : 0, o.cap ?? null, o.active === false ? 0 : 1, o.public === false ? 0 : 1,
      o.intake === false ? null : "What question would you like to bring to your reading?", o.intake === false ? null : "आप अपनी रीडिंग में कौन सा सवाल लाना चाहेंगे?",
      o.screen ? 1 : 0,
    )
    .run();
}

const w = new Wa();
beforeEach(() => w.start());
afterEach(async () => {
  await w.stop();
  await resetCatalogue();
});

const bodyOf = (p: Json): string => p.text?.body ?? p.interactive?.body?.text ?? "";
const rowsOf = (p: Json): Json[] => (p.interactive?.action?.sections ?? []).flatMap((s: Json) => s.rows);
const buttonsOf = (p: Json): string[] => (p.interactive?.action?.buttons ?? []).map((b: Json) => b.reply.id);
const sid = async () => (await w.db.prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").first<{ id: number }>())?.id;
const pay = async (link: string, amount: number) => {
  const raw = JSON.stringify(paidEvent(link, { amount }));
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, w.env());
};

describe("NEW_SERVICES 'false' (live): the bot is exactly as before, whatever the catalogue says", () => {
  // The same chat, booking a ₹99 call and opening Sessions & packages, with and without an offered Tarot reading in the catalogue.
  async function chat(): Promise<Json[]> {
    const from = await w.greeted("en");
    await w.typed(from, "book");
    await w.tap(from, "age_yes");
    await w.tap(from, "svc_HEALING");
    await w.tap(from, "who_HEALING_SELF");
    await w.tapRow(from, "day_HEALING_SELF_2026-10-06");
    await w.tapRow(from, "time_HEALING_SELF_2026-10-06T08:30:00Z");
    await w.tap(from, "menu_pack");
    await w.typed(from, "hi");
    return w.sent().map((p: Json) => ({ ...p, to: "x" }));
  }

  it("the same messages, byte for byte, with an active and public Tarot reading in the catalogue", async () => {
    const before = await chat();
    await w.stop();
    await w.start();
    await addTarot(w.db);
    const after = await chat();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("Tarot");
    expect(bodyOf(after[0])).toBe(allCopy.en.ageCheck); // "book" goes straight to the call's steps
  });

  it("an old catalogue button gets the menu with a kind line, and books nothing", async () => {
    await addTarot(w.db);
    const from = await w.greeted("en");
    await w.tap(from, "cat_tarot_reading");
    expect(bodyOf(w.last())).toBe(allCopy.en.offerNotAvailable);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });
});

describe("NEW_SERVICES 'true' (test): Book lists the offered services, and a Tarot reading books end to end", () => {
  beforeEach(() => void (w.newServices = "true"));

  it("Book: the ₹99 call first, the session, then the offered services by pathway; WhatsApp's limits respected", async () => {
    await addTarot(w.db);
    await w.db.prepare("INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, active, public, sort) VALUES ('hidden_one', 'Hidden', 'छिपी', 'REWIRE', 60, 100000, 1, 0, 40)").run();
    const from = await w.greeted("en");
    await w.tap(from, "menu_book");
    const list = w.last();
    expect(list.interactive.type).toBe("list");
    expect(bodyOf(list)).toBe(allCopy.en.offerBody);
    const sections = list.interactive.action.sections as Json[];
    expect(sections.map((s) => s.title)).toEqual(["Start here", "Understand"]);
    expect(rowsOf(list).map((r) => r.id)).toEqual(["book_call", "pk_single", "cat_tarot_reading"]);
    expect(rowsOf(list)[2]).toEqual({ id: "cat_tarot_reading", title: "Tarot reading", description: "30 min · ₹499 · voice call" });
    for (const r of rowsOf(list)) {
      expect(r.title.length).toBeLessThanOrEqual(24);
      expect(r.description.length).toBeLessThanOrEqual(72);
    }
    // The call row is the old "Book": its age question first.
    await w.tapRow(from, "book_call");
    expect(bodyOf(w.last())).toBe(allCopy.en.ageCheck);
    // A service that is off (not active) is not listed; with none offered, Book is the call's steps as before.
    await w.db.prepare("UPDATE services SET active = 0 WHERE key = 'tarot_reading'").run();
    await w.tap(from, "menu_book");
    expect(bodyOf(w.last())).toBe(allCopy.en.ageCheck);
  });

  it("a Tarot reading: day, time, a 30-minute hold, a ₹499 link naming it, paid, a confirmation naming it, its question, the answer kept", async () => {
    await addTarot(w.db);
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "cat_tarot_reading");
    const id = (await sid())!;
    expect(await w.db.prepare("SELECT service, for_whom, origin, state, service_key FROM sessions WHERE id = ?1").bind(id).first()).toEqual({
      service: "HEALING", for_whom: "SELF", origin: "SELF", state: "OFFERED", service_key: "tarot_reading",
    });
    expect(rowsOf(w.last()).some((r) => r.id === `sday_${id}_2026-10-06`)).toBe(true);
    await w.tapRow(from, `sday_${id}_2026-10-06`);
    const times = w.last();
    expect(bodyOf(times)).toBe(allCopy.en.serviceTimesFor("Tarot reading", 30, "Tue, 6 Oct"));
    // Half-hourly times (each 30 minutes long), described as such.
    expect(rowsOf(times).slice(0, 3).map((r) => r.id)).toEqual([`sess_${id}_2026-10-06T08:30:00Z`, `sess_${id}_2026-10-06T09:00:00Z`, `sess_${id}_2026-10-06T09:30:00Z`]);
    expect(rowsOf(times)[0].description).toBe("30-min voice call");
    await w.tapRow(from, `sess_${id}_2026-10-06T09:00:00Z`);
    const slot = await w.db.prepare("SELECT start_utc, end_utc, service_key, state FROM slots").first();
    expect(slot).toEqual({ start_utc: "2026-10-06T09:00:00Z", end_utc: "2026-10-06T09:30:00Z", service_key: "tarot_reading", state: "HELD" });
    const payMsg = w.last();
    expect(payMsg.interactive.type).toBe("cta_url");
    expect(payMsg.interactive.action.parameters.display_text).toBe("Pay ₹499");
    expect(bodyOf(payMsg)).toContain("held for your Tarot reading");
    const linkPost = w.fake.posts("/payment_links").at(-1)!.body!;
    expect(linkPost.amount).toBe(49900);
    expect(linkPost.description).toBe("Disha Dira Tarot reading booking");

    const link = (await w.db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    w.fetchMock.mockClear();
    expect((await pay(link, 49900)).status).toBe(200);
    expect(await w.db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(id).first()).toEqual({ state: "CONFIRMED" });
    const [confirm, intake] = w.sent();
    expect(bodyOf(confirm)).toBe(allCopy.en.serviceConfirmed("Tarot reading", "Tue, 6 Oct", "2:30 pm", true));
    expect(bodyOf(confirm)).toContain("voice call by phone");
    expect(bodyOf(intake)).toBe(allCopy.en.intakeAsk("What question would you like to bring to your reading?"));
    expect(buttonsOf(intake)).toEqual([`ik_${id}_skip`]);

    // Their answer is kept on the session (never sent to the AI), and thanked once.
    w.fetchMock.mockClear();
    await w.typed(from, "Should I change my job this year");
    expect(w.aiCalls()).toHaveLength(0);
    expect(bodyOf(w.last())).toBe(allCopy.en.intakeThanks);
    expect((await w.db.prepare("SELECT intake_answer AS a FROM sessions WHERE id = ?1").bind(id).first<{ a: string }>())!.a).toBe("Should I change my job this year");

    // My bookings names it.
    await w.tap(from, "menu_bookings");
    expect(bodyOf(w.sent().find((p: Json) => bodyOf(p).includes("Tarot reading on"))!)).toContain("Tarot reading on Tue, 6 Oct at 2:30 pm");
  });

  it("Hindi: the times, the pay message and the confirmation name the service in Hindi; Skip keeps nothing", async () => {
    await addTarot(w.db);
    const from = await w.greeted("hi");
    await w.ageOk(from);
    await w.tapRow(from, "cat_tarot_reading");
    const id = (await sid())!;
    await w.tapRow(from, `sday_${id}_2026-10-06`);
    expect(bodyOf(w.last())).toContain("टैरो रीडिंग");
    await w.tapRow(from, `sess_${id}_2026-10-06T09:00:00Z`);
    expect(w.last().interactive.action.parameters.display_text).toBe("₹499 भुगतान करें");
    const link = (await w.db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    w.fetchMock.mockClear();
    await pay(link, 49900);
    expect(bodyOf(w.sent()[0])).toContain("आपकी टैरो रीडिंग");
    expect(bodyOf(w.sent()[1])).toContain("आप अपनी रीडिंग में कौन सा सवाल लाना चाहेंगे?");
    await w.tap(from, `ik_${id}_skip`);
    expect((await w.db.prepare("SELECT intake_answer AS a FROM sessions WHERE id = ?1").bind(id).first<{ a: string | null }>())!.a).toBeNull();
  });

  it("a payment is checked against the service's price when its link was made (not the session's ₹799)", async () => {
    await addTarot(w.db);
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "cat_tarot_reading");
    const id = (await sid())!;
    await w.tapRow(from, `sess_${id}_2026-10-06T09:00:00Z`);
    // The owner raises the price after the link was made: the old link's amount is still right.
    await w.db.batch([
      w.db.prepare("UPDATE services SET price_paise = 59900 WHERE key = 'tarot_reading'"),
      w.db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES ('2099-01-01T00:00:00Z', 'owner', 'SERVICE_UPDATE', 'service:tarot_reading', 'price 49900 -> 59900')"),
    ]);
    const link = (await w.db.prepare("SELECT provider_link_id AS l FROM payments").first<{ l: string }>())!.l;
    await pay(link, 49900);
    expect(await w.db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PAID" });
    expect(await w.count("SELECT COUNT(*) AS n FROM attention WHERE kind IN ('PAYMENT_MISMATCH', 'UNSUPPORTED_PAYMENT')")).toBe(0);
  });

  it("only after the first call: someone who hasn't had one is offered the ₹99 call instead; after it, the times", async () => {
    await addTarot(w.db, { callFirst: true });
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tap(from, "menu_book");
    expect(rowsOf(w.last())[2].description).toBe("30 min · ₹499 · voice call · after the ₹99 call");
    await w.tapRow(from, "cat_tarot_reading");
    expect(bodyOf(w.last())).toBe(allCopy.en.offerCallFirst("Tarot reading"));
    expect(buttonsOf(w.last())).toEqual(["book_call", "menu_how"]);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    const conv = (await w.conv(from)).id;
    await w.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(conv).run();
    await w.tapRow(from, "cat_tarot_reading");
    expect(bodyOf(w.last())).toBe(allCopy.en.chooseDay);
  });

  it("the two health questions: any yes sends them to the ₹99 call, books nothing and keeps no answer (SCREENED_TO_CALL only)", async () => {
    await addTarot(w.db, { screen: true });
    const from = await w.greeted("en");
    await w.ageOk(from);
    await w.tapRow(from, "cat_tarot_reading");
    expect(bodyOf(w.last())).toBe(allCopy.en.screenQ1);
    expect(buttonsOf(w.last())).toEqual(["scr_tarot_reading_1_yes", "scr_tarot_reading_1_no"]);
    await w.tap(from, "scr_tarot_reading_1_no");
    expect(bodyOf(w.last())).toBe(allCopy.en.screenQ2);
    await w.tap(from, "scr_tarot_reading_2_yes");
    expect(bodyOf(w.last())).toBe(allCopy.en.screenToCall("Tarot reading"));
    expect(buttonsOf(w.last())).toEqual(["book_call", "menu_how"]);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    expect(await w.count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    const audit = await w.db.prepare("SELECT actor, action, target, detail FROM audit_log WHERE action = 'SCREENED_TO_CALL'").all();
    expect(audit.results).toEqual([{ actor: "bot", action: "SCREENED_TO_CALL", target: `conv:${(await w.conv(from)).id}`, detail: "service:tarot_reading" }]);
    // Typed answers work too: "no", "nahi" -> the times.
    await w.tapRow(from, "cat_tarot_reading");
    await w.typed(from, "no");
    expect(bodyOf(w.last())).toBe(allCopy.en.screenQ2);
    await w.typed(from, "nahi");
    expect(bodyOf(w.last())).toBe(allCopy.en.chooseDay);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions WHERE service_key = 'tarot_reading'")).toBe(1);
    expect(w.aiCalls()).toHaveLength(0);
  });

  it("the day-before reminder names it: free text in the window, the approved reminder template (its name as {{1}}) outside", async () => {
    await addTarot(w.db);
    const from = await w.greeted("en");
    const conv = (await w.conv(from)).id;
    const slot = (await w.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, service_key) VALUES ('SESSION', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z', ?1, 'BOOKED', 'tarot_reading')").bind(conv).run()).meta.last_row_id;
    await w.db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, service_key) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', 'SELF', 'tarot_reading')").bind(conv, slot).run();
    w.fetchMock.mockClear();
    await sendReminders(w.env(), Date.parse("2026-10-05T13:00:00Z"));
    expect(bodyOf(w.last())).toBe(allCopy.en.reminderService("Tarot reading", "Tue, 6 Oct", "2:30 pm"));
    // Outside the window: the template, with the service's name.
    await w.db.prepare("DELETE FROM messages WHERE dedupe_key LIKE 'reminder:%'").run();
    await w.db.prepare("UPDATE conversations SET last_user_at = '2026-10-01T00:00:00Z' WHERE id = ?1").bind(conv).run();
    w.fetchMock.mockClear();
    (config.templates.reminder as { approved: boolean }).approved = true; // tests start with no template approved (test/setup.ts)
    await sendReminders(w.env(), Date.parse("2026-10-05T13:00:00Z"));
    expect(w.last().template.name).toBe("reminder");
    expect(w.last().template.components[0].parameters.map((p: Json) => p.text)).toEqual(["Tarot reading", "Tue, 6 Oct", "2:30 pm"]);
  });

  it("the phone alert names the service (kind, amount and time only, never a name or number)", async () => {
    await addTarot(w.db);
    await w.typed(w.newPhone(), "hi"); // a request loads this catalogue
    const p = alertPayload({ kind: "SESSION", amount: 49900, bookingId: 1, startUtc: "2026-10-06T09:00:00Z", serviceKey: "tarot_reading" }, "en", 1, NOW);
    expect(p.body).toBe("Tarot reading · ₹499 · Tomorrow, 2:30 pm");
    expect(alertPayload({ kind: "SESSION", amount: 79900, bookingId: 2, startUtc: "2026-10-06T09:00:00Z", serviceKey: "single_session" }, "en", 2, NOW).body).toBe("₹799 session · Tomorrow, 2:30 pm");
  });
});

describe("reading-safety replies (every bot, whatever NEW_SERVICES says): fixed, calm, no AI, no strike", () => {
  const spell = ["Is there black magic on my family?", "someone did something to me", "Mujh par kala jadu kiya hai", "kisi ne kuch kar diya hai ghar pe", "lagta hai nazar lagi hai", "bhoot pret ka saya hai", "jadoo tona hata do", "मेरे ऊपर किसी ने काला जादू किया है", "evil eye remove karo"];
  const predict = ["When will I die?", "Will I get pregnant this year?", "will i pass my exam", "Can you predict my court case result", "meri maut kab hogi", "kya main pregnant hoongi", "mera case jeetunga kya", "मेरी शादी किस दिन होगा बताइए", "बच्चा कब होगा"];
  const normal = ["I feel stuck", "energy cleansing", "I have been feeling heavy and tired", "When is my call?", "How long will the session be?", "can I book for my mother?", "kab call hogi", "My exam is next week, can I book Saturday?", "In case I miss the call will I get a refund?"];

  it("the word lists: spells and predictions are caught; ordinary messages are not", () => {
    for (const t of spell) expect(readingSafety(t), t).toBe("READING_SPELL");
    for (const t of predict) expect(readingSafety(t), t).toBe("READING_PREDICT");
    for (const t of normal) expect(readingSafety(t), t).toBeNull();
    expect(readingSafety("black magic you idiot")).toBeNull(); // abuse keeps its own rule
  });

  it("English and Hindi replies, with the AI on and off; never a strike or a block; a loop gets silence", async () => {
    for (const ai of ["true", "false"]) {
      w.aiFlag = ai;
      const from = await w.greeted("en");
      await w.typed(from, "Someone has done black magic on me, please remove it");
      expect(bodyOf(w.last())).toBe(allCopy.en.readingSpell);
      expect(buttonsOf(w.last())).toEqual(["book_call", "menu_how"]);
      await w.typed(from, "When will I die?");
      expect(bodyOf(w.last())).toBe(allCopy.en.readingPredict);
      expect(buttonsOf(w.last())).toEqual(["menu_how", "menu_person"]); // no booking push
      w.fetchMock.mockClear();
      await w.typed(from, "kala jadu hai kya mujh par");
      expect(w.sent()).toHaveLength(0); // the same reply within 10 minutes: silence
      expect(w.aiCalls()).toHaveLength(0);
      expect((await w.state(from)).strikes).toBe(0);
      expect((await w.conv(from)).mode).toBe("BOT");
    }
    const hi = await w.greeted("hi");
    await w.typed(hi, "मेरे ऊपर किसी ने काला जादू किया है");
    expect(bodyOf(w.last())).toBe(allCopy.hi.readingSpell);
    await w.typed(hi, "बच्चा कब होगा");
    expect(bodyOf(w.last())).toBe(allCopy.hi.readingPredict);
    expect(w.aiCalls()).toHaveLength(0);
  });

  it("crisis and emergency keep priority; the first message is answered after the language tap; ordinary ones still reach the AI", async () => {
    const a = await w.greeted("en");
    await w.typed(a, "I want to die, is it black magic?");
    expect(bodyOf(w.last())).toBe(allCopy.en.crisis);
    const b = await w.greeted("en");
    await w.typed(b, "chest pain, is it nazar?");
    expect(bodyOf(w.last())).toBe(allCopy.en.emergency);
    // A first-ever message: the greeting, then after the language tap the fixed reply (not the assistant).
    const c = w.newPhone();
    await w.typed(c, "will i get pregnant this year?");
    w.fetchMock.mockClear();
    await w.tap(c, "lang_en");
    expect(w.sent().map(bodyOf)).toContain(allCopy.en.readingPredict);
    expect(w.aiCalls()).toHaveLength(0);
    // "I feel stuck" goes to the assistant as before.
    const d = await w.greeted("en");
    await w.typed(d, "I feel stuck");
    expect(w.aiCalls()).toHaveLength(1);
  });

  it("the copy says nothing it must not: no banned word (black magic, curse, cure, guarantee …), and every line in both languages", () => {
    for (const lang of ["en", "hi"] as const) {
      const c = allCopy[lang];
      for (const t of [c.readingSpell, c.readingPredict, c.screenToCall("X"), c.offerCallFirst("X"), c.serviceConfirmed("X", "d", "t"), c.offerBody]) {
        expect(t).not.toMatch(/black magic|evil eye|curse|cure|guarantee|miracle|permanent|काला जादू|बुरी नज़र|पक्का|गारंटी|चमत्कार/i);
      }
      expect(c.offerButton.length).toBeLessThanOrEqual(20);
      expect(c.offerSectionStart.length).toBeLessThanOrEqual(24);
      for (const t of Object.values(c.offerPathway)) expect(t.length).toBeLessThanOrEqual(24);
      expect(c.servicePayLabel("₹1,00,000").length).toBeLessThanOrEqual(20);
      expect(c.offerRowDesc(90, "₹1,00,000", true).length).toBeLessThanOrEqual(72);
    }
  });
});

describe("the answer to the question after payment: wiped with the name, and by Remove their data", () => {
  it("removeOldNames and wipePersonStmts clear it", async () => {
    const conv = (await w.db.prepare("INSERT INTO conversations (wa_id, display_name, last_user_at, created_at) VALUES ('910000000049', 'Test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run()).meta.last_row_id;
    await w.db.prepare("INSERT INTO sessions (conversation_id, service, state, intake_answer) VALUES (?1, 'HEALING', 'COMPLETED', 'A synthetic question')").bind(conv).run();
    await removeOldNames(w.env(), NOW);
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions WHERE intake_answer IS NOT NULL")).toBe(0);
    await w.db.prepare("UPDATE sessions SET intake_answer = 'Again'").run();
    await w.db.batch(wipePersonStmts(w.db, conv, "2026-10-05T06:00:00Z"));
    expect(await w.count("SELECT COUNT(*) AS n FROM sessions WHERE intake_answer IS NOT NULL")).toBe(0);
  });
});

describe("Settings → Services and Today (the console)", () => {
  const T = Date.parse("2026-10-27T08:00:00Z"); // Tue 27 Oct, 1:30 pm India time
  const h = new ConsoleHarness();
  beforeEach(async () => {
    await w.stop(); // this block uses the console harness instead
    await h.start(T);
    await addTarot(h.db, { public: false, intake: false });
  });
  afterEach(async () => {
    await h.stop();
    await w.start(); // the file-level afterEach stops it again
  });
  const page = async (as = OWNER) => decode(await (await h.get("/app/settings/services", as)).text());
  const edit = async (f: Record<string, string>) =>
    h.post("/app/settings/services/edit", { csrf: await h.tokenFor(OWNER, "services-edit:tarot_reading"), key: "tarot_reading", name_en: "Tarot reading", name_hi: "टैरो रीडिंग", price: "499", minutes: "30", active: "1", ...f });
  const row = () => h.db.prepare("SELECT public, intake_en, intake_hi, screen FROM services WHERE key = 'tarot_reading'").first();

  it("NEW_SERVICES 'false': Ticket 48's note, no 'Offered by the bot' box, and a crafted public=1 changes nothing; the question and the health questions save", async () => {
    const html = await page();
    expect(html).toContain("Offered by the bot after launch.");
    expect(html).not.toContain('name="public"');
    expect(html).toContain("Question after payment (English)");
    expect(html).toContain("Two health questions before booking");
    expect((await edit({ public: "1", intake_en: "  What question would you like to bring to your reading?  ", intake_hi: "आपका सवाल?", screen: "1" })).status).toBe(303);
    expect(await row()).toEqual({ public: 0, intake_en: "What question would you like to bring to your reading?", intake_hi: "आपका सवाल?", screen: 1 });
    const audit = (await h.audits("SERVICE_UPDATE")).map((a) => a.detail);
    expect(audit).toEqual(["intake_en; intake_hi; screen on"]); // the field names, never the words
    // Too long a question: refused, the form kept.
    const bad = await edit({ intake_en: "x".repeat(301) });
    expect(bad.status).toBe(400);
    expect(decode(await bad.text())).toContain("Up to 300 characters.");
  });

  it("NEW_SERVICES 'true': the box is there and offers it; the seeded two have none of the new fields", async () => {
    h.vars = { NEW_SERVICES: "true" };
    const html = await page();
    expect(html).toContain('name="public"');
    expect(html.split('id="svc-tarot_reading"')[1].split("</article>")[0]).not.toContain("Offered by the bot after launch.");
    expect((await edit({ public: "1" })).status).toBe(303);
    expect(await row()).toMatchObject({ public: 1 });
    expect((await h.audits("SERVICE_UPDATE")).map((a) => a.detail)).toEqual(["public on"]);
    expect(await page()).toMatch(/id="svc-tarot_reading"[\s\S]*?Offered by the bot/);
    const seeded = (await page()).split('id="svc-single_session"')[1].split("</article>")[0];
    expect(seeded).not.toContain("intake_en");
    expect(seeded).not.toContain('name="screen"');
  });

  it("Today, the Calendar's day and the person page show the service by name and their answer, to the owner and the practitioner only", async () => {
    const prac = (await h.member(PRAC))!.id;
    const conv = (await h.db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES ('919800000491', 'Tara Test')").run()).meta.last_row_id;
    const slot = (
      await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id, service_key) VALUES ('SESSION', '2026-10-27T10:30:00Z', '2026-10-27T11:00:00Z', ?1, 'BOOKED', ?2, 'tarot_reading')").bind(conv, prac).run()
    ).meta.last_row_id;
    await h.db
      .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, practitioner_id, service_key, intake_answer) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', 'SELF', ?3, 'tarot_reading', 'Will my new venture work out')")
      .bind(conv, slot, prac)
      .run();
    for (const [as, sees] of [[OWNER, true], [PRAC, true], [STAFF, false]] as const) {
      for (const path of ["/app", "/app/calendar?view=day&d=2026-10-27", `/app/people/${conv}`]) {
        const html = decode(await (await h.get(path, as)).text());
        expect(html, `${as} ${path}`).toContain("Tarot reading · 30 min");
        expect(html.includes("Their question: Will my new venture work out"), `${as} ${path}`).toBe(sees);
      }
    }
    const today = decode(await (await h.get("/app")).text());
    expect(today).not.toContain("Healing · Tarot reading");
  });
});
