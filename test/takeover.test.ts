// Ticket 36 A: "Take over this chat". The team takes a chat the bot is handling (BOT -> HUMAN, as "Talk to a person") from the person
// page in /app or from /admin/conv/<id>: rights as the Inbox's, POST-only with Origin and the per-form token, audited, nothing sent to the
// customer and no item raised; the chat is then in the Inbox (reply box, Book or move for them); the bot stays quiet; Hand back returns
// it; follow-ups skip it; the 24-hour return is quiet. All data is synthetic; Access, WhatsApp, Razorpay and email are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { csrf } from "../src/amma";
import { allCopy } from "../src/copy";
import { whatsappFollowUps } from "../src/followup";
import { INBOX_COPY } from "../src/inbox-copy";
import { PEOPLE_COPY } from "../src/people-copy";
import { iso } from "../src/slots";
import { returnStaleHumans } from "../src/watch";
import { ConsoleHarness, ORIGIN, OWNER, PRAC, STAFF } from "./console-env";

const NOW = Date.parse("2026-10-05T10:00:00Z"); // Mon 3:30 pm India time
const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET = "test-app-secret";
const h = new ConsoleHarness();
const pc = PEOPLE_COPY.en;
const ic = INBOX_COPY.en;
const en = allCopy.en;

beforeEach(async () => {
  await h.start(NOW);
  h.vars = { WA_APP_SECRET: SECRET, WA_TOKEN: "tok", WA_PHONE_ID: "1000" };
});
afterEach(() => h.stop());

// A customer the bot is talking to, who wrote 10 minutes ago (inside WhatsApp's 24-hour window).
async function customer(waId = "919800000101", mode = "BOT"): Promise<number> {
  const id = (
    await h.db
      .prepare("INSERT INTO conversations (wa_id, display_name, locale, mode, greeted_at, consent_at, last_user_at) VALUES (?1, 'Test Customer', 'en', ?2, ?3, ?3, ?4)")
      .bind(waId, mode, iso(NOW - HOUR), iso(NOW - 10 * MIN))
      .run()
  ).meta.last_row_id;
  await h.db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(id).run();
  return id;
}
const conv = (id: number) => h.db.prepare("SELECT * FROM conversations WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const graphSends = () => vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com"));
const takeOver = async (id: number, as = OWNER, o: { token?: string; origin?: string | null } = {}) =>
  h.post(`/app/people/${id}/take-over`, { csrf: o.token ?? (await h.tokenFor(as, `people-takeover:${id}`)) }, as, { origin: o.origin });

