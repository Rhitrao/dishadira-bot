import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { bookingChoice } from "../src/booking";
import { config } from "../src/config";
import { cashfree } from "../src/pay/cashfree";
import { reconcile } from "../src/pay/apply";
import { generateSlots, holdSlot } from "../src/slots";
import { addPerson, newDb } from "./db";

// All data is synthetic. Mon 2026-10-05, 11:30 IST. fetch is mocked: real Cashfree and Meta are never called.
const SECRET = "test-cashfree-secret";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const call = (i: number) => generateSlots("2026-10-05", "CALL")[i];
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let live = false;
let refundFails = false;
let n = 0;

const env = () =>
  ({
    DB: db, SENDS: "true", NEW_BOOKINGS: "true", PAYMENT_MODE: live ? "live" : "test",
    CASHFREE_APP_ID: "test-app", CASHFREE_SECRET: SECRET, WA_TOKEN: "tok", WA_PHONE_ID: "1000",
  }) as never;
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const calls = (host: string, method?: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(host) && (!method || (c[1] as { method: string }).method === method));
const waSent = () => calls("graph.facebook.com").map((c) => JSON.parse((c[1] as { body: string }).body));
const cfBody = (i = 0) => JSON.parse((calls("cashfree.com/pg/links", "POST")[i][1] as { body: string }).body);

beforeEach(async () => {
  ({ db, close } = await newDb());
  live = false;
  refundFails = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: `wamid.OUT${++n}` }] });
    if (u.endsWith("/links") && init.method === "POST") {
      const b = JSON.parse(init.body!);
      return json({ link_id: b.link_id, link_status: "ACTIVE", link_url: `https://payments-test.cashfree.com/links/${b.link_id}` });
    }
    if (u.includes("/orders?")) return json([{ order_id: "order_1", order_status: "PAID" }]);
    if (/\/links\/[^/]+$/.test(u)) return json({ link_status: "PAID", link_currency: "INR", link_amount_paid: "99.00", link_url: "https://payments-test.cashfree.com/links/x" });
    if (u.includes("/refunds")) return refundFails ? json({ message: "no" }, 400) : json({ cf_refund_id: 555, refund_status: "PENDING" });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

async function person(wa: string) {
  const id = await addPerson(db, wa);
  await db.prepare("UPDATE conversations SET last_user_at = '2026-10-05T06:00:00Z' WHERE id = ?1").bind(id).run();
  return id;
}
const tap = (conv: number, choice: string, msg = `m${++n}`) => bookingChoice(env(), choice, conv, msg);
const book = async (conv: number, i = 0) => {
  await tap(conv, `slot_PROTECTION_${call(i).startUtc}`);
  return (await db.prepare("SELECT provider_link_id AS link, id, target_id FROM payments ORDER BY id DESC LIMIT 1").first<{ link: string; id: number; target_id: number }>())!;
};

async function sign(raw: string, ts = "1759644000000", secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + raw)));
  return btoa(String.fromCharCode(...mac));
}
const linkEvent = (link: string, o: { status?: string; paid?: string; cur?: string; order?: string | null; time?: string; url?: string } = {}) => ({
  type: "PAYMENT_LINK_EVENT",
  version: 1,
  event_time: o.time ?? "2026-10-05T11:40:00+05:30",
  data: {
    link_id: link,
    link_status: o.status ?? "PAID",
    link_currency: o.cur ?? "INR",
    link_amount: "99.00",
    link_amount_paid: o.paid ?? "99.00",
    link_url: o.url ?? `https://payments-test.cashfree.com/links/${link}`,
    order: o.order === null ? null : { order_id: o.order ?? `order_${link}`, transaction_id: 1021206 },
  },
});
async function hook(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const headers = { "x-webhook-timestamp": "1759644000000", "x-webhook-signature": await sign(raw, "1759644000000", secret) };
  return app.request("/pay/cashfree/webhook", { method: "POST", body: raw, headers }, env());
}

