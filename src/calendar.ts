// Calendar (/app/calendar): "When am I booked or free?" (docs/CONSOLE-PRD.md, "Calendar"; ticket 27). Read-only in Phase 1.
// Week view (Monday to Sunday, this week by default), Day view or Month view (ticket 39), chosen by links (no script):
// ?view=day|week|month&d=YYYY-MM-DD, and for owner and staff ?p=<practitioner member id> when there is more than one practitioner.
// Each day lists its calls, sessions and live holds in time order, then the free times left (the slot generator in src/slots.ts, less every active booking or hold, exactly as the bot sees
// them), under the working hours from config. A practitioner sees only their own (the view_calendar row of the permission table is "own").
// Working hours are edited in Phase 2; the page says so in one line and draws no button for it. Days off (holidays, ticket 30) are
// marked and removed at the foot of the page by whoever may set_hours (owner; a practitioner for the one shared calendar; not staff),
// and a holiday shows as "Holiday" on its day (src/holidays.ts).
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, canAny, memberCsrf, type Member } from "./auth";
import { config } from "./config";
import { appPage, auditStmt, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { addHoliday, anyDate, bookingsOn, holidayBounds, holidayDate, holidaysBetween, removeHoliday, upcomingHolidays } from "./holidays";
import { consoleCopy, consoleLang, type ConsoleCopy } from "./console-copy";
import { hoursText, serviceName, type ForWhom } from "./copy";
import type { Env } from "./env";
import { dayLabelFor, generateSlots, iso, istDay } from "./slots";
import { TODAY_COPY } from "./today";
import { appointmentRow, bookingChip, button, clock, dayName, emptyState, firstName, forWhomText, keep4, last4, screenHead, section, statusChip } from "./ui";

const DAY = 86_400_000;
export type CalView = "day" | "week" | "month";

// ---------- days ----------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const utcOf = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
export const addDays = (ymd: string, n: number) => new Date(utcOf(ymd) + n * DAY).toISOString().slice(0, 10);
// Weeks start on Monday.
export const weekStart = (ymd: string) => addDays(ymd, -((new Date(utcOf(ymd)).getUTCDay() + 6) % 7));
const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));
const validDay = (v: string | undefined): string | null => (v && YMD.test(v) && !Number.isNaN(utcOf(v)) && addDays(v, 0) === v ? v : null);

// ---------- what is on the calendar ----------
export type Entry = {
  kind: "CALL" | "SESSION"; id: number; startUtc: string; endUtc: string; state: string; holdUntil: string | null;
  convId: number; name: string | null; waId: string; service: string; forWhom: ForWhom | null; practitionerId: number | null;
  packSize: number | null; packNo: number | null;
};
// A booking that still holds its time (or held it: done, missed), and a hold that hasn't lapsed. Cancelled and expired ones free the time.
const CALL_STATES = "('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE')";
const SESSION_STATES = "('CONFIRMED','CREDIT_BOOKED','COMPLETED','NO_SHOW','NOT_FIT')";
const LIVE_HOLD = "(x.state = 'HELD' AND s.state = 'HELD' AND s.hold_until > ?4 AND s.owner_id = x.conversation_id)";

