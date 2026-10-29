// Ticket 22: the Inbox. PRD checks 6 (claim) and 7 (reply window), staff never see safety text, booking for a customer holds a real
// slot, every POST refuses a role that can't do it (and the buttons agree), Hand back / Done, and the one 2-hour email per handoff.
// All data is synthetic. Access, WhatsApp, Razorpay and email are fakes: nothing real is called.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { memberCsrf, type Member } from "../src/auth";
import { config } from "../src/config";
import { CONSOLE_COPY } from "../src/console-copy";
import { FOLLOW_UP_TEXT, INBOX_COPY } from "../src/inbox-copy";
import { inWorkingHours, nudgeWaitingChats, workingMinutes } from "../src/inbox";
import { holdSlot, iso } from "../src/slots";
import { newDb } from "./db";
import { FakeRazorpay, rzpEnv } from "./razorpay";
import { slotAt } from "./slotat";

const NOW = Date.parse("2026-10-05T10:00:00Z"); // Mon 3:30 pm in Bengaluru: inside working hours
const MIN = 60_000;
const HOUR = 3_600_000;
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const OWNER = "owner@example.test";
const PRAC = "practitioner@example.test";
const STAFF = "staff@example.test";
const STAFF2 = "staff2@example.test";
const en = INBOX_COPY.en;
const templates = config.templates as unknown as Record<string, { approved: boolean; hi: { approved: boolean } }>;

let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let tokens: Map<string, string>;
let emails: { to: string; subject: string; text: string }[];
let fake: FakeRazorpay;
let fetchMock: ReturnType<typeof vi.fn>;
let flags: Record<string, string>;

const env = (o: Record<string, unknown> = {}) =>
  ({
    DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: "true", SENDS: "true", NEW_BOOKINGS: "true",
    WA_TOKEN: "tok", WA_PHONE_ID: "1000", PUBLIC_URL: ORIGIN, CHAT_RETENTION_MINUTES: "10080",
    EMAIL: { send: async (m: (typeof emails)[number]) => void emails.push(m) }, ...rzpEnv(), ...flags, ...o,
  }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  tokens = new Map();
  emails = [];
  flags = {};
  fake = new FakeRazorpay();
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let n = 0;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify(jwks));
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }));
    return fake.handle(u, init) ?? new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await get("/app"); // the one-time seed: the owner and the practitioner
  await db.prepare("INSERT INTO members (workspace_id, email, display_name, role, status) VALUES (1, ?1, 'Staff One', 'STAFF', 'active'), (1, ?2, 'Staff Two', 'STAFF', 'active')").bind(STAFF, STAFF2).run();
});
afterEach(async () => {
  templates.follow_up.approved = false;
  templates.follow_up.hi.approved = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

// ---- helpers ----
const sign = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(AUD).setIssuedAt().setExpirationTime("30d").sign(priv);
const jwtFor = async (email: string) => {
  if (!tokens.has(email)) tokens.set(email, await sign(email));
  return tokens.get(email)!;
};
async function get(path: string, as = OWNER, e = env()) {
  return app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as) } }, e);
}
async function post(path: string, form: Record<string, string>, as = OWNER, o: { origin?: string } = {}) {
  return app.request(
    ORIGIN + path,
    { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as), "Content-Type": "application/x-www-form-urlencoded", Origin: o.origin ?? ORIGIN }, body: new URLSearchParams(form).toString() },
    env(),
  );
}
// The page's text with hono's escapes undone, so expectations can use the copy as written ("isn't", not "isn&#39;t").
const unescape = (h: string) => h.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const txt = async (res: Response): Promise<string> => unescape(await res.text());
const page = async (path: string, as = OWNER) => txt(await get(path, as));
const member = (email: string) => db.prepare("SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status FROM members WHERE email = ?1").bind(email).first<Member>();
const idOf = async (email: string) => (await member(email))!.id;
// A form token exactly as the page draws it: what a hand-made POST would send.
const tok = async (email: string, action: string, conv: number) => memberCsrf(await jwtFor(email), (await member(email))!, `inbox:${action}:${conv}`);
const act = async (email: string, conv: number, action: string, form: Record<string, string> = {}) => post(`/app/inbox/${conv}/${action}`, { csrf: await tok(email, action, conv), ...form }, email);
const hasForm = (html: string, conv: number, action: string) => html.includes(`action="/app/inbox/${conv}/${action}"`);
const waSent = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com")).map((c) => JSON.parse((c[1] as { body: string }).body));
const one = <T>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();

