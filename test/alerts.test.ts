// Ticket 45: phone alerts for the team when a customer books and pays. Settings → "Alerts on this phone" (owner and practitioner, never
// staff; token and Origin like every form), the triggers (a paid ₹99 call, session, package, a session from a package; never a hold, a
// refund or a duplicate), who gets what, the quiet hours, what a push says (read back by decrypting it as the browser does), retries and
// gone subscriptions, push off without the secrets, the digest line and the CSP. All data and keys are synthetic; nothing real is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { pushDigestLine, queueBookingAlert, sendPushAlerts, SW_JS, ALERTS_JS, dueFor } from "../src/alerts";
import { applyStatus } from "../src/pay/apply";
import type { PaymentProvider } from "../src/pay/provider";
import { digestText } from "../src/report";
import { generateSlots, iso } from "../src/slots";
import { CONSOLE_CSP } from "../src/ui";
import { ConsoleHarness, ORIGIN, OWNER, PRAC, STAFF } from "./console-env";
import { decryptPayload, testKeys, testSubscription, type TestSub } from "./pushkit";
import { paidEvent, rzpHeaders } from "./razorpay";

const NOW = Date.parse("2026-11-04T09:00:00Z"); // Wed 4 Nov, 2:30 pm India time
const h = new ConsoleHarness();
let keys: { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string };
let pushes: { url: string; body: Uint8Array; headers: Record<string, string> }[];
let pushStatus: (url: string) => number;
const subs = new Map<string, TestSub>(); // endpoint -> the browser's keys, to read a push back

beforeEach(async () => {
  await h.start(NOW);
  keys = await testKeys();
  h.vars = { ...keys, WA_APP_SECRET: "test-app-secret", WA_TOKEN: "tok", WA_PHONE_ID: "1000" };
  pushes = [];
  pushStatus = () => 201;
  // Push services answer here; everything else goes to the harness's own fakes.
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: Uint8Array }) => {
      const u = String(url);
      if (/^https:\/\/(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[^/]+\.notify\.windows\.com)\//.test(u)) {
        pushes.push({ url: u, body: init.body as Uint8Array, headers: init.headers ?? {} });
        return new Response("", { status: pushStatus(u) });
      }
      return base(url, init as never);
    }),
  );
});
afterEach(() => h.stop());

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const id = async (email: string) => (await h.member(email))!.id;
const token = (email: string) => h.tokenFor(email, "settings-alerts");
const read = async (p: { url: string; body: Uint8Array }) => JSON.parse(await decryptPayload(subs.get(p.url)!, p.body)) as { title: string; body: string; url: string; tag: string };

// A browser turning alerts on through the page's form, as /app/alerts.js posts it.
async function turnOn(email: string, host = "fcm.googleapis.com", ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36") {
  const sub = await testSubscription(host);
  subs.set(sub.endpoint, sub);
  const res = await postAs(email, "/app/settings/alerts/on", { csrf: await token(email), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, ua);
  return { sub, res };
}
async function postAs(email: string, path: string, form: Record<string, string>, ua?: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await h.jwtFor(email), "Content-Type": "application/x-www-form-urlencoded" };
  if (origin) headers.Origin = origin;
  if (ua) headers["User-Agent"] = ua;
  return app.request(ORIGIN + path, { method: "POST", headers, body: new URLSearchParams(form).toString() }, h.env());
}

