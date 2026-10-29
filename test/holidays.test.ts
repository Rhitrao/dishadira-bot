// Ticket 30: marking and removing holidays on /amma, /admin (live today: CONSOLE_V2 "false") and /app Calendar (roles), with the
// audit rows, the warning when bookings are already on the day, and refusals. All data is synthetic; Access, WhatsApp and Razorpay are fakes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env"; // first: it loads the Worker
import { csrf } from "../src/auth";
import { availableSlots } from "../src/slots";

// Thu 29 Oct 2026, 1:30 pm in Bengaluru. Sat 7 Nov is nine days ahead; the last day that may be marked is Mon 28 Dec.
const NOW = Date.parse("2026-10-29T08:00:00Z");
const SAT = "2026-11-07";
const h = new ConsoleHarness();
const decode = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
const plain = (s: string) => s.replace(/<[^>]+>/g, "");
const text = async (path: string, as = OWNER) => {
  const res = await h.get(path, as);
  expect(res.status, path).toBe(200);
  return decode(await res.text());
};
const isHoliday = async (ymd: string) => (await h.setting(`holiday:${ymd}`)) !== null;
const oldToken = async (email: string, scope: string) => csrf(await h.jwtFor(email), scope); // /amma and /admin: no member in the scope

// A paid call at an IST time ("2026-11-07T15:00").
let wa = 919800007000;
async function paidCall(ist: string, name: string) {
  const start = Date.parse(`${ist}:00+05:30`);
  const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  const conv = (await h.db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES (?1, ?2)").bind(String(++wa), name).run()).meta.last_row_id;
  const pid = (await h.member(PRAC))!.id;
  const slot = (await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED', ?4)").bind(utc(start), utc(start + 15 * 60_000), conv, pid).run()).meta.last_row_id;
  await h.db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'HEALING', 'PAID', ?3)").bind(conv, slot, pid).run();
  return conv;
}

beforeEach(async () => {
  await h.start(NOW);
});
afterEach(async () => {
  await h.stop();
});

describe("/amma (the practitioner's page on live)", () => {
  beforeEach(() => {
    h.vars.CONSOLE_V2 = "false";
  });

  it("shows the form (a date from today to 60 days ahead, no note: this page has no free text) and the empty list", async () => {
    const page = await text("/amma", PRAC);
    expect(page).toContain("Days off");
    expect(page).toContain('<form method="post" action="/amma/holiday">');
    expect(page).toContain('type="date" name="day" min="2026-10-29" max="2026-12-28" required');
    expect(page).not.toContain('name="note"');
    expect(page).toContain("No holidays marked.");
  });

  it("marks a day (audited with who did it), shows it with Remove, and removing it opens the day again", async () => {
    const res = await h.post("/amma/holiday", { day: SAT, csrf: await oldToken(PRAC, "holiday:add") }, PRAC);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/amma?h=added&d=${SAT}`);
    expect(await isHoliday(SAT)).toBe(true);
    expect(await h.audits("HOLIDAY_ADDED")).toEqual([{ actor: PRAC, memberId: null, target: `holiday:${SAT}`, detail: "0 booked that day" }]);
    expect(await availableSlots(h.db, "CALL", SAT, NOW)).toEqual([]); // the bot offers nothing that day
    const page = await text(`/amma?h=added&d=${SAT}`, PRAC);
    expect(page).toContain("Sat, 7 Nov is marked as a holiday. The bot won't offer it.");
    expect(page).toContain('action="/amma/holiday/remove"');
    // Twice is still once.
    await h.post("/amma/holiday", { day: SAT, csrf: await oldToken(PRAC, "holiday:add") }, PRAC);
    expect(await h.audits("HOLIDAY_ADDED")).toHaveLength(1);

    const off = await h.post("/amma/holiday/remove", { day: SAT, csrf: await oldToken(PRAC, `holiday:remove:${SAT}`) }, PRAC);
    expect(off.headers.get("Location")).toBe(`/amma?h=removed&d=${SAT}`);
    expect(await isHoliday(SAT)).toBe(false);
    expect(await h.audits("HOLIDAY_REMOVED")).toHaveLength(1);
    expect(await availableSlots(h.db, "CALL", SAT, NOW)).toHaveLength(20);
    expect(await text(`/amma?h=removed&d=${SAT}`, PRAC)).toContain("Sat, 7 Nov is open for bookings again.");
  });

  it("bookings already on the day stay booked: a warning lists them, a Needs-you item is raised, nobody is messaged", async () => {
    await paidCall(`${SAT}T15:00`, "Ravi Test");
    await paidCall(`${SAT}T16:30`, "Asha Test");
    await h.post("/amma/holiday", { day: SAT, csrf: await oldToken(PRAC, "holiday:add") }, PRAC);
    const page = plain(await text("/amma", PRAC));
    expect(page).toContain("2 bookings on Sat, 7 Nov. They stay booked: ask the team to move them.");
    expect(page).toContain("3:00pm Ravi");
    expect(page).toContain("4:30pm Asha");
    expect(await h.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'HOLIDAY_BOOKINGS' AND target = ?1 AND resolved_at IS NULL", `holiday:${SAT}`)).toBe(1);
    expect(await h.count("SELECT COUNT(*) AS n FROM intros WHERE state = 'PAID'")).toBe(2);
    expect(await h.count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect((await h.audits("HOLIDAY_ADDED"))[0].detail).toBe("2 booked that day");
    // Removing the holiday closes the item.
    await h.post("/amma/holiday/remove", { day: SAT, csrf: await oldToken(PRAC, `holiday:remove:${SAT}`) }, PRAC);
    expect(await h.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'HOLIDAY_BOOKINGS' AND resolved_at IS NULL")).toBe(0);
  });

  it("refuses past days, days too far ahead and bad dates; a wrong token or a missing Origin changes nothing", async () => {
    const tok = await oldToken(PRAC, "holiday:add");
    for (const day of ["2026-10-28", "2026-12-29", "2026-02-30", "tomorrow", ""]) {
      const res = await h.post("/amma/holiday", { day, csrf: tok }, PRAC);
      expect(res.headers.get("Location"), day).toBe("/amma?h=bad");
    }
    expect(await text("/amma?h=bad", PRAC)).toContain("Choose a date from today to 60 days ahead.");
    expect((await h.post("/amma/holiday", { day: SAT, csrf: "nope" }, PRAC)).status).toBe(403);
    expect((await h.post("/amma/holiday", { day: SAT, csrf: tok }, PRAC, { origin: null })).status).toBe(403);
    expect((await h.post("/amma/holiday", { day: SAT, csrf: await oldToken(OWNER, "holiday:add") }, PRAC)).status).toBe(403); // someone else's token
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'holiday:%'")).toBe(0);
    expect(await h.count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'HOLIDAY_%'")).toBe(0);
  });

  it("today itself may be marked", async () => {
    await h.post("/amma/holiday", { day: "2026-10-29", csrf: await oldToken(PRAC, "holiday:add") }, PRAC);
    expect(await isHoliday("2026-10-29")).toBe(true);
  });
});

describe("/admin (the owner's page on live)", () => {
  beforeEach(() => {
    h.vars.CONSOLE_V2 = "false";
  });

  it("marks a day with a note the owner sees (never customers), lists the bookings with links, and raises the item on Home", async () => {
    const ravi = await paidCall(`${SAT}T15:00`, "Ravi Test");
    const page0 = await text("/admin");
    expect(page0).toContain('id="days-off"');
    expect(page0).toContain('name="note"');
    const res = await h.post("/admin/holiday", { day: SAT, note: "family function", csrf: await oldToken(OWNER, "holiday:add") });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin?m=holiday&d=${SAT}#days-off`);
    expect(await h.setting(`holiday:${SAT}`)).toBe("family function");
    expect(await h.audits("HOLIDAY_ADDED")).toEqual([{ actor: OWNER, memberId: null, target: `holiday:${SAT}`, detail: "1 booked that day; note: family function" }]);
    const page = await text(`/admin?m=holiday&d=${SAT}`);
    expect(page).toContain("Sat, 7 Nov is marked as a holiday. The bot won't offer it.");
    expect(page).toContain("family function");
    expect(page).toContain("1 booking on Sat, 7 Nov: move it from the person page.");
    expect(page).toContain(`href="/admin/conv/${ravi}"`);
    expect(page).toContain("Bookings on a holiday"); // the Needs-you item
    expect(page).toContain('action="/admin/holiday-remove"');

    const off = await h.post("/admin/holiday-remove", { day: SAT, csrf: await oldToken(OWNER, `holiday:remove:${SAT}`) });
    expect(off.headers.get("Location")).toBe(`/admin?m=holidayoff&d=${SAT}#days-off`);
    expect(await isHoliday(SAT)).toBe(false);
    expect(await h.audits("HOLIDAY_REMOVED")).toHaveLength(1);
    expect(await text("/admin")).not.toContain("Bookings on a holiday");
  });

  it("only the owner reaches it; refuses past dates and wrong tokens", async () => {
    expect((await h.post("/admin/holiday", { day: SAT, csrf: await oldToken(PRAC, "holiday:add") }, PRAC)).status).toBe(403);
    const res = await h.post("/admin/holiday", { day: "2026-10-01", csrf: await oldToken(OWNER, "holiday:add") });
    expect(res.headers.get("Location")).toBe("/admin?m=holidaybad");
    expect(await text("/admin?m=holidaybad")).toContain("Choose a date from today to 60 days ahead.");
    expect((await h.post("/admin/holiday-remove", { day: SAT, csrf: "x" })).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'holiday:%'")).toBe(0);
  });
});

describe("/app Calendar (after the switch-over)", () => {
  it("owner: marks a day with a note; the week shows it as Holiday with no free times; audited with the member and the note", async () => {
    const res = await h.post("/app/calendar/holiday", { day: SAT, note: "family function", csrf: await h.tokenFor(OWNER, "holiday:add") });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/calendar?view=week&d=${SAT}&hd=${SAT}&m=holiday#days-off`);
    const owner = (await h.member(OWNER))!.id;
    expect(await h.audits("HOLIDAY_ADDED")).toEqual([{ actor: OWNER, memberId: owner, target: `holiday:${SAT}`, detail: "0 booked that day" }]);
    expect(await h.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'HOLIDAY_ADDED' AND reason = 'family function'")).toBe(1);
    const week = await text(`/app/calendar?view=week&d=${SAT}&hd=${SAT}&m=holiday`);
    expect(week).toContain("Sat, 7 Nov is marked as a holiday. The bot won't offer it.");
    expect(week).toMatch(/Sat, 7 Nov<\/a> <span class="chip plain">Holiday<\/span>/);
    expect(week).toContain("Holiday: no new bookings on this day.");
    expect(week).toContain("family function"); // the owner sees the note
    const day = plain(await text(`/app/calendar?view=day&d=${SAT}`));
    expect(day).toContain("Holiday: no new bookings on this day.");
    expect(day).not.toContain("Free:");
  });

  it("a holiday with a booking: the day keeps the booking and the list warns, with a link to the person", async () => {
    const ravi = await paidCall(`${SAT}T15:00`, "Ravi Test");
    await h.post("/app/calendar/holiday", { day: SAT, csrf: await h.tokenFor(OWNER, "holiday:add") });
    const week = await text(`/app/calendar?view=week&d=${SAT}`);
    expect(week).toMatch(/<span class="chip attention">Holiday<\/span>/);
    expect(week).toContain("1 booking on Sat, 7 Nov: move it from the person page.");
    expect(week).toContain(`href="/app/people/${ravi}"`);
    expect(await h.count("SELECT COUNT(*) AS n FROM attention WHERE kind = 'HOLIDAY_BOOKINGS'")).toBe(1);
  });

  it("practitioner: may mark and remove (no note field); staff: sees Holiday, no form, and a hand-made POST is refused", async () => {
    const page = await text("/app/calendar", PRAC);
    expect(page).toContain('action="/app/calendar/holiday"');
    expect(page).not.toContain('name="note"');
    await h.post("/app/calendar/holiday", { day: SAT, note: "ignored", csrf: await h.tokenFor(PRAC, "holiday:add") }, PRAC);
    expect(await h.setting(`holiday:${SAT}`)).toBe(""); // a practitioner's form has no note
    expect((await h.audits("HOLIDAY_ADDED"))[0].memberId).toBe((await h.member(PRAC))!.id);

    const staff = await text(`/app/calendar?view=week&d=${SAT}`, STAFF);
    expect(staff).toContain("Holiday");
    expect(staff).not.toContain('action="/app/calendar/holiday"');
    expect(staff).not.toContain('action="/app/calendar/holiday/remove"');
    const refused = await h.post("/app/calendar/holiday", { day: "2026-11-09", csrf: await h.tokenFor(STAFF, "holiday:add") }, STAFF);
    expect(refused.status).toBe(403);
    expect((await h.post("/app/calendar/holiday/remove", { day: SAT, csrf: await h.tokenFor(STAFF, `holiday:remove:${SAT}`) }, STAFF)).status).toBe(403);
    expect(await isHoliday("2026-11-09")).toBe(false);
    expect(await isHoliday(SAT)).toBe(true);

    await h.post("/app/calendar/holiday/remove", { day: SAT, csrf: await h.tokenFor(PRAC, `holiday:remove:${SAT}`) }, PRAC);
    expect(await isHoliday(SAT)).toBe(false);
    expect(await h.audits("HOLIDAY_REMOVED")).toHaveLength(1);
  });

  it("refuses a past date and another member's token; Hindi words for a Hindi member", async () => {
    const bad = await h.post("/app/calendar/holiday", { day: "2026-10-28", csrf: await h.tokenFor(OWNER, "holiday:add") });
    expect(bad.headers.get("Location")).toBe("/app/calendar?view=week&m=holidaybad#days-off");
    expect(await text("/app/calendar?view=week&m=holidaybad")).toContain("Choose a date from today to 60 days ahead.");
    expect((await h.post("/app/calendar/holiday", { day: SAT, csrf: await h.tokenFor(PRAC, "holiday:add") })).status).toBe(403);
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'holiday:%'")).toBe(0);
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    await h.post("/app/calendar/holiday", { day: SAT, csrf: await h.tokenFor(PRAC, "holiday:add") }, PRAC);
    const hi = await text(`/app/calendar?view=week&d=${SAT}`, PRAC);
    expect(hi).toContain("छुट्टी");
    expect(hi).toContain("छुट्टी तय करें");
  });
});
