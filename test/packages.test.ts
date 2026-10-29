/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { allCopy, perSession, rupees } from "../src/copy";
import { applyDueOutcomes } from "../src/outcomes";
import { bookCredit, creditBalance, markManualRefund, refundUnused } from "../src/packages";
import { cancelCredit, cancelSingle, moveSession } from "../src/mybookings";
import { razorpay } from "../src/pay/razorpay";
import { payToken, untilLabel } from "../src/paylink";
import { sendReminders } from "../src/remind";
import { digestText, packageLines } from "../src/report";
import { generateSlots, iso } from "../src/slots";
import { applySql, migrations, newDb } from "./db";
import { closedEvent, FakeRazorpay, paidEvent, rzpEnv, rzpHeaders } from "./razorpay";

// Sessions and packages (ticket 13), in English and Hindi. All data is synthetic. Mon 2026-10-05, 11:30 IST.
// Meta and Razorpay are mocked: nothing is sent anywhere.
const SECRET = "test-app-secret";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const P10 = config.prices.pack10;
const P20 = config.prices.pack20;
const sessionSlot = (i: number, ymd = "2026-10-07") => generateSlots(ymd, "SESSION")[i];
const WED_2PM = sessionSlot(0).startUtc; // Wed 7 Oct, 14:00 IST = 08:30Z

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wa = any;
let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let fake: FakeRazorpay;
let n = 0;

const env = () => ({ DB: db, SENDS: "true", NEW_BOOKINGS: "true", WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "v", WA_TOKEN: "tok", WA_PHONE_ID: "1000", PUBLIC_URL: PUBLIC, ...rzpEnv() }) as never;
// The /p/ link and the "until" time of the newest payment's message (ticket 29), as the pay bodies take them.
const PUBLIC = "https://bot.example.test";
async function sentLink(lang: "en" | "hi"): Promise<[string, string]> {
  const id = (await db.prepare("SELECT MAX(id) AS id FROM payments").first<{ id: number }>())!.id;
  const row = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(`paylink:${id}`).first<{ value: string }>())!.value) as { until: string };
  return [untilLabel(row.until, lang), `${PUBLIC}/p/${await payToken(env() as never, id)}`];
}
const sent = (): Wa[] => fetchMock.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com")).map((c) => JSON.parse((c[1] as { body: string }).body));
const last = (): Wa => sent().at(-1);
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const one = async <T = Wa>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).first<T>())!;

async function sign(raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw) } }, env());
}
const stamp = () => String(Math.floor(Date.now() / 1000));
const wrap = (from: string, extra: object) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: `wamid.P${++n}`, from, timestamp: stamp(), ...extra }] } }] }] });
const typed = (from: string, body: string) => post(wrap(from, { type: "text", text: { body } }));
const tap = (from: string, id: string) => post(wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } }));
const pay = async (ref: string, o: Parameters<typeof paidEvent>[1] = {}, eventId?: string) => {
  const raw = JSON.stringify(paidEvent(ref, o));
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw, eventId ? { eventId } : {}) }, env());
};
const expire = async (ref: string) => {
  const raw = JSON.stringify(closedEvent(ref, "expired"));
  return app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env());
};

// Everything WhatsApp enforces on a message we send.
function violations(p: Wa): string[] {
  const v: string[] = [];
  if (p.type === "text") return p.text.body.length > 4096 ? ["text over 4096"] : v;
  if (p.type !== "interactive") return v;
  const i = p.interactive;
  if (i.body.text.length > 1024) v.push(`body ${i.body.text.length} > 1024`);
  if (i.type === "button") {
    const b = i.action.buttons;
    if (b.length < 1 || b.length > 3) v.push(`${b.length} buttons`);
    for (const x of b) {
      if (x.reply.title.length < 1 || x.reply.title.length > 20) v.push(`button "${x.reply.title}" > 20`);
      if (x.reply.id.length > 256) v.push("button id > 256");
    }
  } else if (i.type === "list") {
    const secs = i.action.sections;
    const rows = secs.flatMap((s: Wa) => s.rows);
    if (i.action.button.length < 1 || i.action.button.length > 20) v.push(`list button "${i.action.button}" > 20`);
    if (rows.length < 1 || rows.length > 10) v.push(`${rows.length} rows`);
    for (const s of secs) {
      if (s.rows.length === 0) v.push("empty section");
      if (s.title.length < 1 || s.title.length > 24) v.push(`section "${s.title}" > 24`);
    }
    for (const r of rows) {
      if (r.title.length < 1 || r.title.length > 24) v.push(`row title "${r.title}" > 24`);
      if ((r.description ?? "").length > 72) v.push(`row description "${r.description}" > 72`);
      if (r.id.length > 200) v.push("row id > 200");
    }
  } else if (i.type === "cta_url") {
    if (i.action.parameters.display_text.length > 20) v.push("cta label > 20");
  }
  return v;
}
const allWithinLimits = () => {
  const bad = sent().flatMap((p) => violations(p).map((x) => `${JSON.stringify(p.interactive?.body?.text ?? p.text?.body).slice(0, 40)}: ${x}`));
  expect(bad).toEqual([]);
};
const buttonIds = (p: Wa): string[] => p.interactive.action.buttons.map((b: Wa) => b.reply.id);
const rowsOf = (p: Wa): Wa[] => p.interactive.action.sections.flatMap((s: Wa) => s.rows);

let phone = 919810100000;
const newPhone = () => String(++phone);
const convOf = async (from: string) => (await one("SELECT id, mode, locale, age_ok_at FROM conversations WHERE wa_id = ?1", from)).id as number;
// A greeted adult with a chosen language, ready for the menu.
async function greeted(lang: "en" | "hi" = "en", ageOk = true) {
  const from = newPhone();
  await typed(from, "hi");
  await tap(from, `lang_${lang}`);
  if (ageOk) await db.prepare("UPDATE conversations SET age_ok_at = '2026-01-01T00:00:00Z' WHERE wa_id = ?1").bind(from).run();
  fetchMock.mockClear();
  return from;
}
// Has paid for a 99 call, so the soft gate stays out of the way.
async function hadCall(conv: number) {
  await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'CALLED_SESSION')").bind(conv).run();
}

