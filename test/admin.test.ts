import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { bookingChoice } from "../src/booking";
import { runDigest, digestText } from "../src/report";
import { sendAlerts } from "../src/mail";
import { bookingsOpen, sendsOn } from "../src/switches";
import { raiseAwayItems, raiseTapReminders, recordHeartbeat } from "../src/watch";
import { applyStatus } from "../src/pay/apply";
import { cashfree } from "../src/pay/cashfree";
import { requestRefund } from "../src/pay/refund";
import { sendMessage } from "../src/send";
import { generateSlots } from "../src/slots";
import { addPerson, newDb } from "./db";

// All data is synthetic. Mon 2026-10-05, 15:30 IST. Access, Cashfree, Meta and email are mocked: nothing real is called.
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
    DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, AMMA_EMAIL: AMMA, ROHIT_EMAIL: ROHIT, NEW_BOOKINGS: "true", SENDS: "true", PAYMENT_MODE: "test",
    CASHFREE_APP_ID: "test-app", CASHFREE_SECRET: "test-secret", WA_TOKEN: "tok", WA_PHONE_ID: "1000", DIGEST_TO: "ops@example.test",
    EMAIL: { send: async (m: (typeof emails)[number]) => { if (emailDown) throw Object.assign(new Error("down"), { code: "E_DELIVERY_FAILED" }); emails.push(m); return { messageId: "x" }; } },
    ...o,
  }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
let refundStore: Set<string>;
beforeEach(async () => {
  session = undefined;
  emails = [];
  emailDown = false;
  refundStore = new Set();
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/cdn-cgi/access/certs")) return json(jwks);
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: "wamid.OUT" }] });
    const refund = /\/orders\/([^/]+)\/refunds(?:\/([^/]+))?$/.exec(u);
    if (refund) {
      if (init.method === "POST") {
        refundStore.add(JSON.parse(init.body!).refund_id);
        return json({ cf_refund_id: 901, refund_status: "SUCCESS" });
      }
      return refundStore.has(refund[2]) ? json({ refund_status: "SUCCESS" }) : json({}, 404);
    }
    return json({}, 404);
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
const refundPosts = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/refunds") && (c[1] as { method: string }).method === "POST");

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
  const pay = await db.prepare("INSERT INTO payments (provider,purpose,target_id,provider_link_id,provider_order_id,amount_paise,state) VALUES ('cashfree','INTRO',?1,?2,?3,9900,?4)")
    .bind(intro.meta.last_row_id, `link${n}`, `order${n}`, o.payState ?? "PAID").run();
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
    expect(JSON.parse(refundPosts()[0][1].body).refund_id).toBe(`refund-${payId}`);
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
    expect(await requestRefund(env(), cashfree(env()), payId, "ADMIN", ROHIT)).toBe("EXISTS");
    expect(refundPosts()).toHaveLength(0);
  });
  it("refunding a PAYMENT_MISMATCH payment returns the amount actually paid, not the price", async () => {
    const { payId } = await paidIntro({ payState: "PENDING" });
    const link = (await db.prepare("SELECT provider_link_id AS l FROM payments WHERE id = ?1").bind(payId).first<{ l: string }>())!.l;
    await applyStatus(env(), cashfree(env()), { linkId: link, status: "PAID", paidPaise: 15000, currency: "INR", orderId: "order-x" });
    expect(await db.prepare("SELECT state, paid_paise AS paid FROM payments WHERE id = ?1").bind(payId).first()).toEqual({ state: "UNKNOWN", paid: 15000 });
    await attention("PAYMENT_MISMATCH", `payment:${payId}`);
    await press("refund");
    expect(refundPosts()).toHaveLength(1);
    expect(JSON.parse(refundPosts()[0][1].body).refund_amount).toBe(150);
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
    expect(refundStore.has(`refund-${p2.payId}`)).toBe(true);
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
    expect(page).toContain("Amma away: AWAY");
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
    expect(page).toContain("New chats: 1");
    expect(page).toContain("₹99 paid: 1");
    expect(page).toContain("Refunds: 1 (₹99)");
  });
});

describe("digest and alerts", () => {
  it("digest lists open items by kind, tomorrow's bookings, the scoreboard and switches that are off", async () => {
    const t = await paidIntro({ ymd: "2026-10-06", i: 0, name: "Tomorrow Caller" });
    await attention("FREE_TEXT", "conv:1");
    await attention("FREE_TEXT", "conv:2");
    await attention("REFUND_FAILED", `payment:${t.payId}`);
    await confirmedSession("2026-10-06", 2, "Sess Person");
    await db.prepare("INSERT INTO settings (key,value) VALUES ('SENDS','false')").run();
    await runDigest(env(), NOW);
    const mail = emails.find((m) => m.subject === "Disha Dira daily digest")!;
    expect(mail.to).toBe("ops@example.test");
    expect(mail.text).toContain("- FREE_TEXT: 2");
    expect(mail.text).toContain("- REFUND_FAILED: 1");
    expect(mail.text).toMatch(/call · Tomorrow/);
    expect(mail.text).toMatch(/session · Sess/);
    expect(mail.text).toContain("New chats:");
    expect(mail.text).toContain("SENDS is OFF");
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