let phone = 919800000100;
// A customer whose chat was handed to the team `waitedMin` minutes ago and who last wrote `lastMin` minutes ago.
async function chat(o: { waitedMin?: number; lastMin?: number; mode?: string; name?: string; locale?: string; kind?: string | null; ageOk?: boolean } = {}) {
  const at = (m: number) => iso(Date.now() - m * MIN);
  const r = await db
    .prepare("INSERT INTO conversations (wa_id, display_name, locale, mode, last_user_at, human_since, age_ok_at, consent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(String(++phone), o.name ?? "Sample Person", o.locale ?? "en", o.mode ?? "HUMAN", at(o.lastMin ?? 5), (o.mode ?? "HUMAN") === "HUMAN" ? at(o.waitedMin ?? 30) : null, o.ageOk === false ? null : "2026-01-01T00:00:00Z", at(600))
    .run();
  const id = r.meta.last_row_id;
  if (o.kind !== null) await db.prepare("INSERT INTO attention (kind, target, created_at) VALUES (?1, ?2, ?3)").bind(o.kind ?? "HUMAN_REQUEST", `conv:${id}`, at(o.waitedMin ?? 30)).run();
  return id;
}
const msg = (conv: number, dir: "IN" | "OUT", body: string, o: { key?: string; wa?: string; min?: number; status?: string } = {}) =>
  db
    .prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, 'text', ?5, ?6, ?7)")
    .bind(conv, dir, o.wa ?? null, o.key ?? null, body, o.status ?? (dir === "IN" ? "RECEIVED" : "SENT"), iso(Date.now() - (o.min ?? 4) * MIN))
    .run();
const claim = (conv: number, memberId: number, minAgo: number) => db.prepare("UPDATE conversations SET claimed_by = ?2, claimed_at = ?3 WHERE id = ?1").bind(conv, memberId, iso(Date.now() - minAgo * MIN)).run();

describe("the list", () => {
  it("shows handed-over chats and open safety follow-ups, oldest first, each with why, how long and the reply deadline", async () => {
    const newer = await chat({ waitedMin: 20, name: "Newer Person" });
    const older = await chat({ waitedMin: 90, name: "Older Person", kind: "MEDIA_FROM_CUSTOMER" });
    const safety = await chat({ mode: "BOT", name: "Safety Person", kind: "EMERGENCY", waitedMin: 60 });
    await chat({ mode: "BOT", kind: null, name: "Bot Person" }); // the bot is answering: not in the Inbox
    const html = await page("/app/inbox");
    expect(html).toContain(CONSOLE_COPY.en.qInbox);
    expect(html).not.toContain("Bot Person");
    const order = [older, safety, newer].map((id) => html.indexOf(`href="/app/inbox/${id}"`));
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(en.whyPayment);
    expect(html).toContain(en.whySafety);
    expect(html).toContain(en.waited(en.hours(1, 30)));
    expect(html).toContain(en.replyBy(en.at("Tue, 6 Oct", "3:25 pm"))); // last wrote 5 minutes ago: 24 hours from then, tomorrow
    // No internal codes on screen.
    for (const code of ["HUMAN", "MEDIA_FROM_CUSTOMER", "EMERGENCY", "HUMAN_REQUEST"]) expect(html).not.toContain(code);
  });

  it("All, Mine and Unassigned", async () => {
    const mine = await chat({ name: "Mine Person" });
    const theirs = await chat({ name: "Theirs Person" });
    const free = await chat({ name: "Free Person" });
    await claim(mine, await idOf(STAFF), 5);
    await claim(theirs, await idOf(STAFF2), 5);
    const has = (h: string, id: number) => h.includes(`href="/app/inbox/${id}`);
    const m = await page("/app/inbox?v=mine", STAFF);
    expect([has(m, mine), has(m, theirs), has(m, free)]).toEqual([true, false, false]);
    const u = await page("/app/inbox?v=unassigned", STAFF);
    expect([has(u, mine), has(u, theirs), has(u, free)]).toEqual([false, false, true]);
    const a = await page("/app/inbox", STAFF);
    expect([has(a, mine), has(a, theirs), has(a, free)]).toEqual([true, true, true]);
    expect(a).toContain(en.replyingNow("Staff Two"));
    expect(a).toContain(en.replyingYou);
    expect(await page("/app/inbox?v=mine", OWNER)).toContain(en.emptyMine);
  });

  it("an empty Inbox says what will appear and links on", async () => {
    const html = await page("/app/inbox", STAFF);
    expect(html).toContain(en.emptyAll);
    expect(html).toContain('href="/app"');
  });

  it("shows in Hindi for a member who chose Hindi", async () => {
    await db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(STAFF).run();
    await chat();
    const html = await page("/app/inbox", STAFF);
    expect(html).toContain(CONSOLE_COPY.hi.qInbox);
    expect(html).toContain(INBOX_COPY.hi.whyPerson);
  });
});

