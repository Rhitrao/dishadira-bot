// Ticket 26: console follow-ups and the owner's contract decisions of 27 Oct 2026. One describe per item of the ticket.
// All data is synthetic (names, numbers, emails). Access, WhatsApp, Razorpay and email are fakes: nothing real is called.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdSlot, iso } from "../src/slots";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env";

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
  [...html.matchAll(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
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
    void PRAC;
  });
});