describe("config", () => {
  it("the hold is at least the provider's minimum link expiry", () => {
    expect(config.holdMinutes).toBeGreaterThanOrEqual(config.cashfree.minLinkExpiryMinutes);
  });
});

describe("cashfree provider", () => {
  const args = { linkId: "di-intro-1", amountPaise: 9900, purpose: "x", customerName: "Test", customerPhone: "9999999999", expiresAtUtc: "2026-10-05T06:20:00Z" };
  it("creates a link against the sandbox, or production when live", async () => {
    const link = await cashfree(env()).createLink(args);
    expect(link.url).toContain("di-intro-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox.cashfree.com/pg/links");
    expect(init.headers["x-api-version"]).toBe(config.cashfree.apiVersion);
    expect(JSON.parse(init.body)).toMatchObject({ link_amount: 99, link_currency: "INR", link_partial_payments: false, link_expiry_time: "2026-10-05T11:50:00+05:30" });
    live = true;
    await cashfree(env()).createLink(args);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.cashfree.com/pg/links");
  });
  it("verifies signature before parsing", async () => {
    const raw = JSON.stringify(linkEvent("L1"));
    const ok = await cashfree(env()).verifyWebhook(raw, new Headers({ "x-webhook-timestamp": "1", "x-webhook-signature": await sign(raw, "1") }));
    expect(ok).toMatchObject({ ok: true, event: { linkId: "L1", status: "PAID", paidPaise: 9900, orderId: "order_L1", mode: "test" } });
    const bad = await cashfree(env()).verifyWebhook(raw, new Headers({ "x-webhook-timestamp": "2", "x-webhook-signature": await sign(raw, "1") }));
    expect(bad).toEqual({ ok: false, reason: "SIGNATURE" });
    expect(await cashfree(env()).verifyWebhook("not json", new Headers())).toEqual({ ok: false, reason: "SIGNATURE" });
  });
});

describe("bot flow", () => {
  it("menu -> service buttons -> slot list (max 10, IST labels) -> pay button", async () => {
    const c = await person("test-a");
    await tap(c, "menu_book");
    expect(waSent()[0].interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(["svc_PROTECTION", "svc_HEALING"]);
    await tap(c, "svc_PROTECTION");
    const rows = waSent()[1].interactive.action.sections[0].rows;
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ id: `slot_PROTECTION_${call(0).startUtc}`, title: "Mon 5 Oct, 2:00pm" });

    const pay = await book(c, 1);
    const slot = await db.prepare("SELECT state, hold_until FROM slots").first<{ state: string; hold_until: string }>();
    expect(slot?.state).toBe("HELD");
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "HELD" });
    expect(await db.prepare("SELECT state, amount_paise, purpose FROM payments").first()).toEqual({ state: "PENDING", amount_paise: 9900, purpose: "INTRO" });
    expect(pay.link).toBe(`di-intro-${pay.target_id}`);
    // Expiry equals the hold (20 min after 11:30 IST) and partial payments are off.
    expect(cfBody().link_expiry_time).toBe("2026-10-05T11:50:00+05:30");
    expect(slot?.hold_until).toBe("2026-10-05T06:20:00Z");
    expect(cfBody().link_partial_payments).toBe(false);
    const cta = waSent().at(-1).interactive;
    expect(cta.type).toBe("cta_url");
    expect(cta.action.parameters.display_text).toBe("Pay ₹99");
    expect(cta.body.text).toContain("20 minutes");
    expect(cta.body.text).toContain("don't pay twice");
  });

  it("the booking switch off keeps booking closed", async () => {
    const c = await person("test-a");
    await bookingChoice({ ...(env() as object), NEW_BOOKINGS: "false" } as never, "menu_book", c, "m-off");
    expect(waSent()[0].text.body).toBe("Booking opens soon.");
  });

  it("a blocked contact gets no hold, no intro, no link", async () => {
    const c = await person("test-blocked");
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES ('test-blocked', 'test', 'test')").run();
    await tap(c, `slot_PROTECTION_${call(0).startUtc}`);
    expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
    expect(calls("cashfree.com")).toHaveLength(0);
  });

  it("a taken slot sends the list again, and a failed link frees the hold", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    await book(a);
    await tap(b, `slot_PROTECTION_${call(0).startUtc}`);
    expect(waSent().some((m) => m.text?.body?.includes("just taken"))).toBe(true);
    // Link creation fails for b on another slot: payment FAILED, intro EXPIRED, slot free again.
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    await tap(b, `slot_PROTECTION_${call(3).startUtc}`);
    expect(await db.prepare("SELECT state FROM payments ORDER BY id DESC").first()).toEqual({ state: "FAILED" });
    expect((await holdSlot(db, { kind: "CALL", startUtc: call(3).startUtc, ownerId: b, nowMs: NOW })).ok).toBe(true); // hold was released
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LINK_CREATE_FAILED'")).toBe(1);
  });
});

