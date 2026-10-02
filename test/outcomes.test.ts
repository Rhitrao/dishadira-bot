import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { applyDueOutcomes, rescheduleChoice } from "../src/outcomes";
import { cashfree } from "../src/pay/cashfree";
import { retryRefunds } from "../src/pay/refund";
import { sessionChoice } from "../src/session";
import { generateSlots, holdSlot, type Slot } from "../src/slots";
import { addPerson, newDb } from "./db";

// All data is synthetic. Mon 2026-10-05, 11:30 IST. fetch is mocked: real Cashfree and Meta are never called.
const SECRET = "test-cashfree-secret";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const MIN = 60_000;
const call = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "CALL")[i];
const sessionSlot = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "SESSION")[i];

let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let n = 0;
let refundStore: Map<string, { status: string }>;
let refundDown = false; // Cashfree unreachable: the POST throws before anything is stored
let refundLostAnswer = false; // Cashfree stores the refund, but the answer never arrives

const env = (o: Record<string, string> = {}) =>
  ({ DB: db, SENDS: "true", NEW_BOOKINGS: "true", PAYMENT_MODE: "test", CASHFREE_APP_ID: "test-app", CASHFREE_SECRET: SECRET, WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...o }) as never;
const provider = () => cashfree(env());
const at = (ms: number) => vi.setSystemTime(ms);
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const calls = (host: string, method?: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(host) && (!method || (c[1] as { method: string }).method === method));
const waSent = () => calls("graph.facebook.com").map((c) => JSON.parse((c[1] as { body: string }).body));
const refundPosts = () => calls("/refunds", "POST").map((c) => JSON.parse((c[1] as { body: string }).body));
const runCron = (nowMs = Date.now()) => applyDueOutcomes(env(), provider(), nowMs);

beforeEach(async () => {
  ({ db, close } = await newDb());
  refundStore = new Map();
  refundDown = false;
  refundLostAnswer = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: `wamid.OUT${++n}` }] });
    const refund = /\/orders\/([^/]+)\/refunds(?:\/([^/]+))?$/.exec(u);
    if (refund) {
      if (init.method === "POST") {
        if (refundDown) throw new TypeError("network down");
        const b = JSON.parse(init.body!);
        if (refundStore.has(b.refund_id)) return json({ message: "refund_id already exists" }, 400);
        refundStore.set(b.refund_id, { status: "PENDING" });
        if (refundLostAnswer) throw new TypeError("connection reset");
        return json({ cf_refund_id: 900 + refundStore.size, refund_status: "PENDING" });
      }
      const r = refundStore.get(refund[2]);
      return r ? json({ cf_refund_id: 900, refund_id: refund[2], refund_status: r.status }) : json({ message: "not found" }, 404);
    }
    if (u.endsWith("/links") && init.method === "POST") {
      const b = JSON.parse(init.body!);
      return json({ link_id: b.link_id, link_status: "ACTIVE", link_url: `https://payments-test.cashfree.com/links/${b.link_id}` });
    }
    return json({}, 404);
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
    .prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,provider_order_id,amount_paise,state,payer_ref) VALUES ('cashfree','INTRO',?1,?2,?3,9900,'PAID',?4)")
    .bind(i.meta.last_row_id, `di-intro-s${k}`, `order_s${k}`, o.payerRef ?? null)
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

