import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { recentMessages } from "../src/ai";
import { allCopy } from "../src/copy";
import { startIntent } from "../src/intent";
import { isOutOfScope, isSexualHealth, matchTopic } from "../src/router";
import { generateSlots } from "../src/slots";
import { removeOldNames } from "../src/wipe";
import { paidEvent, rzpHeaders } from "./razorpay";
import { Wa, type Json } from "./wa";

// Ticket 41: voice calls only, the three questions after a paid ₹99 call, and concerns outside what we offer. All data is synthetic;
// Meta, Razorpay and Anthropic are fakes.
const h = new Wa();
beforeEach(() => h.start());
afterEach(() => h.stop());

const en = allCopy.en;
const hi = allCopy.hi;
const DAY = "2026-10-06"; // Tue
const callAt = (i: number) => generateSlots(DAY, "CALL")[i].startUtc;
const body = (p: Json) => p?.text?.body ?? p?.interactive?.body?.text;
const ids = (p: Json): string[] => [...(p?.interactive?.action?.buttons?.map((b: Json) => b.reply.id) ?? []), ...(p?.interactive?.action?.sections?.flatMap((s: Json) => s.rows.map((r: Json) => r.id)) ?? [])];
const intro = async (from: string) => (await h.db.prepare("SELECT i.* FROM intros i JOIN conversations c ON c.id = i.conversation_id WHERE c.wa_id = ?1 ORDER BY i.id DESC").bind(from).first<Json>())!;
const items = async (kind = "OUT_OF_SCOPE") => (await h.db.prepare("SELECT target FROM attention WHERE kind = ?1 AND resolved_at IS NULL").bind(kind).all<{ target: string }>()).results.map((r) => r.target);

// Books the 5:30 pm call on Tuesday through the real steps and pays it through the real webhook.
async function bookAndPay(lang: "en" | "hi" = "en", from?: string) {
  const who = await h.greeted(lang, from);
  await h.ageOk(who);
  await h.tap(who, "menu_book");
  await h.tap(who, "svc_HEALING");
  await h.tap(who, "who_HEALING_SELF");
  await h.tap(who, `day_HEALING_SELF_${DAY}`);
  await h.tapRow(who, `time_HEALING_SELF_${callAt(14)}`);
  const link = (await h.db.prepare("SELECT provider_link_id AS l FROM payments ORDER BY id DESC").first<{ l: string }>())!.l;
  const raw = JSON.stringify(paidEvent(link));
  expect((await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, h.env())).status).toBe(200);
  return who;
}

describe("voice calls only (ticket 41)", () => {
  it("every description of the call says it is a voice call by phone, not video, in both languages", () => {
    for (const c of [en.confirmed("{day}", "{time}", "en"), en.timesFor("{day}"), en.sessionTimesFor("{day}"), en.sessionConfirmed("{d}", "{t}"), en.rescheduled("{d}", "{t}"),
      en.reminderCall("{d}", "{t}"), en.reminderSession("{d}", "{t}"), en.faqAnswers.what_is_this, en.faqAnswers.how_it_works, en.packagesBody, en.callRequest, en.answerCall,
      en.sessionLinkBody, en.creditBooked("{d}", "{t}", 3)]) expect(c, c).toContain("a voice call by phone (audio only, no video)");
    for (const c of [hi.confirmed("{day}", "{time}", "hi"), hi.timesFor("{day}"), hi.sessionConfirmed("{d}", "{t}"), hi.reminderCall("{d}", "{t}"), hi.reminderSession("{d}", "{t}"),
      hi.faqAnswers.how_it_works, hi.packagesBody, hi.answerCall]) expect(c, c).toContain("फ़ोन पर वॉइस कॉल (सिर्फ़ आवाज़, वीडियो नहीं)");
    expect(en.greeting).toContain("voice call (audio only, no video)");
    expect(en.rowIntroDesc).toContain("voice call");
    expect(en.answerVideo).toBe("All calls and sessions are voice calls by phone — no video.");
  });

  it("\"video call?\", \"video pe\" and वीडियो कॉल get the fixed answer, never the \"we don't take calls\" line or the assistant", async () => {
    for (const [text, lang, answer] of [["Is it a video call?", "en", en.answerVideo], ["video pe hoga kya", "en", en.answerVideo], ["can we do video call me", "en", en.answerVideo], ["क्या वीडियो कॉल होगी?", "hi", hi.answerVideo]] as const) {
      h.aiFlag = "false";
      const from = await h.greeted(lang);
      await h.typed(from, text);
      expect(body(h.last()), text).toBe(answer);
      expect(body(h.last())).not.toBe(lang === "hi" ? hi.callRequest : en.callRequest);
    }
    expect(matchTopic("I saw your video on instagram")).not.toBe("video"); // the word alone is not the question
  }, 90_000);
});

