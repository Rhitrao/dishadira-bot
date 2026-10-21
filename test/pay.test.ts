import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { bookingChoice } from "../src/booking";
import { config } from "../src/config";
import { razorpay } from "../src/pay/razorpay";
import { reconcile } from "../src/pay/apply";
import { generateSlots, holdSlot } from "../src/slots";
import { addPerson, newDb } from "./db";
import { FakeRazorpay, LIVE_KEY_ID, TEST_KEY_ID, closedEvent, paidEvent, refundEvent, rzpEnv, rzpHeaders } from "./razorpay";

// All data is synthetic. Mon 2026-10-05, 11:30 IST. fetch is mocked: real Razorpay and Meta are never called.
const NOW = Date.parse("2026-10-05T06:00:00Z");
const call = (i: number) => generateSlots("2026-10-05", "CALL")[i];
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let live = false;
let fake: FakeRazorpay;
let n = 0;

const env = () =>
  ({
    DB: db, SENDS: "true", NEW_BOOKINGS: "true", ...rzpEnv(live), WA_TOKEN: "tok", WA_PHONE_ID: "1000",
  }) as never;
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const calls = (host: string, method?: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(host) && (!method || (c[1] as { method: string }).method === method));
const waSent = () => calls("graph.facebook.com").map((c) => JSON.parse((c[1] as { body: string }).body));
const linkBody = (i = 0) => fake.posts("/payment_links")[i].body as Record<string, unknown>;
const reads = () => fake.log.filter((c) => c.method === "GET" && c.url.startsWith("/v1/payment_links")).length;

beforeEach(async () => {
  ({ db, close } = await newDb());
  live = false;
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

async function hook(body: unknown, o: { secret?: string; eventId?: string | null } = {}) {
  const raw = JSON.stringify(body);
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw, o) }, env());
}
const payId = (link: string) => `pay_${link.replace(/\W/g, "")}`; // the fake payment id for a link

const EXPIRE_20 = Date.parse("2026-10-05T06:20:00Z") / 1000; // the hold: 20 minutes after 11:30 IST

describe("config", () => {
  it("the hold is at least the provider's minimum link expiry (Razorpay: expire_by at least 15 minutes ahead)", () => {
    expect(config.razorpay.minLinkExpiryMinutes).toBe(15);
    expect(config.holdMinutes).toBeGreaterThanOrEqual(config.razorpay.minLinkExpiryMinutes);
  });
});

