// Ticket 24: Settings (/app/settings) and the audit log, owner only; the prices the bot quotes; the switches' env-is-master rule;
// who gets the daily summary and the crisis email. All data is synthetic; Access, email, WhatsApp and Razorpay are fakes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_PRICES, KEYS, loadPrices, priceAt, prices, readPrices, recipients, staffReadsChat, validPrice } from "../src/business";
import { allCopy, copyFor } from "../src/copy";
import { runDigest } from "../src/report";
import { TOKENS } from "../src/ui";
import { ALERTS, ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";
import { paidEvent, rzpHeaders } from "./razorpay";
import { slotAt } from "./slotat";
import { Wa } from "./wa";
import app from "../src/index";

const NOW = Date.parse("2026-10-27T08:00:00Z"); // Tue 27 Oct, 1:30 pm India time
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());

// The page as a person reads it: entities decoded (the tests look for words with apostrophes).
const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const page = async (path = "/app/settings", as = OWNER) => decode(await (await h.get(path, as)).text());
// Only the audit log's rows (the filter's own options name every action).
const logRows = (html: string) => /<div class="rows log">([\s\S]*?)<\/div><\/section>/.exec(html)?.[1] ?? "";
// The csrf token of the form posting to `action` (with optional hidden `name` field values), as the page drew it.
const csrfOn = (html: string, action: string, fields: Record<string, string> = {}) => {
  const forms = [...html.matchAll(/<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/g)];
  const f = forms.find((m) => m[1] === action && Object.entries(fields).every(([k, v]) => m[2].includes(`name="${k}" value="${v}"`)));
  return f ? /name="csrf" value="([0-9a-f]+)"/.exec(f[2])?.[1] : undefined;
};

describe("only the owner reaches Settings, the audit log and Payments", () => {
  for (const path of ["/app/settings", "/app/settings/audit", "/app/payments", "/app/payments/1", "/app/payments?month=2026-09"]) {
    it(`GET ${path}`, async () => {
      expect((await h.get(path, OWNER)).status).toBe(200);
      for (const who of [PRAC, STAFF]) {
        const res = await h.get(path, who);
        expect(res.status).toBe(403);
        expect(decode(await res.text())).toContain("Your role can't open this page.");
      }
    });
  }
  it("the More sheet and the rail show Payments and Settings to the owner only", async () => {
    expect(await page("/app/settings")).toContain('href="/app/payments"');
    const staffToday = await (await h.get("/app", STAFF)).text();
    expect(staffToday).not.toContain('href="/app/payments"');
    expect(staffToday).not.toContain('href="/app/settings"');
  });
  it("every POST refuses a practitioner and staff, even with a valid token of their own, and changes nothing", async () => {
    const posts: [string, Record<string, string>, string][] = [
      ["/app/settings/business", { name: "Changed", accent: "plum", locale: "hi" }, "settings-business"],
      ["/app/settings/prices", { intro: "1", single: "1", pack10: "10", pack20: "20" }, "settings-prices"],
      ["/app/settings/switch", { name: "SENDS", v: "off" }, "settings-switch:SENDS:off"],
      ["/app/settings/emails", { digest: "1", safety: "1" }, "settings-emails"],
      ["/app/settings/privacy", { v: "off" }, "settings-privacy:off"],
      ["/app/payments/export", { month: "2026-10" }, "payments-export"],
      ["/app/payments/1/retry-refund", {}, "payments-retry:1"],
    ];
    const before = { settings: await h.count("SELECT COUNT(*) AS n FROM settings"), audit: await h.count("SELECT COUNT(*) AS n FROM audit_log") };
    for (const who of [PRAC, STAFF])
      for (const [path, form, scope] of posts) {
        const res = await h.post(path, { ...form, csrf: await h.tokenFor(who, scope) }, who);
        expect(res.status, `${who} ${path}`).toBe(403);
      }
    expect(await h.count("SELECT COUNT(*) AS n FROM settings")).toBe(before.settings);
    expect(await h.count("SELECT COUNT(*) AS n FROM audit_log")).toBe(before.audit);
  });
  it("the owner's POST needs the page's own token and the console's Origin", async () => {
    const html = await page();
    const csrf = csrfOn(html, "/app/settings/privacy")!;
    expect(csrf).toBeTruthy();
    expect((await h.post("/app/settings/privacy", { v: "off", csrf: "0".repeat(64) })).status).toBe(403);
    expect((await h.post("/app/settings/privacy", { v: "off", csrf }, OWNER, { origin: "https://evil.example" })).status).toBe(403);
    expect((await h.post("/app/settings/privacy", { v: "off", csrf }, OWNER, { origin: null })).status).toBe(403);
    expect(await h.setting(KEYS.staffReadChat)).toBeNull();
    expect((await h.post("/app/settings/privacy", { v: "off", csrf })).status).toBe(303);
    expect(await h.setting(KEYS.staffReadChat)).toBe("false");
  });
});