describe("the questions after a paid ₹99 call", () => {
  it("after the confirmation: the name (Use <WhatsApp name> / Skip), the work, the area list; answers stored on the intro", async () => {
    const from = await bookAndPay("en");
    const sent = h.sent();
    const conf = sent.findIndex((p) => body(p)?.startsWith("Received your ₹99."));
    expect(conf).toBeGreaterThanOrEqual(0);
    const q1 = sent[conf + 1];
    expect(body(q1)).toBe(en.intentName("Test Person"));
    const i = await intro(from);
    expect(ids(q1)).toEqual([`in_${i.id}_name_use`, `in_${i.id}_name_skip`]);
    expect(q1.interactive.action.buttons.map((b: Json) => b.reply.title)).toEqual(["Use Test Person", "Skip"]);

    await h.tap(from, `in_${i.id}_name_use`);
    expect(body(h.last())).toBe(en.intentWork);
    await h.typed(from, "School teacher");
    expect(body(h.last())).toBe(en.intentArea);
    expect(ids(h.last())).toEqual([...["STRESS", "SLEEP", "RELATIONSHIPS", "WORK", "ENERGY", "PHYSICAL", "OTHER"].map((a) => `in_${i.id}_area_${a}`), `in_${i.id}_area_skip`]);
    expect(h.aiCalls().length).toBe(0); // a typed answer never goes to the assistant
    await h.tapRow(from, `in_${i.id}_area_SLEEP`);
    expect(body(h.last())).toBe(en.intentThanks);
    const after = await intro(from);
    expect([after.profession, after.help_area]).toEqual(["School teacher", "SLEEP"]);
    expect((await h.conv(from)).display_name).toBe("Test Person");
    // Nothing more is sent, and a second tap on an old button changes nothing.
    const n = h.sent().length;
    await h.tapRow(from, `in_${i.id}_area_SLEEP`);
    expect(h.sent().length).toBe(n);
  }, 90_000);

  it("a typed name becomes their name and stays (the WhatsApp name no longer replaces it), and never goes to the assistant; Skip everywhere", async () => {
    const from = await bookAndPay("hi");
    const i = await intro(from);
    expect(body(h.last())).toBe(hi.intentName("Test Person"));
    await h.typed(from, "Priya Sharma");
    expect(body(h.last())).toBe(hi.intentWork);
    const conv = await h.conv(from);
    expect(conv.display_name).toBe("Priya Sharma");
    expect(conv.name_given_at).not.toBeNull();
    await h.tap(from, `in_${i.id}_work_skip`);
    await h.tapRow(from, `in_${i.id}_area_skip`);
    expect(body(h.last())).toBe(hi.intentThanks);
    expect([(await intro(from)).profession, (await intro(from)).help_area]).toEqual([null, null]);
    await h.typed(from, "ok"); // the next message still carries the WhatsApp profile name "Test Person"
    expect((await h.conv(from)).display_name).toBe("Priya Sharma");
    // The assistant's history has [name] instead of the typed name.
    const hist = await recentMessages(h.db, conv.id, 1_000_000);
    expect(JSON.stringify(hist)).not.toContain("Priya");
    expect(JSON.stringify(hist)).toContain("[name]");
    // 90 days after the last booking, the name, the work, the area and the mark go together.
    await h.db.prepare("UPDATE intros SET profession = 'Nurse', help_area = 'WORK' WHERE id = ?1").bind(i.id).run();
    await removeOldNames(h.env(), Date.parse("2027-02-01T00:00:00Z"));
    const wiped = await h.conv(from);
    expect([wiped.display_name, wiped.name_given_at]).toEqual([null, null]);
    expect([(await intro(from)).profession, (await intro(from)).help_area]).toEqual([null, null]);
  }, 90_000);

  it("\"Something else\": their own words stay only in the chat (OTHER on the intro), then the thanks", async () => {
    const from = await bookAndPay("en");
    const i = await intro(from);
    await h.tap(from, `in_${i.id}_name_skip`);
    await h.tap(from, `in_${i.id}_work_skip`);
    await h.tapRow(from, `in_${i.id}_area_OTHER`);
    expect(body(h.last())).toBe(en.intentOther);
    await h.typed(from, "I feel restless after my father passed");
    expect(body(h.last())).toBe(en.intentThanks);
    const row = await intro(from);
    expect(row.help_area).toBe("OTHER");
    expect(JSON.stringify(row)).not.toContain("restless");
    expect(await items()).toEqual([]);
    expect(h.aiCalls().length).toBe(0);
  }, 90_000);

  it("a question instead of an answer ends the questions and is answered the usual way; nothing is stored", async () => {
    h.aiFlag = "false";
    const from = await bookAndPay("en");
    await h.typed(from, "What time will she call me?");
    expect(body(h.last())).not.toBe(en.intentWork);
    expect((await h.conv(from)).display_name).toBe("Test Person");
    expect((await h.conv(from)).pending_step).toBeNull();
    // ... and a later "teacher" is not taken as an answer either.
    await h.typed(from, "teacher");
    expect((await intro(from)).profession).toBeNull();
  }, 90_000);

  it("not while the team has the chat, and only once per call", async () => {
    const from = await h.greeted("en");
    const c = await h.conv(from);
    const id = (await h.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'PAID')").bind(c.id).run()).meta.last_row_id;
    await h.db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(c.id).run();
    await startIntent(h.env(), c.id, id);
    expect(h.sent().length).toBe(0);
    await h.db.prepare("UPDATE conversations SET mode = 'BOT' WHERE id = ?1").bind(c.id).run();
    await startIntent(h.env(), c.id, id);
    await startIntent(h.env(), c.id, id);
    expect(h.sent().filter((p) => body(p) === en.intentName("Test Person")).length).toBe(1);
  });

  it("a button naming another person's call does nothing", async () => {
    const from = await bookAndPay("en");
    const other = await h.greeted("en");
    const i = await intro(from);
    await h.tap(other, `in_${i.id}_area_SLEEP`);
    expect((await intro(from)).help_area).toBeNull();
  }, 90_000);
});