describe("webhook", () => {
  it("bad signature -> 401 and nothing stored", async () => {
    const c = await person("test-a");
    const p = await book(c);
    const res = await hook(linkEvent(p.link), "wrong-secret");
    expect(res.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PENDING" });
  });

  it("verified paid event books the slot and confirms once, even when replayed", async () => {
    const c = await person("test-a");
    const p = await book(c);
    expect((await hook(linkEvent(p.link))).status).toBe(200);
    expect((await hook(linkEvent(p.link))).status).toBe(200); // replay
    expect(await db.prepare("SELECT state, provider_order_id AS o FROM payments").first()).toEqual({ state: "PAID", o: `order_${p.link}` });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state, hold_until FROM slots").first()).toEqual({ state: "BOOKED", hold_until: null });
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(1);
    const texts = waSent().map((m) => m.text?.body).filter(Boolean);
    expect(texts.filter((t) => t.startsWith("Received your ₹99"))).toEqual([
      `Received your ₹99. Shantha Rao will call you on Mon 5 Oct at 2:00pm from ${config.businessNumber}. That number is for her calls only, so please message us here.`,
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
  });

  it("wrong amount or currency is not PAID and raises attention", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(linkEvent(p.link, { paid: "50.00" }));
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "UNKNOWN" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "HELD" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(1);

    const c2 = await person("test-b");
    const p2 = await book(c2, 2);
    await hook(linkEvent(p2.link, { cur: "USD" }));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p2.id).first()).toEqual({ state: "UNKNOWN" });
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
    // A live-mode event on a test-mode Worker is also refused.
    const c3 = await person("test-c");
    const p3 = await book(c3, 4);
    await hook(linkEvent(p3.link, { url: "https://payments.cashfree.com/links/x" }));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p3.id).first()).toEqual({ state: "UNKNOWN" });
  });

  it("a second payment for an intro that is already PAID is refunded automatically", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(linkEvent(p.link));
    // A second link/payment row for the same intro (e.g. a re-created link) also gets paid.
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('cashfree','INTRO',?1,'di-intro-dup',9900,'PENDING')").bind(p.target_id).run();
    await hook(linkEvent("di-intro-dup", { order: "order_dup" }));
    await hook(linkEvent("di-intro-dup", { order: "order_dup" })); // replay
    expect(await db.prepare("SELECT reason, requested_by, provider_refund_id AS r FROM refunds").all()).toMatchObject({ results: [{ reason: "DUPLICATE", requested_by: "system", r: "555" }] });
    expect(calls("/refunds")).toHaveLength(1);
    expect(JSON.parse((calls("/refunds")[0][1] as { body: string }).body)).toMatchObject({ refund_id: "refund-2", refund_amount: 99 });
    expect(String(calls("/refunds")[0][0])).toContain("/orders/order_dup/refunds");
    expect(await db.prepare("SELECT state FROM payments WHERE provider_link_id = 'di-intro-dup'").first()).toEqual({ state: "REFUND_PENDING" });
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'DUPLICATE_PAYMENT'")).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
  });

  it("a failed refund is recorded and raises attention", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(linkEvent(p.link));
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('cashfree','INTRO',?1,'di-intro-dup',9900,'PENDING')").bind(p.target_id).run();
    refundFails = true;
    await hook(linkEvent("di-intro-dup", { order: "order_dup" }));
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM payments WHERE provider_link_id = 'di-intro-dup'").first()).toEqual({ state: "REFUND_FAILED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'REFUND_FAILED'")).toBe(1);
  });

  it("late payment: books the slot if it is still free", async () => {
    const c = await person("test-a");
    const p = await book(c);
    vi.setSystemTime(NOW + 30 * 60_000); // hold expired 10 minutes ago
    await hook(linkEvent(p.link));
    expect(await db.prepare("SELECT state FROM slots").first()).toEqual({ state: "BOOKED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("late payment: never takes another person's slot, raises attention instead", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    const p = await book(a);
    vi.setSystemTime(NOW + 30 * 60_000);
    expect((await holdSlot(db, { kind: "CALL", startUtc: call(0).startUtc, ownerId: b, nowMs: Date.now() })).ok).toBe(true);
    await hook(linkEvent(p.link));
    expect(await db.prepare("SELECT owner_id, state FROM slots").first()).toEqual({ owner_id: b, state: "HELD" });
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "PAID" }); // money was received
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
    expect(waSent().some((m) => m.text?.body?.startsWith("Received your"))).toBe(false);
  });

  it("late payment: an overlapping session hold by someone else also blocks the booking", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    const p = await book(a, 1); // 14:15 call
    vi.setSystemTime(NOW + 30 * 60_000);
    expect((await holdSlot(db, { kind: "SESSION", startUtc: generateSlots("2026-10-05", "SESSION")[0].startUtc, ownerId: b, nowMs: Date.now() })).ok).toBe(true);
    await hook(linkEvent(p.link));
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
  });

  it("expired or cancelled link: payment FAILED, intro EXPIRED, hold freed; a later success supersedes", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    const p = await book(a);
    await hook(linkEvent(p.link, { status: "EXPIRED", order: null, paid: "0.00" }));
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
    expect((await holdSlot(db, { kind: "CALL", startUtc: call(0).startUtc, ownerId: b, nowMs: NOW })).ok).toBe(true); // freed at once
    // Someone else now holds the slot, so a late success for the first person cannot book it.
    await hook(linkEvent(p.link));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
  });

  it("an expired event never downgrades a PAID payment", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(linkEvent(p.link));
    await hook(linkEvent(p.link, { status: "EXPIRED", order: null, time: "later" }));
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state FROM slots").first()).toEqual({ state: "BOOKED" });
  });
});