// ---- synthetic bookings: a customer with a held call or session and its open payment link, paid through the real payment code ----
const provider = { refund: async () => ({ providerRefundId: "rfnd_FAKE0001", status: "PENDING" }), getRefund: async () => ({ status: "PENDING" }) } as unknown as PaymentProvider;
let phone = 919800000100;
let slotN = 0; // each default booking takes the next hour on Thu 5 Nov (3 pm, 4 pm, ...), so no two holds collide
beforeEach(() => void (slotN = 0));
async function customer(name = "Asha Testname") {
  const wa = String(++phone);
  const conv = (await h.db.prepare("INSERT INTO conversations (wa_id, display_name, locale, mode, last_user_at, age_ok_at) VALUES (?1, ?2, 'en', 'BOT', ?3, '2026-01-01T00:00:00Z')").bind(wa, name, iso(Date.now())).run()).meta.last_row_id;
  return { conv, wa, name };
}
async function heldBooking(kind: "INTRO" | "SESSION", o: { practitioner?: number | null; startUtc?: string; conv?: number } = {}) {
  const c = o.conv ? { conv: o.conv, wa: "", name: "" } : await customer();
  const start = o.startUtc ?? iso(Date.parse("2026-11-05T09:30:00Z") + slotN++ * 3_600_000);
  const end = iso(Date.parse(start) + (kind === "INTRO" ? 15 : 60) * 60_000);
  const prac = o.practitioner === undefined ? await id(PRAC) : o.practitioner;
  const slot = (
    await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until, practitioner_id) VALUES (?1, ?2, ?3, ?4, 'HELD', ?5, ?6)")
      .bind(kind === "INTRO" ? "CALL" : "SESSION", start, end, c.conv, iso(Date.now() + 20 * 60_000), prac).run()
  ).meta.last_row_id;
  const target =
    kind === "INTRO"
      ? (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'HEALING', 'HELD', ?3)").bind(c.conv, slot, prac).run()).meta.last_row_id
      : (await h.db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, practitioner_id) VALUES (?1, ?2, 'HEALING', 'HELD', 'SELF', ?3)").bind(c.conv, slot, prac).run()).meta.last_row_id;
  const pay = await openPayment(kind, target, kind === "INTRO" ? 9900 : 79900);
  return { ...c, target, pay, start };
}
async function openPayment(purpose: string, target: number, paise: number) {
  const link = `plink_T${purpose}${target}x${Math.random().toString(36).slice(2, 8)}`;
  const pay = (await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', ?1, ?2, ?3, ?4, 'PENDING', ?5)").bind(purpose, target, link, paise, iso(Date.now())).run()).meta.last_row_id;
  return { id: pay, link, paise };
}
const paid = (p: { link: string; paise: number }, n = 1) => applyStatus(h.env(), provider, { linkId: p.link, status: "PAID", paidPaise: p.paise, currency: "INR", orderId: `pay_FAKE${n}${p.link.slice(-6)}`, mode: "test" });
async function packageFor(conv: number, size = 10) {
  const k = (await h.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, ?2, ?3, 'PENDING')").bind(conv, size, size === 10 ? 500000 : 900000).run()).meta.last_row_id;
  return { k, pay: await openPayment("PACKAGE", k, size === 10 ? 500000 : 900000) };
}
const outbox = () => h.db.prepare("SELECT member_id AS memberId, kind, target, state, held, due_at AS dueAt, attempts FROM push_outbox ORDER BY id").all<{ memberId: number; kind: string; target: string; state: string; held: number; dueAt: string; attempts: number }>().then((r) => r.results);

// ======================================================================================================================================
describe("Settings → Alerts on this phone: who sees it", () => {
  it("the owner: the section with its buttons, the iPhone line, and the page's CSP allows its own script", async () => {
    const res = await h.get("/app/settings");
    const t = decode(await res.text());
    expect(t).toContain("Alerts on this phone");
    expect(t).toContain("iPhone: open this from the home-screen icon first; needs iOS 16.4 or later.");
    expect(t).toContain('<script src="/app/alerts.js" defer></script>');
    expect(t).toContain(`data-key="${keys.VAPID_PUBLIC_KEY}"`);
    expect(t).toContain("Turn on");
    expect(t).toContain("Services and prices"); // the rest of Settings is still there for the owner
    expect(res.headers.get("Content-Security-Policy")).toBe(`${CONSOLE_CSP}; script-src 'self'; worker-src 'self'`);
    expect(t).not.toMatch(/<script>|<script(?![^>]*src="\/app\/alerts\.js")/); // no inline script
  });

  it("the practitioner: a Settings tab with only this section (no prices, switches or team)", async () => {
    const home = await (await h.get("/app", PRAC)).text();
    expect(home).toContain('href="/app/settings"');
    const res = await h.get("/app/settings", PRAC);
    expect(res.status).toBe(200);
    const t = decode(await res.text());
    expect(t).toContain("Alerts on this phone");
    expect(t).toContain("one of your customers");
    expect(t).toContain("Between 9:00 pm and 8:00 am they wait until 8:00 am.");
    for (const not of ["Services and prices", "Business name", "Taking bookings", "Razorpay", "/app/settings/team", "/app/settings/audit"]) expect(t).not.toContain(not);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    // Every other Settings POST still refuses her.
    const r = await h.post("/app/settings/privacy", { csrf: await h.tokenFor(PRAC, "settings-privacy:off"), v: "off" }, PRAC);
    expect(r.status).toBe(403);
  });

  it("staff: no Settings tab, the page and every alert form refused", async () => {
    expect(await (await h.get("/app", STAFF)).text()).not.toContain('href="/app/settings"');
    expect((await h.get("/app/settings", STAFF)).status).toBe(403);
    for (const path of ["/app/settings/alerts/on", "/app/settings/alerts/off", "/app/settings/alerts/test", "/app/settings/alerts/remove"]) {
      const sub = await testSubscription();
      const r = await postAs(STAFF, path, { csrf: await token(STAFF), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, id: "1" });
      expect(r.status, path).toBe(403);
    }
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
  });

  it("Hindi console: the section in Hindi", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    const t = decode(await (await h.get("/app/settings", PRAC)).text());
    expect(t).toContain("इस फ़ोन पर अलर्ट");
    expect(t).toContain("चालू करें");
  });
});

