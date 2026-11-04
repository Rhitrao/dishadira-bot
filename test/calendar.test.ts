// Ticket 27: the Calendar (/app/calendar). All data is synthetic; Access, WhatsApp and Razorpay are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env"; // first: it loads the Worker, which loads the calendar
import { addDays, freeRanges, weekStart } from "../src/calendar";

// Wed 28 Oct 2026, 1:30 pm in Bengaluru: the week runs Mon 26 Oct to Sun 1 Nov.
const NOW = Date.parse("2026-10-28T08:00:00Z");
const PRAC2 = "second-practitioner@example.test";
const h = new ConsoleHarness();
const decode = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
const page = async (path: string, as = OWNER) => {
  const res = await h.get(path, as);
  expect(res.status, path).toBe(200);
  return decode(await res.text());
};
const plain = (s: string) => s.replace(/<[^>]+>/g, "");
const id = async (email: string) => (await h.member(email))!.id;

// A paid call (or a held one) at an IST time, on a practitioner's calendar.
async function call(o: { name: string; wa: string; ist: string; prac: number; state?: "PAID" | "HELD"; holdMin?: number }) {
  const db = h.db;
  const start = Date.parse(`${o.ist}:00+05:30`);
  const conv = (await db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES (?1, ?2)").bind(o.wa, o.name).run()).meta.last_row_id;
  const held = o.state === "HELD";
  const holdUntil = held ? new Date(NOW + (o.holdMin ?? 15) * 60_000).toISOString().slice(0, 19) + "Z" : null;
  const slot = (
    await db
      .prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(new Date(start).toISOString().slice(0, 19) + "Z", new Date(start + 15 * 60_000).toISOString().slice(0, 19) + "Z", conv, held ? "HELD" : "BOOKED", holdUntil, o.prac)
      .run()
  ).meta.last_row_id;
  await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'HEALING', ?3, ?4)").bind(conv, slot, o.state ?? "PAID", o.prac).run();
  return conv;
}

beforeEach(async () => {
  await h.start(NOW);
});
afterEach(async () => {
  await h.stop();
});

describe("the calendar's days", () => {
  it("weeks start on Monday; free times are the generator's slots less what is booked, after now", () => {
    expect(weekStart("2026-10-28")).toBe("2026-10-26");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    const busy = [{ startUtc: "2026-10-29T09:00:00Z", endUtc: "2026-10-29T10:00:00Z" }]; // Thu 2:30-3:30 pm, a session
    const free = freeRanges("2026-10-29", busy, NOW);
    expect(free).toEqual([
      { from: "2026-10-29T08:30:00Z", to: "2026-10-29T09:00:00Z" },
      { from: "2026-10-29T10:00:00Z", to: "2026-10-29T13:30:00Z" },
    ]);
    expect(freeRanges("2026-10-31", [], NOW)).toEqual([{ from: "2026-10-31T08:30:00Z", to: "2026-10-31T13:30:00Z" }]); // Saturday is a working day (ticket 30)
    expect(freeRanges("2026-11-01", [], NOW)).toEqual([]); // Sunday
    expect(freeRanges("2026-10-28", [], Date.parse("2026-10-28T13:30:00Z"))).toEqual([]); // today, after 7 pm
  });
});

