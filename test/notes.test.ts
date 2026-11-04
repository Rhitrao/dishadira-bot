import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExport } from "../src/export";
import { phaseAt } from "../src/notes";
import { wipeChats } from "../src/wipe";
import { ConsoleHarness, ORIGIN, OWNER, PRAC, STAFF } from "./console-env";

// Ticket 47: notes for each customer. All data is synthetic (names, numbers, emails); Access, WhatsApp, Razorpay and the AI are fakes.
// Wed 4 Nov 2026, 2:00 pm in Bengaluru.
const NOW = Date.parse("2026-11-04T08:30:00Z");
const MIN = 60_000;
const h = new ConsoleHarness();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

let conv: number; // Asha: a paid ₹99 call with the practitioner at 2:30 pm, and a call last week
let call: number;
let pastCall: number;
let other: number; // Ravi: no booking with the practitioner
let anthropic: string[];

async function person(waId: string, name: string, lastUserAt = NOW - 30 * MIN) {
  return (await h.db.prepare("INSERT INTO conversations (wa_id, display_name, locale, consent_at, last_user_at, created_at) VALUES (?1, ?2, 'en', ?3, ?4, ?3)").bind(waId, name, iso(NOW - 10 * 86_400_000), iso(lastUserAt)).run()).meta.last_row_id;
}
async function intro(c: number, startMs: number, state = "PAID", practitioner: number | null = 2) {
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED', ?4)").bind(iso(startMs), iso(startMs + 15 * MIN), c, practitioner).run()).meta.last_row_id;
  return (await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id, call_lang, for_whom) VALUES (?1, ?2, 'HEALING', ?3, ?4, 'en', 'SELF')").bind(c, slot, state, practitioner).run()).meta.last_row_id;
}
async function message(c: number, dir: "IN" | "OUT", body: string, atMs: number) {
  await h.db.prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, 'text', ?5, ?6, ?7)")
    .bind(c, dir, dir === "IN" ? `wamid.${c}.${atMs}` : null, dir === "OUT" ? `out.${c}.${atMs}` : null, body, dir === "IN" ? "RECEIVED" : "SENT", iso(atMs))
    .run();
}
const add = async (c: number, form: Record<string, string>, as = OWNER, o: { origin?: string | null; csrf?: string } = {}) =>
  h.post(`/app/notes/${c}/add`, { csrf: o.csrf ?? (await h.tokenFor(as, `notes-add:${c}`)), phase: "BEFORE", ...form }, as, { origin: o.origin });
const notesRows = () => h.db.prepare("SELECT id, conversation_id AS conv, booking_kind AS kind, booking_id AS bid, phase, body, author_id AS author, edited_at AS edited FROM notes ORDER BY id").all<Record<string, unknown>>().then((r) => r.results);

beforeEach(async () => {
  await h.start(NOW);
  anthropic = [];
  const prev = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: unknown) => {
    if (String(url).includes("anthropic.com")) {
      anthropic.push(String((init as { body?: string }).body ?? ""));
      return new Response("{}", { status: 500 });
    }
    return (prev as (u: string, i: unknown) => Promise<Response>)(url, init);
  }));
  conv = await person("919800004821", "Asha Verma");
  call = await intro(conv, NOW + 30 * MIN);
  pastCall = await intro(conv, NOW - 7 * 86_400_000, "CALLED_SESSION");
  other = await person("919800005555", "Ravi Kumar");
  await message(conv, "IN", "Hello, I can't sleep well", NOW - 40 * MIN);
  await message(conv, "OUT", "Thank you. Choose a time below.", NOW - 39 * MIN);
});
afterEach(() => h.stop());

describe("the phase from the time", () => {
  it("is Before until the start, During until the end, After from the end", () => {
    const s = "2026-11-04T09:00:00Z";
    const e = "2026-11-04T09:15:00Z";
    expect(phaseAt(Date.parse(s) - 1, s, e)).toBe("BEFORE");
    expect(phaseAt(Date.parse(s), s, e)).toBe("DURING");
    expect(phaseAt(Date.parse(e) - 1, s, e)).toBe("DURING");
    expect(phaseAt(Date.parse(e), s, e)).toBe("AFTER");
  });

  it("is chosen on the form from the booking, and can be changed", async () => {
    const checked = (page: string) => /<input type="radio" name="phase" value="(\w+)" checked>/.exec(page)?.[1];
    const page = async () => (await h.get(`/app/people/${conv}?b=CALL-${call}`)).text();
    expect(checked(await page())).toBe("BEFORE");
    expect(await page()).toMatch(new RegExp(`<option value="CALL-${call}" selected>`));
    vi.setSystemTime(NOW + 30 * MIN);
    expect(checked(await page())).toBe("DURING");
    vi.setSystemTime(NOW + 45 * MIN);
    expect(checked(await page())).toBe("AFTER");
    // Changed by hand: a During note after the call is kept as During.
    expect((await add(conv, { text: "Talked about sleep", phase: "DURING", booking: `CALL-${call}` })).status).toBe(303);
    expect((await notesRows())[0]).toMatchObject({ phase: "DURING", kind: "CALL", bid: call });
  });
});