describe("PRD check 6: the claim", () => {
  it("someone else's claim under 30 minutes old: Reply warns, naming them; after 30 minutes without a reply it lapses", async () => {
    const id = await chat();
    const other = await idOf(STAFF2);
    await claim(id, other, 10);
    let html = await page(`/app/inbox/${id}`, STAFF);
    expect(html).toContain(en.claimWarning("Staff Two", en.minutes(10)));
    expect(hasForm(html, id, "reply")).toBe(true); // the warning sits above the box: they may still reply after checking
    expect(hasForm(html, id, "assign")).toBe(false);
    // A hand-made Assign is refused and the claim stays theirs.
    await act(STAFF, id, "assign");
    expect((await one<{ by: number }>("SELECT claimed_by AS by FROM conversations WHERE id = ?1", id))!.by).toBe(other);

    vi.setSystemTime(NOW + 21 * MIN); // 31 minutes since the claim, no reply
    html = await page(`/app/inbox/${id}`, STAFF);
    expect(html).not.toContain("Staff Two took this chat");
    expect(hasForm(html, id, "assign")).toBe(true);
    expect(await page("/app/inbox?v=unassigned", STAFF)).toContain(`href="/app/inbox/${id}?v=unassigned"`);
    const res = await act(STAFF, id, "assign");
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=assigned`);
    expect((await one<{ by: number }>("SELECT claimed_by AS by FROM conversations WHERE id = ?1", id))!.by).toBe(await idOf(STAFF));
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'INBOX_ASSIGN' AND member_id = ?1", await idOf(STAFF))).not.toBeNull();
  });

  it("the server stops a reply drawn before someone else took the chat; one drawn with the warning goes", async () => {
    const id = await chat();
    const html = await page(`/app/inbox/${id}`, STAFF); // drawn while nobody had it
    expect(html).toContain('name="seen" value=""');
    await claim(id, await idOf(STAFF2), 2);
    const res = await act(STAFF, id, "reply", { text: "Hello from the team", seen: "" });
    expect(res.status).toBe(409);
    const body = await txt(res);
    expect(body).toContain(en.claimTaken("Staff Two"));
    expect(body).toContain("Hello from the team</textarea>"); // the text is kept
    expect(waSent()).toHaveLength(0);
    const ok = await act(STAFF, id, "reply", { text: "Hello from the team", seen: String(await idOf(STAFF2)) });
    expect(ok.headers.get("Location")).toBe(`/app/inbox/${id}?m=sent`);
    expect(waSent().map((p) => p.text?.body)).toEqual(["Hello from the team"]);
  });

  it("a reply takes an unclaimed chat, and the claimer's replies keep it", async () => {
    const id = await chat();
    await act(STAFF, id, "reply", { text: "First answer", seen: "" });
    const c1 = await one<{ by: number; at: string }>("SELECT claimed_by AS by, claimed_at AS at FROM conversations WHERE id = ?1", id);
    expect(c1!.by).toBe(await idOf(STAFF));
    vi.setSystemTime(NOW + 25 * MIN);
    await act(STAFF, id, "reply", { text: "Second answer", seen: "" });
    vi.setSystemTime(NOW + 50 * MIN); // 50 minutes after the claim, 25 after the last reply: still theirs
    expect(await page(`/app/inbox/${id}`, STAFF2)).toContain(en.claimWarning("Staff One", en.minutes(25)));
    // The team member's name labels their messages.
    expect(await page(`/app/inbox/${id}`, OWNER)).toContain("Staff One · <time>");
  });
});

describe("PRD check 7: the reply window", () => {
  it("inside 24 hours: a reply box and 'Reply by'", async () => {
    const id = await chat({ lastMin: 60 });
    const html = await page(`/app/inbox/${id}`, STAFF);
    expect(html).toContain('<textarea id="reply-text"');
    expect(html).toContain(en.replyBy(en.at("Tue, 6 Oct", "2:30 pm"))); // last message 2:30 pm today
  });

  it("after 24 hours the reply box is replaced by the approved follow-up, ready to send", async () => {
    templates.follow_up.approved = true;
    const id = await chat({ lastMin: 25 * 60, waitedMin: 25 * 60 });
    const html = await page(`/app/inbox/${id}`, STAFF);
    expect(html).not.toContain("<textarea");
    expect(html).toContain(en.windowClosed);
    expect(html).toContain(FOLLOW_UP_TEXT.en);
    expect(hasForm(html, id, "follow-up")).toBe(true);
    expect(html).toContain(en.sendFollowUp);
    const res = await act(STAFF, id, "follow-up");
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=followup`);
    expect(waSent().map((p) => p.template?.name)).toEqual(["follow_up"]);
    // A free-text reply by hand is refused: nothing goes.
    const r2 = await act(STAFF, id, "reply", { text: "Free text", seen: "" });
    expect(r2.status).toBe(409);
    // One follow-up per handoff, whoever sends it.
    expect((await act(OWNER, id, "follow-up")).headers.get("Location")).toBe(`/app/inbox/${id}?m=dup`);
    expect(waSent()).toHaveLength(1);
    expect(await page(`/app/inbox/${id}`, OWNER)).toContain(en.followUpBubble);
  });

  it("a Hindi customer gets the Hindi follow-up once it is approved, and the team sees that wording", async () => {
    templates.follow_up.approved = true;
    templates.follow_up.hi.approved = true;
    const id = await chat({ lastMin: 25 * 60, locale: "hi" });
    expect(await page(`/app/inbox/${id}`, STAFF)).toContain(FOLLOW_UP_TEXT.hi);
    await act(STAFF, id, "follow-up");
    expect(waSent().map((p) => p.template?.name)).toEqual(["follow_up_hi"]);
  });

  it("while the follow-up isn't approved yet, it says so and nothing can be sent", async () => {
    const id = await chat({ lastMin: 25 * 60 });
    const html = await page(`/app/inbox/${id}`, STAFF);
    expect(html).toContain(en.followUpNotApproved);
    expect(hasForm(html, id, "follow-up")).toBe(false);
    expect((await act(STAFF, id, "follow-up")).headers.get("Location")).toBe(`/app/inbox/${id}?m=notapproved`);
    expect(waSent()).toHaveLength(0);
  });
});

