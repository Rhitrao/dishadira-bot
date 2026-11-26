// Ticket 61: the home screen's themes with today's message, the first free reading in each theme and then a pass, deleting history, the
// tester PIN login, the love readings, and the page's own pieces (top bar, safe area, voice). Synthetic data only; no real numbers or PINs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { SPREADS, THEMES } from "../src/tarot/reading";
import { APP_JS, pageHtml } from "../src/tarot/page";
import { deleteHistory, linkCode, pinLogin, PIN_TRIES, saveProfile, startCode, tarotWipeStmts, themeAccess, todayMessages } from "../src/tarot/store";
import { Wa } from "./wa";

vi.setConfig({ testTimeout: 120_000 });
const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());
const ORIGIN = "https://bot.example.test";
let extra: Record<string, string> = {};
const env = () => ({ ...(w.env() as object), TAROT_GAME: "true", ...extra }) as never;
const post = (path: string, body: unknown, cookie = "") =>
  app.request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } }, env());
const state = async (cookie: string) => (await (await app.request(`${ORIGIN}/tarot/api/state`, { headers: { Cookie: cookie } }, env())).json()) as Record<string, any>;
async function personIn(phone = w.newPhone()): Promise<{ id: number; cookie: string; phone: string }> {
  const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(phone).run()).meta.last_row_id;
  const r = (await (await post("/tarot/api/code/start", {})).json()) as { code: string; secret: string };
  await linkCode(w.db, r.code, id);
  const cookie = (await post("/tarot/api/code/poll", { code: r.code, secret: r.secret })).headers.get("Set-Cookie")!.split(";")[0];
  await saveProfile(w.db, id, { name: "Asha", dob: "1990-05-15", birthTime: null, tzMinutes: 330, birthPlace: null });
  return { id, cookie, phone };
}
const read = async (cookie: string, theme: string, spread: string) => {
  const s = await post("/tarot/api/start", { kind: "spread", theme, spread, question: 0, pile: 1 }, cookie);
  if (s.status !== 200) return s.status;
  const picks = Array.from({ length: SPREADS[spread as keyof typeof SPREADS].positions.length }, (_, i) => i);
  return (await post("/tarot/api/pick", { kind: "spread", picks }, cookie)).status;
};
beforeEach(() => (extra = {}));

