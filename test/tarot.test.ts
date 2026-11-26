// Ticket 57: the tarot game. The deck is complete and well formed; the shuffle is fair over a million cards; the cut and the picks are the
// real deck; the reading rules; the one-time login link and the session cookie; the day's readings cannot be re-rolled; the journal, the
// collection and the streak; the routes (404 while off, posts only from this site); the chat word TAROT; the wipe. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { BY_ID, DECK } from "../src/tarot/deck";
import { isTarotWord } from "../src/tarot/bot";
import { cutDeck, FAN, pickCards, secureBelow, shuffledDeck, summarize, THEMES } from "../src/tarot/reading";
import { finishReading, journal, newLoginLink, newSession, redeemLogin, seenCards, sessionConv, startReading, streak, wipeOldTarot } from "../src/tarot/store";
import { wipePersonStmts } from "../src/wipe";
import { Wa } from "./wa";

const w = new Wa();
const PROFILE = { name: "Asha Kumari", dob: "1990-05-15", birthTime: "06:30", tzMinutes: 330, birthPlace: "Mysuru", consent: true };
beforeEach(() => w.start());
afterEach(() => w.stop());
const DAY = 86_400_000;

describe("the deck", () => {
  it("is the full 78-card deck, each card complete", () => {
    expect(DECK.length).toBe(78);
    expect(new Set(DECK.map((c) => c.id)).size).toBe(78);
    expect(new Set(DECK.map((c) => c.name)).size).toBe(78);
    expect(DECK.filter((c) => c.suit === null).length).toBe(22);
    for (const s of ["wands", "cups", "swords", "pentacles"]) expect(DECK.filter((c) => c.suit === s).map((c) => c.rank)).toEqual([...Array(14)].map((_, i) => i + 1));
    for (const c of DECK) {
      for (const f of [c.meaning, c.reversed, c.love, c.work, c.self, c.ask]) expect(f.trim().length, c.id).toBeGreaterThan(10);
      expect(c.up.length).toBe(3);
      expect(c.rev.length).toBe(3);
      expect(c.ask.endsWith("?"), c.id).toBe(true);
    }
    expect(BY_ID.get("m13")!.meaning).toMatch(/almost never means a physical death/);
  });
  it("never predicts health, pregnancy, death dates or money won", () => {
    const words = /\b(cancer|pregnan|lottery|jackpot|you will die|will marry|guaranteed)\b/i;
    for (const c of DECK) for (const f of [c.meaning, c.reversed, c.love, c.work, c.self]) expect(words.test(f), `${c.id}: ${f}`).toBe(false);
  });
});

