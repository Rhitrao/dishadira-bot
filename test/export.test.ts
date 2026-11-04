import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env"; // first: it loads the Worker
import app from "../src/index";
import { buildExport, chatCode, exportDays, redact } from "../src/export";
import { wipeChats } from "../src/wipe";

// Ticket 37: the owner's chat export. All data is synthetic (numbers 91910000000x, names made up); Access is mocked, nothing real is called.
const NOW = Date.parse("2026-11-04T06:00:00Z"); // Wednesday 11:30 am in Bengaluru
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());

const adminOnly = () => (h.vars = { CONSOLE_V2: "false" }); // live today: the old /admin console
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString().slice(0, 19) + "Z";

type ConvOpts = { wa: string; name?: string; created?: string; last?: string | null; ad?: string; headline?: string; locale?: string; consent?: boolean; mode?: string; ageOk?: boolean };
async function conv(o: ConvOpts) {
  const r = await h.db
    .prepare(
      "INSERT INTO conversations (wa_id, display_name, created_at, last_user_at, source_ad_id, ad_headline, locale, consent_at, greeted_at, age_ok_at, mode) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)",
    )
    .bind(o.wa, o.name ?? null, o.created ?? ago(20), o.last === undefined ? ago(19) : o.last, o.ad ?? null, o.headline ?? null, o.locale ?? "en", o.consent === false ? null : ago(20), o.ageOk ? ago(19) : null, o.mode ?? "BOT")
    .run();
  await h.db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(r.meta.last_row_id).run();
  return r.meta.last_row_id;
}
let n = 0;
async function msg(c: number, dir: "IN" | "OUT", kind: string, body: string | null, o: { at?: string; key?: string; status?: string; wamid?: string } = {}) {
  await h.db
    .prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(c, dir, o.wamid ?? (dir === "IN" ? `wamid.in${++n}` : null), o.key ?? (dir === "OUT" ? `k${++n}:text` : null), kind, body, o.status ?? (dir === "IN" ? "RECEIVED" : "SENT"), o.at ?? ago(19))
    .run();
}
async function paidIntro(c: number) {
  const intro = await h.db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'PAID')").bind(c).run();
  await h.db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', 'INTRO', ?1, ?2, 9900, 'PAID', ?3)")
    .bind(intro.meta.last_row_id, `link_test_${c}`, ago(18))
    .run();
}