// A paid package straight in the database: payment PAID (with a Razorpay payment id), package PAID, the PURCHASE row on the ledger.
async function seedPackage(conv: number, size: 10 | 20 = 10, o: { paidAt?: string } = {}) {
  const p = size === 10 ? P10 : P20;
  const pk = await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, ?2, ?3, 'PAID')").bind(conv, p.sessions, p.paise).run();
  const id = pk.meta.last_row_id;
  const ref = `di-seed-pack-${id}`;
  const py = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, provider_payment_id, amount_paise, state, created_at, updated_at) VALUES ('razorpay','PACKAGE',?1,?2,?3,?3,?4,'PAID',?5,?5)")
    .bind(id, ref, `pay_seed${id}`, p.paise, o.paidAt ?? iso(NOW))
    .run();
  await db.prepare("UPDATE packages SET payment_id = ?2 WHERE id = ?1").bind(id, py.meta.last_row_id).run();
  await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, ?2, 'PURCHASE', ?3, 'system')").bind(id, p.sessions, iso(NOW)).run();
  return { id, payId: py.meta.last_row_id as number };
}
// A single session, paid and confirmed, straight in the database.
async function seedSingle(conv: number, startUtc: string, state = "CONFIRMED") {
  const s = generateSlots(startUtc.slice(0, 10), "SESSION").find((x) => x.startUtc === startUtc)!;
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
  const ses = await db
    .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, for_whom, call_lang) VALUES (?1, ?2, 'HEALING', ?3, 'SELF', 'SELF', 'en')")
    .bind(conv, slot.meta.last_row_id, state)
    .run();
  const sid = ses.meta.last_row_id;
  const py = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, provider_payment_id, amount_paise, state) VALUES ('razorpay','SESSION',?1,?2,?3,?3,?4,'PAID')")
    .bind(sid, `di-seed-single-${sid}`, `pay_single${sid}`, config.prices.single)
    .run();
  return { sid, slotId: slot.meta.last_row_id as number, payId: py.meta.last_row_id as number };
}
const creditBook = (conv: number, startUtc: string, lang = "en") => bookCredit(db, conv, "HEALING", "SELF", lang, startUtc, NOW);

beforeEach(async () => {
  ({ db, close } = await newDb());
  fake = new FakeRazorpay();
  fake.refundStatusOnCreate = "processed";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }), { status: 200 });
    return fake.handle(u, init) ?? new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

describe("prices and the menu", () => {
  it("every price and per-session rate comes from config: the rates are price ÷ sessions", () => {
    expect(config.prices).toMatchObject({ intro: 9900, single: 79900, pack10: { sessions: 10, paise: 500000 }, pack20: { sessions: 20, paise: 900000 } });
    expect(perSession(P10)).toBe("₹500");
    expect(perSession(P20)).toBe("₹450");
    expect(rupees(P10.paise)).toBe("₹5,000");
    for (const lang of ["en", "hi"] as const) {
      const c = allCopy[lang];
      expect(c.rowPack10Desc).toContain(`${rupees(P10.paise)} · ${rupees(P10.paise / P10.sessions)}`);
      expect(c.rowPack20Desc).toContain(`${rupees(P20.paise)} · ${rupees(P20.paise / P20.sessions)}`);
      expect(c.rowSingleDesc).toBe(rupees(config.prices.single));
      expect(c.faqAnswers.price).toContain(rupees(config.prices.single));
      expect(c.faqAnswers.price).toContain(rupees(P20.paise / P20.sessions));
      expect(c.packPayLabel(rupees(P10.paise))).toBe(lang === "en" ? "Pay ₹5,000" : "₹5,000 भुगतान करें");
      expect(c.sessionPayLabel).toContain("₹799");
    }
    expect(JSON.stringify(allCopy)).not.toContain("700");
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: the menu has three buttons, Help is a list of nine rows, and Sessions & packages lists four`, async () => {
      const c = allCopy[lang];
      const from = newPhone();
      await typed(from, "hi");
      await tap(from, `lang_${lang}`);
      expect(buttonIds(last())).toEqual(["menu_book", "menu_pack", "menu_how"]);
      expect(last().interactive.action.buttons.map((b: Wa) => b.reply.title)).toEqual([c.btnBook, c.btnPackages, c.btnHelp]);

      await tap(from, "menu_how");
      expect(rowsOf(last())).toHaveLength(9);
      expect(rowsOf(last()).map((r) => r.id)).toEqual([...config.faqIds.map((id) => `faq_${id}`), "menu_bookings", "menu_person", "menu_lang"]);
      expect(last().interactive.body.text).toBe(c.helpListBody);

      await tap(from, "menu_pack");
      expect(rowsOf(last()).map((r) => r.id)).toEqual(["pk_intro", "pk_single", "pk_p10", "pk_p20"]);
      expect(rowsOf(last()).map((r) => r.title)).toEqual([c.rowIntroTitle, c.rowSingleTitle, c.rowPack10Title, c.rowPack20Title]);
      expect(last().interactive.body.text).toBe(c.packagesBody);
      allWithinLimits();
    });
  }

  it("'human' and the other handoff words work in the middle of every new step", async () => {
    const from = await greeted("en");
    for (const open of ["menu_pack", "pk_single", "bk_new"]) {
      await tap(from, open);
      await db.prepare("UPDATE conversations SET mode = 'BOT' WHERE wa_id = ?1").bind(from).run();
      fetchMock.mockClear();
      await typed(from, "human");
      expect(last().text.body).toBe(allCopy.en.handoffAck);
      await db.prepare("UPDATE conversations SET mode = 'BOT' WHERE wa_id = ?1").bind(from).run();
    }
  });

  it("the menu without selling buttons (after a crisis message) hides Sessions & packages too", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    await db.prepare("UPDATE person_state SET no_sell_until = '2026-10-11T00:00:00Z' WHERE conversation_id = ?1").bind(conv).run();
    await typed(from, "hi");
    expect(buttonIds(last())).toEqual(["menu_how", "menu_person"]);
  });
});

describe("the soft gate and buying a single session", () => {
  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: no 99 call yet -> soft gate; Continue -> service -> who -> day -> time -> pay 799 -> confirmed`, async () => {
      const c = allCopy[lang];
      const from = await greeted(lang);
      const conv = await convOf(from);
      await tap(from, "pk_single");
      expect(last().interactive.body.text).toBe(c.softGate);
      expect(last().interactive.action.buttons.map((b: Wa) => [b.reply.id, b.reply.title])).toEqual([["menu_book", c.btnBook], ["gate_s", c.btnContinue]]);
      await tap(from, "gate_s");
      expect(last().interactive.body.text).toBe(c.chooseService);
      expect(buttonIds(last())).toEqual(["ssv_HEALING", "ssv_PROTECTION"]);
      await tap(from, "ssv_PROTECTION");
      expect(buttonIds(last())).toEqual(["swh_PROTECTION_SELF", "swh_PROTECTION_FAMILY", "swh_PROTECTION_PET"]);
      await tap(from, "swh_PROTECTION_FAMILY");
      expect(last().interactive.body.text).toBe(c.chooseDay);
      expect(buttonIds(last())[0]).toMatch(/^sdy_PROTECTION_FAMILY_2026-10-0[5-9]$/);
      await tap(from, "sdy_PROTECTION_FAMILY_2026-10-06");
      expect(rowsOf(last()).at(-1)).toMatchObject({ id: "smo_PROTECTION_FAMILY", title: c.anotherDay });
      await tap(from, `stm_PROTECTION_FAMILY_${sessionSlot(1, "2026-10-06").startUtc}`);
      expect(last().interactive.type).toBe("cta_url");
      expect(last().interactive.action.parameters.display_text).toBe(c.sessionPayLabel);
      expect(last().interactive.body.text).toContain("₹799");

      const ses = await one("SELECT id, state, origin, service, for_whom, call_lang FROM sessions WHERE conversation_id = ?1", conv);
      expect(ses).toMatchObject({ state: "HELD", origin: "SELF", service: "PROTECTION", for_whom: "FAMILY", call_lang: lang });
      const py = await one("SELECT provider_link_id AS ref, amount_paise AS amount, purpose FROM payments WHERE target_id = ?1 AND purpose = 'SESSION'", ses.id);
      expect(py.amount).toBe(79900);
      expect(fake.links.get(py.ref)!.amount).toBe(79900);

      await pay(py.ref, { amount: 79900 });
      expect((await one("SELECT state FROM sessions WHERE id = ?1", ses.id)).state).toBe("CONFIRMED");
      expect(last().text.body).toBe(c.sessionConfirmed(...(lang === "en" ? ["Tue, 6 Oct", "3:00 pm"] : ["मंगल, 6 अक्टूबर", "दोपहर 3:00"]) as [string, string]));
      allWithinLimits();
    });
  }

  it("someone who has paid for a 99 call skips the soft gate; the age check comes first the first time", async () => {
    const from = await greeted("en", false);
    const conv = await convOf(from);
    await hadCall(conv);
    await tap(from, "pk_single");
    expect(last().interactive.body.text).toBe(allCopy.en.ageCheck);
    expect(buttonIds(last())).toEqual(["age_yes_s", "age_no_s"]);
    await tap(from, "age_no_s");
    expect(last().text.body).toBe(allCopy.en.ageNo);
    await tap(from, "age_yes_s");
    expect(buttonIds(last())).toEqual(["ssv_HEALING", "ssv_PROTECTION"]);
    expect((await one("SELECT age_ok_at FROM conversations WHERE id = ?1", conv)).age_ok_at).not.toBeNull();
  });

  it("an old button works only after the age check; a single time picked twice never makes a second session or hold", async () => {
    const from = await greeted("en", false);
    const conv = await convOf(from);
    await hadCall(conv);
    await tap(from, `stm_HEALING_SELF_${sessionSlot(0, "2026-10-06").startUtc}`);
    expect(last().interactive.body.text).toBe(allCopy.en.ageCheck);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE origin = 'SELF'")).toBe(0);
    await db.prepare("UPDATE conversations SET age_ok_at = '2026-01-01T00:00:00Z' WHERE id = ?1").bind(conv).run();
    await tap(from, `stm_HEALING_SELF_${sessionSlot(0, "2026-10-06").startUtc}`);
    await tap(from, `stm_HEALING_SELF_${sessionSlot(0, "2026-10-06").startUtc}`);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE origin = 'SELF'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'SESSION'")).toBe(1);
  });

  it("buying is closed while NEW_BOOKINGS is off, and never works for a blocked person", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    await hadCall(conv);
    const off = { ...(env() as object), NEW_BOOKINGS: "false" } as never;
    const raw = JSON.stringify(wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "go_p10", title: "x" } } }));
    await app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw) } }, off);
    expect(last().text.body).toBe(allCopy.en.bookSoon);
    expect(await count("SELECT COUNT(*) AS n FROM packages")).toBe(0);
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'ADMIN', 'test')").bind(from).run();
    fetchMock.mockClear();
    await tap(from, "go_p10");
    expect(sent()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM packages")).toBe(0);
  });
});

