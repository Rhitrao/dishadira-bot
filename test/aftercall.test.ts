// Ticket 40: after the call (src/aftercall.ts). The session reminder 48 hours after an untaken offer, and the review and referral ask the
// morning after a paid session; the owner's two switches; the digest line. All people, numbers and links are synthetic; Meta and Razorpay
// are fakes (test/console-env.ts), the clock is fixed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterCallLines, referralLink, reviewAsks, reviewDue, sessionReminders } from "../src/aftercall";
import { config } from "../src/config";
import { copyFor } from "../src/copy";
import { applyDueOutcomes } from "../src/outcomes";
import { razorpay } from "../src/pay/razorpay";
import { digestText } from "../src/report";
import { generateSlots, iso, type SlotKind } from "../src/slots";
import { setSetting } from "../src/switches";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";

// The slot of `kind` starting at `hhmm` India time on `ymd`.
const slotAt = (ymd: string, hhmm: string, kind: SlotKind) => generateSlots(ymd, kind).find((s) => s.startUtc === iso(Date.parse(`${ymd}T${hhmm}:00+05:30`)))!;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Mon 2 Nov 2026, 3:00 pm India time: the call's outcome is applied and the offer goes out.
const OFFER = Date.parse("2026-11-02T09:30:00Z");
const h = new ConsoleHarness();
const templates = config.templates as unknown as Record<string, { approved: boolean; hi: { approved: boolean } }>;
const after = config.afterCall as unknown as { googleReviewUrl: string; reviewUnmarked: boolean };
const REVIEW_URL = "https://g.page/r/EXAMPLE-review/review";

let outN = 0;
beforeEach(async () => {
  await h.start(OFFER);
  // The harness answers every WhatsApp send with the same message id; ours get their own, as Meta's do.
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) =>
      String(url).includes("graph.facebook.com") && init?.method === "POST" ? new Response(JSON.stringify({ messages: [{ id: `wamid.AC${++outN}` }] })) : base(url, init as never),
    ),
  );
  after.googleReviewUrl = REVIEW_URL;
  after.reviewUnmarked = true;
});
afterEach(async () => {
  after.googleReviewUrl = "";
  after.reviewUnmarked = true;
  await h.stop();
});