// A small week of chats: an ad chat that paid, a "(BLR)" tag chat, one opened from Instagram, a safety chat, a blocked number, an old
// chat outside 7 days, and one whose text the wipe already removed.
const WA = { ad: "919100000001", tag: "919100000002", ig: "919100000003", safety: "919100000004", blocked: "919100000005", old: "919100000006", wiped: "919100000007" };
const NAMES = ["Asha Kumari", "Bhavna Testwoman", "Chetan Sample", "Devika Fakename", "Eshan Rudeperson", "Farah Oldtimer", "Gauri Wipedname"];
async function seed() {
  const ad = await conv({ wa: WA.ad, name: NAMES[0], ad: "120000000000001", headline: "Feel lighter (BLR)", ageOk: true });
  await msg(ad, "IN", "text", "Hi, I want to know more (BLR)", { at: ago(20) });
  await msg(ad, "OUT", "buttons", "Namaste! Please choose your language", { key: `greet:${ad}`, at: ago(20) });
  await msg(ad, "IN", "interactive", "English");
  for (const s of ["service", "who", "days", "times"]) await msg(ad, "OUT", s === "days" || s === "times" ? "list" : "buttons", `step ${s}`, { key: `wamid.x:${s}` });
  await msg(ad, "OUT", "cta", "Pay ₹99 here: https://bot.disha-dira.com/p/AbCdEf123456", { key: "wamid.y:pay" });
  await msg(ad, "IN", "text", "I am Asha, call +91 98100 00000 or mail asha.k@example.com, upi asha99@okhdfcbank, see https://evil.example.org/x and disha-dira.com/privacy.html, pay_ABCDEF123456, code 1234567");
  await msg(ad, "OUT", "text", "Thank you Asha, we will call you.", { key: `admin-reply:conv:${ad}:abc` });
  await msg(ad, "OUT", "template", "template:call_booked", { key: "tpl1" });
  await paidIntro(ad);

  const tag = await conv({ wa: WA.tag, name: NAMES[1], locale: "hi" });
  await msg(tag, "IN", "text", "Hello (BLR)");
  await msg(tag, "IN", "image", null);
  await h.db.prepare("INSERT INTO followups (channel, person, anchor, stage, state, created_at) VALUES ('whatsapp', ?1, ?2, 1, 'SENT', ?3)").bind(String(tag), ago(19), ago(18)).run();
  await h.db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES ('test', 'ADMIN_TAKE_OVER', ?1, 'BOT -> HUMAN')").bind(`conv:${tag}`).run();

  const ig = await conv({ wa: WA.ig, name: NAMES[2], consent: false });
  await msg(ig, "IN", "text", "Hi from Instagram");
  await h.db.prepare("INSERT INTO social_contacts (platform, user_id, ref_code, wa_conversation_id, created_at, last_in_at) VALUES ('instagram', 'igsid-test-1', 'IGAB123', ?1, ?2, ?2)").bind(ig, ago(21)).run();
  await h.db.prepare("INSERT INTO social_contacts (platform, user_id, created_at, last_in_at) VALUES ('messenger', 'psid-test-1', ?1, ?1)").bind(ago(30)).run();

  const safety = await conv({ wa: WA.safety, name: NAMES[3] });
  await msg(safety, "IN", "text", "a synthetic crisis sentence SAFETYWORDS", { wamid: "wamid.crisis1" });
  await msg(safety, "OUT", "text", "fixed helpline message HELPLINETEXT", { key: "wamid.crisis1:crisis" });
  await h.db.prepare("INSERT INTO attention (kind, target, resolved_at) VALUES ('CRISIS', ?1, ?2)").bind(`conv:${safety}`, ago(10)).run();
  await paidIntro(safety);

  const blocked = await conv({ wa: WA.blocked, name: NAMES[4], mode: "BLOCKED" });
  await msg(blocked, "IN", "text", "BLOCKEDTEXT rude words");
  await h.db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'ADMIN', 'test')").bind(WA.blocked).run();

  const old = await conv({ wa: WA.old, name: NAMES[5], created: ago(24 * 20), last: ago(24 * 20) });
  await msg(old, "IN", "text", "an old question", { at: ago(24 * 20) });

  const wiped = await conv({ wa: WA.wiped, name: NAMES[6], created: ago(24 * 9), last: ago(24 * 8) });
  await msg(wiped, "IN", "text", "WIPEDTEXT that is past retention", { at: ago(24 * 8) });
  await wipeChats(h.env(), NOW);
  return { ad, tag, ig, safety, blocked, old, wiped };
}

type File = {
  days: number; timezone: string; truncated: boolean; notes: string[]; summary: Record<string, unknown>; social: Record<string, Record<string, unknown>>;
  chats: { code: string; last4: string; source: { kind: string; ad_id: string | null; ad_headline: string | null; tag: string | null }; language: string; safety: boolean; blocked: boolean; furthest_step: string; note?: string; text_wiped_count: number; message_count: number; outcome: { paid_intro: boolean; intro_status: string | null }; followups: { stage: number }[]; messages: { at: string; from: string; kind: string; text: string }[] }[];
};
const download = async (path = "/admin/export", as = OWNER) => {
  const res = await h.get(path, as);
  const text = await res.text();
  return { res, text, file: res.status === 200 ? (JSON.parse(text) as File) : null };
};