describe("the Settings page", () => {
  it("shows every section in words, with no internal codes and no keys", async () => {
    const html = await page();
    for (const s of ["Business", "Services and prices", "Team", "Bot", "Emails", "Payments", "Privacy", "System"]) expect(html).toContain(`<span>${s}</span>`);
    expect(html).toContain('href="/app/settings/team"');
    expect(html).toContain('href="/app/settings/audit"');
    expect(html).toContain("Test mode: no real money moves");
    expect(html).not.toMatch(/rzp_(test|live)_/);
    expect(html).not.toContain("test-razorpay-key-secret");
    const words = html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " "); // what a person reads
    expect(words).not.toMatch(/\b(NEW_BOOKINGS|AMMA_AWAY|SENDS|AI_REPLIES|HUMAN|AMMA|REFUND_FAILED|UNKNOWN)\b/);
    expect(html).toContain("Chat text is deleted 7 days after the customer's last message.");
    expect(html).toContain("Staff read chats so they can reply. Safety messages are always hidden from them.");
  });
  it("Razorpay: live key words, a mode mismatch warned in words, and not connected when a secret is missing", async () => {
    h.vars = { RAZORPAY_KEY_ID: "rzp_" + "live_" + "FAKEKEY00000002" };
    let html = await page();
    expect(html).toContain("Live mode: real payments");
    expect(html).toContain("The key's mode and the bot's payment mode don't match");
    h.vars = { RAZORPAY_WEBHOOK_SECRET: "" };
    html = await page();
    expect(html).toContain("Not connected");
  });
  it("Business: renames the workspace, sets the accent and the language for new members, audited; a bad name keeps the form filled", async () => {
    const html = await page();
    const csrf = csrfOn(html, "/app/settings/business")!;
    expect((await h.post("/app/settings/business", { csrf, name: "  Calm   Practice ", accent: "plum", locale: "hi" })).status).toBe(303);
    expect((await h.db.prepare("SELECT name FROM workspaces WHERE id = 1").first<{ name: string }>())!.name).toBe("Calm Practice");
    expect(await h.setting(KEYS.accent)).toBe("plum");
    expect(await h.setting(KEYS.locale)).toBe("hi");
    expect((await h.audits("BUSINESS_CHANGED")).length).toBe(3);
    const after = await page();
    expect(after).toContain("Calm Practice");
    expect(after).toContain(`--accent:${ACCENTS.plum.light}`);
    // Saving the same again changes nothing and writes no audit row.
    expect((await h.post("/app/settings/business", { csrf, name: "Calm Practice", accent: "plum", locale: "hi" })).headers.get("Location")).toContain("m=nothingChanged");
    expect((await h.audits("BUSINESS_CHANGED")).length).toBe(3);
    const bad = await h.post("/app/settings/business", { csrf, name: "x".repeat(61), accent: "plum", locale: "hi" });
    expect(bad.status).toBe(400);
    expect(decode(await bad.text())).toContain("Give the business a name, up to 60 characters.");
    expect((await h.post("/app/settings/business", { csrf, name: "Ok", accent: "neon", locale: "hi" })).status).toBe(400);
  });
  it("a new member invited after the default language is Hindi gets the Hindi console", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES (?1, 'hi')").bind(KEYS.locale).run();
    const team = await page("/app/settings/team");
    const csrf = /action="\/app\/settings\/team\/invite">\s*<input type="hidden" name="csrf" value="([0-9a-f]+)"/.exec(team)![1];
    await h.post("/app/settings/team/invite", { csrf, email: "new@example.test", role: "STAFF" });
    expect((await h.member("new@example.test"))!.locale).toBe("hi");
  });
  it("every accent passes contrast in light and dark (text on paper, surface and its tint; button text on it)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const a of Object.values(ACCENTS)) {
      for (const bg of [TOKENS.light.paper, TOKENS.light.surface, a.lightTint]) expect(ratio(a.light, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(TOKENS.light["on-accent"], a.light)).toBeGreaterThanOrEqual(4.5);
      for (const bg of [TOKENS.dark.paper, TOKENS.dark.surface, a.darkTint]) expect(ratio(a.dark, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(TOKENS.dark["on-accent"], a.dark)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(TOKENS.light.ink, a.lightTint)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(TOKENS.dark.ink, a.darkTint)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("renders in Hindi for an owner who chose Hindi", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(OWNER).run();
    const html = await page();
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("सेवाएँ और दाम");
    expect(html).toContain("स्टाफ़ चैट का टेक्स्ट पढ़ सकता है");
  });
});

describe("prices: saved in Settings, quoted by the bot, config as the fallback", () => {
  it("only whole rupees from ₹1 to ₹1,00,000, and a package must split into whole-rupee sessions", () => {
    expect(validPrice("intro", 14900)).toBe(true);
    expect(validPrice("intro", 14950)).toBe(false);
    expect(validPrice("intro", 0)).toBe(false);
    expect(validPrice("intro", 10_000_100)).toBe(false);
    expect(validPrice("pack10", 550000)).toBe(true);
    expect(validPrice("pack10", 550500)).toBe(false); // ₹550.50 a session
    expect(validPrice("pack20", 900000)).toBe(true);
  });
  it("saving writes one settings row and one audit row per changed price; bad input keeps the form filled and saves nothing", async () => {
    const csrf = csrfOn(await page(), "/app/settings/prices")!;
    const bad = await h.post("/app/settings/prices", { csrf, intro: "149", single: "79.5", pack10: "5,000", pack20: "abc" });
    expect(bad.status).toBe(400);
    const html = decode(await bad.text());
    expect(html).toContain("That didn't save");
    expect(html).toContain('value="79.5"');
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'price.%'")).toBe(0);
    const ok = await h.post("/app/settings/prices", { csrf, intro: "149", single: "799", pack10: "₹5,500", pack20: "9000" });
    expect(ok.status).toBe(303);
    expect(await h.setting(KEYS.intro)).toBe("14900");
    expect(await h.setting(KEYS.pack10)).toBe("550000");
    expect(await h.setting(KEYS.single)).toBeNull(); // unchanged: no row
    expect((await h.audits("PRICE_CHANGED")).map((a) => [a.target, a.detail])).toEqual([
      [KEYS.intro, "9900 -> 14900"],
      [KEYS.pack10, "500000 -> 550000"],
    ]);
    const after = await page();
    expect(after).toContain('name="intro" inputmode="numeric" pattern="[0-9,]*" required value="149"');
    expect(after).toContain("₹550 a session");
  });
  it("readPrices falls back to config for a missing or bad row, one price at a time", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES (?1, '14900'), (?2, 'lots'), (?3, '555555')").bind(KEYS.intro, KEYS.single, KEYS.pack10).run();
    const p = await readPrices(h.db);
    expect(p.intro).toBe(14900);
    expect(p.single).toBe(DEFAULT_PRICES.single);
    expect(p.pack10).toEqual(DEFAULT_PRICES.pack10);
    expect(p.pack20).toEqual(DEFAULT_PRICES.pack20);
  });
  it("priceAt: the price when a link was made, from the first change after it", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES (?1, '19900')").bind(KEYS.intro).run();
    await h.db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES ('2026-10-20T00:00:00Z', 'o', 'PRICE_CHANGED', ?1, '9900 -> 14900'), ('2026-10-25T00:00:00Z', 'o', 'PRICE_CHANGED', ?1, '14900 -> 19900')").bind(KEYS.intro).run();
    expect(await priceAt(h.db, "intro", "2026-10-01T00:00:00Z")).toBe(9900);
    expect(await priceAt(h.db, "intro", "2026-10-22T00:00:00Z")).toBe(14900);
    expect(await priceAt(h.db, "intro", "2026-10-26T00:00:00Z")).toBe(19900);
    expect(await priceAt(h.db, "single", "2026-10-26T00:00:00Z")).toBe(DEFAULT_PRICES.single);
  });
  it("copyFor quotes the prices in force; allCopy stays at config's prices", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES (?1, '14900'), (?2, '600000')").bind(KEYS.intro, KEYS.pack10).run();
    await loadPrices(h.env());
    expect(prices().intro).toBe(14900);
    expect(copyFor("en").btnBook).toBe("Book ₹149 call");
    expect(copyFor("hi").btnBook).toBe("₹149 कॉल बुक करें");
    expect(copyFor("en").rowPack10Desc).toContain("₹6,000 · ₹600 each");
    expect(allCopy.en.btnBook).toBe("Book ₹99 call");
    await h.db.prepare("DELETE FROM settings WHERE key LIKE 'price.%'").run();
    await loadPrices(h.env());
    expect(copyFor("en").btnBook).toBe("Book ₹99 call");
  });
});

