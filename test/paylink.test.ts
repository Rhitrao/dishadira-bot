/// <reference types="vite/client" />
// Ticket 29: our own payment link (/p/<token>) instead of Razorpay's, the page behind it, and the reminder before a hold ends.
// All data is synthetic; Meta and Razorpay are fakes (test/wa.ts, test/razorpay.ts). Mon 2026-10-05, 11:30 IST.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { allCopy } from "../src/copy";
import { config } from "../src/config";
import { generateSlots } from "../src/slots";
import { setSetting } from "../src/switches";
import { nudgeUnpaidHolds, PAYLINK_CSP, payToken, safeEqual, tokenPaymentId } from "../src/paylink";
import { NOW, Wa, type Json } from "./wa";

const source = (import.meta.glob("../src/paylink.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../src/paylink.ts"];
const t = new Wa();
const PUBLIC = "https://bot.example.test";
const call = (i: number, ymd = "2026-10-05") => generateSlots(ymd, "CALL")[i];
const WA_ME = `https://wa.me/${config.businessNumber.replace(/\D/g, "")}`;
const MIN = 60_000;

beforeEach(() => t.start());
afterEach(() => t.stop());

const open = (path: string, env: unknown = t.env()) => app.request(path, {}, env as never);
const newestPayment = async () => (await t.db.prepare("SELECT id, state, provider_link_id AS ref, purpose FROM payments ORDER BY id DESC LIMIT 1").first<Json>())!;
const stored = async (id: number) => JSON.parse((await t.db.prepare("SELECT value FROM settings WHERE key = ?1").bind(`paylink:${id}`).first<{ value: string }>())!.value);
const linkOf = async (id: number) => `${PUBLIC}/p/${await payToken(t.env(), id)}`;

// A greeted person (18+) holding the 2:30 pm call today: the pay message has gone out.
async function heldCall(lang: "en" | "hi" = "en", i = 2) {
  const from = await t.greeted(lang);
  await t.ageOk(from);
  await t.tapRow(from, `slot_PROTECTION_${call(i).startUtc}`);
  return { from, pay: await newestPayment() };
}

describe("the token", () => {
  it("is <payment id>-<16 hex>, and only the right one opens its payment", async () => {
    const { pay } = await heldCall();
    const token = (await payToken(t.env(), pay.id))!;
    expect(token).toMatch(new RegExp(`^${pay.id}-[0-9a-f]{16}$`));
    expect(await tokenPaymentId(t.env(), token)).toBe(pay.id);
    // tampered: one hex digit changed, a cut or longer mac, another payment's id with this mac, a leading zero, junk
    const mac = token.split("-")[1];
    const flipped = `${pay.id}-${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
    for (const bad of [flipped, `${pay.id}-${mac.slice(1)}`, `${pay.id}-${mac}0`, `${pay.id + 1}-${mac}`, `0${pay.id}-${mac}`, "x", "", `${pay.id}-${mac.toUpperCase()}`]) {
      expect(await tokenPaymentId(t.env(), bad), bad).toBeNull();
    }
    // a key that isn't ours makes a different token
    expect(await payToken({ RAZORPAY_KEY_SECRET: "another-key" }, pay.id)).not.toBe(token);
  });

  it("is checked with a constant-time compare", () => {
    expect(safeEqual("0123456789abcdef", "0123456789abcdef")).toBe(true);
    expect(safeEqual("0123456789abcdef", "0123456789abcdee")).toBe(false);
    expect(safeEqual("0123456789abcdef", "0123456789abcde")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(source).toMatch(/safeEqual\(m\[2\], await mac\(/); // the mac is never compared with === or startsWith
  });

  it("a tampered, unknown or other payment's token is a friendly 404 in both languages", async () => {
    const { pay } = await heldCall();
    const mac = (await payToken(t.env(), pay.id))!.split("-")[1];
    const other = (await payToken(t.env(), pay.id + 5))!; // a real mac, but no such payment
    for (const path of [`/p/${pay.id}-0000000000000000`, `/p/${pay.id + 1}-${mac}`, `/p/${other}`, "/p/nonsense"]) {
      const res = await open(path);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body).toContain(allCopy.en.pageNotFoundTitle);
      expect(body).toContain(allCopy.hi.pageNotFoundTitle);
      expect(body).not.toContain("rzp.io");
    }
  });
});

describe("GET /p/:token", () => {
  // Ticket 31: a tiny "Opening Razorpay's secure payment page…" page that moves on by meta refresh (a bare 302 showed a black screen on a phone).
  const opensRazorpay = async (res: Response, ref: string) => {
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<meta http-equiv="refresh" content="0;url=https://rzp.io/i/${ref}">`);
    expect(body).toContain(`href="https://rzp.io/i/${ref}"`);
    expect(body).toContain(allCopy.en.pageOpeningTitle.replace(/'/g, "&#39;"));
  };
  it("pending and inside the hold: the short page on to the stored Razorpay link, no-store, and no Razorpay call", async () => {
    const { pay } = await heldCall();
    const calls = t.fake.log.length;
    const res = await open(`/p/${await payToken(t.env(), pay.id)}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe(PAYLINK_CSP);
    await opensRazorpay(res, pay.ref);
    expect(t.fake.log.length).toBe(calls);
    // a CREATING payment (the link is made, the row not yet moved on) goes on too
    await t.db.prepare("UPDATE payments SET state = 'CREATING' WHERE id = ?1").bind(pay.id).run();
    await opensRazorpay(await open(`/p/${await payToken(t.env(), pay.id)}`), pay.ref);
  });

  it("paid (or refunded): a page that says so, so nobody pays twice", async () => {
    const { pay } = await heldCall();
    for (const state of ["PAID", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED"]) {
      await t.db.prepare("UPDATE payments SET state = ?2 WHERE id = ?1").bind(pay.id, state).run();
      const res = await open(`/p/${await payToken(t.env(), pay.id)}`);
      expect(res.status, state).toBe(200);
      const body = await res.text();
      expect(body).toContain(allCopy.en.pagePaidTitle);
      expect(body).toContain("Your booking is confirmed; the details are in WhatsApp. You can close this page.");
      expect(body).not.toContain("rzp.io");
    }
  });

  it("past the hold, or failed: the expired page with a button to WhatsApp (unknown: 'we're checking it', ticket 31)", async () => {
    const { pay } = await heldCall();
    const path = `/p/${await payToken(t.env(), pay.id)}`;
    const expired = async () => {
      const res = await open(path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("This payment link has expired");
      expect(body).toContain("Your time is no longer held. Go back to WhatsApp and tap Book again.");
      expect(body).toContain(`href="${WA_ME}"`);
      expect(body).not.toContain("rzp.io");
    };
    vi.setSystemTime(NOW + 20 * MIN); // the hold ends at 11:50 am
    await expired();
    vi.setSystemTime(NOW);
    for (const value of ["null", "not json", '{"url":"https://rzp.io/x"}']) {
      await t.db.prepare("UPDATE settings SET value = ?2 WHERE key = ?1").bind(`paylink:${pay.id}`, value).run();
      await expired(); // an unreadable or incomplete row never redirects and never errors
    }
    await t.db.prepare("UPDATE payments SET state = 'FAILED' WHERE id = ?1").bind(pay.id).run();
    await expired();
    await t.db.prepare("UPDATE payments SET state = 'UNKNOWN' WHERE id = ?1").bind(pay.id).run();
    const unknown = await (await open(path)).text();
    expect(unknown).toContain(allCopy.en.pageCheckTitle.replace(/'/g, "&#39;"));
    expect(unknown).not.toContain("This payment link has expired");
  });

  it("a Hindi chat gets the Hindi page", async () => {
    const { pay } = await heldCall("hi");
    vi.setSystemTime(NOW + 30 * MIN);
    const res = await open(`/p/${await payToken(t.env(), pay.id)}`);
    const body = await res.text();
    expect(body).toContain('<html lang="hi">');
    expect(body).toContain(allCopy.hi.pageExpiredTitle);
    expect(body).toContain(allCopy.hi.pageExpiredBody.replace(/"/g, "&quot;"));
    expect(body).toContain(allCopy.hi.pageBtnWhatsApp);
    expect(body).not.toContain(allCopy.en.pageExpiredTitle);
  });

  it("the page: noindex, a strict CSP with no scripts, readable text and one button", async () => {
    const { pay } = await heldCall();
    await t.db.prepare("UPDATE payments SET state = 'PAID' WHERE id = ?1").bind(pay.id).run();
    const res = await open(`/p/${await payToken(t.env(), pay.id)}`);
    expect(res.headers.get("Content-Security-Policy")).toBe(PAYLINK_CSP);
    expect(PAYLINK_CSP).toContain("default-src 'none'");
    expect(PAYLINK_CSP).not.toContain("script");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).not.toContain("<script");
    expect(body).toContain("font:18px/");
    expect(body.match(/class="btn"/g)).toHaveLength(1);
  });

  it("is public: no Access sign-in, no console flag needed", async () => {
    const { pay } = await heldCall();
    const env = { ...(t.env() as object), CONSOLE_V2: "false", ACCESS_AUD: "", ACCESS_TEAM: "" };
    expect((await open(`/p/${await payToken(t.env(), pay.id)}`, env)).status).toBe(200);
  });

  it("if the database does not answer, a try-again page (never an error)", async () => {
    const { pay } = await heldCall();
    const broken = { ...(t.env() as object), DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("down"); } }) }) } };
    const res = await open(`/p/${await payToken(t.env(), pay.id)}`, broken);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(allCopy.en.pageErrorTitle);
  });
});

describe("the three pay messages carry our link", () => {
  const checkCta = async (id: number) => {
    const cta = t.last().interactive;
    expect(cta.type).toBe("cta_url");
    expect(cta.action.parameters.url.startsWith(`${PUBLIC}/p/`)).toBe(true);
    expect(cta.action.parameters.url).toBe(await linkOf(id));
    expect(cta.body.text).toContain(`If the button does not open, use this link: ${cta.action.parameters.url}`);
    expect(cta.body.text).not.toContain("rzp.io");
    return cta;
  };

  it("the ₹99 call", async () => {
    const { pay } = await heldCall();
    const cta = await checkCta(pay.id);
    expect(cta.action.parameters.display_text).toBe("Pay ₹99");
    expect(cta.body.text).toContain("held for you until 11:50 am (India time)");
    expect(await stored(pay.id)).toEqual({ url: `https://rzp.io/i/${pay.ref}`, until: "2026-10-05T06:20:00Z" });
  });

  it("a single session", async () => {
    const from = await t.greeted("en");
    await t.ageOk(from);
    await t.tapRow(from, "pk_single");
    await t.tap(from, "gate_s");
    await t.tap(from, "ssv_HEALING");
    await t.tap(from, "swh_HEALING_SELF");
    await t.tap(from, "sdy_HEALING_SELF_2026-10-06");
    await t.tapRow(from, `stm_HEALING_SELF_${generateSlots("2026-10-06", "SESSION")[0].startUtc}`);
    const pay = await newestPayment();
    expect(pay.purpose).toBe("SESSION");
    const cta = await checkCta(pay.id);
    expect(cta.action.parameters.display_text).toBe("Pay ₹799");
    expect(cta.body.text).toContain("held for your session until 11:50 am (India time)");
    expect((await stored(pay.id)).url).toBe(`https://rzp.io/i/${pay.ref}`);
  });

  it("a package", async () => {
    const from = await t.greeted("en");
    await t.ageOk(from);
    await t.tapRow(from, "pk_p10");
    await t.tap(from, "gate_p10");
    const pay = await newestPayment();
    expect(pay.purpose).toBe("PACKAGE");
    const cta = await checkCta(pay.id);
    expect(cta.action.parameters.display_text).toBe("Pay ₹5,000");
    expect(cta.body.text).toContain("The link is open until 12:30 pm (India time)");
    expect(await stored(pay.id)).toEqual({ url: `https://rzp.io/i/${pay.ref}`, until: "2026-10-05T07:00:00Z" });
    // a paid package's page talks about the package
    await t.db.prepare("UPDATE payments SET state = 'PAID' WHERE id = ?1").bind(pay.id).run();
    expect(await (await open(`/p/${await payToken(t.env(), pay.id)}`)).text()).toContain(allCopy.en.pagePaidPackBody);
  });

  it("without PUBLIC_URL (or the key secret) the message keeps Razorpay's link rather than a broken one", async () => {
    const from = await t.greeted("en");
    await t.ageOk(from);
    const env = { ...(t.env() as object), PUBLIC_URL: undefined };
    const { bookingChoice } = await import("../src/booking");
    const conv = (await t.conv(from)).id;
    await bookingChoice(env as never, `slot_PROTECTION_${call(3).startUtc}`, conv, "m-nourl");
    const pay = await newestPayment();
    expect(t.last().interactive.action.parameters.url).toBe(`https://rzp.io/i/${pay.ref}`);
    expect(t.last().interactive.body.text).toContain(`use this link: https://rzp.io/i/${pay.ref}`);
  });

  it("a typed message while the pay step is open sends the same link again", async () => {
    const { from, pay } = await heldCall();
    t.fetchMock.mockClear();
    t.aiFlag = "false";
    await t.typed(from, "what do I do now");
    expect(t.last().interactive.action.parameters.url).toBe(await linkOf(pay.id));
  });
});

describe("the reminder before the hold ends", () => {
  const nudges = () => t.texts().filter((x: string) => x?.includes("is still held until"));

  it("one text about 8 minutes before the hold ends, with our link; once", async () => {
    const { pay } = await heldCall();
    t.fetchMock.mockClear();
    vi.setSystemTime(NOW + 10 * MIN); // 10 minutes left: too early
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    vi.setSystemTime(NOW + 12 * MIN); // 8 minutes left
    expect(await nudgeUnpaidHolds(t.env())).toBe(1);
    expect(t.last().text.body).toBe(allCopy.en.payNudge("11:50 am", await linkOf(pay.id)));
    expect(t.last().text.body).toContain("Reply HELP and we will help you.");
    vi.setSystemTime(NOW + 14 * MIN);
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    expect(nudges()).toHaveLength(1);
    expect(await t.count(`SELECT COUNT(*) AS n FROM settings WHERE key = 'paynudge:${pay.id}'`)).toBe(1);
  });

  it("runs from the 2-minute cron, in Hindi for a Hindi chat", async () => {
    const { pay } = await heldCall("hi");
    t.fetchMock.mockClear();
    vi.setSystemTime(NOW + 12 * MIN);
    await (app as unknown as { scheduled: (e: object, env: unknown) => Promise<void> }).scheduled({ cron: "*/2 * * * *", scheduledTime: NOW + 12 * MIN }, t.env());
    expect(t.texts()).toContain(allCopy.hi.payNudge("सुबह 11:50", await linkOf(pay.id)));
  });

  it("not once it is paid, nor after the hold has ended", async () => {
    const { pay } = await heldCall();
    t.fetchMock.mockClear();
    await t.db.prepare("UPDATE payments SET state = 'PAID' WHERE id = ?1").bind(pay.id).run();
    vi.setSystemTime(NOW + 12 * MIN);
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    await t.db.prepare("UPDATE payments SET state = 'PENDING' WHERE id = ?1").bind(pay.id).run();
    vi.setSystemTime(NOW + 19.5 * MIN); // the last minute: too late to help
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    expect(nudges()).toHaveLength(0);
  });

  it("not outside the 24-hour window (and no item is raised for it)", async () => {
    const { from } = await heldCall();
    t.fetchMock.mockClear();
    await t.db.prepare("UPDATE conversations SET last_user_at = '2026-10-04T05:00:00Z' WHERE wa_id = ?1").bind(from).run();
    vi.setSystemTime(NOW + 12 * MIN);
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    expect(t.sent()).toHaveLength(0);
    expect(await t.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'OUTSIDE_WINDOW'")).toBe(0);
  });

  it("not while SENDS is paused; nothing is claimed, so resuming in time still sends it", async () => {
    await heldCall();
    t.fetchMock.mockClear();
    await setSetting(t.db, "SENDS", "false");
    vi.setSystemTime(NOW + 12 * MIN);
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    expect(await t.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'paynudge:%'")).toBe(0);
    t.sends = "false"; // the env flag off: nothing either
    await t.db.prepare("DELETE FROM settings WHERE key = 'SENDS'").run();
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    t.sends = "true";
    vi.setSystemTime(NOW + 14 * MIN);
    expect(await nudgeUnpaidHolds(t.env())).toBe(1);
    expect(nudges()).toHaveLength(1);
  });

  it("not to a chat a person has taken over, someone who opted out, or during the no-selling week", async () => {
    const { from } = await heldCall();
    t.fetchMock.mockClear();
    vi.setSystemTime(NOW + 12 * MIN);
    await t.db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE wa_id = ?1").bind(from).run();
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    await t.db.prepare("UPDATE conversations SET mode = 'BOT' WHERE wa_id = ?1").bind(from).run();
    await t.setState(from, "opted_out_at = ?2", "2026-10-05T06:01:00Z");
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    await t.setState(from, "opted_out_at = NULL, no_sell_until = ?2", "2026-10-12T06:00:00Z");
    expect(await nudgeUnpaidHolds(t.env())).toBe(0);
    expect(nudges()).toHaveLength(0);
  });

  it("\"HELP\" (or मदद) on its own reaches a person", async () => {
    const { from } = await heldCall();
    t.fetchMock.mockClear();
    await t.typed(from, "HELP");
    expect((await t.conv(from)).mode).toBe("HUMAN");
    expect(t.last().text.body).toBe(allCopy.en.handoffAck);
    const hi = (await heldCall("hi", 4)).from;
    await t.typed(hi, "मदद");
    expect((await t.conv(hi)).mode).toBe("HUMAN");
  });
});