describe("the redactor", () => {
  it("replaces phone numbers, emails, UPI ids, payment ids, long digit runs, other links and the person's name", () => {
    expect(redact("call +91 98100 00000 now")).toBe("call [phone] now");
    expect(redact("call 9810000000")).toBe("call [phone]");
    expect(redact("+91-981-000-0000 or 98100-00000")).toBe("[phone] or [phone]");
    expect(redact("०९८१००००००००")).toBe("[phone]"); // Devanagari digits
    expect(redact("mail me at a.b+c@example.co.in")).toBe("mail me at [email]");
    expect(redact("upi rohit.k@okaxis or 9810000000@ybl")).toBe("upi [upi] or [upi]");
    expect(redact("see https://evil.example.org/path?x=1 and www.other.net")).toBe("see [link] and [link]");
    expect(redact("bit.ly/abc")).toBe("[link]");
    expect(redact("pay_ABCDEF123456 and plink_Zx9y8w7v6u")).toBe("[id] and [id]");
    expect(redact("code 1234567 and 123456")).toBe("code [number] and [number]");
    expect(redact("I am Asha, asha here", ["Asha", "Kumari"])).toBe("I am [name], [name] here");
    expect(redact("आशा जी", ["आशा"])).toBe("[name] जी");
  });
  it("keeps our own links (with the payment token hidden) and ordinary numbers", () => {
    expect(redact("https://disha-dira.com/privacy.html")).toBe("https://disha-dira.com/privacy.html");
    expect(redact("pay at https://bot.disha-dira.com/p/AbCdEf123456 please")).toBe("pay at https://bot.disha-dira.com/p/[token] please");
    expect(redact("https://wa.me/919800000000?text=Hi")).toBe("https://wa.me/[phone]?text=Hi");
    expect(redact("₹99 for 15 min, 2:30 pm, 10 sessions for ₹5,000")).toBe("₹99 for 15 min, 2:30 pm, 10 sessions for ₹5,000");
    expect(redact("Hello (BLR)")).toBe("Hello (BLR)");
    expect(redact("Ashaji", ["Asha"])).toBe("Ashaji"); // whole words only
  });
  it("days: 1 to 30, default 7", () => {
    expect(exportDays(undefined)).toBe(7);
    expect(exportDays("1")).toBe(1);
    expect(exportDays("30")).toBe(30);
    for (const bad of ["0", "31", "-1", "abc", "2.5", "007"]) expect(exportDays(bad)).toBeNull();
    expect(chatCode(7)).toBe("C-0007");
  });
});