describe("week and day views", () => {
  it("this week by default: every day in order, bookings in time order with a link to the person, free times and the hours", async () => {
    const p = await id(PRAC);
    const late = await call({ name: "Meera Long-Surname-Example", wa: "919800004321", ist: "2026-10-29T16:00", prac: p });
    const early = await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    const body = await page("/app/calendar");
    expect(body).toContain("When am I booked or free?");
    for (const d of ["Mon, 26 Oct", "Tue, 27 Oct", "Wed, 28 Oct", "Thu, 29 Oct", "Fri, 30 Oct", "Sat, 31 Oct", "Sun, 1 Nov"]) expect(body).toContain(d);
    expect(body.indexOf("Ravi")).toBeLessThan(body.indexOf("Meera"));
    // Ticket 46: the grid's blocks keep the last 4; the agenda has the full number as a tel: link for the owner (staff: last 4 only).
    expect(body).toContain("…1234");
    expect(body).toContain("+91 98000 01234");
    expect(body).toContain('href="tel:+919800001234"');
    const staff = await page("/app/calendar", STAFF);
    expect(staff).toContain("…1234");
    expect(staff).not.toContain("919800001234");
    expect(staff).not.toContain("98000 01234");
    expect(body).toContain(`href="/app/people/${early}"`);
    expect(body).toContain(`href="/app/people/${late}"`);
    expect(body).toContain("15-minute call");
    expect(body).not.toContain("Confirmed"); // ticket 46: a booking's status shows only when it isn't confirmed
    expect(plain(body)).toContain("Free: 2:00 pm – 2:30 pm · 2:45 pm – 4:00 pm · 4:15 pm – 7:00 pm"); // Thursday
    expect(body).toContain("Calls are Monday to Saturday, 2 pm to 7 pm (India time).");
    expect(body).not.toContain("later release"); // ticket 46: no developer's notes on the page
    expect(body).toContain('href="/app/calendar?view=week&d=2026-10-19"'); // previous week
    expect(body).toContain('href="/app/calendar?view=week&d=2026-11-02"'); // next week
    expect(body).toContain('href="/app/calendar?view=day&d=2026-10-29"'); // each day opens its Day view
    // The console's frame and look, not the old one.
    expect(body).toContain('<nav class="rail"');
    expect(body).toContain('font-family:"Jost"');
    expect(body).not.toContain('<nav class="tabs"');
  });

  it("the Day view shows one day, with previous and next day links", async () => {
    const p = await id(PRAC);
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    await call({ name: "Asha Test", wa: "919800005678", ist: "2026-10-30T15:00", prac: p });
    const body = await page("/app/calendar?view=day&d=2026-10-29");
    expect(body).toContain("Ravi");
    expect(body).not.toContain("Asha");
    expect(body).not.toContain("Fri, 30 Oct</a>");
    expect(body).toContain('href="/app/calendar?view=day&d=2026-10-28"');
    expect(body).toContain('href="/app/calendar?view=day&d=2026-10-30"');
    expect(body).toContain("Open 2:00 pm – 7:00 pm");
    expect(body).toContain('aria-current="page">Day</a>');
  });

  it("a live hold shows as held, with when it lapses; a lapsed hold frees the time", async () => {
    const p = await id(PRAC);
    await call({ name: "Hema Hold", wa: "919800002222", ist: "2026-10-28T15:00", prac: p, state: "HELD", holdMin: 15 });
    await call({ name: "Gone Hold", wa: "919800003333", ist: "2026-10-28T16:00", prac: p, state: "HELD", holdMin: -5 });
    const body = await page("/app/calendar?view=day&d=2026-10-28");
    expect(body).toContain("Hema");
    expect(body).toContain("Held");
    expect(body).toContain("Waiting for payment until 1:45 pm");
    expect(body).not.toContain("Gone");
    expect(plain(body)).toContain("Free: 2:00 pm – 3:00 pm · 3:15 pm – 7:00 pm");
  });

  it("Sunday says plainly that it isn't a working day; Saturday is one (ticket 30)", async () => {
    const week = await page("/app/calendar");
    expect(week).toMatch(/Sun, 1 Nov<\/b><span>Closed/);
    expect(week).not.toMatch(/Sat, 31 Oct<\/b><span>Closed/);
    expect(week).toMatch(/<a class="tg-dh slim" href="\/app\/calendar\?view=day&d=2026-11-01" aria-label="Sun, 1 Nov, Closed">/); // a slim column in the grid
    expect(week).not.toContain("Not a working day"); // not in every closed cell
    const sun = await page("/app/calendar?view=day&d=2026-11-01");
    expect(sun).toContain("Not a working day");
    expect(sun).not.toContain("Free:");
    const sat = await page("/app/calendar?view=day&d=2026-10-31");
    expect(plain(sat)).toContain("Free: 2:00 pm – 7:00 pm");
    expect(sat).toContain("Open 2:00 pm – 7:00 pm");
  });

  it("an empty week says so and names the next booking", async () => {
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-11-05T14:30", prac: await id(PRAC) });
    const body = await page("/app/calendar");
    expect(body).toContain("Nothing booked this week. Next booking: Thu, 5 Nov, 2:30 pm.");
    expect(body).toContain('href="/app/calendar?view=day&d=2026-11-05"');
    const none = await page("/app/calendar?view=week&d=2026-11-16");
    expect(none).toContain("Nothing booked this week, and nothing after it yet.");
  });

  it("a bad date falls back to this week", async () => {
    expect(await page("/app/calendar?d=2026-13-45")).toContain("Wed, 28 Oct");
  });
});

