import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { requestHuman } from "../src/handoff";
import { sendAlerts } from "../src/mail";
import { digestText } from "../src/report";
import { runCrisis } from "../src/safety";
import { appPathFor, consoleLink } from "../src/switchover";
import { addPerson, newDb } from "./db";

// Ticket 25: with CONSOLE_V2 on, the old pages send people to /app and emails link to /app; off, everything is as before.
// All data is synthetic. Access and email are mocked: nothing real is called.
const NOW = Date.parse("2026-10-05T10:00:00Z"); // Mon 15:30 IST
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const OWNER = "owner@example.test";
const PRAC = "practitioner@example.test";
let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let emails: { to: string; subject: string; text: string }[];

const env = (on: boolean, o: Record<string, unknown> = {}) =>
  ({
    DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: on ? "true" : "false",
    NEW_BOOKINGS: "true", SENDS: "false", PUBLIC_URL: ORIGIN, DIGEST_TO: "ops@example.test", CHAT_RETENTION_MINUTES: "10080",
    EMAIL: { send: async (m: (typeof emails)[number]) => void emails.push(m) },
    ...o,
  }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  emails = [];
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/cdn-cgi/access/certs") ? jwks : {}), { status: 200 })));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(AUD).setIssuedAt().setExpirationTime("1h").sign(priv);
const get = async (path: string, e: unknown, who = OWNER) => app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await token(who) } }, e as never);
const post = async (path: string, form: Record<string, string>, e: unknown, who = OWNER) =>
  app.request(ORIGIN + path, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await token(who), "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams(form).toString(),
  }, e as never);
let wa = 919200000000;
const person = async (name = "Test Person") => {
  const id = await addPerson(db, String(++wa));
  await db.prepare("UPDATE conversations SET display_name = ?2, last_user_at = ?3 WHERE id = ?1").bind(id, name, "2026-10-05T09:00:00Z").run();
  return id;
};
// The path (and query) an absolute email link points to.
const pathOf = (link: string) => link.slice(ORIGIN.length);
const linkIn = (text: string) => /https:\/\/bot\.example\.test\S*/.exec(text)![0];