describe("/admin/export", () => {
  it("is the owner's only: no Access, the practitioner and staff get 403; the owner a download", async () => {
    adminOnly();
    expect((await app.request("https://bot.example.test/admin/export", {}, h.env())).status).toBe(403);
    expect((await h.get("/admin/export", PRAC)).status).toBe(403);
    expect((await h.get("/admin/export", STAFF)).status).toBe(403);
    const { res } = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="disha-dira-chats-2026-11-04.json"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await h.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'EXPORT_CHATS'")).toBe(1); // the refused ones wrote nothing
  });

  it("days must be 1 to 30 (400 otherwise), default 7; the audit row has the counts, never the content", async () => {
    adminOnly();
    await seed();
    for (const bad of ["0", "31", "abc"]) expect((await h.get(`/admin/export?days=${bad}`)).status).toBe(400);
    const week = (await download()).file!;
    expect(week.days).toBe(7);
    expect(week.timezone).toBe("Asia/Kolkata");
    expect(week.chats.map((c) => c.last4).sort()).toEqual(["0001", "0002", "0003", "0004", "0005"]); // the old and the wiped chats are outside 7 days
    const month = (await download("/admin/export?days=30")).file!;
    expect(month.chats).toHaveLength(7);
    const rows = await h.audits("EXPORT_CHATS");
    expect(rows.map((r) => [r.actor, r.target])).toEqual([[OWNER, "export:7d"], [OWNER, "export:30d"]]);
    expect(rows[0].detail).toBe(`days 7, chats 5, messages ${week.summary.messages_in_file}`);
    expect(JSON.stringify(rows)).not.toMatch(/BLR|Asha|9191/);
  }, 60_000); // seeds seven chats: give the slower CI runner room

  it("chats carry a code and the last 4 digits only: no full number, no name, anywhere", async () => {
    adminOnly();
    const ids = await seed();
    const { text, file } = await download("/admin/export?days=30");
    for (const wa of Object.values(WA)) {
      expect(text).not.toContain(wa);
      expect(text).not.toContain(wa.slice(2)); // without the country code either
    }
    for (const name of NAMES) for (const word of name.split(" ")) expect(text).not.toContain(word);
    expect(text).not.toMatch(/display_name|wa_id/);
    const ad = file!.chats.find((c) => c.last4 === "0001")!;
    expect(ad.code).toBe(chatCode(ids.ad));
    // The only long digit run left is the ad id (the business's own ad data, so the owner can find the ad).
    expect([...text.matchAll(/\d{8,}/g)].map((m) => m[0]).every((d) => d === "120000000000001")).toBe(true);
  }, 60_000); // seeds seven chats: give the slower CI runner room

  it("redacts every text field, keeps the order, and says who wrote each message in India time", async () => {
    adminOnly();
    await seed();
    const { text, file } = await download();
    const ad = file!.chats.find((c) => c.last4 === "0001")!;
    expect(ad.messages.map((m) => [m.from, m.kind])).toEqual([
      ["customer", "text"], ["bot", "button"], ["customer", "button"], ["bot", "button"], ["bot", "button"], ["bot", "list"], ["bot", "list"], ["bot", "button"],
      ["customer", "text"], ["team", "text"], ["bot", "template"],
    ]);
    expect(ad.messages[0]).toEqual({ at: "2026-11-03T15:30:00+05:30", from: "customer", kind: "text", text: "Hi, I want to know more (BLR)" });
    expect(ad.messages[2].text).toBe("tapped: English");
    expect(ad.messages[7].text).toBe("Pay ₹99 here: https://bot.disha-dira.com/p/[token]");
    expect(ad.messages[8].text).toBe("I am [name], call [phone] or mail [email], upi [upi], see [link] and disha-dira.com/privacy.html, [id], code [number]");
    expect(ad.messages[9].text).toBe("Thank you [name], we will call you.");
    expect(ad.messages[10].text).toBe("template: call_booked");
    for (const leak of ["98100", "asha.k@", "okhdfcbank", "evil.example", "pay_ABC", "1234567", "AbCdEf123456"]) expect(text).not.toContain(leak);
    const tag = file!.chats.find((c) => c.last4 === "0002")!;
    expect(tag.messages.map((m) => m.text)).toEqual(["Hello (BLR)", "[photo]"]);
  }, 60_000); // seeds seven chats: give the slower CI runner room

  it("a safety chat keeps its counts and outcome but no text; a blocked number has counts only; wiped text stays gone", async () => {
    adminOnly();
    await seed();
    const { text, file } = await download("/admin/export?days=30");
    for (const t of ["SAFETYWORDS", "HELPLINETEXT", "BLOCKEDTEXT", "WIPEDTEXT"]) expect(text).not.toContain(t);
    const safety = file!.chats.find((c) => c.last4 === "0004")!;
    expect(safety).toMatchObject({ safety: true, note: "text withheld (safety)", messages: [], message_count: 2, outcome: { paid_intro: true, intro_status: "PAID" } });
    const blocked = file!.chats.find((c) => c.last4 === "0005")!;
    expect(blocked).toMatchObject({ blocked: true, note: "text withheld (blocked)", messages: [], message_count: 1 });
    const wiped = file!.chats.find((c) => c.last4 === "0007")!;
    expect(wiped).toMatchObject({ messages: [], message_count: 1, text_wiped_count: 1 });
    expect(wiped.note).toBeUndefined();
    expect(file!.summary).toMatchObject({ safety_flagged: 1, blocked: 1, messages_text_wiped: 2 }); // the wiped chat and the 20-day-old one
  }, 60_000); // seeds seven chats: give the slower CI runner room

  it("finds the source: the ad, a (BLR) tag, an Instagram link, or none; and counts the summary", async () => {
    adminOnly();
    await seed();
    const file = (await download()).file!;
    const by = (l4: string) => file.chats.find((c) => c.last4 === l4)!;
    expect(by("0001").source).toEqual({ kind: "ad", ad_id: "120000000000001", ad_headline: "Feel lighter (BLR)", tag: "BLR" });
    expect(by("0002").source).toEqual({ kind: "tag", ad_id: null, ad_headline: null, tag: "BLR" });
    expect(by("0003").source.kind).toBe("instagram");
    expect(by("0004").source.kind).toBe("organic_or_unknown");
    expect(by("0001").furthest_step).toBe("call_paid");
    expect(by("0002").furthest_step).toBe("language_chosen");
    expect(by("0003").furthest_step).toBe("first_message");
    expect(by("0002").language).toBe("hi");
    expect(by("0003").language).toBe("not_chosen");
    expect(by("0002").followups).toEqual([{ stage: 1, at: "2026-11-03T17:30:00+05:30", state: "SENT" }]);
    expect(file.summary).toMatchObject({
      chats_in_file: 5,
      chats_started: 5,
      by_source: { ad: 1, tag: 1, instagram: 1, organic_or_unknown: 2 },
      by_ad: [{ ad_id: "120000000000001", ad_headline: "Feel lighter (BLR)", chats: 1, paid_intro: 1 }],
      by_tag: { BLR: { chats: 2, paid_intro: 1 } },
      by_language: { en: 3, hi: 1, not_chosen: 1 },
      paid_intro_calls: 2,
      paid_rupees: 198,
      handed_to_team: 1, // the tag chat, taken over by the team
      followups_sent: { stage_1: 1 },
    });
    const reached = file.summary.reached_step as Record<string, number>;
    // "At least that far": the safety chat paid, so it counts at every step before too.
    expect(reached).toMatchObject({ first_message: 5, greeted: 4, language_chosen: 4, age_confirmed: 2, time_list: 2, call_held: 2, call_paid: 2 });
    expect(file.social).toMatchObject({ instagram: { people: 1, opened_whatsapp: 1 }, messenger: { people: 1, opened_whatsapp: 0 } });
    expect(file.truncated).toBe(false);
    expect(file.notes.join(" ")).toContain("deleted automatically");
  }, 60_000); // seeds seven chats: give the slower CI runner room
});