describe("buying a package", () => {
  for (const [flow, p] of [["p10", P10], ["p20", P20]] as const) {
    for (const lang of ["en", "hi"] as const) {
      it(`${lang}: ${flow} -> a link for ${p.paise / 100} rupees, no slot held -> paid -> ${p.sessions} credits and [Book a session]`, async () => {
        const c = allCopy[lang];
        const from = await greeted(lang);
        const conv = await convOf(from);
        await tap(from, `pk_${flow}`);
        expect(last().interactive.body.text).toBe(c.softGate); // never had the 99 call
        await tap(from, `gate_${flow}`);
        expect(last().interactive.type).toBe("cta_url");
        const [until, link] = await sentLink(lang);
        expect(until).toBe(lang === "en" ? "12:30 pm" : "दोपहर 12:30"); // the link is open for an hour
        expect(last().interactive.body.text).toBe(c.packPayBody(p.sessions, rupees(p.paise), until, link));
        expect(last().interactive.action.parameters.url).toBe(link);
        expect(last().interactive.action.parameters.display_text).toBe(c.packPayLabel(rupees(p.paise)));
        expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
        const py = await one("SELECT id, provider_link_id AS ref, amount_paise AS amount, state FROM payments WHERE purpose = 'PACKAGE'");
        expect(py).toMatchObject({ amount: p.paise, state: "PENDING" });
        expect(fake.links.get(py.ref)!.amount).toBe(p.paise);
        expect(await one("SELECT size, price_paise, state FROM packages WHERE conversation_id = ?1", conv)).toEqual({ size: p.sessions, price_paise: p.paise, state: "PENDING" });
        expect(await creditBalance(db, conv)).toBe(0);

        fetchMock.mockClear();
        await pay(py.ref, { amount: p.paise });
        expect(await creditBalance(db, conv)).toBe(p.sessions);
        expect(await one("SELECT state FROM packages WHERE conversation_id = ?1", conv)).toEqual({ state: "PAID" });
        expect(last().interactive.body.text).toBe(c.packConfirmed(p.sessions));
        expect(last().interactive.action.buttons).toEqual([{ type: "reply", reply: { id: "bk_new", title: c.btnBookSession } }]);
        allWithinLimits();
      });
    }
  }

  it("purchase is idempotent: a replay, a second event for the same payment and the cron all add the credits once", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    await tap(from, "go_p10");
    const ref = (await one("SELECT provider_link_id AS ref FROM payments WHERE purpose = 'PACKAGE'")).ref as string;
    fetchMock.mockClear();
    const raw = JSON.stringify(paidEvent(ref, { amount: P10.paise }));
    for (let i = 0; i < 2; i++) await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, env()); // the same event twice
    await pay(ref, { amount: P10.paise }, "evt_another_one"); // a different event for the same payment
    fake.markPaid(ref, { amount: P10.paise });
    const { reconcile } = await import("../src/pay/apply");
    await reconcile(env(), razorpay(env()), NOW + HOUR);
    expect(await creditBalance(db, conv)).toBe(10);
    expect(await count("SELECT COUNT(*) AS n FROM credits WHERE reason = 'PURCHASE'")).toBe(1);
    expect(sent().filter((p) => p.interactive?.body?.text === allCopy.en.packConfirmed(10))).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
  });

  it("a second tap while a link is open makes no second link; a wrong amount adds no credits; an expired link adds none", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    await tap(from, "go_p10");
    await tap(from, "go_p20");
    expect(last().text.body).toBe(allCopy.en.packPending);
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'PACKAGE'")).toBe(1);
    const ref = (await one("SELECT provider_link_id AS ref FROM payments WHERE purpose = 'PACKAGE'")).ref as string;
    await pay(ref, { amount: P10.paise, paid: 9900 }); // the wrong amount arrived
    expect(await creditBalance(db, conv)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(1);

    const from2 = await greeted("en");
    const conv2 = await convOf(from2);
    await tap(from2, "go_p20");
    const ref2 = (await one("SELECT provider_link_id AS ref FROM payments WHERE purpose = 'PACKAGE' AND id = 2")).ref as string;
    await expire(ref2);
    expect(await one("SELECT state FROM packages WHERE conversation_id = ?1", conv2)).toEqual({ state: "EXPIRED" });
    expect(await creditBalance(db, conv2)).toBe(0);
    // A payment that still arrives after the link expired is real money: the credits are added.
    await pay(ref2, { amount: P20.paise });
    expect(await creditBalance(db, conv2)).toBe(20);
  });

  it("a failed link creation frees everything and tells the person", async () => {
    const from = await greeted("en");
    fake.failLinkCreateOnce = true;
    await tap(from, "go_p10");
    expect(last().text.body).toBe(allCopy.en.payFailed);
    expect(await one("SELECT state FROM packages")).toEqual({ state: "FAILED" });
    expect(await one("SELECT state FROM payments")).toEqual({ state: "FAILED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'LINK_CREATE_FAILED'")).toBe(1);
    await tap(from, "go_p10"); // and it can be tried again
    expect(last().interactive.type).toBe("cta_url");
  });

  it("a package payment makes a paying customer (never filtered), and a package payment outside the 24-hour window raises an item instead of sending", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    await tap(from, "go_p10");
    const ref = (await one("SELECT provider_link_id AS ref FROM payments WHERE purpose = 'PACKAGE'")).ref as string;
    await db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(conv, iso(NOW - 3 * DAY)).run();
    fetchMock.mockClear();
    await pay(ref, { amount: P10.paise });
    expect(sent()).toHaveLength(0); // the template is not approved yet
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED' AND target LIKE 'package_confirmed:%'")).toBe(1);
    expect(await creditBalance(db, conv)).toBe(10);
    const { isPayingCustomer } = await import("../src/noise");
    expect(await isPayingCustomer(db, conv, NOW)).toBe(true);
    expect(config.templates.package_confirmed).toMatchObject({ approved: false, hi: { approved: false } });
    expect(config.templates.session_booked).toMatchObject({ approved: false, hi: { approved: false } });
  });
});

