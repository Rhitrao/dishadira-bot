// Ticket 26: console follow-ups and the owner's contract decisions of 27 Oct 2026. One describe per item of the ticket.
// All data is synthetic (names, numbers, emails). Access, WhatsApp, Razorpay and email are fakes: nothing real is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { factsText, RULES_HEADER, type Facts } from "../src/ai";
import { checkReply } from "../src/aicheck";
import { loadPrices } from "../src/business";
import { KNOWLEDGE } from "../src/knowledge";
import { mailOpenRequests, REQUESTS_MAIL_KEY } from "../src/requests";
import { holdSlot, iso } from "../src/slots";
import { ALERTS, ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";

const NOW = Date.parse("2026-10-05T10:00:00Z"); // Mon 3:30 pm in Bengaluru, inside working hours
const MIN = 60_000;
const TOMORROW_3PM = "2026-10-06T09:30:00Z"; // a call slot, Tue 3:00 pm in Bengaluru
const h = new ConsoleHarness();
let wa: Record<string, unknown>[] = [];

beforeEach(async () => {
  await h.start(NOW);
  h.vars = { WA_TOKEN: "tok", WA_PHONE_ID: "1000" };
  wa = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes("graph.facebook.com")) wa.push(JSON.parse(init?.body ?? "{}"));
    return inner(url, init as never);
  }) as never;
});
afterEach(() => h.stop());

