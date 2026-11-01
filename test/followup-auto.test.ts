// Ticket 35: the automatic follow-ups, 60 minutes and 20 hours after a person's last real message, on WhatsApp, Instagram and Messenger
// (src/followup.ts, src/social.ts socialFollowUps). All ids, numbers and text are synthetic; Meta is a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { loadPrices } from "../src/business";
import { config } from "../src/config";
import { copyFor } from "../src/copy";
import { atNight, dueFollowUp, whatsappFollowUps } from "../src/followup";
import { digestText } from "../src/report";
import { iso } from "../src/slots";
import { socialFollowUps, socialWords } from "../src/social";
import { setSetting } from "../src/switches";
import { newDb } from "./db";

const SECRET = "test-app-secret";
const PUB = "https://bot.example.invalid";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-02T06:30:00Z"); // Mon 2 Nov, 12:00 noon in India: the 20-hour follow-up falls at 08:00 the next day
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let flags: Record<string, string>;
let n = 0;
const env = () =>
  ({
    DB: db, NEW_BOOKINGS: "true", AI_REPLIES: "false", CHAT_RETENTION_MINUTES: "10080", WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "v", WA_TOKEN: "tok",
    WA_PHONE_ID: "1000", META_VERIFY_TOKEN: "mv", META_PAGE_TOKEN: "ptok", META_PAGE_ID: "PAGE1", META_IG_ID: "IG1", PUBLIC_URL: PUB, DIGEST_TO: "ops@example.invalid",
    RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", PAYMENT_MODE: "test",
    ...flags,
  }) as never;
const at = (ms: number) => vi.setSystemTime(ms);

