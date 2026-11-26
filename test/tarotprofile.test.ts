// Ticket 58: the tarot game's profile and what it adds. Numerology by hand-worked examples; the Sun and Moon against eclipses and an
// equinox whose times are known to the minute; Greer's birth cards; the Chinese year at Li Chun; the details form; the personal lines;
// spreads per theme in their places; the person's own question (and the ones we will not read); testers' unlimited turns (synthetic
// numbers only); migration 0026 carrying old readings over.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { birthCards, insights, lahiri, moonLongitude, numerology, personalLines, reduce, sunLongitude, type Profile } from "../src/tarot/profile";
import { SPREADS, THEMES } from "../src/tarot/reading";
import { finishReading, getProfile, isTester, newLoginLink, parseProfile, saveProfile, startReading, testerNumbers, wipeOldTarot } from "../src/tarot/store";
import { applySql, migrations, newDb } from "./db";
import { Wa } from "./wa";

vi.setConfig({ testTimeout: 60_000 });
const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());
const DAY = 86_400_000;
const ASHA: Profile = { name: "Asha Kumari", dob: "1990-05-15", birthTime: "06:30", tzMinutes: 330, birthPlace: "Mysuru" };
const gap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

describe("numerology", () => {
  it("works out the numbers by hand", () => {
    const n = numerology(ASHA, "2026-11-25");
    expect(n.lifePath).toBe(3); // 5 + (1+5) + (1+9+9+0 → 19 → 1) = 12 → 3
    expect(n.expression).toBe(3); // A1 S1 H8 A1 K2 U3 M4 A1 R9 I9 = 39 → 12 → 3
    expect(n.soulUrge).toBe(6); // A A U A I = 1+1+3+1+9 = 15 → 6
    expect(n.personality).toBe(6); // S H K M R = 1+8+2+4+9 = 24 → 6
    expect([n.mulank, n.bhagyank]).toEqual([6, 3]);
    expect([n.personalYear, n.personalMonth, n.personalDay]).toEqual([3, 5, 3]); // 5+6+1 → 3; 3+11 → 5; 5+(2+5) → 3
    expect([reduce(29), reduce(38), reduce(29, false), reduce(33), reduce(44)]).toEqual([11, 11, 2, 33, 8]);
    expect(numerology({ ...ASHA, name: "आशा" }, "2026-11-25").expression).toBeNull();
  });
  it("finds the tarot birth cards by Greer's method", () => {
    expect(birthCards("1990-05-15")).toEqual([3]); // 5 + 15 + 1990 = 2010 → 3: the Empress, both cards
    expect(birthCards("1950-10-12")).toEqual([19, 10, 1]); // 1972 → 19 → 10 → 1
    expect(birthCards("1950-12-22")).toEqual([0, 4]); // 1984 → 22: the Fool and the Emperor
    expect(birthCards("1985-03-14")).toEqual([4]); // Greer's own worked example: 2002 → 4
  });
});

describe("the sky", () => {
  it("puts the Sun and Moon where eclipses and the equinox say they were", () => {
    expect(gap(sunLongitude(Date.UTC(2024, 2, 20, 3, 6)), 0)).toBeLessThan(0.05); // March equinox 2024, 03:06 UTC
    const eclipse = Date.UTC(2024, 3, 8, 18, 21); // total solar eclipse, new moon 18:21 UTC
    expect(gap(moonLongitude(eclipse), sunLongitude(eclipse))).toBeLessThan(0.3);
    const lunar = Date.UTC(2025, 2, 14, 6, 55); // total lunar eclipse, full moon 06:55 UTC
    expect(gap(moonLongitude(lunar), sunLongitude(lunar) + 180)).toBeLessThan(0.3);
    expect(lahiri(Date.UTC(2026, 0, 1))).toBeGreaterThan(24.1);
    expect(lahiri(Date.UTC(2026, 0, 1))).toBeLessThan(24.3);
  });
  it("gives a whole profile across the arts, honest about what it cannot know", () => {
    const ins = insights(ASHA, Date.UTC(2026, 10, 25, 6), "2026-11-25");
    const arts = Object.fromEntries(ins.arts.map((a) => [a.art, a]));
    expect(Object.keys(arts)).toEqual(["Numerology", "Western astrology", "Vedic astrology (Jyotish)", "Chinese astrology", "Tarot birth cards"]);
    expect(arts["Western astrology"].items[0].value).toBe("Taurus");
    expect(arts["Chinese astrology"].items[0].value).toBe("Metal Horse");
    expect(arts["Tarot birth cards"].items).toEqual([expect.objectContaining({ label: "Personality and Soul card", value: "The Empress" })]);
    expect(arts["Vedic astrology (Jyotish)"].items[1].value).toMatch(/, pada [1-4]$/);
    expect(ins.today[0]).toMatch(/^Today is a Personal Day 3 for you/);
    const noTime = insights({ ...ASHA, birthTime: null }, Date.now(), "2026-11-25");
    expect(noTime.arts[2].note).toMatch(/Add your birth time/);
    expect(insights({ ...ASHA, dob: "1990-01-20" }, Date.now(), "2026-11-25").arts[3].items[0].value).toBe("Earth Snake"); // before Li Chun: still 1989
  });
});