// ---- helpers ----
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = async (path: string, as = OWNER) => decode(await (await h.get(path, as)).text());
const forms = (html: string) =>
  [...html.matchAll(/<form[^>]*? method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
    action: m[1],
    fields: Object.fromEntries([...m[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((f) => [f[1], f[2]])),
  }));
const formFor = (html: string, action: string, match: Record<string, string> = {}) =>
  forms(html).find((f) => f.action === action && Object.entries(match).every(([k, v]) => f.fields[k] === v))?.fields;
const one = <T = Record<string, unknown>>(sql: string, ...b: unknown[]) => h.db.prepare(sql).bind(...b).first<T>();

let phone = 919811100000;
// A customer chatting now (inside WhatsApp's window), in English.
async function customer(name = "Asha Test", o: { mode?: string } = {}) {
  const waId = String(++phone);
  const id = (
    await h.db
      .prepare("INSERT INTO conversations (wa_id, display_name, locale, mode, last_user_at, human_since, age_ok_at) VALUES (?1, ?2, 'en', ?3, ?4, ?5, ?4)")
      .bind(waId, name, o.mode ?? "BOT", iso(NOW - 10 * MIN), o.mode === "HUMAN" ? iso(NOW - 10 * MIN) : null)
      .run()
  ).meta.last_row_id;
  return { id, waId };
}

// The Inbox's staff cash booking, as src/inbox.ts writes it: a real hold, a HELD call, and a MARK_PAID request naming the call.
async function cashBooking(convId: number, startUtc = TOMORROW_3PM, nowMs = Date.now()) {
  const hold = await holdSlot(h.db, { kind: "CALL", startUtc, ownerId: convId, nowMs });
  if (!hold.ok) throw new Error(`no hold: ${hold.reason}`);
  const intro = (
    await h.db
      .prepare("INSERT INTO intros (conversation_id, slot_id, service, for_whom, call_lang, practitioner_id, created_at) SELECT ?1, id, 'HEALING', 'SELF', 'en', practitioner_id, ?3 FROM slots WHERE kind = 'CALL' AND start_utc = ?2")
      .bind(convId, startUtc, iso(nowMs))
      .run()
  ).meta.last_row_id;
  const staff = (await h.member(STAFF))!;
  await h.db.prepare("INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason) VALUES (1, 'MARK_PAID', ?1, 9900, ?2, 'Paid outside Razorpay (cash or UPI), recorded from the Inbox')").bind(`intro:${intro}`, staff.id).run();
  return intro;
}
const decide = async (decision: "APPROVED" | "DECLINED", as = OWNER) => {
  const f = formFor(await text("/app", as), "/app/today/decide", { decision });
  expect(f, `the ${decision} button is on Today`).toBeTruthy();
  return h.post("/app/today/decide", f!, as);
};

describe("item 2: approving money received confirms the booking (one path)", () => {
  it("a staff cash booking, approved inside the hold: the call is booked, paid by hand, and the customer gets the confirmation", async () => {
    const c = await customer();
    const intro = await cashBooking(c.id);
    const today = await text("/app");
    expect(today).toContain("₹99 received from Asha");
    expect(today).toContain("confirms their booking");
    const res = await decide("APPROVED");
    expect(res.headers.get("Location")).toBe("/app?m=recorded");
    expect(await one("SELECT state FROM intros WHERE id = ?1", intro)).toEqual({ state: "PAID" });
    expect(await one("SELECT state, hold_until AS until FROM slots WHERE start_utc = ?1", TOMORROW_3PM)).toEqual({ state: "BOOKED", until: null });
    expect(await one("SELECT provider, purpose, amount_paise AS amount, state FROM payments WHERE target_id = ?1", intro)).toEqual({ provider: "manual", purpose: "INTRO", amount: 9900, state: "PAID" });
    expect(wa.filter((m) => JSON.stringify(m).includes("Tue"))).toHaveLength(1); // one confirmation with the day
    const audit = (await h.db.prepare("SELECT detail, reason, member_id AS mid FROM audit_log WHERE action = 'REQUEST_MARK_PAID_APPROVED'").all()).results;
    expect(audit).toEqual([{ detail: expect.stringContaining("DONE"), reason: expect.stringContaining("cash or UPI"), mid: (await h.member(OWNER))!.id }]);
    // Deciding again (another tab) changes nothing.
    expect(await h.count("SELECT COUNT(*) AS n FROM requests WHERE decided_at IS NULL")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM payments")).toBe(1);
  });

  it("the hold lapsed but the time is still free: booked, as for any late payment", async () => {
    const c = await customer();
    const intro = await cashBooking(c.id, TOMORROW_3PM, NOW - 45 * MIN); // held 45 minutes ago, lapsed 25 minutes ago
    expect((await decide("APPROVED")).headers.get("Location")).toBe("/app?m=recorded");
    expect(await one("SELECT state FROM intros WHERE id = ?1", intro)).toEqual({ state: "PAID" });
    expect(await one("SELECT state FROM slots WHERE start_utc = ?1", TOMORROW_3PM)).toEqual({ state: "BOOKED" });
  });

  it("the hold lapsed and someone else took the time: nothing is booked, the owner is told, never a double booking", async () => {
    const c = await customer();
    const intro = await cashBooking(c.id, TOMORROW_3PM, NOW - 45 * MIN);
    const other = await customer("Kiran Other");
    expect((await holdSlot(h.db, { kind: "CALL", startUtc: TOMORROW_3PM, ownerId: other.id, nowMs: NOW })).ok).toBe(true);
    const res = await decide("APPROVED");
    expect(res.headers.get("Location")).toBe("/app?m=late");
    expect(await text("/app?m=late")).toContain("that time was taken in the meantime, so nothing was booked");
    expect(await one("SELECT state FROM intros WHERE id = ?1", intro)).toEqual({ state: "EXPIRED" });
    expect(await one("SELECT owner_id AS owner, state FROM slots WHERE start_utc = ?1", TOMORROW_3PM)).toEqual({ owner: other.id, state: "HELD" }); // the other person's hold is untouched
    expect(await one("SELECT kind FROM attention WHERE target = ?1", `intro:${intro}`)).toEqual({ kind: "LATE_PAYMENT_NO_SLOT" });
    expect(await one("SELECT state FROM payments WHERE target_id = ?1", intro)).toEqual({ state: "PAID" }); // the money is on the books, for a new time or a refund
    expect(await h.count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED'")).toBe(0);
  });

  it("declining a staff cash booking frees the held time at once and books nothing", async () => {
    const c = await customer();
    const intro = await cashBooking(c.id);
    expect((await decide("DECLINED")).headers.get("Location")).toBe("/app?m=declined");
    expect(await one("SELECT state FROM intros WHERE id = ?1", intro)).toEqual({ state: "EXPIRED" });
    const other = await customer("Kiran Other");
    expect((await holdSlot(h.db, { kind: "CALL", startUtc: TOMORROW_3PM, ownerId: other.id, nowMs: Date.now() })).ok).toBe(true);
    expect(await h.count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
  });

  it("a staff request for a sent link: approving runs the owner's own record (the link's payment becomes PAID, the call is booked)", async () => {
    const c = await customer();
    const hold = await holdSlot(h.db, { kind: "CALL", startUtc: TOMORROW_3PM, ownerId: c.id, nowMs: NOW });
    expect(hold.ok).toBe(true);
    const intro = (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, for_whom) SELECT ?1, id, 'HEALING', 'SELF' FROM slots WHERE start_utc = ?2").bind(c.id, TOMORROW_3PM).run()).meta.last_row_id;
    const pay = (await h.db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, ?2, 9900, 'PENDING')").bind(intro, `di-intro-${intro}`).run()).meta.last_row_id;
    await h.db.prepare("INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason) VALUES (1, 'MARK_PAID', ?1, 9900, ?2, 'UPI: paid at the desk')").bind(`payment:${pay}`, (await h.member(STAFF))!.id).run();
    expect((await decide("APPROVED")).headers.get("Location")).toBe("/app?m=recorded");
    expect(await one("SELECT state FROM payments WHERE id = ?1", pay)).toEqual({ state: "PAID" });
    expect(await one("SELECT state FROM intros WHERE id = ?1", intro)).toEqual({ state: "PAID" });
  });

  it("only the owner decides: staff see no approval and a hand-made decision is refused", async () => {
    const c = await customer();
    await cashBooking(c.id);
    const html = await text("/app", STAFF);
    expect(formFor(html, "/app/today/decide")).toBeUndefined();
    const id = (await one<{ id: number }>("SELECT id FROM requests"))!.id;
    const res = await h.post("/app/today/decide", { request: String(id), decision: "APPROVED", csrf: await h.tokenFor(STAFF, `decide:${id}:APPROVED`) }, STAFF);
    expect(res.status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM payments")).toBe(0);
  });
});

// A paid call booked with a practitioner, and a few chat lines (one of them a crisis message and the bot's safety reply).
async function bookedWith(convId: number, pracEmail: string, startUtc = TOMORROW_3PM) {
  const pid = (await h.member(pracEmail))!.id;
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED', ?4)").bind(startUtc, iso(Date.parse(startUtc) + 15 * MIN), convId, pid).run()).meta.last_row_id;
  await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'HEALING', 'PAID', ?3)").bind(convId, slot, pid).run();
}
async function chatLines(convId: number) {
  const add = (dir: string, body: string, o: { key?: string; waMsg?: string } = {}) =>
    h.db.prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, 'text', ?5, 'SENT', ?6)").bind(convId, dir, o.waMsg ?? null, o.key ?? null, body, iso(NOW - 5 * MIN)).run();
  await add("IN", "a question about the timing");
  await add("OUT", "the bot answers the timing question", { key: `wamid.Q${convId}:help` });
  await add("IN", "a synthetic crisis line", { waMsg: `wamid.C${convId}` });
  await add("OUT", "the fixed safety reply", { key: `wamid.C${convId}:crisis` });
}

describe("item 3: practitioners read their own customers' chats, read-only", () => {
  it("their own customer: the whole chat, safety lines included; another practitioner's customer: refused", async () => {
    await h.db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, 'second@example.test', 'PRACTITIONER', 'active')").run();
    const mine = await customer("Asha Mine");
    const theirs = await customer("Bina Theirs");
    await bookedWith(mine.id, PRAC);
    await bookedWith(theirs.id, "second@example.test", "2026-10-06T10:00:00Z");
    await chatLines(mine.id);
    await chatLines(theirs.id);
    const page = await text(`/app/people/${mine.id}`, PRAC);
    for (const line of ["a question about the timing", "the bot answers the timing question", "a synthetic crisis line", "the fixed safety reply"]) expect(page).toContain(line);
    expect(page).not.toMatch(/<textarea|action="[^"]*\/reply"/); // read-only: nothing to reply with
    const other = await h.get(`/app/people/${theirs.id}`, PRAC);
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain("a question about the timing");
    expect((await h.get(`/app/inbox/${mine.id}`, PRAC)).status).toBe(403); // the Inbox stays owner and staff only
  });

  it("staff masking is unchanged: staff read the chat but never a safety line", async () => {
    const c = await customer("Asha Mine");
    await bookedWith(c.id, PRAC);
    await chatLines(c.id);
    const page = await text(`/app/people/${c.id}`, STAFF);
    expect(page).toContain("a question about the timing");
    expect(page).not.toContain("a synthetic crisis line");
    expect(page).not.toContain("the fixed safety reply");
    expect(page).toContain("A safety message. An owner is needed.");
  });
});

describe("item 5: Settings apply everywhere", () => {
  it("the workspace accent colour is on every /app page, for every role", async () => {
    const plum = "--accent:#7B3F72";
    const c = await customer("Asha Mine", { mode: "HUMAN" });
    await bookedWith(c.id, PRAC);
    const before = await text("/app");
    expect(before).not.toContain(plum);
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('business.accent', 'plum')").run();
    const pages: [string, string][] = [
      ["/app", OWNER], ["/app/inbox", OWNER], [`/app/inbox/${c.id}`, OWNER], [`/app/inbox/${c.id}/book`, OWNER], ["/app/calendar", OWNER], ["/app/people", OWNER],
      [`/app/people/${c.id}`, OWNER], ["/app/payments", OWNER], ["/app/settings", OWNER], ["/app/settings/audit", OWNER], ["/app/settings/team", OWNER],
      ["/app", STAFF], ["/app/inbox", STAFF], ["/app/people", STAFF], ["/app", PRAC], ["/app/people", PRAC], [`/app/people/${c.id}`, PRAC], ["/app/payments", STAFF],
    ];
    for (const [path, as] of pages) expect(await text(path, as), `${path} as ${as}`).toContain(plum);
  });

  it("'Staff read chats' off: staff see that the text is hidden in Inbox and People, and Today says so; the owner still reads it", async () => {
    const c = await customer("Asha Mine", { mode: "HUMAN" });
    await chatLines(c.id);
    const hiddenLine = "Chat text is hidden by the owner";
    // On by default: staff read the text (but never the safety lines).
    expect(await text(`/app/inbox/${c.id}`, STAFF)).toContain("a question about the timing");
    expect(await text("/app", STAFF)).not.toContain(hiddenLine);
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('privacy.staff_read_chat', 'false')").run();
    for (const path of [`/app/inbox/${c.id}`, `/app/people/${c.id}`]) {
      const page = await text(path, STAFF);
      expect(page, path).toContain(hiddenLine);
      for (const line of ["a question about the timing", "the bot answers the timing question", "a synthetic crisis line", "the fixed safety reply"]) expect(page, path).not.toContain(line);
      const owner = await text(path, OWNER);
      expect(owner, path).toContain("a question about the timing");
      expect(owner, path).not.toContain(hiddenLine);
    }
    expect(await text("/app", STAFF)).toContain(`${hiddenLine}.`);
    expect(await text("/app", OWNER)).not.toContain(hiddenLine);
  });
});

describe("item 4: the outgoing owner chooses their role on a hand-over", () => {
  it("the form offers Practitioner (checked) or Staff; by default the old owner stays on as Practitioner, audited", async () => {
    const staff = (await h.member(STAFF))!;
    const page = await text("/app/settings/team");
    const form = page.slice(page.indexOf('action="/app/settings/team/transfer"><input type="hidden" name="member" value="' + staff.id));
    expect(form).toMatch(/<input type="radio" name="as" value="PRACTITIONER" checked> Practitioner/);
    expect(form).toMatch(/<input type="radio" name="as" value="STAFF"> Staff/);
    const res = await h.post("/app/settings/team/transfer", { member: String(staff.id), as: "PRACTITIONER", csrf: await h.tokenFor(OWNER, `team-transfer:${staff.id}`) });
    expect(res.headers.get("Location")).toBe("/app?m=transferred_p");
    expect((await h.member(OWNER))!.role).toBe("PRACTITIONER");
    expect((await h.member(STAFF))!.role).toBe("OWNER");
    expect(await text("/app?m=transferred_p", OWNER)).toContain("You're now a Practitioner.");
    expect((await h.audits("ownership_transferred"))[0].detail).toBe(`from member:${(await h.member(OWNER))!.id}, now PRACTITIONER`);
  });

  it("a hand-made form with no choice gets the default; a made-up role is refused and nothing changes", async () => {
    const staff = (await h.member(STAFF))!;
    const csrf = await h.tokenFor(OWNER, `team-transfer:${staff.id}`);
    expect((await h.post("/app/settings/team/transfer", { member: String(staff.id), as: "OWNER", csrf })).status).toBe(400);
    expect((await h.member(OWNER))!.role).toBe("OWNER");
    expect((await h.post("/app/settings/team/transfer", { member: String(staff.id), csrf })).headers.get("Location")).toBe("/app?m=transferred_p");
    expect((await h.member(OWNER))!.role).toBe("PRACTITIONER");
  });

  it("new bookings stay on the practitioner who already has the calendar, not on the old owner who became one", async () => {
    const prac = (await h.member(PRAC))!;
    const c = await customer();
    await bookedWith(c.id, PRAC); // the practitioner's calendar has a booking
    const staff = (await h.member(STAFF))!;
    await h.post("/app/settings/team/transfer", { member: String(staff.id), csrf: await h.tokenFor(OWNER, `team-transfer:${staff.id}`) });
    const other = await customer("Kiran Other");
    const hold = await holdSlot(h.db, { kind: "CALL", startUtc: "2026-10-06T10:00:00Z", ownerId: other.id, nowMs: Date.now() });
    expect(hold.ok).toBe(true);
    expect(await one("SELECT practitioner_id AS p FROM slots WHERE owner_id = ?1", other.id)).toEqual({ p: prac.id });
  });
});

describe("item 1e: invites are never emailed", () => {
  it("the owner gets the one-time link on the page, with Send on WhatsApp and a field to copy", async () => {
    const csrf = await h.tokenFor(OWNER, "team-invite");
    const res = await h.post("/app/settings/team/invite", { csrf, email: "new@example.test", role: "PRACTITIONER" });
    expect(res.status).toBe(200);
    const page = decode(await res.text());
    expect(h.emails).toHaveLength(0);
    const link = /readonly value="([^"]+\/app\/invite\/[A-Za-z0-9_-]+)"/.exec(page)![1];
    const wa = /href="https:\/\/wa\.me\/\?text=([^"]+)"/.exec(page)![1];
    expect(decodeURIComponent(wa)).toContain(link);
    expect(decodeURIComponent(wa)).toContain("as Practitioner");
    expect(page).toContain("Send on WhatsApp");
  });

  it("Settings says email only reaches verified addresses, next to who gets the emails", async () => {
    expect(await text("/app/settings")).toContain("once you have verified it in Cloudflare Email Routing");
  });
});