export async function entriesBetween(env: Env, fromUtc: string, toUtc: string, practitionerId: number | null, nowMs: number): Promise<Entry[]> {
  const common = `s.start_utc AS startUtc, s.end_utc AS endUtc, x.state, CASE WHEN x.state = 'HELD' THEN s.hold_until END AS holdUntil,
    c.id AS convId, c.display_name AS name, c.wa_id AS waId, x.service, x.for_whom AS forWhom, COALESCE(x.practitioner_id, s.practitioner_id) AS practitionerId`;
  const scope = "(?3 IS NULL OR COALESCE(x.practitioner_id, s.practitioner_id) = ?3) AND s.start_utc >= ?1 AND s.start_utc < ?2";
  const [calls, sessions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT 'CALL' AS kind, x.id, ${common}, NULL AS packSize, NULL AS packNo
       FROM intros x JOIN slots s ON s.id = x.slot_id JOIN conversations c ON c.id = x.conversation_id
       WHERE s.kind = 'CALL' AND ${scope} AND (x.state IN ${CALL_STATES} OR ${LIVE_HOLD})`,
    ).bind(fromUtc, toUtc, practitionerId, iso(nowMs)),
    env.DB.prepare(
      `SELECT 'SESSION' AS kind, x.id, ${common},
         (SELECT k.size FROM packages k WHERE k.id = x.package_id) AS packSize,
         (SELECT COUNT(*) FROM credits cr WHERE cr.package_id = x.package_id AND cr.reason = 'BOOK' AND cr.session_id <= x.id) AS packNo
       FROM sessions x JOIN slots s ON s.id = x.slot_id JOIN conversations c ON c.id = x.conversation_id
       WHERE s.kind = 'SESSION' AND ${scope} AND (x.state IN ${SESSION_STATES} OR ${LIVE_HOLD})`,
    ).bind(fromUtc, toUtc, practitionerId, iso(nowMs)),
  ]);
  return [...(calls.results as Entry[]), ...(sessions.results as Entry[])].sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id - b.id);
}

// The free times left on a day, as ranges: the call slots the generator makes (the smallest step), after now, that no active booking
// or hold overlaps. There is one calendar (CONTRACT: a call and a session never overlap), so this is the same for every practitioner.
export type Range = { from: string; to: string };
export function freeRanges(ymd: string, busy: { startUtc: string; endUtc: string }[], nowMs: number): Range[] {
  const now = iso(nowMs);
  const out: Range[] = [];
  for (const s of generateSlots(ymd, "CALL")) {
    if (s.startUtc < now || busy.some((b) => b.startUtc < s.endUtc && b.endUtc > s.startUtc)) continue;
    const last = out.at(-1);
    if (last && last.to === s.startUtc) last.to = s.endUtc;
    else out.push({ from: s.startUtc, to: s.endUtc });
  }
  return out;
}
// Every slot that blocks the calendar right now: booked, or held and not lapsed (the rule holdSlot uses).
const busyBetween = (env: Env, fromUtc: string, toUtc: string, nowMs: number) =>
  env.DB.prepare("SELECT start_utc AS startUtc, end_utc AS endUtc FROM slots WHERE (state = 'BOOKED' OR hold_until > ?3) AND start_utc < ?2 AND end_utc > ?1")
    .bind(fromUtc, toUtc, iso(nowMs))
    .all<{ startUtc: string; endUtc: string }>()
    .then((r) => r.results);

async function nextAfter(env: Env, fromUtc: string, practitionerId: number | null): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT MIN(s.start_utc) AS at FROM slots s WHERE s.start_utc >= ?1 AND s.state = 'BOOKED' AND (
       (s.kind = 'CALL' AND EXISTS (SELECT 1 FROM intros i WHERE i.slot_id = s.id AND i.state IN ('PAID','RESCHEDULED') AND (?2 IS NULL OR i.practitioner_id = ?2)))
       OR (s.kind = 'SESSION' AND EXISTS (SELECT 1 FROM sessions se WHERE se.slot_id = s.id AND se.state IN ('CONFIRMED','CREDIT_BOOKED') AND (?2 IS NULL OR se.practitioner_id = ?2))))`,
  ).bind(fromUtc, practitionerId).first<{ at: string | null }>();
  return r?.at ?? null;
}

type Practitioner = { id: number; name: string };
const practitioners = (env: Env, m: Member) =>
  env.DB.prepare("SELECT id, COALESCE(NULLIF(display_name, ''), email) AS name FROM members WHERE workspace_id = ?1 AND role = 'PRACTITIONER' AND status = 'active' ORDER BY id")
    .bind(m.workspaceId)
    .all<Practitioner>()
    .then((r) => r.results);