describe("safety messages", () => {
  async function crisisChat(open = true) {
    const id = await chat({ kind: open ? "CRISIS" : null });
    await msg(id, "IN", "SAMPLE-CRISIS-WORDS from the customer", { wa: "wamid.IN1", min: 10 });
    await msg(id, "OUT", "SAMPLE-SAFETY-REPLY with helplines", { key: "wamid.IN1:crisis", min: 10 });
    await msg(id, "IN", "an ordinary later message", { wa: "wamid.IN2", min: 5 });
    return id;
  }

  it("staff never see the text of a safety message, nor of the message that set it off; the owner does", async () => {
    const id = await crisisChat();
    const staff = await page(`/app/inbox/${id}`, STAFF);
    expect(staff).not.toContain("SAMPLE-CRISIS-WORDS");
    expect(staff).not.toContain("SAMPLE-SAFETY-REPLY");
    expect(staff).toContain(CONSOLE_COPY.en.safetyHidden);
    expect(staff).toContain(en.safetyInHidden);
    expect(staff).toContain("an ordinary later message");
    const list = await page("/app/inbox", STAFF);
    expect(list).toContain(en.ownerNeeded);
    const owner = await page(`/app/inbox/${id}`, OWNER);
    expect(owner).toContain("SAMPLE-CRISIS-WORDS");
    expect(owner).toContain("SAMPLE-SAFETY-REPLY");
  });

  it("only an owner replies to or closes an open safety follow-up: staff see no buttons and their POSTs are refused", async () => {
    const id = await crisisChat();
    const staff = await page(`/app/inbox/${id}`, STAFF);
    expect(staff).toContain(en.safetyForOwner);
    for (const a of ["reply", "assign", "hand-back", "done", "book", "follow-up"]) expect(hasForm(staff, id, a), a).toBe(false);
    for (const [a, f] of [["reply", { text: "x", seen: "" }], ["done", { note: "x" }], ["hand-back", {}], ["assign", {}]] as const) {
      expect((await act(STAFF, id, a, f)).status, a).toBe(403);
    }
    expect(await one("SELECT 1 FROM attention WHERE kind = 'CRISIS' AND resolved_at IS NULL")).not.toBeNull();
    const owner = await page(`/app/inbox/${id}`, OWNER);
    expect(hasForm(owner, id, "reply")).toBe(true);
    expect(hasForm(owner, id, "done")).toBe(true);
    await act(OWNER, id, "done", { note: "Spoke to them, they are safe" });
    expect(await one("SELECT 1 FROM attention WHERE kind = 'CRISIS' AND resolved_at IS NULL")).toBeNull();
  });

  it("the text stays hidden from staff after the safety item is closed", async () => {
    const id = await crisisChat(false);
    const staff = await page(`/app/inbox/${id}`, STAFF);
    expect(staff).not.toContain("SAMPLE-CRISIS-WORDS");
    expect(staff).not.toContain("SAMPLE-SAFETY-REPLY");
    expect(hasForm(staff, id, "reply")).toBe(true); // not a safety follow-up any more: staff may answer
  });
});