describe("booking a session with a credit", () => {
  async function ready(lang: "en" | "hi" = "en", size: 10 | 20 = 10) {
    const from = await greeted(lang);
    const conv = await convOf(from);
    await seedPackage(conv, size);
    return { from, conv };
  }

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: Book a session -> service -> who -> day -> time -> booked at once, no payment step, one credit used`, async () => {
      const c = allCopy[lang];
      const { from, conv } = await ready(lang);
      await tap(from, "bk_new");
      expect(buttonIds(last())).toEqual(["bsv_HEALING", "bsv_PROTECTION"]);
      await tap(from, "bsv_HEALING");
      expect(buttonIds(last())).toEqual(["bwh_HEALING_SELF", "bwh_HEALING_FAMILY", "bwh_HEALING_PET"]);
      await tap(from, "bwh_HEALING_PET");
      expect(last().interactive.body.text).toBe(c.chooseDay);
      await tap(from, "bdy_HEALING_PET_2026-10-07");
      expect(rowsOf(last()).at(-1)).toMatchObject({ id: "bmo_HEALING_PET", title: c.anotherDay });
      await tap(from, `btm_HEALING_PET_${WED_2PM}`);
      expect(last().text.body).toBe(c.creditBooked(...(lang === "en" ? ["Wed, 7 Oct", "2:00 pm"] : ["बुध, 7 अक्टूबर", "दोपहर 2:00"]) as [string, string], 9));
      expect(await one("SELECT state, origin, for_whom, call_lang, package_id FROM sessions")).toMatchObject({ state: "CREDIT_BOOKED", origin: "CREDIT", for_whom: "PET", call_lang: lang });
      expect(await one("SELECT state FROM slots WHERE start_utc = ?1", WED_2PM)).toEqual({ state: "BOOKED" });
      expect(await creditBalance(db, conv)).toBe(9);
      expect(await count("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'SESSION'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM credits WHERE reason = 'BOOK'")).toBe(1);
      allWithinLimits();
    });
  }

  it("two taps at once for different times, with one credit left, book exactly one session", async () => {
    const { from, conv } = await ready();
    await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (1, -9, 'ADJUST', ?1, 'test')").bind(iso(NOW)).run(); // one credit left
    expect(await creditBalance(db, conv)).toBe(1);
    await Promise.all([tap(from, `btm_HEALING_SELF_${sessionSlot(0).startUtc}`), tap(from, `btm_HEALING_SELF_${sessionSlot(2).startUtc}`)]);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE state = 'CREDIT_BOOKED'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM credits WHERE reason = 'BOOK'")).toBe(1);
    expect(await creditBalance(db, conv)).toBe(0);
  });

  it("the same time tapped twice, or the booking replayed, uses one credit and one slot", async () => {
    const { from, conv } = await ready();
    await Promise.all([tap(from, `btm_HEALING_SELF_${WED_2PM}`), tap(from, `btm_HEALING_SELF_${WED_2PM}`)]);
    expect(await creditBalance(db, conv)).toBe(9);
    const again = await creditBook(conv, WED_2PM);
    expect(again).toEqual({ ok: false, reason: expect.stringMatching(/MAX_UPCOMING|SLOT_TAKEN/) });
    expect(await creditBalance(db, conv)).toBe(9);
    expect(await count("SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    // the same Meta message delivered twice is also a no-op
    const raw = JSON.stringify(wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `btm_HEALING_SELF_${sessionSlot(1).startUtc}`, title: "x" } } }));
    for (let i = 0; i < 2; i++) await app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw) } }, env());
    expect(await creditBalance(db, conv)).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM sessions")).toBe(2);
  });

  it("at most two upcoming sessions: the third is refused with the message, and a slot someone else holds is not taken", async () => {
    const { from, conv } = await ready();
    expect((await creditBook(conv, sessionSlot(0).startUtc)).ok).toBe(true);
    expect((await creditBook(conv, sessionSlot(1).startUtc)).ok).toBe(true);
    expect(await creditBook(conv, sessionSlot(2).startUtc)).toEqual({ ok: false, reason: "MAX_UPCOMING" });
    await tap(from, "bk_new");
    expect(last().text.body).toBe(allCopy.en.maxUpcoming);
    await tap(from, `btm_HEALING_SELF_${sessionSlot(3).startUtc}`);
    expect(last().text.body).toBe(allCopy.en.maxUpcoming);
    expect(await creditBalance(db, conv)).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM sessions")).toBe(2);
    // an ended session no longer counts
    await db.prepare("UPDATE slots SET end_utc = '2026-10-04T10:00:00Z', start_utc = '2026-10-04T09:00:00Z' WHERE id = 1").run();
    expect((await creditBook(conv, sessionSlot(3).startUtc)).ok).toBe(true);
    // and a time somebody else already holds is a "taken", not a booking
    const other = await greeted("en");
    const oc = await convOf(other);
    await seedPackage(oc);
    const taken = await creditBook(oc, sessionSlot(3).startUtc);
    expect(taken).toEqual({ ok: false, reason: "SLOT_TAKEN" });
    expect(await creditBalance(db, oc)).toBe(10);
  });

  it("a zero balance books nothing; Book a session says so, and an empty package does not hide My bookings", async () => {
    const { from, conv } = await ready();
    await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (1, -10, 'ADJUST', ?1, 'test')").bind(iso(NOW)).run();
    expect(await creditBook(conv, WED_2PM)).toEqual({ ok: false, reason: "NO_CREDIT" });
    await tap(from, "bk_new");
    expect(last().text.body).toBe(allCopy.en.noCredits);
    await tap(from, `btm_HEALING_SELF_${WED_2PM}`);
    expect(last().text.body).toBe(allCopy.en.noCredits);
    expect(await count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    await tap(from, "menu_bookings");
    expect(last().text.body).toBe(`${allCopy.en.myBookingsNone} ${allCopy.en.creditsLeft(0)}`);
    // Nothing to tap, so no step stays open: the next typed question is answered on its own.
    expect((await one("SELECT pending_step FROM conversations WHERE wa_id = ?1", from)).pending_step).toBeNull();
  });

  it("someone with no package at all cannot book from credits", async () => {
    const from = await greeted("en");
    await tap(from, `btm_HEALING_SELF_${WED_2PM}`);
    expect(last().text.body).toBe(allCopy.en.noCredits);
    expect(await count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });

  it("credit-booked sessions get the day-before reminder, once", async () => {
    const { conv } = await ready();
    await creditBook(conv, WED_2PM);
    fetchMock.mockClear();
    const tuesday = Date.parse("2026-10-06T13:00:00Z");
    expect(await sendReminders(env(), tuesday)).toBe(1);
    expect(await sendReminders(env(), tuesday)).toBe(0);
    expect(last().text.body).toBe(allCopy.en.reminderSession("Wed, 7 Oct", "2:00 pm"));
  });
});

describe("My bookings, Move and Cancel (IST, 3 h and 24 h)", () => {
  const at = (startUtc: string, beforeMs: number) => vi.setSystemTime(Date.parse(startUtc) - beforeMs);
  async function packageBuyer(lang: "en" | "hi" = "en") {
    const from = await greeted(lang);
    const conv = await convOf(from);
    await seedPackage(conv);
    return { from, conv };
  }

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: one session lists with [Move] [Cancel] and the credits left; none says so`, async () => {
      const c = allCopy[lang];
      const { from, conv } = await packageBuyer(lang);
      await tap(from, "menu_bookings");
      expect(last().interactive.action.buttons ?? last().text).toBeTruthy();
      expect(last().interactive?.body.text ?? last().text.body).toBe(`${c.myBookingsNone} ${c.creditsLeft(10)}`);
      await creditBook(conv, WED_2PM, lang);
      const sid = (await one("SELECT id FROM sessions")).id;
      await tap(from, "menu_bookings");
      const word = c.bookingItem(c.wordSession, ...(lang === "en" ? ["Wed, 7 Oct", "2:00 pm"] : ["बुध, 7 अक्टूबर", "दोपहर 2:00"]) as [string, string]);
      expect(last().interactive.body.text).toBe(c.myBookingsBody(word, 9));
      expect(last().interactive.action.buttons.map((b: Wa) => [b.reply.id, b.reply.title])).toEqual([[`mv_${sid}`, c.btnMove], [`cx_${sid}`, c.btnCancel]]);
      allWithinLimits();
    });
  }

  it("two sessions: the list, then a [Move] [Cancel] message for each; a person without a package sees no credits line", async () => {
    const { from, conv } = await packageBuyer();
    await creditBook(conv, sessionSlot(0).startUtc);
    await creditBook(conv, sessionSlot(1).startUtc);
    await tap(from, "menu_bookings");
    const m = sent();
    expect(m).toHaveLength(3);
    expect(m[0].text.body).toContain("Sessions left in your package: 8");
    expect(m[1].interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["mv_1", "cx_1"]);
    expect(m[2].interactive.action.buttons.map((b: Wa) => b.reply.id)).toEqual(["mv_2", "cx_2"]);

    const solo = await greeted("en");
    const sc = await convOf(solo);
    await seedSingle(sc, sessionSlot(4).startUtc);
    await tap(solo, "menu_bookings");
    expect(last().interactive.body.text).not.toContain("package");
    expect(last().interactive.action.buttons).toHaveLength(2);
  });

  it("a package session: cancel at exactly 3 h before returns the credit and frees the slot; 3 h less a second does not", async () => {
    const { from, conv } = await packageBuyer();
    await creditBook(conv, sessionSlot(0).startUtc);
    await creditBook(conv, sessionSlot(1).startUtc); // 15:00 IST
    expect(await creditBalance(db, conv)).toBe(8);
    const late = sessionSlot(1).startUtc;
    at(late, 3 * HOUR - 1000);
    await tap(from, "cx_2");
    expect(last().text.body).toBe(allCopy.en.moveTooLate);
    expect((await one("SELECT state FROM sessions WHERE id = 2")).state).toBe("CREDIT_BOOKED");
    expect(await creditBalance(db, conv)).toBe(8);
    await tap(from, "mv_2");
    expect(last().text.body).toBe(allCopy.en.moveTooLate);

    at(sessionSlot(0).startUtc, 3 * HOUR); // exactly 3 h before the 14:00 session
    await tap(from, "cx_1");
    expect(last().text.body).toBe(allCopy.en.cancelledCredit(9));
    expect(await one("SELECT state FROM sessions WHERE id = 1")).toEqual({ state: "CANCELLED" });
    expect(await creditBalance(db, conv)).toBe(9);
    expect(await count("SELECT COUNT(*) AS n FROM credits WHERE reason = 'CANCEL_RETURN'")).toBe(1);
    await tap(from, "cx_1"); // a second tap changes nothing
    expect(last().text.body).toBe(allCopy.en.bookingNotFound);
    expect(await creditBalance(db, conv)).toBe(9);
    // the freed slot can be booked by someone else
    const other = await greeted("en");
    const oc = await convOf(other);
    await seedPackage(oc);
    expect((await bookCredit(db, oc, "HEALING", "SELF", "en", sessionSlot(0).startUtc, Date.now())).ok).toBe(true);
  });

  it("a package session can be moved (any number of times) at 3 h or more, and keeps its credit", async () => {
    const { from, conv } = await packageBuyer();
    await creditBook(conv, WED_2PM);
    at(WED_2PM, 3 * HOUR);
    await tap(from, "mv_1");
    expect(buttonIds(last())[0]).toMatch(/^mdy_1_2026-10-0/);
    await tap(from, "mdy_1_2026-10-07");
    expect(rowsOf(last()).at(-1)).toMatchObject({ id: "mmo_1" });
    await tap(from, `mtm_1_${sessionSlot(2).startUtc}`);
    expect(last().text.body).toBe(allCopy.en.moved("Wed, 7 Oct", "4:00 pm"));
    const ses = await one("SELECT slot_id FROM sessions WHERE id = 1");
    expect((await one("SELECT start_utc, state FROM slots WHERE id = ?1", ses.slot_id))).toEqual({ start_utc: sessionSlot(2).startUtc, state: "BOOKED" });
    expect(await creditBalance(db, conv)).toBe(9);
    // the old time is free again
    const other = await greeted("en");
    const oc = await convOf(other);
    await seedPackage(oc);
    expect((await bookCredit(db, oc, "HEALING", "SELF", "en", WED_2PM, Date.now())).ok).toBe(true);
    // moved again, from the new time (4 pm today is more than 3 h away from now)
    at(sessionSlot(2).startUtc, 4 * HOUR);
    expect(await moveSession(db, conv, (await loadRow(1))!, sessionSlot(3).startUtc, Date.now())).toBe(true);
    expect(await creditBalance(db, conv)).toBe(9);
  });

  async function loadRow(sid: number) {
    return db
      .prepare("SELECT se.id, se.state, se.origin, se.moves, sl.id AS slotId, sl.start_utc AS startUtc FROM sessions se JOIN slots sl ON sl.id = se.slot_id WHERE se.id = ?1")
      .bind(sid)
      .first<{ id: number; state: string; origin: string; moves: number; slotId: number; startUtc: string }>();
  }

  it("a move to a time that is taken leaves the session where it was", async () => {
    const { from, conv } = await packageBuyer();
    await creditBook(conv, WED_2PM);
    const other = await greeted("en");
    const oc = await convOf(other);
    await seedPackage(oc);
    await creditBook(oc, sessionSlot(2).startUtc);
    await tap(from, `mtm_1_${sessionSlot(2).startUtc}`);
    expect(sent().some((p) => p.text?.body === allCopy.en.slotTaken)).toBe(true);
    expect((await loadRow(1))!.startUtc).toBe(WED_2PM);
    expect(await count(`SELECT COUNT(*) AS n FROM slots WHERE owner_id = ${conv} AND state = 'BOOKED'`)).toBe(1);
  });

  it("a single session: cancel at 24 h or more refunds through the one refund path, once", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    const { sid, payId } = await seedSingle(conv, WED_2PM);
    at(WED_2PM, 24 * HOUR - 1000); // 23 h 59 m 59 s
    await tap(from, `cx_${sid}`);
    expect(last().interactive.body.text).toBe(allCopy.en.cancelledSingleNoRefund);
    expect(buttonIds(last())).toEqual([`mv_${sid}`, "book_keep"]);
    expect((await one("SELECT state FROM sessions WHERE id = ?1", sid)).state).toBe("CONFIRMED");
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);

    at(WED_2PM, 24 * HOUR); // exactly 24 h
    await tap(from, `cx_${sid}`);
    expect(last().text.body).toBe(allCopy.en.cancelledSingleRefund);
    expect((await one("SELECT state FROM sessions WHERE id = ?1", sid)).state).toBe("CANCELLED");
    expect(await one("SELECT reason, requested_by, state, amount_paise FROM refunds WHERE payment_id = ?1", payId)).toEqual({ reason: "CANCEL", requested_by: "customer", state: "REFUNDED", amount_paise: null });
    expect(fake.posts("/refund")).toHaveLength(1);
    expect(fake.posts("/refund")[0].body).toMatchObject({ amount: 79900 });
    expect(await one("SELECT state FROM slots WHERE start_utc = ?1", WED_2PM)).toMatchObject({ state: "HELD" });
    await tap(from, `cx_${sid}`); // again
    expect(fake.posts("/refund")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);
  });

  it("a single session between 3 and 24 h: no refund, but it can be moved once; then never again; under 3 h nothing", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    const { sid } = await seedSingle(conv, WED_2PM);
    at(WED_2PM, 10 * HOUR);
    await tap(from, `mv_${sid}`);
    await tap(from, `mdy_${sid}_2026-10-08`);
    await tap(from, `mtm_${sid}_${sessionSlot(1, "2026-10-08").startUtc}`);
    expect(last().text.body).toBe(allCopy.en.moved("Thu, 8 Oct", "3:00 pm"));
    expect(await one("SELECT moves, state FROM sessions WHERE id = ?1", sid)).toEqual({ moves: 1, state: "CONFIRMED" });
    await tap(from, `mv_${sid}`);
    expect(last().interactive.body.text).toBe(allCopy.en.moveOnlyOnce);
    expect(buttonIds(last())).toEqual(["menu_person"]);
    at(sessionSlot(1, "2026-10-08").startUtc, 10 * HOUR);
    await tap(from, `cx_${sid}`); // 10 h before the new time: no refund and no second move
    expect(last().interactive.body.text).toBe(allCopy.en.moveOnlyOnce);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(0);
    // under 3 h: nothing
    at(sessionSlot(1, "2026-10-08").startUtc, 3 * HOUR - 1000);
    await tap(from, `cx_${sid}`);
    expect(last().text.body).toBe(allCopy.en.moveTooLate);
    await tap(from, `mv_${sid}`);
    expect(last().text.body).toBe(allCopy.en.moveTooLate);
    expect(await one("SELECT moves, state FROM sessions WHERE id = ?1", sid)).toEqual({ moves: 1, state: "CONFIRMED" });
  });

  it("someone else's session, a session that is over and an unknown one are 'not found', never an error", async () => {
    const a = await greeted("en");
    const ac = await convOf(a);
    const { sid } = await seedSingle(ac, WED_2PM);
    const b = await greeted("en");
    for (const id of [`cx_${sid}`, `mv_${sid}`, `mdy_${sid}_2026-10-08`, "cx_999", "mv_999"]) {
      await tap(b, id);
      expect(last().text.body, id).toBe(allCopy.en.bookingNotFound);
    }
    at(WED_2PM, -HOUR); // an hour after it started
    await tap(a, `cx_${sid}`);
    expect(last().text.body).toBe(allCopy.en.bookingNotFound);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE status = 'FAILED'")).toBe(0);
    // the guarded writes themselves refuse too
    expect(await cancelSingle(db, ac, sid, Date.now())).toBeNull();
    expect(await cancelCredit(db, ac, sid, Date.now())).toBe(false);
  });

  it("the 99 call is listed without Move or Cancel", async () => {
    const from = await greeted("en");
    const conv = await convOf(from);
    const s = generateSlots("2026-10-07", "CALL")[0];
    const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
    await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'PAID')").bind(conv, slot.meta.last_row_id).run();
    await tap(from, "menu_bookings");
    expect(last().text.body).toContain(allCopy.en.wordCall);
    expect(sent()).toHaveLength(1);
  });
});