describe("today's message in each theme", () => {
  it("is one card per theme per day, the same all day, and joins the collection", async () => {
    const { id } = await personIn();
    const now = Date.UTC(2026, 10, 26, 6);
    const a = await todayMessages(w.db, id, now);
    expect(Object.keys(a).sort()).toEqual(["love", "self", "work"]);
    expect(await todayMessages(w.db, id, now + 3_600_000)).toEqual(a);
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_messages WHERE conversation_id = ${id}`)).toBe(3);
    await todayMessages(w.db, id, now + 86_400_000);
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_messages WHERE conversation_id = ${id}`)).toBe(6);
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_seen WHERE conversation_id = ${id}`)).toBeGreaterThanOrEqual(1);
  });
  it("comes with the home screen's state, with each theme's free or pass status", async () => {
    const { cookie } = await personIn();
    const s = await state(cookie);
    expect(s.access).toEqual({ love: "free", work: "free", self: "free" });
    expect(s.messages.love).toMatchObject({ id: expect.any(String), name: expect.any(String), theme: expect.any(String) });
    expect(s.pass).toBeNull();
  });
});

describe("free readings and passes", () => {
  it("gives one free reading in each theme, then asks for a pass; the daily card stays free", async () => {
    const { id, cookie } = await personIn();
    expect(await read(cookie, "love", "love_heart")).toBe(200);
    expect(await read(cookie, "work", "sao")).toBe(200); // the same day: career has its own free reading
    expect(await read(cookie, "love", "ppf")).toBe(402);
    expect((await state(cookie)).access).toEqual({ love: "locked", work: "locked", self: "free" });
    expect((await post("/tarot/api/start", { kind: "daily", pile: 0 }, cookie)).status).toBe(200);
    // A pass opens every theme until it ends.
    const now = Date.now();
    await w.db.prepare("INSERT INTO tarot_passes (conversation_id, plan, starts_at, ends_at, source, created_at) VALUES (?1, 'p33', ?2, ?3, 'gift', ?2)").bind(id, new Date(now - 1000).toISOString(), new Date(now + 86_400_000).toISOString()).run();
    expect(await read(cookie, "love", "love_months")).toBe(200);
    expect(await themeAccess(w.db, id, false, now + 2 * 86_400_000)).toEqual({ love: "locked", work: "locked", self: "free" });
  });
  it("keeps the free-reading record when the history is deleted", async () => {
    const { id, cookie } = await personIn();
    expect(await read(cookie, "self", "self_mbs")).toBe(200);
    await todayMessages(w.db, id);
    expect((await post("/tarot/api/history/delete", {}, cookie)).status).toBe(200);
    for (const t of ["tarot_readings", "tarot_messages"]) expect(await w.count(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ${id}`), t).toBe(0);
    expect(await w.count(`SELECT COUNT(*) AS n FROM tarot_profiles WHERE conversation_id = ${id}`)).toBe(1);
    expect(await read(cookie, "self", "ppf")).toBe(402);
  });
  it("lets testers read without limit", async () => {
    const phone = w.newPhone();
    extra = { TAROT_TESTERS: phone };
    const { id, cookie } = await personIn(phone);
    for (let i = 0; i < 3; i++) expect(await read(cookie, "love", "ppf")).toBe(200);
    expect(await themeAccess(w.db, id, true)).toEqual({ love: "tester", work: "tester", self: "tester" });
  });
  it("are wiped with the account", async () => {
    const { id, cookie } = await personIn();
    expect(await read(cookie, "love", "ppf")).toBe(200);
    await w.db.batch(tarotWipeStmts(w.db, id));
    for (const t of ["tarot_messages", "tarot_free", "tarot_passes", "tarot_readings"]) expect(await w.count(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ${id}`), t).toBe(0);
    await deleteHistory(w.db, id); // nothing left: no error
  });
});

describe("the tester PIN", () => {
  it("is off unless the secret is set", async () => {
    expect((await post("/tarot/api/tester-login", { phone: "9000000001", pin: "0000" })).status).toBe(404);
    expect(APP_JS).toContain("tester-login");
    expect(pageHtml("910000000000")).toContain('data-pin=""');
    expect(pageHtml("910000000000", true)).toContain('data-pin="1"');
  });
  it("logs in only a tester with the right PIN, and stops after five wrong tries", async () => {
    const phone = w.newPhone();
    const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(phone).run()).meta.last_row_id;
    const other = w.newPhone();
    await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(other).run();
    const testers = new Set([phone]);
    expect(await pinLogin(w.db, phone, "4826", testers, "4826")).toBe(id);
    expect(await pinLogin(w.db, other, "4826", testers, "4826")).toBe("no"); // not a tester
    expect(await pinLogin(w.db, phone, "4826", testers, undefined)).toBe("no"); // no secret
    expect(await pinLogin(w.db, phone, "48", testers, "48")).toBe("no"); // too short to be a PIN
    for (let i = 0; i < PIN_TRIES; i++) expect(await pinLogin(w.db, phone, "0000", testers, "4826")).toBe("no");
    expect(await pinLogin(w.db, phone, "4826", testers, "4826")).toBe("wait");
    expect(await pinLogin(w.db, phone, "4826", testers, "4826", Date.now() + 16 * 60_000)).toBe(id);
  });
  it("sets the session cookie through the route", async () => {
    const phone = w.newPhone();
    await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(phone).run();
    extra = { TAROT_TESTERS: phone, TAROT_TESTER_PIN: "4826" };
    expect((await post("/tarot/api/tester-login", { phone, pin: "1234" })).status).toBe(403);
    const ok = await post("/tarot/api/tester-login", { phone, pin: "4826" });
    expect(ok.status).toBe(200);
    expect((await state(ok.headers.get("Set-Cookie")!.split(";")[0])).in).toBe(true);
  });
});

describe("details and love readings", () => {
  it("keep an optional email, checked", async () => {
    const { id, cookie } = await personIn();
    const base = { name: "Asha", dob: "1990-05-15", birthTime: "", tzMinutes: 330, birthPlace: "", consent: true };
    expect((await post("/tarot/api/profile", { ...base, email: "not an email" }, cookie)).status).toBe(400);
    expect((await post("/tarot/api/profile", { ...base, email: " Asha@Example.com " }, cookie)).status).toBe(200);
    expect((await w.db.prepare("SELECT email FROM tarot_profiles WHERE conversation_id = ?1").bind(id).first<{ email: string }>())!.email).toBe("asha@example.com");
    expect((await post("/tarot/api/profile", { ...base, email: "" }, cookie)).status).toBe(200);
  });
  it("offer the partner's-heart and three-month readings, framed as possibilities and energies", () => {
    expect(THEMES.love.spreads.slice(0, 2)).toEqual(["love_heart", "love_months"]);
    expect(SPREADS.love_heart.positions.map((p) => p.name)).toEqual(["Their feelings", "Their intention", "Their message", "Your heart"]);
    expect(SPREADS.love_heart.positions[0].frame).toMatch(/not a certainty/);
    for (const p of SPREADS.love_months.positions.slice(1, 4)) expect(p.frame).toMatch(/energy/);
    for (const q of Object.values(THEMES).flatMap((t) => t.questions)) expect(q, q).not.toMatch(/\bwill (he|she|they)\b|come back|marry|cheat/i);
  });
});

describe("the page", () => {
  it("keeps clear of the phone's status bar, has a big back button, and stops the voice when hidden", () => {
    const html = pageHtml("910000000000");
    expect(html).toContain("env(safe-area-inset-top)");
    expect(html).toMatch(/\.back\{[^}]*min-height:48px/);
    expect(APP_JS).toContain('"visibilitychange"');
    expect(APP_JS).toContain("function voiceBlob");
    expect(APP_JS).not.toContain("showThemes");
    expect(APP_JS).not.toMatch(/`|\$\{/);
  });
});