describe("/app/people/export (the console, when CONSOLE_V2 is on)", () => {
  it("only the owner sees the link and gets the file; staff and the practitioner are refused", async () => {
    await seed();
    expect(await (await h.get("/app/people")).text()).toContain("/app/people/export?days=7");
    expect(await (await h.get("/app/people", STAFF)).text()).not.toContain("/app/people/export");
    expect((await h.get("/app/people/export", STAFF)).status).toBe(403);
    expect((await h.get("/app/people/export", PRAC)).status).toBe(403);
    expect((await h.get("/app/people/export?days=99")).status).toBe(400);
    const { res, file } = await download("/app/people/export?days=7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="disha-dira-chats-2026-11-04.json"');
    expect(file!.chats).toHaveLength(5);
    const rows = await h.audits("EXPORT_CHATS");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: OWNER, target: "export:7d" });
    expect(rows[0].memberId).toBe((await h.member(OWNER))!.id);
  }, 60_000); // seeds seven chats: give the slower CI runner room
});

describe("the hard cap", () => {
  it("stops at the chat and message limits and says truncated", async () => {
    await seed();
    const few = await buildExport(h.env(), 7, NOW, { maxChats: 3, maxMessages: 20000 });
    expect(few.file).toMatchObject({ truncated: true, limits: { chats: 3 } });
    expect(few.file.chats).toHaveLength(3); // the most recent first
    // The chats come newest first; once the next chat's messages would pass the limit, its text is left out (its counts stay).
    const out = await buildExport(h.env(), 7, NOW, { maxChats: 2000, maxMessages: 3 });
    expect(out.truncated).toBe(true);
    expect(out.messages).toBe(3);
    expect(out.file.chats).toHaveLength(5);
    expect(out.file.chats.find((c) => c.last4 === "0001")).toMatchObject({ note: "text left out (file limit reached)", messages: [], outcome: { paid_intro: true } });
    expect((await buildExport(h.env(), 7, NOW)).truncated).toBe(false);
  }, 60_000);
});