describe("the bot quotes the owner's prices (WhatsApp, end to end)", () => {
  const w = new Wa();
  beforeEach(async () => {
    await h.stop();
    await w.start();
  });
  afterEach(async () => {
    await w.stop();
    await h.start(NOW); // the outer afterEach stops it again
  });
  const buttons = () => w.last().interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title);

  it("the menu, the price answer and the payment link use the settings; a later price change doesn't make the paid link a mismatch", async () => {
    await w.db.prepare("INSERT INTO settings (key, value) VALUES (?1, '14900'), (?2, '850000')").bind(KEYS.intro, KEYS.pack10).run();
    const from = w.newPhone();
    await w.typed(from, "hi");
    await w.tap(from, "lang_en");
    expect(buttons()).toContain("Book ₹149 call");
    await w.tap(from, "menu_how");
    await w.tapRow(from, "faq_price");
    const answer = w.last().interactive?.body?.text ?? w.last().text?.body;
    expect(answer).toContain("The first call is ₹149.");
    expect(answer).toContain("10 sessions for ₹8,500 (₹850 each)");
    expect(answer).not.toContain("₹99");
    // Book a call: the link and the payment row ask for ₹149.
    await w.tap(from, "menu_book");
    await w.tap(from, "age_yes");
    await w.tap(from, "svc_HEALING");
    await w.tap(from, "who_HEALING_SELF");
    await w.tap(from, "day_HEALING_SELF_2026-10-06");
    await w.tapRow(from, `time_HEALING_SELF_${slotAt("2026-10-06", "CALL", 4)[0]}`);
    const pay = (await w.db.prepare("SELECT provider_link_id AS link, amount_paise AS paise FROM payments").first<{ link: string; paise: number }>())!;
    expect(pay.paise).toBe(14900);
    expect(w.fake.links.get(pay.link)!.amount).toBe(14900);
    expect(w.texts().some((t: string) => t?.includes('Tap "Pay ₹149" below'))).toBe(true); // the body names the button, at the price in force
    // The owner puts the price back to ₹99 before the customer pays: the ₹149 link is still the right amount.
    await w.db.prepare("UPDATE settings SET value = '9900' WHERE key = ?1").bind(KEYS.intro).run();
    await w.db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES ('owner', 'PRICE_CHANGED', ?1, '14900 -> 9900')").bind(KEYS.intro).run();
    const raw = JSON.stringify(paidEvent(pay.link, { amount: 14900 }));
    expect((await app.request("/pay/razorpay/webhook", { method: "POST", body: raw, headers: await rzpHeaders(raw) }, w.env())).status).toBe(200);
    expect((await w.db.prepare("SELECT state FROM payments").first<{ state: string }>())!.state).toBe("PAID");
    expect(await w.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'PAYMENT_MISMATCH'")).toBe(0);
  });
  it("with no settings, or a bad one, the bot quotes config's prices", async () => {
    await w.db.prepare("INSERT INTO settings (key, value) VALUES (?1, 'free')").bind(KEYS.intro).run();
    const from = w.newPhone();
    await w.typed(from, "hi");
    await w.tap(from, "lang_en");
    expect(buttons()).toContain("Book ₹99 call");
  });
});