describe("turning alerts on and off", () => {
  it("on: one row (address, keys, 'Chrome on Android', date), audited; the list shows the device with Remove; again: still one row", async () => {
    const { sub, res } = await turnOn(OWNER);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app/settings?m=alertsOn#alerts");
    const row = await h.db.prepare("SELECT member_id AS m, endpoint, p256dh, auth, ua FROM push_subs").first<Record<string, unknown>>();
    expect(row).toEqual({ m: await id(OWNER), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, ua: "Chrome on Android" });
    expect((await h.audits("PUSH_SUBSCRIBED")).map((a) => [a.target, a.detail])).toEqual([[`member:${await id(OWNER)}`, "Chrome on Android"]]);
    const t = decode(await (await h.get("/app/settings?m=alertsOn")).text());
    expect(t).toContain("Alerts are on for this phone.");
    expect(t).toContain("Chrome on Android");
    expect(t).toContain("Added Wed, 4 Nov");
    expect(t).toContain("Send a test alert");
    expect(t).not.toContain(sub.endpoint); // the page names the device, never its address
    await postAs(OWNER, "/app/settings/alerts/on", { csrf: await token(OWNER), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(1);
    expect(await h.audits("PUSH_SUBSCRIBED")).toHaveLength(1); // nothing changed, nothing logged
  });

  it("a forged or another member's token, no Origin or a foreign one: refused, nothing stored", async () => {
    const sub = await testSubscription();
    const form = { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth };
    expect((await postAs(OWNER, "/app/settings/alerts/on", { ...form, csrf: "0".repeat(64) })).status).toBe(403);
    expect((await postAs(OWNER, "/app/settings/alerts/on", { ...form, csrf: await token(PRAC) })).status).toBe(403);
    expect((await postAs(OWNER, "/app/settings/alerts/on", { ...form, csrf: await token(OWNER) }, undefined, null)).status).toBe(403);
    expect((await postAs(OWNER, "/app/settings/alerts/on", { ...form, csrf: await token(OWNER) }, undefined, "https://evil.example")).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
  });

  it("an address off the push-service list, or keys that aren't keys: not stored", async () => {
    const sub = await testSubscription();
    for (const bad of [
      { endpoint: "https://evil.example/fcm/send/x", p256dh: sub.p256dh, auth: sub.auth },
      { endpoint: "http://fcm.googleapis.com/fcm/send/x", p256dh: sub.p256dh, auth: sub.auth },
      { endpoint: sub.endpoint, p256dh: "abc", auth: sub.auth },
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: "" },
    ]) {
      const r = await postAs(OWNER, "/app/settings/alerts/on", { ...bad, csrf: await token(OWNER) });
      expect(r.headers.get("Location")).toBe("/app/settings?m=alertsBad#alerts");
    }
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
  });

  it("off and Remove: only the member's own device goes, audited; another member's id is not found", async () => {
    const a = await turnOn(OWNER);
    const b = await turnOn(PRAC, "web.push.apple.com", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
    const pracSub = (await h.db.prepare("SELECT id, ua FROM push_subs WHERE endpoint = ?1").bind(b.sub.endpoint).first<{ id: number; ua: string }>())!;
    expect(pracSub.ua).toBe("Safari on iPhone");
    expect((await postAs(OWNER, "/app/settings/alerts/remove", { csrf: await token(OWNER), id: String(pracSub.id) })).status).toBe(404);
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(2);
    const off = await postAs(OWNER, "/app/settings/alerts/off", { csrf: await token(OWNER), endpoint: a.sub.endpoint });
    expect(off.headers.get("Location")).toBe("/app/settings?m=alertsOff#alerts");
    const rm = await postAs(PRAC, "/app/settings/alerts/remove", { csrf: await token(PRAC), id: String(pracSub.id) });
    expect(rm.headers.get("Location")).toBe("/app/settings?m=alertsRemoved#alerts");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
    expect((await h.audits("PUSH_UNSUBSCRIBED")).map((x) => x.detail)).toEqual(["Chrome on Android", "Safari on iPhone"]);
  });

  it("a browser another member turned on moves to whoever turns it on now", async () => {
    const { sub } = await turnOn(OWNER);
    await postAs(PRAC, "/app/settings/alerts/on", { csrf: await token(PRAC), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
    expect(await h.db.prepare("SELECT member_id AS m FROM push_subs").all<{ m: number }>().then((r) => r.results)).toEqual([{ m: await id(PRAC) }]);
  });

  it("Send a test alert: one push to each of the member's devices, readable only by that browser; a gone one is deleted", async () => {
    const { sub } = await turnOn(PRAC);
    await turnOn(OWNER); // not the practitioner's: no test for it
    const r = await postAs(PRAC, "/app/settings/alerts/test", { csrf: await token(PRAC) });
    expect(r.headers.get("Location")).toBe("/app/settings?m=alertsTestSent#alerts");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toBe(sub.endpoint);
    expect(pushes[0].headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(await read(pushes[0])).toEqual({ title: "Test alert", body: "Alerts are working on this phone.", url: "/app/settings#alerts", tag: "test" });
    pushStatus = () => 500;
    expect((await postAs(PRAC, "/app/settings/alerts/test", { csrf: await token(PRAC) })).headers.get("Location")).toBe("/app/settings?m=alertsTestFailed#alerts");
    pushStatus = () => 410;
    expect((await postAs(PRAC, "/app/settings/alerts/test", { csrf: await token(PRAC) })).headers.get("Location")).toBe("/app/settings?m=alertsNoDevice#alerts");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs WHERE member_id = ?1", await id(PRAC))).toBe(0);
  });

  it("without the two secrets: the section says so, no script and no script CSP, the forms change nothing, nothing is queued", async () => {
    h.vars = {};
    const res = await h.get("/app/settings");
    const t = decode(await res.text());
    expect(t).toContain("Alerts aren't set up for this copy of the bot yet");
    expect(t).not.toContain("<script");
    expect(res.headers.get("Content-Security-Policy")).toBe(CONSOLE_CSP);
    const sub = await testSubscription();
    const r = await postAs(OWNER, "/app/settings/alerts/on", { csrf: await token(OWNER), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
    expect(r.headers.get("Location")).toBe("/app/settings?m=alertsPushOff#alerts");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
    const b = await heldBooking("INTRO");
    expect(await paid(b.pay)).toBe("BOOKED");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(0);
    expect(await sendPushAlerts(h.env())).toBe(0);
    expect(await pushDigestLine(h.env())).toBe("Phone alerts to the team: off (the alert keys aren't set).");
  });
});

describe("the scripts and the CSP", () => {
  it("/app/sw.js and /app/alerts.js: JavaScript, nosniff, their own CSP; 404 while the console is off", async () => {
    const sw = await app.request(`${ORIGIN}/app/sw.js`, {}, h.env());
    expect(sw.status).toBe(200);
    expect(sw.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(sw.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(sw.headers.get("Content-Security-Policy")).toBe("default-src 'none'; script-src 'self'; img-src 'self'");
    expect(await sw.text()).toBe(SW_JS);
    const js = await app.request(`${ORIGIN}/app/alerts.js`, {}, h.env());
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe(ALERTS_JS);
    for (const path of ["/app/sw.js", "/app/alerts.js"]) expect((await app.request(`${ORIGIN}${path}`, {}, h.env({ CONSOLE_V2: "false" }))).status).toBe(404);
    for (const src of [SW_JS, ALERTS_JS]) {
      expect(src).not.toMatch(/\beval\s*\(|new Function|setTimeout\(\s*["']|innerHTML/);
    }
    expect(SW_JS).toContain('pathname.indexOf("/app/") === 0'); // a tap only ever opens a console page
    expect(ALERTS_JS).toContain('register("/app/sw.js", { scope: "/app/" })');
    expect(ALERTS_JS).toContain("userVisibleOnly: true");
  });

  it("every other console page stays script-free", async () => {
    for (const [path, who] of [["/app", OWNER], ["/app/calendar", OWNER], ["/app/people", OWNER], ["/app/payments", OWNER], ["/app/inbox", STAFF], ["/app/settings/audit", OWNER], ["/app/settings/team", OWNER], ["/app", PRAC]] as const) {
      const res = await h.get(path, who);
      expect(res.headers.get("Content-Security-Policy"), path).toBe(CONSOLE_CSP);
      expect(await res.text(), path).not.toContain("<script");
    }
  });

  it("the web app manifest the home-screen icon opens: standalone, start /app, in scope", async () => {
    const m = await (await app.request(`${ORIGIN}/app/manifest.webmanifest`, {}, h.env())).json<{ display: string; start_url: string; scope: string }>();
    expect(m.display).toBe("standalone");
    expect(m.start_url.startsWith(m.scope)).toBe(true);
    expect("/app/settings".startsWith(m.scope)).toBe(true);
  });
});

// ======================================================================================================================================
describe("the triggers: one alert per booking and member", () => {
  beforeEach(async () => {
    await turnOn(OWNER);
    await turnOn(PRAC);
    // Staff can't turn alerts on; even a row written by hand gets nothing.
    const s = await testSubscription();
    await h.db.prepare("INSERT INTO push_subs (member_id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(await id(STAFF), s.endpoint, s.p256dh, s.auth, iso(NOW)).run();
  });

  it("a paid ₹99 call: the owner and the call's practitioner, once each, even when the payment is replayed; staff never", async () => {
    const b = await heldBooking("INTRO");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(0); // a hold alerts nobody
    expect(await paid(b.pay)).toBe("BOOKED");
    await paid(b.pay); // the webhook and the cron both saw it
    const rows = await outbox();
    expect(rows.map((r) => [r.memberId, r.kind, r.target, r.state, r.held])).toEqual([
      [await id(OWNER), "CALL", `payment:${b.pay.id}`, "PENDING", 0],
      [await id(PRAC), "CALL", `payment:${b.pay.id}`, "PENDING", 0],
    ]);
    expect(await sendPushAlerts(h.env())).toBe(2);
    expect(pushes).toHaveLength(2);
    for (const p of pushes) {
      const msg = await read(p);
      expect(msg).toEqual({ title: "New booking", body: "₹99 call · Tomorrow, 3:00 pm", url: "/app/calendar?view=day&d=2026-11-05", tag: expect.stringMatching(/^booking-\d+$/) });
      const raw = JSON.stringify(msg);
      for (const secret of [b.name, "Asha", b.wa, b.wa.slice(-4), "HEALING", "Healing"]) expect(raw).not.toContain(secret);
    }
    expect(await sendPushAlerts(h.env())).toBe(0); // sent once
    expect((await outbox()).map((r) => r.state)).toEqual(["SENT", "SENT"]);
  });

  it("today's call taps through to its card on Today; Hindi words for a Hindi console", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    const b = await heldBooking("INTRO", { startUtc: generateSlots("2026-11-04", "CALL")[7].startUtc }); // today 3:45 pm
    await paid(b.pay);
    await sendPushAlerts(h.env());
    const byUrl = new Map((await Promise.all(pushes.map(read))).map((m) => [m.body, m]));
    expect(byUrl.get("₹99 call · Today, 3:45 pm")?.url).toBe(`/app#b-intro-${b.target}`);
    expect(byUrl.get("₹99 कॉल · आज, दोपहर 3:45")?.title).toBe("नई बुकिंग");
  });

  it("a practitioner gets only her own customers' bookings; a second practitioner's call doesn't reach her", async () => {
    const other = (await h.db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, 'second.practitioner@example.test', 'PRACTITIONER', 'active')").run()).meta.last_row_id;
    const b = await heldBooking("INTRO", { practitioner: other });
    await paid(b.pay);
    expect((await outbox()).map((r) => r.memberId)).toEqual([await id(OWNER)]); // the other practitioner has no device; Amma isn't hers
  });

  it("a paid ₹799 session: owner and practitioner", async () => {
    const b = await heldBooking("SESSION", { startUtc: generateSlots("2026-11-06", "SESSION")[0].startUtc });
    expect(await paid(b.pay)).toBe("BOOKED");
    await sendPushAlerts(h.env());
    const bodies = (await Promise.all(pushes.map(read))).map((m) => m.body);
    expect(bodies).toEqual(["₹799 session · Fri, 6 Nov, 2:00 pm", "₹799 session · Fri, 6 Nov, 2:00 pm"]);
    expect((await outbox()).map((r) => r.kind)).toEqual(["SESSION", "SESSION"]);
  });

  it("a paid package: the owner always; the practitioner only when the buyer is her customer", async () => {
    const stranger = await customer();
    const p1 = await packageFor(stranger.conv, 10);
    expect(await paid(p1.pay)).toBe("BOOKED");
    expect((await outbox()).map((r) => [r.memberId, r.kind])).toEqual([[await id(OWNER), "PACKAGE"]]);
    // A buyer who had a paid call with her
    const call = await heldBooking("INTRO");
    await paid(call.pay);
    const p2 = await packageFor(call.conv, 20);
    await paid(p2.pay);
    const pk = (await outbox()).filter((r) => r.target === `payment:${p2.pay.id}`);
    expect(pk.map((r) => r.memberId)).toEqual([await id(OWNER), await id(PRAC)]);
    await sendPushAlerts(h.env());
    const msgs = await Promise.all(pushes.map(read));
    expect(msgs.filter((m) => m.body === "Package of 20 paid").map((m) => m.url)).toEqual([`/app/people/${call.conv}`, `/app/people/${call.conv}`]);
    expect(msgs.filter((m) => m.body === "Package of 10 paid")).toHaveLength(1);
  });

  it("a session booked from a package (the customer's tap on WhatsApp): owner and practitioner, once", async () => {
    const c = await customer();
    const pk = await packageFor(c.conv, 10);
    await paid(pk.pay);
    await h.db.prepare("DELETE FROM push_outbox").run();
    const start = generateSlots("2026-11-06", "SESSION")[1].startUtc;
    const tap = async () => {
      const raw = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: c.wa, profile: { name: "Test Person" } }], messages: [{ id: `wamid.A${Math.random()}`, from: c.wa, timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id: `btm_HEALING_SELF_${start}`, title: "x" } } }] } }] }] });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-app-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((x) => x.toString(16).padStart(2, "0")).join("");
      return app.request(`${ORIGIN}/wa/webhook`, { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, h.env());
    };
    await tap();
    await tap(); // a double tap books once
    const ses = (await h.db.prepare("SELECT id FROM sessions WHERE state = 'CREDIT_BOOKED'").all<{ id: number }>()).results;
    expect(ses).toHaveLength(1);
    expect((await outbox()).map((r) => [r.memberId, r.kind, r.target])).toEqual([
      [await id(OWNER), "CREDIT_SESSION", `session:${ses[0].id}`],
      [await id(PRAC), "CREDIT_SESSION", `session:${ses[0].id}`],
    ]);
    await sendPushAlerts(h.env());
    expect((await Promise.all(pushes.map(read))).map((m) => m.body)).toEqual(["Session from package · Fri, 6 Nov, 3:00 pm", "Session from package · Fri, 6 Nov, 3:00 pm"]);
  });

  it("never on a duplicate payment, an expired hold, a payment of the wrong amount; a refund before sending skips it", async () => {
    const b = await heldBooking("SESSION");
    await paid(b.pay);
    const dup = await openPayment("SESSION", b.target, 79900);
    expect(await paid(dup, 2)).toBe("DUPLICATE_REFUNDED");
    expect((await outbox()).every((r) => r.target === `payment:${b.pay.id}`)).toBe(true);
    const held = await heldBooking("INTRO");
    await applyStatus(h.env(), provider, { linkId: held.pay.link, status: "EXPIRED", paidPaise: 0, currency: "INR" });
    const wrong = await heldBooking("INTRO");
    expect(await applyStatus(h.env(), provider, { linkId: wrong.pay.link, status: "PAID", paidPaise: 100, currency: "INR", mode: "test" })).toBe("MISMATCH");
    expect(await h.count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(2);
    // Refunded (say, Not right fit) before the cron ran: nothing goes.
    await h.db.prepare("UPDATE payments SET state = 'REFUND_PENDING' WHERE id = ?1").bind(b.pay.id).run();
    expect(await sendPushAlerts(h.env())).toBe(0);
    expect(pushes).toHaveLength(0);
    expect((await outbox()).map((r) => r.state)).toEqual(["SKIPPED", "SKIPPED"]);
    // And a refunded payment never queues one.
    expect(await queueBookingAlert(h.env(), "SESSION", b.pay.id)).toBe(0);
  });

  it("a member removed since, or one with no device: nothing", async () => {
    await h.db.prepare("DELETE FROM push_subs WHERE member_id = ?1").bind(await id(PRAC)).run();
    const b = await heldBooking("INTRO");
    await paid(b.pay);
    expect((await outbox()).map((r) => r.memberId)).toEqual([await id(OWNER)]);
    await h.db.prepare("UPDATE members SET status = 'removed' WHERE email = ?1").bind(OWNER).run();
    expect(await sendPushAlerts(h.env())).toBe(0);
    expect((await outbox()).map((r) => r.state)).toEqual(["SKIPPED"]);
  });
});

describe("quiet hours (the practitioner: 9 pm to 8 am India time)", () => {
  it("the owner at once; the practitioner's wait until 8:00 and go as one summary", async () => {
    await turnOn(OWNER);
    await turnOn(PRAC);
    vi.setSystemTime(Date.parse("2026-11-04T16:30:00Z")); // 10:00 pm India time
    const calls = [];
    for (const i of [0, 1, 2]) calls.push(await heldBooking("INTRO", { startUtc: generateSlots("2026-11-05", "CALL")[i * 4].startUtc }));
    for (const c of calls) await paid(c.pay);
    const rows = await outbox();
    expect(rows).toHaveLength(6);
    const prac = await id(PRAC);
    for (const r of rows) {
      if (r.memberId === prac) expect([r.held, r.dueAt]).toEqual([1, "2026-11-05T02:30:00Z"]);
      else expect([r.held, r.dueAt]).toEqual([0, "2026-11-04T16:30:00Z"]);
    }
    expect(await sendPushAlerts(h.env())).toBe(3);
    expect(pushes).toHaveLength(3); // the owner's three, at once
    vi.setSystemTime(Date.parse("2026-11-05T02:28:00Z")); // 7:58 am: still waiting
    expect(await sendPushAlerts(h.env())).toBe(0);
    vi.setSystemTime(Date.parse("2026-11-05T02:30:00Z")); // 8:00 am
    pushes = [];
    expect(await sendPushAlerts(h.env())).toBe(3);
    expect(pushes).toHaveLength(1);
    expect(await read(pushes[0])).toEqual({ title: "New bookings", body: "3 new bookings overnight", url: "/app", tag: "bookings-overnight" });
  });

  it("one alert that waited goes as itself; the hours come from config", () => {
    const at = (utc: string) => dueFor("PRACTITIONER", Date.parse(utc));
    expect(at("2026-11-04T15:29:00Z")).toEqual({ dueMs: Date.parse("2026-11-04T15:29:00Z"), held: false }); // 8:59 pm
    expect(at("2026-11-04T15:30:00Z")).toEqual({ dueMs: Date.parse("2026-11-05T02:30:00Z"), held: true }); // 9:00 pm
    expect(at("2026-11-04T20:00:00Z")).toEqual({ dueMs: Date.parse("2026-11-05T02:30:00Z"), held: true }); // 1:30 am
    expect(at("2026-11-05T02:30:00Z")).toEqual({ dueMs: Date.parse("2026-11-05T02:30:00Z"), held: false }); // 8:00 am
    expect(dueFor("OWNER", Date.parse("2026-11-04T20:00:00Z"))).toEqual({ dueMs: Date.parse("2026-11-04T20:00:00Z"), held: false });
  });

  it("a single overnight booking goes on its own words at 8:00", async () => {
    await turnOn(PRAC);
    vi.setSystemTime(Date.parse("2026-11-04T17:00:00Z"));
    const b = await heldBooking("INTRO");
    await paid(b.pay);
    vi.setSystemTime(Date.parse("2026-11-05T02:31:00Z"));
    await sendPushAlerts(h.env());
    expect((await read(pushes[0])).body).toBe("₹99 call · Today, 3:00 pm");
  });
});

describe("delivery: gone subscriptions and retries", () => {
  it("404 or 410: the subscription is deleted and the alert skipped (no device left)", async () => {
    for (const status of [404, 410]) {
      await h.db.prepare("DELETE FROM push_outbox").run();
      await turnOn(OWNER);
      pushStatus = () => status;
      const b = await heldBooking("INTRO");
      await paid(b.pay);
      await sendPushAlerts(h.env());
      expect(await h.count("SELECT COUNT(*) AS n FROM push_subs")).toBe(0);
      expect((await outbox()).map((r) => r.state)).toEqual(["SKIPPED"]);
    }
  });

  it("another error: tried again on the next runs, then given up after 3 tries; one good device is enough", async () => {
    const a = await turnOn(OWNER);
    pushStatus = () => 503;
    const b = await heldBooking("INTRO");
    await paid(b.pay);
    for (const want of [["PENDING", 1], ["PENDING", 2], ["FAILED", 3]] as const) {
      await sendPushAlerts(h.env());
      expect((await outbox()).map((r) => [r.state, r.attempts])).toEqual([want]);
    }
    expect(pushes).toHaveLength(3);
    await sendPushAlerts(h.env());
    expect(pushes).toHaveLength(3); // never again
    expect(await h.db.prepare("SELECT failure_count AS f FROM push_subs WHERE endpoint = ?1").bind(a.sub.endpoint).first<{ f: number }>()).toEqual({ f: 3 });
    // A second device that works: the next alert counts as sent, and the good device's last success is kept.
    const good = await turnOn(OWNER, "web.push.apple.com");
    pushStatus = (u) => (u === good.sub.endpoint ? 201 : 503);
    const c = await heldBooking("INTRO");
    await paid(c.pay);
    expect(await sendPushAlerts(h.env())).toBe(1);
    expect(await h.db.prepare("SELECT last_success_at AS at FROM push_subs WHERE endpoint = ?1").bind(good.sub.endpoint).first<{ at: string }>()).toEqual({ at: iso(NOW) });
  });

  it("two runs at once send an alert once", async () => {
    await turnOn(OWNER);
    const b = await heldBooking("INTRO");
    await paid(b.pay);
    await Promise.all([sendPushAlerts(h.env()), sendPushAlerts(h.env())]);
    expect(pushes).toHaveLength(1);
  });

  it("right after the payment webhook, not two minutes later (waitUntil)", async () => {
    await turnOn(OWNER);
    const b = await heldBooking("INTRO");
    const waits: Promise<unknown>[] = [];
    const raw = JSON.stringify(paidEvent(b.pay.link, { amount: 9900 }));
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => undefined };
    const res = await app.request(`${ORIGIN}/pay/razorpay/webhook`, { method: "POST", body: raw, headers: await rzpHeaders(raw) }, h.env(), ctx as never);
    expect(res.status).toBe(200);
    await Promise.all(waits);
    expect(waits).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });
});

describe("the daily digest", () => {
  it("one line: sent and not delivered in the last 24 hours", async () => {
    await turnOn(OWNER);
    const b = await heldBooking("INTRO");
    await paid(b.pay);
    await sendPushAlerts(h.env());
    pushStatus = () => 500;
    const c = await heldBooking("INTRO");
    await paid(c.pay);
    for (let i = 0; i < 3; i++) await sendPushAlerts(h.env());
    const text = await digestText(h.env());
    expect(text).toContain("Phone alerts to the team (last 24 hours): 1 sent, 1 not delivered.");
    expect(text.split("\n").filter((l) => l.includes("Phone alerts"))).toHaveLength(1);
  });
});