// ---------- the page ----------
// The look (ticket 39): the Day view is a timeline of the working hours, its bookings and the free gaps between them; the Week view is a
// list of days on a phone and seven columns on a wide screen; the Month view is a Monday-to-Sunday grid with a count and a dot per booking
// (teal a call, gold a session), holidays and today marked and past days quieter. Every day in Week and Month opens its Day view.
const CAL_CSS = `
.calbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px}
.calnav{display:flex;align-items:center;gap:6px;flex-wrap:nowrap}
.calnav .btn{padding:10px 16px}
.calnav .arrow{min-width:48px;padding:10px 12px;font-size:22px;line-height:1}
.range{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1.15;color:var(--bronze);margin:4px 0 4px}
[lang=hi] .range{font-family:var(--sans);font-size:22px}
.calnote{color:var(--muted);margin:0 0 4px}
.cday{margin:24px 0 0}
.cday h2.sec{margin:0 0 12px;align-items:center}
.cday h2.sec>span{display:inline-flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:48px}
.cday h2.sec a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;min-height:48px}
.cday h2.sec a:hover{color:var(--accent)}
.cday .chip{text-transform:none;letter-spacing:0}
.free{margin:0 0 4px;color:var(--muted)}
.free b{color:var(--ink);font-weight:500}
.freesum{display:none}
.closed{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;min-height:56px;color:var(--muted);border-top:1px solid var(--line);padding:4px 0;margin:0}
.closed a{color:var(--ink);text-decoration:none}
.cday+.closed{margin-top:24px}
.closed+.closed{border-top-style:dashed}
.closed b{color:var(--ink);font-weight:500}
.evs{display:flex;flex-direction:column;gap:8px;margin:0 0 10px}
.ev{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 14px;align-items:baseline;min-height:56px;padding:10px 14px;border-radius:var(--r-sm);background:var(--surface);border:1px solid var(--line);color:var(--ink);text-decoration:none;box-shadow:inset 4px 0 0 var(--accent),0 1px 2px var(--shade)}
.ev:hover{border-color:var(--muted)}
.ev.session{box-shadow:inset 4px 0 0 var(--gold),0 1px 2px var(--shade)}
.ev.held{border-style:dashed;box-shadow:inset 4px 0 0 var(--waiting),0 1px 2px var(--shade)}
.ev .t{font-weight:600;color:var(--accent);white-space:nowrap}
.ev .n{font-weight:600;min-width:0}
.ev .k{grid-column:2;color:var(--muted);font-size:16px;line-height:1.4}
.ev .chip{grid-column:2;justify-self:start;margin-top:2px}
.cday.past .ev,.cday.past h2.sec{opacity:.78}
.tl{position:relative;margin:8px 0 12px;padding:0 0 0 30px}
.tl::before{content:"";position:absolute;left:10px;top:12px;bottom:12px;width:2px;border-radius:2px;background:linear-gradient(180deg,var(--gold),var(--water))}
.tl>*{position:relative;margin:0 0 10px}
.tl>*::before{content:"";position:absolute;left:-26px;top:22px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2px solid var(--water)}
.tl .edge{display:flex;align-items:center;min-height:32px;margin:0 0 10px;color:var(--muted);font-size:16px;font-weight:500;letter-spacing:.06em}
.tl .edge::before{top:11px;background:var(--gold);border-color:var(--gold)}
.tl .item{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:0 18px;box-shadow:0 1px 2px var(--shade)}
.tl .item::before{background:var(--accent);border-color:var(--accent)}
.tl .item.session::before{background:var(--gold);border-color:var(--gold)}
.tl .item.held{border-style:dashed}
.tl .item .appt{border:0}
.tl .gap{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;min-height:56px;padding:8px 18px;border:1px dashed var(--line);border-radius:var(--r);background:var(--glow2);color:var(--muted)}
.tl .gap::before{top:22px;background:var(--paper);border-color:var(--line)}
.tl .gap b{color:var(--ink);font-weight:600;white-space:nowrap}
.tl .gap.past{background:transparent;border-color:transparent;min-height:40px;padding:4px 18px}
.tl .gap.past b{color:var(--muted);font-weight:500}
.tl .now{display:flex;align-items:center;gap:10px;min-height:32px;color:var(--attention);font-weight:600}
.tl .now::after{content:"";flex:1;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--attention),transparent)}
.tl .now::before{top:11px;background:var(--attention);border-color:var(--attention);box-shadow:0 0 0 4px var(--attention-tint)}
.mgrid{table-layout:fixed;border-collapse:separate;border-spacing:3px;margin:0 -3px 8px;width:calc(100% + 6px)}
.mgrid th{font-size:16px;font-weight:600;color:var(--muted);padding:4px 0 6px;text-align:center}
.mgrid td{padding:0;vertical-align:top}
.md{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;min-height:64px;padding:6px 2px;border-radius:12px;background:var(--surface);border:1px solid var(--line);color:var(--ink);text-decoration:none;overflow:hidden}
.md:hover{border-color:var(--muted)}
.md .dn{font-size:18px;font-weight:600;line-height:1.2}
.md .cnt{font-size:16px;line-height:1.1;color:var(--accent);font-weight:600}
.md .dots{display:flex;flex-wrap:wrap;justify-content:center;gap:3px;max-width:40px}
.md .dots i{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.md .dots i.s{background:var(--gold)}
.md .kinds,.md .tag,.ev .ks{display:none}
.md .kinds>span{display:block}
.md.out{background:transparent;border-color:transparent;color:var(--muted)}
.md.out .cnt{color:var(--muted)}
.md.past:not(.out){background:var(--sunk);color:var(--muted)}
.md.past .cnt{color:var(--muted)}
.md.closed{background:transparent;border-style:dashed}
.md.hol{background:var(--waiting-tint);border-color:var(--gold)}
.md.hol::after{content:"";width:8px;height:8px;margin-top:4px;border-radius:2px;transform:rotate(45deg);background:var(--gold)}
.md.today{border:2px solid var(--accent);box-shadow:0 0 0 3px var(--glow)}
.md.today .dn{color:var(--accent)}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;color:var(--muted);font-size:16px;margin:4px 0 0}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.legend i.s{background:var(--gold)}
.legend i.h{border-radius:2px;transform:rotate(45deg);background:var(--gold)}
.legend i.t{background:transparent;border:2px solid var(--accent);border-radius:4px}
.holform{max-width:420px}
.holform label{display:block;font-weight:500;margin:0 0 4px}
.holform input{display:block;width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px;margin:0 0 16px}
.hol{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.holbks{display:flex;flex-direction:column;margin:4px 0 0}
.holbk{display:flex;align-items:center;min-height:48px;color:var(--ink)}
@media (min-width:900px){
.calbar{flex-wrap:nowrap}
.mgrid{border-spacing:6px;margin:0 -6px 8px;width:calc(100% + 12px)}
.md{align-items:flex-start;min-height:112px;padding:10px 12px;gap:4px}
.md .dn{font-size:20px}
.md .dots{justify-content:flex-start;max-width:none}
.md .cnt{display:none !important}
.md.hol::after{position:absolute;top:12px;right:12px;margin:0}
.md .kinds{display:block;font-size:16px;color:var(--muted);line-height:1.3}
.md .tag{display:block;font-size:16px;font-weight:500;color:var(--waiting)}
.md.closed .tag{color:var(--muted)}
.tl{padding-left:40px}
.tl::before{left:14px}
.tl>*::before{left:-31px}
}
@media (min-width:1200px){
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px;align-items:start;margin-top:8px}
.week>.cday,.week>.closed{margin:0;min-height:280px;padding:10px;border-radius:var(--r);background:var(--surface);border:1px solid var(--line);display:block}
.week>.closed{background:transparent;border-style:dashed}
.week>.closed>*{display:block}
.week>.closed+.closed{border-top-style:dashed}
.week>.cday.today{border:2px solid var(--accent);box-shadow:0 0 0 4px var(--glow)}
.week>.cday.past{background:var(--sunk)}
.week h2.sec{display:block;margin:0 0 8px;letter-spacing:.04em}
.week h2.sec>span{display:flex;min-height:0}
.week h2.sec .n{margin-top:6px}
.week .ev{grid-template-columns:minmax(0,1fr);gap:0;padding:8px 10px}
.week .ev .k{display:none}
.week .ev .ks{display:block;color:var(--muted);font-size:16px}
.week .ev .n .nw{display:block;font-weight:400;color:var(--muted)}
.week .ev .chip{grid-column:1;white-space:normal;margin-top:4px}
.week .ev .chip.done{display:none}
.week>.closed b{display:block;font-size:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:4px 0 8px}
.week>.closed b a{color:inherit}
.week .free{display:none}
.week .freesum{display:block;color:var(--muted);font-size:16px;margin:4px 0 0}
}
`;