describe("writing, editing and deleting notes", () => {
  it("the owner adds a note to a booking; the audit has ids only, never the text", async () => {
    const res = await add(conv, { text: "Wants help with sleep.\r\nPrefers Hindi.", booking: `CALL-${call}`, back: `/app/people/${conv}#notes` });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/people/${conv}?n=saved&nb=CALL-${call}#notes`);
    const [n] = await notesRows();
    expect(n).toMatchObject({ conv, kind: "CALL", bid: call, phase: "BEFORE", body: "Wants help with sleep.\nPrefers Hindi.", author: 1, edited: null });
    const audit = await h.audits("NOTE_ADD");
    expect(audit).toEqual([{ actor: OWNER, memberId: 1, target: `conv:${conv}`, detail: `note ${n.id}, call ${call}, before` }]);
    const page = await (await h.get(`/app/people/${conv}?n=saved`)).text();
    expect(page).toContain("Note saved.");
    expect(page).toContain("Wants help with sleep.\nPrefers Hindi.");
    expect(page).toMatch(/<h2 class="sec"><span>Notes<\/span><span class="n">1<\/span>/);
    expect(page).toContain("₹99 call · Wed, 4 Nov, 2:30 pm");
    expect(page).toMatch(/<p class="ph">Before<\/p>/);
    const log = await (await h.get("/app/settings/audit")).text();
    expect(log).not.toContain("Wants help with sleep");
  });

  it("the practitioner writes for her own customers only; staff never see or write notes", async () => {
    expect((await add(conv, { text: "Before the call: ask about sleep", booking: `CALL-${call}` }, PRAC)).status).toBe(303);
    expect((await add(other, { text: "Not mine" }, PRAC)).status).toBe(403);
    expect((await add(conv, { text: "Staff note" }, STAFF)).status).toBe(403);
    expect((await notesRows()).map((r) => r.body)).toEqual(["Before the call: ask about sleep"]);
    const prac = await (await h.get(`/app/people/${conv}`, PRAC)).text();
    expect(prac).toContain("Before the call: ask about sleep");
    expect(prac).toContain('action="/app/notes/');
    const staff = await (await h.get(`/app/people/${conv}`, STAFF)).text();
    expect(staff).not.toContain("Before the call: ask about sleep");
    expect(staff).not.toContain('id="notes"');
    expect(staff).not.toContain("/app/notes/");
    // Staff can't edit or delete either, even with a hand-made form.
    const id = (await notesRows())[0].id as number;
    expect((await h.post(`/app/notes/edit/${id}`, { csrf: await h.tokenFor(STAFF, `notes-edit:${id}`), text: "x" }, STAFF)).status).toBe(403);
    expect((await h.post(`/app/notes/delete/${id}`, { csrf: await h.tokenFor(STAFF, `notes-delete:${id}`) }, STAFF)).status).toBe(403);
  });

  it("needs the form's own token and the console's Origin", async () => {
    expect((await add(conv, { text: "a" }, OWNER, { csrf: "forged" })).status).toBe(403);
    expect((await add(conv, { text: "a" }, OWNER, { csrf: await h.tokenFor(OWNER, `notes-add:${other}`) })).status).toBe(403);
    expect((await add(conv, { text: "a" }, OWNER, { csrf: await h.tokenFor(PRAC, `notes-add:${conv}`) })).status).toBe(403);
    expect((await add(conv, { text: "a" }, OWNER, { origin: null })).status).toBe(403);
    expect((await add(conv, { text: "a" }, OWNER, { origin: "https://evil.example" })).status).toBe(403);
    expect(await notesRows()).toEqual([]);
  });

  it("takes up to 2,000 characters, never an empty note, a booking of someone else or an unknown phase", async () => {
    expect((await add(conv, { text: "a".repeat(2000) })).status).toBe(303);
    expect((await add(conv, { text: "a\r\n".repeat(1000).trim() })).status).toBe(303); // 1,999 characters once \r\n is one newline
    const long = await add(conv, { text: "a".repeat(2001) });
    expect(long.headers.get("Location")).toContain("n=long");
    const empty = await add(conv, { text: "   \r\n " });
    expect(empty.headers.get("Location")).toContain("n=empty");
    expect((await h.get(`/app/people/${conv}?n=long`).then((r) => r.text()))).toContain("A note can be up to 2000 characters.");
    const ravisCall = await intro(other, NOW + 90 * MIN, "PAID", null);
    expect((await add(conv, { text: "wrong booking", booking: `CALL-${ravisCall}` })).status).toBe(400);
    expect((await add(conv, { text: "about", phase: "ABOUT" })).status).toBe(400);
    expect((await notesRows()).length).toBe(2);
    expect(await h.audits("NOTE_ADD")).toHaveLength(2);
  });

  it("the author or the owner edits or deletes; the edited time shows", async () => {
    await add(conv, { text: "Her note", booking: `CALL-${call}` }, PRAC);
    await add(conv, { text: "The owner note" });
    const [mine, owners] = (await notesRows()).map((r) => r.id as number);
    // The practitioner can't change the owner's note.
    expect((await h.post(`/app/notes/edit/${owners}`, { csrf: await h.tokenFor(PRAC, `notes-edit:${owners}`), text: "changed" }, PRAC)).status).toBe(403);
    expect((await h.post(`/app/notes/delete/${owners}`, { csrf: await h.tokenFor(PRAC, `notes-delete:${owners}`) }, PRAC)).status).toBe(403);
    // Her own, she can; the owner can change hers too.
    vi.setSystemTime(NOW + 5 * MIN);
    expect((await h.post(`/app/notes/edit/${mine}`, { csrf: await h.tokenFor(PRAC, `notes-edit:${mine}`), text: "Her note, changed" }, PRAC)).status).toBe(303);
    expect((await h.post(`/app/notes/edit/${mine}`, { csrf: "wrong", text: "x" })).status).toBe(403);
    vi.setSystemTime(NOW + 65 * MIN);
    const page = await (await h.get(`/app/people/${conv}`)).text();
    expect(page).toContain("Her note, changed");
    expect(page).toContain("practitioner · 1 hour ago · edited 1 hour ago");
    expect((await h.post(`/app/notes/delete/${mine}`, { csrf: await h.tokenFor(OWNER, `notes-delete:${mine}`) })).status).toBe(303);
    expect((await notesRows()).map((r) => r.body)).toEqual(["The owner note"]);
    expect((await h.audits("NOTE_EDIT"))[0]).toMatchObject({ target: `conv:${conv}`, detail: `note ${mine}` });
    expect((await h.audits("NOTE_DELETE"))[0]).toMatchObject({ memberId: 1, detail: `note ${mine}` });
    expect(JSON.stringify(await h.db.prepare("SELECT * FROM audit_log").all())).not.toContain("The owner note");
  });

  it("the About note is one per person, edited in place, and deleted when emptied", async () => {
    const about = async (text: string, as = OWNER) => h.post(`/app/notes/${conv}/about`, { csrf: await h.tokenFor(as, `notes-about:${conv}`), text }, as);
    expect((await about("Mother of two; prefers evenings")).status).toBe(303);
    expect((await about("Mother of two; prefers evenings after 5", PRAC)).status).toBe(303);
    const rows = await notesRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "ABOUT", kind: null, body: "Mother of two; prefers evenings after 5", author: 2 });
    expect(await (await h.get(`/app/people/${conv}`)).text()).toContain("Mother of two; prefers evenings after 5");
    expect((await about("", PRAC)).status).toBe(303);
    expect(await notesRows()).toEqual([]);
    expect((await about("x", STAFF)).status).toBe(403);
    expect((await h.audits("NOTE_ADD")).length + (await h.audits("NOTE_EDIT")).length + (await h.audits("NOTE_DELETE")).length).toBe(3);
  });
});