// A confirmed session (60 minutes) at an IST time.
async function session(o: { name: string; wa: string; ist: string; prac: number }) {
  const db = h.db;
  const start = Date.parse(`${o.ist}:00+05:30`);
  const conv = (await db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES (?1, ?2)").bind(o.wa, o.name).run()).meta.last_row_id;
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  const slot = (await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED', ?4)").bind(at(start), at(start + 3_600_000), conv, o.prac).run()).meta.last_row_id;
  await db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, practitioner_id) VALUES (?1, ?2, 'HEALING', 'CONFIRMED', 'AMMA', ?3)").bind(conv, slot, o.prac).run();
  return conv;
}
// The month grid's cell for a day: its link and what it says.
const cell = (body: string, ymd: string) => new RegExp(`<a class="([^"]*)" href="/app/calendar\\?view=day&d=${ymd}[^"]*" aria-label="([^"]*)"`).exec(body);

describe("the month view (ticket 39)", () => {
  it("a Monday-to-Sunday grid of every week touching the month: counts and kinds per day, today, past days, holidays, closed Sundays", async () => {
    const p = await id(PRAC);
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    await call({ name: "Asha Test", wa: "919800005678", ist: "2026-10-29T16:00", prac: p });
    await session({ name: "Meera Test", wa: "919800004321", ist: "2026-10-29T17:00", prac: p });
    await call({ name: "Early Test", wa: "919800007777", ist: "2026-10-05T15:00", prac: p });
    await call({ name: "Hema Hold", wa: "919800002222", ist: "2026-10-30T15:00", prac: p, state: "HELD", holdMin: 15 });
    await h.db.prepare("INSERT INTO settings (key, value) VALUES ('holiday:2026-10-31', '')").run();
    const body = await page("/app/calendar?view=month&d=2026-10-28");
    expect(body).toContain('aria-current="page">Month</a>');
    expect(body).toContain('<p class="range">October 2026</p>');
    expect(body).toContain("<th scope=\"col\">Mon</th>");
    expect(body.indexOf(">Mon</th>")).toBeLessThan(body.indexOf(">Sun</th>"));
    // Every week that touches October: Mon 28 Sep to Sun 1 Nov, 5 rows of 7.
    expect((body.match(/<tr><td>/g) ?? []).length).toBe(5);
    expect(cell(body, "2026-09-28")?.[1]).toContain("out");
    expect(cell(body, "2026-11-01")).not.toBeNull();
    expect(body).not.toContain("d=2026-11-02");
    // Counts and kinds, in words for screen readers (the dots are decoration).
    expect(cell(body, "2026-10-29")?.[2]).toBe("Thu, 29 Oct, 3 booked (2 calls · 1 session)");
    expect(cell(body, "2026-10-30")?.[2]).toBe("Fri, 30 Oct, 1 booked (1 call)"); // a live hold counts, as in the Week view
    expect(cell(body, "2026-10-05")?.[1]).toContain("past");
    expect(cell(body, "2026-10-05")?.[2]).toBe("Mon, 5 Oct, 1 booked (1 call)");
    expect(cell(body, "2026-10-06")?.[2]).toBe("Tue, 6 Oct, Nothing booked");
    expect(cell(body, "2026-10-28")?.[1]).toContain("today");
    expect(body).toMatch(/d=2026-10-28" aria-label="[^"]*" aria-current="date"/);
    expect(cell(body, "2026-10-31")?.[1]).toContain("holi");
    expect(cell(body, "2026-10-31")?.[2]).toBe("Sat, 31 Oct, Nothing booked, Holiday");
    expect(cell(body, "2026-10-25")?.[1]).toContain("closed");
    expect(cell(body, "2026-10-25")?.[2]).toBe("Sun, 25 Oct, Nothing booked, Closed");
    expect(body).not.toContain("Not a working day"); // closed days are muted, not labelled
    // Ticket 46: up to three bookings per day as chips (time, first name, kind), then "+N more"; a bar for how full the day is.
    const thu = body.slice(body.indexOf('d=2026-10-29" aria-label'), body.indexOf("</td>", body.indexOf('d=2026-10-29" aria-label')));
    expect(plain(thu)).toContain("2:30 Ravi · Call4:00 Asha · Call5:00 Meera · Session");
    expect(thu).toContain('<span class="mc session">');
    expect(thu).toMatch(/class="mbar" style="--b:\d+%"/);
    expect(thu).not.toContain("more");
    const fri = body.slice(body.indexOf('d=2026-10-30" aria-label'), body.indexOf("</td>", body.indexOf('d=2026-10-30" aria-label')));
    expect(fri).toContain('<span class="mc call held">'); // a hold, drawn dashed
    expect(cell(body, "2026-10-06")?.[0]).not.toContain("mbar");
  });

  it("‹ › go a month at a time, Today comes back, and the views keep the day", async () => {
    const oct = await page("/app/calendar?view=month&d=2026-10-28");
    expect(oct).toContain('href="/app/calendar?view=month&d=2026-09-01" aria-label="Previous month"');
    expect(oct).toContain('href="/app/calendar?view=month&d=2026-11-01" aria-label="Next month"');
    expect(oct).toContain('href="/app/calendar?view=week&d=2026-10-28"'); // this month shows today: Week opens on today
    const jan = await page("/app/calendar?view=month&d=2027-01-15");
    expect(jan).toContain('<p class="range">January 2027</p>');
    expect(jan).toContain('href="/app/calendar?view=month&d=2026-12-01"');
    expect(jan).toContain('href="/app/calendar?view=month&d=2027-02-01"');
    expect(jan).toContain('href="/app/calendar?view=month&d=2026-10-28"'); // Today
    expect(jan).toContain('href="/app/calendar?view=day&d=2027-01-01"'); // Day opens on the 1st
    expect(jan).toContain("Nothing booked this month, and nothing after it yet.");
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2027-02-03T14:30", prac: await id(PRAC) });
    expect(await page("/app/calendar?view=month&d=2027-01-15")).toContain("Nothing booked this month. Next booking: Wed, 3 Feb, 2:30 pm.");
    // The Day and Week views link to the Month.
    expect(await page("/app/calendar?view=day&d=2026-10-29")).toContain('href="/app/calendar?view=month&d=2026-10-29"');
  });

  it("the practitioner filter: a practitioner counts only their own; owner and staff everyone's, or one practitioner's", async () => {
    const p1 = await id(PRAC);
    await call({ name: "Ravi Mine", wa: "919800001234", ist: "2026-10-29T14:30", prac: p1 });
    await h.db.prepare("INSERT INTO members (workspace_id, email, role, status, display_name) VALUES (1, ?1, 'PRACTITIONER', 'active', 'Second')").bind(PRAC2).run();
    const p2 = await id(PRAC2);
    await call({ name: "Sita Theirs", wa: "919800005678", ist: "2026-10-29T15:00", prac: p2 });
    const m = "/app/calendar?view=month&d=2026-10-28";
    expect(cell(await page(m, PRAC), "2026-10-29")?.[2]).toBe("Thu, 29 Oct, 1 booked (1 call)");
    expect(cell(await page(`${m}&p=${p2}`, PRAC), "2026-10-29")?.[2]).toBe("Thu, 29 Oct, 1 booked (1 call)"); // can't widen it
    for (const who of [OWNER, STAFF]) {
      const all = await page(m, who);
      expect(cell(all, "2026-10-29")?.[2]).toBe("Thu, 29 Oct, 2 booked (2 calls)");
      expect(all).toContain(`href="/app/calendar?view=month&d=2026-10-28&p=${p2}"`);
      const one = await page(`${m}&p=${p2}`, who);
      expect(cell(one, "2026-10-29")?.[2]).toBe("Thu, 29 Oct, 1 booked (1 call)");
      expect(one).toContain(`href="/app/calendar?view=day&d=2026-10-29&p=${p2}"`); // a day keeps the filter
    }
  });

  it("Hindi: the month's name, the weekdays and the words", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    const body = await page("/app/calendar?view=month&d=2026-10-28", PRAC);
    expect(body).toContain('<p class="range">अक्टूबर 2026</p>');
    expect(body).toContain(">सोम</th>");
    expect(body).toContain(">महीना</a>");
  });
});

describe("the week grid and the list (ticket 46)", () => {
  it("the week grid: a gutter of hours, one column per day, blocks placed by start and sized by length, kind and status shown", async () => {
    const p = await id(PRAC);
    const ravi = await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    await session({ name: "Meera Test", wa: "919800004321", ist: "2026-10-29T16:00", prac: p });
    await call({ name: "Hema Hold", wa: "919800002222", ist: "2026-10-30T15:00", prac: p, state: "HELD", holdMin: 15 });
    const body = await page("/app/calendar");
    expect(body).toContain('<div class="tg" style="--cols:52px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 40px;--hh:54px">');
    for (const hr of ["2 pm", "3 pm", "6 pm"]) expect(body).toContain(`px">${hr}</span>`);
    expect(body).not.toContain('px">7 pm</span>'); // closing is the grid's foot
    // 2:30 pm is 30 minutes after opening at 1.8 px a minute; a 15-minute call is 25 px tall, a 60-minute session 106 px.
    expect(body).toMatch(new RegExp(`<a class="ev2 call" href="/app/people/${ravi}" style="top:54.0px;height:25.0px;left:calc\\(0.00% \\+ 3px\\);width:calc\\(100.00% - 6px\\)" title="2:30 pm – 2:45 pm · Ravi …1234`));
    expect(body).toMatch(/<a class="ev2 session" href="[^"]+" style="top:216.0px;height:106.0px;/);
    expect(body).toMatch(/<a class="ev2 call held" [^>]*title="3:00 pm – 3:15 pm · Hema …2222[^"]*Held"/);
    // Compact day headers with a count, today's marked.
    expect(body).toMatch(/<a class="tg-dh today" href="\/app\/calendar\?view=day&d=2026-10-28" aria-label="Wed, 28 Oct, Nothing booked, [^"]+" aria-current="date"><span class="dw">Wed<\/span><span class="dl"><span class="dd">28<\/span><\/span>/);
    expect(body).toMatch(/<span class="dw">Thu<\/span><span class="dl"><span class="dd">29<\/span><span class="dn">2<\/span><\/span>/);
  });

  it("List: the next 30 days of bookings grouped by day, with a one-tap Call, ‹ › 30 days at a time", async () => {
    const p = await id(PRAC);
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    await call({ name: "Late Test", wa: "919800009999", ist: "2026-11-30T14:30", prac: p }); // beyond the 30 days
    const body = await page("/app/calendar?view=list");
    expect(body).toContain('aria-current="page">List</a>');
    expect(body).toContain('<p class="range">28 Oct – 26 Nov</p>');
    expect(body).toContain("Thu, 29 Oct</a>");
    expect(body).toContain("Ravi");
    expect(body).not.toContain("Late");
    expect(body).not.toContain("Fri, 30 Oct</a>"); // a day with nothing booked is left out
    expect(body).toContain('<a class="btn call secondary" href="tel:+919800001234">');
    expect(body).toContain('href="/app/calendar?view=list&d=2026-11-27" aria-label="Next 30 days"');
    expect(body).toContain('href="/app/calendar?view=list&d=2026-09-28" aria-label="Earlier 30 days"');
    const later = await page("/app/calendar?view=list&d=2026-11-27");
    expect(later).toContain("Late");
    const none = await page("/app/calendar?view=list&d=2027-03-01");
    expect(none).toContain("Nothing booked in these 30 days.");
    // A practitioner sees her own customers' numbers; staff the last 4.
    expect(await page("/app/calendar?view=list", PRAC)).toContain('href="tel:+919800001234"');
    const staff = await page("/app/calendar?view=list", STAFF);
    expect(staff).not.toContain("tel:+91980000");
    expect(staff).not.toContain("btn call");
  });
});

