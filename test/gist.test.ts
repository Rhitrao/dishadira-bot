import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gistFacts, gistInput, makeGist, makeGists } from "../src/gist";
import { wipeChats } from "../src/wipe";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";

// Ticket 47: the gist above the chat. All data is synthetic; Access, WhatsApp and the AI provider are fakes (nothing real is called).
// Wed 4 Nov 2026, 2:00 pm in Bengaluru.
const NOW = Date.parse("2026-11-04T08:30:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const h = new ConsoleHarness();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Call = { body: Record<string, unknown> };
let calls: Call[];
let aiStatus: number;
const FIELDS = {
  en: { asking: "Asking about help with sleep", concerns: "Prefers evening calls in Hindi", promised: "nothing mentioned", next: "Offer an evening time for the ₹99 call" },
  hi: { asking: "नींद में मदद के बारे में पूछ रहे हैं", concerns: "शाम को हिन्दी में कॉल चाहते हैं", promised: "कुछ नहीं बताया गया", next: "₹99 कॉल के लिए शाम का समय दें" },
};

let n = 0;
async function person(o: { waId?: string; name?: string | null; given?: boolean; locale?: string; consent?: boolean; lastUserAt?: number; mode?: string; created?: number } = {}) {
  return (
    await h.db
      .prepare("INSERT INTO conversations (wa_id, display_name, name_given_at, locale, consent_at, last_user_at, mode, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(o.waId ?? `91980000${String(++n).padStart(4, "0")}`, o.name === undefined ? "Asha Verma" : o.name, o.given ? iso(NOW - DAY) : null, o.locale ?? "en", o.consent === false ? null : iso(NOW - 3 * DAY), o.lastUserAt === undefined ? null : iso(o.lastUserAt), o.mode ?? "BOT", iso(o.created ?? NOW - 3 * DAY))
      .run()
  ).meta.last_row_id;
}
let m = 0;
async function say(conv: number, dir: "IN" | "OUT", body: string, atMs: number, o: { key?: string; wamid?: string; kind?: string; status?: string } = {}) {
  const wamid = dir === "IN" ? o.wamid ?? `wamid.T${++m}` : null;
  await h.db
    .prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(conv, dir, wamid, dir === "OUT" ? o.key ?? `out.${++m}:reply` : null, o.kind ?? "text", body, o.status ?? (dir === "IN" ? "RECEIVED" : "SENT"), iso(atMs))
    .run();
  await h.db.prepare("UPDATE conversations SET last_user_at = MAX(COALESCE(last_user_at, ''), ?2) WHERE id = ?1 AND ?3 = 'IN'").bind(conv, iso(atMs), dir).run();
  return wamid;
}
async function booking(conv: number, kind: "CALL" | "SESSION", startMs: number, state: string, o: { paise?: number; payState?: string; origin?: string } = {}) {
  const mins = kind === "CALL" ? 15 : 60;
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES (?1, ?2, ?3, ?4, 'BOOKED', 2)").bind(kind, iso(startMs), iso(startMs + mins * MIN), conv).run()).meta.last_row_id;
  const id =
    kind === "CALL"
      ? (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'HEALING', ?3, 2)").bind(conv, slot, state).run()).meta.last_row_id
      : (await h.db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, practitioner_id, origin) VALUES (?1, ?2, 'HEALING', ?3, 2, ?4)").bind(conv, slot, state, o.origin ?? "AMMA").run()).meta.last_row_id;
  if (o.origin !== "CREDIT")
    await h.db
      .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state, created_at) VALUES ('razorpay', ?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(kind === "CALL" ? "INTRO" : "SESSION", id, `di-${kind}-${id}`, o.paise ?? (kind === "CALL" ? 9900 : 79900), o.payState ?? "PAID", iso(startMs - DAY))
      .run();
  return id;
}
// A chat that is due: two customer messages and a bot reply, quiet for 6 minutes.
async function dueChat(o: Parameters<typeof person>[0] = {}) {
  const c = await person(o);
  await say(c, "IN", "Hi, I can't sleep. Please call me on 98100 12345 or asha.verma@example.test", NOW - 20 * MIN);
  await say(c, "OUT", "Thank you. Choose a time below.", NOW - 19 * MIN);
  await say(c, "IN", "Evening is better, and Hindi please. Asha here.", NOW - 6 * MIN);
  return c;
}
const env = () => h.env({ ANTHROPIC_API_KEY: "test-key" });
const prompt = (i = 0) => JSON.stringify((calls[i].body.messages as unknown[])[0]);
const gistRow = (c: number) => h.db.prepare("SELECT summary, made_at AS madeAt, tried_at AS triedAt, last_message_id AS lastId, held FROM gists WHERE conversation_id = ?1").bind(c).first<Record<string, unknown>>();
const page = async (path: string, as = OWNER) => (await h.get(path, as)).text();

beforeEach(async () => {
  await h.start(NOW);
  calls = [];
  aiStatus = 200;
  h.vars = { ANTHROPIC_API_KEY: "test-key" };
  const prev = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes("api.anthropic.com")) {
        calls.push({ body: JSON.parse(init.body ?? "{}") });
        if (aiStatus !== 200) return new Response("{}", { status: aiStatus });
        return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "write_gist", input: FIELDS }], stop_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 150 } }));
      }
      return (prev as (u: string, i: unknown) => Promise<Response>)(url, init);
    }),
  );
});
afterEach(() => h.stop());