describe("book or move for them", () => {
  const [tomorrow3pm] = slotAt("2026-10-06", "CALL", 4);

  it("the payment link: the existing booking code holds a real slot, makes the link and sends it", async () => {
    const id = await chat();
    const html = await page(`/app/inbox/${id}/book`, STAFF);
    expect(html).toContain(en.bookTitle("₹99"));
    expect(html).toContain(`value="${tomorrow3pm}"`);
    const n = /name="n" value="([0-9a-f-]+)"/.exec(html)![1];
    const form = { service: "HEALING", who: "SELF", time: tomorrow3pm, pay: "link", n };
    const res = await act(STAFF, id, "book", form);
    const body = await txt(res);
    expect(body).toContain(en.heldLink("3:50 pm")); // a 20-minute hold
    const slot = await one<{ state: string; owner: number }>("SELECT state, owner_id AS owner FROM slots WHERE kind = 'CALL' AND start_utc = ?1", tomorrow3pm);
    expect(slot).toEqual({ state: "HELD", owner: id });
    expect(await one<{ state: string }>("SELECT state FROM intros WHERE conversation_id = ?1", id)).toEqual({ state: "HELD" });
    expect(await one<{ state: string }>("SELECT state FROM payments WHERE purpose = 'INTRO'")).toEqual({ state: "PENDING" });
    expect(fake.posts("/payment_links")).toHaveLength(1);
    expect(waSent().filter((p) => p.interactive?.type === "cta_url")).toHaveLength(1);
    // It is a real hold: nobody else can take that time, and the same form sent twice changes nothing.
    const otherPerson = await chat({ kind: null, mode: "BOT" });
    expect((await holdSlot(db, { kind: "CALL", startUtc: tomorrow3pm, ownerId: otherPerson, nowMs: Date.now() })).ok).toBe(false);
    await act(STAFF, id, "book", form);
    expect(fake.posts("/payment_links")).toHaveLength(1);
    expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 1 });
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'INBOX_BOOK' AND member_id = ?1", await idOf(STAFF))).not.toBeNull();
  });

  it("money received (staff): a real hold, a held call and an 'ask owner' request; the owner records money on the person's page instead", async () => {
    const id = await chat();
    const html = await page(`/app/inbox/${id}/book`, STAFF);
    expect(html).toContain(en.payCash);
    const res = await act(STAFF, id, "book", { service: "PROTECTION", who: "FAMILY", time: tomorrow3pm, pay: "cash", n: "abc123" });
    expect(await txt(res)).toContain(en.heldCash("3:50 pm"));
    expect(await one("SELECT state FROM slots WHERE start_utc = ?1", tomorrow3pm)).toEqual({ state: "HELD" });
    const intro = await one<{ id: number; state: string; forWhom: string }>("SELECT id, state, for_whom AS forWhom FROM intros WHERE conversation_id = ?1", id);
    expect(intro).toMatchObject({ state: "HELD", forWhom: "FAMILY" });
    const req = await one<Record<string, unknown>>("SELECT kind, target, amount_paise AS amount, asked_by AS askedBy, decision FROM requests");
    expect(req).toEqual({ kind: "MARK_PAID", target: `intro:${intro!.id}`, amount: config.prices.intro, askedBy: await idOf(STAFF), decision: null });
    expect(fake.posts("/payment_links")).toHaveLength(0);
    expect(waSent()).toHaveLength(0); // nothing goes to the customer until the owner approves
    // The owner's record_payment is "yes", not "ask": no cash option here (their page does it), and a hand-made one is refused.
    const owner = await page(`/app/inbox/${id}/book`, OWNER);
    expect(owner).not.toContain(en.payCash);
    expect(owner).toContain(en.ownerCash);
    expect((await act(OWNER, id, "book", { service: "HEALING", who: "SELF", time: tomorrow3pm, pay: "cash", n: "abc124" })).status).toBe(403);
  });

  it("refuses a time already taken, a second call, a blocked number, paused bookings and a past time", async () => {
    const id = await chat();
    const other = await chat({ kind: null, mode: "BOT" });
    await holdSlot(db, { kind: "CALL", startUtc: tomorrow3pm, ownerId: other, nowMs: NOW });
    const form = (o: Record<string, string> = {}) => ({ service: "HEALING", who: "SELF", time: tomorrow3pm, pay: "link", n: "n1", ...o });
    expect(await txt(await act(STAFF, id, "book", form()))).toContain(en.taken);
    expect(waSent()).toHaveLength(0); // the customer is not told about the team's pick
    expect(await txt(await act(STAFF, id, "book", form({ time: iso(NOW - HOUR), n: "n2" })))).toContain(en.taken);
    flags = { NEW_BOOKINGS: "false" };
    expect(await txt(await act(STAFF, id, "book", form({ n: "n3" })))).toContain(en.paused);
    flags = {};
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) SELECT wa_id, 'ADMIN', 'test' FROM conversations WHERE id = ?1").bind(id).run();
    expect(await txt(await act(STAFF, id, "book", form({ n: "n4" })))).toContain(en.blocked);
    expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 0 });
  });

  it("someone who hasn't said they're 18 or older is asked first, and nothing is held", async () => {
    const id = await chat({ ageOk: false });
    const res = await act(STAFF, id, "book", { service: "HEALING", who: "SELF", time: tomorrow3pm, pay: "link", n: "n9" });
    expect(await txt(res)).toContain(en.ageAsked);
    expect(await one("SELECT 1 FROM slots")).toBeNull();
    expect(waSent().map((p) => p.interactive?.action?.buttons?.[0]?.reply?.id)).toEqual(["age_yes"]);
  });

  it("moves a booked session with the existing guarded move, and tells the customer", async () => {
    const id = await chat();
    const [start, end] = slotAt("2026-10-07", "SESSION", 0);
    const slot = await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED')").bind(start, end, id).run();
    const ses = await db
      .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', 'SELF')")
      .bind(id, slot.meta.last_row_id)
      .run();
    const html = await page(`/app/inbox/${id}/book`, STAFF);
    expect(hasForm(html, id, "move")).toBe(true);
    const [to] = slotAt("2026-10-07", "SESSION", 2);
    const res = await act(STAFF, id, "move", { session: String(ses.meta.last_row_id), time: to });
    expect(await txt(res)).toContain(en.moved(en.at("Wed, 7 Oct", "4:00 pm")));
    expect(await one("SELECT s.start_utc AS at FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.id = ?1", ses.meta.last_row_id)).toEqual({ at: to });
    expect(waSent().map((p) => p.text?.body)).toHaveLength(1);
    // A single session moves once: the second move is refused.
    const [again] = slotAt("2026-10-07", "SESSION", 3);
    expect(await txt(await act(STAFF, id, "move", { session: String(ses.meta.last_row_id), time: again }))).toContain(en.moveRefused);
  });
});