describe("item 7: the Inbox moves a paid ₹99 call, once, on the reschedule code", () => {
  const NEW_TIME = "2026-10-06T10:30:00Z"; // Tue 4:00 pm in Bengaluru
  async function waitingWithCall() {
    const c = await customer("Asha Mine", { mode: "HUMAN" });
    await bookedWith(c.id, PRAC);
    const intro = (await one<{ id: number; slotId: number }>("SELECT id, slot_id AS slotId FROM intros WHERE conversation_id = ?1", c.id))!;
    return { ...c, intro };
  }

  it("staff move it to a free time: the call is booked there, the old time is free, the customer is told, audited", async () => {
    const c = await waitingWithCall();
    const page = await text(`/app/inbox/${c.id}/book`, STAFF);
    expect(page).toContain("Move: ₹99 call, ");
    expect(page).toContain("A call can be moved once, free");
    const f = formFor(page, `/app/inbox/${c.id}/move-call`, { intro: String(c.intro.id) });
    expect(f).toBeTruthy();
    expect(page).toContain(`value="${NEW_TIME}"`);
    const res = await h.post(`/app/inbox/${c.id}/move-call`, { ...f!, time: NEW_TIME }, STAFF);
    expect(res.status).toBe(200);
    expect(decode(await res.text())).toContain("They get a WhatsApp message with the new time.");
    const intro = await one("SELECT state, reschedule_count AS rc, slot_id AS slotId FROM intros WHERE id = ?1", c.intro.id);
    expect(intro).toMatchObject({ state: "RESCHEDULED", rc: 1 });
    expect(await one("SELECT start_utc AS s, state FROM slots WHERE id = ?1", intro!.slotId)).toEqual({ s: NEW_TIME, state: "BOOKED" });
    expect(await one("SELECT state FROM slots WHERE id = ?1", c.intro.slotId)).toEqual({ state: "HELD" }); // freed (its hold has ended)
    expect(await h.count("SELECT COUNT(*) AS n FROM slots WHERE state = 'BOOKED' OR hold_until > ?1", iso(Date.now()))).toBe(1);
    expect(wa.filter((m) => JSON.stringify(m).includes("Your call is now booked for"))).toHaveLength(1);
    expect(await h.audits("INBOX_MOVE_CALL")).toEqual([{ actor: STAFF, memberId: (await h.member(STAFF))!.id, target: `intro:${c.intro.id}`, detail: `${TOMORROW_3PM} -> ${NEW_TIME}` }]);
    // One free move: the page now says so, and the same form sent again changes nothing.
    expect(await text(`/app/inbox/${c.id}/book`, STAFF)).toContain("This call was already moved once");
    const again = await h.post(`/app/inbox/${c.id}/move-call`, { ...f!, time: "2026-10-06T11:00:00Z" }, STAFF);
    expect(again.status).toBe(409);
    expect(await one("SELECT slot_id AS s FROM intros WHERE id = ?1", c.intro.id)).toEqual({ s: intro!.slotId });
  });

  it("a time someone else has is refused and nothing changes; a practitioner can't reach it", async () => {
    const c = await waitingWithCall();
    const other = await customer("Kiran Other");
    expect((await holdSlot(h.db, { kind: "CALL", startUtc: NEW_TIME, ownerId: other.id, nowMs: Date.now() })).ok).toBe(true);
    const csrf = await h.tokenFor(OWNER, `inbox:move-call:${c.id}`);
    const res = await h.post(`/app/inbox/${c.id}/move-call`, { csrf, intro: String(c.intro.id), time: NEW_TIME }, OWNER);
    expect(res.status).toBe(409);
    expect(await one("SELECT state, slot_id AS s FROM intros WHERE id = ?1", c.intro.id)).toEqual({ state: "PAID", s: c.intro.slotId });
    expect(await h.audits("INBOX_MOVE_CALL")).toHaveLength(0);
    const prac = await h.post(`/app/inbox/${c.id}/move-call`, { csrf: await h.tokenFor(PRAC, `inbox:move-call:${c.id}`), intro: String(c.intro.id), time: "2026-10-06T11:00:00Z" }, PRAC);
    expect(prac.status).toBe(403);
    expect(await one("SELECT state FROM intros WHERE id = ?1", c.intro.id)).toEqual({ state: "PAID" });
  });
});