describe("the draw", () => {
  it("is fair over a million cards: every card equally likely in every place, and reversed half the time", () => {
    const shuffles = 100_000;
    const firstPlace = new Map<string, number>();
    let cards = 0;
    let reversed = 0;
    for (let i = 0; i < shuffles; i++) {
      const d = shuffledDeck();
      expect(d.length).toBe(78);
      firstPlace.set(d[0].id, (firstPlace.get(d[0].id) ?? 0) + 1);
      for (let k = 0; k < 10; k++) {
        cards++;
        if (d[k].r) reversed++;
      }
    }
    expect(cards).toBe(1_000_000);
    const expected = shuffles / 78;
    const chi = [...DECK].reduce((s, c) => s + ((firstPlace.get(c.id) ?? 0) - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(121); // 77 degrees of freedom: p < 0.001 above about 121
    expect(Math.abs(reversed / cards - 0.5)).toBeLessThan(0.003);
  });
  it("draws each card once per shuffle, and a fixed random source gives a fixed deck", () => {
    const d = shuffledDeck();
    expect(new Set(d.map((x) => x.id)).size).toBe(78);
    expect(shuffledDeck(() => 0)).toEqual(shuffledDeck(() => 0));
    expect(shuffledDeck(() => 0, false).every((x) => !x.r)).toBe(true);
  });
  it("throws away random values that would bias the result", () => {
    const values = [0xffffffff, 7]; // for 3, 0xffffffff is past the last whole run of 3 and must be skipped
    let k = 0;
    expect(secureBelow(3, (buf) => ((buf[0] = values[k++]), buf))).toBe(1);
    expect(k).toBe(2);
  });
  it("cuts the chosen pile to the top and keeps every card", () => {
    const deck = shuffledDeck(() => 0);
    const cut = cutDeck(deck, 2);
    expect(cut[0]).toEqual(deck[52]);
    expect(new Set(cut.map((x) => x.id)).size).toBe(78);
    expect(cutDeck(deck, 0)).toEqual(deck);
    expect(cutDeck(deck, 9)[0]).toEqual(deck[52]);
  });
  it("gives exactly the cards at the picked places in the fan", () => {
    const deck = shuffledDeck();
    expect(pickCards(deck, [3, 0, 21], 3)).toEqual([deck[3], deck[0], deck[21]]);
    for (const bad of [[1, 1, 2], [0, 1], [0, 1, FAN], [-1, 2, 3], [0.5, 1, 2], "1,2,3", null]) expect(pickCards(deck, bad, 3)).toBeNull();
  });
});

describe("the reading", () => {
  it("names a leading suit, repeated numbers, reversals, court cards and elements", () => {
    const lines = summarize([{ id: "cups05", r: true }, { id: "cups13", r: true }, { id: "wands05", r: false }]);
    expect(lines.join(" ")).toMatch(/Most of your cards are about feelings and relationships/);
    expect(lines.join(" ")).toMatch(/The number five comes up more than once/);
    expect(lines.join(" ")).toMatch(/Most cards came out upside down/);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(summarize([{ id: "m00", r: false }, { id: "m13", r: false }, { id: "m21", r: false }])[0]).toMatch(/big .life lesson. cards/);
    expect(summarize([{ id: "wands02", r: false }, { id: "cups03", r: false }, { id: "swords04", r: false }]).join(" ")).toMatch(/pull in different directions/);
    expect(summarize([{ id: "m17", r: true }])[0]).toMatch(/upside down/);
  });
  it("has six to eight questions for each of the three themes", () => {
    for (const t of Object.values(THEMES)) expect(t.questions.length).toBeGreaterThanOrEqual(6), expect(t.questions.length).toBeLessThanOrEqual(8);
  });
});

const DAILY = { kind: "daily", spread: "daily", theme: null, question: null, custom: false, pile: 0 } as const;

describe("login and readings", () => {
  const person = async () => (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(w.newPhone()).run()).meta.last_row_id;
  it("logs in once with a fresh link, never with an old or used one, and keeps only hashes", async () => {
    const id = await person();
    const url = await newLoginLink(w.db, id, "https://bot.example.test/");
    expect(url).toMatch(/^https:\/\/bot\.example\.test\/tarot\/in\?t=[A-Za-z0-9_-]{43}$/);
    const token = url.split("t=")[1];
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_logins WHERE token_hash = '${token}'`)).toBe(0);
    expect(await redeemLogin(w.db, token)).toBe(id);
    expect(await redeemLogin(w.db, token)).toBeNull();
    const late = (await newLoginLink(w.db, id, "https://x.test")).split("t=")[1];
    expect(await redeemLogin(w.db, late, Date.now() + 16 * 60_000)).toBeNull();
    const sid = await newSession(w.db, id);
    expect(await sessionConv(w.db, sid)).toBe(id);
    expect(await sessionConv(w.db, sid, Date.now() + 91 * DAY)).toBeNull();
    await w.db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(id).run();
    expect(await sessionConv(w.db, sid)).toBeNull();
  });
  it("keeps today's reading once picked, fills the collection and counts the streak", async () => {
    const id = await person();
    const now = Date.now();
    expect(await startReading(w.db, id, { kind: "spread", spread: "ppf", theme: "love", question: THEMES.love.questions[0], custom: false, pile: 1 }, false, now)).toBe("started");
    expect(await finishReading(w.db, id, "spread", [0, 0, 1], now)).toBeNull();
    const done = await finishReading(w.db, id, "spread", [4, 9, 13], now);
    expect(done!.cards.length).toBe(3);
    expect(await startReading(w.db, id, { kind: "spread", spread: "sao", theme: "work", question: THEMES.work.questions[0], custom: false, pile: 0 }, false, now)).toBe("done");
    expect(await finishReading(w.db, id, "spread", [1, 2, 3], now)).toBeNull();
    expect((await seenCards(w.db, id)).sort()).toEqual(done!.cards.map((c) => c.id).sort());
    expect(await streak(w.db, id, now)).toBe(1);
    await startReading(w.db, id, DAILY, false, now + DAY);
    await finishReading(w.db, id, "daily", [5], now + DAY);
    expect(await streak(w.db, id, now + DAY)).toBe(2);
    expect(await streak(w.db, id, now + 2 * DAY)).toBe(2); // today not done yet: still counts from yesterday
    expect(await streak(w.db, id, now + 3 * DAY)).toBe(0);
    const j = await journal(w.db, id, now + DAY);
    expect(j.map((x) => x.kind)).toEqual(["daily", "spread"]);
    expect(j[1].spread).toBe("ppf");
    expect(j[1].question).toBe(THEMES.love.questions[0]);
    expect((await journal(w.db, id, now + 8 * DAY)).length).toBe(0);
  });
  it("goes with Remove their data and 90 days after the last reading", async () => {
    const a = await person();
    const b = await person();
    for (const id of [a, b]) {
      await startReading(w.db, id, DAILY);
      await finishReading(w.db, id, "daily", [0]);
      await newSession(w.db, id);
    }
    await w.db.batch(wipePersonStmts(w.db, a, "2026-10-05T00:00:00Z"));
    for (const t of ["tarot_readings", "tarot_seen", "tarot_sessions"]) expect(await w.count(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ${a}`), t).toBe(0);
    await wipeOldTarot(w.db, Date.now() + 89 * DAY);
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_readings WHERE conversation_id = ${b}`)).toBe(1);
    await wipeOldTarot(w.db, Date.now() + 91 * DAY);
    for (const t of ["tarot_readings", "tarot_seen", "tarot_sessions"]) expect(await w.count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
  });
});

describe("the routes", () => {
  const env = (on = "true") => ({ ...(w.env() as object), TAROT_GAME: on }) as never;
  const ORIGIN = "https://bot.example.test";
  const post = (path: string, body: unknown, cookie: string, origin: string | null = ORIGIN) =>
    app.request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Cookie: cookie, ...(origin ? { Origin: origin } : {}) } }, env());
  const login = async () => {
    const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(w.newPhone()).run()).meta.last_row_id;
    const url = await newLoginLink(w.db, id, ORIGIN);
    const res = await app.request(url, {}, env());
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/tarot");
    const set = res.headers.get("Set-Cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\/tarot/);
    return set.split(";")[0];
  };
  it("are a plain 404 while TAROT_GAME is off", async () => {
    for (const p of ["/tarot", "/tarot/app.js", "/tarot/api/state", "/tarot/art/m00.webp"]) expect((await app.request(`${ORIGIN}${p}`, {}, env("false"))).status, p).toBe(404);
  });
  it("serve the page with a strict CSP, the script and the art", async () => {
    const page = await app.request(`${ORIGIN}/tarot`, {}, env());
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toMatch(/script-src 'self'/);
    expect(await page.text()).toMatch(/data-wa="916366199009"/);
    expect((await app.request(`${ORIGIN}/tarot/app.js`, {}, env())).headers.get("Content-Type")).toMatch(/javascript/);
    const art = await app.request(`${ORIGIN}/tarot/art/pentacles14.webp`, {}, env());
    expect(art.status).toBe(200);
    expect(art.headers.get("Content-Type")).toBe("image/webp");
    expect((await app.request(`${ORIGIN}/tarot/art/..%2Fsecret.webp`, {}, env())).status).toBe(404);
  });
  it("send an old link back to the page, and an unknown person sees the login", async () => {
    const res = await app.request(`${ORIGIN}/tarot/in?t=${"a".repeat(43)}`, {}, env());
    expect(res.headers.get("Location")).toBe("/tarot?link=old");
    expect(await (await app.request(`${ORIGIN}/tarot/api/state`, {}, env())).json()).toEqual({ in: false });
  });
  it("run a whole reading for a logged-in person, and refuse posts from other sites", async () => {
    const cookie = await login();
    const ask = { kind: "spread", theme: "love", spread: "ppf", question: 2, pile: 1 };
    expect((await post("/tarot/api/start", ask, cookie)).status).toBe(409); // details first
    expect((await post("/tarot/api/profile", PROFILE, cookie)).status).toBe(200);
    expect((await post("/tarot/api/start", ask, cookie, "https://evil.example")).status).toBe(400);
    expect((await post("/tarot/api/start", ask, cookie, null)).status).toBe(400);
    expect((await post("/tarot/api/start", { ...ask, theme: "money" }, cookie)).status).toBe(400);
    expect((await post("/tarot/api/start", { ...ask, question: THEMES.love.questions.length }, cookie)).status).toBe(400);
    expect((await post("/tarot/api/start", { ...ask, spread: "work_path" }, cookie)).status).toBe(400); // not a love spread
    expect((await post("/tarot/api/start", ask, cookie)).status).toBe(200);
    const pick = await post("/tarot/api/pick", { kind: "spread", picks: [2, 7, 11] }, cookie);
    const r = ((await pick.json()) as { reading: { cards: { position: string; theme: string }[]; summary: string[]; question: string; id: number } }).reading;
    expect(r.cards.map((c) => c.position)).toEqual(["Past", "Present", "Future"]);
    expect(r.cards.every((c) => c.theme.length > 0)).toBe(true);
    expect(r.question).toBe(THEMES.love.questions[2]);
    expect(r.summary.length).toBeGreaterThan(0);
    expect((await post("/tarot/api/start", { kind: "spread", theme: "love", spread: "ppf", question: 0 }, cookie)).status).toBe(402); // ticket 61: the free love reading is used
    expect((await post("/tarot/api/start", { kind: "spread", theme: "work", spread: "sao", question: 0 }, cookie)).status).toBe(200); // career has its own
    expect((await post("/tarot/api/note", { id: r.id, note: "  Feels true about my sister.  " }, cookie)).status).toBe(200);
    const state = (await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie } }, env())).json()) as { in: boolean; streak: number; seen: string[]; today: { spread: { note: string } }; journal: unknown[] };
    expect(state.in).toBe(true);
    expect(state.streak).toBe(1);
    expect(state.seen.length).toBeGreaterThanOrEqual(3); // the reading's three, and today's messages (ticket 61)
    expect(state.today.spread.note).toBe("Feels true about my sister.");
    expect(state.journal.length).toBe(1);
    expect((await post("/tarot/api/logout", {}, cookie)).status).toBe(200);
    expect(await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie } }, env())).json()).toEqual({ in: false });
  });
});

describe("in the chat", () => {
  it("knows the bare word only", () => {
    for (const t of ["TAROT", " tarot ", "Tarot game", "टैरो"]) expect(isTarotWord(t), t).toBe(true);
    for (const t of ["card", "tarot reading for my exam tomorrow", "", "tarots"]) expect(isTarotWord(t), t).toBe(false);
  });
  it("TAROT gets the Open your cards button when the game is on, and the CARD test when it is off", async () => {
    w.tarotGame = "true";
    const from = await w.greeted("en");
    await w.typed(from, "TAROT");
    const msg = w.last();
    expect(msg.interactive.type).toBe("cta_url");
    expect(msg.interactive.action.parameters.display_text).toBe("Open your cards");
    expect(msg.interactive.action.parameters.url).toMatch(/^https:\/\/bot\.example\.test\/tarot\/in\?t=/);
    expect(msg.interactive.body.text).toMatch(/Not advice or prediction/);
    await w.typed(from, "CARD");
    expect(w.last().interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toContain("card_work");
    w.tarotGame = "false";
    const other = await w.greeted("en");
    await w.typed(other, "TAROT");
    expect(w.last().interactive.type).toBe("button");
    expect(await w.count("SELECT COUNT(*) AS n FROM tarot_logins")).toBe(1);
  });
  it("answers TAROT as a first message after the language tap, in Hindi too", async () => {
    w.tarotGame = "true";
    const from = w.newPhone();
    await w.typed(from, "TAROT");
    await w.tap(from, "lang_hi");
    const msg = w.last();
    expect(msg.interactive.type).toBe("cta_url");
    expect(msg.interactive.action.parameters.display_text).toBe("अपने कार्ड खोलें");
  });
});
vi.setConfig({ testTimeout: 60_000 });
