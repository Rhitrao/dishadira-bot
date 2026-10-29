import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { applyDueOutcomes, rescheduleChoice } from "../src/outcomes";
import { razorpay } from "../src/pay/razorpay";
import { retryRefunds } from "../src/pay/refund";
import { sessionChoice } from "../src/session";
import { generateSlots, holdSlot, type Slot } from "../src/slots";
import { addPerson, newDb } from "./db";
import { FakeRazorpay, paidEvent as rzpPaid, refundEvent as rzpRefund, rzpEnv, rzpHeaders } from "./razorpay";

// All data is synthetic. Mon 2026-10-05, 11:30 IST. fetch is mocked: real Razorpay and Meta are never called.
const NOW = Date.parse("2026-10-05T06:00:00Z");
const MIN = 60_000;
const call = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "CALL")[i];
const sessionSlot = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "SESSION")[i];

let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let n = 0;
let fake: FakeRazorpay; // fake.refundDown: Razorpay unreachable; fake.refundLostAnswer: Razorpay stores the refund but the answer never arrives

const env = (o: Record<string, string> = {}) =>
  ({ DB: db, SENDS: "true", NEW_BOOKINGS: "true", ...rzpEnv(), WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...o }) as never;
const provider = () => razorpay(env());
const at = (ms: number) => vi.setSystemTime(ms);
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const calls = (host: string, method?: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(host) && (!method || (c[1] as { method: string }).method === method));
const waSent = () => calls("graph.facebook.com").map((c) => JSON.parse((c[1] as { body: string }).body));
const refundPosts = () => fake.posts("/refund").map((c) => c.body as Record<string, unknown>);
const runCron = (nowMs = Date.now()) => applyDueOutcomes(env(), provider(), nowMs);

beforeEach(async () => {
  ({ db, close } = await newDb());
  fake = new FakeRazorpay();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: `wamid.OUT${++n}` }] });
    return fake.handle(u, init as never) ?? json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

let wa = 919100000000;
async function person(o: { lastUserAt?: string | null } = {}) {
  const id = await addPerson(db, String(++wa));
  const last = o.lastUserAt === undefined ? "2026-10-05T06:00:00Z" : o.lastUserAt;
  await db.prepare("UPDATE conversations SET last_user_at = ?2, display_name = 'Test Person' WHERE id = ?1").bind(id, last).run();
  return id;
}
let linkN = 0;
// A paid ₹99 intro on a BOOKED call slot.
async function seedPaid(slot: Slot = call(0), o: { conv?: number; payerRef?: string; lastUserAt?: string | null } = {}) {
  const conv = o.conv ?? (await person({ lastUserAt: o.lastUserAt }));
  const s = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(slot.startUtc, slot.endUtc, conv).run();
  const i = await db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state) VALUES (?1,?2,'PROTECTION','PAID')").bind(conv, s.meta.last_row_id).run();
  const k = ++linkN;
  const p = await db
    .prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,provider_order_id,amount_paise,state,payer_ref) VALUES ('razorpay','INTRO',?1,?2,?3,9900,'PAID',?4)")
    .bind(i.meta.last_row_id, `di-intro-s${k}`, `pay_s${k}`, o.payerRef ?? null)
    .run();
  return { conv, introId: i.meta.last_row_id, payId: p.meta.last_row_id, slotId: s.meta.last_row_id };
}
// Amma's tap, as the page writes it: undo window of 10 minutes.
async function tap(introId: number, value: string, tappedMs = NOW) {
  const slot = (await db.prepare("SELECT slot_id AS s FROM intros WHERE id = ?1").bind(introId).first<{ s: number }>())!.s;
  const r = await db
    .prepare("INSERT INTO outcomes (intro_id,value,tapped_at,undo_until,slot_id) VALUES (?1,?2,?3,?4,?5)")
    .bind(introId, value, new Date(tappedMs).toISOString().slice(0, 19) + "Z", new Date(tappedMs + 10 * MIN).toISOString().slice(0, 19) + "Z", slot)
    .run();
  return r.meta.last_row_id;
}
const introState = async (id: number) => (await db.prepare("SELECT state, reschedule_count AS rc FROM intros WHERE id = ?1").bind(id).first<{ state: string; rc: number }>())!;
const payState = async (id: number) => (await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(id).first<{ state: string }>())!.state;

