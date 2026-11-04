// Ticket 40: "Send session link (₹799)" from the console (src/sessionlink.ts). With a time (the bot's hold and link) or for the customer to
// choose (the single session's own steps); paid, it is a normal session on Calendar and Today. All people, numbers and links are synthetic;
// Access, Meta and Razorpay are fakes (test/console-env.ts), the clock is fixed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { config } from "../src/config";
import { copyFor } from "../src/copy";
import { sessionChoice } from "../src/session";
import { generateSlots, iso } from "../src/slots";
import { setSetting } from "../src/switches";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";
import { paidEvent, rzpHeaders } from "./razorpay";

const MIN = 60_000;
const NOW = Date.parse("2026-11-03T05:30:00Z"); // Tue 3 Nov 2026, 11:00 am India time
const TIME = generateSlots("2026-11-04", "SESSION").find((s) => s.startUtc === "2026-11-04T09:30:00Z")!; // Wed 3:00 pm India time
const PRAC2 = "second-practitioner@example.test";
const h = new ConsoleHarness();
const templates = config.templates as unknown as Record<string, { approved: boolean; hi: { approved: boolean } }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let outN = 0;
beforeEach(async () => {
  await h.start(NOW);
  await h.db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, ?1, 'PRACTITIONER', 'active')").bind(PRAC2).run();
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) =>
      String(url).includes("graph.facebook.com") && init?.method === "POST" ? new Response(JSON.stringify({ messages: [{ id: `wamid.SL${++outN}` }] })) : base(url, init as never),
    ),
  );
});
afterEach(() => h.stop());

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const waSent = (): Json[] =>
  (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls
    .filter(([u, i]) => String(u).includes("graph.facebook.com") && i?.method === "POST")
    .map(([, i]) => JSON.parse(i.body ?? "{}"));
const memberId = async (email: string) => (await h.member(email))!.id;

let wa = 919600000000;
// A customer whose ₹99 call was today at 10 am with the practitioner, paid; inside the 24-hour window unless said otherwise.
async function customer(o: { lastUserAt?: number | null; paid?: boolean; state?: string; locale?: string } = {}) {
  const waId = String(++wa);
  const last = o.lastUserAt === undefined ? NOW - 10 * MIN : o.lastUserAt;
  const conv = (
    await h.db
      .prepare("INSERT INTO conversations (wa_id, display_name, locale, last_user_at, age_ok_at) VALUES (?1, 'Asha Test', ?2, ?3, '2026-01-01T00:00:00Z')")
      .bind(waId, o.locale ?? "en", last === null ? null : iso(last))
      .run()
  ).meta.last_row_id;
  await h.db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(conv).run();
  const prac = await memberId(PRAC);
  const start = Date.parse("2026-11-03T04:30:00Z") + conv * MIN; // about 10 am India time, one per person
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED', ?4)").bind(iso(start), iso(start + 15 * MIN), conv, prac).run()).meta.last_row_id;
  const intro = (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id, call_lang) VALUES (?1, ?2, 'HEALING', ?3, ?4, 'en')").bind(conv, slot, o.state ?? "CALLED_SESSION", prac).run()).meta.last_row_id;
  if (o.paid !== false) await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, ?2, 9900, 'PAID')").bind(intro, `di-intro-${intro}`).run();
  return { conv, waId, intro };
}
const hold = async (conv: number, as = OWNER, time = TIME.startUtc, n = "n1") => h.post(`/app/session-link/${conv}/hold`, { time, n, csrf: await h.tokenFor(as, `slink-hold:${conv}`) }, as);
const choose = async (conv: number, as = OWNER, n = "n1") => h.post(`/app/session-link/${conv}/choose`, { n, csrf: await h.tokenFor(as, `slink-choose:${conv}`) }, as);
const audits = () => h.audits("SEND_SESSION_LINK");
const sessionPay = (conv: number) =>
  h.db.prepare("SELECT p.id, p.state, p.amount_paise AS amount, p.provider_link_id AS link, se.id AS sid FROM payments p JOIN sessions se ON se.id = p.target_id WHERE p.purpose = 'SESSION' AND se.conversation_id = ?1 ORDER BY p.id DESC").bind(conv).first<Json>();
async function pay(link: string) {
  h.fake.markPaid(link, { amount: 79900 });
  const raw = JSON.stringify(paidEvent(link, { amount: 79900 }));
  expect((await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, h.env())).status).toBe(200);
}
// The session on the Calendar's day view and on Today, on its day.
async function onCalendarAndToday(conv: number) {
  const ses = await h.db.prepare("SELECT se.state, sl.state AS slot FROM sessions se JOIN slots sl ON sl.id = se.slot_id WHERE se.conversation_id = ?1 AND se.state = 'CONFIRMED'").bind(conv).first<Json>();
  expect(ses).toEqual({ state: "CONFIRMED", slot: "BOOKED" });
  const cal = decode(await (await h.get("/app/calendar?view=day&d=2026-11-04")).text());
  expect(cal).toContain("Asha");
  expect(cal).toContain("3:00 pm");
  vi.setSystemTime(Date.parse("2026-11-04T03:30:00Z")); // Wed 9 am
  const today = decode(await (await h.get("/app")).text());
  expect(today).toContain("Asha");
  expect(today).toContain("3:00 pm");
}

