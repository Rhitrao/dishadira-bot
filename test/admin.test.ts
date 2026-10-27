import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { bookingChoice } from "../src/booking";
import { runDigest, digestText } from "../src/report";
import { sendAlerts } from "../src/mail";
import { aiOn, bookingsOpen, sendsOn } from "../src/switches";
import { raiseAwayItems, raiseTapReminders, recordHeartbeat } from "../src/watch";
import { applyStatus } from "../src/pay/apply";
import { razorpay } from "../src/pay/razorpay";
import { requestRefund } from "../src/pay/refund";
import { sendMessage } from "../src/send";
import { generateSlots } from "../src/slots";
import { addPerson, newDb } from "./db";
import { FakeRazorpay, rzpEnv } from "./razorpay";

// All data is synthetic. Mon 2026-10-05, 15:30 IST. Access, Razorpay, Meta and email are mocked: nothing real is called.
const NOW = Date.parse("2026-10-05T10:00:00Z");
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const ROHIT = "rohit@example.test";
const AMMA = "amma@example.test";
let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let fetchMock: ReturnType<typeof vi.fn>;
let emails: { to: string; from: string; subject: string; text: string }[];
let emailDown = false;
let session: string | undefined;

const env = (o: Record<string, unknown> = {}) =>
  ({
    DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, AMMA_EMAIL: AMMA, ROHIT_EMAIL: ROHIT, NEW_BOOKINGS: "true", SENDS: "true", ...rzpEnv(),
    WA_TOKEN: "tok", WA_PHONE_ID: "1000", DIGEST_TO: "ops@example.test",
    EMAIL: { send: async (m: (typeof emails)[number]) => { if (emailDown) throw Object.assign(new Error("down"), { code: "E_DELIVERY_FAILED" }); emails.push(m); return { messageId: "x" }; } },
    ...o,
  }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
let fake: FakeRazorpay;
beforeEach(async () => {
  session = undefined;
  emails = [];
  emailDown = false;
  fake = new FakeRazorpay();
  fake.refundStatusOnCreate = "processed";
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/cdn-cgi/access/certs")) return json(jwks);
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: "wamid.OUT" }] });
    return fake.handle(u, init as never) ?? json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