const at = (ms: number) => vi.setSystemTime(ms);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const waSent = (): Json[] =>
  (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls
    .filter(([u, i]) => String(u).includes("graph.facebook.com") && i?.method === "POST")
    .map(([, i]) => JSON.parse(i.body ?? "{}"));
const sentTo = (wa: string) => waSent().filter((p) => p.to === wa);
const rows = async () => (await h.db.prepare("SELECT kind, target, conversation_id AS conv, state, skip_reason AS why FROM after_call ORDER BY created_at, target").all<Json>()).results;

let wa = 919700000000;
async function person(o: { locale?: string; lastUserAt?: number } = {}) {
  const waId = String(++wa);
  const conv = (
    await h.db
      .prepare("INSERT INTO conversations (wa_id, display_name, locale, last_user_at, age_ok_at) VALUES (?1, 'Test Person', ?2, ?3, '2026-01-01T00:00:00Z')")
      .bind(waId, o.locale ?? "en", iso(o.lastUserAt ?? OFFER - 5 * MIN))
      .run()
  ).meta.last_row_id;
  await h.db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(conv).run();
  return { conv, waId };
}

// A paid ₹99 call that Amma marked "Session"; the outcome applied at `offerMs` sends the offer (inside the window: the list).
async function offered(o: { locale?: string; offerMs?: number } = {}) {
  const offerMs = o.offerMs ?? OFFER;
  const p = await person({ locale: o.locale, lastUserAt: offerMs - 5 * MIN });
  const start = Date.parse(slotAt("2026-10-30", "15:00", "CALL").startUtc) + p.conv * MIN; // one per person
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED')").bind(iso(start), iso(start + 15 * MIN), p.conv).run()).meta.last_row_id;
  const intro = (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'PAID')").bind(p.conv, slot).run()).meta.last_row_id;
  await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', 'INTRO', ?1, ?2, 9900, 'PAID', '2026-10-29T09:00:00Z')").bind(intro, `di-i-${intro}`).run();
  at(offerMs - 11 * MIN);
  await h.db.prepare("INSERT INTO outcomes (intro_id, value, tapped_at, undo_until, slot_id) VALUES (?1, 'SESSION', ?2, ?3, ?4)").bind(intro, iso(offerMs - 11 * MIN), iso(offerMs - MIN), slot).run();
  at(offerMs);
  await applyDueOutcomes(h.env(), razorpay(h.env()), offerMs);
  const sid = (await h.db.prepare("SELECT id FROM sessions WHERE intro_id = ?1").bind(intro).first<{ id: number }>())!.id;
  expect(sentTo(p.waId)).toHaveLength(1); // the offer itself
  return { ...p, intro, sid };
}
const remind = (ms: number) => {
  at(ms);
  return sessionReminders(h.env(), ms);
};
const wrote = (conv: number, ms: number) => h.db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(conv, iso(ms)).run();

describe("the session reminder", () => {
  it("nothing before 48 hours; at 48 hours one reminder with the same three options (inside the window), then never again", async () => {
    const a = await offered();
    await wrote(a.conv, OFFER + 47 * HOUR); // they wrote again, so the 24-hour window is open
    expect(await remind(OFFER + 47 * HOUR + 58 * MIN)).toBe(0);
    expect(await remind(OFFER + 48 * HOUR)).toBe(1);
    const msg = sentTo(a.waId).at(-1);
    expect(msg.interactive.type).toBe("list");
    expect(msg.interactive.body.text).toBe(copyFor("en").sessionReminderBody);
    expect(msg.interactive.action.sections[0].rows.map((r: Json) => r.id)).toEqual([`sess_offer_${a.sid}`, "go_p10", "go_p20"]);
    expect(await rows()).toEqual([{ kind: "REMINDER", target: a.intro, conv: a.conv, state: "SENT", why: null }]);
    for (const t of [OFFER + 48 * HOUR + 2 * MIN, OFFER + 60 * HOUR, OFFER + 90 * HOUR]) expect(await remind(t)).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(2);
  });

  it("the wording, English and Hindi (Hindi to be read by a native speaker)", () => {
    expect(copyFor("en").sessionReminderBody).toBe(
      "A gentle reminder: after your call, Shantha Rao offered you a full session. If you'd like to go ahead, choose an option below: a single session, or a package of 10 or 20. If now isn't the right time, that's completely fine.",
    );
    expect(copyFor("hi").sessionReminderBody).toContain("एक छोटी-सी याद");
  });

  it("outside the window: the template only once Meta has approved it; before that it is skipped, counted and never tried again", async () => {
    const a = await offered();
    expect(await remind(OFFER + 48 * HOUR)).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(1);
    expect(await rows()).toEqual([{ kind: "REMINDER", target: a.intro, conv: a.conv, state: "SKIPPED", why: "TEMPLATE_UNAPPROVED" }]);
    expect(await h.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(0); // counted, not an item
    expect(await afterCallLines(h.env(), OFFER + 48 * HOUR)).toContain("- Session reminders: 0 sent, 1 not sent (the WhatsApp template isn't approved yet)");
    templates.session_reminder.approved = true;
    expect(await remind(OFFER + 49 * HOUR)).toBe(0); // that offer is done: no late backlog once the template is approved
    const b = await offered({ offerMs: OFFER + HOUR });
    expect(await remind(OFFER + 49 * HOUR)).toBe(1);
    expect(sentTo(b.waId).at(-1).template).toEqual({ name: "session_reminder", language: { code: "en" } });
  }, 60_000);

  it("a Hindi chat gets the Hindi template once it is approved, the English one before that", async () => {
    templates.session_reminder.approved = true;
    const a = await offered({ locale: "hi" });
    templates.session_reminder.hi.approved = true;
    expect(await remind(OFFER + 48 * HOUR)).toBe(1);
    expect(sentTo(a.waId).at(-1).template).toEqual({ name: "session_reminder_hi", language: { code: "hi" } });
  });

  it("never at night: one due at 10 pm goes at 8 am, still once", async () => {
    const offerMs = Date.parse("2026-11-02T16:00:00Z"); // 9:30 pm India time
    templates.session_reminder.approved = true;
    const a = await offered({ offerMs });
    expect(await remind(offerMs + 48 * HOUR)).toBe(0);
    expect(await remind(Date.parse("2026-11-05T02:28:00Z"))).toBe(0); // 7:58 am
    expect(await remind(Date.parse("2026-11-05T02:30:00Z"))).toBe(1); // 8:00 am
    expect(await remind(Date.parse("2026-11-05T02:32:00Z"))).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(2);
  });

  it("two cron runs at once send it once (atomic claim)", async () => {
    templates.session_reminder.approved = true;
    const a = await offered();
    at(OFFER + 48 * HOUR);
    const [x, y] = await Promise.all([sessionReminders(h.env(), OFFER + 48 * HOUR), sessionReminders(h.env(), OFFER + 48 * HOUR)]);
    expect(x + y).toBe(1);
    expect(sentTo(a.waId)).toHaveLength(2);
  });

  it("never after 96 hours (a reminder held back that long is dropped)", async () => {
    templates.session_reminder.approved = true;
    const a = await offered();
    await setSetting(h.db, "SENDS", "false");
    expect(await remind(OFFER + 48 * HOUR)).toBe(0);
    await setSetting(h.db, "SENDS", "true");
    expect(await remind(OFFER + 96 * HOUR + 2 * MIN)).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it("every exclusion: paid, booked, holding, stop, blocked, rude, the team, safety, no-sell, paused, away, switched off", async () => {
    templates.session_reminder.approved = true;
    const db = h.db;
    const cases: [string, (a: Awaited<ReturnType<typeof offered>>) => Promise<unknown>][] = [
      ["paid the single session", (a) => db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', 'SESSION', ?1, ?2, 79900, 'PAID', ?3)").bind(a.sid, `di-s-${a.sid}`, iso(OFFER + HOUR)).run()],
      ["paying right now", (a) => db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', 'SESSION', ?1, ?2, 79900, 'PENDING', ?3)").bind(a.sid, `di-s-${a.sid}`, iso(OFFER + 48 * HOUR - 10 * MIN)).run()],
      ["bought a package", (a) => db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(a.conv).run()],
      ["booked the session", (a) => db.prepare("UPDATE sessions SET state = 'CONFIRMED' WHERE id = ?1").bind(a.sid).run()],
      ["holding a time", async (a) => {
        const s = slotAt("2026-11-06", "15:00", "SESSION");
        await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until) VALUES ('SESSION', ?1, ?2, ?3, 'HELD', ?4)").bind(s.startUtc, s.endUtc, a.conv, iso(OFFER + 48 * HOUR + 15 * MIN)).run();
      }],
      ["said stop", (a) => db.prepare("UPDATE person_state SET opted_out_at = ?2 WHERE conversation_id = ?1").bind(a.conv, iso(OFFER + HOUR)).run()],
      ["blocked", (a) => db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(a.conv).run()],
      ["on the block list", (a) => db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'TEST', 'test')").bind(a.waId).run()],
      ["an insult", (a) => db.prepare("UPDATE person_state SET abuse_offences = 1 WHERE conversation_id = ?1").bind(a.conv).run()],
      ["the team has the chat", (a) => db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(a.conv).run()],
      ["asked for a person", (a) => db.prepare("INSERT INTO attention (kind, target) VALUES ('HUMAN_REQUEST', ?1)").bind(`conv:${a.conv}`).run()],
      ["a crisis message", (a) => db.prepare("INSERT INTO messages (conversation_id, direction, dedupe_key, kind, status, created_at) VALUES (?1, 'OUT', ?2, 'text', 'SENT', ?3)").bind(a.conv, `wamid.X${a.conv}:crisis`, iso(OFFER + HOUR)).run()],
      ["no-selling week", (a) => db.prepare("UPDATE person_state SET no_sell_until = ?2 WHERE conversation_id = ?1").bind(a.conv, iso(OFFER + 5 * DAY)).run()],
    ];
    for (const [why, setup] of cases) {
      const a = await offered();
      await setup(a);
      expect(await remind(OFFER + 48 * HOUR), why).toBe(0);
      expect(sentTo(a.waId), why).toHaveLength(1);
      at(OFFER);
    }
    // The switches: bookings paused, Amma away, sends paused, the owner's switch off.
    const a = await offered();
    for (const [key, value] of [["NEW_BOOKINGS", "false"], ["AMMA_AWAY", "true"], ["SENDS", "false"], ["after.reminder", "off"]]) {
      await setSetting(h.db, key, value);
      expect(await remind(OFFER + 48 * HOUR), key).toBe(0);
      await h.db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
    }
    expect(await rows()).toEqual([]);
    expect(await remind(OFFER + 48 * HOUR)).toBe(1); // all back on: it goes
    expect(sentTo(a.waId)).toHaveLength(2);
  }, 120_000);
});

// ---- the review and referral ask ----
const SESSION_DAY = "2026-11-02"; // Mon, the session at 3 pm India time
const MORNING = Date.parse("2026-11-03T04:30:00Z"); // Tue 10:00 am India time
let linkN = 0;
async function sessionDone(o: { locale?: string; day?: string; state?: string; origin?: "SELF" | "AMMA" | "CREDIT"; paid?: boolean; conv?: { conv: number; waId: string }; lastUserAt?: number } = {}) {
  const p = o.conv ?? (await person({ locale: o.locale, lastUserAt: o.lastUserAt ?? MORNING - 30 * MIN }));
  // Many people at "3 pm" in one test: each a minute apart, so the slots stay unique (the SQL never needs them on the grid).
  const start = Date.parse(slotAt(o.day ?? SESSION_DAY, "15:00", "SESSION").startUtc) + ++linkN * MIN;
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED')").bind(iso(start), iso(start + HOUR), p.conv).run()).meta.last_row_id;
  const origin = o.origin ?? "SELF";
  let pkg: number | null = null;
  if (origin === "CREDIT") {
    pkg = (await h.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(p.conv).run()).meta.last_row_id;
    const pay = (await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'PACKAGE', ?1, ?2, 500000, 'PAID')").bind(pkg, `di-p-${++linkN}`).run()).meta.last_row_id;
    await h.db.prepare("UPDATE packages SET payment_id = ?2 WHERE id = ?1").bind(pkg, pay).run();
  }
  const sid = (
    await h.db
      .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, package_id) VALUES (?1, ?2, 'HEALING', ?3, ?4, ?5)")
      .bind(p.conv, slot, o.state ?? (origin === "CREDIT" ? "CREDIT_BOOKED" : "CONFIRMED"), origin, pkg)
      .run()
  ).meta.last_row_id;
  let pay: number | null = null;
  if (origin !== "CREDIT" && o.paid !== false)
    pay = (await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'SESSION', ?1, ?2, 79900, 'PAID')").bind(sid, `di-s-${++linkN}`).run()).meta.last_row_id;
  return { ...p, sid, pay };
}
const ask = (ms: number) => {
  at(ms);
  return reviewAsks(h.env(), ms);
};
const reviewOn = () => setSetting(h.db, "after.review", "on");

describe("the review and referral ask", () => {
  it("off by default; the owner turns it on", async () => {
    const a = await sessionDone();
    expect(await ask(MORNING)).toBe(0);
    await reviewOn();
    expect(await ask(MORNING)).toBe(1);
    expect(sentTo(a.waId)).toHaveLength(1);
  });

  it("the morning after, from 10 am India time, never the same day, never at night, and once", async () => {
    await reviewOn();
    const a = await sessionDone();
    expect(await ask(Date.parse("2026-11-02T12:00:00Z"))).toBe(0); // the same evening
    expect(await ask(MORNING - 2 * MIN)).toBe(0); // 9:58 am
    expect(await ask(MORNING)).toBe(1);
    expect(await ask(MORNING + 2 * MIN)).toBe(0);
    expect(await ask(MORNING + DAY)).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(1);
    expect(reviewDue(slotAt(SESSION_DAY, "15:00", "SESSION").startUtc, Date.parse("2026-11-03T16:00:00Z"))).toBe(false); // 9:30 pm
    expect(reviewDue(slotAt(SESSION_DAY, "15:00", "SESSION").startUtc, Date.parse("2026-11-04T05:00:00Z"))).toBe(true); // the next day, 10:30 am
    expect(reviewDue(slotAt(SESSION_DAY, "15:00", "SESSION").startUtc, Date.parse("2026-11-06T05:00:00Z"))).toBe(false); // too late
  });

  it("inside the window: thank-you, the review link and the referral link (wa.me, prefilled, the number from config)", async () => {
    await reviewOn();
    const a = await sessionDone();
    await ask(MORNING);
    const link = referralLink();
    expect(link).toBe(`https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=Hi%2C%20I%20was%20referred%20by%20a%20friend`);
    const text = sentTo(a.waId)[0].text.body;
    expect(text).toBe(
      `Thank you for your session with Shantha Rao.\n\nIf the session helped, would you share a short Google review? ${REVIEW_URL}\n\nIf someone you know might benefit, you can share this WhatsApp link: ${link}\n\nWith warm wishes, Disha Dira`,
    );
    expect(text).not.toMatch(/discount|coupon|gift|free/i); // no incentive for a review (Google's policy)
    expect(copyFor("hi").reviewAsk(REVIEW_URL, link)).toContain("Google पर एक छोटा-सा रिव्यू");
  });

  it("no review link set: the review sentence is left out; outside the window it is skipped (the template needs the link)", async () => {
    after.googleReviewUrl = "";
    await reviewOn();
    const a = await sessionDone();
    const b = await sessionDone({ lastUserAt: MORNING - 2 * DAY });
    templates.review_ask.approved = true;
    expect(await ask(MORNING)).toBe(1);
    expect(sentTo(a.waId)[0].text.body).not.toContain("Google");
    expect(sentTo(b.waId)).toHaveLength(0);
    expect((await rows()).find((r: Json) => r.conv === b.conv)).toMatchObject({ state: "SKIPPED", why: "NO_REVIEW_LINK" });
  }, 60_000);

  it("outside the window: the review_ask template with the two links, once approved; skipped and counted before", async () => {
    await reviewOn();
    const a = await sessionDone({ lastUserAt: MORNING - 2 * DAY });
    expect(await ask(MORNING)).toBe(0);
    expect(sentTo(a.waId)).toHaveLength(0);
    expect(await afterCallLines(h.env(), MORNING)).toContain("- Review and referral asks: 0 sent, 1 not sent (the WhatsApp template isn't approved yet)");
    templates.review_ask.approved = true;
    const b = await sessionDone({ lastUserAt: MORNING - 2 * DAY });
    expect(await ask(MORNING + 2 * MIN)).toBe(1);
    expect(sentTo(b.waId)[0].template).toEqual({
      name: "review_ask", language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: REVIEW_URL }, { type: "text", text: referralLink() }] }],
    });
    expect(sentTo(a.waId)).toHaveLength(0); // the skipped one is never tried again
  }, 60_000);

  it("at most once per person in 90 days", async () => {
    await reviewOn();
    const a = await sessionDone();
    expect(await ask(MORNING)).toBe(1);
    await sessionDone({ conv: a, day: "2026-12-02" });
    await wrote(a.conv, Date.parse("2026-12-03T04:00:00Z"));
    expect(await ask(Date.parse("2026-12-03T04:30:00Z"))).toBe(0);
    await sessionDone({ conv: a, day: "2027-02-02" }); // 92 days after the first ask
    await wrote(a.conv, Date.parse("2027-02-03T04:00:00Z"));
    expect(await ask(Date.parse("2027-02-03T04:30:00Z"))).toBe(1);
    expect(sentTo(a.waId)).toHaveLength(2);
  }, 60_000);

  it("a package session counts; the ₹99 call, an unpaid (free) session, a no-show and Not right fit never do", async () => {
    await reviewOn();
    const credit = await sessionDone({ origin: "CREDIT" });
    const free = await sessionDone({ paid: false });
    const noShow = await sessionDone({ state: "NO_SHOW" });
    const notFit = await sessionDone({ state: "NOT_FIT" });
    const call = await person({ lastUserAt: MORNING - 30 * MIN });
    const c = slotAt(SESSION_DAY, "16:00", "CALL");
    const cs = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED')").bind(c.startUtc, c.endUtc, call.conv).run()).meta.last_row_id;
    await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'CALLED_SESSION')").bind(call.conv, cs).run();
    expect(await ask(MORNING)).toBe(1);
    expect(sentTo(credit.waId)).toHaveLength(1);
    for (const x of [free, noShow, notFit, call]) expect(sentTo(x.waId)).toHaveLength(0);
  }, 60_000);

  it("only sessions marked Completed when reviewUnmarked is false", async () => {
    after.reviewUnmarked = false;
    await reviewOn();
    const unmarked = await sessionDone();
    const done = await sessionDone({ state: "COMPLETED" });
    expect(await ask(MORNING)).toBe(1);
    expect(sentTo(done.waId)).toHaveLength(1);
    expect(sentTo(unmarked.waId)).toHaveLength(0);
  }, 60_000);

  it("never after Not right fit, a refund, rudeness, a complaint, a safety message, stop or a block", async () => {
    await reviewOn();
    const db = h.db;
    const cases: [string, (a: Awaited<ReturnType<typeof sessionDone>>) => Promise<unknown>][] = [
      ["not right fit on the call", async (a) => db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_NOT_FIT')").bind(a.conv).run()],
      ["rude on the call", async (a) => db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'RUDE')").bind(a.conv).run()],
      ["not right fit pending (in its undo window)", (a) => db.prepare("INSERT INTO outcomes (session_id, value, tapped_at, undo_until) VALUES (?1, 'NOT_FIT', ?2, ?3)").bind(a.sid, iso(MORNING - 5 * MIN), iso(MORNING + 5 * MIN)).run()],
      ["a refund", (a) => db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state) VALUES (?1, 'ADMIN', 'owner', 'REFUNDED')").bind(a.pay).run()],
      ["asked for a person (a complaint)", (a) => db.prepare("INSERT INTO attention (kind, target, created_at) VALUES ('HUMAN_REQUEST', ?1, ?2)").bind(`conv:${a.conv}`, iso(MORNING - HOUR)).run()],
      ["an open item on the session", (a) => db.prepare("INSERT INTO attention (kind, target) VALUES ('LATE_PAYMENT_NO_SLOT', ?1)").bind(`session:${a.sid}`).run()],
      ["a crisis message last month", (a) => db.prepare("INSERT INTO messages (conversation_id, direction, dedupe_key, kind, status, created_at) VALUES (?1, 'OUT', ?2, 'text', 'SENT', ?3)").bind(a.conv, `wamid.Y${a.conv}:crisis`, iso(MORNING - 30 * DAY)).run()],
      ["said stop", (a) => db.prepare("UPDATE person_state SET opted_out_at = ?2 WHERE conversation_id = ?1").bind(a.conv, iso(MORNING - HOUR)).run()],
      ["blocked", (a) => db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(a.conv).run()],
      ["the team has the chat", (a) => db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(a.conv).run()],
    ];
    const people = [];
    for (const [why, setup] of cases) {
      const a = await sessionDone();
      await setup(a);
      people.push([why, a] as const);
    }
    expect(await ask(MORNING)).toBe(0);
    for (const [why, a] of people) expect(sentTo(a.waId), why).toHaveLength(0);
    // A duplicate payment refunded automatically is not a complaint.
    const dup = await sessionDone();
    const extra = (await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'SESSION', ?1, 'di-dup-1', 79900, 'REFUNDED')").bind(dup.sid).run()).meta.last_row_id;
    await db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state) VALUES (?1, 'DUPLICATE', 'system', 'REFUNDED')").bind(extra).run();
    expect(await ask(MORNING + 2 * MIN)).toBe(1);
    expect(sentTo(dup.waId)).toHaveLength(1);
  }, 120_000);

  it("paused sends, paused bookings and Amma away hold it back", async () => {
    await reviewOn();
    const a = await sessionDone();
    for (const [key, value] of [["NEW_BOOKINGS", "false"], ["AMMA_AWAY", "true"], ["SENDS", "false"]]) {
      await setSetting(h.db, key, value);
      expect(await ask(MORNING), key).toBe(0);
      await h.db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
    }
    expect(await ask(MORNING)).toBe(1);
    expect(sentTo(a.waId)).toHaveLength(1);
  });
});