async function hook(body: unknown) {
  const raw = JSON.stringify(body);
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env());
}
const rupees = (v: string) => Math.round(Number(v) * 100);
// `time` only makes the body (and so the event id) differ, like a later delivery of the same fact.
const paidEvent = (link: string, paid: string, time = "") => rzpPaid(link, { amount: rupees(paid), paymentId: `pay_${link.replace(/\W/g, "")}`, createdAt: 1759644000 + time.length });
const refundEvent = (refundId: string, status: "processed" | "failed", at = 0) => rzpRefund(refundId, status, "pay_x", 1759644000 + at);

describe("applying outcomes", () => {
  it("nothing happens before undo_until; then it is applied", async () => {
    const a = await seedPaid();
    await tap(a.introId, "SESSION");
    at(NOW + 9 * MIN);
    expect(await runCron()).toBe(0);
    expect((await introState(a.introId)).state).toBe("PAID");
    expect(waSent()).toHaveLength(0);
    at(NOW + 10 * MIN);
    expect(await runCron()).toBe(1);
    expect((await introState(a.introId)).state).toBe("CALLED_SESSION");
  });

  it("is applied exactly once, even when the cron runs twice or at the same time", async () => {
    const a = await seedPaid();
    await tap(a.introId, "NOT_FIT");
    at(NOW + 11 * MIN);
    const results = await Promise.all([runCron(), runCron()]);
    await runCron();
    expect(results.reduce((x, y) => x + y, 0)).toBe(1);
    expect(refundPosts()).toHaveLength(1);
    expect(waSent()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'OUTCOME_APPLIED'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outcomes WHERE applied_at IS NOT NULL")).toBe(1);
  });

  it("an undone outcome is never applied", async () => {
    const a = await seedPaid();
    const o = await tap(a.introId, "NOT_FIT");
    await db.prepare("DELETE FROM outcomes WHERE id = ?1").bind(o).run();
    at(NOW + 11 * MIN);
    expect(await runCron()).toBe(0);
    expect(refundPosts()).toHaveLength(0);
  });

  it("SESSION: intro CALLED_SESSION, session OFFERED, the options list (single, 10, 20) inside the 24h window", async () => {
    const a = await seedPaid();
    await tap(a.introId, "SESSION");
    at(NOW + 11 * MIN);
    await runCron();
    const ses = await db.prepare("SELECT id, state FROM sessions WHERE intro_id = ?1").bind(a.introId).first<{ id: number; state: string }>();
    expect(ses!.state).toBe("OFFERED");
    const msg = waSent()[0];
    expect(msg.interactive.type).toBe("list"); // single session, 10 or 20
    expect(msg.interactive.action.sections.flatMap((s: { rows: { id: string }[] }) => s.rows.map((r) => r.id))).toEqual([`sess_offer_${ses!.id}`, "go_p10", "go_p20"]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'OUTCOME_APPLIED' AND target = 'intro:" + a.introId + "'")).toBe(1);
  });

  it("SESSION outside the 24h window needs the session_offer template: unapproved -> nothing sent, attention", async () => {
    const a = await seedPaid(call(0), { lastUserAt: "2026-10-01T06:00:00Z" });
    await tap(a.introId, "SESSION");
    at(NOW + 11 * MIN);
    await runCron();
    expect(waSent()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(1);
  });
});

describe("NOT_FIT refunds", () => {
  it("refunds the ₹99 once with the kind message", async () => {
    const a = await seedPaid();
    await tap(a.introId, "NOT_FIT");
    at(NOW + 11 * MIN);
    await runCron();
    expect((await introState(a.introId)).state).toBe("CALLED_NOT_FIT");
    expect(refundPosts()).toEqual([{ amount: 9900, speed: "normal", receipt: `refund-${a.payId}`, notes: { refund_id: `refund-${a.payId}`, reason: expect.any(String) } }]);
    expect(await payState(a.payId)).toBe("REFUND_PENDING");
    expect(waSent()[0].text.body).toBe("Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ₹99.");
  });

  it("a second refund for the same person (same wa_id) is refused: no refund, no message, attention", async () => {
    const a = await seedPaid(call(0));
    await tap(a.introId, "NOT_FIT");
    at(NOW + 11 * MIN);
    await runCron();
    const b = await seedPaid(call(1), { conv: a.conv });
    await tap(b.introId, "NOT_FIT", Date.now());
    at(NOW + 22 * MIN);
    await runCron();
    expect(refundPosts()).toHaveLength(1);
    expect(await payState(b.payId)).toBe("PAID");
    expect(waSent()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'NOT_FIT_REFUND_REFUSED'")).toBe(1);
  });

  it("the same payer UPI handle under another number is refused too", async () => {
    const a = await seedPaid(call(0), { payerRef: "payer@upi.test" });
    const b = await seedPaid(call(1), { payerRef: "payer@upi.test" });
    await tap(a.introId, "NOT_FIT");
    await tap(b.introId, "NOT_FIT");
    at(NOW + 11 * MIN);
    await runCron();
    expect(refundPosts()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'NOT_FIT_REFUND_REFUSED'")).toBe(1);
  });

  it("at most notFitRefundsPerDay per day; the cap resets the next day", async () => {
    const cap = config.limits.notFitRefundsPerDay;
    const people = [];
    for (let i = 0; i < cap + 1; i++) {
      const p = await seedPaid(call(i));
      await tap(p.introId, "NOT_FIT");
      people.push(p);
    }
    at(NOW + 11 * MIN);
    await runCron();
    expect(refundPosts()).toHaveLength(cap);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'NOT_FIT_REFUND_REFUSED'")).toBe(1);
    expect(await payState(people[cap].payId)).toBe("PAID");
    // Next day (Tue 6 Oct, 11:30 IST): the refused call is tapped again by a new person.
    const next = await seedPaid(call(0, "2026-10-06"));
    at(NOW + 24 * 60 * MIN);
    await tap(next.introId, "NOT_FIT", Date.now());
    at(Date.now() + 11 * MIN);
    await runCron();
    expect(await payState(next.payId)).toBe("REFUND_PENDING");
  });
});

describe("MISSED", () => {
  it("offers new call times; picking one reschedules with no payment; a second miss closes with no refund", async () => {
    const a = await seedPaid(call(0));
    await tap(a.introId, "MISSED");
    at(NOW + 11 * MIN);
    await runCron();
    expect(await introState(a.introId)).toMatchObject({ state: "MISSED", rc: 0 });
    const list = waSent()[0].interactive;
    expect(list.type).toBe("list");
    const rows: { id: string }[] = list.action.sections[0].rows;
    expect(rows.length).toBeLessThanOrEqual(10);
    const payments = await count("SELECT COUNT(*) AS n FROM payments");

    const pick = rows[0].id;
    expect(await rescheduleChoice(env(), pick, a.conv, "pick1")).toBe(true);
    expect(await rescheduleChoice(env(), pick, a.conv, "pick1-again")).toBe(true); // a second tap changes nothing
    expect(await introState(a.introId)).toMatchObject({ state: "RESCHEDULED", rc: 1 });
    const startUtc = pick.split("_")[2];
    expect(await db.prepare("SELECT s.start_utc AS t, s.state FROM intros i JOIN slots s ON s.id = i.slot_id WHERE i.id = ?1").bind(a.introId).first()).toEqual({ t: startUtc, state: "BOOKED" });
    expect(await count("SELECT COUNT(*) AS n FROM payments")).toBe(payments); // free: no new payment
    expect(await db.prepare("SELECT state FROM slots WHERE id = ?1").bind(a.slotId).first()).toEqual({ state: "HELD" }); // old time freed (expired hold)
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED' AND owner_id = " + a.conv)).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.includes("nothing more to pay"))).toHaveLength(1);

    // The rescheduled call is missed too: closed, no refund, one polite message, no new list.
    await tap(a.introId, "MISSED", Date.now());
    at(Date.now() + 11 * MIN);
    await runCron();
    expect(await introState(a.introId)).toMatchObject({ state: "MISSED", rc: 1 });
    expect(await payState(a.payId)).toBe("PAID");
    expect(refundPosts()).toHaveLength(0);
    expect(waSent().filter((m) => m.interactive?.type === "list")).toHaveLength(1);
    expect(waSent().at(-1).text.body).toContain("closing this booking");
    // ...and it cannot be rescheduled again.
    await rescheduleChoice(env(), rows[1].id, a.conv, "pick2");
    expect(await introState(a.introId)).toMatchObject({ state: "MISSED", rc: 1 });
  });
});

describe("RUDE", () => {
  it("blocks the conversation, sends nothing, and the refund waits for approval", async () => {
    const a = await seedPaid();
    await tap(a.introId, "RUDE");
    at(NOW + 11 * MIN);
    await runCron();
    expect(await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(a.conv).first()).toEqual({ mode: "BLOCKED" });
    expect(await count("SELECT COUNT(*) AS n FROM blocks WHERE reason = 'RUDE'")).toBe(1);
    expect((await introState(a.introId)).state).toBe("RUDE");
    expect(await db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(a.payId).first()).toEqual({ state: "PENDING_APPROVAL" });
    expect(await payState(a.payId)).toBe("PAID");
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'RUDE_REFUND_APPROVAL'")).toBe(1);
    expect(waSent()).toHaveLength(0);
    expect(refundPosts()).toHaveLength(0);
    // The retry cron does not send an unapproved refund.
    at(NOW + 30 * MIN);
    await retryRefunds(env(), provider());
    expect(refundPosts()).toHaveLength(0);
  });
});

describe("₹799 session", () => {
  async function offered(o: { intro?: string; callIdx?: number } = {}) {
    const a = await seedPaid(call(o.callIdx ?? 0));
    await db.prepare("UPDATE intros SET state = ?2 WHERE id = ?1").bind(a.introId, o.intro ?? "CALLED_SESSION").run();
    const s = await db.prepare("INSERT INTO sessions (conversation_id,intro_id,service) VALUES (?1,?2,'PROTECTION')").bind(a.conv, a.introId).run();
    return { ...a, sid: s.meta.last_row_id };
  }

  it("is only offered after CALLED_SESSION", async () => {
    const early = await offered({ intro: "PAID", callIdx: 5 });
    await sessionChoice(env(), `sess_offer_${early.sid}`, early.conv, "m1");
    expect(waSent().filter((m) => m.interactive?.type === "list")).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'SESSION_NOT_OFFERABLE'")).toBe(1);
    await sessionChoice(env(), `sess_${early.sid}_${sessionSlot(3).startUtc}`, early.conv, "m2");
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION'")).toBe(0);
    // Someone else cannot use another person's offer.
    const ok = await offered({ callIdx: 6 });
    const other = await person();
    await sessionChoice(env(), `sess_offer_${ok.sid}`, other, "m3");
    expect(waSent().filter((m) => m.interactive?.type === "list")).toHaveLength(0);
  });

  it("choose a time -> days -> times (max 10 rows) -> hold + payment + link expiring with the hold -> paid -> CONFIRMED", async () => {
    const a = await offered();
    await sessionChoice(env(), `sess_offer_${a.sid}`, a.conv, "m1");
    // The day step is one list of up to 6 days (ticket 30).
    const days: { id: string }[] = waSent().find((m) => m.interactive?.type === "list").interactive.action.sections.flatMap((x: { rows: never[] }) => x.rows);
    expect(days.length).toBeGreaterThan(0);
    expect(days.length).toBeLessThanOrEqual(6);
    expect(days[0].id).toMatch(new RegExp(`^sday_${a.sid}_\\d{4}-\\d{2}-\\d{2}$`));
    await sessionChoice(env(), days[0].id, a.conv, "m1b");
    const rows: { id: string; title: string }[] = waSent().filter((m) => m.interactive?.type === "list").at(-1).interactive.action.sections.flatMap((x: { rows: never[] }) => x.rows);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.at(-1)!.id).toBe(`smore_${a.sid}`); // "Another day"
    expect(rows[0].id).toBe(`sess_${a.sid}_${rows[0].id.split("_")[2]}`);

    await sessionChoice(env(), rows[0].id, a.conv, "m2");
    const start = rows[0].id.split("_")[2];
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "HELD" });
    const pay = (await db.prepare("SELECT id, provider_link_id AS link, amount_paise AS amt, state FROM payments WHERE purpose = 'SESSION'").first<{ id: number; link: string; amt: number; state: string }>())!;
    expect(pay).toMatchObject({ amt: 79900, state: "PENDING" });
    const body = fake.posts("/payment_links")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ amount: 79900, accept_partial: false, reference_id: pay.link });
    expect(body.expire_by).toBe(Date.parse("2026-10-05T06:20:00Z") / 1000); // now (11:30 IST) + 20-minute hold
    expect(waSent().at(-1).interactive.action.parameters.display_text).toBe("Pay ₹799");

    expect((await hook(paidEvent(pay.link, "799.00"))).status).toBe(200);
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "CONFIRMED" });
    expect(await db.prepare("SELECT state FROM slots WHERE kind = 'SESSION' AND start_utc = ?1").bind(start).first()).toEqual({ state: "BOOKED" });
    const text: string = waSent().at(-1).text.body;
    expect(text).toContain("distance session");
    expect(text).toMatch(/confirmed for \w{3}, \d+ \w{3} at \d+:\d\d [ap]m/);
    await hook(paidEvent(pay.link, "799.00", "2026-10-05T12:00:01+05:30")); // replay
    expect(waSent().filter((m) => m.text?.body?.includes("distance session"))).toHaveLength(1);
  });

  it("a wrong amount is a mismatch: nothing is booked", async () => {
    const a = await offered();
    await sessionChoice(env(), `sess_${a.sid}_${sessionSlot(3).startUtc}`, a.conv, "m1");
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE purpose = 'SESSION'").first<{ l: string }>())!.l;
    await hook(paidEvent(link, "99.00"));
    expect(await db.prepare("SELECT state FROM payments WHERE purpose = 'SESSION'").first()).toEqual({ state: "UNKNOWN" });
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "HELD" });
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION' AND state = 'BOOKED'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(1);
  });

  it("a late payment never steals a slot someone else now holds", async () => {
    const a = await offered();
    const start = sessionSlot(2).startUtc;
    await sessionChoice(env(), `sess_${a.sid}_${start}`, a.conv, "m1");
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE purpose = 'SESSION'").first<{ l: string }>())!.l;
    at(NOW + 21 * MIN); // hold lapsed
    const other = await person();
    expect((await holdSlot(db, { kind: "SESSION", startUtc: start, ownerId: other, nowMs: Date.now() })).ok).toBe(true);
    await hook(paidEvent(link, "799.00"));
    expect(await db.prepare("SELECT owner_id AS o, state FROM slots WHERE kind = 'SESSION' AND start_utc = ?1").bind(start).first()).toEqual({ o: other, state: "HELD" });
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "EXPIRED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.includes("distance session"))).toHaveLength(0);
  });

  it("a second ₹799 payment for the same session is refunded as a duplicate", async () => {
    const a = await offered();
    await sessionChoice(env(), `sess_${a.sid}_${sessionSlot(3).startUtc}`, a.conv, "m1");
    const first = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE purpose = 'SESSION'").first<{ l: string }>())!.l;
    await hook(paidEvent(first, "799.00"));
    await db.prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,amount_paise,state) VALUES ('razorpay','SESSION',?1,'di-session-dup',79900,'PENDING')").bind(a.sid).run();
    await hook(paidEvent("di-session-dup", "799.00", "2026-10-05T12:05:00+05:30"));
    expect(refundPosts()).toEqual([{ amount: 79900, speed: "normal", receipt: expect.stringMatching(/^refund-\d+$/), notes: { refund_id: expect.stringMatching(/^refund-\d+$/), reason: expect.any(String) } }]);
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "CONFIRMED" });
  });
});

