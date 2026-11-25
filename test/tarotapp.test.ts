// Ticket 60: logging in by a WhatsApp code (the Android app, or the website from anywhere), and deleting the whole account. The code is
// readable, unbiased and short-lived; the secret stays on the device; the bot ties a code to the chat that sent it, once; a wrong or old
// code still gets the person a login button; "Delete my account" removes every tarot row. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { tarotCodeIn } from "../src/tarot/bot";
import { CODE_MINUTES, isCode, linkCode, MAX_OPEN_CODES, newCodeValue, pollCode, saveProfile, startCode } from "../src/tarot/store";
import { Wa } from "./wa";

vi.setConfig({ testTimeout: 60_000 });
const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());
const ORIGIN = "https://bot.example.test";
const env = () => ({ ...(w.env() as object), TAROT_GAME: "true" }) as never;
const post = (path: string, body: unknown, cookie = "") =>
  app.request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } }, env());
const person = async () => (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(w.newPhone()).run()).meta.last_row_id;

describe("codes", () => {
  it("are eight easy-to-read letters and digits, spread evenly", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 4000; i++) for (const ch of newCodeValue()) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    expect([...seen.keys()].sort().join("")).toBe("23456789ABCDEFGHJKLMNPQRSTUVWXYZ");
    for (const n of seen.values()) expect(Math.abs(n / 1000 - 1)).toBeLessThan(0.15);
    expect(isCode("ABCD2345")).toBe(true);
    for (const bad of ["ABCD234", "ABCD23450", "ABCO2345", "abcd2345", "ABCD1345"]) expect(isCode(bad), bad).toBe(false);
  });
  it("log in once, only with the device's secret, within ten minutes", async () => {
    const id = await person();
    const r = (await startCode(w.db))!;
    expect(await pollCode(w.db, r.code, r.secret)).toBe("waiting");
    expect(await linkCode(w.db, r.code, id)).toBe(true);
    expect(await linkCode(w.db, r.code, await person())).toBe(false); // someone else cannot take it over
    expect(await pollCode(w.db, r.code, "x".repeat(43))).toBe("expired");
    expect(await pollCode(w.db, r.code, r.secret)).toBe(id);
    expect(await pollCode(w.db, r.code, r.secret)).toBe("expired");
    const late = (await startCode(w.db))!;
    expect(await linkCode(w.db, late.code, id, Date.now() + (CODE_MINUTES + 1) * 60_000)).toBe(false);
    expect(await pollCode(w.db, late.code, late.secret, Date.now() + (CODE_MINUTES + 1) * 60_000)).toBe("expired");
    expect(await w.count("SELECT COUNT(*) AS n FROM tarot_codes WHERE secret_hash = '" + r.secret + "'")).toBe(0); // only the hash is kept
  });
  it("stop at a ceiling of open codes", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    await w.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_OPEN_CODES}) INSERT OR IGNORE INTO tarot_codes (code, secret_hash, created_at, expires_at) SELECT printf('Z%07d', i), 'h', ?1, ?2 FROM n`).bind(now, later).run();
    expect(await startCode(w.db)).toBeNull();
  });
  it("are read from the WhatsApp message", () => {
    expect(tarotCodeIn("TAROT ABCD2345")).toBe("ABCD2345");
    expect(tarotCodeIn(" tarot  abcd2345 ")).toBe("ABCD2345");
    expect(tarotCodeIn("टैरो ABCD2345")).toBe("ABCD2345");
    for (const t of ["TAROT", "TAROT ABCD234", "my code is ABCD2345", "TAROT ABCD2345 please"]) expect(tarotCodeIn(t), t).toBeNull();
  });
});

describe("the routes", () => {
  it("hand out a code with a WhatsApp link, and set the session cookie once the bot has seen it", async () => {
    const id = await person();
    const r = (await (await post("/tarot/api/code/start", {})).json()) as { code: string; secret: string; wa: string };
    expect(r.wa).toBe(`https://wa.me/916366199009?text=TAROT%20${r.code}`);
    expect(await (await post("/tarot/api/code/poll", { code: r.code, secret: r.secret })).json()).toEqual({ waiting: true });
    await linkCode(w.db, r.code, id);
    const done = await post("/tarot/api/code/poll", { code: r.code, secret: r.secret });
    expect(await done.json()).toEqual({ ok: true });
    const cookie = done.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    const state = (await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie.split(";")[0] } }, env())).json()) as { in: boolean };
    expect(state.in).toBe(true);
    expect((await post("/tarot/api/code/start", {}, "")).status).toBe(200);
    expect((await app.request(`${ORIGIN}/tarot/api/code/start`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", Origin: "https://evil.example" } }, env())).status).toBe(400);
  });
  it("delete the whole account: details, readings, notes, collection, sessions, codes", async () => {
    const id = await person();
    const r = (await (await post("/tarot/api/code/start", {})).json()) as { code: string; secret: string };
    await linkCode(w.db, r.code, id);
    const cookie = (await post("/tarot/api/code/poll", { code: r.code, secret: r.secret })).headers.get("Set-Cookie")!.split(";")[0];
    await saveProfile(w.db, id, { name: "Asha", dob: "1990-05-15", birthTime: null, tzMinutes: 330, birthPlace: null });
    expect((await post("/tarot/api/start", { kind: "daily", pile: 0 }, cookie)).status).toBe(200);
    expect((await post("/tarot/api/pick", { kind: "daily", picks: [3] }, cookie)).status).toBe(200);
    expect((await post("/tarot/api/account/delete", {}, cookie)).status).toBe(200);
    for (const t of ["tarot_profiles", "tarot_readings", "tarot_seen", "tarot_sessions", "tarot_codes", "tarot_logins"]) expect(await w.count(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ${id}`), t).toBe(0);
    expect(await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie } }, env())).json()).toEqual({ in: false });
    expect(await w.count(`SELECT COUNT(*) AS n FROM conversations WHERE id = ${id}`)).toBe(1); // the WhatsApp chat itself is not part of the game
  });
});

describe("in the chat", () => {
  it("ties the code to the chat and says so; an old code gets the login button instead", async () => {
    w.tarotGame = "true";
    const from = await w.greeted("en");
    const r = (await startCode(w.db))!;
    await w.typed(from, `TAROT ${r.code}`);
    expect(w.last().text.body).toMatch(/^You are logged in/);
    expect(typeof (await pollCode(w.db, r.code, r.secret))).toBe("number");
    await w.typed(from, "TAROT ZZZZ2222");
    expect(w.last().interactive.type).toBe("cta_url");
  });
  it("works as the very first message, after the language tap", async () => {
    w.tarotGame = "true";
    const from = w.newPhone();
    const r = (await startCode(w.db))!;
    await w.typed(from, `TAROT ${r.code}`);
    await w.tap(from, "lang_hi");
    expect(w.last().text.body).toMatch(/^आप लॉग इन हो गए/);
  });
  it("is ignored while the game is off", async () => {
    const from = await w.greeted("en");
    const r = (await startCode(w.db))!;
    await w.typed(from, `TAROT ${r.code}`);
    expect(await pollCode(w.db, r.code, r.secret)).toBe("waiting");
  });
});