describe("where notes show", () => {
  it("Today: the next call shows its Before notes and the last booking's After notes, and Add note; staff see neither", async () => {
    await add(conv, { text: "Ask how the sleep has been", booking: `CALL-${call}`, phase: "BEFORE" });
    await add(conv, { text: "Suggested a session next week", booking: `CALL-${pastCall}`, phase: "AFTER" });
    await add(conv, { text: "Old before note", booking: `CALL-${pastCall}`, phase: "BEFORE" });
    for (const who of [OWNER, PRAC]) {
      const page = await (await h.get("/app", who)).text();
      const hero = page.slice(page.indexOf('<div class="hero">'), page.indexOf("</div></div>", page.indexOf('class="nts tnotes"')));
      expect(hero, who).toContain("Notes for this call");
      expect(hero, who).toContain("Ask how the sleep has been");
      expect(hero, who).toContain("After their last booking (₹99 call, Wed, 28 Oct)");
      expect(hero, who).toContain("Suggested a session next week");
      expect(hero, who).not.toContain("Old before note");
      expect(page, who).toContain(`action="/app/notes/${conv}/add"`);
      expect(page, who).toContain(`<input type="hidden" name="booking" value="CALL-${call}">`);
      expect(page, who).toContain('<input type="radio" name="phase" value="BEFORE" checked>');
    }
    const staff = await (await h.get("/app", STAFF)).text();
    expect(staff).not.toContain("Ask how the sleep has been");
    expect(staff).not.toContain("/app/notes/");
    // Add note from Today comes back to the card with its status line.
    const res = await add(conv, { text: "From Today", booking: `CALL-${call}`, back: `/app#b-intro-${call}` }, PRAC);
    expect(res.headers.get("Location")).toBe(`/app?n=saved&nb=CALL-${call}#b-intro-${call}`);
    expect(await (await h.get(`/app?n=saved&nb=CALL-${call}`, PRAC)).text()).toContain("Note saved.");
  });

  it("the Inbox thread links to them with a count, for the owner only; the Calendar opens the booking's notes", async () => {
    await h.db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE id = ?1").bind(conv, iso(NOW - 20 * MIN)).run();
    await add(conv, { text: "one" });
    await add(conv, { text: "two" });
    await add(conv, { text: "three" });
    const owner = await (await h.get(`/app/inbox/${conv}`)).text();
    expect(owner).toContain(`<a class="tap" href="/app/people/${conv}#notes">Notes (3)</a>`);
    expect(owner).not.toContain("three");
    const staff = await (await h.get(`/app/inbox/${conv}`, STAFF)).text();
    expect(staff).not.toContain("#notes");
    const cal = await (await h.get("/app/calendar?view=day&d=2026-11-04")).text();
    expect(cal).toContain(`href="/app/people/${conv}?b=CALL-${call}#notes"`);
  });

  it("Hindi console", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE id = 2").run();
    await add(conv, { text: "नोट", booking: `CALL-${call}` }, PRAC);
    const page = await (await h.get(`/app/people/${conv}`, PRAC)).text();
    expect(page).toContain("नोट्स");
    expect(page).toContain("नया नोट");
    expect(page).toContain("इनके बारे में");
    expect(page).toMatch(/<p class="ph">पहले<\/p>/);
  });
});