describe("razorpay provider", () => {
  const args = { linkId: "di-intro-1", amountPaise: 9900, purpose: "Disha Dira call booking", customerName: "Test", customerPhone: "9999999999", expiresAtUtc: "2026-10-05T06:20:00Z" };

  it("creates a link: paise, expire_by, our id as reference_id, customer, and no Razorpay notifications", async () => {
    const link = await razorpay(env()).createLink(args);
    expect(link).toEqual({ linkId: "di-intro-1", url: "https://rzp.io/i/di-intro-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/payment_links");
    expect(init.headers.Authorization).toBe("Basic " + btoa(`${TEST_KEY_ID}:test-razorpay-key-secret`));
    expect(JSON.parse(init.body)).toEqual({
      amount: 9900,
      currency: "INR",
      accept_partial: false,
      reference_id: "di-intro-1",
      description: "Disha Dira call booking",
      customer: { name: "Test", contact: "9999999999" },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: EXPIRE_20,
      notes: { link_id: "di-intro-1" },
    });
  });

  it("works with a live key when PAYMENT_MODE is live", async () => {
    live = true;
    await razorpay(env()).createLink(args);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Basic " + btoa(`${LIVE_KEY_ID}:test-razorpay-key-secret`));
  });

  it("refuses to create a link when the key prefix does not match PAYMENT_MODE, or is not a Razorpay key", async () => {
    const e = env() as Record<string, string>;
    await expect(razorpay({ ...e, PAYMENT_MODE: "live" } as never).createLink(args)).rejects.toThrow("PAYMENT_MODE"); // test key, live Worker
    await expect(razorpay({ ...e, RAZORPAY_KEY_ID: LIVE_KEY_ID } as never).createLink(args)).rejects.toThrow("PAYMENT_MODE"); // live key, test Worker
    await expect(razorpay({ ...e, RAZORPAY_KEY_ID: "" } as never).createLink(args)).rejects.toThrow("PAYMENT_MODE");
    await expect(razorpay({ ...e, RAZORPAY_KEY_ID: "key_abc" } as never).createLink(args)).rejects.toThrow("PAYMENT_MODE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a key/mode mismatch through the bot: no link, no hold, attention for Rohit", async () => {
    live = true;
    const c = await person("test-a");
    await bookingChoice({ ...(env() as object), RAZORPAY_KEY_ID: TEST_KEY_ID } as never, `slot_PROTECTION_${call(0).startUtc}`, c, "m-mismatch");
    expect(fake.log).toHaveLength(0);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "FAILED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LINK_CREATE_FAILED'")).toBe(1);
  });

  it("verifies the signature before parsing, in constant time on the raw body", async () => {
    const raw = JSON.stringify(paidEvent("L1"));
    const p = razorpay(env());
    const good = await p.verifyWebhook(raw, new Headers(await rzpHeaders(raw, { eventId: "evt_1" })));
    expect(good).toEqual({ ok: true, event: { key: "evt_1", linkId: "L1", status: "PAID", paidPaise: 9900, currency: "INR", orderId: "pay_L1" } });
    const sig = (await rzpHeaders(raw)) ["X-Razorpay-Signature"];
    const bad = [
      new Headers(await rzpHeaders(raw, { secret: "wrong" })), // wrong secret
      new Headers({ "x-razorpay-event-id": "e" }), // no signature
      new Headers({ "X-Razorpay-Signature": sig.slice(0, 63) }), // wrong length
      new Headers({ "X-Razorpay-Signature": "z".repeat(64) }), // not hex
      new Headers({ "X-Razorpay-Signature": btoa("x") }), // base64, but Razorpay signs with hex
    ];
    for (const h of bad) expect(await p.verifyWebhook(raw, h)).toEqual({ ok: false, reason: "SIGNATURE" });
    // A changed body fails even with a once-valid signature; a missing webhook secret fails closed.
    expect(await p.verifyWebhook(raw + " ", new Headers(await rzpHeaders(raw)))).toEqual({ ok: false, reason: "SIGNATURE" });
    expect(await razorpay({ ...(env() as object), RAZORPAY_WEBHOOK_SECRET: "" } as never).verifyWebhook(raw, new Headers(await rzpHeaders(raw)))).toEqual({ ok: false, reason: "SIGNATURE" });
    // Signed but not JSON: PAYLOAD (so the signature really is checked first). Unsigned non-JSON is just a bad signature.
    expect(await p.verifyWebhook("not json", new Headers(await rzpHeaders("not json")))).toEqual({ ok: false, reason: "PAYLOAD" });
    expect(await p.verifyWebhook("not json", new Headers())).toEqual({ ok: false, reason: "SIGNATURE" });
  });

  it("reads the five events; any other signed event is ignored; a missing event id falls back to the body", async () => {
    const p = razorpay(env());
    const read = async (body: unknown, eventId?: string | null) => {
      const raw = JSON.stringify(body);
      return p.verifyWebhook(raw, new Headers(await rzpHeaders(raw, { eventId })));
    };
    expect(await read(closedEvent("L1", "expired"))).toMatchObject({ ok: true, event: { linkId: "L1", status: "EXPIRED", paidPaise: 0 } });
    expect(await read(closedEvent("L1", "cancelled"))).toMatchObject({ ok: true, event: { linkId: "L1", status: "CANCELLED" } });
    expect(await read(refundEvent("refund-7", "processed"))).toMatchObject({ ok: true, refund: { refundId: "refund-7", status: "SUCCESS" } });
    expect(await read(refundEvent("refund-7", "failed"))).toMatchObject({ ok: true, refund: { refundId: "refund-7", status: "FAILED" } });
    expect(await read({ event: "payment_link.partially_paid", payload: {} })).toEqual({ ok: true, ignored: true });
    expect(await read({ event: "payment.captured", payload: {} })).toEqual({ ok: true, ignored: true });
    expect(await read({ event: "payment_link.paid", payload: { payment_link: {} } })).toEqual({ ok: false, reason: "PAYLOAD" });
    const a = await read(paidEvent("L1"), null);
    const b = await read(paidEvent("L1"), null);
    expect(a).toMatchObject({ ok: true, event: { key: expect.stringMatching(/^body:[0-9a-f]{64}$/) } });
    expect(a).toEqual(b); // same body, same key: a replay is still a replay
  });

  it("a refund event without our receipt falls back to notes.refund_id, then to Razorpay's own id", async () => {
    const p = razorpay(env());
    const viaNotes = { ...refundEvent("refund-9", "processed") };
    (viaNotes.payload.refund.entity as { receipt: string | null }).receipt = null;
    const raw = JSON.stringify(viaNotes);
    expect(await p.verifyWebhook(raw, new Headers(await rzpHeaders(raw)))).toMatchObject({ ok: true, refund: { refundId: "refund-9" } });
    const raw2 = JSON.stringify(refundEvent(null, "processed")); // a refund Rohit made in the Razorpay dashboard
    expect(await p.verifyWebhook(raw2, new Headers(await rzpHeaders(raw2)))).toMatchObject({ ok: true, refund: { refundId: "rfnd_FAKEW" } });
  });

  it("getStatus finds the link by OUR id, maps its state, and returns the payment id as orderId", async () => {
    const p = razorpay(env());
    await p.createLink(args);
    expect(await p.getStatus("di-intro-1")).toEqual({ linkId: "di-intro-1", status: "ACTIVE", paidPaise: 0, currency: "INR", orderId: undefined, mode: "test" });
    expect(fake.log.at(-1)!.url).toBe("/v1/payment_links?reference_id=di-intro-1");
    fake.markPaid("di-intro-1", { paymentId: "pay_ABC" });
    expect(await p.getStatus("di-intro-1")).toMatchObject({ status: "PAID", paidPaise: 9900, currency: "INR", orderId: "pay_ABC" });
    for (const [razor, ours] of [["expired", "EXPIRED"], ["cancelled", "CANCELLED"], ["partially_paid", "PARTIALLY_PAID"], ["something_new", "UNKNOWN"]] as const) {
      fake.setStatus("di-intro-1", razor);
      expect((await p.getStatus("di-intro-1")).status).toBe(ours);
    }
    expect((await p.getStatus("di-intro-nope")).status).toBe("UNKNOWN");
  });

  it("refunds on the payment id with our refund id as receipt, in paise; a repeat returns the same refund and never makes a second", async () => {
    const p = razorpay(env());
    const first = await p.refund({ orderId: "pay_ABC", amountPaise: 9900, refundId: "refund-5", note: "Refund from Disha Dira" });
    expect(first).toEqual({ providerRefundId: expect.stringMatching(/^rfnd_/), status: "PENDING" });
    expect(fake.posts("/refund")[0]).toMatchObject({ url: "/v1/payments/pay_ABC/refund", body: { amount: 9900, speed: "normal", receipt: "refund-5", notes: { refund_id: "refund-5" } } });
    const again = await p.refund({ orderId: "pay_ABC", amountPaise: 9900, refundId: "refund-5", note: "Refund from Disha Dira" }); // Razorpay: 400 duplicate receipt
    expect(again).toEqual(first);
    expect(fake.refunds).toHaveLength(1);
    expect(await p.getRefund("pay_ABC", "refund-5")).toEqual(first);
    expect(await p.getRefund("pay_ABC", "refund-6")).toEqual({ status: "NOT_FOUND" });
    expect(await p.getRefund("pay_OTHER", "refund-5")).toEqual({ status: "NOT_FOUND" });
    fake.refunds[0].status = "processed";
    expect(await p.getRefund("pay_ABC", "refund-5")).toMatchObject({ status: "SUCCESS" });
    fake.refunds[0].status = "failed";
    expect(await p.getRefund("pay_ABC", "refund-5")).toMatchObject({ status: "FAILED" });
  });

  it("any other refund error is thrown, so the caller leaves it PENDING", async () => {
    fake.failRefundWith = { status: 400, description: "The payment has been fully refunded already" };
    await expect(razorpay(env()).refund({ orderId: "pay_ABC", amountPaise: 9900, refundId: "refund-5", note: "x" })).rejects.toThrow("400");
  });
});

describe("bot flow", () => {
  it("menu -> service -> who for -> day -> times (max 10, IST labels) -> pay button", async () => {
    const c = await person("test-a");
    const ids = (m: { interactive: { action: { buttons: { reply: { id: string } }[] } } }) => m.interactive.action.buttons.map((b) => b.reply.id);
    await tap(c, "menu_book");
    expect(ids(waSent()[0])).toEqual(["svc_HEALING", "svc_PROTECTION"]);
    await tap(c, "svc_PROTECTION");
    expect(ids(waSent()[1])).toEqual(["who_PROTECTION_SELF", "who_PROTECTION_FAMILY", "who_PROTECTION_PET"]);
    await tap(c, "who_PROTECTION_FAMILY");
    expect(ids(waSent()[2])).toEqual(["day_PROTECTION_FAMILY_2026-10-05", "day_PROTECTION_FAMILY_2026-10-06", "day_PROTECTION_FAMILY_2026-10-07"]);
    expect(waSent()[2].interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title)).toEqual(["Mon, 5 Oct", "Tue, 6 Oct", "Wed, 7 Oct"]);
    await tap(c, "day_PROTECTION_FAMILY_2026-10-05");
    const rows = waSent()[3].interactive.action.sections.flatMap((x: { rows: unknown[] }) => x.rows);
    expect(rows).toHaveLength(10); // 9 times + "Another day"
    expect(rows[0]).toEqual({ id: `time_PROTECTION_FAMILY_${call(0).startUtc}`, title: "2:00 pm", description: "15-min call" });
    expect(rows.at(-1)).toEqual({ id: "more_PROTECTION_FAMILY", title: "Another day" });
    await tap(c, rows[1].id); // 2:30 pm, the second half hour
    expect(await db.prepare("SELECT service, for_whom, call_lang FROM intros").first()).toEqual({ service: "PROTECTION", for_whom: "FAMILY", call_lang: "en" });
    expect(waSent().at(-1).interactive.body.text).toBe("Mon, 5 Oct at 2:30 pm is held for you for 20 minutes. Tap below to pay ₹99 and confirm. Please don't pay twice.");
  });

  it("the hold, the payment row and a link that expires with the hold", async () => {
    const c = await person("test-a");
    const pay = await book(c, 1); // a legacy list row still books directly
    const slot = await db.prepare("SELECT state, hold_until FROM slots").first<{ state: string; hold_until: string }>();
    expect(slot?.state).toBe("HELD");
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "HELD" });
    expect(await db.prepare("SELECT state, amount_paise, purpose, provider FROM payments").first()).toEqual({ state: "PENDING", amount_paise: 9900, purpose: "INTRO", provider: "razorpay" });
    expect(pay.link).toBe(`di-intro-${pay.target_id}`);
    // Expiry equals the hold (20 min after 11:30 IST), partial payments are off, and our id travels as reference_id (max 40 chars).
    expect(linkBody().expire_by).toBe(EXPIRE_20);
    expect(slot?.hold_until).toBe("2026-10-05T06:20:00Z");
    expect(linkBody()).toMatchObject({ amount: 9900, accept_partial: false, reference_id: pay.link, notify: { sms: false, email: false } });
    expect(pay.link.length).toBeLessThanOrEqual(40);
    const cta = waSent().at(-1).interactive;
    expect(cta.type).toBe("cta_url");
    expect(cta.action.parameters.url).toBe(`https://rzp.io/i/${pay.link}`);
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
    expect(calls("razorpay.com")).toHaveLength(0);
  });

  it("a taken slot sends the list again, and a failed link frees the hold", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    await book(a);
    await tap(b, `slot_PROTECTION_${call(0).startUtc}`);
    expect(waSent().some((m) => m.text?.body?.includes("just taken"))).toBe(true);
    // Link creation fails for b on another slot: payment FAILED, intro EXPIRED, slot free again.
    fake.failLinkCreateOnce = true;
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
    const res = await hook(paidEvent(p.link), { secret: "wrong-secret" });
    expect(res.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PENDING" });
  });

  it("signed events we do not act on are acknowledged (200) and stored as nothing", async () => {
    expect((await hook({ event: "payment.captured", payload: {} })).status).toBe(200);
    expect((await hook({ event: "refund.created", payload: {} })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
  });

  it("a supported event with a broken shape is a 400, and an unknown link raises attention", async () => {
    expect((await hook({ event: "payment_link.paid", payload: { payment_link: {} } })).status).toBe(400);
    expect((await hook(paidEvent("di-intro-unknown"))).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'UNKNOWN_PAYMENT_LINK'")).toBe(1);
  });

  it("verified paid event books the slot and confirms once, even when replayed", async () => {
    const c = await person("test-a");
    const p = await book(c);
    expect((await hook(paidEvent(p.link))).status).toBe(200);
    expect((await hook(paidEvent(p.link))).status).toBe(200); // replay: same x-razorpay-event-id
    expect(await db.prepare("SELECT state, provider_order_id AS o, provider_payment_id AS pid FROM payments").first()).toEqual({ state: "PAID", o: payId(p.link), pid: payId(p.link) });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state, hold_until FROM slots").first()).toEqual({ state: "BOOKED", hold_until: null });
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE provider = 'razorpay'")).toBe(1);
    const texts = waSent().map((m) => m.text?.body).filter(Boolean);
    expect(texts.filter((t) => t.startsWith("Received your ₹99"))).toEqual([
      `Received your ₹99. Shantha Rao will call you on Mon, 5 Oct at 2:00 pm from ${config.businessNumber}. Call in English. That number is for her calls only, so please message us here.`,
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
  });

  it("a replay with a different body but the same event id is still a replay", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(paidEvent(p.link), { eventId: "evt_same" });
    await hook(paidEvent(p.link, { createdAt: 1759649999 }), { eventId: "evt_same" });
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
  });

  it("wrong amount or currency is not PAID and raises attention", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(paidEvent(p.link, { amount: 9900, paid: 5000 }));
    expect(await db.prepare("SELECT state, paid_paise FROM payments").first()).toEqual({ state: "UNKNOWN", paid_paise: 5000 });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "HELD" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(1);

    const c2 = await person("test-b");
    const p2 = await book(c2, 2);
    await hook(paidEvent(p2.link, { currency: "USD" }));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p2.id).first()).toEqual({ state: "UNKNOWN" });
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
  });

  it("a payment seen by a Worker whose key says live while PAYMENT_MODE says test is refused", async () => {
    const c = await person("test-a");
    const p = await book(c);
    fake.markPaid(p.link, { paymentId: "pay_1" });
    vi.setSystemTime(NOW + 3 * 60_000);
    await reconcile({ ...(env() as object), RAZORPAY_KEY_ID: LIVE_KEY_ID } as never, razorpay({ ...(env() as object), RAZORPAY_KEY_ID: LIVE_KEY_ID } as never), Date.now());
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "UNKNOWN" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
  });

  it("a second payment for an intro that is already PAID is refunded automatically", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(paidEvent(p.link));
    // A second link/payment row for the same intro (e.g. a re-created link) also gets paid.
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay','INTRO',?1,'di-intro-dup',9900,'PENDING')").bind(p.target_id).run();
    await hook(paidEvent("di-intro-dup", { paymentId: "pay_dup" }));
    await hook(paidEvent("di-intro-dup", { paymentId: "pay_dup" })); // replay
    expect(await db.prepare("SELECT reason, requested_by, provider_refund_id AS r FROM refunds").all()).toMatchObject({ results: [{ reason: "DUPLICATE", requested_by: "system", r: expect.stringMatching(/^rfnd_/) }] });
    expect(fake.posts("/refund")).toHaveLength(1);
    expect(fake.posts("/refund")[0]).toMatchObject({ url: "/v1/payments/pay_dup/refund", body: { receipt: "refund-2", amount: 9900, notes: { refund_id: "refund-2" } } });
    expect(await db.prepare("SELECT state FROM payments WHERE provider_link_id = 'di-intro-dup'").first()).toEqual({ state: "REFUND_PENDING" });
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'DUPLICATE_PAYMENT'")).toBe(1);
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
  });

  it("a refund Razorpay reports as failed is FAILED and raises attention; a transport error just stays PENDING for the retry", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(paidEvent(p.link));
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay','INTRO',?1,'di-intro-dup',9900,'PENDING')").bind(p.target_id).run();
    fake.refundStatusOnCreate = "failed";
    await hook(paidEvent("di-intro-dup", { paymentId: "pay_dup" }));
    expect(await db.prepare("SELECT state FROM refunds").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM payments WHERE provider_link_id = 'di-intro-dup'").first()).toEqual({ state: "REFUND_FAILED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'REFUND_FAILED'")).toBe(1);
  });

  it("late payment: books the slot if it is still free", async () => {
    const c = await person("test-a");
    const p = await book(c);
    vi.setSystemTime(NOW + 30 * 60_000); // hold expired 10 minutes ago
    await hook(paidEvent(p.link));
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
    await hook(paidEvent(p.link));
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
    await hook(paidEvent(p.link));
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
  });

  it("expired or cancelled link: payment FAILED, intro EXPIRED, hold freed; a later success supersedes", async () => {
    const a = await person("test-a");
    const b = await person("test-b");
    const p = await book(a);
    await hook(closedEvent(p.link, "expired"));
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
    expect((await holdSlot(db, { kind: "CALL", startUtc: call(0).startUtc, ownerId: b, nowMs: NOW })).ok).toBe(true); // freed at once
    // Someone else now holds the slot, so a late success for the first person cannot book it.
    await hook(paidEvent(p.link));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LATE_PAYMENT_NO_SLOT'")).toBe(1);
  });

  it("a cancelled link frees the hold the same way", async () => {
    const a = await person("test-a");
    const p = await book(a);
    expect((await hook(closedEvent(p.link, "cancelled"))).status).toBe(200);
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p.id).first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
  });

  it("out-of-order events: expired arriving after paid changes nothing; paid arriving after expired still wins", async () => {
    const c = await person("test-a");
    const p = await book(c);
    await hook(paidEvent(p.link));
    await hook(closedEvent(p.link, "expired", 1759650000));
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state FROM slots").first()).toEqual({ state: "BOOKED" });

    const c2 = await person("test-b");
    const p2 = await book(c2, 2);
    await hook(closedEvent(p2.link, "expired")); // delivered first although it happened later
    await hook(paidEvent(p2.link));
    expect(await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(p2.id).first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state FROM intros WHERE id = ?1").bind(p2.target_id).first()).toEqual({ state: "PAID" });
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(2);
  });
});