describe("the facts (no AI)", () => {
  it("someone new: no name, no bookings, language not chosen, nothing open", async () => {
    const c = await person({ name: "🙏🙏", consent: false });
    await say(c, "IN", "hi", NOW - 3 * 60 * MIN);
    const f = (await gistFacts(env(), (await h.member(OWNER))!, c, null, NOW))!;
    expect(f.who).toBe("No name · Language not chosen yet · first message Sun, 1 Nov");
    expect(f.bookings).toBe("No bookings yet");
    expect(f.next).toBe("Nothing booked");
    expect(f.open).toEqual([]);
    expect(f.last).toBe("From them 3 hours ago · reply window open until Thu, 5 Nov, 11:00 am");
    expect(f.credits).toBeNull();
    expect(f.note).toBeNull();
  });

  it("a paying customer: the history in one line, credits, the next booking, open items, the last After note", async () => {
    const c = await person({ name: "Asha Verma", locale: "hi", lastUserAt: NOW - 26 * 60 * MIN });
    await h.db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1").bind(c).run();
    const callId = await booking(c, "CALL", Date.parse("2026-11-02T09:30:00Z"), "CALLED_SESSION");
    const ses = await booking(c, "SESSION", Date.parse("2026-11-06T10:30:00Z"), "CONFIRMED");
    const pack = (await h.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state, created_at) VALUES (?1, 10, 500000, 'PAID', '2026-11-03T06:00:00Z')").bind(c).run()).meta.last_row_id;
    await h.db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, 10, 'PURCHASE', '2026-11-03T06:00:00Z', 'test'), (?1, -4, 'BOOK', '2026-11-03T06:00:00Z', 'test')").bind(pack).run();
    await h.db.prepare("INSERT INTO attention (kind, target) VALUES ('OUT_OF_SCOPE', ?1), ('CRISIS', ?2)").bind(`session:${ses}`, `conv:${c}`).run();
    await h.db.prepare("INSERT INTO notes (conversation_id, booking_kind, booking_id, phase, body, author_id, created_at) VALUES (?1, 'CALL', ?2, 'AFTER', 'Offered a session next week\nSecond line', 2, ?3)").bind(c, callId, iso(NOW - DAY)).run();
    const owner = (await gistFacts(env(), (await h.member(OWNER))!, c, null, NOW))!;
    expect(owner.who).toBe("Asha Verma · Speaks Hindi · first message Sun, 1 Nov");
    expect(owner.bookings).toBe("₹99 call Mon, 2 Nov (done) · Package of 10 (Tue, 3 Nov) · ₹799 session Fri, 6 Nov, 4:00 pm (confirmed)");
    expect(owner.credits).toBe("Package: 6 of 10 sessions left");
    expect(owner.next).toBe("₹799 session · Fri, 6 Nov, 4:00 pm");
    expect(owner.open.map((o) => o.text)).toEqual(["Waiting for a person", "Safety: see the chat", "Outside what we offer: consider a refund"]);
    expect(owner.last).toBe("From them 26 hours ago · reply window closed (templates only)");
    expect(owner.note).toBe("Offered a session next week");
    // Staff: the safety item only as "the owner is needed", and never a note.
    const staff = (await gistFacts(env(), (await h.member(STAFF))!, c, null, NOW))!;
    expect(staff.open.map((o) => o.text)).toContain("Safety: the owner is needed");
    expect(staff.note).toBeNull();
  });

  it("a typed name, work and help area; a refund on its way (not for the practitioner); a session from a package", async () => {
    const c = await person({ name: "Meera", given: true });
    const callId = await booking(c, "CALL", Date.parse("2026-11-02T09:30:00Z"), "CALLED_NOT_FIT", { payState: "REFUND_PENDING" });
    await h.db.prepare("UPDATE intros SET profession = 'Teacher', help_area = 'SLEEP' WHERE id = ?1").bind(callId).run();
    await booking(c, "SESSION", NOW + DAY, "CREDIT_BOOKED", { origin: "CREDIT" });
    const pid = (await h.db.prepare("SELECT id FROM payments WHERE purpose = 'INTRO' AND target_id = ?1").bind(callId).first<{ id: number }>())!.id;
    await h.db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state) VALUES (?1, 'NOT_FIT', 'system', 'PENDING')").bind(pid).run();
    const owner = (await gistFacts(env(), (await h.member(OWNER))!, c, null, NOW))!;
    expect(owner.who).toBe("Meera · Speaks English · first message Sun, 1 Nov");
    expect(owner.about).toBe("Work: Teacher · Wants help with: Sleep");
    expect(owner.bookings).toBe("₹99 call Mon, 2 Nov (done, refunded) · Session from a package Thu, 5 Nov, 2:00 pm (confirmed)");
    expect(owner.open.map((o) => o.text)).toEqual(["Refund open"]);
    const prac = (await gistFacts(env(), (await h.member(PRAC))!, c, 2, NOW))!;
    expect(prac.bookings).toBe("₹99 call Mon, 2 Nov (done) · Session from a package Thu, 5 Nov, 2:00 pm (confirmed)");
    expect(prac.open).toEqual([]);
  });
});