describe("the details form", () => {
  const ok = { name: "  Asha   Kumari ", dob: "1990-05-15", birthTime: "", tzMinutes: 330, birthPlace: "", consent: true };
  it("keeps what is given and refuses what does not make sense", () => {
    expect(parseProfile(ok)).toEqual({ name: "Asha Kumari", dob: "1990-05-15", birthTime: null, tzMinutes: 330, birthPlace: null, email: null });
    expect(parseProfile({ ...ok, consent: false })).toEqual({ error: "consent" });
    expect(parseProfile({ ...ok, dob: "2023-02-30" })).toEqual({ error: "dob" });
    expect(parseProfile({ ...ok, dob: "2015-01-01" })).toEqual({ error: "age" });
    expect(parseProfile({ ...ok, birthTime: "25:00" })).toEqual({ error: "time" });
    expect(parseProfile({ ...ok, tzMinutes: 333 })).toEqual({ error: "tz" });
    expect(parseProfile({ ...ok, name: "" })).toEqual({ error: "name" });
  });
});

describe("spreads", () => {
  it("every theme has its own spreads, each position placed, none on top of another except the crossing card", () => {
    for (const t of Object.values(THEMES)) {
      expect(t.spreads.length).toBeGreaterThanOrEqual(4);
      for (const id of t.spreads) {
        const ps = SPREADS[id].positions;
        const spots = ps.filter((p) => !("cross" in p)).map((p) => `${p.x},${p.y}`);
        expect(new Set(spots).size, id).toBe(spots.length);
        expect(ps.length).toBeLessThanOrEqual(10);
      }
    }
    expect(SPREADS.celtic.positions.length).toBe(10);
  });
});

describe("personal lines", () => {
  it("name a birth card, the Sun sign's card, the Personal Day and a card that keeps returning", () => {
    const ins = insights(ASHA, Date.now(), "2026-11-25"); // birth card the Empress (3); Taurus → the Hierophant (5); Personal Day 3
    const lines = personalLines([{ id: "m03", r: false }, { id: "m05", r: true }, { id: "cups07", r: false }], ins, [{ id: "cups07", r: true }]);
    expect(lines[0]).toMatch(/The Empress is one of your birth cards/);
    expect(lines[1]).toMatch(/The Hierophant is the card of your Sun sign, Taurus/);
    expect(lines[2]).toMatch(/Personal Day number, 3/);
    expect(lines.length).toBe(3);
    expect(personalLines([{ id: "cups07", r: false }], null, [{ id: "cups07", r: false }, { id: "cups07", r: false }])[0]).toMatch(/3 times this month/);
    expect(personalLines([{ id: "swords02", r: false }], ins, [])).toEqual([expect.stringMatching(/^Read this on your Personal Day 3/)]); // nothing matched: today's number still frames it
    expect(personalLines([{ id: "swords02", r: false }], null, [])).toEqual([]);
  });
});

describe("testers", () => {
  it("reads the secret's numbers, adding India's 91 to ten-digit ones", () => {
    expect([...testerNumbers("98765 00001, +91-98765-00002,abc, 4479460000")]).toEqual(["919876500001", "919876500002", "914479460000"]);
    expect(testerNumbers(undefined).size).toBe(0);
  });
  it("lets a tester draw again the same day, and no one else", async () => {
    const tester = w.newPhone();
    const other = w.newPhone();
    const ids: number[] = [];
    for (const p of [tester, other]) ids.push((await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(p).run()).meta.last_row_id);
    const secret = `${tester}`;
    expect(await isTester(w.db, ids[0], secret)).toBe(true);
    expect(await isTester(w.db, ids[1], secret)).toBe(false);
    const daily = { kind: "daily", spread: "daily", theme: null, question: null, custom: false, pile: 0 } as const;
    for (const [id, unlimited] of [[ids[0], true], [ids[1], false]] as const) {
      await startReading(w.db, id, daily, unlimited);
      await finishReading(w.db, id, "daily", [0]);
    }
    expect(await startReading(w.db, ids[0], daily, true)).toBe("started");
    expect((await finishReading(w.db, ids[0], "daily", [1]))!.row.n).toBe(2);
    expect(await startReading(w.db, ids[1], daily, false)).toBe("done");
  });
});