describe("who sees the button, and who may send", () => {
  it("the person page, the Today call card and the Inbox chat show it to the owner, staff and the call's practitioner", async () => {
    const a = await customer();
    const href = `href="/app/session-link/${a.conv}"`;
    expect(decode(await (await h.get(`/app/people/${a.conv}`)).text())).toContain("Send session link (₹799)");
    expect(await (await h.get(`/app/people/${a.conv}`, STAFF)).text()).toContain(href);
    expect(await (await h.get("/app")).text()).toContain(href);
    expect(await (await h.get("/app", PRAC)).text()).toContain(href);
    await h.db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE id = ?1").bind(a.conv, iso(NOW)).run();
    expect(await (await h.get(`/app/inbox/${a.conv}`)).text()).toContain(href);
    for (const who of [OWNER, STAFF, PRAC]) expect((await h.get(`/app/session-link/${a.conv}`, who)).status, who).toBe(200);
  });

  it("another practitioner, a customer with no paid call, a forged token and a foreign Origin are refused; nothing is sent", async () => {
    const a = await customer();
    const unpaid = await customer({ paid: false });
    const rude = await customer({ state: "RUDE" });
    expect((await h.get(`/app/session-link/${a.conv}`, PRAC2)).status).toBe(403);
    expect((await hold(a.conv, PRAC2)).status).toBe(403);
    expect((await choose(a.conv, PRAC2)).status).toBe(403);
    for (const x of [unpaid, rude]) {
      expect((await h.get(`/app/session-link/${x.conv}`)).status).toBe(403);
      expect((await hold(x.conv)).status).toBe(403);
      expect(await (await h.get(`/app/people/${x.conv}`)).text()).not.toContain(`/app/session-link/${x.conv}`);
    }
    expect((await h.post(`/app/session-link/${a.conv}/hold`, { time: TIME.startUtc, n: "x", csrf: "0".repeat(64) })).status).toBe(403);
    expect((await h.post(`/app/session-link/${a.conv}/hold`, { time: TIME.startUtc, n: "x", csrf: await h.tokenFor(OWNER, `slink-choose:${a.conv}`) })).status).toBe(403);
    expect((await h.post(`/app/session-link/${a.conv}/hold`, { time: TIME.startUtc, n: "x", csrf: await h.tokenFor(OWNER, `slink-hold:${a.conv}`) }, OWNER, { origin: "https://evil.example" })).status).toBe(403);
    expect(waSent()).toHaveLength(0);
    expect(await audits()).toEqual([]);
    expect(await h.count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION'")).toBe(0);
  });
});

describe("with a time", () => {
  it("holds the time, sends the ₹799 link, audits it; paid, it is on the Calendar and Today", async () => {
    const a = await customer();
    const page = decode(await (await h.get(`/app/session-link/${a.conv}`)).text());
    expect(page).toContain(`value="${TIME.startUtc}"`);
    const res = await hold(a.conv, PRAC);
    expect(res.status).toBe(200);
    expect(decode(await res.text())).toContain("Held Wed, 4 Nov, 3:00 pm until 11:20 am. The payment link has gone to them.");
    const p = await sessionPay(a.conv);
    expect(p).toMatchObject({ state: "PENDING", amount: config.prices.single });
    expect(await h.db.prepare("SELECT state, hold_until AS until FROM slots WHERE kind = 'SESSION' AND owner_id = ?1").bind(a.conv).first()).toEqual({ state: "HELD", until: iso(NOW + config.holdMinutes * MIN) });
    const msg = waSent().at(-1);
    expect(msg.to).toBe(a.waId);
    expect(msg.interactive.type).toBe("cta_url");
    expect(msg.interactive.body.text).toContain("Wed, 4 Nov");
    expect(msg.interactive.action.parameters.display_text).toBe(copyFor("en").sessionPayLabel);
    const au = await audits();
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ actor: PRAC, memberId: await memberId(PRAC), target: `conv:${a.conv}` });
    expect(au[0].detail).toBe(`session:${p.sid} with a time ${TIME.startUtc}`);
    await pay(p.link);
    await onCalendarAndToday(a.conv);
  });

  it("one held time at a time; a time someone else holds or has booked is refused without a word to the customer", async () => {
    const a = await customer();
    expect((await hold(a.conv)).status).toBe(200);
    const sent = waSent().length;
    const again = await hold(a.conv, OWNER, TIME.startUtc, "n2");
    expect(again.status).toBe(409);
    expect(decode(await again.text())).toContain("They already have a time held.");
    expect(await h.count("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION'")).toBe(1);
    const b = await customer();
    const taken = await hold(b.conv);
    expect(taken.status).toBe(409);
    expect(decode(await taken.text())).toContain("That time is no longer free.");
    expect(waSent()).toHaveLength(sent);
    expect(await audits()).toHaveLength(1);
  });

  it("the window closed: refused until session_link is approved; then the template carries the time and the link", async () => {
    const a = await customer({ lastUserAt: NOW - 30 * 3_600_000 });
    expect(decode(await (await h.get(`/app/session-link/${a.conv}`)).text())).toContain('WhatsApp window closed: this needs the template "session_link" approved in Meta.');
    const res = await hold(a.conv);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain('needs the template "session_link" approved in Meta. Nothing was sent.');
    expect(await h.count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION'")).toBe(0);
    expect(waSent()).toHaveLength(0);
    templates.session_link.approved = true;
    expect((await hold(a.conv)).status).toBe(200);
    const t = waSent().at(-1).template;
    expect(t.name).toBe("session_link");
    expect(t.components[0].parameters.map((x: Json) => x.text).slice(0, 3)).toEqual(["Wed, 4 Nov", "3:00 pm", "11:20 am"]);
    expect(t.components[0].parameters[3].text).toMatch(/\/p\//);
    expect((await audits())[0].detail).toContain("(template)");
  });
});

describe("let them choose", () => {
  it("sends [Choose a time]; they pick a time and pay; it is on the Calendar and Today", async () => {
    const a = await customer();
    const res = await choose(a.conv, STAFF);
    expect(decode(await res.text())).toContain("Sent. They can choose a time and pay.");
    const msg = waSent().at(-1);
    expect(msg.interactive.body.text).toBe(copyFor("en").sessionLinkBody);
    const id = msg.interactive.action.buttons[0].reply.id as string;
    expect(id).toMatch(/^sess_offer_\d+$/);
    expect((await audits())[0].detail).toBe(`session:${id.slice(11)} let them choose`);
    // The customer's taps, as the webhook hands them on: the days, then a time (the hold and the link).
    expect(await sessionChoice(h.env(), id, a.conv, "wamid.TAP1")).toBe(true);
    expect(await sessionChoice(h.env(), `sess_${id.slice(11)}_${TIME.startUtc}`, a.conv, "wamid.TAP2")).toBe(true);
    const p = await sessionPay(a.conv);
    expect(p).toMatchObject({ state: "PENDING", amount: config.prices.single });
    await pay(p.link);
    await onCalendarAndToday(a.conv);
  });

  it("the copy, English and Hindi (Hindi to be read)", () => {
    expect(copyFor("en").sessionLinkBody).toBe("Shantha Rao would like to book a full session with you (₹799, 60 minutes, by phone). Tap below to choose a time; it is yours once it is paid.");
    expect(copyFor("hi").sessionLinkBody).toContain("शांता राव जी आपके साथ एक पूरा सेशन बुक करना चाहती हैं");
  });

  it("the window closed: the approved session_offer template, or a plain message when it isn't approved", async () => {
    const a = await customer({ lastUserAt: NOW - 30 * 3_600_000 });
    const res = await choose(a.conv);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain('needs the template "session_offer" approved in Meta');
    expect(waSent()).toHaveLength(0);
    templates.session_offer.approved = true;
    expect((await choose(a.conv, OWNER, "n2")).status).toBe(200);
    expect(waSent().at(-1).template.name).toBe("session_offer");
  });
});

describe("guards", () => {
  it("bookings paused, Amma away, blocked, stop, a safety item or the no-selling week: refused with a plain message, nothing sent", async () => {
    const cases: [string, (a: Awaited<ReturnType<typeof customer>>) => Promise<unknown>, string][] = [
      ["paused", () => setSetting(h.db, "NEW_BOOKINGS", "false"), "Bookings are paused, so nothing was sent."],
      ["away", () => setSetting(h.db, "AMMA_AWAY", "true"), "Bookings are paused, so nothing was sent."],
      ["blocked", (a) => h.db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'TEST', 'test')").bind(a.waId).run(), "This person is blocked"],
      ["stop", (a) => h.db.prepare("UPDATE person_state SET opted_out_at = ?2 WHERE conversation_id = ?1").bind(a.conv, iso(NOW - MIN)).run(), "They asked us to stop messaging them"],
      ["safety", (a) => h.db.prepare("INSERT INTO attention (kind, target) VALUES ('CRISIS', ?1)").bind(`conv:${a.conv}`).run(), "This person has an open safety message"],
      ["no-sell", (a) => h.db.prepare("UPDATE person_state SET no_sell_until = ?2 WHERE conversation_id = ?1").bind(a.conv, iso(NOW + 86_400_000)).run(), "No selling to this person until"],
    ];
    for (const [why, setup, words] of cases) {
      const a = await customer();
      await setup(a);
      const page = decode(await (await h.get(`/app/session-link/${a.conv}`)).text());
      expect(page, why).toContain(words);
      expect(page, why).not.toContain("/hold");
      for (const res of [await hold(a.conv), await choose(a.conv)]) {
        expect(res.status, why).toBe(409);
        expect(decode(await res.text()), why).toContain(words);
      }
      await h.db.prepare("DELETE FROM settings WHERE key IN ('NEW_BOOKINGS', 'AMMA_AWAY')").run();
    }
    expect(waSent()).toHaveLength(0);
    expect(await audits()).toEqual([]);
    expect(await h.count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION'")).toBe(0);
  }, 90_000);
});