describe("the day view's timeline (ticket 39)", () => {
  it("opening to closing: the bookings in time order with the free gaps between them, and how long each gap is", async () => {
    const p = await id(PRAC);
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-29T14:30", prac: p });
    await session({ name: "Meera Test", wa: "919800004321", ist: "2026-10-29T16:00", prac: p });
    const body = plain(await page("/app/calendar?view=day&d=2026-10-29"));
    const order = ["Opens 2:00 pm", "2:00 pm – 2:30 pmFree · 30 min", "Ravi", "2:45 pm – 4:00 pmFree · 1 h 15 min", "Meera", "5:00 pm – 7:00 pmFree · 2 h", "Closes 7:00 pm"];
    let at = 0;
    for (const x of order) {
      const i = body.indexOf(x, at);
      expect(i, x).toBeGreaterThan(-1);
      at = i;
    }
  });

  it("today: the time already gone is a quiet line, with a Now marker", async () => {
    vi.setSystemTime(Date.parse("2026-10-28T09:20:00Z")); // 2:50 pm
    await call({ name: "Ravi Test", wa: "919800001234", ist: "2026-10-28T15:30", prac: await id(PRAC) });
    const page28 = await page("/app/calendar?view=day&d=2026-10-28");
    // The grid: a Now line at 2:50 pm, 50 minutes past opening (2.4 px a minute), and the time gone shaded.
    expect(page28).toContain('<div class="tg-now" style="top:120.0px"><span>2:50 pm</span></div>');
    expect(page28).toContain('<div class="tg-past" style="height:120.0px">');
    const body = plain(page28.slice(page28.indexOf('<div class="tl">')));
    expect(body).toContain("2:00 pm – 3:00 pmEarlier, not booked");
    expect(body.indexOf("Now · 2:50 pm")).toBeGreaterThan(body.indexOf("Earlier, not booked"));
    expect(body.indexOf("Now · 2:50 pm")).toBeLessThan(body.indexOf("Ravi"));
  });
});