describe("keeping and deleting", () => {
  it("survive the 7-day chat wipe, are deleted by Remove their data, and are never in the export", async () => {
    await add(conv, { text: "Secret health detail: migraines", booking: `CALL-${call}` });
    await h.post(`/app/notes/${conv}/about`, { csrf: await h.tokenFor(OWNER, `notes-about:${conv}`), text: "About text kept" });
    const file = JSON.stringify((await buildExport(h.env(), 7, NOW)).file);
    expect(file).toContain("I can't sleep well"); // the chat is there,
    expect(file).not.toContain("migraines"); // the notes never
    expect(file).not.toContain("About text kept");
    // The chat text is wiped 7 days after the last message; the notes stay.
    await wipeChats(h.env(), NOW + 8 * 86_400_000);
    expect(await h.count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND body IS NOT NULL", conv)).toBe(0);
    expect((await notesRows()).length).toBe(2);
    // Remove their data: the notes go too.
    const res = await h.post(`/app/people/${conv}/remove-data`, { csrf: await h.tokenFor(OWNER, `people-remove:${conv}`), reason: "They asked by phone" });
    expect(res.status).toBe(303);
    expect(await notesRows()).toEqual([]);
    expect((await h.audits("PERSON_DATA_REMOVED"))[0].detail).toBe("name, message text, notes and gist");
    expect(anthropic).toEqual([]); // nothing went to the AI
    void ORIGIN;
  });
});