describe("Amma's Session outcome and Not right fit on a first session", () => {
  it("the offer after a call is a list: single, 10 or 20; a typed message shows it again", async () => {
    for (const lang of ["en", "hi"] as const) {
      const c = allCopy[lang];
      const from = await greeted(lang);
      const conv = await convOf(from);
      const intro = await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'PAID')").bind(conv).run();
      const introId = intro.meta.last_row_id;
      await db.prepare("INSERT INTO outcomes (intro_id, value, tapped_at, undo_until) VALUES (?1, 'SESSION', ?2, ?2)").bind(introId, iso(NOW - HOUR)).run();
      fetchMock.mockClear();
      await applyDueOutcomes(env(), razorpay(env()), NOW);
      const sid = (await one("SELECT id FROM sessions WHERE intro_id = ?1", introId)).id;
      expect(last().interactive.type).toBe("list");
      expect(last().interactive.body.text).toBe(c.sessionOfferBody);
      expect(rowsOf(last()).map((r) => [r.id, r.title, r.description])).toEqual([
        [`sess_offer_${sid}`, c.rowSingleTitle, c.rowSingleDesc],
        ["go_p10", c.rowPack10Title, c.rowPack10Desc],
        ["go_p20", c.rowPack20Title, c.rowPack20Desc],
      ]);
      allWithinLimits();
      fetchMock.mockClear();
      await typed(from, "what next?");
      expect(last().interactive.type).toBe("list");
      await tap(from, "go_p20"); // no soft gate for someone who just had the call
      expect(last().interactive.type).toBe("cta_url");
      expect(last().interactive.action.parameters.display_text).toBe(c.packPayLabel("₹9,000"));
    }
  });

  async function firstSession(kind: "single" | "package") {
    const from = await greeted("en");
    const conv = await convOf(from);
    let sid: number;
    let payId: number;
    if (kind === "single") ({ sid, payId } = await seedSingle(conv, WED_2PM));
    else {
      ({ payId } = await seedPackage(conv));
      await creditBook(conv, WED_2PM);
      await creditBook(conv, sessionSlot(1).startUtc);
      sid = 1;
    }
    const tapped = (value = "NOT_FIT") => db.prepare("INSERT INTO outcomes (session_id, value, tapped_at, undo_until, slot_id) VALUES (?1, ?2, ?3, ?3, 1)").bind(sid, value, iso(NOW)).run();
    return { from, conv, sid, payId, tapped };
  }

  it("a single session: the whole payment is refunded, once per person, and the person is told", async () => {
    const { from, conv, sid, payId, tapped } = await firstSession("single");
    await tapped();
    fetchMock.mockClear();
    await applyDueOutcomes(env(), razorpay(env()), NOW + HOUR);
    expect((await one("SELECT state FROM sessions WHERE id = ?1", sid)).state).toBe("NOT_FIT");
    expect(await one("SELECT reason, requested_by FROM refunds WHERE payment_id = ?1", payId)).toEqual({ reason: "NOT_FIT", requested_by: "amma" });
    expect(fake.posts("/refund")[0].body).toMatchObject({ amount: 79900 });
    expect(last().text.body).toBe(allCopy.en.notFitRefundSession("₹799"));
    // a second purchase by the same person is not refunded this way again
    const second = await seedSingle(conv, sessionSlot(3).startUtc);
    await db.prepare("INSERT INTO outcomes (session_id, value, tapped_at, undo_until, slot_id) VALUES (?1, 'NOT_FIT', ?2, ?2, 2)").bind(second.sid, iso(NOW)).run();
    await applyDueOutcomes(env(), razorpay(env()), NOW + 2 * HOUR);
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'NOT_FIT_REFUND_REFUSED'")).toBe(1);
    expect(from).toBeTruthy();
  });

  it("a package: the whole purchase is refunded, other sessions are cancelled, the balance goes to 0", async () => {
    const { conv, payId, tapped } = await firstSession("package");
    await tapped();
    await applyDueOutcomes(env(), razorpay(env()), NOW + HOUR);
    expect(fake.posts("/refund")).toHaveLength(1);
    expect(fake.posts("/refund")[0].body).toMatchObject({ amount: P10.paise });
    expect(await one("SELECT reason FROM refunds WHERE payment_id = ?1", payId)).toEqual({ reason: "NOT_FIT" });
    expect(await one("SELECT state FROM sessions WHERE id = 1")).toEqual({ state: "NOT_FIT" });
    expect(await one("SELECT state FROM sessions WHERE id = 2")).toEqual({ state: "CANCELLED" });
    expect(await one("SELECT state FROM slots WHERE start_utc = ?1", sessionSlot(1).startUtc)).toMatchObject({ state: "HELD" });
    expect(await creditBalance(db, conv)).toBe(0);
    expect(await one("SELECT state FROM packages")).toEqual({ state: "CLOSED" });
  });

  it("a replayed or undone outcome does nothing twice", async () => {
    const { tapped } = await firstSession("single");
    await tapped();
    await applyDueOutcomes(env(), razorpay(env()), NOW + HOUR);
    await applyDueOutcomes(env(), razorpay(env()), NOW + 2 * HOUR);
    expect(fake.posts("/refund")).toHaveLength(1);
    await expect(tapped()).rejects.toThrow(); // one answer per session (unique index)
  });
});

