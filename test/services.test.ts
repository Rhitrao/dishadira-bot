// Ticket 48: the service catalogue (migration 0021, src/catalogue.ts), Settings → Services (src/services-page.ts), and slots, holds, the
// calendar and Today for services of any allowed length. The 30- and 90-minute services here exist in these tests only. All data synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { DEFAULT_PRICES, KEYS, loadPrices, priceAt, prices, readPrices } from "../src/business";
import { CALL_KEY, catalogue, loadCatalogue, newKey, SESSION_KEY } from "../src/catalogue";
import { config } from "../src/config";
import { copyFor } from "../src/copy";
import { availableSlots, generateSlots, holdSlot } from "../src/slots";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";
import { addPerson, applySql, migrations, newDb } from "./db";

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

// The catalogue and prices in force are module state (read at the start of each request): put back the seeded ones after a test.
async function resetCatalogue() {
  const fresh = await newDb();
  await loadPrices({ DB: fresh.db });
  await fresh.close();
}

// Two services that exist only in these tests: a 30-minute reading and a 90-minute hypnosis session.
async function addTestServices(db: D1Database, o: { tarotCap?: number | null } = {}) {
  await db
    .prepare(
      `INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, daily_cap, active, public, sort) VALUES
       ('tarot_reading', 'Tarot reading', 'टैरो रीडिंग', 'UNDERSTAND', 30, 120000, ?1, 1, 0, 30),
       ('guided_hypnosis', 'Guided hypnosis', 'गाइडेड हिप्नोसिस', 'REWIRE', 90, 250000, NULL, 1, 0, 40)`,
    )
    .bind(o.tarotCap ?? null)
    .run();
  await loadCatalogue(db);
}

describe("migration 0021: the catalogue is seeded with today's offer, and bookings say which service they were", () => {
  it("seeds exactly the ₹99 15-minute call (ENTRY) and the ₹799 60-minute session (RELEASE), both on and offered", async () => {
    const { db, close } = await newDb();
    const rows = (await db.prepare("SELECT key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, daily_cap, active, public FROM services ORDER BY sort").all()).results;
    expect(rows).toEqual([
      { key: CALL_KEY, name_en: "First call", name_hi: "पहली कॉल", pathway: "ENTRY", minutes: 15, price_paise: 9900, needs_call_first: 0, daily_cap: null, active: 1, public: 1 },
      { key: SESSION_KEY, name_en: "Single session", name_hi: "एक सेशन", pathway: "RELEASE", minutes: 60, price_paise: 79900, needs_call_first: 0, daily_cap: null, active: 1, public: 1 },
    ]);
    expect([config.prices.intro, config.prices.single, config.slots.callMinutes, config.slots.sessionMinutes]).toEqual([9900, 79900, 15, 60]);
    // Only 15, 30, 60 or 90 minutes; whole rupees.
    await expect(db.prepare("INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise) VALUES ('x45', 'X', 'X', 'RELEASE', 45, 10000)").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise) VALUES ('x30', 'X', 'X', 'RELEASE', 30, 10050)").run()).rejects.toThrow();
    await close();
  });

  it("carries over the owner's prices from Settings, and back-fills service_key from the kind on existing bookings", async () => {
    const { db, close } = await newDb(20); // before 0021
    await db.prepare("INSERT INTO settings (key, value) VALUES ('price.intro_paise', '14900'), ('price.single_paise', '79950')").run(); // the second is not whole rupees
    const conv = await addPerson(db, "910000000048");
    const call = (await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', '2026-10-05T08:30:00Z', '2026-10-05T08:45:00Z', ?1, 'BOOKED')").bind(conv).run()).meta.last_row_id;
    const ses = (await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('SESSION', '2026-10-06T08:30:00Z', '2026-10-06T09:30:00Z', ?1, 'BOOKED')").bind(conv).run()).meta.last_row_id;
    await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'PAID')").bind(conv, call).run();
    await db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'CONFIRMED')").bind(conv, ses).run();
    await applySql(db, migrations.servicesSql);
    expect((await db.prepare("SELECT price_paise AS p FROM services WHERE key = ?1").bind(CALL_KEY).first<{ p: number }>())!.p).toBe(14900);
    expect((await db.prepare("SELECT price_paise AS p FROM services WHERE key = ?1").bind(SESSION_KEY).first<{ p: number }>())!.p).toBe(79900);
    expect((await db.prepare("SELECT service_key AS k FROM slots ORDER BY id").all<{ k: string }>()).results.map((r) => r.k)).toEqual([CALL_KEY, SESSION_KEY]);
    expect((await db.prepare("SELECT service_key AS k FROM intros").first<{ k: string }>())!.k).toBe(CALL_KEY);
    expect((await db.prepare("SELECT service_key AS k FROM sessions").first<{ k: string }>())!.k).toBe(SESSION_KEY);
    await close();
  });
});