describe("the owner's switches and the digest", () => {
  const csrfOn = (html: string, action: string, fields: Record<string, string>) => {
    const forms = [...html.matchAll(/<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/g)];
    const f = forms.find((m) => m[1] === action && Object.entries(fields).every(([k, v]) => m[2].includes(`name="${k}" value="${v}"`)));
    return f ? /name="csrf" value="([0-9a-f]+)"/.exec(f[2])?.[1] : undefined;
  };

  it("Settings shows both, with their defaults; the owner switches them, audited; others are refused", async () => {
    const html = await (await h.get("/app/settings")).text();
    expect(html).toContain("After-call reminder");
    expect(html).toContain("Review &amp; referral ask");
    expect(html).toContain("session_reminder");
    const on = csrfOn(html, "/app/settings/after", { name: "review", v: "on" })!;
    expect(on).toBeTruthy();
    for (const who of [PRAC, STAFF]) {
      const res = await h.post("/app/settings/after", { name: "review", v: "on", csrf: await h.tokenFor(who, "settings-after:review:on") }, who);
      expect(res.status).toBe(403);
    }
    expect(await h.setting("after.review")).toBeNull();
    expect((await h.post("/app/settings/after", { name: "review", v: "on", csrf: "0".repeat(64) })).status).toBe(403);
    expect((await h.post("/app/settings/after", { name: "review", v: "on", csrf: on })).status).toBe(303);
    expect(await h.setting("after.review")).toBe("on");
    const off = csrfOn(await (await h.get("/app/settings")).text(), "/app/settings/after", { name: "reminder", v: "off" })!;
    expect((await h.post("/app/settings/after", { name: "reminder", v: "off", csrf: off })).status).toBe(303);
    expect(await h.setting("after.reminder")).toBe("off");
    expect((await h.audits("AFTER_SWITCH")).map((a) => [a.actor, a.target, a.detail])).toEqual([
      [OWNER, "after.review", "on"],
      [OWNER, "after.reminder", "off"],
    ]);
  });

  it("the 9pm digest counts what went in the last 24 hours", async () => {
    templates.session_reminder.approved = true;
    await reviewOn();
    const a = await offered();
    await remind(OFFER + 48 * HOUR);
    const b = await sessionDone({ day: "2026-11-03", lastUserAt: Date.parse("2026-11-04T04:00:00Z") });
    await ask(Date.parse("2026-11-04T04:30:00Z"));
    expect(sentTo(b.waId)).toHaveLength(1);
    const text = await digestText(h.env(), Date.parse("2026-11-04T15:30:00Z"));
    expect(text).toContain("After the call (last 24 hours)\n- Session reminders: 1 sent\n- Review and referral asks: 1 sent");
    expect(await digestText(h.env(), Date.parse("2026-11-06T15:30:00Z"))).toContain("- Session reminders: 0 sent\n- Review and referral asks: 0 sent");
    expect(sentTo(a.waId)).toHaveLength(2);
  }, 60_000);
});