const link = (o: { view: CalView; d: string; p: number | null }) => `/app/calendar?view=${o.view}&d=${o.d}${o.p !== null ? `&p=${o.p}` : ""}`;
const rangeText = (r: Range, locale: string) => `${clock(r.from, locale)} – ${clock(r.to, locale)}`;
const minutesOf = (r: Range) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 60_000);
const durationOf = (min: number, cc: ConsoleCopy) => cc.duration(Math.floor(min / 60), min % 60);
// "Free: 2:30 pm – 3:30 pm · 4:15 pm – 7:00 pm": the label quiet, each range in ink and on one line.
const keepTimes = (line: string) => {
  const [label, ...rest] = line.split(": ");
  if (!rest.length) return html`${line}`;
  return html`${label}: ${rest.join(": ").split(" · ").map((x, i) => html`${i ? " · " : ""}<b class="nw">${x}</b>`)}`;
};
const isWorkingDay = (ymd: string) => generateSlots(ymd, "CALL").length > 0;
const dayEndMs = (ymd: string) => Date.parse(dayStartUtc(addDays(ymd, 1)));

// What a booking is, in words: "15-minute call", "Session 3 of 10, from a package", who it's for, a hold's lapse, whose calendar.
function entryDetails(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const t = TODAY_COPY[consoleLang(m.locale)];
  const kind = e.kind === "CALL" ? t.kindCall(config.slots.callMinutes) : e.packSize ? t.kindSessionPackage(e.packNo ?? 0, e.packSize) : t.kindSession;
  const details = [kind, forWhomText(e.forWhom, m.locale)];
  if (e.state === "HELD" && e.holdUntil) details.push(cc.calHeldUntil(clock(e.holdUntil, m.locale)));
  if (many && e.practitionerId !== null && many.has(e.practitionerId)) details.push(many.get(e.practitionerId)!);
  return details.filter(Boolean);
}
const evClass = (e: Entry) => `${e.kind === "CALL" ? "call" : "session"}${e.state === "HELD" ? " held" : ""}`;

// The Day view's row: the full appointment row with Open.
function entryRow(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const lang = consoleLang(m.locale);
  return appointmentRow({
    time: clock(e.startUtc, lang),
    name: firstName(e.name, TODAY_COPY[lang].noName),
    waId: e.waId,
    service: serviceName(e.service, lang),
    details: entryDetails(e, m, cc, many),
    status: bookingChip(e.state, m.locale),
    action: { label: cc.open, href: `/app/people/${e.convId}`, kind: "secondary" },
  });
}
// The Week view's entry: one tappable block that opens the person.
function entryCompact(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const lang = consoleLang(m.locale);
  const k = [serviceName(e.service, lang), ...entryDetails(e, m, cc, many)].join(" · ");
  const short = e.kind === "CALL" ? cc.calShortCall : cc.calShortSession;
  return html`<a class="ev ${evClass(e)}" href="/app/people/${e.convId}"><span class="t">${clock(e.startUtc, lang)}</span><span class="n">${firstName(e.name, TODAY_COPY[lang].noName)} <span class="nw">${last4(e.waId)}</span></span><span class="k">${k}</span><span class="ks" aria-hidden="true">${short}</span>${bookingChip(e.state, m.locale)}</a>`;
}

type DayArgs = { ymd: string; entries: Entry[]; busy: { startUtc: string; endUtc: string }[]; m: Member; cc: ConsoleCopy; nowMs: number; p: number | null; many: Map<number, string> | null; holiday: boolean };

