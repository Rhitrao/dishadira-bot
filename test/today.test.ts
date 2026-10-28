import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { memberCsrf, type Member } from "../src/auth";
import { bookingChoice } from "../src/booking";
import { copyFor } from "../src/copy";
import { applyDueOutcomes } from "../src/outcomes";
import { razorpay } from "../src/pay/razorpay";
import { createRequest, decideRequest } from "../src/requests";
import { generateSlots, holdSlot } from "../src/slots";
import { addPerson, newDb } from "./db";
import { FakeRazorpay, rzpEnv } from "./razorpay";

// All data is synthetic (names, numbers, emails). Access, WhatsApp and Razorpay are mocked: nothing real is called.
// Mon 2026-10-05, 2:05 pm in Bengaluru: the 2:00 pm call started 5 minutes ago.
const NOW = Date.parse("2026-10-05T08:35:00Z");
const MIN = 60_000;
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const OWNER = "owner@example.test";
const PRAC = "practitioner@example.test";
const PRAC2 = "second-practitioner@example.test";
const STAFF = "staff@example.test";

let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let tokens: Map<string, string>;
let fake: FakeRazorpay;
let wa: { to: string; body: Record<string, unknown> }[];

const env = (o: Record<string, unknown> = {}) =>
  ({ DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: "true", SENDS: "true", WA_TOKEN: "tok", WA_PHONE_ID: "1000", ...rzpEnv(), ...o }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  tokens = new Map();
  wa = [];
  fake = new FakeRazorpay();
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const u = String(url);
      if (u.includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify(jwks));
      if (u.includes("graph.facebook.com")) {
        wa.push({ to: u, body: JSON.parse(init.body ?? "{}") });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }));
      }
      return fake.handle(u, init as never) ?? new Response("{}", { status: 404 });
    }),
  );
  await get("/app"); // the one-time seed: the owner and the practitioner
  await db.prepare("INSERT INTO members (workspace_id, email, role, status, display_name) VALUES (1, ?1, 'STAFF', 'active', 'Desk'), (1, ?2, 'PRACTITIONER', 'active', 'Second')").bind(STAFF, PRAC2).run();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

const sign = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(AUD).setIssuedAt().setExpirationTime("30d").sign(priv);
const jwtFor = async (email: string) => {
  if (!tokens.has(email)) tokens.set(email, await sign(email));
  return tokens.get(email)!;
};
const get = async (path: string, as = OWNER) => app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as) } }, env());
const post = async (path: string, form: Record<string, string>, as = OWNER, origin: string | null = ORIGIN) => {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await jwtFor(as), "Content-Type": "application/x-www-form-urlencoded" };
  if (origin) headers.Origin = origin;
  return app.request(ORIGIN + path, { method: "POST", headers, body: new URLSearchParams(form).toString() }, env());
};
const member = async (email: string) =>
  (await db.prepare("SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status FROM members WHERE email = ?1").bind(email).first<Member>())!;
// A form token exactly as a page would draw it for this member: what a hand-made POST would send.
const tokenFor = async (email: string, scope: string) => memberCsrf(await jwtFor(email), await member(email), scope);
// The page as text, with the few entities hono's html escaping writes turned back.
const page = async (as = OWNER, path = "/app") => decode(await (await get(path, as)).text());
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Every POST form on a page: its action and hidden fields.
const forms = (html: string) =>
  [...html.matchAll(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
    action: m[1],
    fields: Object.fromEntries([...m[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((f) => [f[1], f[2]])),
  }));
const formFor = (html: string, action: string, match: Record<string, string> = {}) =>
  forms(html).find((f) => f.action === action && Object.entries(match).every(([k, v]) => f.fields[k] === v))?.fields;
const count = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const audits = async (action: string) => (await db.prepare("SELECT member_id AS memberId, target, detail, reason FROM audit_log WHERE action = ?1 ORDER BY id").bind(action).all<{ memberId: number; target: string; detail: string; reason: string | null }>()).results;
// Only the Up next section of a page.
const upNext = (html: string) => html.slice(html.indexOf(">Up next<"), html.indexOf(">Later<"));

let phone = 919800000000;
// A paid ₹99 call (or a confirmed first session) with a practitioner, on a slot of an IST day.
async function booking(o: { ymd?: string; i?: number; name?: string; kind?: "CALL" | "SESSION"; state?: string; prac?: string; first?: boolean } = {}) {
  const kind = o.kind ?? "CALL";
  const pid = (await member(o.prac ?? PRAC)).id;
  const waId = String(++phone);
  const conv = await addPerson(db, waId);
  await db.prepare("UPDATE conversations SET display_name = ?2, locale = 'en', last_user_at = '2026-10-05T07:00:00Z' WHERE id = ?1").bind(conv, o.name ?? "Asha Test").run();
  const s = generateSlots(o.ymd ?? "2026-10-05", kind)[o.i ?? 0];
  const slot = (await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES (?1, ?2, ?3, ?4, 'BOOKED', ?5)").bind(kind, s.startUtc, s.endUtc, conv, pid).run()).meta.last_row_id;
  if (kind === "SESSION") {
    const id = (
      await db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, practitioner_id) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', ?3, ?4)").bind(conv, slot, o.first ? "SELF" : "AMMA", pid).run()
    ).meta.last_row_id;
    const pay = (await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, amount_paise, state) VALUES ('razorpay', 'SESSION', ?1, ?2, ?3, 79900, 'PAID')").bind(id, `di-s${id}`, `pay_s${id}`).run()).meta.last_row_id;
    return { conv, id, waId, payId: pay, pid };
  }
  const id = (
    await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, call_lang, for_whom, practitioner_id) VALUES (?1, ?2, 'PROTECTION', ?3, 'hi', 'FAMILY', ?4)").bind(conv, slot, o.state ?? "PAID", pid).run()
  ).meta.last_row_id;
  const pay = (await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, ?2, ?3, 9900, 'PAID')").bind(id, `di-i${id}`, `pay_i${id}`).run()).meta.last_row_id;
  return { conv, id, waId, payId: pay, pid };
}
// Taps an outcome as the page draws it.
async function tap(as: string, introId: number, v: string, html?: string) {
  const f = formFor(html ?? (await page(as)), "/app/today/outcome", { kind: "intro", id: String(introId), v });
  expect(f, `the ${v} button is on the page`).toBeTruthy();
  return post("/app/today/outcome", f!, as);
}