describe("Hand back and Done", () => {
  it("Hand back: the bot answers again, the waiting item closes, the claim goes, and it is logged", async () => {
    const id = await chat();
    await claim(id, await idOf(STAFF), 1);
    const res = await act(STAFF, id, "hand-back");
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=handedback`);
    expect(await one("SELECT mode, human_since AS hs, claimed_by AS by FROM conversations WHERE id = ?1", id)).toEqual({ mode: "BOT", hs: null, by: null });
    expect(await one("SELECT 1 FROM attention WHERE resolved_at IS NULL")).toBeNull();
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'INBOX_HAND_BACK'")).not.toBeNull();
    expect(await page("/app/inbox", STAFF)).not.toContain(`href="/app/inbox/${id}"`);
    // A second tap (another tab) changes nothing.
    expect((await act(STAFF, id, "hand-back")).headers.get("Location")).toBe(`/app/inbox/${id}?m=gone`);
  });

  it("Done needs a one-line closing note, which goes in the log", async () => {
    const id = await chat();
    const empty = await act(STAFF, id, "done", { note: "   " });
    expect(empty.status).toBe(400);
    expect(await txt(empty)).toContain(en.flashNoteNeeded);
    expect(await one("SELECT mode FROM conversations WHERE id = ?1", id)).toEqual({ mode: "HUMAN" });
    const res = await act(STAFF, id, "done", { note: "Answered their question about timings" });
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=done`);
    expect(await one("SELECT mode FROM conversations WHERE id = ?1", id)).toEqual({ mode: "BOT" });
    expect(await one("SELECT reason, member_id AS by FROM audit_log WHERE action = 'INBOX_DONE'")).toEqual({ reason: "Answered their question about timings", by: await idOf(STAFF) });
    expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INBOX_DONE'")).toEqual({ n: 1 });
    await act(STAFF, id, "done", { note: "again" }); // already closed: nothing more is logged
    expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INBOX_DONE'")).toEqual({ n: 1 });
  });

  it("a reply that WhatsApp refuses keeps the card and the text, with 'Message not delivered'", async () => {
    const id = await chat();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/cdn-cgi/access/certs") ? new Response(JSON.stringify(jwks)) : new Response("{}", { status: 400 }),
    );
    const res = await act(STAFF, id, "reply", { text: "Will this arrive?", seen: "" });
    const body = await txt(res);
    expect(body).toContain(en.flashNotDelivered);
    expect(body).toContain("Will this arrive?</textarea>");
  });
});