describe("reconciliation cron", () => {
  it("only reads payments PENDING for more than 2 minutes, then applies the paid status", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await reconcile(env(), cashfree(env()), NOW + 60_000); // 1 minute: too fresh
    expect(calls("/links/di-intro", "GET")).toHaveLength(0);
    await reconcile(env(), cashfree(env()), NOW + 3 * 60_000);
    expect(await db.prepare("SELECT state, provider_order_id AS o FROM payments").first()).toEqual({ state: "PAID", o: "order_1" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state FROM slots").first()).toEqual({ state: "BOOKED" });
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
    // A second run finds nothing PENDING.
    const reads = calls("/links/di-intro", "GET").length;
    await reconcile(env(), cashfree(env()), NOW + 6 * 60_000);
    expect(calls("/links/di-intro", "GET").length).toBe(reads);
    expect(p.link).toBeTruthy();
  });

  it("webhook and cron racing on the same payment apply once", async () => {
    const c = await person("test-a");
    const p = await book(c);
    vi.setSystemTime(NOW + 3 * 60_000);
    await Promise.all([hook(linkEvent(p.link, { order: "order_1" })), reconcile(env(), cashfree(env()), Date.now())]);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(1);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PAID" });
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("an expired link seen by the cron frees the hold", async () => {
    const c = await person("test-a");
    await book(c);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/links/") ? new Response(JSON.stringify({ link_status: "EXPIRED", link_currency: "INR", link_amount_paid: "0" }), { status: 200 }) : new Response("{}"),
    );
    await reconcile(env(), cashfree(env()), NOW + 3 * 60_000);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
  });
});