describe("item 8: one bundled 'ask owner' email, at most every 30 minutes", () => {
  const ask = async (kind: string, target: string, amount: number | null, at = iso(Date.now())) =>
    h.db.prepare("INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason, created_at) VALUES (1, ?1, ?2, ?3, ?4, 'a reason', ?5)").bind(kind, target, amount, (await h.member(STAFF))!.id, at).run();

  it("lists every open request in plain words to the owner's alert address, without customer names", async () => {
    await h.db.prepare("UPDATE members SET display_name = 'Desk One' WHERE email = ?1").bind(STAFF).run();
    const c = await customer("Asha Secret");
    const intro = await cashBooking(c.id); // a MARK_PAID for intro:<id>, from the Inbox
    await ask("BLOCK", `conv:${c.id}`, null);
    expect(await mailOpenRequests(h.env(), Date.now())).toBe(true);
    expect(h.emails).toHaveLength(1);
    const e = h.emails[0];
    expect(e.to).toBe(ALERTS);
    expect(e.subject).toBe("Waiting for your approval: 2 requests");
    expect(e.text).toContain("2 requests are waiting for your approval:");
    expect(e.text).toContain(`- Money received outside Razorpay: ₹99 for the customer whose number ends ${c.waId.slice(-4)}. Asked by Desk One, just now.`);
    expect(e.text).toContain(`- Block a number ending ${c.waId.slice(-4)}. Asked by Desk One, just now.`);
    expect(e.text).toContain("Nothing happens until you approve or decline.");
    expect(e.text).not.toContain("Asha");
    expect(e.text).not.toContain(c.waId.slice(0, -4));
    expect(e.text).not.toMatch(/MARK_PAID|BLOCK|intro:|conv:/); // no codes
    expect(intro).toBeGreaterThan(0);
  });

  it("at most one email every 30 minutes; a new request waits for the next; nothing new, nothing sent", async () => {
    const c = await customer();
    await ask("REFUND", "payment:1", 9900);
    expect(await mailOpenRequests(h.env(), NOW)).toBe(true);
    expect(await mailOpenRequests(h.env(), NOW + 2 * MIN)).toBe(false); // the same request: already emailed
    vi.setSystemTime(NOW + 10 * MIN);
    await ask("BLOCK", `conv:${c.id}`, null);
    expect(await mailOpenRequests(h.env(), NOW + 10 * MIN)).toBe(false); // new, but the last email was 10 minutes ago
    expect(await mailOpenRequests(h.env(), NOW + 29 * MIN)).toBe(false);
    expect(await mailOpenRequests(h.env(), NOW + 30 * MIN)).toBe(true);
    expect(h.emails).toHaveLength(2);
    expect(h.emails[1].text).toContain("2 requests are waiting");
    expect(await mailOpenRequests(h.env(), NOW + 120 * MIN)).toBe(false); // nothing new since
    expect(h.emails).toHaveLength(2);
  });

  it("an email that didn't go is tried again on the next run; with the console off, or no requests, nothing is sent", async () => {
    await ask("REFUND", "payment:1", 9900);
    expect(await mailOpenRequests(h.env({ CONSOLE_V2: "false" }), NOW)).toBe(false);
    const down = h.env({ EMAIL: { send: async () => { throw new Error("down"); } } });
    expect(await mailOpenRequests(down, NOW)).toBe(false);
    expect(await h.setting(REQUESTS_MAIL_KEY)).toBeNull(); // the claim was put back
    expect(await mailOpenRequests(h.env(), NOW + 2 * MIN)).toBe(true);
    await h.db.prepare("UPDATE requests SET decided_at = ?1, decision = 'DECLINED'").bind(iso(NOW)).run();
    await h.db.prepare("DELETE FROM settings WHERE key = ?1").bind(REQUESTS_MAIL_KEY).run();
    expect(await mailOpenRequests(h.env(), NOW + 60 * MIN)).toBe(false);
    expect(h.emails).toHaveLength(1);
  });

  it("runs in the 2-minute cron", async () => {
    await ask("REFUND", "payment:1", 9900);
    await (app as unknown as { scheduled: (e: { cron: string; scheduledTime: number }, env: unknown) => Promise<void> }).scheduled({ cron: "*/2 * * * *", scheduledTime: NOW }, h.env());
    expect(h.emails.filter((e) => e.subject.startsWith("Waiting for your approval"))).toHaveLength(1);
  });
});