// One day of the Week view: its heading (a link to its Day view), its bookings, its free times. A day off is one quiet line.
function weekDay(o: DayArgs) {
  const { ymd, m, cc } = o;
  const lang = consoleLang(m.locale);
  const label = dayLabelFor(ymd, lang);
  const today = ymd === istDay(o.nowMs);
  const past = dayEndMs(ymd) <= o.nowMs;
  const working = isWorkingDay(ymd);
  const title = html`<a href="${link({ view: "day", d: ymd, p: o.p })}">${label}</a>`;
  const evs = o.entries.length ? html`<div class="evs">${o.entries.map((e) => entryCompact(e, m, cc, o.many))}</div>` : "";
  const cls = `cday${today ? " today" : ""}${past ? " past" : ""}`;
  if (o.holiday) {
    // A day off: said plainly, with whatever was booked before it was marked (those stay booked until someone moves them).
    return html`<section class="${cls} hol" id="d-${ymd}"><h2 class="sec"><span>${title} ${statusChip(cc.calHoliday, o.entries.length ? "attention" : "plain")}</span><span class="n">${o.entries.length ? cc.calBooked(o.entries.length) : ""}</span></h2>
${evs}<p class="free">${cc.calHolidayLine}</p></section>`;
  }
  if (!working && !o.entries.length) return html`<p class="closed"><b>${label}</b><span>${cc.calClosed}</span></p>`;
  if (!o.entries.length && past) return html`<p class="closed"><b><a class="tap" href="${link({ view: "day", d: ymd, p: o.p })}">${label}</a></b><span>${cc.calNothing}</span></p>`;
  const free = freeRanges(ymd, o.busy, o.nowMs);
  const freeLine =
    past || !working
      ? ""
      : free.length
        ? html`<p class="free">${keepTimes(cc.calFree(free.map((r) => rangeText(r, lang)).join(" · ")))}</p><p class="freesum">${cc.calFreeFor(durationOf(free.reduce((n, r) => n + minutesOf(r), 0), cc))}</p>`
        : html`<p class="free">${cc.calNoFree}</p>`;
  const count = o.entries.length ? cc.calBooked(o.entries.length) : cc.calNothing;
  return html`<section class="${cls}" id="d-${ymd}"><h2 class="sec"><span>${title}${today ? html` ${statusChip(cc.calToday, "accent")}` : ""}</span><span class="n">${count}</span></h2>
${evs}${freeLine}</section>`;
}

// The Day view: a timeline from opening to closing. Bookings in time order with the free gaps between them (the times the bot can still
// offer), the time already gone as a quiet "earlier" line, and a Now marker on today.
function dayTimeline(o: DayArgs) {
  const { ymd, m, cc } = o;
  const lang = consoleLang(m.locale);
  const label = dayLabelFor(ymd, lang);
  const today = ymd === istDay(o.nowMs);
  const working = isWorkingDay(ymd);
  const past = dayEndMs(ymd) <= o.nowMs;
  const rowOf = (e: Entry) => html`<div class="item ${evClass(e)}">${entryRow(e, m, cc, o.many)}</div>`;
  if (o.holiday) {
    return html`<section class="cday hol" id="d-${ymd}"><h2 class="sec"><span>${label} ${statusChip(cc.calHoliday, o.entries.length ? "attention" : "plain")}</span><span class="n">${o.entries.length ? cc.calBooked(o.entries.length) : ""}</span></h2>
${o.entries.length ? html`<div class="tl">${o.entries.map(rowOf)}</div>` : ""}<p class="free">${cc.calHolidayLine}</p></section>`;
  }
  if (!working && !o.entries.length) return html`<p class="closed"><b>${label}</b><span>${cc.calClosed}</span></p>`;
  const slots = generateSlots(ymd, "CALL");
  const free = freeRanges(ymd, o.busy, o.nowMs);
  // The working time already gone that nothing was booked in: slots started before now that no booking overlaps.
  const gone: Range[] = [];
  for (const s of slots) {
    if (Date.parse(s.startUtc) >= o.nowMs || o.busy.some((b) => b.startUtc < s.endUtc && b.endUtc > s.startUtc)) continue;
    const last = gone.at(-1);
    if (last && last.to === s.startUtc) last.to = s.endUtc;
    else gone.push({ from: s.startUtc, to: s.endUtc });
  }
  type Item = { at: string; order: number; html: unknown };
  const items: Item[] = [
    ...o.entries.map((e) => ({ at: e.startUtc, order: 1, html: rowOf(e) })),
    ...free.map((r) => ({ at: r.from, order: 2, html: html`<div class="gap"><b>${rangeText(r, lang)}</b><span>${cc.calFreeGap} · ${durationOf(minutesOf(r), cc)}</span></div>` })),
    ...gone.map((r) => ({ at: r.from, order: 2, html: html`<div class="gap past"><b>${rangeText(r, lang)}</b><span>${cc.calPastGap}</span></div>` })),
  ];
  if (today && slots.length && o.nowMs >= Date.parse(slots[0].startUtc) && o.nowMs < Date.parse(slots.at(-1)!.endUtc))
    items.push({ at: iso(o.nowMs), order: 0, html: html`<p class="now">${cc.calNow} · ${clock(iso(o.nowMs), lang)}</p>` });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const edges = slots.length
    ? { open: html`<p class="edge">${cc.calOpens(clock(slots[0].startUtc, lang))}</p>`, close: html`<p class="edge">${cc.calCloses(clock(slots.at(-1)!.endUtc, lang))}</p>` }
    : { open: "", close: "" };
  const hours = slots.length ? cc.calOpen(clock(slots[0].startUtc, lang), clock(slots.at(-1)!.endUtc, lang)) : cc.calClosed;
  const freeLine =
    past || !working ? "" : free.length ? html`<p class="free vh">${keepTimes(cc.calFree(free.map((r) => rangeText(r, lang)).join(" · ")))}</p>` : html`<p class="free">${cc.calNoFree}</p>`;
  const count = o.entries.length ? cc.calBooked(o.entries.length) : cc.calNothing;
  return html`<section class="cday${today ? " today" : ""}${past ? " past" : ""}" id="d-${ymd}"><h2 class="sec"><span>${label}${today ? html` ${statusChip(cc.calToday, "accent")}` : ""}</span><span class="n">${count}</span></h2>
${freeLine}<p class="calnote">${hours}</p><div class="tl">${edges.open}${items.map((i) => i.html)}${edges.close}</div></section>`;
}