describe("reconciliation cron", () => {
  it("only reads payments PENDING for more than 2 minutes, then applies the paid status", async () => {
    const c = await person("test-a");
    const p = await book(c);
    fake.markPaid(p.link, { paymentId: "pay_1" });
    await reconcile(env(), razorpay(env()), NOW + 60_000); // 1 minute: too fresh
    expect(reads()).toBe(0);
    await reconcile(env(), razorpay(env()), NOW + 3 * 60_000);
    expect(await db.prepare("SELECT state, provider_order_id AS o FROM payments").first()).toEqual({ state: "PAID", o: "pay_1" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "PAID" });
    expect(await db.prepare("SELECT state FROM slots").first()).toEqual({ state: "BOOKED" });
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
    // A second run finds nothing PENDING.
    const before = reads();
    await reconcile(env(), razorpay(env()), NOW + 6 * 60_000);
    expect(reads()).toBe(before);
  });

  it("webhook and cron racing on the same payment apply once", async () => {
    const c = await person("test-a");
    const p = await book(c);
    fake.markPaid(p.link, { paymentId: "pay_1" });
    vi.setSystemTime(NOW + 3 * 60_000);
    await Promise.all([hook(paidEvent(p.link, { paymentId: "pay_1" })), reconcile(env(), razorpay(env()), Date.now())]);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(1);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "PAID" });
    expect(waSent().filter((m) => m.text?.body?.startsWith("Received your")).length).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });

  it("an expired link seen by the cron frees the hold", async () => {
    const c = await person("test-a");
    const p = await book(c);
    fake.setStatus(p.link, "expired");
    await reconcile(env(), razorpay(env()), NOW + 3 * 60_000);
    expect(await db.prepare("SELECT state FROM payments").first()).toEqual({ state: "FAILED" });
    expect(await db.prepare("SELECT state FROM intros").first()).toEqual({ state: "EXPIRED" });
  });
});