describe("outside what we offer (ticket 41)", () => {
  it("the word lists: English, Hinglish and Hindi; a serious illness only with a request to cure it", () => {
    for (const t of ["I have an erection problem", "ED problem since 2 years", "premature ejaculation", "mardana kamzori ka ilaj", "nil shukranu", "मुझे शीघ्रपतन की समस्या है", "नपुंसकता"])
      expect(isSexualHealth(t), t).toBe(true);
    expect(isOutOfScope("Can she cure my cancer?")).toBe(true);
    expect(isOutOfScope("kidney failure ka ilaj ho sakta hai")).toBe(true);
    expect(isOutOfScope("I had cancer and I feel anxious")).toBe(false);
    expect(isOutOfScope("I feel stressed at work")).toBe(false);
  });

  it("a sexual-function concern: the kind fixed answer (a doctor, no booking button), never a strike, a block or the assistant", async () => {
    const from = await h.greeted("en");
    // Four times in a row: one answer (a repeat inside 10 minutes gets silence), and never a strike.
    for (let k = 0; k < 4; k++) await h.typed(from, k % 2 ? "I am impotent, please help, sexual weakness" : "Can she help with my erectile dysfunction?");
    const answers = h.sent().filter((p) => body(p) === en.answerSexualHealth);
    expect(answers.length).toBe(1);
    expect(answers[0].interactive.action.buttons.map((b: Json) => b.reply.id)).toEqual(["menu_how", "menu_person"]);
    expect(h.aiCalls().length).toBe(0);
    const st = await h.state(from);
    expect(st.strikes).toBe(0);
    expect(st.quiet_until).toBeNull();
    expect((await h.conv(from)).mode).toBe("BOT");
    expect(await h.count("SELECT COUNT(*) AS n FROM blocks")).toBe(0);
    expect(await items()).toEqual([]); // not paid: only the reply
    expect(h.sent().some((p) => body(p) === en.flirtLine)).toBe(false);
  }, 90_000);

  it("Hindi gets the Hindi answer", async () => {
    const from = await h.greeted("hi");
    await h.typed(from, "मुझे शीघ्रपतन की समस्या है");
    expect(body(h.last())).toBe(hi.answerSexualHealth);
  });

  it("after the payment: the same answer and one item for the team on that booking; the outcome settles it", async () => {
    const from = await bookAndPay("en");
    const i = await intro(from);
    await h.typed(from, "actually my problem is premature ejaculation");
    expect(h.sent().some((p) => body(p) === en.answerSexualHealth)).toBe(true);
    expect(await items()).toEqual([`intro:${i.id}`]);
    await h.typed(from, "erection problem"); // one open item per booking
    expect(await items()).toEqual([`intro:${i.id}`]);
    expect(await h.count("SELECT COUNT(*) AS n FROM refunds")).toBe(0); // never an automatic refund
  }, 90_000);

  it("\"Something else\" words that are out of scope: the answer instead of the thanks, and the item", async () => {
    const from = await bookAndPay("en");
    const i = await intro(from);
    await h.tap(from, `in_${i.id}_name_skip`);
    await h.tap(from, `in_${i.id}_work_skip`);
    await h.tapRow(from, `in_${i.id}_area_OTHER`);
    await h.typed(from, "low sperm count");
    expect(body(h.last())).toBe(en.answerSexualHealth);
    expect(await items()).toEqual([`intro:${i.id}`]);
    const st = await h.state(from);
    expect(st.strikes).toBe(0);
  }, 90_000);

  it("a paying customer asking to cure a serious illness: the item, and the usual answer", async () => {
    h.aiFlag = "false";
    const from = await bookAndPay("en");
    const i = await intro(from);
    await h.typed(from, "Can she cure my cancer?");
    expect(body(h.last())).toBe(en.answerMedical);
    expect(await items()).toEqual([`intro:${i.id}`]);
  }, 90_000);
});
