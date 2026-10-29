// Ticket 31: fixes from the launch simulations. One block per finding (the id is the QA report's). All data is synthetic; Meta, Razorpay
// and email are fakes (test/wa.ts, test/razorpay.ts). Mon 2026-10-05, 11:30 IST; the assistant is off, as on live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { allCopy } from "../src/copy";
import { config } from "../src/config";
import { applyRefundEvent, retryRefunds } from "../src/pay/refund";
import { reminderReaches, resendSkippedPaid } from "../src/pay/apply";
import { contactFor, razorpay } from "../src/pay/razorpay";
import { applyDueOutcomes, recordOutcome, sendRefundNotices } from "../src/outcomes";
import { bookCredit } from "../src/packages";
import { payToken } from "../src/paylink";
import { sendReminders } from "../src/remind";
import { matchTopic } from "../src/router";
import { generateSlots, holdSlot, iso, nextWorkingDays } from "../src/slots";
import { typedChoice } from "../src/steps";
import { setSetting } from "../src/switches";
import { returnStaleHumans } from "../src/watch";
import { closedEvent, paidEvent, rzpHeaders } from "./razorpay";
import { NOW, Wa, type Json } from "./wa";

const w = new Wa();
const EN = allCopy.en;
const HI = allCopy.hi;
const MIN = 60_000;
const HOUR = 3_600_000;
const call = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "CALL")[i];

beforeEach(async () => {
  await w.start();
  w.aiFlag = "false"; // live: the assistant is off
});
afterEach(() => w.stop());

const body = (p: Json): string => p?.text?.body ?? p?.interactive?.body?.text ?? "";
const ids = (p: Json): string[] => p?.interactive?.action?.buttons?.map((b: Json) => b.reply.id) ?? p?.interactive?.action?.sections?.flatMap((s: Json) => s.rows.map((r: Json) => r.id)) ?? [];
const rzp = async (event: unknown) => {
  const raw = JSON.stringify(event);
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, w.env());
};
const payments = () => w.db.prepare("SELECT p.id, p.state, p.provider_link_id AS ref, p.target_id AS target FROM payments p ORDER BY id").all<Json>().then((r) => r.results);
const items = (kind: string) => w.count(`SELECT COUNT(*) AS n FROM attention WHERE kind = '${kind}' AND resolved_at IS NULL`);
const esc = (t: string) => t.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
const noPromise = () => expect(w.texts().filter((t: string) => /24 hours|24 घंटे/.test(t ?? ""))).toEqual([]);

// A greeted, 18+ person holding a ₹99 call at `utc` (the pay message has gone out).
async function holding(utc = call(2).startUtc, lang: "en" | "hi" = "en", from?: string) {
  const who = from ?? (await w.greeted(lang));
  await w.ageOk(who);
  await w.tapRow(who, `time_HEALING_SELF_${utc}`);
  return who;
}