describe("refund safety", () => {
  async function notFitApplied() {
    const a = await seedPaid();
    await tap(a.introId, "NOT_FIT");
    at(NOW + 11 * MIN);
    await runCron();
    return a;
  }

  it("a crash before Razorpay answers: the retry uses the SAME refund_id and refunds once", async () => {
    fake.refundDown = true;
    const a = await notFitApplied(); // the POST throws: refund stays PENDING
    expect(await db.prepare("SELECT state, provider_refund_id AS id FROM refunds").first()).toEqual({ state: "PENDING", id: null });
    expect(await payState(a.payId)).toBe("REFUND_PENDING");
    fake.refundDown = false;
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    await retryRefunds(env(), provider()); // same minute again: the lease stops it
    const ids = refundPosts().map((b) => b.receipt);
    expect(ids).toEqual([`refund-${a.payId}`, `refund-${a.payId}`]);
    expect(fake.refunds).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);
    // Razorpay later says processed: polled, then REFUNDED. Further runs do nothing.
    fake.refunds[0].status = "processed";
    at(NOW + 17 * MIN);
    await retryRefunds(env(), provider());
    expect(await payState(a.payId)).toBe("REFUNDED");
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "REFUNDED" });
    at(NOW + 20 * MIN);
    await retryRefunds(env(), provider());
    expect(refundPosts()).toHaveLength(2);
  });

  it("a lost answer (Razorpay stored the refund): the retry finds it and never sends a second one", async () => {
    fake.refundLostAnswer = true;
    const a = await notFitApplied();
    expect(fake.refunds).toHaveLength(1);
    fake.refundLostAnswer = false;
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    expect(refundPosts()).toHaveLength(1);
    expect(await db.prepare("SELECT provider_refund_id AS id FROM refunds").first()).toEqual({ id: fake.refunds[0].id });
    expect(await payState(a.payId)).toBe("REFUND_PENDING");
  });

  it("FAILED raises attention; payments never move backwards", async () => {
    const a = await notFitApplied();
    fake.refunds[0].status = "failed";
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    expect(await payState(a.payId)).toBe("REFUND_FAILED");
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'REFUND_FAILED'")).toBe(1);
    // A verified refund webhook says SUCCESS (money did go out): FAILED -> REFUNDED is allowed ...
    expect((await hook(refundEvent(`refund-${a.payId}`, "processed"))).status).toBe(200);
    expect(await payState(a.payId)).toBe("REFUNDED");
    // ... but a stray later FAILED never moves it back, and a replay does nothing.
    await hook(refundEvent(`refund-${a.payId}`, "failed", 60));
    await hook(refundEvent(`refund-${a.payId}`, "processed")); // replay of the first one
    expect(await payState(a.payId)).toBe("REFUNDED");
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "REFUNDED" });
  });

  it("the refund webhook is signature-checked", async () => {
    const raw = JSON.stringify(refundEvent("refund-1", "processed"));
    const res = await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw, { secret: "wrong" }) }, env());
    expect(res.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
  });
});