describe("one source of truth: the call's and the session's price and length come from the catalogue, config the fallback", () => {
  let db: D1Database;
  let close: () => Promise<void>;
  beforeEach(async () => ({ db, close } = await newDb()));
  afterEach(async () => {
    await close();
    await resetCatalogue();
  });

  it("readPrices takes the two rows' prices; a missing row falls back to config; the packages stay in settings", async () => {
    await db.prepare("UPDATE services SET price_paise = 14900 WHERE key = ?1").bind(CALL_KEY).run();
    await db.prepare("INSERT INTO settings (key, value) VALUES (?1, '600000')").bind(KEYS.pack10).run();
    let p = await readPrices(db);
    expect([p.intro, p.single, p.pack10.paise, p.pack20.paise]).toEqual([14900, DEFAULT_PRICES.single, 600000, DEFAULT_PRICES.pack20.paise]);
    await db.prepare("DELETE FROM services").run();
    p = await readPrices(db);
    expect([p.intro, p.single]).toEqual([config.prices.intro, config.prices.single]);
    await loadPrices({ DB: db });
    expect(catalogue().map((s) => [s.key, s.minutes, s.pricePaise])).toEqual([
      [CALL_KEY, 15, 9900],
      [SESSION_KEY, 60, 79900],
    ]);
  });

  it("the bot's words are unchanged with the seeded rows, and quote a price changed in the catalogue", async () => {
    const before = copyFor("en");
    await loadPrices({ DB: db });
    expect(copyFor("en")).toEqual(before);
    expect(copyFor("en").btnBook).toBe("Book ₹99 call");
    await db.prepare("UPDATE services SET price_paise = 89900 WHERE key = ?1").bind(SESSION_KEY).run();
    await loadPrices({ DB: db });
    expect(prices().single).toBe(89900);
    expect(copyFor("en").rowSingleDesc).toBe("₹899");
  });
});