describe("the bot switches: the env flag is the master", () => {
  const sw = async (name: string, v: "on" | "off") => h.post("/app/settings/switch", { name, v, csrf: await h.tokenFor(OWNER, `settings-switch:${name}:${v}`) });
  it("pause and resume write the setting and an audit row; the card says what happens", async () => {
    let html = await page();
    expect(html).toContain("Messages to customers");
    expect(csrfOn(html, "/app/settings/switch", { name: "SENDS", v: "off" })).toBeTruthy();
    expect((await sw("SENDS", "off")).headers.get("Location")).toContain("m=switched");
    expect(await h.setting("SENDS")).toBe("false");
    html = await page();
    expect(csrfOn(html, "/app/settings/switch", { name: "SENDS", v: "on" })).toBeTruthy();
    await sw("SENDS", "on");
    expect(await h.setting("SENDS")).toBe("true");
    expect((await h.audits("SWITCH_CHANGED")).map((a) => `${a.target}:${a.detail}`)).toEqual(["SENDS:off", "SENDS:on"]);
  });
  it("a switch whose env flag is off can't be turned on, and the page offers no button for it", async () => {
    h.vars = { AI_REPLIES: "false" };
    const html = await page();
    const card = /<article class="card" id="sw-ai_replies">([\s\S]*?)<\/article>/.exec(html)![1];
    expect(card).toContain("Off for this copy of the bot. Only a deploy can turn it on");
    expect(card).not.toContain("<form");
    const res = await sw("AI_REPLIES", "on");
    expect(res.headers.get("Location")).toContain("m=envIsMaster");
    expect(await h.setting("AI_REPLIES")).toBeNull();
    expect(await h.audits("SWITCH_CHANGED")).toEqual([]);
  });
  it("practitioner away pauses bookings and says so on the bookings card", async () => {
    await sw("AMMA_AWAY", "on");
    expect(await h.setting("AMMA_AWAY")).toBe("true");
    const html = await page();
    expect(html).toContain("Paused because the practitioner is away.");
    await sw("AMMA_AWAY", "off");
    expect(await h.setting("AMMA_AWAY")).toBe("false");
  });
  it("a hand-made switch name is refused", async () => {
    expect((await h.post("/app/settings/switch", { name: "OWNER_APPROVED", v: "on", csrf: await h.tokenFor(OWNER, "settings-switch:OWNER_APPROVED:on") })).status).toBe(400);
  });
});