async function sign(raw: string, ts = "1759644000000") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + raw)))));
}
async function hook(body: unknown) {
  const raw = JSON.stringify(body);
  const headers = { "x-webhook-timestamp": "1759644000000", "x-webhook-signature": await sign(raw) };
  return app.request("/pay/cashfree/webhook", { method: "POST", body: raw, headers }, env());
}
const paidEvent = (link: string, paid: string, time = "2026-10-05T12:00:00+05:30") => ({
  type: "PAYMENT_LINK_EVENT",
  event_time: time,
  data: {
    link_id: link, link_status: "PAID", link_currency: "INR", link_amount_paid: paid,
    link_url: `https://payments-test.cashfree.com/links/${link}`, order: { order_id: `order_${link}`, transaction_id: 1 },
  },
});
const refundEvent = (refundId: string, status: string, time: string) => ({
  type: "REFUND_STATUS_WEBHOOK", event_time: time, data: { refund: { refund_id: refundId, refund_status: status, order_id: "x" } },
});

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

  it("SESSION: intro CALLED_SESSION, session OFFERED, a 'Choose a time' button inside the 24h window", async () => {
    const a = await seedPaid();
    await tap(a.introId, "SESSION");
    at(NOW + 11 * MIN);
    await runCron();
    const ses = await db.prepare("SELECT id, state FROM sessions WHERE intro_id = ?1").bind(a.introId).first<{ id: number; state: string }>();
    expect(ses!.state).toBe("OFFERED");
    const msg = waSent()[0];
    expect(msg.interactive.type).toBe("button");
    expect(msg.interactive.action.buttons).toEqual([{ type: "reply", reply: { id: `sess_offer_${ses!.id}`, title: "Choose a time" } }]);
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
    expect(refundPosts()).toEqual([{ refund_id: `refund-${a.payId}`, refund_amount: 99, refund_note: expect.any(String), refund_speed: "STANDARD" }]);
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

describe("₹700 session", () => {
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

  it("choose a time -> list (max 10 rows) -> hold + payment + link expiring with the hold -> paid -> CONFIRMED", async () => {
    const a = await offered();
    await sessionChoice(env(), `sess_offer_${a.sid}`, a.conv, "m1");
    const rows: { id: string; title: string }[] = waSent().find((m) => m.interactive?.type === "list").interactive.action.sections[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows[0].id).toBe(`sess_${a.sid}_${rows[0].id.split("_")[2]}`);

    await sessionChoice(env(), rows[0].id, a.conv, "m2");
    const start = rows[0].id.split("_")[2];
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "HELD" });
    const pay = (await db.prepare("SELECT id, provider_link_id AS link, amount_paise AS amt, state FROM payments WHERE purpose = 'SESSION'").first<{ id: number; link: string; amt: number; state: string }>())!;
    expect(pay).toMatchObject({ amt: 70000, state: "PENDING" });
    const body = JSON.parse((calls("/links", "POST")[0][1] as { body: string }).body);
    expect(body.link_amount).toBe(700);
    expect(body.link_expiry_time).toBe("2026-10-05T11:50:00+05:30"); // now (11:30 IST) + 20-minute hold
    expect(waSent().at(-1).interactive.action.parameters.display_text).toBe("Pay ₹700");

    expect((await hook(paidEvent(pay.link, "700.00"))).status).toBe(200);
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "CONFIRMED" });
    expect(await db.prepare("SELECT state FROM slots WHERE kind = 'SESSION' AND start_utc = ?1").bind(start).first()).toEqual({ state: "BOOKED" });
    const text: string = waSent().at(-1).text.body;
    expect(text).toContain("distance session");
    expect(text).toMatch(/confirmed for \w{3} \d+ \w{3} at \d+:\d\d[ap]m/);
    await hook(paidEvent(pay.link, "700.00", "2026-10-05T12:00:01+05:30")); // replay
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
    await hook(paidEvent(link, "700.00"));
    expect(await db.prepare("SELECT owner_id AS o, state FROM slots WHERE kind = 'SESSION' AND start_utc = ?1").bind(start).first()).toEqual({ o: other, state: "HELD" });
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(a.sid).first()).toEqual({ state: "EXPIRED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.includes("distance session"))).toHaveLength(0);
  });

  it("a second ₹700 payment for the same session is refunded as a duplicate", async () => {
    const a = await offered();
    await sessionChoice(env(), `sess_${a.sid}_${sessionSlot(3).startUtc}`, a.conv, "m1");
    const first = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE purpose = 'SESSION'").first<{ l: string }>())!.l;
    await hook(paidEvent(first, "700.00"));
    await db.prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,amount_paise,state) VALUES ('cashfree','SESSION',?1,'di-session-dup',70000,'PENDING')").bind(a.sid).run();
    await hook(paidEvent("di-session-dup", "700.00", "2026-10-05T12:05:00+05:30"));
    expect(refundPosts()).toEqual([{ refund_id: expect.stringMatching(/^refund-\d+$/), refund_amount: 700, refund_note: expect.any(String), refund_speed: "STANDARD" }]);
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

  it("a crash before Cashfree answers: the retry uses the SAME refund_id and refunds once", async () => {
    refundDown = true;
    const a = await notFitApplied(); // the POST throws: refund stays PENDING
    expect(await db.prepare("SELECT state, provider_refund_id AS id FROM refunds").first()).toEqual({ state: "PENDING", id: null });
    expect(await payState(a.payId)).toBe("REFUND_PENDING");
    refundDown = false;
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    await retryRefunds(env(), provider()); // same minute again: the lease stops it
    const ids = refundPosts().map((b) => b.refund_id);
    expect(ids).toEqual([`refund-${a.payId}`, `refund-${a.payId}`]);
    expect(refundStore.size).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);
    // Cashfree later says SUCCESS: polled, then REFUNDED. Further runs do nothing.
    refundStore.get(`refund-${a.payId}`)!.status = "SUCCESS";
    at(NOW + 17 * MIN);
    await retryRefunds(env(), provider());
    expect(await payState(a.payId)).toBe("REFUNDED");
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "REFUNDED" });
    at(NOW + 20 * MIN);
    await retryRefunds(env(), provider());
    expect(refundPosts()).toHaveLength(2);
  });

  it("a lost answer (Cashfree stored the refund): the retry finds it and never sends a second one", async () => {
    refundLostAnswer = true;
    const a = await notFitApplied();
    expect(refundStore.size).toBe(1);
    refundLostAnswer = false;
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    expect(refundPosts()).toHaveLength(1);
    expect(await db.prepare("SELECT provider_refund_id AS id FROM refunds").first()).toEqual({ id: "900" });
    expect(await payState(a.payId)).toBe("REFUND_PENDING");
  });

  it("FAILED raises attention; payments never move backwards", async () => {
    const a = await notFitApplied();
    refundStore.get(`refund-${a.payId}`)!.status = "REJECTED";
    at(NOW + 14 * MIN);
    await retryRefunds(env(), provider());
    expect(await payState(a.payId)).toBe("REFUND_FAILED");
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'REFUND_FAILED'")).toBe(1);
    // A verified refund webhook says SUCCESS (money did go out): FAILED -> REFUNDED is allowed ...
    expect((await hook(refundEvent(`refund-${a.payId}`, "SUCCESS", "2026-10-05T12:00:00+05:30"))).status).toBe(200);
    expect(await payState(a.payId)).toBe("REFUNDED");
    // ... but a stray later FAILED never moves it back, and a replay does nothing.
    await hook(refundEvent(`refund-${a.payId}`, "REJECTED", "2026-10-05T12:01:00+05:30"));
    await hook(refundEvent(`refund-${a.payId}`, "SUCCESS", "2026-10-05T12:00:00+05:30"));
    expect(await payState(a.payId)).toBe("REFUNDED");
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "REFUNDED" });
  });

  it("the refund webhook is signature-checked", async () => {
    const raw = JSON.stringify(refundEvent("refund-1", "SUCCESS", "2026-10-05T12:00:00+05:30"));
    const res = await app.request("/pay/cashfree/webhook", { method: "POST", body: raw, headers: { "x-webhook-timestamp": "1", "x-webhook-signature": btoa("bad") } }, env());
    expect(res.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
  });
});