describe("slots and holds for services of any allowed length", () => {
  const MON = "2026-10-05";
  const NOW = Date.parse("2026-10-05T06:00:00Z"); // 11:30 am India time, before opening
  const at = (hhmm: string) => new Date(Date.parse(`${MON}T${hhmm}:00+05:30`)).toISOString().slice(0, 19) + "Z";
  let db: D1Database;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await newDb());
    await addTestServices(db);
  });
  afterEach(async () => {
    await close();
    await resetCatalogue();
  });

  it("the generator makes back-to-back slots of each length; today's call and session are as before", () => {
    expect(generateSlots(MON, "CALL")).toHaveLength(20);
    expect(generateSlots(MON, "SESSION")).toHaveLength(5);
    const tarot = generateSlots(MON, "SESSION", "tarot_reading");
    expect(tarot).toHaveLength(10); // a 30-minute reading is not a 60/90-minute session: not limited to 5
    expect(tarot[0]).toEqual({ kind: "SESSION", startUtc: at("14:00"), endUtc: at("14:30") });
    expect(tarot[9].endUtc).toBe(at("19:00"));
    expect(generateSlots(MON, "SESSION", "guided_hypnosis").map((s) => [s.startUtc, s.endUtc])).toEqual([
      [at("14:00"), at("15:30")],
      [at("15:30"), at("17:00")],
      [at("17:00"), at("18:30")],
    ]);
    expect(generateSlots(MON, "CALL", "tarot_reading")).toEqual([]); // a reading is never a CALL slot
    expect(generateSlots(MON, "SESSION", "no_such_service")).toEqual([]);
    expect(generateSlots("2026-10-11", "SESSION", "guided_hypnosis")).toEqual([]); // Sunday
  });

  it("one calendar: a 90-minute hold blocks every overlapping call, session and reading, and the slot records its service and length", async () => {
    const a = await addPerson(db, "910000000101");
    const b = await addPerson(db, "910000000102");
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("15:30"), ownerId: a, nowMs: NOW, service: "guided_hypnosis" })).toMatchObject({ ok: true });
    const row = await db.prepare("SELECT kind, start_utc AS s, end_utc AS e, service_key AS k FROM slots").first();
    expect(row).toEqual({ kind: "SESSION", s: at("15:30"), e: at("17:00"), k: "guided_hypnosis" });
    for (const [kind, start, service] of [["CALL", "16:45", undefined], ["SESSION", "16:00", undefined], ["SESSION", "15:30", "tarot_reading"], ["SESSION", "16:30", "tarot_reading"]] as const)
      expect(await holdSlot(db, { kind, startUtc: at(start), ownerId: b, nowMs: NOW, service }), `${kind} ${start}`).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("17:00"), ownerId: b, nowMs: NOW, service: "tarot_reading" })).toMatchObject({ ok: true });
    const free = (await availableSlots(db, "CALL", MON, NOW)).map((s) => s.startUtc);
    expect(free).toContain(at("15:15"));
    expect(free).not.toContain(at("15:30"));
    expect(free).not.toContain(at("17:15"));
    expect(free).toContain(at("17:30"));
    // A held reading's length comes from its service, not from the kind.
    expect((await db.prepare("SELECT end_utc AS e FROM slots WHERE service_key = 'tarot_reading'").first<{ e: string }>())!.e).toBe(at("17:30"));
    // A time that isn't one of the service's slots, or the wrong kind for it, is not a slot.
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("14:15"), ownerId: b, nowMs: NOW, service: "tarot_reading" })).toEqual({ ok: false, reason: "NOT_A_SLOT" });
    expect(await holdSlot(db, { kind: "CALL", startUtc: at("14:00"), ownerId: b, nowMs: NOW, service: "tarot_reading" })).toEqual({ ok: false, reason: "NOT_A_SLOT" });
  });

  it("the 5-sessions-a-day cap counts 60/90-minute sessions only: not calls, not 30-minute readings", async () => {
    // Five booked 60-minute sessions earlier that day (synthetic rows before opening, so the afternoon is still free).
    const p = await addPerson(db, "910000000103");
    for (let i = 0; i < 5; i++)
      await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, service_key) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED', ?4)").bind(at(`0${i + 1}:00`), at(`0${i + 2}:00`), p, SESSION_KEY).run();
    const c = await addPerson(db, "910000000104");
    expect(await availableSlots(db, "SESSION", MON, NOW)).toEqual([]);
    expect(await availableSlots(db, "SESSION", MON, NOW, NOW, "guided_hypnosis")).toEqual([]);
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("14:00"), ownerId: c, nowMs: NOW })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("14:00"), ownerId: c, nowMs: NOW, service: "guided_hypnosis" })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect((await availableSlots(db, "SESSION", MON, NOW, NOW, "tarot_reading")).length).toBe(10);
    expect((await availableSlots(db, "CALL", MON, NOW)).length).toBe(20);
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("14:00"), ownerId: c, nowMs: NOW, service: "tarot_reading" })).toMatchObject({ ok: true });
    // Four: a session can be held again. The next day is not affected.
    await db.prepare("UPDATE slots SET state = 'HELD', hold_until = ?1 WHERE start_utc = ?2").bind(at("00:00"), at("01:00")).run();
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("15:00"), ownerId: p, nowMs: NOW })).toMatchObject({ ok: true });
    expect((await availableSlots(db, "SESSION", "2026-10-06", NOW)).length).toBe(5);
  });

  it("a service's own daily limit: the third reading of the day is refused, other services are not affected; expired holds don't count", async () => {
    await db.prepare("UPDATE services SET daily_cap = 2 WHERE key = 'tarot_reading'").run();
    await loadCatalogue(db);
    const ids = await Promise.all(["910000000111", "910000000112", "910000000113"].map((w) => addPerson(db, w)));
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("14:00"), ownerId: ids[0], nowMs: NOW, service: "tarot_reading" })).toMatchObject({ ok: true });
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("15:00"), ownerId: ids[1], nowMs: NOW, service: "tarot_reading" })).toMatchObject({ ok: true });
    expect(await availableSlots(db, "SESSION", MON, NOW, NOW, "tarot_reading")).toEqual([]);
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("16:00"), ownerId: ids[2], nowMs: NOW, service: "tarot_reading" })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("16:00"), ownerId: ids[2], nowMs: NOW })).toMatchObject({ ok: true }); // the single session
    // 25 minutes later the first two holds have lapsed (20-minute holds): a reading can be held again.
    const later = NOW + 25 * 60_000;
    expect(await holdSlot(db, { kind: "SESSION", startUtc: at("17:00"), ownerId: ids[0], nowMs: later, service: "tarot_reading" })).toMatchObject({ ok: true });
  });

  it("a new key is made from the English name and never reuses one", () => {
    expect(newKey("Tarot reading (30 min)", [])).toBe("tarot_reading_30_min");
    expect(newKey("Tarot reading", ["tarot_reading"])).toBe("tarot_reading_2");
    expect(newKey("टैरो", [])).toBe("service");
    expect(newKey("A", ["service_a"])).toBe("service_a_2");
  });
});