// A signed WhatsApp webhook post, as Meta sends it.
async function typed(from: string, body: string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from }], messages: [{ id: `wamid.IN${Math.random()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }] });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const sig = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, h.env());
}

describe("Take over this chat (/app person page)", () => {
  it("the owner takes a bot chat: HUMAN since now, the chat is theirs, one audit row, nothing sent, no item, no email; the Inbox opens on it", async () => {
    const id = await customer();
    await h.db.prepare("UPDATE conversations SET pending_step = 'time', pending_out = '{}', pending_until = ?2 WHERE id = ?1").bind(id, iso(NOW + HOUR)).run();
    const page = await (await h.get(`/app/people/${id}`)).text();
    expect(page).toContain(pc.takeOver);
    expect(page).toContain(`action="/app/people/${id}/take-over"`);
    vi.mocked(fetch).mockClear();
    const res = await takeOver(id);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=takenover`);
    const c = await conv(id);
    expect(c?.mode).toBe("HUMAN");
    expect(c?.human_since).toBe(iso(NOW));
    expect(c?.pending_step).toBeNull(); // the open booking step closes, so a typed time is not booked behind the team's back
    expect(c?.claimed_by).toBe((await h.member(OWNER))!.id);
    const audits = await h.audits("INBOX_TAKE_OVER");
    expect(audits).toEqual([{ actor: OWNER, memberId: (await h.member(OWNER))!.id, target: `conv:${id}`, detail: "BOT -> HUMAN" }]);
    expect(graphSends()).toHaveLength(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
    expect(h.emails).toHaveLength(0);
    // In the Inbox: the reply box (inside the window) and "Book or move for them"; the reason says the team took it.
    const inbox = await (await h.get(`/app/inbox/${id}?m=takenover`)).text();
    expect(inbox).toContain(ic.flashTakenOver);
    expect(inbox).toContain(ic.whyTakenOver);
    expect(inbox).toContain(`action="/app/inbox/${id}/reply"`);
    expect(inbox).toContain(ic.bookOrMove);
    expect(inbox).toContain(ic.handBack);
    // The person page no longer offers it
    expect(await (await h.get(`/app/people/${id}`)).text()).not.toContain(pc.takeOver);
  });

  it("staff may take over (as they may reply in the Inbox); a practitioner sees no button and the POST is refused", async () => {
    const id = await customer();
    expect(await (await h.get(`/app/people/${id}`, STAFF)).text()).toContain(pc.takeOver);
    expect((await takeOver(id, STAFF)).status).toBe(303);
    expect((await conv(id))?.mode).toBe("HUMAN");
    expect((await h.audits("INBOX_TAKE_OVER"))[0].memberId).toBe((await h.member(STAFF))!.id);

    // The practitioner's own customer: they read the chat, but can't reply, so can't take it over.
    const other = await customer("919800000102");
    const prac = (await h.member(PRAC))!.id;
    await h.db.prepare("INSERT INTO intros (conversation_id, service, state, practitioner_id) VALUES (?1, 'HEALING', 'PAID', ?2)").bind(other, prac).run();
    const page = await h.get(`/app/people/${other}`, PRAC);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(pc.takeOver);
    expect((await takeOver(other, PRAC)).status).toBe(403);
    expect((await conv(other))?.mode).toBe("BOT");
  });

  it("a chat with an open safety item: the owner may, staff may not", async () => {
    const id = await customer();
    await h.db.prepare("INSERT INTO attention (kind, target) VALUES ('EMERGENCY', ?1)").bind(`conv:${id}`).run();
    expect(await (await h.get(`/app/people/${id}`, STAFF)).text()).not.toContain(pc.takeOver);
    expect((await takeOver(id, STAFF)).status).toBe(403);
    expect((await conv(id))?.mode).toBe("BOT");
    expect((await takeOver(id, OWNER)).status).toBe(303);
    expect((await conv(id))?.mode).toBe("HUMAN");
  });

  it("the form token and the Origin are checked: a wrong token, another person's token, or no Origin changes nothing", async () => {
    const id = await customer();
    const other = await customer("919800000103");
    expect((await takeOver(id, OWNER, { token: "nope" })).status).toBe(403);
    expect((await takeOver(id, OWNER, { token: await h.tokenFor(OWNER, `people-takeover:${other}`) })).status).toBe(403);
    expect((await takeOver(id, OWNER, { token: await h.tokenFor(STAFF, `people-takeover:${id}`) })).status).toBe(403); // another member's token
    expect((await takeOver(id, OWNER, { origin: null })).status).toBe(403);
    expect((await takeOver(id, OWNER, { origin: "https://evil.example" })).status).toBe(403);
    // GET is not a way in
    expect((await h.get(`/app/people/${id}/take-over`)).status).not.toBe(303);
    expect((await conv(id))?.mode).toBe("BOT");
    expect(await h.audits("INBOX_TAKE_OVER")).toEqual([]);
  });

  it("only while the bot has the chat: not shown for a chat already with the team or blocked, and a POST then changes nothing", async () => {
    const human = await customer("919800000104", "HUMAN");
    const blocked = await customer("919800000105", "BLOCKED");
    for (const id of [human, blocked]) {
      expect(await (await h.get(`/app/people/${id}`)).text()).not.toContain(pc.takeOver);
      const res = await takeOver(id);
      expect(res.headers.get("Location")).toBe(`/app/people/${id}?m=gone`);
    }
    // A number in the block list whose chat still says BOT (they haven't written since): not taken.
    const listed = await customer("919800000106");
    await h.db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES ('919800000106', 'ADMIN', 'test')").run();
    expect((await takeOver(listed)).headers.get("Location")).toBe(`/app/people/${listed}?m=gone`);
    expect((await conv(listed))?.mode).toBe("BOT");
    expect(await h.audits("INBOX_TAKE_OVER")).toEqual([]);
  });
});