describe("the old pages with CONSOLE_V2 on", () => {
  it("each old page redirects (302) to its /app page", async () => {
    const conv = await person();
    const cases: [string, string][] = [
      ["/admin", "/app"],
      ["/admin/", "/app"],
      ["/admin?m=sent", "/app"], // the old flash codes mean nothing in /app
      ["/admin/people", "/app/people"],
      ["/admin/people?f=human&q=Pri", "/app/people?q=Pri&f=waiting"],
      ["/admin/people?f=blocked", "/app/people?f=blocked"],
      ["/admin/people?f=crisis&q=4321", "/app/people?q=4321"], // no "crisis" filter in /app: dropped, the search kept
      [`/admin/conv/${conv}`, `/app/people/${conv}`],
      [`/admin/conv/${conv}?m=cleared`, `/app/people/${conv}`],
      ["/admin/payments", "/app/payments"],
      ["/admin/no-such-page", "/app"],
      ["/amma", "/app"],
      ["/amma/", "/app"],
      ["/amma/confirm?intro=3&v=SESSION", "/app"],
      ["/amma/anything", "/app"],
    ];
    for (const [from, to] of cases) {
      const res = await get(from, env(true));
      expect(res.status, from).toBe(302);
      expect(res.headers.get("Location"), from).toBe(to);
    }
  });

  it("redirects without needing the old sign-in (the /app page checks the member itself)", async () => {
    const res = await app.request(`${ORIGIN}/admin/payments`, {}, env(true));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/payments");
  });

  it("the package refund page goes to the buyer's person page", async () => {
    const conv = await person();
    const pk = await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(conv).run();
    expect((await get(`/admin/pack-refund/${pk.meta.last_row_id}`, env(true))).headers.get("Location")).toBe(`/app/people/${conv}`);
    expect((await get("/admin/pack-refund/9999", env(true))).headers.get("Location")).toBe("/app/people");
  });

  it("an old POST changes nothing and says the console moved, with a link", async () => {
    for (const path of ["/admin/switch", "/admin/reply", "/admin/block", "/amma/outcome", "/amma/undo"]) {
      const res = await post(path, { name: "SENDS", v: "off", csrf: "x" }, env(true), path.startsWith("/amma") ? PRAC : OWNER);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      const page = await res.text();
      expect(page).toContain("The console has moved");
      expect(page).toContain('href="/app"');
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'switch:%'").first<{ n: number }>())!.n).toBe(0);
  });

  it("does not touch /app, the webhooks or /health", async () => {
    expect((await app.request(`${ORIGIN}/health`, {}, env(true))).status).toBe(200);
    expect((await get("/app", env(true))).status).toBe(200);
    expect((await app.request(`${ORIGIN}/administrator`, {}, env(true))).status).toBe(404); // only /admin and /admin/…
  });
});

describe("the old pages with CONSOLE_V2 off (the rollback)", () => {
  it("they work exactly as before: no redirect, the old sign-in, the old pages", async () => {
    for (const v of ["false", undefined]) {
      const e = env(false, { CONSOLE_V2: v });
      expect((await get("/admin", e)).status).toBe(200);
      expect((await get("/admin/people?f=human", e)).status).toBe(200);
      expect((await get("/admin/payments", e)).status).toBe(200);
      expect((await get("/amma", e, PRAC)).status).toBe(200);
      expect((await app.request(`${ORIGIN}/admin`, {}, e)).status).toBe(403); // still the old Access check
      expect((await get("/app", e)).status).toBe(404);
    }
  });

  it("an old POST still works", async () => {
    const e = env(false);
    const page = await (await get("/admin", e)).text();
    const form = /<form method="post" action="\/admin\/switch">([\s\S]*?)<\/form>/.exec(page)![1];
    const fields: Record<string, string> = {};
    for (const h of form.matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields[h[1]] = h[2];
    const res = await post("/admin/switch", fields, e);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin?m=switched");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("email links follow the switch", () => {
  it("the mapping and the link helper", () => {
    expect(appPathFor("/admin/conv/7")).toBe("/app/people/7");
    expect(consoleLink({ CONSOLE_V2: "true", PUBLIC_URL: ORIGIN }, "/admin/conv/7")).toBe(`${ORIGIN}/app/people/7`);
    expect(consoleLink({ CONSOLE_V2: "false", PUBLIC_URL: ORIGIN }, "/admin/conv/7")).toBe(`${ORIGIN}/admin/conv/7`);
    expect(consoleLink({ PUBLIC_URL: ORIGIN }, "/admin/conv/7", "/app/inbox/7")).toBe(`${ORIGIN}/admin/conv/7`);
  });

  it("the crisis email", async () => {
    for (const on of [false, true]) {
      emails = [];
      const conv = await person();
      await runCrisis(env(on), { id: conv, locale: "en", consent_at: null }, `wamid.crisis${conv}`, "synthetic crisis words");
      expect(emails).toHaveLength(1);
      expect(emails[0].text).toBe(`A crisis message arrived. Open ${ORIGIN}${on ? "/app/people" : "/admin/conv"}/${conv} now.`);
    }
  });

  it("the handover email opens the chat in the Inbox", async () => {
    for (const on of [false, true]) {
      emails = [];
      const conv = await person();
      await db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(conv).run();
      await requestHuman(env(on), conv, NOW);
      expect(emails).toHaveLength(1);
      expect(emails[0].text).toBe(`A customer asked to talk to a person. Open ${ORIGIN}${on ? "/app/inbox" : "/admin/conv"}/${conv}`);
    }
  });

  it("the daily summary's follow-up links", async () => {
    const conv = await person("Priya Sharma");
    await db.prepare("INSERT INTO person_state (conversation_id, book_tap_at) VALUES (?1, ?2)").bind(conv, "2026-10-05T08:00:00Z").run();
    expect(await digestText(env(false), NOW)).toContain(`- Priya · ${ORIGIN}/admin/conv/${conv}`);
    expect(await digestText(env(true), NOW)).toContain(`- Priya · ${ORIGIN}/app/people/${conv}`);
  });

  it("health alerts: each payment's link and the page to act on", async () => {
    await db.prepare("INSERT INTO attention (kind, target) VALUES ('REFUND_FAILED', 'payment:12')").run();
    await db.prepare("INSERT INTO attention (kind, target) VALUES ('OUTCOME_FAILED', 'intro:3')").run();
    await sendAlerts(env(false), NOW);
    const off = emails.map((m) => m.text);
    expect(off[0]).toContain(`- payment:12 · ${ORIGIN}/admin/payments`);
    expect(off[0]).toContain(`Open ${ORIGIN}/admin to act.`);
    expect(off[1]).toContain("- intro:3\n");
    expect(off[1]).toContain(`Open ${ORIGIN}/admin to act.`);
    emails = [];
    await db.prepare("DELETE FROM settings WHERE key LIKE 'alert:%'").run(); // one alert per kind per day: allow them again
    await sendAlerts(env(true), NOW);
    const on = emails.map((m) => m.text);
    expect(on[0]).toContain(`- payment:12 · ${ORIGIN}/app/payments/12`);
    expect(on[0]).toContain(`Open ${ORIGIN}/app/payments to act.`);
    expect(on[1]).toContain(`Open ${ORIGIN}/app to act.`);
    for (const t of on) expect(t).not.toContain("/admin");
  });

  it("an old email link lands on the right /app page", async () => {
    const conv = await person();
    const e = env(true);
    await runCrisis(e, { id: conv, locale: "en", consent_at: null }, "wamid.crisis-land", "synthetic crisis words");
    const res = await get(pathOf(linkIn(emails[0].text)), e);
    expect(res.status).toBe(200);
    // A link from an email sent before the switch (the old page) redirects to the same person's page, which opens.
    const old = await get(`/admin/conv/${conv}`, e);
    expect(old.headers.get("Location")).toBe(`/app/people/${conv}`);
    expect((await get(old.headers.get("Location")!, e)).status).toBe(200);
    // The handed-over chat opens in the Inbox.
    const other = await person();
    await db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(other).run();
    emails = [];
    await requestHuman(e, other, NOW);
    expect((await get(pathOf(linkIn(emails[0].text)), e)).status).toBe(200);
  });
});