describe("stopping a package: unused sessions x the package rate", () => {
  async function owner(size: 10 | 20, used: number, paidAt?: string) {
    const from = await greeted("en");
    const conv = await convOf(from);
    const { id, payId } = await seedPackage(conv, size, { paidAt });
    for (let i = 0; i < used; i++) {
      await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, -1, 'ADJUST', ?2, 'test')").bind(id, iso(NOW)).run();
    }
    return { conv, id, payId };
  }

  it("the 10-pack with 3 used: 7 x ₹500 = ₹3,500 goes back through Razorpay, the balance goes to 0 and the package closes", async () => {
    const { conv, id, payId } = await owner(10, 3);
    fetchMock.mockClear();
    const res = await refundUnused(env(), razorpay(env()), id, 7, "rohit@example.test");
    expect(res).toEqual({ kind: "REFUNDED", unused: 7, paise: 350000 });
    expect(fake.posts("/refund")[0].body).toMatchObject({ amount: 350000 });
    expect(await one("SELECT reason, amount_paise, requested_by, state FROM refunds WHERE payment_id = ?1", payId)).toEqual({ reason: "PACKAGE_UNUSED", amount_paise: 350000, requested_by: "rohit@example.test", state: "REFUNDED" });
    expect(await creditBalance(db, conv)).toBe(0);
    expect(await one("SELECT state FROM packages WHERE id = ?1", id)).toEqual({ state: "CLOSED" });
    expect(last().text.body).toBe(allCopy.en.packRefunded("₹3,500"));
    expect(await one("SELECT delta, reason, by FROM credits WHERE reason = 'REFUND'")).toEqual({ delta: -7, reason: "REFUND", by: "rohit@example.test" });
    // again: nothing
    expect((await refundUnused(env(), razorpay(env()), id, 7, "rohit@example.test")).kind).toBe("NOTHING");
    expect(fake.posts("/refund")).toHaveLength(1);
  });

  it("the 20-pack with 2 used: 18 x ₹450 = ₹8,100", async () => {
    const { id } = await owner(20, 2);
    expect(await refundUnused(env(), razorpay(env()), id, 18, "rohit@example.test")).toEqual({ kind: "REFUNDED", unused: 18, paise: 810000 });
    expect(fake.posts("/refund")[0].body).toMatchObject({ amount: 810000 });
  });

  it("if the balance changed since Rohit looked, nothing happens", async () => {
    const { conv, id } = await owner(10, 3);
    expect((await refundUnused(env(), razorpay(env()), id, 8, "rohit@example.test")).kind).toBe("STALE");
    expect(await creditBalance(db, conv)).toBe(7);
    expect(fake.posts("/refund")).toHaveLength(0);
  });

  it("a payment older than 180 days is paid by hand: MANUAL_REFUND, balance 0, no Razorpay call; marking it done is recorded once", async () => {
    const { conv, id } = await owner(10, 4, iso(NOW - 181 * DAY));
    fetchMock.mockClear();
    const res = await refundUnused(env(), razorpay(env()), id, 6, "rohit@example.test");
    expect(res).toEqual({ kind: "MANUAL", unused: 6, paise: 300000 });
    expect(fake.posts("/refund")).toHaveLength(0);
    expect(await creditBalance(db, conv)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'MANUAL_REFUND' AND target = 'package:1' AND resolved_at IS NULL")).toBe(1);
    expect(sent()).toHaveLength(0); // the customer is told when the money has really gone
    expect((await packageLines(env(), NOW)).join("\n")).toContain("Refunds to pay by hand: 1");

    expect(await markManualRefund(env(), id, "rohit@example.test")).toBe(true);
    expect(await markManualRefund(env(), id, "rohit@example.test")).toBe(false);
    expect(await one("SELECT delta, reason, by FROM credits WHERE reason = 'ADJUST' AND delta = 0")).toEqual({ delta: 0, reason: "ADJUST", by: "rohit@example.test" });
    expect(last().text.body).toBe(allCopy.en.packRefunded("₹3,000"));
    expect(await creditBalance(db, conv)).toBe(0);
  });

  it("179 days is still Razorpay's", async () => {
    const { id } = await owner(10, 0, iso(NOW - 179 * DAY));
    expect((await refundUnused(env(), razorpay(env()), id, 10, "rohit@example.test")).kind).toBe("REFUNDED");
  });
});