describe("who gets the daily summary and the crisis email", () => {
  it("by default the owner, at the alert address, exactly as before", async () => {
    expect(await recipients(h.env(), "digest")).toEqual([ALERTS]);
    expect(await recipients(h.env(), "safety")).toEqual([ALERTS]);
    await runDigest(h.env(), NOW);
    const mail = h.emails.find((m) => m.subject.startsWith("Daily summary"))!;
    expect(mail.to).toBe(ALERTS);
    expect(mail.subject).toBe("Daily summary: My business");
  });
  it("the owner chooses members; removed members never get one; staff as the safety contact gets the crisis email", async () => {
    const staff = (await h.member(STAFF))!;
    const owner = (await h.member(OWNER))!;
    const prac = (await h.member(PRAC))!;
    const csrf = csrfOn(await page(), "/app/settings/emails")!;
    expect((await h.post("/app/settings/emails", { csrf, digest: [String(owner.id), String(prac.id)], safety: String(staff.id) })).status).toBe(303);
    expect(await recipients(h.env(), "digest")).toEqual([ALERTS, PRAC]);
    expect(await recipients(h.env(), "safety")).toEqual([STAFF]);
    expect((await h.audits("EMAILS_CHANGED")).length).toBe(2);
    await runDigest(h.env(), NOW);
    expect(h.emails.filter((m) => m.subject.startsWith("Daily summary")).map((m) => m.to)).toEqual([ALERTS, PRAC]);
    // The crisis email: through the bot, to the safety contact.
    const db = h.db;
    const { runCrisis } = await import("../src/safety");
    const conv = (await db.prepare("INSERT INTO conversations (wa_id, locale) VALUES ('919800000001', 'en')").run()).meta.last_row_id;
    await runCrisis(h.env(), { id: conv, locale: "en", consent_at: null }, "wamid.X", "synthetic");
    expect(h.emails.filter((m) => m.subject === "Urgent: crisis message").map((m) => m.to)).toEqual([STAFF]);
    // Once the staff member is removed, it goes to the owner again.
    await db.prepare("UPDATE members SET status = 'removed' WHERE id = ?1").bind(staff.id).run();
    expect(await recipients(h.env(), "safety")).toEqual([ALERTS]);
  });
  it("the summary needs at least one person; a member id from elsewhere is refused", async () => {
    const csrf = csrfOn(await page(), "/app/settings/emails")!;
    const none = await h.post("/app/settings/emails", { csrf, safety: String((await h.member(OWNER))!.id) });
    expect(none.status).toBe(400);
    expect(decode(await none.text())).toContain("Choose at least one person for the daily summary.");
    expect((await h.post("/app/settings/emails", { csrf, digest: "1", safety: "999" })).status).toBe(400);
    expect(await h.setting(KEYS.digest)).toBeNull();
  });
});