// The Month view: Monday to Sunday, every week that touches the month; each day a link to its Day view.
function monthGrid(o: { first: string; days: string[]; entries: Entry[]; holidays: Set<string>; m: Member; cc: ConsoleCopy; nowMs: number; p: number | null }) {
  const { m, cc } = o;
  const lang = consoleLang(m.locale);
  const todayYmd = istDay(o.nowMs);
  const month = o.first.slice(0, 7);
  const byDay = new Map<string, Entry[]>();
  for (const e of o.entries) {
    const d = istDay(Date.parse(e.startUtc));
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const cell = (ymd: string) => {
    const es = byDay.get(ymd) ?? [];
    const calls = es.filter((e) => e.kind === "CALL").length;
    const sessions = es.length - calls;
    const hol = o.holidays.has(ymd);
    const closed = !isWorkingDay(ymd);
    const cls = ["md", ymd.slice(0, 7) !== month ? "out" : "", dayEndMs(ymd) <= o.nowMs ? "past" : "", ymd === todayYmd ? "today" : "", hol ? "hol" : closed ? "closed" : ""].filter(Boolean).join(" ");
    const kindList = [calls ? cc.calCalls(calls) : "", sessions ? cc.calSessions(sessions) : ""].filter(Boolean);
    const kinds = kindList.join(" · ");
    const tag = hol ? cc.calHoliday : closed ? cc.calClosed : "";
    const aria = [dayLabelFor(ymd, lang), es.length ? `${cc.calBooked(es.length)} (${kinds})` : cc.calNothing, tag].filter(Boolean).join(", ");
    const dots = es.slice(0, 8).map((e) => raw(e.kind === "CALL" ? "<i></i>" : '<i class="s"></i>'));
    return html`<td><a class="${cls}" href="${link({ view: "day", d: ymd, p: o.p })}" aria-label="${aria}"${ymd === todayYmd ? raw(' aria-current="date"') : ""}><span class="dn">${Number(ymd.slice(8))}</span>${
      es.length ? html`<span class="cnt" aria-hidden="true">${es.length}</span><span class="dots" aria-hidden="true">${dots}</span><span class="kinds" aria-hidden="true">${kindList.map((k) => html`<span>${k}</span>`)}</span>` : ""
    }${tag ? html`<span class="tag" aria-hidden="true">${tag}</span>` : ""}</a></td>`;
  };
  const weeks: string[][] = [];
  for (let i = 0; i < o.days.length; i += 7) weeks.push(o.days.slice(i, i + 7));
  const head = cc.calWeekdays.split(" ").map((d) => html`<th scope="col">${d}</th>`);
  const legend = html`<p class="legend"><span>${cc.calLegend}</span><span><i></i>${TODAY_COPY[lang].kindCall(config.slots.callMinutes)}</span><span><i class="s"></i>${TODAY_COPY[lang].kindSession}</span><span><i class="h"></i>${cc.calHoliday}</span><span><i class="t"></i>${cc.calToday}</span></p>`;
  return html`<table class="mgrid"><thead><tr>${head}</tr></thead><tbody>${weeks.map((w) => html`<tr>${w.map(cell)}</tr>`)}</tbody></table>${legend}`;
}

const monthTitle = (first: string, cc: ConsoleCopy) => `${cc.calMonthNames.split(" ")[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
const monthStart = (ymd: string) => `${ymd.slice(0, 8)}01`;
const addMonths = (first: string, n: number) => {
  const d = new Date(utcOf(first));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

async function calendarPage(c: ConsoleCtx) {
  const m = c.get("member");
  if (!canAny(m, "view_calendar")) return refused(c);
  const cc = consoleCopy(m.locale);
  const lang = consoleLang(m.locale);
  const nowMs = Date.now();
  const asked = c.req.query("view");
  const view: CalView = asked === "day" || asked === "month" ? asked : "week";
  const d = validDay(c.req.query("d")) ?? istDay(nowMs);

  // Whose calendar: a practitioner only their own; owner and staff everyone's, or one practitioner's when there is more than one.
  const all = can(m, "view_calendar") === "yes";
  const team = all ? await practitioners(c.env, m) : [];
  const pAsked = Number(c.req.query("p"));
  const picked = all && team.length > 1 && team.some((x) => x.id === pAsked) ? pAsked : null;
  const scope = all ? picked : m.id;
  const many = all && team.length > 1 && picked === null ? new Map(team.map((x) => [x.id, x.name])) : null;

  // The days on the page: one; Monday to Sunday; or every week that touches the month.
  const first = monthStart(d);
  const days =
    view === "week"
      ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(d), i))
      : view === "month"
        ? (() => {
            const from = weekStart(first);
            const to = addDays(weekStart(addDays(addMonths(first, 1), -1)), 6);
            const out: string[] = [];
            for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
            return out;
          })()
        : [d];
  const from = dayStartUtc(days[0]);
  const to = dayStartUtc(addDays(days.at(-1)!, 1));
  const [entries, busy, hols] = await Promise.all([entriesBetween(c.env, from, to, scope, nowMs), busyBetween(c.env, from, to, nowMs), holidaysBetween(c.env.DB, days[0], days.at(-1)!)]);
  const holidays = new Set(hols.map((h) => h.ymd));

  // Previous and next: a day, a week (Monday to Monday) or a month (the 1st to the 1st).
  const todayYmd = istDay(nowMs);
  const step = (n: number) => (view === "month" ? addMonths(first, n) : view === "week" ? addDays(days[0], 7 * n) : addDays(d, n));
  const here = (o: Partial<{ view: CalView; d: string; p: number | null }>) => link({ view, d, p: picked, ...o });
  const showingToday = view === "month" ? todayYmd.slice(0, 7) === first.slice(0, 7) : days.includes(todayYmd);
  // Switching view keeps the day in sight: today if it is on the page, else the day asked for (Week, Day) or the 1st (Month).
  const keep = showingToday ? todayYmd : view === "month" ? first : view === "week" ? days[0] : d;
  const VIEWS: [CalView, string][] = [["day", cc.calDay], ["week", cc.calWeek], ["month", cc.calMonth]];
  const viewSeg = html`<nav class="seg" aria-label="${cc.calViewLabel}">${VIEWS.map(
    ([v, word]) => html`<a href="${here({ view: v, d: v === view ? d : keep })}"${v === view ? raw(' class="on" aria-current="page"') : ""}>${word}</a>`,
  )}</nav>`;
  const prevWord = { day: cc.calPrevDay, week: cc.calPrevWeek, month: cc.calPrevMonth }[view];
  const nextWord = { day: cc.calNextDay, week: cc.calNextWeek, month: cc.calNextMonth }[view];
  const nav = html`<nav class="calnav" aria-label="${cc.calViewLabel}">
<a class="btn arrow" href="${here({ d: step(-1) })}" aria-label="${prevWord}" title="${prevWord}">‹</a>
<a class="btn${showingToday ? " primary" : ""}" href="${here({ d: todayYmd })}"${showingToday ? raw(' aria-current="date"') : ""}>${cc.calToday}</a>
<a class="btn arrow" href="${here({ d: step(1) })}" aria-label="${nextWord}" title="${nextWord}">›</a></nav>`;
  const filter =
    all && team.length > 1
      ? html`<nav class="seg who" aria-label="${cc.calWhose}">${[{ id: null as number | null, name: cc.calEveryone }, ...team].map(
          (x) => html`<a href="${link({ view, d, p: x.id })}"${x.id === picked ? raw(' class="on" aria-current="page"') : ""}>${x.name}</a>`,
        )}</nav>`
      : "";
  const rangeLabel = view === "week" ? `${dayLabelFor(days[0], lang)} – ${dayLabelFor(days[6], lang)}` : view === "month" ? monthTitle(first, cc) : dayLabelFor(d, lang);

  // Nothing booked on the page: say so, and name the next booking after it.
  const inMonth = view === "month" ? entries.filter((e) => istDay(Date.parse(e.startUtc)).slice(0, 7) === first.slice(0, 7)) : entries;
  let empty: unknown = "";
  if (!inMonth.length) {
    const after = view === "month" ? dayStartUtc(addMonths(first, 1)) : to;
    const next = await nextAfter(c.env, after, scope);
    const nextText = next ? `${dayName(next, m.locale)}, ${clock(next, m.locale)}` : null;
    const sentence =
      view === "week"
        ? nextText ? cc.calEmptyWeek(nextText) : cc.calEmptyWeekNone
        : view === "month"
          ? nextText ? cc.calEmptyMonth(nextText) : cc.calEmptyMonthNone
          : nextText ? cc.calEmptyDay(nextText) : cc.calEmptyDayNone;
    empty = emptyState(sentence, next ? { label: cc.calGoNext, href: link({ view: "day", d: istDay(Date.parse(next)), p: picked }) } : undefined);
  }
  const byDay = (ymd: string) => entries.filter((e) => istDay(Date.parse(e.startUtc)) === ymd);
  const args = (ymd: string): DayArgs => ({ ymd, entries: byDay(ymd), busy, m, cc, nowMs, p: picked, many, holiday: holidays.has(ymd) });
  const main =
    view === "month"
      ? monthGrid({ first, days, entries, holidays, m, cc, nowMs, p: picked })
      : view === "week"
        ? html`<div class="week">${days.map((ymd) => weekDay(args(ymd)))}</div>`
        : dayTimeline(args(d));

  const body = html`<style>${raw(CAL_CSS)}</style>${screenHead("calendar", m.locale)}
<div class="calbar">${viewSeg}${nav}</div>${filter ? html`<div class="calbar">${filter}</div>` : ""}
${view !== "day" ? html`<p class="range">${rangeLabel}</p>` : ""}<p class="calnote">${hoursText(lang)} ${cc.calPhase2}</p>
${empty}${main}${await daysOff(c)}`;
  return appPage(c, { active: "calendar", title: cc.tabCalendar, body, back: here({}), flash: flashFor(c, cc) });
}

// ---------- days off (ticket 30) ----------
// Who may mark or remove one: set_hours (owner yes; a practitioner "own", and the one calendar is theirs too; staff no).
const maySetDaysOff = (m: Member) => can(m, "set_hours", { practitionerId: m.id }) === "yes";
// The team's note is the owner's (never shown to customers, nor to other roles).
const seesNote = (m: Member) => m.role === "OWNER";

function flashFor(c: ConsoleCtx, cc: ConsoleCopy): string | null {
  const day = anyDate(c.req.query("hd"));
  const lang = consoleLang(c.get("member").locale);
  const code = c.req.query("m");
  if (code === "holiday" && day) return cc.holAdded(dayLabelFor(day, lang));
  if (code === "holidayoff" && day) return cc.holRemoved(dayLabelFor(day, lang));
  if (code === "holidaybad") return cc.holBadDate(config.holidays.maxDaysAhead);
  return null;
}

async function daysOff(c: ConsoleCtx) {
  const m = c.get("member");
  const cc = consoleCopy(m.locale);
  const lang = consoleLang(m.locale);
  const jwt = c.get("jwt");
  const may = maySetDaysOff(m);
  const list = await upcomingHolidays(c.env.DB);
  if (!may && !list.length) return "";
  const cards = await Promise.all(
    list.map(async (h) => {
      const label = dayLabelFor(h.ymd, lang);
      // Bookings on the day that this member may open (a practitioner: their own customers').
      const booked = (await bookingsOn(c.env.DB, h.ymd)).filter((b) => can(m, "view_people", { practitionerId: b.practitionerId }) === "yes");
      const who = booked.map((b) => html`<a class="holbk" href="/app/people/${b.convId}"><span>${clock(b.startUtc, lang)} ${firstName(b.name, "")} <span class="nw">${last4(b.waId)}</span></span></a>`);
      const remove = may ? button({ label: cc.holRemove, post: { action: "/app/calendar/holiday/remove", csrf: await memberCsrf(jwt, m, `holiday:remove:${h.ymd}`), fields: { day: h.ymd } } }) : "";
      return html`<article class="card${booked.length ? " attention" : ""}"><div class="hol"><h3>${label}</h3>${remove}</div>
${seesNote(m) && h.note ? html`<p class="why">${h.note}</p>` : ""}${booked.length ? html`<p class="why">${keep4(cc.holWarn(booked.length, label))}</p><div class="holbks">${who}</div>` : ""}</article>`;
    }),
  );
  const b = holidayBounds();
  const form = may
    ? html`<form class="card holform" method="post" action="/app/calendar/holiday"><h3>${cc.holMarkTitle}</h3><p class="why">${cc.holIntro}</p>
<input type="hidden" name="csrf" value="${await memberCsrf(jwt, m, "holiday:add")}">
<label for="hol-day">${cc.holDate}</label><input id="hol-day" type="date" name="day" min="${b.min}" max="${b.max}" required>
${seesNote(m) ? html`<label for="hol-note">${cc.holReason}</label><input id="hol-note" type="text" name="note" maxlength="200" autocomplete="off">` : ""}
<button class="btn primary" type="submit">${cc.holMark}</button></form>`
    : "";
  return html`<div id="days-off">${section(cc.holTitle, html`${form}${list.length ? html`<h3 class="sub">${cc.holUpcoming}</h3>${cards}` : may ? html`<p class="calnote">${cc.holNone}</p>` : ""}`)}</div>`;
}

// Back to the week of the day, with the flash.
const backTo = (ymd: string | null, code: string) => `/app/calendar?view=week${ymd ? `&d=${ymd}&hd=${ymd}` : ""}&m=${code}#days-off`;

async function addDayOff(c: ConsoleCtx) {
  const m = c.get("member");
  if (!maySetDaysOff(m)) return refused(c);
  const f = (await c.req.parseBody()) as Record<string, string | undefined>;
  if (f.csrf !== (await memberCsrf(c.get("jwt"), m, "holiday:add"))) return c.text("Forbidden", 403);
  const day = holidayDate(f.day);
  if (!day) return c.redirect(backTo(null, "holidaybad"), 303);
  const note = seesNote(m) ? (f.note ?? "").trim().slice(0, 200) : "";
  const booked = (await bookingsOn(c.env.DB, day)).length;
  await addHoliday(c.env, day, note, auditStmt(c, "HOLIDAY_ADDED", `holiday:${day}`, `${booked} booked that day`, note || null));
  return c.redirect(backTo(day, "holiday"), 303);
}

async function removeDayOff(c: ConsoleCtx) {
  const m = c.get("member");
  if (!maySetDaysOff(m)) return refused(c);
  const f = (await c.req.parseBody()) as Record<string, string | undefined>;
  const day = anyDate(f.day);
  if (!day || f.csrf !== (await memberCsrf(c.get("jwt"), m, `holiday:remove:${day}`))) return c.text("Forbidden", 403);
  await removeHoliday(c.env, day, auditStmt(c, "HOLIDAY_REMOVED", `holiday:${day}`, ""));
  return c.redirect(backTo(day, "holidayoff"), 303);
}

export const calendar = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();
calendar.get("/", calendarPage);
calendar.post("/holiday", addDayOff);
calendar.post("/holiday/remove", removeDayOff);