describe("Settings → Services (owner only)", () => {
  const NOW = Date.parse("2026-10-27T08:00:00Z");
  const h = new ConsoleHarness();
  beforeEach(() => h.start(NOW));
  afterEach(async () => {
    await h.stop();
    await resetCatalogue();
  });
  const page = async (as = OWNER) => decode(await (await h.get("/app/settings/services", as)).text());
  const edit = async (key: string, f: Record<string, string>, as = OWNER) =>
    h.post("/app/settings/services/edit", { csrf: await h.tokenFor(as, `services-edit:${key}`), key, ...f }, as);
  const add = async (f: Record<string, string>) => h.post("/app/settings/services/add", { csrf: await h.tokenFor(OWNER, "services-add"), ...f });
  const row = (key: string) => h.db.prepare("SELECT * FROM services WHERE key = ?1").bind(key).first<Record<string, unknown>>();

  it("lists the two services the bot offers, in English and Hindi; Settings links to it; practitioner and staff are refused", async () => {
    const html = await page();
    for (const t of ["Services", "First call", "Single session", "15 min", "60 min", "₹99", "₹799", "Offered by the bot", "Add a service", "at most 5 sessions"]) expect(html).toContain(t);
    expect(html).not.toContain("<script");
    expect(decode(await (await h.get("/app/settings")).text())).toContain('href="/app/settings/services"');
    for (const as of [PRAC, STAFF]) {
      expect((await h.get("/app/settings/services", as)).status).toBe(403);
      expect((await edit(SESSION_KEY, { name_en: "X", name_hi: "X", price: "1" }, as)).status).toBe(403);
    }
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(OWNER).run();
    const hiPage = await page();
    for (const t of ["सेवाएँ", "पहली कॉल", "एक सेशन", "बॉट ऑफ़र करता है", "नई सेवा जोड़ें"]) expect(hiPage).toContain(t);
  });

  it("every POST needs its own token and the Origin", async () => {
    const f = { key: SESSION_KEY, name_en: "Single session", name_hi: "एक सेशन", price: "899" };
    expect((await h.post("/app/settings/services/edit", { ...f, csrf: "bad" })).status).toBe(403);
    expect((await h.post("/app/settings/services/edit", { ...f, csrf: await h.tokenFor(OWNER, `services-edit:${CALL_KEY}`) })).status).toBe(403); // another row's token
    expect((await h.post("/app/settings/services/edit", { ...f, csrf: await h.tokenFor(OWNER, `services-edit:${SESSION_KEY}`) }, OWNER, { origin: null })).status).toBe(403);
    expect((await h.post("/app/settings/services/add", { name_en: "X", name_hi: "X", pathway: "RELEASE", minutes: "30", price: "100", csrf: "bad" })).status).toBe(403);
    expect((await row(SESSION_KEY))!.price_paise).toBe(79900);
    expect(await h.count("SELECT COUNT(*) AS n FROM services")).toBe(2);
  });

  it("editing the session's price and names: one row, audited (and PRICE_CHANGED for payments); its length and 'on' can't change here", async () => {
    const res = await edit(SESSION_KEY, { name_en: "Healing session", name_hi: "हीलिंग सेशन", price: "₹899", minutes: "60", cap: "4" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/settings/services?m=saved#svc-${SESSION_KEY}`);
    expect(await row(SESSION_KEY)).toMatchObject({ name_en: "Healing session", name_hi: "हीलिंग सेशन", price_paise: 89900, minutes: 60, daily_cap: 4, active: 1, public: 1 });
    expect((await h.audits("SERVICE_UPDATE")).map((a) => [a.target, a.detail])).toEqual([[`service:${SESSION_KEY}`, "name_en; name_hi; price 79900 -> 89900; daily_cap none -> 4"]]);
    expect((await h.audits("PRICE_CHANGED")).map((a) => [a.target, a.detail])).toEqual([[KEYS.single, "79900 -> 89900"]]);
    expect(await priceAt(h.db, "single", "2026-10-01T00:00:00Z")).toBe(79900); // a link made before the change
    expect(await priceAt(h.db, "single", "2099-01-01T00:00:00Z")).toBe(89900); // a link made after it (the audit row has the database's own clock)
    // The prices form on Settings shows the new price; the bot quotes it.
    expect(decode(await (await h.get("/app/settings")).text())).toContain('name="single" inputmode="numeric" pattern="[0-9,]*" required value="899"');
    expect(copyFor("en").rowSingleDesc).toBe("₹899");
    // The length of a service the bot offers: refused; leaving out "active" doesn't turn it off.
    const bad = await edit(SESSION_KEY, { name_en: "Healing session", name_hi: "हीलिंग सेशन", price: "899", minutes: "90" });
    expect(bad.status).toBe(400);
    expect(decode(await bad.text())).toContain("That didn't save");
    expect((await row(SESSION_KEY))!.minutes).toBe(60);
    expect((await edit(CALL_KEY, { name_en: "First call", name_hi: "पहली कॉल", price: "99" })).headers.get("Location")).toContain("m=nothingChanged");
    expect((await row(CALL_KEY))!.active).toBe(1);
    // The audit log names the service.
    expect(decode(await (await h.get("/app/settings/audit")).text())).toContain("Changed a service");
  });

  it("adding a service: it starts off and unoffered, with a key from its name; bad input keeps the form filled", async () => {
    const bad = await add({ name_en: "Tarot reading", name_hi: "", pathway: "ENTRY", minutes: "45", price: "1200.5", cap: "50" });
    expect(bad.status).toBe(400);
    const html = decode(await bad.text());
    expect(html).toContain('value="Tarot reading"');
    expect(html).toContain("Choose a pathway.");
    expect(html).toContain("Choose 15, 30, 60 or 90 minutes.");
    expect(html).toContain("Leave empty, or a whole number from 1 to 20.");
    expect(await h.count("SELECT COUNT(*) AS n FROM services")).toBe(2);

    const ok = await add({ name_en: "Tarot reading", name_hi: "टैरो रीडिंग", pathway: "UNDERSTAND", minutes: "30", price: "1,200", cap: "", call_first: "1", public: "1", active: "1" });
    expect(ok.status).toBe(303);
    expect(await row("tarot_reading")).toMatchObject({ pathway: "UNDERSTAND", minutes: 30, price_paise: 120000, needs_call_first: 1, daily_cap: null, active: 0, public: 0, sort: 30 });
    expect((await h.audits("SERVICE_ADD")).map((a) => [a.target, a.detail])).toEqual([["service:tarot_reading", "UNDERSTAND · 30 min · 120000"]]);
    const list = await page();
    expect(list).toContain("Tarot reading");
    expect(list).toContain("Not offered yet");
    expect(list).toContain("Offered by the bot after launch.");
    // It can be turned on and lengthened, but never offered by the bot from here.
    expect((await edit("tarot_reading", { name_en: "Tarot reading", name_hi: "टैरो रीडिंग", price: "1200", minutes: "90", cap: "2", active: "1", public: "1" })).status).toBe(303);
    expect(await row("tarot_reading")).toMatchObject({ minutes: 90, daily_cap: 2, active: 1, public: 0 });
    // The bot's words don't change.
    expect(copyFor("en").rowIntroTitle).toBe("₹99 first call");
  });
});

describe("the calendar and Today draw 30- and 90-minute bookings", () => {
  const NOW = Date.parse("2026-10-28T08:00:00Z"); // Wed 28 Oct, 1:30 pm India time
  const h = new ConsoleHarness();
  beforeEach(async () => {
    await h.start(NOW);
    await addTestServices(h.db);
  });
  afterEach(async () => {
    await h.stop();
    await resetCatalogue();
  });
  const page = async (path: string) => decode(await (await h.get(path)).text());
  async function booking(o: { name: string; wa: string; ist: string; minutes: number; key: string }) {
    const db = h.db;
    const prac = (await h.member(PRAC))!.id;
    const start = Date.parse(`${o.ist}:00+05:30`);
    const u = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
    const conv = (await db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES (?1, ?2)").bind(o.wa, o.name).run()).meta.last_row_id;
    const slot = (
      await db
        .prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id, service_key) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED', ?4, ?5)")
        .bind(u(start), u(start + o.minutes * 60_000), conv, prac, o.key)
        .run()
    ).meta.last_row_id;
    await db
      .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, practitioner_id, service_key) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', 'SELF', ?3, ?4)")
      .bind(conv, slot, prac, o.key)
      .run();
  }

  it("Week: blocks placed and sized by their length (1.8 px a minute), named by their service; Day, Month and List too", async () => {
    await booking({ name: "Tara Test", wa: "919800000301", ist: "2026-10-29T14:00", minutes: 30, key: "tarot_reading" });
    await booking({ name: "Hari Test", wa: "919800000302", ist: "2026-10-29T17:00", minutes: 90, key: "guided_hypnosis" });
    const week = await page("/app/calendar");
    expect(week).toMatch(/<a class="ev2 session" href="[^"]+" style="top:0.0px;height:52.0px;[^"]*" title="2:00 pm – 2:30 pm · Tara …0301 · Tarot reading · 30 min/); // ticket 49: no "Healing" beside a newer service
    expect(week).toMatch(/<a class="ev2 session" href="[^"]+" style="top:324.0px;height:160.0px;[^"]*" title="5:00 pm – 6:30 pm · Hari …0302 · Guided hypnosis · 90 min/);
    expect(week).toContain('<span class="k">Guided hypnosis</span>'); // the tall block's third line: its service alone (ticket 49)
    const day = await page("/app/calendar?view=day&d=2026-10-29");
    expect(day).toContain("Tarot reading · 30 min");
    expect(day).toContain("Guided hypnosis · 90 min");
    expect(day).toContain("2:30 pm – 5:00 pm"); // the free gap between them
    const month = await page("/app/calendar?view=month&d=2026-10-28");
    expect(month).toContain("Tara · Tarot reading");
    expect(month).toContain("Hari · Guided hypnosis");
    const list = await page("/app/calendar?view=list&d=2026-10-28");
    expect(list).toContain("Tarot reading · 30 min");
    expect(list).toContain("Guided hypnosis · 90 min");
  });

  it("Today: a 30-minute booking today shows its service and length; the call and session keep their words", async () => {
    await booking({ name: "Tara Test", wa: "919800000303", ist: "2026-10-28T16:00", minutes: 30, key: "tarot_reading" });
    const today = await page("/app");
    expect(today).toContain("Tarot reading · 30 min");
  });
});