describe("item 6: the assistant quotes the prices in force", () => {
  const FACTS: Facts = { today: "Monday, 5 October 2026", language: "en", noSell: false, hadIntroCall: false, creditsLeft: 0, next: null, openStep: null };
  afterEach(async () => {
    await h.db.prepare("DELETE FROM settings WHERE key LIKE 'price.%'").run().catch(() => undefined);
  });

  it("with no price rows: config's prices in the facts, and they pass the output check", async () => {
    await loadPrices(h.env());
    expect(factsText(FACTS)).toContain("- Prices in force: first call ₹99 (15 minutes); single session ₹799; 10 sessions ₹5,000 (₹500 a session); 20 sessions ₹9,000 (₹450 a session)");
    expect(checkReply("The first call is ₹99 and a session is ₹799.")).toEqual({ ok: true });
  });

  it("after the owner changes prices in Settings: the facts carry them, the check allows them and refuses the old ones", async () => {
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('price.intro_paise', '14900'), ('price.single_paise', '89900'), ('price.pack10_paise', '600000')").run();
    await loadPrices(h.env());
    const t = factsText(FACTS);
    expect(t).toContain("first call ₹149 (15 minutes); single session ₹899; 10 sessions ₹6,000 (₹600 a session); 20 sessions ₹9,000 (₹450 a session)");
    expect(checkReply("The first call is ₹149, a session ₹899, and 10 sessions are ₹6,000 (₹600 each).")).toEqual({ ok: true });
    expect(checkReply("The first call is ₹99.")).toEqual({ ok: false, reason: "NUMBER" });
    expect(checkReply("A session is ₹799.")).toEqual({ ok: false, reason: "NUMBER" });
    await h.db.prepare("DELETE FROM settings WHERE key LIKE 'price.%'").run();
    await loadPrices(h.env());
  });

  it("the rules and the knowledge bank say prices come from the trusted facts", () => {
    expect(RULES_HEADER).toContain('Prices come from the trusted facts ("Prices in force")');
    expect(KNOWLEDGE).toContain('The "Prices in force" line of the trusted facts is always right');
  });
});