describe("PRD check 1: Today for a practitioner", () => {
  it("a paid call that started 5 minutes ago is first under Up next, with the three outcomes; Didn't pick up shows Undo until +10 min, then the new-time message goes", async () => {
    const later = await booking({ i: 4, name: "Kiran Later" }); // 3:00 pm, not started
    const b = await booking({ name: "Asha Test" });
    const html = await page(PRAC);
    const up = upNext(html);
    expect(up.indexOf("Asha")).toBeGreaterThan(0);
    expect(up.indexOf("Asha")).toBeLessThan(up.indexOf("Kiran")); // first, in time order
    expect(up).toContain("2:00 pm");
    expect(up).toContain("How did it go?");
    expect(up).toContain("Book a session for them");
    expect(up).toContain("Not a fit (₹99 refunded)");
    expect(up).toContain("Didn't pick up (offer a new time)");
    expect(up).toContain("Report behaviour…"); // under More, behind a confirm step
    expect(up).toContain(`…${b.waId.slice(-4)}`);
    expect(html).not.toContain(b.waId); // never the whole number on the page
    expect(up).toContain("For family");
    expect(up).toContain("Call in Hindi");
    expect(up).toContain("Energy cleansing");
    // The later call has no outcome buttons yet.
    expect(formFor(html, "/app/today/outcome", { id: String(later.id) })).toBeUndefined();

    const res = await tap(PRAC, b.id, "MISSED", html);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app#b-intro-${b.id}`);
    const after = await page(PRAC);
    expect(after).toContain("Didn't pick up · Saved. Undo until 2:15 pm");
    expect(formFor(after, "/app/today/undo")).toBeTruthy();
    const [a] = await audits("APP_OUTCOME");
    expect(a).toMatchObject({ memberId: (await member(PRAC)).id, target: `intro:${b.id}`, detail: "MISSED" });

    // The same outcome code as /amma: nothing goes to the customer until the undo time has passed; then the new-time offer.
    expect(await applyDueOutcomes(env(), razorpay(env()), NOW + 5 * MIN)).toBe(0);
    expect(wa).toHaveLength(0);
    vi.setSystemTime(NOW + 10 * MIN + 1000);
    expect(await applyDueOutcomes(env(), razorpay(env()), NOW + 10 * MIN + 1000)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM intros WHERE id = ?1 AND state = 'MISSED'", b.id)).toBe(1);
    const sent = wa.find((m) => (m.body.interactive as { body?: { text?: string } } | undefined)?.body?.text === copyFor("en").missedOffer);
    expect(sent, "the new-time list went to the customer").toBeTruthy();
    expect(String(sent!.body.to)).toBe(b.waId);
    const done = await page(PRAC);
    expect(done).toContain("Marked: Didn't pick up");
    expect(formFor(done, "/app/today/undo")).toBeUndefined();
  });

  it("Call shows the number only from 1 hour before to 1 hour after, and the reveal is recorded", async () => {
    const now = await booking({ name: "Asha Test" });
    const far = await booking({ i: 16, name: "Ravi Far" }); // 6:00 pm: more than an hour away
    const html = await page(PRAC);
    const call = formFor(html, "/app/today/call", { kind: "intro", id: String(now.id) });
    expect(call).toBeTruthy();
    expect(formFor(html, "/app/today/call", { id: String(far.id) })).toBeUndefined();
    const res = await post("/app/today/call", call!, PRAC);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="tel:+${now.waId}"`);
    expect(await audits("PHONE_REVEAL")).toEqual([{ memberId: (await member(PRAC)).id, target: `intro:${now.id}`, detail: "call", reason: "call" }]);
    // A hand-made POST for the far call is refused, for the practitioner and the owner alike.
    for (const as of [PRAC, OWNER]) {
      const r = await post("/app/today/call", { kind: "intro", id: String(far.id), csrf: await tokenFor(as, `call:intro:${far.id}`) }, as);
      expect(r.status).toBe(403);
    }
    expect(await audits("PHONE_REVEAL")).toHaveLength(1);
  });

  it("shows the screen in Hindi for a practitioner who chose it", async () => {
    await db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    await booking();
    const html = await page(PRAC);
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("कॉल कैसी रही?");
    expect(html).toContain("फ़ोन नहीं उठाया (नया समय भेजें)");
    expect(html).toContain("आगे क्या है");
  });
});

describe("PRD check 2: undo", () => {
  it("inside the 10 minutes Undo works; 11 minutes after the tap it is gone and a POST is refused with Too late to undo", async () => {
    const b = await booking();
    await tap(PRAC, b.id, "NOT_FIT");
    const undoForm = formFor(await page(PRAC), "/app/today/undo")!;
    vi.setSystemTime(NOW + 11 * MIN);
    const html = await page(PRAC);
    expect(formFor(html, "/app/today/undo")).toBeUndefined();
    expect(html).not.toContain("Undo until");
    expect(html).toContain("Marked: Not a fit");
    const res = await post("/app/today/undo", undoForm, PRAC);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain("Too late to undo");
    expect(await count("SELECT COUNT(*) AS n FROM outcomes")).toBe(1);
    expect(await audits("APP_UNDO")).toHaveLength(0);
  });

  it("an undo in time removes the outcome, is audited, and the buttons come back", async () => {
    const b = await booking();
    await tap(PRAC, b.id, "SESSION");
    vi.setSystemTime(NOW + 9 * MIN);
    const res = await post("/app/today/undo", formFor(await page(PRAC), "/app/today/undo")!, PRAC);
    expect(res.status).toBe(303);
    expect(await count("SELECT COUNT(*) AS n FROM outcomes")).toBe(0);
    expect(await audits("APP_UNDO")).toMatchObject([{ target: `intro:${b.id}`, detail: "SESSION" }]);
    const html = await page(PRAC, "/app?m=undone");
    expect(html).toContain("Undone. Nothing will happen.");
    expect(formFor(html, "/app/today/outcome", { id: String(b.id), v: "SESSION" })).toBeTruthy();
    expect(await applyDueOutcomes(env(), razorpay(env()), NOW + 30 * MIN)).toBe(0);
    expect(wa).toHaveLength(0);
  });
});

describe("PRD check 3: the same call open in two tabs", () => {
  it("the second tap says Already marked: Not a fit, by you at 2:05 pm, and changes nothing", async () => {
    const b = await booking();
    const tab1 = await page(PRAC);
    const tab2 = await page(PRAC);
    expect((await tap(PRAC, b.id, "NOT_FIT", tab1)).status).toBe(303);
    vi.setSystemTime(NOW + 2 * MIN);
    const res = await tap(PRAC, b.id, "MISSED", tab2);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain("Already marked: Not a fit, by you at 2:05 pm");
    expect((await db.prepare("SELECT value, tapped_at AS at FROM outcomes").all()).results).toEqual([{ value: "NOT_FIT", at: "2026-10-05T08:35:00Z" }]);
    expect(await audits("APP_OUTCOME")).toHaveLength(1);
  });

  it("the owner's second tap names who marked it", async () => {
    const b = await booking();
    const ownerTab = await page(OWNER);
    await tap(PRAC, b.id, "NOT_FIT");
    const res = await tap(OWNER, b.id, "SESSION", ownerTab);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain("Already marked: Not a fit, by Practitioner at 2:05 pm");
  });

  it("a tap from /amma counts too", async () => {
    const b = await booking();
    const tab = await page(PRAC);
    await db.prepare("INSERT INTO outcomes (intro_id, value, tapped_at, undo_until, slot_id) SELECT id, 'MISSED', '2026-10-05T08:35:00Z', '2026-10-05T08:45:00Z', slot_id FROM intros WHERE id = ?1").bind(b.id).run();
    await db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?1, 'AMMA_OUTCOME', ?2, 'MISSED')").bind(PRAC, `intro:${b.id}`).run();
    const res = await tap(PRAC, b.id, "NOT_FIT", tab);
    expect(res.status).toBe(409);
    expect(decode(await res.text())).toContain("Already marked: Didn't pick up, by you at 2:05 pm");
  });
});

describe("PRD check 8: a stale booking", () => {
  it("a past call with no outcome never blocks a new booking, and shows under Loose ends", async () => {
    const old = await booking({ ymd: "2026-10-02", name: "Meena Old" }); // last Friday, never marked
    // The bot's Book tap: no "you already have a call".
    await bookingChoice(env(), "menu_book", old.conv, "wamid.IN1", razorpay(env({ NEW_BOOKINGS: "true" })));
    const texts = JSON.stringify(wa.map((m) => m.body));
    expect(texts).not.toContain("You already have a call");
    // And a new time can be held for them.
    const next = generateSlots("2026-10-06", "CALL")[2];
    expect((await holdSlot(db, { kind: "CALL", startUtc: next.startUtc, ownerId: old.conv, nowMs: NOW })).ok).toBe(true);
    for (const as of [PRAC, OWNER]) {
      const html = await page(as);
      const loose = html.slice(html.indexOf(">Loose ends<"));
      expect(html.indexOf(">Loose ends<")).toBeGreaterThan(html.indexOf(">Later<"));
      expect(loose).toContain("Meena");
      expect(loose).toContain("No outcome marked yet");
      expect(loose).toContain("Fri, 2 Oct");
      expect(upNext(html)).not.toContain("Meena");
    }
  });

  it("a call from yesterday evening, under 24 hours ago, can still be marked from Loose ends", async () => {
    vi.setSystemTime(Date.parse("2026-10-06T05:00:00Z")); // Tue 10:30 am
    const b = await booking({ ymd: "2026-10-05", i: 19, name: "Neha Evening" }); // Mon 6:45 pm
    const html = await page(PRAC);
    expect(html.slice(html.indexOf(">Loose ends<"))).toContain("How did it go?");
    expect((await tap(PRAC, b.id, "MISSED", html)).status).toBe(303);
  });

  it("after today's last call, the day's unmarked calls, unpaid links and open chats are listed", async () => {
    const b = await booking({ name: "Asha Test" });
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', 'INTRO', 999, 'di-x', 9900, 'PENDING', '2026-10-05T06:00:00Z')").run();
    await db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = '2026-10-05T07:00:00Z' WHERE id = ?1").bind(b.conv).run();
    expect(await page(OWNER)).not.toContain(">Loose ends<"); // the call hasn't ended
    vi.setSystemTime(NOW + 30 * MIN);
    const owner = await page(OWNER);
    const loose = owner.slice(owner.indexOf(">Loose ends<"));
    expect(loose).toContain(`href="#b-intro-${b.id}"`);
    expect(loose).toContain("1 payment link sent today isn't paid");
    expect(loose).toContain("1 chat is still waiting for a reply");
    const prac = await page(PRAC);
    const pLoose = prac.slice(prac.indexOf(">Loose ends<"));
    expect(pLoose).toContain(`href="#b-intro-${b.id}"`);
    expect(pLoose).not.toContain("payment link");
    expect(pLoose).not.toContain("chat");
  });
});

describe("role views", () => {
  async function busyDay() {
    const mine = await booking({ name: "Asha Mine" });
    const theirs = await booking({ i: 8, name: "Ravi Theirs", prac: PRAC2 });
    await db.prepare("INSERT INTO attention (kind, target) VALUES ('CRISIS', ?1), ('EMERGENCY', ?2)").bind(`conv:${mine.conv}`, `conv:${theirs.conv}`).run();
    const human = await addPerson(db, "919811111111");
    await db.prepare("UPDATE conversations SET display_name = 'Leela Wait', mode = 'HUMAN', human_since = '2026-10-05T06:35:00Z', last_user_at = '2026-10-05T06:35:00Z' WHERE id = ?1").bind(human).run();
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'INTRO', 998, 'di-u', 9900, 'UNKNOWN')").run();
    const ask = await createRequest(env(), await member(STAFF), { kind: "REFUND", target: `payment:${mine.payId}`, reason: "Customer asked" });
    expect(ask.ok).toBe(true);
    return { mine, theirs, human };
  }

  it("the owner sees everything, in the PRD order, with banners", async () => {
    const { mine, theirs } = await busyDay();
    const html = await page(OWNER);
    const order = [">Safety<", ">Waiting for a reply<", ">Approvals<", ">Up next<", ">Later<"].map((h) => html.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Crisis message from Asha");
    expect(html).toContain("Possible medical emergency: Ravi");
    expect(html).toContain("The safety message was sent");
    expect(html).toContain(`href="/app/inbox/${mine.conv}"`);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Reply to Leela …1111"); // the last 4 digits sit in a no-wrap span (ticket 27)
    expect(html).toContain("Asked for a person, 2 h ago. Reply by Tue, 6 Oct, 12:05 pm.");
    expect(formFor(html, "/app/today/handback")).toBeTruthy();
    expect(html).toContain("Refund ₹99 to Asha");
    expect(html).toContain("Asked by Desk, just now");
    expect(html).toContain("Reason: Customer asked");
    expect(upNext(html)).toContain("Asha");
    expect(upNext(html)).toContain("Ravi");
    expect(formFor(html, "/app/today/outcome", { id: String(theirs.id) })).toBeUndefined(); // 4:00 pm, not started
    expect(formFor(html, "/app/today/outcome", { id: String(mine.id), v: "NOT_FIT" })).toBeTruthy();
    for (const b of ["Bookings are paused", "Payments are failing", "The bot hasn't run for 15 minutes"]) expect(html).toContain(b);
    expect(html).not.toContain(mine.waId);
  });

  it("a practitioner sees only their own calls and their own customers' safety cards, and nothing about money", async () => {
    const { mine, theirs } = await busyDay();
    const html = await page(PRAC);
    expect(html).toContain("Crisis message from Asha");
    expect(html).not.toContain("Ravi");
    expect(html).not.toContain(">Waiting for a reply<");
    expect(html).not.toContain("Leela");
    expect(html).not.toContain(">Approvals<");
    expect(html).not.toContain("Refund ₹99");
    for (const b of ["Bookings are paused", "Payments are failing", "The bot hasn't run"]) expect(html).not.toContain(b);
    expect(html).not.toContain('href="/app/payments"');
    expect(html).not.toContain('href="/app/inbox');
    expect(html).toContain(`href="/app/people/${mine.conv}"`); // Open chat goes to the person, not the inbox
    expect(formFor(html, "/app/today/handback")).toBeUndefined();
    expect(formFor(html, "/app/today/decide")).toBeUndefined();
    expect(formFor(html, "/app/today/outcome", { id: String(theirs.id) })).toBeUndefined();
    // The second practitioner sees their own call, and not the first one's customer.
    const other = await page(PRAC2);
    expect(other).toContain("Possible medical emergency: Ravi");
    expect(upNext(other)).toContain("Ravi");
    expect(other).not.toContain("Asha");
  });

  it("staff see the chats waiting and the day's bookings, but no Call, no outcomes, no approvals, and no safety text", async () => {
    const { mine } = await busyDay();
    const html = await page(STAFF);
    expect(html).toContain("A safety message. An owner is needed.");
    expect(html).not.toContain("Crisis message from");
    expect(html).not.toContain("Possible medical emergency");
    expect(html).not.toContain(`href="/app/inbox/${mine.conv}"`);
    expect(html).toContain("Reply to Leela");
    expect(formFor(html, "/app/today/handback")).toBeTruthy();
    expect(upNext(html)).toContain("Asha");
    expect(formFor(html, "/app/today/call")).toBeUndefined();
    expect(formFor(html, "/app/today/outcome")).toBeUndefined();
    expect(html).not.toContain(">Approvals<");
    expect(formFor(html, "/app/today/decide")).toBeUndefined();
    expect(html).not.toContain("Payments are failing");
  });
});

describe("an empty day", () => {
  it("says there are no calls and links to the calendar", async () => {
    const html = await page(PRAC);
    expect(html).toContain("No calls booked yet.");
    expect(html).toContain('href="/app/calendar"');
    expect(html).toContain("Tomorrow: nothing booked");
    expect(html).not.toContain(">Safety<");
    expect(html).not.toContain(">Loose ends<");
  });

  it("names the next booking, and counts tomorrow", async () => {
    await booking({ ymd: "2026-10-06", i: 0 });
    await booking({ ymd: "2026-10-06", i: 1, kind: "SESSION" });
    await booking({ ymd: "2026-10-08", i: 4 });
    const html = await page(PRAC);
    expect(html).toContain("No calls today. Next: Tue, 6 Oct, 2:00 pm.");
    expect(html).toContain("Tomorrow: 1 call, 1 session");
  });
});

describe("role refusals on every POST", () => {
  it("each POST refuses a member whose role can't do it, even with a hand-made form and a valid token", async () => {
    const mine = await booking();
    const theirs = await booking({ i: 1, name: "Ravi Theirs", prac: PRAC2 });
    vi.setSystemTime(NOW + 15 * MIN); // both calls have started
    const human = await addPerson(db, "919822222222");
    await db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = '2026-10-05T08:00:00Z' WHERE id = ?1").bind(human).run();
    const ask = await createRequest(env(), await member(STAFF), { kind: "BLOCK", target: `conv:${mine.conv}` });
    if (!ask.ok) throw new Error("no request");
    await tap(PRAC, mine.id, "MISSED");
    const oid = (await db.prepare("SELECT id FROM outcomes").first<{ id: number }>())!.id;

    const cases: [string, string, Record<string, string>, string][] = [
      ["/app/today/outcome", STAFF, { kind: "intro", id: String(theirs.id), v: "NOT_FIT" }, `outcome:intro:${theirs.id}:NOT_FIT`],
      ["/app/today/outcome", PRAC, { kind: "intro", id: String(theirs.id), v: "NOT_FIT" }, `outcome:intro:${theirs.id}:NOT_FIT`], // someone else's call
      ["/app/today/undo", STAFF, { outcome: String(oid) }, `undo:${oid}`],
      ["/app/today/undo", PRAC2, { outcome: String(oid) }, `undo:${oid}`],
      ["/app/today/call", STAFF, { kind: "intro", id: String(mine.id) }, `call:intro:${mine.id}`],
      ["/app/today/call", PRAC, { kind: "intro", id: String(theirs.id) }, `call:intro:${theirs.id}`],
      ["/app/today/handback", PRAC, { conv: String(human) }, `handback:${human}`],
      ["/app/today/decide", STAFF, { request: String(ask.id), decision: "APPROVED" }, `decide:${ask.id}:APPROVED`],
      ["/app/today/decide", PRAC, { request: String(ask.id), decision: "DECLINED" }, `decide:${ask.id}:DECLINED`],
    ];
    for (const [path, as, fields, scope] of cases) {
      // The page never drew this button for them...
      expect(formFor(await page(as), path, fields), `${as} sees no ${path} button`).toBeUndefined();
      // ...and the POST is refused.
      const res = await post(path, { ...fields, csrf: await tokenFor(as, scope) }, as);
      expect(res.status, `${as} POST ${path}`).toBe(403);
    }
    expect(await count("SELECT COUNT(*) AS n FROM outcomes")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM requests WHERE decided_at IS NULL")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE mode = 'HUMAN'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE mode = 'BLOCKED'")).toBe(0);
    expect(await audits("PHONE_REVEAL")).toHaveLength(0);
  });

  it("a wrong token, another member's token or no Origin is refused", async () => {
    const b = await booking();
    const f = formFor(await page(PRAC), "/app/today/outcome", { v: "MISSED" })!;
    expect((await post("/app/today/outcome", { ...f, csrf: "0".repeat(64) }, PRAC)).status).toBe(403);
    expect((await post("/app/today/outcome", f, OWNER)).status).toBe(403); // the practitioner's token, sent by the owner
    expect((await post("/app/today/outcome", f, PRAC, null)).status).toBe(403);
    expect((await post("/app/today/outcome", f, PRAC, "https://evil.example")).status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM outcomes WHERE intro_id = ?1", b.id)).toBe(0);
  });

  it("a removed practitioner's open form is refused", async () => {
    const b = await booking();
    const f = formFor(await page(PRAC), "/app/today/outcome", { v: "MISSED" })!;
    await db.prepare("UPDATE members SET status = 'removed' WHERE email = ?1").bind(PRAC).run();
    expect((await post("/app/today/outcome", f, PRAC)).status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM outcomes WHERE intro_id = ?1", b.id)).toBe(0);
  });

  it("outcome taps are refused before the start and after 24 hours", async () => {
    const soon = await booking({ i: 8 }); // 4:00 pm
    const r1 = await post("/app/today/outcome", { kind: "intro", id: String(soon.id), v: "MISSED", csrf: await tokenFor(PRAC, `outcome:intro:${soon.id}:MISSED`) }, PRAC);
    expect(r1.status).toBe(409);
    expect(decode(await r1.text())).toContain("This call hasn't started yet. Nothing was saved.");
    vi.setSystemTime(Date.parse("2026-10-06T11:00:00Z")); // Tue 4:30 pm: more than 24 hours after Mon 4:00 pm
    const r2 = await post("/app/today/outcome", { kind: "intro", id: String(soon.id), v: "MISSED", csrf: await tokenFor(PRAC, `outcome:intro:${soon.id}:MISSED`) }, PRAC);
    expect(r2.status).toBe(409);
    expect(decode(await r2.text())).toContain("More than 24 hours have passed");
    expect(await count("SELECT COUNT(*) AS n FROM outcomes")).toBe(0);
  });
});

describe("sessions", () => {
  it("a buyer's very first session has one answer, Not a fit with the price refunded, as on /amma", async () => {
    const first = await booking({ kind: "SESSION", first: true, i: 0, name: "Tara First" });
    const html = await page(PRAC);
    expect(html).toContain("Not a fit (₹799 refunded)");
    expect(formFor(html, "/app/today/outcome", { kind: "session", id: String(first.id), v: "NOT_FIT" })).toBeTruthy();
    expect(formFor(html, "/app/today/outcome", { kind: "session", id: String(first.id), v: "MISSED" })).toBeUndefined();
    const res = await post("/app/today/outcome", formFor(html, "/app/today/outcome", { kind: "session", id: String(first.id) })!, PRAC);
    expect(res.status).toBe(303);
    expect(await count("SELECT COUNT(*) AS n FROM outcomes WHERE session_id = ?1 AND value = 'NOT_FIT'", first.id)).toBe(1);
  });
  it("a session after a ₹99 call has no outcome buttons", async () => {
    const s = await booking({ kind: "SESSION", i: 0, name: "Uma Offer" });
    expect(formFor(await page(PRAC), "/app/today/outcome", { id: String(s.id) })).toBeUndefined();
  });
});

describe("approvals and requests", () => {
  it("staff ask; the owner approves a refund on Today; it runs the one refund path and is audited", async () => {
    const b = await booking();
    const staff = await member(STAFF);
    expect(await createRequest(env(), await member(OWNER), { kind: "REFUND", target: `payment:${b.payId}` })).toEqual({ ok: false, why: "NOT_ALLOWED" }); // the owner does it directly
    expect(await createRequest(env(), await member(PRAC), { kind: "REFUND", target: `payment:${b.payId}` })).toEqual({ ok: false, why: "NOT_ALLOWED" });
    expect(await createRequest(env(), staff, { kind: "REFUND", target: `conv:${b.conv}` })).toEqual({ ok: false, why: "BAD_TARGET" });
    const ask = await createRequest(env(), staff, { kind: "REFUND", target: `payment:${b.payId}`, reason: "Asked twice" });
    expect(ask.ok).toBe(true);
    expect(await createRequest(env(), staff, { kind: "REFUND", target: `payment:${b.payId}` })).toEqual({ ok: false, why: "EXISTS" });
    expect(await audits("REQUEST_CREATED")).toMatchObject([{ memberId: staff.id, target: `payment:${b.payId}`, detail: "REFUND", reason: "Asked twice" }]);

    const html = await page(OWNER);
    expect(html).toContain("Approve…");
    expect(html).toContain("₹99 goes back to Asha");
    const approve = formFor(html, "/app/today/decide", { decision: "APPROVED" })!;
    const res = await post("/app/today/decide", approve, OWNER);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app?m=approved");
    expect(await count("SELECT COUNT(*) AS n FROM refunds WHERE payment_id = ?1 AND reason = 'ADMIN'", b.payId)).toBe(1);
    expect(fake.posts("/refund")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM requests WHERE decision = 'APPROVED' AND decided_by = ?1", (await member(OWNER)).id)).toBe(1);
    expect(await audits("REQUEST_APPROVED")).toHaveLength(1);
    expect((await audits("REQUEST_REFUND_APPROVED"))[0].detail).toContain("DONE");
    expect(await page(OWNER)).not.toContain(">Approvals<");
    // A second tab: nothing happens twice.
    const again = await post("/app/today/decide", approve, OWNER);
    expect(again.status).toBe(409);
    expect(fake.posts("/refund")).toHaveLength(1);
  });

  it("a rude caller's refund waiting for approval is approved or kept through the same request", async () => {
    const b = await booking();
    await db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state, attempt_at, created_at, updated_at) VALUES (?1, 'RUDE', 'practitioner', 'PENDING_APPROVAL', 'x', 'x', 'x')").bind(b.payId).run();
    const ask = await createRequest(env(), await member(STAFF), { kind: "REFUND", target: `payment:${b.payId}` });
    if (!ask.ok) throw new Error("no request");
    expect(await decideRequest(env(), razorpay(env()), await member(OWNER), ask.id, "DECLINED")).toBe("DONE");
    expect(await count("SELECT COUNT(*) AS n FROM refunds WHERE state = 'DECLINED'")).toBe(1);
    expect(fake.posts("/refund")).toHaveLength(0);
  });

  it("approving a block blocks the number; declining changes nothing", async () => {
    const a = await booking({ name: "Asha Test" });
    const b = await booking({ i: 1, name: "Ravi Test" });
    const staff = await member(STAFF);
    const r1 = await createRequest(env(), staff, { kind: "BLOCK", target: `conv:${a.conv}` });
    const r2 = await createRequest(env(), staff, { kind: "BLOCK", target: `conv:${b.conv}` });
    if (!r1.ok || !r2.ok) throw new Error("no request");
    const html = await page(OWNER);
    expect(html).toContain("Block Asha");
    const yes = await post("/app/today/decide", formFor(html, "/app/today/decide", { request: String(r1.id), decision: "APPROVED" })!, OWNER);
    expect(yes.status).toBe(303);
    const no = await post("/app/today/decide", formFor(html, "/app/today/decide", { request: String(r2.id), decision: "DECLINED" })!, OWNER);
    expect(no.headers.get("Location")).toBe("/app?m=declined");
    expect((await db.prepare("SELECT wa_id AS w FROM blocks").all<{ w: string }>()).results).toEqual([{ w: a.waId }]);
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE mode = 'BLOCKED'")).toBe(1);
    expect(await audits("REQUEST_DECLINED")).toHaveLength(1);
  });

  it("money received outside Razorpay: approving confirms the booking on the paid-link path (CONTRACT v6)", async () => {
    const b = await booking();
    await db.prepare("UPDATE payments SET state = 'PENDING' WHERE id = ?1").bind(b.payId).run();
    const ask = await createRequest(env(), await member(STAFF), { kind: "MARK_PAID", target: `payment:${b.payId}`, amountPaise: 9900, reason: "Paid by UPI" });
    if (!ask.ok) throw new Error("no request");
    const html = await page(OWNER);
    expect(html).toContain("₹99 received from Asha");
    const res = await post("/app/today/decide", formFor(html, "/app/today/decide", { decision: "APPROVED" })!, OWNER);
    expect(res.headers.get("Location")).toBe("/app?m=recorded");
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE id = ?1 AND state = 'PAID'", b.payId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM intros WHERE id = ?1 AND state = 'PAID'", b.id)).toBe(1);
    expect(await audits("REQUEST_MARK_PAID_APPROVED")).toEqual([expect.objectContaining({ detail: expect.stringContaining("DONE"), reason: "Paid by UPI" })]);
    expect(await page(OWNER, "/app?m=recorded")).toContain("Their booking is confirmed.");
  });

  it("a failed refund effect puts the decision back so it can be tried again", async () => {
    const b = await booking();
    const ask = await createRequest(env(), await member(STAFF), { kind: "REFUND", target: `payment:${b.payId}` });
    if (!ask.ok) throw new Error("no request");
    const broken = { ...razorpay(env()), refund: async () => { throw new Error("down"); }, getRefund: async () => { throw new Error("down"); } };
    // The provider being down is not a failure here: the refund row waits as PENDING and the cron retries it with the same id.
    expect(await decideRequest(env(), broken as never, await member(OWNER), ask.id, "APPROVED")).toBe("DONE");
    const bad = await createRequest(env(), await member(STAFF), { kind: "BLOCK", target: `conv:${b.conv}` });
    if (!bad.ok) throw new Error("no request");
    await db.prepare("DROP TABLE blocks").run(); // a database write that fails
    expect(await decideRequest(env(), razorpay(env()), await member(OWNER), bad.id, "APPROVED")).toBe("FAILED");
    expect(await count("SELECT COUNT(*) AS n FROM requests WHERE id = ?1 AND decided_at IS NULL", bad.id)).toBe(1);
  });
});

describe("hand back to the bot", () => {
  it("the owner hands a waiting chat back: the mode, the item and the audit row", async () => {
    const conv = await addPerson(db, "919833333333");
    await db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = '2026-10-05T08:00:00Z', display_name = 'Leela Wait' WHERE id = ?1").bind(conv).run();
    await db.prepare("INSERT INTO attention (kind, target) VALUES ('HUMAN_REQUEST', ?1)").bind(`conv:${conv}`).run();
    const res = await post("/app/today/handback", formFor(await page(OWNER), "/app/today/handback")!, OWNER);
    expect(res.headers.get("Location")).toBe("/app?m=handback");
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE id = ?1 AND mode = 'BOT'", conv)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(0);
    expect(await audits("APP_HAND_BACK")).toMatchObject([{ memberId: (await member(OWNER)).id, target: `conv:${conv}` }]);
    expect(await page(OWNER, "/app?m=handback")).toContain("Handed back to the bot.");
  });
});

describe("the page", () => {
  it("uses the console frame, the console CSP with self-hosted fonts, and no scripts", async () => {
    const res = await get("/app", PRAC);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("font-src 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('class="tabbar"');
    expect(html).toContain("What needs me now?");
    expect(html).not.toContain("<script");
    expect(forms(html).find((f) => f.action === "/app/language")).toBeTruthy();
  });
});