describe("what goes to the AI", () => {
  it("is redacted, has no notes, and leaves out the messages kept from the AI for safety", async () => {
    const c = await dueChat();
    const crisis = await say(c, "IN", "I want to die", NOW - 15 * MIN);
    await say(c, "OUT", "Fixed safety message with 14416", NOW - 15 * MIN, { key: `${crisis}:crisis` });
    const sex = await say(c, "IN", "I have an erection problem", NOW - 14 * MIN);
    await say(c, "OUT", "This isn't something we can help with", NOW - 14 * MIN, { key: `${sex}:route-sexual_health` });
    await say(c, "IN", "I will kill you", NOW - 13 * MIN);
    await say(c, "OUT", "template:follow_up", NOW - 12 * MIN, { kind: "template" });
    await say(c, "IN", "Book ₹99 call", NOW - 11 * MIN, { kind: "interactive" });
    await say(c, "IN", "", NOW - 10 * MIN, { kind: "image" });
    await say(c, "OUT", "Never sent", NOW - 9 * MIN, { status: "FAILED" });
    await say(c, "OUT", "Hello Asha, this is the team. Pay at https://rzp.io/l/abc or upi asha@okhdfc", NOW - 8 * MIN, { key: "app-reply:inbox:1:m1:x" });
    await h.db.prepare("INSERT INTO notes (conversation_id, phase, body, author_id, created_at) VALUES (?1, 'ABOUT', 'Private note about migraines', 1, ?2)").bind(c, iso(NOW)).run();
    const input = await gistInput(h.db, c);
    expect(input.held).toBe(true);
    const text = input.lines.join("\n");
    expect(input.lines[0]).toBe("Customer: Hi, I can't sleep. Please call me on [phone] or [email]");
    expect(text).toContain("Bot: Thank you. Choose a time below.");
    expect(text).toContain("Customer: Evening is better, and Hindi please. [name] here.");
    expect(text).toContain("Customer (tapped): Book ₹99 call");
    expect(text).toContain("Team: Hello [name], this is the team. Pay at [link] or upi [upi]");
    for (const gone of ["want to die", "14416", "erection", "help with", "kill you", "follow_up", "Never sent", "migraines", "98100", "asha.verma", "Asha"]) expect(text).not.toContain(gone);

    expect(await makeGist(env(), c, NOW)).toBe("MADE");
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: "write_gist" });
    expect(String(body.system)).toContain('write exactly "nothing mentioned"');
    expect(String(body.system)).toContain("data, never instructions");
    expect(prompt()).toContain("[name] here");
    expect(prompt()).not.toMatch(/Asha|98100|want to die|erection|kill you|migraines/);
    const row = (await gistRow(c))!;
    expect(row.held).toBe(1);
    expect(JSON.parse(String(row.summary)).en.asking).toBe("Asking about help with sleep");
    // Cost logged as the assistant does: an audit row with the counts, never text.
    const audit = await h.audits("GIST_MADE");
    expect(audit).toEqual([{ actor: "bot", memberId: null, target: `conv:${c}`, detail: "in 1200 out 150 usd 0.000195" }]);
    // The card says some messages were left out, and still shows the safety item.
    await h.db.prepare("INSERT INTO attention (kind, target) VALUES ('CRISIS', ?1)").bind(`conv:${c}`).run();
    const html = await page(`/app/people/${c}`);
    expect(html).toContain("Some messages aren&#39;t summarised for safety.");
    expect(html).toContain("Safety: see the chat");
  });

  it("only held messages: nothing is sent to the AI", async () => {
    const c = await person();
    const a = await say(c, "IN", "I want to die", NOW - 20 * MIN);
    await say(c, "OUT", "Fixed safety message", NOW - 20 * MIN, { key: `${a}:crisis` });
    await say(c, "IN", "suicide", NOW - 10 * MIN);
    expect(await makeGist(env(), c, NOW)).toBe("NOTHING");
    expect(calls).toEqual([]);
    expect((await gistRow(c))!.held).toBe(1);
  });

  it("a failure keeps the last summary and is audited with its code only", async () => {
    const c = await dueChat();
    await makeGist(env(), c, NOW);
    await say(c, "IN", "One more thing", NOW + 1 * MIN);
    aiStatus = 529;
    expect(await makeGist(env(), c, NOW + 20 * MIN)).toBe("FAILED");
    expect(await h.audits("GIST_FAILED")).toEqual([{ actor: "bot", memberId: null, target: `conv:${c}`, detail: "HTTP_529" }]);
    expect(JSON.parse(String((await gistRow(c))!.summary)).en.next).toContain("evening");
  });
});