describe("the routes", () => {
  const ORIGIN = "https://bot.example.test";
  const env = (testers = "") => ({ ...(w.env() as object), TAROT_GAME: "true", TAROT_TESTERS: testers }) as never;
  const post = (path: string, body: unknown, cookie: string, testers = "") =>
    app.request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN } }, env(testers));
  const login = async (phone = w.newPhone()) => {
    const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(phone).run()).meta.last_row_id;
    const res = await app.request(await newLoginLink(w.db, id, ORIGIN), {}, env());
    return { id, cookie: res.headers.get("Set-Cookie")!.split(";")[0] };
  };
  const state = async (cookie: string) => (await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie } }, env())).json()) as Record<string, any>;
  const PROFILE = { name: "Asha Kumari", dob: "1990-05-15", birthTime: "06:30", tzMinutes: 330, birthPlace: "Mysuru", consent: true };

  it("ask for details first, then show the profile on the home screen, and delete it on request", async () => {
    const { id, cookie } = await login();
    expect((await state(cookie)).profile).toBeNull();
    expect((await post("/tarot/api/profile", { ...PROFILE, dob: "2012-01-01" }, cookie)).status).toBe(400);
    expect((await post("/tarot/api/profile", PROFILE, cookie)).status).toBe(200);
    const s = await state(cookie);
    expect(s.insights.firstName).toBe("Asha");
    expect(s.insights.today.length).toBeGreaterThanOrEqual(3);
    expect(s.insights.arts.length).toBe(5);
    expect(s.themes.love.spreads.map((x: { id: string }) => x.id)).toEqual(THEMES.love.spreads);
    expect((await post("/tarot/api/profile/delete", {}, cookie)).status).toBe(200);
    expect(await getProfile(w.db, id)).toBeNull();
  });
  it("read for the person's own question in any spread of the theme, and turn away the questions we do not read", async () => {
    const { cookie } = await login();
    await post("/tarot/api/profile", PROFILE, cookie);
    for (const [q, why] of [["I want to end my life", "crisis"], ["Will I get pregnant this year?", "predict"], ["Is there black magic on my family?", "spell"]] as const) {
      const r = await post("/tarot/api/check", { own: q }, cookie);
      expect(r.status, q).toBe(422);
      expect(((await r.json()) as { error: string }).error).toBe(why);
      expect((await post("/tarot/api/start", { kind: "spread", theme: "love", spread: "ppf", own: q }, cookie)).status).toBe(422);
    }
    expect((await post("/tarot/api/check", { own: "ok" }, cookie)).status).toBe(400);
    const own = "How can I feel closer to my sister?";
    expect((await post("/tarot/api/check", { own }, cookie)).status).toBe(200);
    expect((await post("/tarot/api/start", { kind: "spread", theme: "love", spread: "love_bond", own, pile: 2 }, cookie)).status).toBe(200);
    const r = (await (await post("/tarot/api/pick", { kind: "spread", picks: [0, 3, 6, 9, 12] }, cookie)).json()) as { reading: Record<string, any> };
    expect(r.reading.question).toBe(own);
    expect(r.reading.custom).toBe(true);
    expect(r.reading.cards.map((c: { position: string }) => c.position)).toEqual(["You", "The bond", "Them", "What helps", "What blocks"]);
    expect(Array.isArray(r.reading.personal)).toBe(true);
  });
  it("give testers as many turns as they like, and everyone else one of each a day", async () => {
    const phone = w.newPhone();
    const { cookie } = await login(phone);
    await post("/tarot/api/profile", PROFILE, cookie, phone);
    for (let i = 0; i < 3; i++) {
      expect((await post("/tarot/api/start", { kind: "daily", pile: 0 }, cookie, phone)).status).toBe(200);
      expect((await post("/tarot/api/pick", { kind: "daily", picks: [i] }, cookie, phone)).status).toBe(200);
    }
    expect((await post("/tarot/api/start", { kind: "daily", pile: 0 }, cookie, "")).status).toBe(409);
  });
});

describe("the data", () => {
  it("migration 0026 carries old readings over as spreads", async () => {
    const { db, close } = await newDb(25);
    try {
      const id = (await db.prepare("INSERT INTO conversations (wa_id) VALUES ('919800000001')").run()).meta.last_row_id;
      await db.prepare("INSERT INTO tarot_readings (conversation_id, day, kind, theme, question, cards, created_at, done_at) VALUES (?1, '2026-11-24', 'ppf', 'love', 'Q?', '[]', 'x', 'x')").bind(id).run();
      await db.prepare("INSERT INTO tarot_readings (conversation_id, day, kind, cards, created_at, done_at) VALUES (?1, '2026-11-24', 'daily', '[]', 'x', 'x')").bind(id).run();
      await applySql(db, migrations.tarotProfileSql);
      const rows = (await db.prepare("SELECT kind, spread, n, custom FROM tarot_readings ORDER BY id").all()).results;
      expect(rows).toEqual([{ kind: "spread", spread: "ppf", n: 1, custom: 0 }, { kind: "daily", spread: "daily", n: 1, custom: 0 }]);
    } finally {
      await close();
    }
  });
  it("profiles go 90 days after the last visit", async () => {
    const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(w.newPhone()).run()).meta.last_row_id;
    await saveProfile(w.db, id, ASHA);
    await wipeOldTarot(w.db, Date.now() + 89 * DAY);
    expect(await getProfile(w.db, id)).not.toBeNull();
    await wipeOldTarot(w.db, Date.now() + 91 * DAY);
    expect(await getProfile(w.db, id)).toBeNull();
  });
});