describe("B1: a time that has passed, or is too soon, is never held", () => {
  it("holdSlot refuses it (TOO_SOON) for calls and sessions, and holds a time past the lead", async () => {
    const conv = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES ('test-b1')").run()).meta.last_row_id;
    const at = Date.parse(call(0).startUtc); // 2:00 pm
    for (const kind of ["CALL", "SESSION"] as const) {
      const s = generateSlots("2026-10-05", kind)[0].startUtc;
      expect(await holdSlot(w.db, { kind, startUtc: s, ownerId: conv, nowMs: at - 15 * MIN })).toEqual({ ok: false, reason: "TOO_SOON" });
      expect(await holdSlot(w.db, { kind, startUtc: s, ownerId: conv, nowMs: at + 3 * 86_400_000 })).toEqual({ ok: false, reason: "TOO_SOON" });
    }
    expect((await holdSlot(w.db, { kind: "CALL", startUtc: call(0).startUtc, ownerId: conv, nowMs: at - config.booking.leadMinutes * MIN - MIN })).ok).toBe(true);
  });

  it("an old time row tapped 15 minutes before the call: 'too soon', the times again, and no hold, payment or link", async () => {
    vi.setSystemTime(Date.parse(call(4).startUtc) - 15 * MIN); // 2:45 pm row at 2:30 pm
    const from = await w.greeted();
    await holding(call(4).startUtc, "en", from);
    const texts = w.texts();
    expect(texts[0]).toBe(EN.timePassed);
    expect(ids(w.last()).every((id) => id.startsWith("time_HEALING_SELF_") || id.startsWith("more_"))).toBe(true);
    expect(await payments()).toEqual([]);
    expect(await w.count("SELECT COUNT(*) AS n FROM slots WHERE state = 'HELD'")).toBe(0);
    expect(w.fake.posts("/payment_links")).toHaveLength(0);
  });

  it("a row three days in the past: refused the same way, in Hindi too", async () => {
    vi.setSystemTime(NOW + 3 * 86_400_000);
    const from = await w.greeted("hi");
    await holding(call(2).startUtc, "hi", from);
    expect(w.texts()[0]).toBe(HI.timePassed);
    expect(await payments()).toEqual([]);
  });

  it("a session row (stm_) and a package-credit booking (btm_) for a past time are refused too", async () => {
    const from = await w.greeted();
    await w.ageOk(from);
    vi.setSystemTime(NOW + 2 * 86_400_000);
    await w.tapRow(from, `stm_HEALING_SELF_${generateSlots("2026-10-05", "SESSION")[1].startUtc}`);
    expect(w.texts()).toContain(EN.timePassed);
    expect(await w.count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
    const conv = (await w.conv(from)).id;
    expect(await bookCredit(w.db, conv, "HEALING", "SELF", "en", generateSlots("2026-10-05", "SESSION")[1].startUtc)).toEqual({ ok: false, reason: "TOO_SOON" });
  });

  it("a missed call's reschedule row for a time that has passed: 'too soon' with the free times again", async () => {
    const from = await holding();
    await rzp(paidEvent((await payments())[0].ref));
    const intro = (await payments())[0].target;
    await w.db.prepare("UPDATE intros SET state = 'MISSED' WHERE id = ?1").bind(intro).run();
    vi.setSystemTime(NOW + 86_400_000);
    w.fetchMock.mockClear();
    await w.tapRow(from, `resched_${intro}_${call(2).startUtc}`); // yesterday 2:30 pm
    expect(body(w.last())).toBe(EN.timePassed);
    expect(ids(w.last()).every((id) => id.startsWith(`resched_${intro}_`))).toBe(true);
    expect((await w.db.prepare("SELECT state FROM intros WHERE id = ?1").bind(intro).first<Json>()).state).toBe("MISSED");
  });
});

describe("B2: an unpaid hold is not a booked call", () => {
  it("the same time again: the pay step again with the same link, never 'already booked', and no second link", async () => {
    const from = await holding();
    const first = w.last();
    w.fetchMock.mockClear();
    await w.tapRow(from, `time_HEALING_SELF_${call(2).startUtc}`);
    const again = w.last();
    expect(again.interactive.type).toBe("cta_url");
    expect(again.interactive.action.parameters.url).toBe(first.interactive.action.parameters.url);
    expect(body(again)).toContain("is still held for you until");
    expect(w.texts().join(" ")).not.toContain("already booked");
    expect(await payments()).toHaveLength(1);
    expect(w.fake.posts("/payment_links")).toHaveLength(1);
  });

  it("a different time: the old hold goes (payment FAILED, intro EXPIRED, slot free) and the new one is held with its own link", async () => {
    const from = await holding(call(2).startUtc);
    const [old] = await payments();
    await w.tapRow(from, `time_HEALING_SELF_${call(6).startUtc}`);
    const [a, b] = await payments();
    expect(a).toMatchObject({ id: old.id, state: "FAILED" });
    expect(b.state).toBe("PENDING");
    expect((await w.db.prepare("SELECT state FROM intros WHERE id = ?1").bind(old.target).first<Json>()).state).toBe("EXPIRED");
    const other = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES ('test-b2')").run()).meta.last_row_id;
    expect((await holdSlot(w.db, { kind: "CALL", startUtc: call(2).startUtc, ownerId: other, nowMs: Date.now() })).ok).toBe(true); // freed
    expect(w.last().interactive.type).toBe("cta_url");
    // our /p/ link for the old payment now says expired
    const page = await (await app.request(`/p/${await payToken(w.env(), old.id)}`, {}, w.env())).text();
    expect(page).toContain(EN.pageExpiredTitle);
  });
});

describe("B3: paying twice for two ₹99 calls", () => {
  it("a late payment for an old hold while another call is paid and ahead: refunded, the customer told, an item", async () => {
    const from = await holding(call(2).startUtc);
    const [first] = await payments();
    vi.setSystemTime(NOW + 25 * MIN); // the first hold lapsed (Razorpay was slow)
    await w.tapRow(from, `time_HEALING_SELF_${call(6).startUtc}`);
    const second = (await payments())[1];
    await rzp(paidEvent(second.ref));
    w.fetchMock.mockClear();
    await rzp(paidEvent(first.ref, { paymentId: "pay_FAKEFIRST" }));
    expect(await w.count("SELECT COUNT(*) AS n FROM intros WHERE state = 'PAID'")).toBe(1);
    expect((await w.db.prepare("SELECT reason FROM refunds WHERE payment_id = ?1").bind(first.id).first<Json>()).reason).toBe("DUPLICATE");
    expect(await items("DUPLICATE_PAYMENT")).toBe(1);
    expect(w.texts()).toEqual([`${EN.dupRefund("₹99")} ${EN.dupKeeps("Mon, 5 Oct", "3:30 pm")}`]);
    expect(await w.count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(1);
  });
});

describe("B4: a late payment for a time someone else has taken", () => {
  it("the customer is told (the team offers a new time or a refund) and the page does not say 'confirmed'", async () => {
    const from = await holding(call(2).startUtc);
    const [pay] = await payments();
    vi.setSystemTime(NOW + 25 * MIN);
    const rival = await w.greeted();
    await holding(call(2).startUtc, "en", rival);
    w.fetchMock.mockClear();
    await rzp(paidEvent(pay.ref));
    expect(await items("LATE_PAYMENT_NO_SLOT")).toBe(1);
    const sentTo = w.sent().map((p: Json) => p.to);
    expect(sentTo).toEqual([from]);
    expect(w.texts()).toEqual([EN.latePaidTaken("₹99")]);
    const page = await (await app.request(`/p/${await payToken(w.env(), pay.id)}`, {}, w.env())).text();
    expect(page).toContain(EN.pagePaidTitle);
    expect(page).toContain(EN.pageLateBody);
    expect(page).not.toContain("confirmed");
  });
});

describe("I1: typed questions with the assistant off", () => {
  const ask = async (text: string, lang: "en" | "hi" = "en") => {
    const from = await w.greeted(lang);
    await w.typed(from, text);
    return from;
  };

  it("common questions get their fixed answer from the Help copy, with the menu buttons, in one message", async () => {
    const cases: [string, string, string[]][] = [
      ["how much??", EN.faqAnswers.price, ["menu_book", "menu_pack", "menu_how"]],
      ["What is pranic healing? Does it work over the phone?", `${EN.faqAnswers.how_it_works}\n\n${EN.answerCall}`, ["menu_book", "menu_pack", "menu_how"]],
      ["what is this exactly", EN.faqAnswers.what_is_this, ["menu_book", "menu_pack", "menu_how"]],
      ["Is this real? is it a scam", EN.answerTrust, ["menu_book", "menu_pack", "menu_how"]],
      ["I live in Dubai, can I pay by card?", EN.answerAbroad, ["menu_book", "menu_how", "menu_person"]],
      ["can I come in person to the centre", EN.answerInPerson, ["menu_book", "menu_pack", "menu_how"]],
      ["what if I want a refund", EN.faqAnswers.refund, ["menu_book", "menu_how", "menu_person"]],
      ["My father has cancer, can this help?", EN.answerMedical, ["menu_how", "menu_person"]],
      ["kitna paisa lagega", EN.faqAnswers.price, ["menu_book", "menu_pack", "menu_how"]],
    ];
    for (const [q, answer, buttons] of cases) {
      w.fetchMock.mockClear();
      await ask(q);
      expect(w.sent(), q).toHaveLength(1);
      expect(body(w.last()), q).toBe(answer);
      expect(ids(w.last()), q).toEqual(buttons);
    }
    expect(await items("FREE_TEXT")).toBe(0);
    noPromise();
  });

  it("Hindi, in Devanagari and in Roman Hindi", async () => {
    await ask("फ़ीस कितनी है?", "hi");
    expect(body(w.last())).toBe(HI.faqAnswers.price);
    w.fetchMock.mockClear();
    await ask("ye kya hai", "hi");
    expect(body(w.last())).toBe(HI.faqAnswers.what_is_this);
  });

  it("'book' in a sentence starts booking; 'when is my call' shows My bookings", async () => {
    const from = await ask("mujhe call book karna hai");
    expect(ids(w.last())).toEqual(["age_yes", "age_no"]);
    w.fetchMock.mockClear();
    await w.typed(from, "when is my call?");
    expect(body(w.last())).toBe(EN.myBookingsNone);
  });

  it("anything else: one honest line with the menu, at most once per half hour, no promise and no queue item", async () => {
    const from = await ask("asdkjh qweoiu");
    expect(body(w.last())).toBe(EN.ack);
    expect(ids(w.last())).toEqual(["menu_book", "menu_how", "menu_person"]);
    w.fetchMock.mockClear();
    await w.typed(from, "can you tell me about cricket scores");
    expect(w.sent()).toHaveLength(0);
    vi.setSystemTime(NOW + 31 * MIN);
    await w.typed(from, "and the weather?");
    expect(body(w.last())).toBe(EN.ack);
    expect(await items("FREE_TEXT")).toBe(0);
    noPromise();
    // the promise of a person comes only with "Talk to a person"
    await w.tap(from, "menu_person");
    expect(body(w.last())).toBe(EN.handoffAck);
  });

  it("the same question again within ten minutes gets nothing (no loop); later it is answered again", async () => {
    const from = await ask("price?");
    w.fetchMock.mockClear();
    await w.typed(from, "price?");
    expect(w.sent()).toHaveLength(0);
    vi.setSystemTime(NOW + 11 * MIN);
    await w.typed(from, "price?");
    expect(body(w.last())).toBe(EN.faqAnswers.price);
  });

  it("polite closings get nothing; 'namaste ji' and 'good morning' get the menu", async () => {
    const from = await w.greeted();
    for (const t of ["ok thank you", "Thank you so much ji 🙏", "dhanyavad", "ok ji"]) await w.typed(from, t);
    expect(w.sent()).toHaveLength(0);
    vi.setSystemTime(NOW + 11 * MIN); // (a greeting right after an untapped menu gets nothing: I13)
    await w.typed(from, "namaste ji");
    expect(body(w.last())).toBe(EN.menuBody);
  });

  it("a question at an open step: the answer on top of the step itself", async () => {
    const from = await w.greeted();
    await w.ageOk(from);
    await w.tap(from, "who_HEALING_SELF");
    w.fetchMock.mockClear();
    await w.typed(from, "how much is it?");
    expect(body(w.last())).toBe(`${EN.faqAnswers.price}\n\n${EN.chooseDay}`);
    expect(ids(w.last())[0]).toMatch(/^day_HEALING_SELF_/);
  });

  it("a question in the very first message is answered after the language tap, in that language", async () => {
    const from = w.newPhone();
    await w.typed(from, "how much is the call?");
    expect(body(w.last())).toBe(EN.greeting);
    w.fetchMock.mockClear();
    await w.tap(from, "lang_hi");
    expect(w.sent()).toHaveLength(1);
    expect(body(w.last())).toBe(HI.faqAnswers.price);
    expect(ids(w.last())).toEqual(["menu_book", "menu_pack", "menu_how"]);
  });

  it("the router's topic order: illness first, then the rest", () => {
    expect(matchTopic("my mother had a stroke, what is the price")).toBe("medical");
    expect(matchTopic("when is my call")).toBe("my_booking");
    expect(matchTopic("I want to cancel my booking")).toBe("refund");
    expect(matchTopic("hello there friend")).toBeNull();
  });
});

describe("I16: non-genuine messages", () => {
  it("an agency pitch, a crypto promoter or a prize scam: no reply, a strike, no item", async () => {
    for (const t of ["We are a digital marketing agency and can grow your business", "Earn 10x with crypto trading tips", "Congratulations you have won a lottery"]) {
      const from = await w.greeted();
      await w.typed(from, t);
      expect(w.sent(), t).toHaveLength(0);
      expect((await w.state(from)).strikes, t).toBe(1);
    }
    expect(await w.count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("a threat: no reply, a strike, and an urgent THREAT item; a second one blocks", async () => {
    const from = await w.greeted();
    await w.typed(from, "I will kill you");
    expect(w.sent()).toHaveLength(0);
    expect(await items("THREAT")).toBe(1);
    await w.typed(from, "I know where you live");
    expect((await w.conv(from)).mode).toBe("BLOCKED");
  });

  it("vashikaran or 'get my love back': one firm, kind line, as a strike", async () => {
    const from = await w.greeted();
    await w.typed(from, "vashikaran karna hai, get my love back");
    expect(w.texts()).toEqual([EN.prohibitedLine]);
    expect((await w.state(from)).strikes).toBe(1);
  });

  it("a job seeker: one line pointing to a person, once a day; no strike, no item", async () => {
    const from = await w.greeted();
    await w.typed(from, "Hi, I am looking for a job, any vacancy?");
    expect(body(w.last())).toBe(EN.jobsLine);
    expect(ids(w.last())).toEqual(["menu_person"]);
    w.fetchMock.mockClear();
    await w.typed(from, "please share my resume");
    expect(w.sent()).toHaveLength(0);
    expect((await w.state(from)).strikes).toBe(0);
    expect(await w.count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("'someone did black magic on my family': the calm answer, no strike", async () => {
    const from = await w.greeted();
    await w.typed(from, "someone did black magic on my family");
    expect(body(w.last())).toBe(EN.answerConcern);
    expect((await w.state(from)).strikes).toBe(0);
  });

  it("an empty or blank text gets nothing and raises nothing", async () => {
    const from = await w.greeted();
    await w.typed(from, "   ");
    expect(w.sent()).toHaveLength(0);
    expect(await w.count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });
});

describe("I3: emergencies are in the present tense", () => {
  it("'had a stroke last year' and 'poison' as a figure of speech are not emergencies; the first message gets the greeting", async () => {
    const from = w.newPhone();
    await w.typed(from, "my mother had a stroke last year and is weak now. Can healing help her?");
    expect(w.texts()).toEqual([EN.greeting]);
    const other = await w.greeted();
    await w.typed(other, "My office is poison for my mind");
    expect(w.texts()).not.toContain(EN.emergency);
    expect(await items("EMERGENCY")).toBe(0);
  });

  it("'he is having a stroke' as a first message: the emergency text, then the greeting", async () => {
    const from = w.newPhone();
    await w.typed(from, "my father is having a stroke");
    expect(w.texts()).toEqual([EN.emergency, EN.greeting]);
    expect(await items("EMERGENCY")).toBe(1);
    w.fetchMock.mockClear();
    await w.typed(from, "zeher kha liya usne");
    expect(w.texts()).toEqual([EN.emergency]);
  });
});

describe("I4: a payment message skipped while SENDS was paused goes out when sends resume, once", () => {
  it("the confirmation", async () => {
    await holding();
    const [pay] = await payments();
    await setSetting(w.db, "SENDS", "false");
    await rzp(paidEvent(pay.ref));
    expect((await w.db.prepare("SELECT status FROM messages WHERE dedupe_key = ?1").bind(`paid:${pay.id}`).first<Json>()).status).toBe("SKIPPED");
    w.fetchMock.mockClear();
    expect(await resendSkippedPaid(w.env())).toBe(0); // still paused
    await setSetting(w.db, "SENDS", "true");
    expect(await resendSkippedPaid(w.env())).toBe(1);
    expect(w.texts()[0]).toContain("Received your ₹99");
    expect(await resendSkippedPaid(w.env())).toBe(0);
    expect(w.sent()).toHaveLength(1);
  });

  it("the 'not right fit' refund notice", async () => {
    const from = await holding();
    const [pay] = await payments();
    await rzp(paidEvent(pay.ref));
    const intro = await w.db.prepare("SELECT id, slot_id FROM intros WHERE id = ?1").bind(pay.target).first<Json>();
    await recordOutcome(w.db, { introId: intro.id, slotId: intro.slot_id, value: "NOT_FIT", nowMs: Date.now() });
    await setSetting(w.db, "SENDS", "false");
    vi.setSystemTime(NOW + 11 * MIN);
    await applyDueOutcomes(w.env(), razorpay(w.env()));
    w.fetchMock.mockClear();
    await setSetting(w.db, "SENDS", "true");
    expect(await sendRefundNotices(w.env())).toBe(1);
    expect(w.texts()).toEqual([EN.notFitRefund]);
    expect(w.sent()[0].to).toBe(from);
    await sendRefundNotices(w.env());
    expect(w.sent()).toHaveLength(1);
  });
});

describe("I5: no day-before reminder while the practitioner is away", () => {
  it("skipped, and the owner has an item per booking", async () => {
    await holding(call(2, "2026-10-06").startUtc);
    await rzp(paidEvent((await payments())[0].ref));
    await setSetting(w.db, "AMMA_AWAY", "true");
    vi.setSystemTime(Date.parse("2026-10-05T18:30:00+05:30"));
    w.fetchMock.mockClear();
    expect(await sendReminders(w.env())).toBe(0);
    expect(w.sent()).toHaveLength(0);
    expect(await items("AMMA_AWAY_CALL")).toBe(1);
    await setSetting(w.db, "AMMA_AWAY", "false");
    expect(await sendReminders(w.env())).toBe(1);
  });
});

describe("I6: after a package is paid, 'hi' shows the menu, not the session offer", () => {
  it("the offer is closed by the purchase", async () => {
    const from = await w.greeted();
    const conv = (await w.conv(from)).id;
    const intro = (await w.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(conv).run()).meta.last_row_id;
    await w.db.prepare("INSERT INTO sessions (conversation_id, intro_id, service) VALUES (?1, ?2, 'HEALING')").bind(conv, intro).run();
    vi.setSystemTime(NOW + 20 * MIN);
    await w.typed(from, "hi");
    expect(body(w.last())).toBe(EN.sessionOfferBody);
    await w.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(conv).run();
    vi.setSystemTime(NOW + 40 * MIN);
    await w.typed(from, "hi");
    expect(body(w.last())).toBe(EN.menuBody);
  });
});

describe("I7: 'we're refunding your ₹99' only once Razorpay has taken the refund", () => {
  async function notFit() {
    const from = await holding();
    const [pay] = await payments();
    await rzp(paidEvent(pay.ref));
    const intro = await w.db.prepare("SELECT id, slot_id FROM intros WHERE id = ?1").bind(pay.target).first<Json>();
    await recordOutcome(w.db, { introId: intro.id, slotId: intro.slot_id, value: "NOT_FIT", nowMs: Date.now() });
    vi.setSystemTime(NOW + 11 * MIN);
    w.fetchMock.mockClear();
    return { from, pay };
  }

  it("accepted: the notice with the usual timing", async () => {
    await notFit();
    await applyDueOutcomes(w.env(), razorpay(w.env()));
    expect(w.texts()).toEqual([EN.notFitRefund]);
    expect(EN.notFitRefund).toContain("5–7 working days");
    expect(EN.notFitRefund).not.toContain("we've refunded");
  });

  it("refused: nothing to the customer, an item for the owner; told once the retry goes through", async () => {
    const { pay } = await notFit();
    w.fake.failRefundWith = { status: 400, description: "The refund could not be processed" };
    await applyDueOutcomes(w.env(), razorpay(w.env()));
    expect(w.sent()).toHaveLength(0);
    expect(await items("REFUND_NOT_STARTED")).toBe(1);
    await sendRefundNotices(w.env());
    expect(w.sent()).toHaveLength(0);
    w.fake.failRefundWith = null;
    vi.setSystemTime(NOW + 15 * MIN);
    await retryRefunds(w.env(), razorpay(w.env()));
    await sendRefundNotices(w.env());
    expect(w.texts()).toEqual([EN.notFitRefund]);
    // a later refund.failed never sends a second message
    await applyRefundEvent(w.env(), `refund-${pay.id}`, "FAILED");
    await sendRefundNotices(w.env());
    expect(w.sent()).toHaveLength(1);
  });
});

describe("I8: typed answers to an open step", () => {
  it("'yes', 'haan', 'ok' and 'YES I am 45' at the age question are the Yes button; 'nahi' is No", async () => {
    for (const t of ["yes", "haan", "ok", "YES I am 45"]) {
      const from = await w.greeted();
      await w.tap(from, "menu_book");
      w.fetchMock.mockClear();
      await w.typed(from, t);
      expect(body(w.last()), t).toBe(EN.chooseService);
    }
    const from = await w.greeted();
    await w.tap(from, "menu_book");
    await w.typed(from, "nahi");
    expect(body(w.last())).toBe(EN.ageNo);
  });

  it("the button's own words, its number, a person, a day and a time", async () => {
    const from = await w.greeted();
    await w.ageOk(from);
    await w.tap(from, "menu_book");
    await w.typed(from, "healing");
    expect(body(w.last())).toBe(EN.whoFor);
    await w.typed(from, "for my mother");
    expect(ids(w.last())[0]).toMatch(/^day_HEALING_FAMILY_/);
    await w.typed(from, "today");
    expect(body(w.last())).toContain("Free times on Mon, 5 Oct");
    await w.typed(from, "4 pm");
    expect(w.last().interactive.type).toBe("cta_url");
    expect(body(w.last())).toContain("Mon, 5 Oct at 4:00 pm is held for you");
    const other = await w.greeted();
    await w.ageOk(other);
    await w.tap(other, "menu_book");
    await w.typed(other, "2");
    expect(ids(w.last())).toEqual(["who_PROTECTION_SELF", "who_PROTECTION_FAMILY", "who_PROTECTION_PET"]);
  });

  it("'English' or 'hindi' at the language question", async () => {
    const from = w.newPhone();
    await w.typed(from, "hi");
    await w.typed(from, "hindi");
    expect(body(w.last())).toBe(HI.menuBody);
    expect((await w.conv(from)).locale).toBe("hi");
  });

  it("a longer message is a question, never a tap", () => {
    const open = { step: "age" as const, reprompts: 0, out: { type: "buttons" as const, body: "", buttons: [{ id: "age_yes", title: "Yes" }, { id: "age_no", title: "No" }] } };
    expect(typedChoice(open, "yes but is it safe for my heart")).toBeNull();
    expect(typedChoice(open, "yes no")).toBeNull();
    expect(typedChoice(open, "हाँ")).toBe("age_yes");
  });
});

describe("I10: no free times", () => {
  it("a clear message with Talk to a person and Help, and an item", async () => {
    const owner = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES ('test-full')").run()).meta.last_row_id;
    for (const ymd of nextWorkingDays(NOW, 14))
      for (const s of generateSlots(ymd, "CALL"))
        await w.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED')").bind(s.startUtc, s.endUtc, owner).run();
    const from = await w.greeted();
    await w.ageOk(from);
    await w.tap(from, "who_HEALING_SELF");
    expect(body(w.last())).toBe(EN.noSlots);
    expect(ids(w.last())).toEqual(["menu_person", "menu_how"]);
    expect(await items("NO_FREE_TIMES")).toBe(1);
  });
});

describe("I11: a hold that ends unpaid", () => {
  it("one short message with a button to choose a time again", async () => {
    const from = await holding();
    const [pay] = await payments();
    vi.setSystemTime(NOW + 20 * MIN);
    w.fetchMock.mockClear();
    await rzp(closedEvent(pay.ref, "expired"));
    expect(w.sent()).toHaveLength(1);
    expect(w.last().to).toBe(from);
    expect(body(w.last())).toBe(EN.holdReleased);
    expect(ids(w.last())).toEqual(["menu_book"]);
    await rzp(closedEvent(pay.ref, "expired", 1759644001)); // a replay
    expect(w.sent()).toHaveLength(1);
  });

  it("nothing for a chat a person has, or outside the 24-hour window", async () => {
    const a = await holding();
    await w.db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE wa_id = ?1").bind(a, iso(NOW)).run();
    const b = await holding(call(8).startUtc);
    await w.db.prepare("UPDATE conversations SET last_user_at = '2026-10-03T00:00:00Z' WHERE wa_id = ?1").bind(b).run();
    vi.setSystemTime(NOW + 20 * MIN);
    w.fetchMock.mockClear();
    for (const p of await payments()) await rzp(closedEvent(p.ref, "expired"));
    expect(w.sent()).toHaveLength(0);
    expect(await items("OUTSIDE_WINDOW")).toBe(0);
  });
});

describe("I12: the Razorpay contact is the full international number", () => {
  it("+971, +1 and +91 numbers whole; a number too long for the field is left out", async () => {
    expect(contactFor("971500000001")).toBe("+971500000001");
    expect(contactFor("14155550002")).toBe("+14155550002");
    expect(contactFor("919820000001")).toBe("+919820000001");
    expect(contactFor("1234567890123456")).toBe("");
    const from = await w.greeted("en", "971500000001");
    await holding(call(2).startUtc, "en", from);
    expect((w.fake.posts("/payment_links")[0].body as Json).customer.contact).toBe("+971500000001");
  });
});

describe("I13: 'hi' again and again", () => {
  it("after an untapped menu, more greetings get nothing (and count as small talk); a tap or ten minutes bring the menu back", async () => {
    const from = await w.greeted(); // the menu has just gone out after the language tap: a greeting now still gets it
    await w.typed(from, "hi");
    expect(body(w.last())).toBe(EN.menuBody);
    w.fetchMock.mockClear();
    for (let i = 0; i < 3; i++) await w.typed(from, "hi");
    expect(w.sent()).toHaveLength(0);
    expect((await w.state(from)).smalltalk_count).toBe(3); // two free a day, then strikes (three strikes: the closing line and a quiet week)
    expect((await w.state(from)).strikes).toBe(1);
    await w.tap(from, "menu_how");
    await w.typed(from, "hello");
    expect(body(w.last())).toBe(EN.menuBody);
    w.fetchMock.mockClear();
    await w.typed(from, "hi");
    expect(w.sent()).toHaveLength(0);
    vi.setSystemTime(NOW + 11 * MIN);
    w.fetchMock.mockClear();
    await w.typed(from, "hi");
    expect(body(w.last())).toBe(EN.menuBody);
  });
});

describe("I14: a handoff nobody answered in time", () => {
  it("inside the window: told at once, with the menu; the owner gets an email", async () => {
    const from = await w.greeted();
    await w.tap(from, "menu_person");
    vi.setSystemTime(NOW + 20 * HOUR);
    await w.typed(from, "hello? anyone?");
    w.fetchMock.mockClear();
    w.emails.length = 0;
    expect(await returnStaleHumans(w.env(), NOW + 24 * HOUR + 1000)).toBe(1);
    expect(body(w.last())).toBe(EN.handbackNotice);
    expect(ids(w.last())).toEqual(["menu_book", "menu_how", "menu_person"]);
    expect(w.emails.map((e) => e.subject)).toEqual(["A chat went back to the bot"]);
  });

  it("window closed: told on their next message, once", async () => {
    const from = await w.greeted();
    await w.tap(from, "menu_person");
    await returnStaleHumans(w.env(), NOW + 24 * HOUR + 1000);
    vi.setSystemTime(NOW + 30 * HOUR);
    w.fetchMock.mockClear();
    await w.typed(from, "Nobody replied to me");
    expect(w.texts()).toEqual([EN.handbackNotice]);
    await w.typed(from, "please reply");
    expect(w.texts()).toEqual([EN.handbackNotice, EN.ack]);
  });
});

describe("I17: a username-only sender", () => {
  it("is not dropped without a trace: one item, keyed by a hash, no reply", async () => {
    const msg = { id: "wamid.BSUID1", from_user_id: "IN.1234567890abcdef", timestamp: String(Math.floor(NOW / 1000)), type: "text", text: { body: "Hi, I want to book a call" } };
    await w.post({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: "Someone" }, user_id: "IN.1234567890abcdef" }], messages: [msg] } }] }] });
    await w.post({ entry: [{ changes: [{ value: { messages: [{ ...msg, id: "wamid.BSUID2" }] } }] }] });
    expect(w.sent()).toHaveLength(0);
    const rows = (await w.db.prepare("SELECT target FROM attention WHERE kind = 'NO_PHONE'").all<Json>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toMatch(/^user:[0-9a-f]{12}$/);
    expect(rows[0].target).not.toContain("1234567890");
  });
});

describe("I19: a payment with the wrong amount", () => {
  it("the customer is told it is being checked; the page says so; the owner's item stays", async () => {
    await holding();
    const [pay] = await payments();
    w.fetchMock.mockClear();
    await rzp(paidEvent(pay.ref, { paid: 4900 }));
    expect(w.texts()).toEqual([EN.checkingPayment]);
    expect(await items("PAYMENT_MISMATCH")).toBe(1);
    const page = await (await app.request(`/p/${await payToken(w.env(), pay.id)}`, {}, w.env())).text();
    expect(page).toContain(esc(EN.pageCheckTitle));
    expect(page).not.toContain(EN.pageExpiredTitle);
  });
});

describe("I20: bookings paused is not a dead end", () => {
  it("Book, Sessions & packages and an old time row get the pause message with Talk to a person and Help", async () => {
    const from = await w.greeted();
    await w.ageOk(from);
    await setSetting(w.db, "NEW_BOOKINGS", "false");
    for (const id of ["menu_book", "menu_pack", `time_HEALING_SELF_${call(2).startUtc}`]) {
      w.fetchMock.mockClear();
      await w.tap(from, id);
      expect(body(w.last()), id).toBe(EN.bookSoon);
      expect(ids(w.last()), id).toEqual(["menu_person", "menu_how"]);
    }
  });
});

describe("the /p/ page in front of Razorpay's", () => {
  it("a tiny page that moves on by meta refresh, with a Continue button to the Razorpay link; no script, no-store", async () => {
    await holding();
    const [pay] = await payments();
    const res = await app.request(`/p/${await payToken(w.env(), pay.id)}`, {}, w.env());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=https://rzp.io/i/${pay.ref}">`);
    expect(html).toContain(`<a class="btn" href="https://rzp.io/i/${pay.ref}">${EN.pageBtnContinue}</a>`);
    expect(html).toContain(esc(EN.pageOpeningTitle));
    expect(html).not.toContain("<script");
  });
});

describe("I2: no reminder promise the bot can't keep", () => {
  it("promised only when the reminder can reach them (or once the template is approved)", () => {
    const tomorrow2pm = "2026-10-06T08:30:00Z"; // reminder today 6:30 pm, 7 hours away
    const in3days = "2026-10-08T08:30:00Z";
    const today4pm = "2026-10-05T10:30:00Z"; // the reminder time has passed
    expect(reminderReaches(tomorrow2pm, NOW)).toBe(true);
    expect(reminderReaches(in3days, NOW)).toBe(false);
    expect(reminderReaches(today4pm, NOW)).toBe(false);
    const t = config.templates.reminder as { approved: boolean };
    t.approved = true;
    try {
      expect(reminderReaches(in3days, NOW)).toBe(true);
    } finally {
      t.approved = false;
    }
    expect(EN.sessionConfirmed("Thu, 8 Oct", "2:00 pm", false)).toContain("Please note the time; we'll message you here if anything changes.");
    expect(EN.sessionConfirmed("Thu, 8 Oct", "2:00 pm", false)).not.toContain("remind");
    expect(HI.sessionConfirmed("x", "y", false)).not.toContain("याद दिलाएँगे");
  });
});