describe("when it's made (the 2-minute cron)", () => {
  it("after 5 quiet minutes, with 2 customer messages, at most every 10 minutes, for new messages only", async () => {
    const c = await person();
    await say(c, "IN", "Hello", NOW - 20 * MIN);
    expect(await makeGists(env(), NOW)).toBe(0); // one customer message
    await say(c, "IN", "What does it cost?", NOW - 3 * MIN);
    expect(await makeGists(env(), NOW)).toBe(0); // not quiet for 5 minutes yet
    expect(await makeGists(env(), NOW + 2 * MIN)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await makeGists(env(), NOW + 4 * MIN)).toBe(0); // nothing new
    await say(c, "IN", "And in Hindi?", NOW + 5 * MIN);
    expect(await makeGists(env(), NOW + 10 * MIN)).toBe(0); // new and quiet, but within 10 minutes of the last
    expect(await makeGists(env(), NOW + 12 * MIN)).toBe(1);
    expect(calls).toHaveLength(2);
    // Two runs at once make one.
    await say(c, "IN", "Thanks", NOW + 13 * MIN);
    const both = await Promise.all([makeGists(env(), NOW + 30 * MIN), makeGists(env(), NOW + 30 * MIN)]);
    expect(both.sort()).toEqual([0, 1]);
    expect(calls).toHaveLength(3);
  });

  it("stops at the daily cap, and makes nothing while the switch is off or the assistant is paused, killed or has no key", async () => {
    const c = await dueChat();
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('gist.day:2026-11-04', '200')").run();
    expect(await makeGists(env(), NOW)).toBe(0);
    expect(await makeGist(env(), c, NOW, true)).toBe("CAP");
    expect(await page(`/app/people/${c}`)).toContain("Today&#39;s AI summaries are used up");
    await h.db.prepare("DELETE FROM settings WHERE key = 'gist.day:2026-11-04'").run();

    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('gist.on', 'off')").run();
    expect(await makeGists(env(), NOW)).toBe(0);
    expect(await page(`/app/people/${c}`)).toContain("The AI summary is off");
    await h.db.prepare("DELETE FROM settings WHERE key = 'gist.on'").run();

    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('AI_REPLIES', 'false')").run();
    expect(await makeGists(env(), NOW)).toBe(0);
    expect(await page(`/app/people/${c}`)).toContain("The AI summary waits while the assistant is paused.");
    await h.db.prepare("DELETE FROM settings WHERE key = 'AI_REPLIES'").run();

    expect(await makeGists(h.env({ ANTHROPIC_API_KEY: "test-key", AI_REPLIES: "false" }), NOW)).toBe(0);
    expect(await makeGists(h.env({ ANTHROPIC_API_KEY: undefined }), NOW)).toBe(0);
    expect(calls).toEqual([]);
    // The facts are there all the time.
    expect(await page(`/app/people/${c}`)).toContain("Nothing open");
    expect(await makeGists(env(), NOW)).toBe(1);
    expect(await h.setting("gist.day:2026-11-04")).toBe("1");
  });

  it("the page never calls the AI, and shows the stored gist with its time", async () => {
    const c = await dueChat();
    await h.db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE id = ?1").bind(c, iso(NOW - 6 * MIN)).run();
    for (const p of [`/app/people/${c}`, `/app/inbox/${c}`]) expect(await page(p)).toContain("The summary is made a few minutes after the chat goes quiet.");
    expect(calls).toEqual([]);
    await makeGist(env(), c, NOW);
    vi.setSystemTime(NOW + 12 * MIN);
    for (const p of [`/app/people/${c}`, `/app/inbox/${c}`]) {
      const html = await page(p);
      expect(html, p).toContain('<div class="card gist" id="gist">');
      expect(html, p).not.toContain("&lt;style");
      expect(html, p).toContain("<li><b>Asking about:</b> Asking about help with sleep</li>");
      expect(html, p).toContain("<li><b>Concerns:</b> Prefers evening calls in Hindi</li>");
      expect(html, p).not.toContain("<b>Promised:</b>"); // "nothing mentioned" is left out
      expect(html, p).toContain("<li><b>Next step:</b>");
      expect(html, p).toContain("Updated 12 min ago");
      expect(html.indexOf('id="gist"'), p).toBeLessThan(html.indexOf('id="chat"'));
    }
    expect(calls).toHaveLength(1);
    // A Hindi console reads the Hindi lines.
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE id = 1").run();
    const hi = await page(`/app/people/${c}`);
    expect(hi).toContain("नींद में मदद के बारे में पूछ रहे हैं");
    expect(hi).toContain("सार");
  });
});