async function signed(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const sig = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return app.request(path, { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, env());
}
let mid = 0;
// WhatsApp: a typed message or a button tap from `from`.
const waMsg = (from: string, extra: object) =>
  signed("/wa/webhook", { entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: `wamid.IN${++mid}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] });
const typed = (from: string, body: string) => waMsg(from, { type: "text", text: { body } });
const tapWa = (from: string, id: string) => waMsg(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
// Instagram / Messenger DMs.
const ids = { instagram: "IG1", messenger: "PAGE1" } as const;
type P = keyof typeof ids;
const dm = (p: P, user: string, text: string) =>
  signed("/meta/webhook", { object: p === "instagram" ? "instagram" : "page", entry: [{ id: ids[p], time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: ids[p] }, timestamp: Date.now(), message: { mid: `m_in${++mid}`, text } }] }] });

const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST").map((c) => ({ url: String(c[0]), body: JSON.parse((c[1] as { body: string }).body) }));
const waSent = (): Json[] => posts().filter((p) => p.url.includes("/1000/messages")).map((p) => p.body);
const metaSent = (): Json[] => posts().filter((p) => p.url.includes("/PAGE1/messages")).map((p) => p.body);
const waBody = (p: Json) => p.text?.body ?? p.interactive?.body?.text;
const metaBody = (m: Json) => m.message.text ?? m.message.attachment.payload.text;
const rows = () => db.prepare("SELECT channel, person, stage, state FROM followups ORDER BY created_at, channel, person").all<Json>().then((r) => r.results);
// One cron tick at `ms`: what the scheduled handler runs for follow-ups (the prices are read first, as there).
async function tick(ms: number) {
  at(ms);
  await loadPrices(env());
  return (await whatsappFollowUps(env(), ms)) + (await socialFollowUps(env(), ms));
}
// The number of follow-ups sent between `from` and `to`, ticking every 2 minutes as the cron does (or every `step`, for a long stretch).
async function ticks(from: number, to: number, step = 2 * MIN) {
  let sent = 0;
  for (let t = from; t <= to; t += step) sent += await tick(t);
  return sent;
}

let phone = 919811200000;
// Someone on WhatsApp who greets, picks a language and asks something: their last real message is at `t`.
async function waPerson(t = T0, lang: "en" | "hi" = "en", last = "how much does it cost?") {
  const from = String(++phone);
  at(t - 2 * MIN);
  await typed(from, "hi");
  await tapWa(from, `lang_${lang}`);
  at(t);
  await typed(from, last);
  const conv = (await db.prepare("SELECT id FROM conversations WHERE wa_id = ?1").bind(from).first<{ id: number }>())!.id;
  return { from, conv };
}

beforeEach(async () => {
  ({ db, close } = await newDb());
  flags = { SENDS: "true", SOCIAL_REPLIES: "true" };
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes("is_user_follow_business")) return new Response(JSON.stringify({ is_user_follow_business: true }), { status: 200 });
    if (init?.method === "POST" && u.includes("/PAGE1/messages")) {
      const b = JSON.parse(init.body ?? "{}");
      return new Response(JSON.stringify({ recipient_id: b.recipient?.id, message_id: `m_out${++n}` }), { status: 200 });
    }
    if (init?.method === "POST" && u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => a) as never); // ref codes: "IGAAAAA", "FBAAAAA"
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await close();
});

const en = copyFor("en");
const WA_BOOK = { id: "menu_book", title: "Book ₹99 call" };

describe("the rules", () => {
  it("the owner's wording, with the prices, minutes and hours in force", () => {
    expect(en.autoFollowUp1).toBe("Just checking in: did you find what you were looking for? If you'd like to talk to Shantha Rao, the ₹99 15-minute call is the easiest way. You choose the time, and she calls you.");
    expect(en.autoFollowUp2).toBe("Whenever you're ready, you can book a ₹99 15-minute call with Shantha Rao. Calls are Monday to Saturday, 2 pm to 7 pm.");
    expect(socialWords("en").followUp1).toBe(en.autoFollowUp1);
    expect(socialWords("en").followUp2).toBe(en.autoFollowUp2);
    expect(socialWords("en").followUpGentle).toBe("Hope you're doing okay. If you'd like to talk to Shantha Rao, just message us on WhatsApp. We're here.");
    // WhatsApp: no "on WhatsApp" there.
    expect(en.autoFollowUpGentle).toBe("Hope you're doing okay. If you'd like to talk to Shantha Rao, just reply to this message. We're here.");
    for (const t of [en.autoFollowUpGentle, socialWords("en").followUpGentle, copyFor("hi").autoFollowUpGentle, socialWords("hi").followUpGentle]) expect(t).not.toMatch(/₹|\d/);
  });

  it("due: the first from 60 minutes, the second from 20 hours, nothing at night (21:00 to 08:00 India time) or after 23 hours", () => {
    const a = iso(T0);
    expect(dueFollowUp(a, null, T0 + 59 * MIN)).toBeNull();
    expect(dueFollowUp(a, null, T0 + 60 * MIN)).toEqual({ stage: 1, gentle: false });
    expect(dueFollowUp(a, null, T0 + 8 * HOUR + 59 * MIN)).toEqual({ stage: 1, gentle: false }); // 20:59
    expect(dueFollowUp(a, null, T0 + 9 * HOUR)).toBeNull(); // 21:00
    expect(dueFollowUp(a, null, T0 + 19 * HOUR + 59 * MIN)).toBeNull(); // 07:59
    expect(dueFollowUp(a, null, T0 + 20 * HOUR)).toEqual({ stage: 2, gentle: false }); // 08:00
    expect(dueFollowUp(a, null, T0 + 23 * HOUR)).toEqual({ stage: 2, gentle: false });
    expect(dueFollowUp(a, null, T0 + 23 * HOUR + MIN)).toBeNull();
    // An illness named: only the second (gentle); and only for a week after it was named.
    expect(dueFollowUp(a, a, T0 + 2 * HOUR)).toBeNull();
    expect(dueFollowUp(a, a, T0 + 20 * HOUR)).toEqual({ stage: 2, gentle: true });
    expect(dueFollowUp(a, iso(T0 - 8 * 24 * HOUR), T0 + 2 * HOUR)).toEqual({ stage: 1, gentle: false });
    expect([atNight(Date.parse("2026-11-02T15:29:00Z")), atNight(Date.parse("2026-11-02T15:30:00Z")), atNight(Date.parse("2026-11-03T02:29:00Z")), atNight(Date.parse("2026-11-03T02:30:00Z"))])
      .toEqual([false, true, true, false]);
  });

  it("every button title is at most 20 characters and every text fits Meta's limits, in both languages", () => {
    for (const lang of ["en", "hi"] as const) {
      const cp = copyFor(lang);
      const w = socialWords(lang);
      expect(cp.btnBook.length, lang).toBeLessThanOrEqual(20);
      for (const b of [w.btnBook, w.btnChat]) expect(b.length).toBeLessThanOrEqual(20);
      for (const t of [cp.autoFollowUp1, cp.autoFollowUp2, cp.autoFollowUpGentle]) expect(t.length).toBeLessThanOrEqual(config.whatsapp.buttonBodyMax);
      for (const t of [w.followUp1, w.followUp2, w.followUpGentle]) {
        expect(t.length).toBeLessThanOrEqual(640); // Instagram button template
        expect(new TextEncoder().encode(`${t}\n\n${w.btnBook}: ${PUB}/b/FBAAAAA/hi/back`).length).toBeLessThan(1000); // Messenger text, well under 2,000
      }
    }
  });
});

describe("WhatsApp", () => {
  it("60 minutes after their last message the first follow-up with [Book ₹99 call]; at 20 hours the second; each once; nothing more", async () => {
    const { conv } = await waPerson();
    fetchMock.mockClear();
    expect(await ticks(T0, T0 + 58 * MIN)).toBe(0);
    expect(await tick(T0 + 60 * MIN)).toBe(1);
    expect(waSent()).toHaveLength(1);
    expect(waSent()[0].interactive).toEqual({ type: "button", body: { text: en.autoFollowUp1 }, action: { buttons: [{ type: "reply", reply: WA_BOOK }] } });
    expect(await tick(T0 + 60 * MIN)).toBe(0); // the same tick again (a second cron run): nothing
    expect(await ticks(T0 + 62 * MIN, T0 + 19 * HOUR + 58 * MIN, 16 * MIN)).toBe(0);
    expect(await tick(T0 + 20 * HOUR)).toBe(1); // 08:00 the next morning
    expect(waBody(waSent()[1])).toBe(en.autoFollowUp2);
    expect(waSent()[1].interactive.action.buttons).toEqual([{ type: "reply", reply: WA_BOOK }]);
    expect(await ticks(T0 + 20 * HOUR + 2 * MIN, T0 + 24 * HOUR, 10 * MIN)).toBe(0);
    expect(await rows()).toEqual([
      { channel: "whatsapp", person: String(conv), stage: 1, state: "SENT" },
      { channel: "whatsapp", person: String(conv), stage: 2, state: "SENT" },
    ]);
    // Recorded through the one send path, with its own dedupe key.
    const out = await db.prepare("SELECT dedupe_key AS k, status FROM messages WHERE conversation_id = ?1 AND dedupe_key LIKE 'autofollow:%' ORDER BY id").bind(conv).all<Json>();
    expect(out.results.map((r: Json) => r.status)).toEqual(["SENT", "SENT"]);
  }, 60_000);

  it("a tap on [Book ₹99 call] starts the booking as from the menu, and a new message starts the times again", async () => {
    const { from } = await waPerson();
    at(T0 + 50 * MIN);
    await typed(from, "where are you based?");
    fetchMock.mockClear();
    expect(await tick(T0 + 60 * MIN)).toBe(0); // 60 minutes after the first message, but only 10 after the last
    expect(await tick(T0 + 110 * MIN)).toBe(1);
    at(T0 + 112 * MIN);
    await tapWa(from, "menu_book");
    const last = waSent().at(-1);
    expect(last.type).toBe("interactive"); // the booking flow's next step answered the tap
    expect(waBody(last)).not.toBe(en.autoFollowUp1);
  }, 60_000);

  it("at most 2 follow-ups per person per channel in 7 days", async () => {
    const { from } = await waPerson();
    fetchMock.mockClear();
    expect(await tick(T0 + 60 * MIN)).toBe(1);
    at(T0 + 2 * HOUR);
    await typed(from, "ok what are the timings");
    expect(await tick(T0 + 3 * HOUR)).toBe(1);
    at(T0 + 4 * HOUR);
    await typed(from, "is it online?");
    expect(await ticks(T0 + 5 * HOUR, T0 + 5 * HOUR + 4 * MIN)).toBe(0);
    expect(await tick(T0 + 24 * HOUR)).toBe(0); // 20 hours after the last message: the second, but the week's two are used
    expect(await rows()).toHaveLength(2);
    // A week later it may start again.
    at(T0 + 7 * 24 * HOUR + HOUR);
    await typed(from, "hello again, how much?");
    expect(await tick(T0 + 7 * 24 * HOUR + 2 * HOUR)).toBe(1);
  }, 60_000);

  it("night: one due at night goes at 08:00 if within 23 hours of their message, otherwise never", async () => {
    // 20:30: the first is due at 21:30 (night), so it goes at 08:00 (11.5 hours later); the second at 16:30.
    const late = await waPerson(T0 + 8.5 * HOUR);
    // 08:30: the first at 09:30; the second would be 04:30 (night), and 08:00 is 23.5 hours later: never.
    const early = await waPerson(T0 - 3.5 * HOUR);
    fetchMock.mockClear();
    expect(await tick(T0 - 2.5 * HOUR)).toBe(1); // 09:30, early's first
    expect(await ticks(T0 + 9.5 * HOUR, T0 + 9.5 * HOUR + 4 * MIN)).toBe(0); // 22:00..: late's first waits
    expect(await tick(T0 + 19 * HOUR + 58 * MIN)).toBe(0); // 07:58
    expect(await tick(T0 + 20 * HOUR)).toBe(1); // 08:00: late's first; early's second is past 23 hours
    expect(await tick(T0 + 28.5 * HOUR)).toBe(1); // 16:30: late's second
    expect((await rows()).map((r: Json) => [Number(r.person), r.stage])).toEqual([[early.conv, 1], [late.conv, 1], [late.conv, 2]]);
  }, 60_000);

  it("an illness named: only the gentle check-in, at 20 hours, with no price and no button", async () => {
    await waPerson(T0, "en", "I have thyroid, can it help me?");
    fetchMock.mockClear();
    expect(await ticks(T0 + 58 * MIN, T0 + 70 * MIN)).toBe(0);
    expect(await tick(T0 + 20 * HOUR)).toBe(1);
    expect(waSent()).toEqual([expect.objectContaining({ type: "text", text: { body: en.autoFollowUpGentle } })]);
    expect(await tick(T0 + 22 * HOUR)).toBe(0);
  }, 60_000);

  it("Hindi: the Hindi words and button", async () => {
    await waPerson(T0, "hi", "कितना खर्च है?");
    fetchMock.mockClear();
    await tick(T0 + 60 * MIN);
    await tick(T0 + 20 * HOUR);
    const hi = copyFor("hi");
    expect(waSent().map(waBody)).toEqual([hi.autoFollowUp1, hi.autoFollowUp2]);
    expect(waSent()[0].interactive.action.buttons[0].reply).toEqual({ id: "menu_book", title: hi.btnBook });
    expect(hi.autoFollowUp2).toContain("सोमवार से शनिवार");
  }, 60_000);

  it("the price in force (Settings), never a fixed one", async () => {
    await setSetting(db, "price.intro_paise", "14900");
    await waPerson();
    fetchMock.mockClear();
    await tick(T0 + 60 * MIN);
    expect(waBody(waSent()[0])).toContain("₹149 15-minute call");
    await setSetting(db, "price.intro_paise", "9900");
    await loadPrices(env());
  }, 60_000);

  it("none after a paid booking, 'stop', a block or an insult, a safety message, 'Talk to a person', a held slot; none while sends are off or Amma is away", async () => {
    const people: Record<string, { from: string; conv: number }> = {};
    for (const k of ["paid", "stop", "blocked", "rude", "crisis", "emergency", "human", "held"]) people[k] = await waPerson();
    const { paid, stop, blocked, rude, crisis, emergency, human, held } = people;
    const intro = await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_NOT_FIT')").bind(paid.conv).run();
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, 9900, 'REFUNDED')").bind(intro.meta.last_row_id).run();
    at(T0 + MIN);
    await typed(stop.from, "stop");
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(blocked.conv).run();
    await typed(rude.from, "shut up");
    await typed(crisis.from, "I want to die");
    await typed(emergency.from, "heart attack, can't breathe");
    await typed(human.from, "talk to a person");
    await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until) VALUES ('CALL', ?1, ?2, ?3, 'HELD', ?4)")
      .bind(iso(T0 + 26 * HOUR), iso(T0 + 26 * HOUR + 15 * MIN), held.conv, iso(T0 + 5 * HOUR)).run();
    fetchMock.mockClear();
    expect(await tick(T0 + 61 * MIN)).toBe(0);
    expect(waSent()).toHaveLength(0);
    // Sends paused in /admin, then Amma away: nothing for anyone (a fresh person included); back on: the fresh person only.
    const fresh = await waPerson(T0 + 2 * HOUR);
    await setSetting(db, "SENDS", "false");
    expect(await tick(T0 + 3 * HOUR)).toBe(0);
    await setSetting(db, "SENDS", "true");
    await setSetting(db, "AMMA_AWAY", "true");
    expect(await tick(T0 + 3 * HOUR + 2 * MIN)).toBe(0);
    flags.SENDS = "false"; // the env flag
    await setSetting(db, "AMMA_AWAY", "false");
    expect(await tick(T0 + 3 * HOUR + 4 * MIN)).toBe(0);
    flags.SENDS = "true";
    fetchMock.mockClear();
    expect(await tick(T0 + 3 * HOUR + 6 * MIN)).toBe(1);
    expect(waSent().map((p: Json) => p.to)).toEqual([fresh.from]);
  }, 90_000);

  it("spam, a reaction or a job request is not a real message: no follow-up", async () => {
    const from = String(++phone);
    await typed(from, "hi");
    await tapWa(from, "lang_en");
    await db.prepare("UPDATE person_state SET real_in_at = NULL WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)").bind(from).run();
    at(T0 + MIN);
    await typed(from, "Earn money fast, invest in crypto www.example.invalid/x");
    await typed(from, "I am looking for a job");
    await waMsg(from, { type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } });
    const st = await db.prepare("SELECT real_in_at FROM person_state WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)").bind(from).first<Json>();
    expect(st.real_in_at).toBeNull();
  }, 30_000);

  it("two cron runs at once send one follow-up", async () => {
    await waPerson();
    fetchMock.mockClear();
    at(T0 + 60 * MIN);
    await loadPrices(env());
    const [a, b] = await Promise.all([whatsappFollowUps(env(), T0 + 60 * MIN), whatsappFollowUps(env(), T0 + 60 * MIN)]);
    expect(a + b).toBe(1);
    expect(waSent()).toHaveLength(1);
  }, 30_000);

  it("a timed-out send is UNKNOWN: counted, never sent again", async () => {
    await waPerson();
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await tick(T0 + 60 * MIN)).toBe(1);
    expect((await rows())[0].state).toBe("UNKNOWN");
    expect(await tick(T0 + 62 * MIN)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe("Instagram and Messenger", () => {
  it("Instagram: the button template with [Book on WhatsApp]; Messenger: the text with the short link; at 60 minutes and 20 hours", async () => {
    await dm("instagram", "U1", "how much is it?"); // Instagram says they follow: the way to book
    await dm("messenger", "P1", "hello"); // the follow ask: they haven't booked, so they get the follow-ups too
    fetchMock.mockClear();
    expect(await tick(T0 + 58 * MIN)).toBe(0);
    expect(await tick(T0 + 60 * MIN)).toBe(2);
    const [ig, fb] = metaSent();
    expect(ig).toEqual({
      recipient: { id: "U1" },
      message: { attachment: { type: "template", payload: { template_type: "button", text: en.autoFollowUp1, buttons: [
        { type: "web_url", url: `https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=${encodeURIComponent("Hi, I'd like to book a ₹99 call (ref: IGAAAAA)")}`, title: "Book on WhatsApp" },
      ] } } },
    });
    expect(fb).toEqual({ recipient: { id: "P1" }, messaging_type: "RESPONSE", message: { text: `${en.autoFollowUp1}\n\nBook on WhatsApp: ${PUB}/b/FBAAAAA`, metadata: "dd-bot" } });
    expect(await tick(T0 + 20 * HOUR)).toBe(2);
    expect(metaSent().slice(2).map(metaBody)).toEqual([en.autoFollowUp2, `${en.autoFollowUp2}\n\nBook on WhatsApp: ${PUB}/b/FBAAAAA`]);
    expect(await ticks(T0 + 20 * HOUR + 2 * MIN, T0 + 23 * HOUR, 10 * MIN)).toBe(0);
    // The echo of a follow-up is ours: it doesn't pause the chat.
    await signed("/meta/webhook", { object: "instagram", entry: [{ id: "IG1", messaging: [{ sender: { id: "IG1" }, recipient: { id: "U1" }, timestamp: Date.now(), message: { mid: "m_echo_fu", is_echo: true, text: en.autoFollowUp2 } }] }] });
    expect((await db.prepare("SELECT paused_until FROM social_contacts WHERE user_id = 'U1'").first<Json>()).paused_until).toBeNull();
  }, 60_000);

  it("an illness named: only the gentle one, at 20 hours, with [Message on WhatsApp] and \"Hi\"; Hindi gets Hindi", async () => {
    await dm("instagram", "U1", "I have diabetes, can pranic healing cure it?");
    await dm("messenger", "P2", "mujhe thyroid hai, kya ilaj ho sakta hai?");
    fetchMock.mockClear();
    expect(await ticks(T0 + 60 * MIN, T0 + 64 * MIN)).toBe(0);
    expect(await tick(T0 + 20 * HOUR)).toBe(2);
    const [ig, fb] = metaSent();
    expect(ig.message.attachment.payload.text).toBe(socialWords("en").followUpGentle);
    expect(ig.message.attachment.payload.buttons).toEqual([
      { type: "web_url", url: `https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=${encodeURIComponent("Hi (ref: IGAAAAA)")}`, title: "Message on WhatsApp" },
    ]);
    expect(fb.message.text).toBe(`${socialWords("hi").followUpGentle}\n\nWhatsApp पर लिखें: ${PUB}/b/FBAAAAA/hi/back`);
  }, 60_000);

  it("Hindi: the Hindi follow-ups", async () => {
    await dm("messenger", "P1", "namaste, kitna hai?");
    fetchMock.mockClear();
    await tick(T0 + 60 * MIN);
    expect(metaSent()[0].message.text).toBe(`${copyFor("hi").autoFollowUp1}\n\nWhatsApp पर बुक करें: ${PUB}/b/FBAAAAA/hi`);
  }, 30_000);

  it("a new message starts the times again; at most 2 in 7 days", async () => {
    await dm("messenger", "P1", "hello");
    at(T0 + 40 * MIN);
    await dm("messenger", "P1", "I've followed");
    fetchMock.mockClear();
    expect(await tick(T0 + 60 * MIN)).toBe(0);
    expect(await tick(T0 + 100 * MIN)).toBe(1);
    at(T0 + 3 * HOUR);
    await dm("messenger", "P1", "where are you based?");
    expect(await tick(T0 + 4 * HOUR)).toBe(1);
    at(T0 + 5 * HOUR);
    await dm("messenger", "P1", "ok, any other details?");
    expect(await ticks(T0 + 6 * HOUR, T0 + 6 * HOUR + 4 * MIN)).toBe(0);
    expect(await tick(T0 + 25 * HOUR)).toBe(0);
  }, 60_000);

  it("none after 'I booked', 'stop', a block, the team writing by hand, a safety message, junk; none while SOCIAL_REPLIES is off", async () => {
    await dm("instagram", "B1", "I booked already");
    await dm("instagram", "S1", "hello");
    at(T0 + MIN);
    await dm("instagram", "S1", "not interested");
    await dm("instagram", "X1", "you idiot, fuck off");
    await dm("instagram", "H1", "how much?");
    at(T0 + 5 * MIN); // the team writes a few minutes after our reply (an echo right after our own send is taken as ours)
    await signed("/meta/webhook", { object: "instagram", entry: [{ id: "IG1", messaging: [{ sender: { id: "IG1" }, recipient: { id: "H1" }, timestamp: Date.now(), message: { mid: "m_team1", is_echo: true, text: "Hello, this is the team" } }] }] });
    await dm("instagram", "C1", "how much?");
    await dm("instagram", "C1", "I want to end my life");
    await dm("instagram", "J1", "Grow your business with our SEO services, buy followers");
    fetchMock.mockClear();
    expect(await ticks(T0 + 61 * MIN, T0 + 67 * MIN)).toBe(0);
    expect(await tick(T0 + 20 * HOUR)).toBe(0);
    // SOCIAL_REPLIES off: nothing on Instagram or Messenger.
    at(T0 + 21 * HOUR);
    await dm("messenger", "P9", "hello");
    flags.SOCIAL_REPLIES = "false";
    expect(await tick(T0 + 22 * HOUR + 2 * MIN)).toBe(0);
    expect(metaSent()).toHaveLength(1); // only the reply to P9's message
  }, 60_000);

  it("someone whose Instagram link opened a WhatsApp chat gets WhatsApp's follow-ups only", async () => {
    await dm("instagram", "U1", "how much?");
    const from = String(++phone);
    at(T0 + MIN);
    await typed(from, "Hi, I'd like to book a ₹99 call (ref: IGAAAAA)");
    await tapWa(from, "lang_en");
    expect((await db.prepare("SELECT wa_conversation_id AS c FROM social_contacts WHERE user_id = 'U1'").first<Json>()).c).not.toBeNull();
    fetchMock.mockClear();
    expect(await tick(T0 + 62 * MIN)).toBe(1);
    expect(metaSent()).toHaveLength(0);
    expect(waSent().map((p: Json) => p.to)).toEqual([from]);
  }, 30_000);

  it("'delete my data' deletes their follow-up rows too", async () => {
    await dm("instagram", "U1", "how much?");
    await tick(T0 + 60 * MIN);
    expect(await rows()).toHaveLength(1);
    at(T0 + 2 * HOUR);
    await dm("instagram", "U1", "delete my data");
    expect(await rows()).toHaveLength(0);
  }, 30_000);
});

describe("the cron and the digest", () => {
  it("the 2-minute cron sends them, and the 9pm digest counts them", async () => {
    await waPerson();
    await dm("instagram", "U1", "how much?");
    fetchMock.mockClear();
    at(T0 + 60 * MIN);
    const scheduled = (app as unknown as { scheduled: (ev: { cron: string; scheduledTime?: number }, e: unknown) => Promise<void> }).scheduled;
    await scheduled({ cron: "*/2 * * * *", scheduledTime: T0 + 60 * MIN }, env());
    expect(waSent()).toHaveLength(1);
    expect(metaSent()).toHaveLength(1);
    expect(await digestText(env(), T0 + 9 * HOUR)).toContain("Automatic follow-ups (last 24 hours)\n- Sent: WhatsApp 1, Instagram 1, Messenger 0");
  }, 30_000);
});