const token = (o: { email?: string; aud?: string } = {}) =>
  new SignJWT({ email: o.email ?? ROHIT }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`)
    .setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime("1h").sign(priv);
const hdr = async () => ({ "Cf-Access-Jwt-Assertion": (session ??= await token()) });
const get = async (path: string, e = env()) => app.request(ORIGIN + path, { headers: await hdr() }, e);
const post = async (path: string, form: Record<string, string>, o: { origin?: string | null; e?: unknown } = {}) => {
  const headers = { ...(await hdr()), "Content-Type": "application/x-www-form-urlencoded" } as Record<string, string>;
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  return app.request(ORIGIN + path, { method: "POST", headers, body: new URLSearchParams(form).toString() }, (o.e ?? env()) as never);
};
const hidden = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)![1];
// Presses the first form on the page that posts to `action` (it carries its own CSRF token and fields).
async function press(action: string, extra: Record<string, string> = {}, e: unknown = env(), contains = "") {
  const page = await (await get("/admin", e as never)).text();
  const forms = [...page.matchAll(new RegExp(`<form method="post" action="/admin/${action}">([\\s\\S]*?)</form>`, "g"))];
  const m = forms.find((f) => f[1].includes(contains));
  if (!m) throw new Error(`no ${action} form`);
  const fields: Record<string, string> = {};
  for (const h of m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields[h[1]] = h[2];
  return post(`/admin/${action}`, { ...fields, ...extra }, { e });
}
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const waSent = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com"));
const refundPosts = () => fake.posts("/refund").map((c) => c.body as Record<string, unknown>);

let wa = 919200000000;
async function person(o: { lastUserAt?: string | null; name?: string } = {}) {
  const id = await addPerson(db, String(++wa));
  await db.prepare("UPDATE conversations SET last_user_at = ?2, display_name = ?3 WHERE id = ?1").bind(id, o.lastUserAt === undefined ? "2026-10-05T09:00:00Z" : o.lastUserAt, o.name ?? "Test Person").run();
  return id;
}
const attention = async (kind: string, target: string) => (await db.prepare("INSERT INTO attention (kind, target) VALUES (?1, ?2)").bind(kind, target).run()).meta.last_row_id;
let k = 0;
async function paidIntro(o: { ymd?: string; i?: number; payState?: string; conv?: number; name?: string } = {}) {
  const conv = o.conv ?? (await person({ name: o.name }));
  const s = generateSlots(o.ymd ?? "2026-10-05", "CALL")[o.i ?? 0];
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
  const intro = await db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state) VALUES (?1,?2,'PROTECTION','PAID')").bind(conv, slot.meta.last_row_id).run();
  const n = ++k;
  const pay = await db.prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,provider_order_id,amount_paise,state) VALUES ('razorpay','INTRO',?1,?2,?3,9900,?4)")
    .bind(intro.meta.last_row_id, `link${n}`, `pay_order${n}`, o.payState ?? "PAID").run();
  return { conv, introId: intro.meta.last_row_id, payId: pay.meta.last_row_id };
}
async function confirmedSession(ymd: string, i: number, name: string) {
  const conv = await person({ name });
  const s = generateSlots(ymd, "SESSION")[i];
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
  const ses = await db.prepare("INSERT INTO sessions (conversation_id,slot_id,service,state) VALUES (?1,?2,'HEALING','CONFIRMED')").bind(conv, slot.meta.last_row_id).run();
  return { conv, sessionId: ses.meta.last_row_id };
}
const auditRows = async () => (await db.prepare("SELECT actor, action, target, detail FROM audit_log ORDER BY id").all<{ actor: string; action: string; target: string; detail: string }>()).results;

describe("access", () => {
  it("403 without Access, for Amma, for a wrong audience, and when the e-mails are unset", async () => {
    expect((await app.request(ORIGIN + "/admin", {}, env())).status).toBe(403);
    expect((await app.request(ORIGIN + "/admin", { headers: { "Cf-Access-Jwt-Assertion": await token({ email: AMMA }) } }, env())).status).toBe(403);
    expect((await app.request(ORIGIN + "/admin", { headers: { "Cf-Access-Jwt-Assertion": await token({ aud: "other" }) } }, env())).status).toBe(403);
    expect((await app.request(ORIGIN + "/admin", { headers: await hdr() }, env({ ROHIT_EMAIL: "" }))).status).toBe(403);
    expect((await get("/admin")).status).toBe(200);
  });
  it("POST needs Origin and a valid CSRF token; pages are no-store", async () => {
    const id = await attention("FREE_TEXT", `conv:${await person()}`);
    expect((await post("/admin/resolve", { item: String(id), csrf: "x" })).status).toBe(403);
    expect((await post("/admin/resolve", { item: String(id), csrf: "x" }, { origin: null })).status).toBe(403);
    expect((await post("/admin/resolve", { item: String(id), csrf: "x" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await get("/admin")).headers.get("Cache-Control")).toBe("no-store");
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(1);
  });
  it("escapes customer text", async () => {
    const conv = await person({ name: "<script>x</script>" });
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status) VALUES (?1,'IN','text','<img src=x onerror=1>','RECEIVED')").bind(conv).run();
    await attention("FREE_TEXT", `conv:${conv}`);
    const page = await (await get("/admin")).text();
    expect(page).not.toMatch(/<script>x|<img src=x/);
    expect(page).toContain("&lt;img src=x onerror=1&gt;");
  });
});

describe("talk to a person (HUMAN_REQUEST)", () => {
  async function humanChat(mode = "HUMAN") {
    const conv = await person();
    await db.prepare("UPDATE conversations SET mode = ?2 WHERE id = ?1").bind(conv, mode).run();
    const item = await attention("HUMAN_REQUEST", `conv:${conv}`);
    return { conv, item };
  }
  it("shows the customer's messages with a reply box, and says what resolving does", async () => {
    const { conv } = await humanChat();
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status) VALUES (?1,'IN','text','please call me back','RECEIVED')").bind(conv).run();
    const page = await (await get("/admin")).text();
    expect(page).toContain("Wants to talk to a person");
    expect(page).toContain("please call me back");
    expect(page).toContain("<textarea");
    expect(page).toContain("hands the chat back to the bot");
  });
  it("resolving the item sets the chat back to BOT, with an audit row", async () => {
    const { conv } = await humanChat();
    expect((await press("resolve")).headers.get("Location")).toBe("/admin?m=resolved");
    expect(await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(conv).first()).toEqual({ mode: "BOT" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ADMIN_HUMAN_DONE'")).toBe(1);
  });
  it("a blocked chat stays blocked, and other items leave a HUMAN chat as it is", async () => {
    const blocked = await humanChat("BLOCKED");
    await press("resolve");
    expect(await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(blocked.conv).first()).toEqual({ mode: "BLOCKED" });
    const human = await person();
    await db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(human).run();
    await attention("FREE_TEXT", `conv:${human}`);
    await press("resolve");
    expect(await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(human).first()).toEqual({ mode: "HUMAN" });
  });
});

describe("reply box", () => {
  it("refused outside the 24h window (even if forced), sent inside it", async () => {
    const old = await person({ lastUserAt: "2026-10-03T09:00:00Z" });
    const id = await attention("FREE_TEXT", `conv:${old}`);
    const page = await (await get("/admin")).text();
    expect(page).toContain("24-hour window is closed");
    expect(page).not.toContain("<textarea");
    const forced = await post("/admin/reply", { item: String(id), text: "hello", csrf: await csrfFor(`reply:${id}`) });
    expect(forced.headers.get("Location")).toBe("/admin?m=window");
    expect(waSent()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'OUT'")).toBe(0);

    const fresh = await person();
    await attention("FREE_TEXT", `conv:${fresh}`);
    const res = await press("reply", { text: "Hello, we can help." });
    expect(res.headers.get("Location")).toBe("/admin?m=sent");
    expect(waSent()).toHaveLength(1);
    expect((await auditRows()).at(-1)).toMatchObject({ actor: ROHIT, action: "ADMIN_REPLY" });
  });
});
async function csrfFor(scope: string) {
  const { csrf } = await import("../src/amma");
  return csrf(await hdr().then((h) => h["Cf-Access-Jwt-Assertion"]), scope);
}

describe("refunds", () => {
  it("approving a RUDE refund goes through the refund engine once", async () => {
    const { payId, introId } = await paidIntro();
    await db.prepare("INSERT INTO refunds (payment_id,reason,requested_by,state) VALUES (?1,'RUDE','amma','PENDING_APPROVAL')").bind(payId).run();
    await attention("RUDE_REFUND_APPROVAL", `payment:${payId}`);
    expect(introId).toBeGreaterThan(0);
    const first = await press("approve");
    expect(first.headers.get("Location")).toBe("/admin?m=approved");
    expect(refundPosts()).toHaveLength(1);
    expect(refundPosts()[0].receipt).toBe(`refund-${payId}`);
    expect((await db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(payId).first<{ state: string }>())!.state).toBe("REFUNDED");
    expect((await db.prepare("SELECT state FROM payments WHERE id = ?1").bind(payId).first<{ state: string }>())!.state).toBe("REFUNDED");
    // the same stale page pressed again: nothing new goes out
    const id = (await db.prepare("SELECT id FROM attention").first<{ id: number }>())!.id;
    const again = await post("/admin/approve", { item: String(id), csrf: await csrfFor(`approve:${id}`) });
    expect(again.headers.get("Location")).toBe("/admin?m=gone");
    expect(refundPosts()).toHaveLength(1);
    expect((await auditRows()).filter((a) => a.action === "ADMIN_APPROVE_REFUND")).toHaveLength(1);
  });
  it("Keep (no refund) marks the row DECLINED, keeps it, audits who, and sends nothing", async () => {
    const { payId } = await paidIntro();
    await db.prepare("INSERT INTO refunds (payment_id,reason,requested_by,state) VALUES (?1,'RUDE','amma','PENDING_APPROVAL')").bind(payId).run();
    await attention("RUDE_REFUND_APPROVAL", `payment:${payId}`);
    await press("keep");
    expect(refundPosts()).toHaveLength(0);
    expect(await db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(payId).first()).toEqual({ state: "DECLINED" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(0);
    const a = (await auditRows()).find((r) => r.action === "ADMIN_KEEP_NO_REFUND")!;
    expect(a.actor).toBe(ROHIT);
    expect(a.detail).toContain(`declined by ${ROHIT}`);
    // a declined payment can never get a second refund row
    expect(await requestRefund(env(), razorpay(env()), payId, "ADMIN", ROHIT)).toBe("EXISTS");
    expect(refundPosts()).toHaveLength(0);
  });
  it("refunding a PAYMENT_MISMATCH payment returns the amount actually paid, not the price", async () => {
    const { payId } = await paidIntro({ payState: "PENDING" });
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE id = ?1").bind(payId).first<{ l: string }>())!.l;
    await applyStatus(env(), razorpay(env()), { linkId: link, status: "PAID", paidPaise: 15000, currency: "INR", orderId: "pay_x" });
    expect(await db.prepare("SELECT state, paid_paise AS paid FROM payments WHERE id = ?1").bind(payId).first()).toEqual({ state: "UNKNOWN", paid: 15000 });
    await attention("PAYMENT_MISMATCH", `payment:${payId}`);
    await press("refund");
    expect(refundPosts()).toHaveLength(1);
    expect(refundPosts()[0].amount).toBe(15000); // paise
  });
  it("Refund on a late payment uses requestRefund (ADMIN) once; a failed refund is retried with the same id", async () => {
    const { payId, introId } = await paidIntro();
    await attention("LATE_PAYMENT_NO_SLOT", `intro:${introId}`);
    await press("refund");
    expect(refundPosts()).toHaveLength(1);
    expect((await db.prepare("SELECT reason, requested_by AS by FROM refunds WHERE payment_id = ?1").bind(payId).first())).toEqual({ reason: "ADMIN", by: ROHIT });
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(1);

    const p2 = await paidIntro({ i: 1 });
    await db.prepare("UPDATE payments SET state = 'REFUND_FAILED' WHERE id = ?1").bind(p2.payId).run();
    await db.prepare("INSERT INTO refunds (payment_id,reason,requested_by,state) VALUES (?1,'ADMIN','x','FAILED')").bind(p2.payId).run();
    await attention("REFUND_FAILED", `payment:${p2.payId}`);
    await press("refund");
    expect(await count("SELECT COUNT(*) AS n FROM refunds")).toBe(2);
    expect(fake.refunds.some((r) => r.receipt === `refund-${p2.payId}`)).toBe(true);
  });
});

describe("switches", () => {
  it("a setting can pause what the env allows but never turn on what the env forbids", async () => {
    const off = env({ NEW_BOOKINGS: "false", SENDS: "false" });
    expect(await bookingsOpen(off)).toBe(false);
    const page = await (await get("/admin", off)).text();
    expect(page).toContain("off in wrangler.toml");
    expect(page).not.toMatch(/Resume new bookings|Pause new bookings/);
    const forced = await post("/admin/switch", { name: "NEW_BOOKINGS", v: "on", csrf: await csrfFor("switch:NEW_BOOKINGS:on") }, { e: off });
    expect(forced.headers.get("Location")).toBe("/admin?m=envoff");
    expect(await bookingsOpen(off)).toBe(false);
    expect(await sendsOn(off)).toBe(false);

    expect(await bookingsOpen(env())).toBe(true);
    await press("switch", {}, env(), 'value="NEW_BOOKINGS"');
    expect(await bookingsOpen(env())).toBe(false);
    expect(await sendsOn(env())).toBe(true);
    expect((await auditRows()).at(-1)).toMatchObject({ actor: ROHIT, action: "ADMIN_SWITCH", target: "NEW_BOOKINGS", detail: "off" });
  });
  it("AI_REPLIES follows the SENDS rules: the env flag is the master, the switch can only pause it, and a paused SENDS means no AI either", async () => {
    const on = env({ AI_REPLIES: "true" });
    expect(await aiOn(on)).toBe(true);
    expect(await (await get("/admin", on)).text()).toMatch(/AI answers<\/h3><span class="chip green">On</);
    await press("switch", {}, on, 'value="AI_REPLIES"');
    expect(await aiOn(on)).toBe(false);
    expect(await (await get("/admin", on)).text()).toMatch(/AI answers<\/h3><span class="chip red">Paused</);
    expect((await auditRows()).at(-1)).toMatchObject({ actor: ROHIT, action: "ADMIN_SWITCH", target: "AI_REPLIES", detail: "off" });
    await press("switch", {}, on, 'value="AI_REPLIES"');
    expect(await aiOn(on)).toBe(true);
    // The env flag off (the default): no button, and a forged "on" is refused.
    const off = env({ AI_REPLIES: "false" });
    expect(await aiOn(off)).toBe(false);
    const page = await (await get("/admin", off)).text();
    expect(page).toMatch(/AI answers<\/h3><span class="chip red">Paused</);
    expect(page).not.toMatch(/Resume ai answers|Pause ai answers/);
    const forced = await post("/admin/switch", { name: "AI_REPLIES", v: "on", csrf: await csrfFor("switch:AI_REPLIES:on") }, { e: off });
    expect(forced.headers.get("Location")).toBe("/admin?m=envoff");
    expect(await aiOn(off)).toBe(false);
    // Sends paused: nothing could go out, so the assistant is not asked either.
    await db.prepare("INSERT INTO settings (key,value) VALUES ('SENDS','false')").run();
    expect(await aiOn(on)).toBe(false);
  });
  it("SENDS paused stops outbound messages (the row is kept as SKIPPED)", async () => {
    const conv = await person();
    await db.prepare("INSERT INTO settings (key,value) VALUES ('SENDS','false')").run();
    expect(await sendMessage(env(), conv, { type: "text", text: "hi" }, "k1")).toBe("SKIPPED");
    expect(waSent()).toHaveLength(0);
  });
  it("AMMA_AWAY stops booking and raises one item per affected call and session today and tomorrow", async () => {
    const today = await paidIntro({ i: 12 }); // 17:00 IST, still ahead
    const tomorrow = await paidIntro({ ymd: "2026-10-06", i: 0 });
    const ses = await confirmedSession("2026-10-06", 1, "Sess Person");
    const later = await paidIntro({ ymd: "2026-10-08", i: 0 }); // outside the two days
    const past = await paidIntro({ i: 0 }); // already started
    await press("switch", {}, env(), 'value="AMMA_AWAY"');
    const page = await (await get("/admin")).text();
    expect(page).toMatch(/Amma away<\/h3><span class="chip amber">Away</);
    expect(await bookingsOpen(env())).toBe(false);
    const kinds = (await db.prepare("SELECT kind, target FROM attention ORDER BY id").all<{ kind: string; target: string }>()).results;
    expect(kinds).toEqual(expect.arrayContaining([
      { kind: "AMMA_AWAY_CALL", target: `intro:${today.introId}` }, { kind: "AMMA_AWAY_CALL", target: `intro:${tomorrow.introId}` },
      { kind: "AMMA_AWAY_SESSION", target: `session:${ses.sessionId}` },
    ]));
    expect(kinds).toHaveLength(3);
    expect(later.introId + past.introId).toBeGreaterThan(0);
    // booking is closed
    const who = await person();
    await bookingChoice(env(), "menu_book", who, "wamid.AWAY");
    expect(JSON.parse(waSent().at(-1)![1].body).text.body).toMatch(/opens soon/i);
    // cron again: no duplicates, and a resolved item does not come back
    await raiseAwayItems(env());
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(3);
    await db.prepare("UPDATE attention SET resolved_at = '2026-10-05T10:00:00Z'").run();
    await raiseAwayItems(env());
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(0);
  });
});

describe("attention items from the cron", () => {
  it("raises AMMA_NO_TAP once, only after the reminder hours and with no outcome", async () => {
    const a = await paidIntro({ i: 0 }); // 14:00 IST; now is 15:30
    expect(await raiseTapReminders(env(), NOW)).toBe(0);
    vi.setSystemTime(NOW + 2 * 3_600_000);
    expect(await raiseTapReminders(env(), Date.now())).toBe(1);
    await raiseTapReminders(env(), Date.now());
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'AMMA_NO_TAP'")).toBe(1);
    await db.prepare("INSERT INTO outcomes (intro_id,value,tapped_at,undo_until,slot_id) SELECT ?1,'MISSED','x','y',slot_id FROM intros WHERE id = ?1").bind(a.introId).run();
    await db.prepare("DELETE FROM attention").run();
    await db.prepare("DELETE FROM attention").run();
    await raiseTapReminders(env(), Date.now());
    expect(await count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
  });
});

describe("page actions and audit", () => {
  it("resolve, block, unblock and session Completed are audited with the Access e-mail", async () => {
    const conv = await person();
    await attention("FREE_TEXT", `conv:${conv}`);
    await press("block");
    expect((await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(conv).first<{ mode: string }>())!.mode).toBe("BLOCKED");
    expect(await count("SELECT COUNT(*) AS n FROM blocks WHERE reason = 'ADMIN'")).toBe(1);
    await press("unblock");
    expect(await count("SELECT COUNT(*) AS n FROM blocks")).toBe(0);
    await press("resolve", { note: "handled by phone" });
    const s = await confirmedSession("2026-10-05", 0, "Past Session"); // 14:00 IST: started
    const future = await confirmedSession("2026-10-06", 0, "Future Session");
    await press("session", {}, env(), 'value="NO_SHOW"');
    expect((await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(s.sessionId).first<{ state: string }>())!.state).toBe("NO_SHOW");
    expect((await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(future.sessionId).first<{ state: string }>())!.state).toBe("CONFIRMED");
    const forced = await post("/admin/session", { id: String(future.sessionId), v: "COMPLETED", csrf: await csrfFor(`session:${future.sessionId}:COMPLETED`) });
    expect(forced.headers.get("Location")).toBe("/admin?m=notyet");
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["ADMIN_BLOCK", "ADMIN_UNBLOCK", "ADMIN_RESOLVE", "ADMIN_SESSION"]);
    expect(rows.every((r) => r.actor === ROHIT)).toBe(true);
    expect(rows[2].detail).toContain("handled by phone");
  });
  it("shows the scoreboard from the database", async () => {
    await paidIntro();
    await db.prepare("INSERT INTO refunds (payment_id,reason,requested_by,state) SELECT id,'ADMIN','x','REFUNDED' FROM payments").run();
    await db.prepare("UPDATE conversations SET created_at = '2026-10-04T00:00:00Z'").run();
    await db.prepare("UPDATE payments SET created_at = '2026-10-04T00:00:00Z'").run();
    const page = await (await get("/admin")).text();
    expect(page).toMatch(/New chats<\/div><div class="v">1</);
    expect(page).toMatch(/₹99 calls paid<\/div><div class="v">1</);
    expect(page).toContain("refunds ₹99");
  });
});

describe("digest and alerts", () => {
  it("the daily summary lists open items in words, tomorrow's bookings, the scoreboard and switches that are off", async () => {
    const t = await paidIntro({ ymd: "2026-10-06", i: 0, name: "Tomorrow Caller" });
    await attention("FREE_TEXT", "conv:1");
    await attention("FREE_TEXT", "conv:2");
    await attention("REFUND_FAILED", `payment:${t.payId}`);
    await confirmedSession("2026-10-06", 2, "Sess Person");
    await db.prepare("INSERT INTO settings (key,value) VALUES ('SENDS','false')").run();
    await runDigest(env(), NOW);
    const mail = emails.find((m) => m.subject.startsWith("Daily summary"))!;
    expect(mail.to).toBe("ops@example.test");
    expect(mail.text).toContain("Needs you (3)");
    expect(mail.text).toContain("- Wrote something the bot couldn't answer: 2");
    expect(mail.text).toContain("- Refunds that didn't go through: 1");
    expect(mail.text).toMatch(/Call · Tomorrow/);
    expect(mail.text).toMatch(/Session · Sess/);
    expect(mail.text).toContain("New chats:");
    expect(mail.text).toContain("Messages to customers are paused");
    expect(mail.text).not.toMatch(/FREE_TEXT|REFUND_FAILED|SENDS|AMMA/); // no internal codes
    expect(mail.text).not.toMatch(/91\d{8}/); // no phone numbers
    expect(await digestText(env(), NOW)).toContain("Last 7 days");
  });
  it("without email configured it logs and skips without failing", async () => {
    await attention("REFUND_FAILED", "payment:1");
    await expect(runDigest(env({ EMAIL: undefined }), NOW)).resolves.toBeUndefined();
    await expect(runDigest(env({ DIGEST_TO: "" }), NOW)).resolves.toBeUndefined();
    expect(await sendAlerts(env({ EMAIL: undefined }), NOW)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'alert:%'")).toBe(0);
  });
  it("alerts once per kind per day, again the next day, and retry after a failed send", async () => {
    await attention("REFUND_FAILED", "payment:1");
    await attention("PAYMENT_MISMATCH", "payment:2");
    await attention("FREE_TEXT", "conv:1"); // not an alert kind
    expect(await sendAlerts(env(), NOW)).toEqual(["REFUND_FAILED", "PAYMENT_MISMATCH"]);
    expect(await sendAlerts(env(), NOW + 60_000)).toEqual([]);
    expect(emails).toHaveLength(2);
    expect(await sendAlerts(env(), NOW + 86_400_000)).toEqual(["REFUND_FAILED", "PAYMENT_MISMATCH"]);
    expect(emails).toHaveLength(4);
    await attention("OUTCOME_FAILED", "intro:1");
    emailDown = true;
    expect(await sendAlerts(env(), NOW + 86_400_000)).toEqual([]);
    emailDown = false;
    expect(await sendAlerts(env(), NOW + 86_400_000 + 1000)).toEqual(["OUTCOME_FAILED"]);
  });
  it("missing heartbeat alerts once; /admin and the 9pm run check it; a fresh heartbeat does not", async () => {
    await recordHeartbeat(env(), NOW - 5 * 60_000);
    expect(await sendAlerts(env(), NOW, { heartbeat: true })).toEqual([]);
    await get("/admin");
    expect(emails).toHaveLength(0);
    await recordHeartbeat(env(), NOW - 20 * 60_000);
    const page = await (await get("/admin")).text();
    expect(page).toContain("has not run in the last 15 minutes");
    expect(emails.map((m) => m.subject)).toEqual(["Disha Dira alert: cron heartbeat missing"]);
    await get("/admin");
    await runDigest(env(), NOW);
    expect(emails.filter((m) => m.subject.includes("heartbeat"))).toHaveLength(1);
  });
});

describe("a person's page: strikes, quiet period, no-sell, opt-out (ticket 12)", () => {
  async function noisy() {
    const conv = await person({ name: "Zoya Quillfeather" });
    await db.prepare("INSERT OR IGNORE INTO person_state (conversation_id) VALUES (?1)").bind(conv).run();
    await db
      .prepare("UPDATE person_state SET strikes = 2, last_strike_at = '2026-10-04T09:00:00Z', quiet_until = '2026-10-12T09:00:00Z', no_sell_until = '2026-10-11T09:00:00Z', opted_out_at = '2026-10-03T09:00:00Z' WHERE conversation_id = ?1")
      .bind(conv)
      .run();
    return conv;
  }
  const stateOf = (conv: number) => db.prepare("SELECT strikes, last_strike_at, quiet_until, no_sell_until, opted_out_at FROM person_state WHERE conversation_id = ?1").bind(conv).first();
  // The first form on the page that posts to `action`, with its own fields and CSRF token.
  async function pressOn(path: string, action: string) {
    const page = await (await get(path)).text();
    const m = new RegExp(`<form method="post" action="/admin/${action}">([\\s\\S]*?)</form>`).exec(page);
    if (!m) throw new Error(`no ${action} form`);
    const fields: Record<string, string> = {};
    for (const h of m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields[h[1]] = h[2];
    return fields;
  }

  it("shows the state, and the conversation as a thread", async () => {
    const conv = await noisy();
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status) VALUES (?1,'IN','text','a private sentence','RECEIVED')").bind(conv).run();
    const res = await get(`/admin/conv/${conv}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain("Zoya");
    expect(page).not.toContain("Quillfeather");
    expect(page).toContain("Strikes: 2");
    expect(page).toContain("Quiet until: Mon 12 Oct, 2:30pm");
    expect(page).toContain("No selling until: Sun 11 Oct, 2:30pm");
    expect(page).toContain("Opted out of messages: yes, since Sat 3 Oct, 2:30pm");
    expect(page).toContain("Clear strikes / end quiet");
    expect(page).toContain("Clear no-sell");
    expect(page).toContain("a private sentence"); // the thread: Rohit reads what was said, as in the Home items
    // a person with nothing set
    const calm = await person();
    const calmPage = await (await get(`/admin/conv/${calm}`)).text();
    expect(calmPage).toContain("Strikes: 0");
    expect(calmPage).toContain("not in a quiet period");
    expect(calmPage).toContain("selling is allowed");
    expect(calmPage).toContain("Opted out of messages: no");
  });

  it("an unknown person is a 404; Amma and anyone without Access are refused", async () => {
    expect((await get("/admin/conv/99999")).status).toBe(404);
    expect((await get("/admin/conv/abc")).status).toBe(404);
    const conv = await noisy();
    expect((await app.request(`${ORIGIN}/admin/conv/${conv}`, {}, env())).status).toBe(403);
    expect((await app.request(`${ORIGIN}/admin/conv/${conv}`, { headers: { "Cf-Access-Jwt-Assertion": await token({ email: AMMA }) } }, env())).status).toBe(403);
  });

  it("'Clear strikes / end quiet' clears strikes and the quiet period only, and is audited", async () => {
    const conv = await noisy();
    const res = await post("/admin/clear-strikes", await pressOn(`/admin/conv/${conv}`, "clear-strikes"));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin/conv/${conv}?m=cleared`);
    expect(await stateOf(conv)).toEqual({ strikes: 0, last_strike_at: null, quiet_until: null, no_sell_until: "2026-10-11T09:00:00Z", opted_out_at: "2026-10-03T09:00:00Z" });
    expect(await auditRows()).toEqual([{ actor: ROHIT, action: "ADMIN_CLEAR_STRIKES", target: `conv:${conv}`, detail: "" }]);
    expect(await (await get(`/admin/conv/${conv}?m=cleared`)).text()).toContain("Strikes cleared and the quiet period ended.");
  });

  it("'Clear no-sell' clears the no-sell date only, and is audited", async () => {
    const conv = await noisy();
    const res = await post("/admin/clear-nosell", await pressOn(`/admin/conv/${conv}`, "clear-nosell"));
    expect(res.headers.get("Location")).toBe(`/admin/conv/${conv}?m=nosellcleared`);
    expect(await stateOf(conv)).toMatchObject({ strikes: 2, quiet_until: "2026-10-12T09:00:00Z", no_sell_until: null });
    expect((await auditRows()).map((r) => r.action)).toEqual(["ADMIN_CLEAR_NOSELL"]);
  });

  it("a wrong token, a token for another person or another button, a missing Origin and a foreign Origin change nothing", async () => {
    const a = await noisy();
    const b = await noisy();
    const form = await pressOn(`/admin/conv/${a}`, "clear-strikes");
    expect((await post("/admin/clear-strikes", { ...form, csrf: "nope" })).status).toBe(403);
    expect((await post("/admin/clear-strikes", { ...form, conv: String(b) })).status).toBe(403); // a's token on b
    expect((await post("/admin/clear-nosell", form)).status).toBe(403); // the other button's endpoint
    expect((await post("/admin/clear-strikes", form, { origin: null })).status).toBe(403);
    expect((await post("/admin/clear-strikes", form, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("/admin/clear-strikes", { ...form, conv: "x" })).status).toBe(403);
    expect(await stateOf(a)).toMatchObject({ strikes: 2 });
    expect(await stateOf(b)).toMatchObject({ strikes: 2 });
    expect(await auditRows()).toEqual([]);
    const gone = await post("/admin/clear-strikes", { conv: "99999", csrf: await csrfFor("clear-strikes:99999") });
    expect(gone.headers.get("Location")).toBe("/admin?m=gone");
  });

  it("a crisis item can be answered from the queue, links to the person, and resolving it hands the chat back (no-sell stays until cleared)", async () => {
    const conv = await person({ name: "Zoya" });
    await db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(conv).run();
    await db.prepare("INSERT OR IGNORE INTO person_state (conversation_id, no_sell_until) VALUES (?1, '2026-10-12T09:00:00Z')").bind(conv).run();
    await attention("CRISIS", `conv:${conv}`);
    await attention("EMERGENCY", `conv:${conv}`);
    const page = await (await get("/admin")).text();
    expect(page).toContain("Crisis message");
    expect(page).toContain("thinking of ending their life");
    expect(page).toContain("Possible medical emergency");
    expect(page).toContain(`href="/admin/conv/${conv}"`);
    expect(page).toContain("<textarea");
    // Danger first, oldest first: the crisis item is the first card, so its Done hands the chat back; the emergency item stays.
    expect(page.indexOf("Crisis message")).toBeLessThan(page.indexOf("Possible medical emergency"));
    expect((await press("resolve", {}, env(), "")).headers.get("Location")).toBe("/admin?m=resolved");
    expect(await db.prepare("SELECT mode FROM conversations WHERE id = ?1").bind(conv).first()).toEqual({ mode: "BOT" });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'EMERGENCY' AND resolved_at IS NULL")).toBe(1);
    await press("resolve");
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(0);
    expect(await db.prepare("SELECT no_sell_until FROM person_state WHERE conversation_id = ?1").bind(conv).first()).toEqual({ no_sell_until: "2026-10-12T09:00:00Z" });
  });

  it("wiped text shows as '(message text removed)'", async () => {
    const conv = await person();
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status,wiped_at) VALUES (?1,'IN','text',NULL,'RECEIVED','2026-10-05T09:30:00Z')").bind(conv).run();
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status) VALUES (?1,'IN','text','this one is still here','RECEIVED')").bind(conv).run();
    await attention("FREE_TEXT", `conv:${conv}`);
    const page = await (await get("/admin")).text();
    expect(page).toContain("(message text removed)");
    expect(page).toContain("this one is still here");
  });
});

describe("packages in /admin (ticket 13)", () => {
  async function pack(o: { size?: 10 | 20; used?: number; paidAt?: string } = {}) {
    const conv = await person({ name: "Pooja Longsurname" });
    const size = o.size ?? 10;
    const price = size === 10 ? 500000 : 900000;
    const pk = (await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, ?2, ?3, 'PAID')").bind(conv, size, price).run()).meta.last_row_id;
    const paidAt = o.paidAt ?? "2026-10-01T09:00:00Z";
    const py = await db
      .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_order_id, provider_payment_id, amount_paise, state, created_at, updated_at) VALUES ('razorpay','PACKAGE',?1,'di-pack-t','pay_PK1','pay_PK1',?2,'PAID',?3,?3)")
      .bind(pk, price, paidAt)
      .run();
    await db.prepare("UPDATE packages SET payment_id = ?2 WHERE id = ?1").bind(pk, py.meta.last_row_id).run();
    await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, ?2, 'PURCHASE', 'x', 'system')").bind(pk, size).run();
    if (o.used) await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, ?2, 'ADJUST', 'x', 'test')").bind(pk, -o.used).run();
    return { conv, pk, payId: py.meta.last_row_id as number };
  }
  const fieldsOf = (page: string, action: string) => {
    const m = new RegExp(`<form method="post" action="/admin/${action}">([\\s\\S]*?)</form>`).exec(page);
    if (!m) throw new Error(`no ${action} form`);
    return Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((h) => [h[1], h[2]]));
  };
  const balance = async (pk: number) => (await db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM credits WHERE package_id = ?1").bind(pk).first<{ n: number }>())!.n;

  it("the person's page shows each package with unused × rate and a button; the next page shows the maths and asks again", async () => {
    const { conv, pk } = await pack({ used: 3 });
    const page = await (await get(`/admin/conv/${conv}`)).text();
    expect(page).toContain("10 sessions · ₹5,000");
    expect(page).toContain("Unused: 7 × ₹500 = ₹3,500");
    expect(page).toContain(`/admin/pack-refund/${pk}`);
    expect(page).toContain("Refund unused sessions");
    expect(page).not.toContain("Longsurname");
    const confirm = await (await get(`/admin/pack-refund/${pk}`)).text();
    expect(confirm).toContain("7 unused × ₹500 = ₹3,500");
    expect(confirm).toContain("Yes, refund ₹3,500");
    expect(fake.posts("/refund")).toHaveLength(0); // looking changes nothing
    expect(await balance(pk)).toBe(7);
  });

  it("confirming refunds unused × rate through Razorpay, sets the balance to 0, closes the package and is audited", async () => {
    const { conv, pk, payId } = await pack({ size: 20, used: 2 });
    const confirm = await (await get(`/admin/pack-refund/${pk}`)).text();
    expect(confirm).toContain("18 unused × ₹450 = ₹8,100");
    const res = await post("/admin/pack-refund", fieldsOf(confirm, "pack-refund"));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin?m=packrefunded");
    expect(refundPosts()).toEqual([expect.objectContaining({ amount: 810000 })]);
    expect(await balance(pk)).toBe(0);
    expect(await db.prepare("SELECT state FROM packages WHERE id = ?1").bind(pk).first()).toEqual({ state: "CLOSED" });
    expect(await db.prepare("SELECT reason, amount_paise, requested_by FROM refunds WHERE payment_id = ?1").bind(payId).first()).toEqual({ reason: "PACKAGE_UNUSED", amount_paise: 810000, requested_by: ROHIT });
    expect(await auditRows()).toEqual([{ actor: ROHIT, action: "ADMIN_PACKAGE_REFUND", target: `package:${pk}`, detail: "18 unused, ₹8,100, Razorpay" }]);
    expect(await (await get(`/admin/conv/${conv}`)).text()).toContain("Closed. Unused: 0");
    // pressing it again does nothing (a replay of the same form)
    const again = await post("/admin/pack-refund", fieldsOf(confirm, "pack-refund"));
    expect(again.headers.get("Location")).toBe("/admin?m=packstale");
    expect(refundPosts()).toHaveLength(1);
  });

  it("a forged token, a foreign origin, a changed count and Amma are all refused; nothing moves", async () => {
    const { pk } = await pack({ used: 3 });
    const confirm = await (await get(`/admin/pack-refund/${pk}`)).text();
    const f = fieldsOf(confirm, "pack-refund");
    expect((await post("/admin/pack-refund", { ...f, csrf: "nope" })).status).toBe(403);
    expect((await post("/admin/pack-refund", { ...f, unused: "8" })).status).toBe(403); // the token is for 7
    expect((await post("/admin/pack-refund", f, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/admin/pack-refund", f, { origin: null })).status).toBe(403);
    const amma = await token({ email: AMMA });
    expect((await app.request(`${ORIGIN}/admin/pack-refund/${pk}`, { headers: { "Cf-Access-Jwt-Assertion": amma } }, env())).status).toBe(403);
    // the count changed after Rohit looked: nothing is refunded
    await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, -1, 'ADJUST', 'x', 'test')").bind(pk).run();
    expect((await post("/admin/pack-refund", f)).headers.get("Location")).toBe("/admin?m=packstale");
    expect(await balance(pk)).toBe(6);
    expect(refundPosts()).toHaveLength(0);
    expect((await get("/admin/pack-refund/999")).headers.get("Location")).toBe("/admin?m=packstale");
  });

  it("a payment over 180 days old becomes a MANUAL_REFUND item with the amount; 'Mark refunded by hand' resolves it, records it and tells the customer", async () => {
    const { pk } = await pack({ used: 4, paidAt: "2026-03-01T09:00:00Z" });
    const confirm = await (await get(`/admin/pack-refund/${pk}`)).text();
    expect(confirm).toContain("older than 180 days");
    const res = await post("/admin/pack-refund", fieldsOf(confirm, "pack-refund"));
    expect(res.headers.get("Location")).toBe("/admin?m=packmanual");
    expect(refundPosts()).toHaveLength(0);
    expect(await balance(pk)).toBe(0);
    expect(await db.prepare("SELECT kind, target FROM attention WHERE resolved_at IS NULL").all().then((r) => r.results)).toEqual([{ kind: "MANUAL_REFUND", target: `package:${pk}` }]);
    const page = await (await get("/admin")).text();
    expect(page).toContain("Refund to pay by hand");
    expect(page).toContain("Pay 6 unused × ₹500 = ₹3,000");
    const done = await press("manual-paid", {}, env(), "");
    expect(done.headers.get("Location")).toBe("/admin?m=manualdone");
    expect(await db.prepare("SELECT delta, reason, by FROM credits WHERE reason = 'ADJUST' AND delta = 0").first()).toEqual({ delta: 0, reason: "ADJUST", by: ROHIT });
    expect(await count("SELECT COUNT(*) AS n FROM attention WHERE resolved_at IS NULL")).toBe(0);
    expect((await auditRows()).map((a) => a.action)).toEqual(["ADMIN_PACKAGE_REFUND", "ADMIN_MANUAL_REFUND_PAID"]);
    expect(waSent().length).toBeGreaterThan(0);
    expect(JSON.parse((waSent().at(-1)![1] as { body: string }).body).text.body).toContain("₹3,000");
    await expect(press("manual-paid", {}, env(), "")).rejects.toThrow("no manual-paid form"); // nothing left to press
  });

  it("a credit-booked session gets the Completed / No-show buttons once it has started, like a paid one", async () => {
    const { conv } = await pack();
    const s = generateSlots("2026-10-05", "SESSION")[0]; // 14:00 IST, started at 15:30
    const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
    const ses = await db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin) VALUES (?1,?2,'HEALING','CREDIT_BOOKED','CREDIT')").bind(conv, slot.meta.last_row_id).run();
    const page = await (await get("/admin")).text();
    expect(page).toContain("Booked from package");
    const res = await press("session", {}, env(), "NO_SHOW");
    expect(res.headers.get("Location")).toBe("/admin?m=done");
    expect(await db.prepare("SELECT state FROM sessions WHERE id = ?1").bind(ses.meta.last_row_id).first()).toEqual({ state: "NO_SHOW" });
    expect(await count("SELECT COUNT(*) AS n FROM credits WHERE reason = 'CANCEL_RETURN'")).toBe(0); // a no-show uses the credit
  });
});

describe("people, a person's page, and payments (ticket 17)", () => {
  const PHONE_RE = /91\d{8,}/;
  it("People lists everyone newest first, masked; search by name or last digits; filters", async () => {
    const a = await person({ name: "Zoya Quillfeather", lastUserAt: "2026-10-05T09:00:00Z" });
    const b = await person({ name: "Ravi", lastUserAt: "2026-10-05T09:30:00Z" });
    await db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(b).run();
    const wa = (await db.prepare("SELECT wa_id FROM conversations WHERE id = ?1").bind(a).first<{ wa_id: string }>())!.wa_id;
    const all = await (await get("/admin/people")).text();
    expect(all.indexOf("Ravi")).toBeLessThan(all.indexOf("Zoya"));
    expect(all).not.toMatch(PHONE_RE);
    expect(all).not.toContain("Quillfeather");
    expect(all).toContain(`…${wa.slice(-4)}`);
    expect(await (await get("/admin/people?q=zoy")).text()).not.toContain("Ravi");
    const byDigits = await (await get(`/admin/people?q=${wa.slice(-4)}`)).text();
    expect(byDigits).toContain("Zoya");
    expect(byDigits).not.toContain("Ravi");
    const human = await (await get("/admin/people?f=human")).text();
    expect(human).toContain("Ravi");
    expect(human).not.toContain("Zoya");
    expect(await (await get("/admin/people?q=nobody")).text()).toContain("Nobody matches that search.");
  });

  it("the number is shown only after a POST, which is recorded; a GET never shows it", async () => {
    const id = await person({ lastUserAt: "2026-10-03T09:00:00Z" }); // window closed
    const wa = (await db.prepare("SELECT wa_id FROM conversations WHERE id = ?1").bind(id).first<{ wa_id: string }>())!.wa_id;
    const pageText = await (await get(`/admin/conv/${id}`)).text();
    expect(pageText).not.toContain(wa);
    expect(pageText).toContain("Show number to call");
    const shown = await (await post("/admin/reveal", { conv: String(id), csrf: hidden(pageText.slice(pageText.indexOf('action="/admin/reveal"')), "csrf") })).text();
    expect(shown).toContain(`href="tel:+${wa}"`);
    expect((await auditRows()).at(-1)).toMatchObject({ actor: ROHIT, action: "ADMIN_REVEAL_NUMBER", target: `conv:${id}` });
    expect((await post("/admin/reveal", { conv: String(id), csrf: "wrong" })).status).toBe(403);
  });

  it("a reply from the person's page goes inside the window, is recorded, and counts as Rohit's reply", async () => {
    const id = await person(); // wrote an hour ago
    const pageText = await (await get(`/admin/conv/${id}`)).text();
    expect(pageText).toContain("Reply on WhatsApp");
    const res = await post("/admin/say", { conv: String(id), text: "Hello from Rohit", csrf: hidden(pageText.slice(pageText.indexOf('action="/admin/say"')), "csrf") });
    expect(res.headers.get("Location")).toBe(`/admin/conv/${id}?m=sent`);
    const sent = await db.prepare("SELECT dedupe_key, body FROM messages WHERE conversation_id = ?1 AND direction = 'OUT'").bind(id).first<{ dedupe_key: string; body: string }>();
    expect(sent!.dedupe_key).toMatch(/^admin-reply:conv:/);
    expect((await auditRows()).at(-1)).toMatchObject({ action: "ADMIN_REPLY", target: `conv:${id}` });
    const after = await (await get(`/admin/conv/${id}`)).text();
    expect(after).toContain("You · ");
    // window closed: refused, nothing sent
    const old = await person({ lastUserAt: "2026-10-03T09:00:00Z" });
    const r2 = await post("/admin/say", { conv: String(old), text: "hi", csrf: await csrfFor(`say:${old}`) });
    expect(r2.headers.get("Location")).toBe(`/admin/conv/${old}?m=window`);
  });

  it("the thread marks the assistant's answer type and replaced answers", async () => {
    const id = await person();
    await db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES ('2026-10-05T09:00:00Z','bot','AI_REPLY',?1,'objection'), ('2026-10-05T09:00:01Z','bot','AI_REJECTED',?1,'BANNED_WORD')").bind(`conv:${id}`).run();
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status,dedupe_key,created_at) VALUES (?1,'OUT','text','A fixed reply','SENT','wamid.X:ai','2026-10-05T09:00:02Z')").bind(id).run();
    const t = await (await get(`/admin/conv/${id}`)).text();
    expect(t).toContain("Assistant · ");
    expect(t).toContain("Doubt or objection");
    expect(t).toContain("Answer replaced by a fixed reply (banned word)");
  });

  it("Payments shows the last 30 days with problems first, linked to the person, masked", async () => {
    const ok = await paidIntro({ name: "Meena" });
    const bad = await paidIntro({ name: "Anil", i: 1, payState: "REFUND_FAILED" });
    const t = await (await get("/admin/payments")).text();
    expect(t.indexOf("Refund failed")).toBeLessThan(t.indexOf(">Paid<"));
    expect(t).toContain(`href="/admin/conv/${ok.conv}"`);
    expect(t).toContain(`href="/admin/conv/${bad.conv}"`);
    expect(t).not.toMatch(PHONE_RE);
    expect(t).toContain("Needs a look");
  });

  it("every page has the tab bar, and the pages escape what customers wrote", async () => {
    const id = await person({ name: "<b>x</b>" });
    for (const path of ["/admin", "/admin/people", "/admin/payments", `/admin/conv/${id}`]) {
      const t = await (await get(path)).text();
      expect(t).toContain('href="/admin/people"');
      expect(t).toContain('href="/admin/payments"');
      expect(t).not.toContain("<b>x</b>");
    }
  });
});