describe("who sees it, Refresh, the switch, and wiping", () => {
  it("the owner, the practitioner for her own customers, staff only while they may read chat text", async () => {
    const c = await dueChat();
    await booking(c, "CALL", NOW + 60 * MIN, "PAID");
    const other = await dueChat();
    await makeGist(env(), c, NOW);
    expect(await page(`/app/people/${c}`, PRAC)).toContain('id="gist"');
    expect((await h.get(`/app/people/${other}`, PRAC)).status).toBe(403);
    expect(await page(`/app/people/${c}`, STAFF)).toContain("Asking about help with sleep");
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('privacy.staff_read_chat', 'false')").run();
    const staff = await page(`/app/people/${c}`, STAFF);
    expect(staff).not.toContain('id="gist"');
    expect(staff).not.toContain("Asking about help with sleep");
  });

  it("Refresh (owner, practitioner; token and Origin) makes it now, once a minute", async () => {
    const c = await dueChat();
    await booking(c, "CALL", NOW + 60 * MIN, "PAID");
    const refresh = async (as: string, o: { csrf?: string; origin?: string | null } = {}) =>
      h.post(`/app/gist/${c}/refresh`, { csrf: o.csrf ?? (await h.tokenFor(as, `gist-refresh:${c}`)), back: `/app/people/${c}` }, as, { origin: o.origin });
    expect(await page(`/app/people/${c}`)).toContain(`action="/app/gist/${c}/refresh"`);
    expect(await page(`/app/people/${c}`, STAFF)).not.toContain("/refresh");
    expect((await refresh(STAFF)).status).toBe(403);
    expect((await refresh(OWNER, { csrf: "forged" })).status).toBe(403);
    expect((await refresh(OWNER, { origin: null })).status).toBe(403);
    expect((await refresh(OWNER, { origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toEqual([]);
    const ok = await refresh(OWNER);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe(`/app/people/${c}?g=done#gist`);
    expect(calls).toHaveLength(1);
    expect((await refresh(PRAC)).headers.get("Location")).toContain("g=soon");
    vi.setSystemTime(NOW + 2 * MIN);
    expect((await refresh(PRAC)).headers.get("Location")).toContain("g=done");
    expect(calls).toHaveLength(2);
    expect(await page(`/app/people/${c}?g=done`)).toContain("Summary updated.");
  });

  it("the owner's switch in Settings, on by default and audited; staff can't", async () => {
    const settings = await page("/app/settings");
    expect(settings).toContain('id="sw-gist"');
    expect(settings).toContain("Chat gist (AI)");
    expect(settings).toContain("0 of 200 made today.");
    const sw = async (v: string, as = OWNER) => h.post("/app/gist/switch", { csrf: await h.tokenFor(as, `gist-switch:${v}`), v }, as);
    expect((await sw("off", STAFF)).status).toBe(403);
    expect((await sw("off", PRAC)).status).toBe(403);
    expect((await sw("off")).status).toBe(303);
    expect(await h.setting("gist.on")).toBe("off");
    expect((await sw("on")).status).toBe(303);
    expect((await h.audits("GIST_SWITCH")).map((a) => a.detail)).toEqual(["off", "on"]);
    expect((await h.post("/app/gist/switch", { csrf: "x", v: "off" })).status).toBe(403);
  });

  it("is wiped with the chat text and by Remove their data, and never in the export", async () => {
    const c = await dueChat();
    await makeGist(env(), c, NOW);
    const { buildExport } = await import("../src/export");
    expect(JSON.stringify((await buildExport(h.env(), 7, NOW)).file)).not.toContain("Asking about help with sleep");
    await wipeChats(h.env(), NOW + 6 * DAY);
    expect(await gistRow(c)).not.toBeNull();
    await wipeChats(h.env(), NOW + 8 * DAY);
    expect(await gistRow(c)).toBeNull();
    const d = await dueChat();
    await makeGist(env(), d, NOW);
    await h.post(`/app/people/${d}/remove-data`, { csrf: await h.tokenFor(OWNER, `people-remove:${d}`), reason: "Asked to delete" });
    expect(await gistRow(d)).toBeNull();
  });
});