describe("the digest", () => {
  it("counts packages sold by size, credits used today, credits outstanding and manual refunds pending", async () => {
    const a = await greeted("en");
    const ac = await convOf(a);
    await seedPackage(ac, 10);
    const b = await greeted("en");
    const bc = await convOf(b);
    await seedPackage(bc, 20);
    await seedPackage(bc, 20);
    await creditBook(ac, WED_2PM);
    const lines = await packageLines(env(), NOW);
    expect(lines).toEqual(["- Packages sold: 10 sessions 1, 20 sessions 2", "- Package sessions booked today: 1", "- Package sessions still owed: 49", "- Refunds to pay by hand: 0"]);
    expect(await digestText(env(), NOW)).toContain("Packages\n- Packages sold: 10 sessions 1, 20 sessions 2");
  });
});

describe("migration 0007", () => {
  it("keeps every row, every id and every link, and the new tables work", async () => {
    const old = await newDb(6);
    try {
      const o = old.db;
      await o.prepare("INSERT INTO conversations (wa_id) VALUES ('919800000101')").run();
      await o.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL','2026-10-05T08:30:00Z','2026-10-05T08:45:00Z',1,'BOOKED')").run();
      await o.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (1, 1, 'HEALING', 'CALLED_NOT_FIT')").run();
      await o.prepare("INSERT INTO sessions (conversation_id, intro_id, service, state, override_by) VALUES (1, 1, 'HEALING', 'CONFIRMED', 'rohit')").run();
      await o.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, amount_paise, state, payer_ref, paid_paise) VALUES ('razorpay','INTRO',1,'di-intro-1','pay_1',9900,'REFUNDED','upi@x',9900)").run();
      await o.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay','SESSION',1,'di-session-1',70000,'PENDING')").run();
      await o.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state, provider_refund_id, attempt_at) VALUES (1,'NOT_FIT','amma','REFUNDED','rfnd_1','2026-10-05T09:00:00Z')").run();
      await o.prepare("INSERT INTO outcomes (intro_id, value, tapped_at, undo_until, applied_at, slot_id) VALUES (1,'NOT_FIT','2026-10-05T09:00:00Z','2026-10-05T09:10:00Z','2026-10-05T09:11:00Z',1)").run();
      await applySql(o, migrations.packagesSql);
      expect(await o.prepare("SELECT id, purpose, target_id, provider_link_id, provider_order_id, amount_paise, state, payer_ref, paid_paise FROM payments ORDER BY id").all().then((r) => r.results)).toEqual([
        { id: 1, purpose: "INTRO", target_id: 1, provider_link_id: "di-intro-1", provider_order_id: "pay_1", amount_paise: 9900, state: "REFUNDED", payer_ref: "upi@x", paid_paise: 9900 },
        { id: 2, purpose: "SESSION", target_id: 1, provider_link_id: "di-session-1", provider_order_id: null, amount_paise: 70000, state: "PENDING", payer_ref: null, paid_paise: null },
      ]);
      expect(await o.prepare("SELECT payment_id, reason, requested_by, state, provider_refund_id, attempt_at, amount_paise FROM refunds").first()).toEqual({
        payment_id: 1, reason: "NOT_FIT", requested_by: "amma", state: "REFUNDED", provider_refund_id: "rfnd_1", attempt_at: "2026-10-05T09:00:00Z", amount_paise: null,
      });
      expect(await o.prepare("SELECT state, override_by, origin, moves, package_id FROM sessions").first()).toEqual({ state: "CONFIRMED", override_by: "rohit", origin: "AMMA", moves: 0, package_id: null });
      expect(await o.prepare("SELECT intro_id, session_id, value, applied_at FROM outcomes").first()).toEqual({ intro_id: 1, session_id: null, value: "NOT_FIT", applied_at: "2026-10-05T09:11:00Z" });
      // the one-refund-per-payment rule survived the rebuild, and the new purpose and states are allowed
      await expect(o.prepare("INSERT INTO refunds (payment_id, reason, requested_by) VALUES (1,'DUPLICATE','system')").run()).rejects.toThrow();
      await expect(o.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay','INTRO',9,'di-intro-1',9900)").run()).rejects.toThrow(); // link ids stay unique
      await o.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay','PACKAGE',1,'di-pack-1',500000)").run();
      await expect(o.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay','OTHER',1,'x',1)").run()).rejects.toThrow();
      await o.prepare("UPDATE sessions SET state = 'CREDIT_BOOKED' WHERE id = 1").run();
      await expect(o.prepare("UPDATE sessions SET state = 'NOPE' WHERE id = 1").run()).rejects.toThrow();
      await o.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (1, 10, 500000, 'PAID')").run();
      await o.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (1, 10, 'PURCHASE', 'x', 'system')").run();
      await expect(o.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (1, 10, 'PURCHASE', 'x', 'system')").run()).rejects.toThrow(); // purchase once
      await o.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (1, -1, 'BOOK', 1, 'x', 'c')").run();
      await expect(o.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (1, -1, 'BOOK', 1, 'x', 'c')").run()).rejects.toThrow(); // one credit per session
      await o.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (1, 1, 'CANCEL_RETURN', 1, 'x', 'c')").run();
      await expect(o.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (1, 1, 'CANCEL_RETURN', 1, 'x', 'c')").run()).rejects.toThrow(); // returned once
      await o.prepare("INSERT INTO outcomes (session_id, value, tapped_at, undo_until) VALUES (1,'NOT_FIT','x','y')").run();
      await expect(o.prepare("INSERT INTO outcomes (session_id, value, tapped_at, undo_until) VALUES (1,'NOT_FIT','x','y')").run()).rejects.toThrow(); // one answer per session
      await expect(o.prepare("INSERT INTO outcomes (value, tapped_at, undo_until) VALUES ('NOT_FIT','x','y')").run()).rejects.toThrow(); // about something
    } finally {
      await old.close();
    }
  });
});