describe("privacy: staff read chat text unless the owner turns it off", () => {
  it("on by default; off and on again, audited", async () => {
    expect(await staffReadsChat(h.db)).toBe(true);
    await h.post("/app/settings/privacy", { v: "off", csrf: await h.tokenFor(OWNER, "settings-privacy:off") });
    expect(await staffReadsChat(h.db)).toBe(false);
    expect(await page()).toContain("Staff see who wrote and when, not the text.");
    await h.post("/app/settings/privacy", { v: "on", csrf: await h.tokenFor(OWNER, "settings-privacy:on") });
    expect(await staffReadsChat(h.db)).toBe(true);
    expect((await h.audits("STAFF_CHAT_TEXT")).map((a) => a.detail)).toEqual(["off", "on"]);
  });
});

describe("the system card: today's health checks, in words", () => {
  it("a stale 2-minute check, a failed alert email and payments to check", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('HEARTBEAT', ?1), ('MAIL_LAST', ?2)").bind(new Date(NOW - 40 * 60_000).toISOString(), `FAILED|${new Date(NOW - 3_600_000).toISOString()}`).run();
    const html = await page();
    const card = /<div class="card" id="system">([\s\S]*?)<\/div>/.exec(html)![1];
    expect(card).toContain("Hasn't run for 15 minutes");
    expect(card).toContain("Didn't send: crisis and alert emails may not be reaching you.");
    expect(card).not.toMatch(/cron|HEARTBEAT|wrangler/i);
  });
});

describe("the audit log: filter by person and action; rows from before roles say so", () => {
  beforeEach(async () => {
    const owner = (await h.member(OWNER))!;
    const staff = (await h.member(STAFF))!;
    await h.db
      .prepare(
        `INSERT INTO audit_log (at, actor, action, target, detail, workspace_id, member_id) VALUES
         ('2026-10-01T05:00:00Z', 'someone@example.test', 'ADMIN_REFUND', 'payment:1', 'old', NULL, NULL),
         ('2026-10-02T05:00:00Z', 'bot', 'CRISIS', 'conv:1', '', NULL, NULL),
         ('2026-10-03T05:00:00Z', ?1, 'PRICE_CHANGED', 'price.intro_paise', '9900 -> 14900', 1, ?2),
         ('2026-10-04T05:00:00Z', ?3, 'MEMBER_LOCALE', 'member:3', 'en -> hi', 1, ?4)`,
      )
      .bind(OWNER, owner.id, STAFF, staff.id)
      .run();
  });
  it("shows every row newest first, in words, with 'Before roles' for old rows", async () => {
    const html = await page("/app/settings/audit");
    expect(html).toContain("Changed a price");
    expect(html).toContain("Before roles · someone@example.test");
    expect(html).toContain("The bot");
    expect(html.indexOf("Changed their language")).toBeLessThan(html.indexOf("Changed a price"));
    expect(logRows(html)).not.toMatch(/ADMIN_REFUND|PRICE_CHANGED/);
  });
  it("by person, by before roles, by the bot, and by action", async () => {
    const staff = (await h.member(STAFF))!;
    let rows = logRows(await page(`/app/settings/audit?who=${staff.id}`));
    expect(rows).toContain("Changed their language");
    expect(rows).not.toContain("Changed a price");
    rows = logRows(await page("/app/settings/audit?who=before"));
    expect(rows).toContain("someone@example.test");
    expect(rows).not.toContain("Changed a price");
    rows = logRows(await page("/app/settings/audit?who=bot"));
    expect(rows).toContain("Sent the crisis message");
    expect(rows).not.toContain("Refunded");
    rows = logRows(await page("/app/settings/audit?what=PRICE_CHANGED"));
    expect(rows).toContain("9900 -> 14900");
    expect(rows).not.toContain("Changed their language");
    expect(await page("/app/settings/audit?what=NOPE")).toContain("Nothing matches.");
  });
  it("pages 50 at a time with an Older link", async () => {
    const stmts = Array.from({ length: 60 }, (_, i) => h.db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES ('bot', 'QUIET', ?1, '')").bind(`conv:${i}`));
    await h.db.batch(stmts);
    const html = await page("/app/settings/audit?who=bot");
    expect((html.match(/<div class="row">/g) ?? []).length).toBe(50);
    const older = /href="(\/app\/settings\/audit\?[^"]+)">Older entries/.exec(html)![1].replaceAll("&amp;", "&");
    const next = await page(older);
    expect((next.match(/<div class="row">/g) ?? []).length).toBe(11);
  });
});