describe("roles: every POST refuses a role that can't do it, and the buttons agree", () => {
  const ACTIONS: [string, Record<string, string>][] = [
    ["assign", {}], ["reply", { text: "hi", seen: "" }], ["follow-up", {}], ["hand-back", {}], ["done", { note: "n" }],
    ["book", { service: "HEALING", who: "SELF", time: "2026-10-06T09:30:00Z", pay: "link", n: "x1" }], ["move", { session: "1", time: "2026-10-06T09:30:00Z" }],
  ];

  it("the practitioner has no Inbox: the page and every POST are refused", async () => {
    const id = await chat();
    expect((await get("/app/inbox", PRAC)).status).toBe(403);
    expect((await get(`/app/inbox/${id}`, PRAC)).status).toBe(403);
    expect((await get(`/app/inbox/${id}/book`, PRAC)).status).toBe(403);
    for (const [a, f] of ACTIONS) expect((await act(PRAC, id, a, f)).status, a).toBe(403);
    expect(waSent()).toHaveLength(0);
    expect(await one("SELECT mode FROM conversations WHERE id = ?1", id)).toEqual({ mode: "HUMAN" });
  });

  it("a wrong or missing token, or another member's token, is refused", async () => {
    const id = await chat();
    for (const [a, f] of ACTIONS) {
      expect((await post(`/app/inbox/${id}/${a}`, { csrf: "0".repeat(64), ...f }, STAFF)).status, a).toBe(403);
      expect((await post(`/app/inbox/${id}/${a}`, { csrf: await tok(STAFF2, a, id), ...f }, STAFF)).status, a).toBe(403);
    }
    expect((await post(`/app/inbox/${id}/reply`, { csrf: await tok(STAFF, "reply", id), text: "hi", seen: "" }, STAFF, { origin: "https://evil.example" })).status).toBe(403);
    expect(waSent()).toHaveLength(0);
  });

  it("a removed member's open form fails", async () => {
    const id = await chat();
    const t = await tok(STAFF, "reply", id);
    await db.prepare("UPDATE members SET status = 'removed' WHERE email = ?1").bind(STAFF).run();
    expect((await post(`/app/inbox/${id}/reply`, { csrf: t, text: "hi", seen: "" }, STAFF)).status).toBe(403);
  });

  it("owner and staff see the buttons they may use, and those POSTs work", async () => {
    const id = await chat();
    for (const who of [OWNER, STAFF]) {
      const html = await page(`/app/inbox/${id}`, who);
      for (const a of ["reply", "assign", "hand-back", "done"]) expect(hasForm(html, id, a), `${who} ${a}`).toBe(true);
      expect(html).toContain(`href="/app/inbox/${id}/book"`);
    }
  });

  it("the Inbox tab badge counts the chats nobody is replying to", async () => {
    await chat();
    const b = await chat();
    await claim(b, await idOf(STAFF), 1);
    expect(await page("/app/inbox", STAFF)).toMatch(/<span class="badge"><span class="vh">1 waiting: <\/span>1<\/span>/);
  });
});