describe("who sees what", () => {
  it("a practitioner sees only their own; owner and staff see everyone's, with a filter only when there are two practitioners", async () => {
    const p1 = await id(PRAC);
    await call({ name: "Ravi Mine", wa: "919800001234", ist: "2026-10-29T14:30", prac: p1 });
    // One practitioner: no filter.
    expect(await page("/app/calendar")).not.toContain("Whose calendar");
    await h.db.prepare("INSERT INTO members (workspace_id, email, role, status, display_name) VALUES (1, ?1, 'PRACTITIONER', 'active', 'Second')").bind(PRAC2).run();
    const p2 = await id(PRAC2);
    await call({ name: "Sita Theirs", wa: "919800005678", ist: "2026-10-30T15:00", prac: p2 });

    const mine = await page("/app/calendar", PRAC);
    expect(mine).toContain("Ravi");
    expect(mine).not.toContain("Sita");
    expect(mine).not.toContain("Whose calendar");
    const second = await page("/app/calendar", PRAC2);
    expect(second).toContain("Sita");
    expect(second).not.toContain("Ravi");
    // A practitioner can't widen the view by hand.
    expect(await page(`/app/calendar?p=${p1}`, PRAC2)).not.toContain("Ravi");

    for (const who of [OWNER, STAFF]) {
      const all = await page("/app/calendar", who);
      expect(all).toContain("Ravi");
      expect(all).toContain("Sita");
      expect(all).toContain("Whose calendar");
      expect(all).toContain(`href="/app/calendar?view=week&d=2026-10-28&p=${p2}"`);
      const one = await page(`/app/calendar?p=${p2}`, who);
      expect(one).toContain("Sita");
      expect(one).not.toContain("Ravi");
    }
  });

  it("Hindi: the same calendar in the member's language", async () => {
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(PRAC).run();
    const body = await page("/app/calendar", PRAC);
    expect(body).toContain('<html lang="hi">');
    expect(body).toContain("हफ़्ता");
    expect(body).toContain("बंद"); // Sunday, closed
  });
});