describe("after a take-over", () => {
  it("the bot stays quiet (one short 'with our team' note at most), and Hand back returns the chat to the bot", async () => {
    const id = await customer();
    await takeOver(id);
    vi.mocked(fetch).mockClear();
    await typed("919800000101", "2pm to 4");
    await typed("919800000101", "are you there");
    const bodies = graphSends().map((c) => JSON.parse((c[1] as { body: string }).body).text?.body);
    expect(bodies).toEqual([en.humanWaitAck]); // as for any chat with the team: nothing booked, no menu, no re-prompt
    expect(await h.count("SELECT COUNT(*) AS n FROM slots")).toBe(0);
    const res = await h.post(`/app/inbox/${id}/hand-back`, { csrf: await h.tokenFor(OWNER, `inbox:hand-back:${id}`) });
    expect(res.headers.get("Location")).toBe(`/app/inbox/${id}?m=handedback`);
    expect((await conv(id))?.mode).toBe("BOT");
  });

  it("follow-ups skip a chat the team has taken over; the same chat left with the bot gets one", async () => {
    const taken = await customer("919800000107");
    const left = await customer("919800000108");
    for (const id of [taken, left]) await h.db.prepare("UPDATE person_state SET real_in_at = ?2 WHERE conversation_id = ?1").bind(id, iso(NOW - 61 * MIN)).run();
    await takeOver(taken);
    vi.mocked(fetch).mockClear();
    expect(await whatsappFollowUps(h.env(), NOW)).toBe(1);
    const to = graphSends().map((c) => JSON.parse((c[1] as { body: string }).body).to);
    expect(to).toEqual(["919800000108"]);
    expect(await h.count("SELECT COUNT(*) AS n FROM followups WHERE person = ?1", String(taken))).toBe(0);
  });

  it("24 hours later with no reply the chat goes back to the bot quietly: no 'sorry we couldn't reply' to someone who never asked", async () => {
    const id = await customer();
    await takeOver(id);
    vi.mocked(fetch).mockClear();
    h.emails.length = 0;
    expect(await returnStaleHumans(h.env(), NOW + 24 * HOUR + 1000)).toBe(1);
    expect((await conv(id))?.mode).toBe("BOT");
    expect(graphSends()).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'handback:%'")).toBe(0);
  });
});

describe("Take over and Hand back on /admin (CONSOLE_V2 off, as on live)", () => {
  it("one button on the person page, POST with Origin and its token, audited; then Hand back", async () => {
    h.vars = { ...h.vars, CONSOLE_V2: "false" };
    const id = await customer();
    const page = await (await h.get(`/admin/conv/${id}`)).text();
    expect(page).toContain("Take over this chat");
    const jwt = await h.jwtFor(OWNER);
    const post = (path: string, form: Record<string, string>, origin: string | null = ORIGIN) =>
      h.post(path, form, OWNER, { origin });
    expect((await post("/admin/take-over", { conv: String(id), csrf: "nope" })).status).toBe(403);
    expect((await post("/admin/take-over", { conv: String(id), csrf: await csrf(jwt, `take-over:${id}`) }, null)).status).toBe(403);
    expect((await conv(id))?.mode).toBe("BOT");
    vi.mocked(fetch).mockClear();
    const res = await post("/admin/take-over", { conv: String(id), csrf: await csrf(jwt, `take-over:${id}`) });
    expect(res.headers.get("Location")).toBe(`/admin/conv/${id}?m=takenover`);
    expect((await conv(id))?.mode).toBe("HUMAN");
    expect(graphSends()).toHaveLength(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM attention")).toBe(0);
    expect((await h.db.prepare("SELECT actor, detail FROM audit_log WHERE action = 'ADMIN_TAKE_OVER'").all()).results).toEqual([{ actor: OWNER, detail: "BOT -> HUMAN" }]);
    const after = await (await h.get(`/admin/conv/${id}?m=takenover`)).text();
    expect(after).toContain("Hand back to the bot");
    expect(after).toContain("Reply on WhatsApp"); // the reply box, inside the 24-hour window
    const back = await post("/admin/hand-back", { conv: String(id), csrf: await csrf(jwt, `hand-back:${id}`) });
    expect(back.headers.get("Location")).toBe(`/admin/conv/${id}?m=handedback`);
    expect((await conv(id))?.mode).toBe("BOT");
    expect(await h.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ADMIN_HAND_BACK'")).toBe(1);
  });
});