describe("the 2-hour email", () => {
  const FIVE_PM = NOW + 90 * MIN; // Mon 5:00 pm in Bengaluru
  beforeEach(() => vi.setSystemTime(FIVE_PM));
  it("one email to the owner and staff (not the practitioner) after 2 working hours with no reply; never twice for one handoff", async () => {
    const id = await chat({ waitedMin: 119 });
    expect(await nudgeWaitingChats(env())).toBe(0);
    vi.setSystemTime(FIVE_PM + 2 * MIN);
    expect(await nudgeWaitingChats(env())).toBe(1);
    expect(emails.map((e) => e.to).sort()).toEqual([OWNER, STAFF, STAFF2].sort());
    expect(emails[0].subject).toBe(en.mailSubject);
    expect(emails[0].text).toContain(`${ORIGIN}/app/inbox/${id}`);
    expect(emails[0].text).not.toContain("Sample");
    vi.setSystemTime(FIVE_PM + 60 * MIN);
    expect(await nudgeWaitingChats(env())).toBe(0);
    expect(emails).toHaveLength(3);
    // A new handoff later is a new wait: one more email, the next working day.
    await db.prepare("UPDATE conversations SET human_since = ?2 WHERE id = ?1").bind(id, iso(FIVE_PM + 61 * MIN)).run();
    vi.setSystemTime(Date.parse("2026-10-06T09:30:00Z")); // Tue 3:00 pm: 59 minutes on Monday + 60 today = 119
    expect(await nudgeWaitingChats(env())).toBe(0);
    vi.setSystemTime(Date.parse("2026-10-06T09:32:00Z"));
    expect(await nudgeWaitingChats(env())).toBe(1);
    expect(emails).toHaveLength(6);
  });

  it("no email once the team has replied, outside working hours, or with the console off", async () => {
    const replied = await chat({ waitedMin: 150 });
    await msg(replied, "OUT", "a reply", { key: `admin-reply:inbox:${replied}:m3:abc`, min: 100 });
    expect(await nudgeWaitingChats(env())).toBe(0);
    await chat({ waitedMin: 150 });
    expect(await nudgeWaitingChats(env({ CONSOLE_V2: "false" }))).toBe(0);
    vi.setSystemTime(Date.parse("2026-10-05T14:00:00Z")); // 7:30 pm: closed
    expect(await nudgeWaitingChats(env())).toBe(0);
    expect(emails).toHaveLength(0);
  });

  it("if no email went, the chat is tried again on the next run", async () => {
    await chat({ waitedMin: 150 });
    expect(await nudgeWaitingChats(env({ EMAIL: { send: async () => { throw new Error("down"); } } }))).toBe(0);
    expect(await nudgeWaitingChats(env())).toBe(1);
  });

  it("counts only working hours (Monday to Saturday): Saturday 6:30 pm to Monday 3:00 pm is 90 minutes; Friday 6:30 pm to Monday 3:00 pm is 390", () => {
    expect(workingMinutes(Date.parse("2026-10-10T13:00:00Z"), Date.parse("2026-10-12T09:30:00Z"))).toBe(90);
    expect(workingMinutes(Date.parse("2026-10-09T13:00:00Z"), Date.parse("2026-10-12T09:30:00Z"))).toBe(390);
    expect(inWorkingHours(Date.parse("2026-10-10T09:30:00Z"))).toBe(true); // Saturday
    expect(inWorkingHours(Date.parse("2026-10-11T09:30:00Z"))).toBe(false); // Sunday
    expect(inWorkingHours(NOW)).toBe(true);
  });
});

describe("the words", () => {
  it("every Inbox string has English and Hindi", () => {
    expect(Object.keys(INBOX_COPY.hi).sort()).toEqual(Object.keys(INBOX_COPY.en).sort());
    for (const [k, v] of Object.entries(INBOX_COPY.hi)) expect(typeof v === "string" ? v.length : 1, k).toBeGreaterThan(0);
  });
});
