// Calendar (/app/calendar): "When am I booked or free?" (docs/CONSOLE-PRD.md, "Calendar"; ticket 27). Read-only in Phase 1.
// Week view (Monday to Sunday, this week by default), Day view, Month view (ticket 39) or List (the next 30 days, ticket 46), chosen by
// links (no script): ?view=day|week|month|list&d=YYYY-MM-DD, and for owner and staff ?p=<practitioner member id> when there is more than one practitioner.
// Each day lists its calls, sessions and live holds in time order, then the free times left (the slot generator in src/slots.ts, less every active booking or hold, exactly as the bot sees
// them), under the working hours from config. A practitioner sees only their own (the view_calendar row of the permission table is "own").
// Working hours are edited in Phase 2 (no button for it; ticket 46 took the "later release" line off the page). Days off (holidays, ticket 30) are
// marked and removed at the foot of the page by whoever may set_hours (owner; a practitioner for the one shared calendar; not staff),
// and a holiday shows as "Holiday" on its day (src/holidays.ts).
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, canAny, memberCsrf, seesNumber, type Member } from "./auth";
import { config } from "./config";
import { appPage, auditStmt, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { addHoliday, anyDate, bookingsOn, holidayBounds, holidayDate, holidaysBetween, removeHoliday, upcomingHolidays } from "./holidays";
import { consoleCopy, consoleLang, type ConsoleCopy } from "./console-copy";
import { hoursText, serviceName, type ForWhom } from "./copy";
import type { Env } from "./env";
import { dayLabelFor, generateSlots, iso, istDay, istMinutes } from "./slots";
import { TODAY_COPY } from "./today";
import {
  appointmentRow, bookingChip, bookingStatus, button, callButton, clock, dayName, emptyState, firstName, formatNumber, forWhomText, keep4, last4, phoneHtml, screenHead, section,
  statusChip,
} from "./ui";

const DAY = 86_400_000;
export type CalView = "day" | "week" | "month" | "list";

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
// Ticket 46: a calendar that reads at a glance. Desktop (1024 px and up): the Week view is a time grid like Google Calendar (a gutter of
// hours from opening to closing, half-hour lines, one column per day, Sunday a slim muted column, bookings as blocks placed and sized by
// their start and length, coloured by kind, a Now line on today); the Day view is the same grid for one day, with the free gaps, beside
// the day's list; the Month view puts up to three bookings in each day ("4:00 Asha · Call", then "+2 more") with a thin bar for how full
// the day is. Phones get a dense agenda by day instead of the grid (the Month keeps a compact grid of dots, with the month's agenda under
// it). List: the next 30 days of bookings, grouped by day. Every day opens its Day view; every booking opens the person.
const CAL_CSS = `
.calbar{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 -16px 12px;padding:8px 16px;background:color-mix(in srgb,var(--paper) 92%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.calbar .cl{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
.calbar .seg{flex:1 1 100%;justify-content:space-between}
.calbar .seg a{flex:1 1 0}
.calnav{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;flex:none}
.calnav .btn{padding:0 14px}
.calnav .arrow{min-width:44px;padding:0 10px;font-size:22px;line-height:1}
.range{font-family:var(--serif);font-size:24px;font-weight:600;line-height:1.15;color:var(--bronze);margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[lang=hi] .range{font-family:var(--sans);font-size:19px}
.calnote{color:var(--muted);margin:0 0 10px;font-size:var(--fs-3)}
.who-bar{margin:0 0 12px}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;color:var(--muted);font-size:var(--fs-3);margin:10px 0 0}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:3px;background:var(--accent)}
.legend i.s{background:var(--gold)}
.legend i.hd{background:transparent;border:1.5px dashed var(--waiting)}
.legend i.h{border-radius:2px;transform:rotate(45deg);background:var(--gold);width:8px;height:8px}
.legend i.t{background:transparent;border:2px solid var(--accent);border-radius:50%}
/* the agenda (phones; and the List view everywhere) */
.ag-day{margin:0 0 14px}
.ag-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0 0 6px;font-size:var(--fs-2);font-weight:600;color:var(--ink)}
.ag-h>a{display:inline-flex;align-items:center;min-height:var(--tap);color:inherit;text-decoration:none}
.ag-h>a:hover{color:var(--accent)}
.ag-h .ag-c{margin-left:auto;color:var(--muted);font-weight:400;font-size:var(--fs-3);white-space:nowrap}
.ag-day.past .ag-h>a{color:var(--muted)}
.ag-list{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:0 1px 2px var(--shade)}
.ag{display:flex;align-items:center;gap:8px;padding:0 10px 0 0;border-top:1px solid var(--line);position:relative}
.ag:first-child{border-top:0}
.ag::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.ag.session::before{background:var(--gold)}
.ag.held::before{background:repeating-linear-gradient(180deg,var(--waiting) 0 4px,transparent 4px 7px)}
.ag-a{flex:1 1 auto;min-width:0;display:grid;grid-template-columns:4.4em minmax(0,1fr) auto;align-items:center;gap:2px 10px;min-height:56px;padding:7px 0 7px 14px;color:var(--ink);text-decoration:none}
.ag-a:hover .ag-n{color:var(--accent)}
.ag-t{font-weight:600;color:var(--accent);white-space:nowrap;font-size:var(--fs-2)}
.session .ag-t{color:var(--waiting)}
.ag-b{min-width:0;display:flex;flex-direction:column}
.ag-n{font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.ag-n .d{white-space:nowrap}
.ag-n .d{font-weight:400;color:var(--muted);font-size:var(--fs-3);margin-left:4px}
.ag-m{color:var(--muted);font-size:var(--fs-3);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ag .btn.call{flex:none;width:44px;min-width:44px;height:44px;min-height:44px;padding:0;border-radius:999px}
.ag .btn.call span{display:none}
.ag.past{opacity:.72}
.ag-none,.ag-free{margin:0;color:var(--muted);font-size:var(--fs-3)}
.ag-free b{color:var(--ink);font-weight:500}
.ag-none{padding:10px 14px;border:1px dashed var(--line);border-radius:var(--r)}
.ag-day .ag-free{margin-top:6px}
.ag-closed{display:flex;align-items:center;gap:10px;min-height:var(--tap);margin:0 0 14px;color:var(--muted);font-size:var(--fs-3);border-top:1px dashed var(--line)}
.ag-closed b{color:var(--muted);font-weight:500}
/* the time grid (desktop Week and Day) */
.tg,.wk-only,.m-chips,.m-more{display:none}
.tg{--hh:54px;margin:0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);box-shadow:0 1px 2px var(--shade);overflow:clip}
.tg-head,.tg-body{display:grid;grid-template-columns:var(--cols)}
.tg-head{position:sticky;top:57px;z-index:4;background:var(--surface);border-bottom:1px solid var(--line);border-radius:var(--r) var(--r) 0 0}
.tg-dh{display:flex;flex-direction:column;align-items:flex-start;gap:0;padding:8px 10px 7px;border-left:1px solid var(--line);color:var(--ink);text-decoration:none;min-width:0}
.tg-dh:hover{background:var(--sunk)}
.tg-dh .dw{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
[lang=hi] .tg-dh .dw{letter-spacing:0}
.tg-dh .dl{display:flex;align-items:baseline;gap:6px}
.tg-dh .dd{font-size:20px;font-weight:600;line-height:1.2}
.tg-dh .dn{font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-tint);border-radius:999px;padding:0 7px;line-height:18px}
.tg-dh .dc{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tg-dh.today .dw{color:var(--accent)}
.tg-dh.today .dd{color:var(--on-accent);background:var(--accent);border-radius:999px;padding:0 8px;margin-left:-4px}
.tg-dh.holi .dc{color:var(--waiting);font-weight:500}
.tg-dh.past .dd{color:var(--muted)}
.tg-dh.slim{align-items:center;padding:8px 2px}
.tg-corner{border:0}
.tg-gutter{position:relative}
.tg-gutter span{position:absolute;right:8px;transform:translateY(-50%);font-size:12px;color:var(--muted);white-space:nowrap}
.tg-gutter span:first-child{transform:none;top:4px!important}
.tg-col{position:relative;border-left:1px solid var(--line);background-image:repeating-linear-gradient(180deg,var(--line) 0 1px,transparent 1px calc(var(--hh) * 2)),repeating-linear-gradient(180deg,color-mix(in srgb,var(--line) 55%,transparent) 0 1px,transparent 1px var(--hh))}
.tg-col.today{background-color:color-mix(in srgb,var(--accent-tint) 45%,transparent)}
.tg-col.holi{background-color:color-mix(in srgb,var(--waiting-tint) 60%,transparent)}
.tg-col.slim{background:repeating-linear-gradient(135deg,var(--sunk) 0 6px,transparent 6px 12px)}
.tg-col.slim .cl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
[lang=hi] .tg-col.slim .cl{writing-mode:horizontal-tb;letter-spacing:0}
.tg-past{position:absolute;left:0;right:0;top:0;background:color-mix(in srgb,var(--sunk) 55%,transparent);pointer-events:none}
.tg-col.past{background-color:color-mix(in srgb,var(--sunk) 40%,transparent)}
.ev2{position:absolute;border:1px solid var(--surface);display:flex;flex-direction:column;gap:0;overflow:hidden;padding:3px 7px 3px 9px;border-radius:7px;background:var(--accent-tint);color:var(--ink);text-decoration:none;font-size:12.5px;line-height:1.3;box-shadow:inset 3px 0 0 var(--accent),0 1px 2px var(--shade);z-index:1;transition:box-shadow .12s,transform .12s}
.ev2:hover{box-shadow:inset 3px 0 0 var(--accent),0 6px 16px -6px var(--shade);z-index:3}
.ev2.session{background:var(--waiting-tint);box-shadow:inset 3px 0 0 var(--gold),0 1px 2px var(--shade)}
.ev2.held{background:var(--surface);outline:1.5px dashed var(--waiting);outline-offset:-1.5px}
.ev2.past{opacity:.66}
.ev2 .l1{display:flex;align-items:baseline;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ev2 b{font-weight:600;color:var(--accent)}
.ev2.session b{color:var(--waiting)}
.ev2 .n{font-weight:600;flex:none}
.ev2 b{flex:none}
.ev2 .p{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ev2 .st{flex:none}
.ev2 .p,.ev2 .k{color:var(--muted)}
.ev2 .k{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev2 .st{font-weight:600;color:var(--waiting)}
.ev2 .st.attention{color:var(--attention)}
.ev2 .st.plain{color:var(--muted);font-weight:500}
.gap2{position:absolute;left:6px;right:6px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px dashed color-mix(in srgb,var(--water) 55%,var(--line));border-radius:7px;color:var(--muted);font-size:12.5px;overflow:hidden;white-space:nowrap}
.gap2 b{color:var(--done);font-weight:600}
.tg-now{position:absolute;left:-1px;right:0;height:0;border-top:2px solid var(--attention);z-index:2;pointer-events:none}
.tg-now::before{content:"";position:absolute;left:-5px;top:-6px;width:10px;height:10px;border-radius:50%;background:var(--attention)}
.tg-now span{position:absolute;right:4px;top:-18px;font-size:12px;font-weight:600;color:var(--attention);background:var(--surface);padding:0 4px;border-radius:4px}
/* the day view: a timeline (phones), beside the grid on desktop */
.cday{margin:8px 0 0}
.cday h2.sec{margin:0 0 10px;align-items:center}
.cday h2.sec>span{display:inline-flex;align-items:center;flex-wrap:wrap;gap:8px}
.free{margin:0 0 4px;color:var(--muted)}
.free b{color:var(--ink);font-weight:500}
.closed{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;min-height:48px;color:var(--muted);border-top:1px solid var(--line);padding:4px 0;margin:0}
.closed b{color:var(--ink);font-weight:500}
.tl{position:relative;margin:8px 0 12px;padding:0 0 0 26px}
.tl::before{content:"";position:absolute;left:8px;top:12px;bottom:12px;width:2px;border-radius:2px;background:linear-gradient(180deg,var(--gold),var(--water))}
.tl>*{position:relative;margin:0 0 8px}
.tl>*::before{content:"";position:absolute;left:-23px;top:20px;width:9px;height:9px;border-radius:50%;background:var(--surface);border:2px solid var(--water)}
.tl .edge{display:flex;align-items:center;min-height:28px;margin:0 0 8px;color:var(--muted);font-size:var(--fs-3);font-weight:500;letter-spacing:.04em}
.tl .edge::before{top:9px;background:var(--gold);border-color:var(--gold)}
.tl .item{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:0 14px;box-shadow:0 1px 2px var(--shade)}
.tl .item::before{background:var(--accent);border-color:var(--accent)}
.tl .item.session::before{background:var(--gold);border-color:var(--gold)}
.tl .item.held{border-style:dashed}
.tl .item .appt{border:0}
.tl .gap{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;min-height:48px;padding:6px 14px;border:1px dashed var(--line);border-radius:var(--r);background:var(--glow2);color:var(--muted);font-size:var(--fs-2)}
.tl .gap::before{top:18px;background:var(--paper);border-color:var(--line)}
.tl .gap b{color:var(--ink);font-weight:600;white-space:nowrap}
.tl .gap.past{background:transparent;border-color:transparent;min-height:32px;padding:2px 14px}
.tl .gap.past b{color:var(--muted);font-weight:500}
.tl .now{display:flex;align-items:center;gap:10px;min-height:28px;color:var(--attention);font-weight:600;font-size:var(--fs-2)}
.tl .now::after{content:"";flex:1;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--attention),transparent)}
.tl .now::before{top:9px;background:var(--attention);border-color:var(--attention);box-shadow:0 0 0 4px var(--attention-tint)}
/* the month */
.mgrid{table-layout:fixed;border-collapse:separate;border-spacing:3px;margin:0 -3px 4px;width:calc(100% + 6px)}
.mgrid th{font-size:var(--fs-3);font-weight:600;color:var(--muted);padding:2px 0 4px;text-align:center}
.mgrid td{padding:0;vertical-align:top}
.md{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;min-height:56px;padding:6px 2px 8px;border-radius:10px;background:var(--surface);border:1px solid var(--line);color:var(--ink);text-decoration:none;overflow:hidden}
.md:hover{border-color:var(--muted)}
.md .dn{font-size:16px;font-weight:600;line-height:1.5;min-width:26px;text-align:center;border-radius:999px}
.md .dots{display:flex;flex-wrap:wrap;justify-content:center;gap:3px;max-width:40px}
.md .dots i{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.md .dots i.s{background:var(--gold)}
.md .tag{display:none}
.md .mbar{position:absolute;left:6px;right:6px;bottom:4px;height:3px;border-radius:3px;background:var(--sunk);overflow:hidden}
.md .mbar::after{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--b);border-radius:3px;background:linear-gradient(90deg,var(--water),var(--accent))}
.md.out{background:transparent;border-color:transparent;color:var(--muted);opacity:.55}
.md.past:not(.out){background:color-mix(in srgb,var(--sunk) 60%,var(--surface))}
.md.past .dn{color:var(--muted)}
.md.holi{background:var(--waiting-tint);border-color:color-mix(in srgb,var(--gold) 70%,var(--line))}
.md.holi::after{content:"";width:7px;height:7px;margin-top:2px;border-radius:2px;transform:rotate(45deg);background:var(--gold)}
.md.closed{background:transparent;border-color:transparent;color:var(--muted)}
.md.today .dn{background:var(--accent);color:var(--on-accent)}
.md.today{border-color:var(--accent);box-shadow:0 0 0 2px var(--glow)}
.m-agenda{margin-top:16px}
/* days off */
.holform{max-width:420px}
.holform label{display:block;font-weight:500;margin:0 0 4px}
.holform input{display:block;width:100%;min-height:var(--ctl);font:inherit;font-size:var(--fs-in);color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:6px 12px;margin:0 0 14px}
.hol{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.holbks{display:flex;flex-direction:column;margin:4px 0 0}
.holbk{display:flex;align-items:center;min-height:var(--tap);color:var(--ink)}
h3.sub{font-size:var(--fs-3);font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}
.hols>div>h3.sub:first-child{margin-top:0}
@media (min-width:640px){.calbar .seg{flex:0 0 auto}.calbar .seg a{flex:0 0 auto}}
@media (min-width:900px){.calbar{margin:-28px -36px 14px;padding:10px 36px}}
@media (min-width:1024px){
.calbar{margin:-24px -32px 14px;padding:10px 32px;min-height:57px;flex-wrap:nowrap}
.calbar .cl{gap:14px}
.calnav .arrow{min-width:36px;font-size:20px}
.range{font-size:24px}
.calnote{margin:0 0 12px}
.ag-only{display:none}
.wk-only{display:block}
.tg{display:block}
.dayview{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,1fr);gap:20px;align-items:start}
.dayview .cday{margin:0}
.dayview .appt{grid-template-columns:5.2em minmax(0,1fr);gap:6px 12px;padding:10px 0}
.dayview .appt .side{grid-column:2;justify-content:flex-start}
.ag{padding-right:12px}
.ag-a{grid-template-columns:5.6em minmax(0,1fr) auto;min-height:44px;padding:5px 0 5px 16px}
.ag-b{flex-direction:row;align-items:baseline;gap:14px}
.ag-n{flex:0 0 auto;min-width:12em;white-space:nowrap}
.ag-m{-webkit-line-clamp:1}
.ag .btn.call{width:auto;height:30px;min-height:30px;padding:0 10px;border-radius:var(--r-sm);font-size:13px}
.ag .btn.call span{display:inline}
.ag-h>a{min-height:0}
.ag-h{margin:0 0 6px}
.mgrid{border-spacing:0;margin:0;width:100%;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);overflow:hidden;box-shadow:0 1px 2px var(--shade)}
.mgrid th{padding:8px 10px;text-align:left;font-size:12px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--line)}
[lang=hi] .mgrid th{letter-spacing:0}
.mgrid td{border-top:1px solid var(--line);border-left:1px solid var(--line)}
.mgrid tr:first-child td{border-top:0}
.mgrid td:first-child{border-left:0}
.md{align-items:stretch;min-height:118px;padding:6px 8px 12px;gap:2px;border:0;border-radius:0;background:transparent}
.md:hover{background:var(--sunk);border:0}
.md .dn{align-self:flex-start;font-size:13px;min-width:24px;line-height:24px;margin:0 0 2px}
.md .dots{display:none}
.mdw{position:relative}
.m-chips{position:absolute;left:8px;right:8px;top:32px;z-index:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.mc{display:block;padding:1px 6px;border-radius:5px;font-size:12px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--accent-tint);color:var(--ink);text-decoration:none;box-shadow:inset 2px 0 0 var(--accent)}
.mc:hover{filter:brightness(.96);box-shadow:inset 2px 0 0 var(--accent),0 2px 6px -2px var(--shade)}
.mc b{font-weight:600;color:var(--accent)}
.mc.session{background:var(--waiting-tint);box-shadow:inset 2px 0 0 var(--gold)}
.mc.session b{color:var(--waiting)}
.mc.held{background:transparent;outline:1px dashed var(--waiting);outline-offset:-1px}
.m-more{display:block;font-size:12px;font-weight:600;color:var(--muted);padding:0 6px;text-decoration:none}
.m-more:hover{color:var(--accent)}
.md .tag{display:block;font-size:12px;font-weight:600;color:var(--waiting)}
.md.holi{background:color-mix(in srgb,var(--waiting-tint) 70%,transparent);border:0}
.md.holi::after{position:absolute;top:10px;right:10px;margin:0}
.md.today{box-shadow:inset 0 0 0 2px var(--accent);border:0}
.md.past:not(.out){background:color-mix(in srgb,var(--sunk) 45%,transparent)}
.md.closed,.md.closed.past:not(.out){background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--sunk) 70%,transparent) 0 6px,transparent 6px 12px)}
.md.past .mc{opacity:.7}
.md.out{opacity:.45}
.md .mbar{left:8px;right:8px;bottom:6px}
.m-agenda{display:none}
.hols{display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);gap:16px;align-items:start}
.hols .holform{max-width:none;margin:0}
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
const noName = (m: Member) => TODAY_COPY[consoleLang(m.locale)].noName;
// "4:00" for a small block or chip, in either language: the grid's gutter and the day already say which part of the day it is.
const shortClock = (utc: string, locale: string) => /\d{1,2}:\d{2}/.exec(clock(utc, locale))?.[0] ?? clock(utc, locale);
const weekdayShort = (ymd: string, cc: ConsoleCopy) => cc.calWeekdays.split(" ")[(new Date(utcOf(ymd)).getUTCDay() + 6) % 7];
// Minutes since midnight in India; a booking ending at midnight ends at 1440.
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const startMin = (e: { startUtc: string }) => Math.round(istMinutes(e.startUtc));
const endMin = (e: { startUtc: string; endUtc: string }) => {
  const x = Math.round(istMinutes(e.endUtc));
  return x <= startMin(e) ? 1440 : x;
};
const CONFIRMED = ["PAID", "RESCHEDULED", "CONFIRMED", "CREDIT_BOOKED"];

// What a booking is, in words: "15-minute call", "Session 3 of 10, from a package", who it's for, a hold's lapse, whose calendar.
function entryDetails(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const t = TODAY_COPY[consoleLang(m.locale)];
  const kind = e.kind === "CALL" ? t.kindCall(config.slots.callMinutes) : e.packSize ? t.kindSessionPackage(e.packNo ?? 0, e.packSize) : t.kindSession;
  const details = [kind, forWhomText(e.forWhom, m.locale)];
  if (e.state === "HELD" && e.holdUntil) details.push(cc.calHeldUntil(clock(e.holdUntil, m.locale)));
  if (many && e.practitionerId !== null && many.has(e.practitionerId)) details.push(many.get(e.practitionerId)!);
  return details.filter(Boolean);
}
// Ticket 47: a booking opens the person page with that booking chosen for a note.
const personHref = (e: Entry) => `/app/people/${e.convId}?b=${e.kind}-${e.id}#notes`;
const evClass = (e: Entry) => `${e.kind === "CALL" ? "call" : "session"}${e.state === "HELD" ? " held" : ""}`;

// The Day view's row (the timeline): the full appointment row, with the number and a one-tap Call for whoever may see it, and Open.
function entryRow(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const lang = consoleLang(m.locale);
  const full = seesNumber(m, e.practitionerId);
  return appointmentRow({
    time: clock(e.startUtc, lang),
    name: firstName(e.name, noName(m)),
    phone: phoneHtml(e.waId, full),
    service: serviceName(e.service, lang),
    details: entryDetails(e, m, cc, many),
    status: bookingChip(e.state, m.locale),
    call: full ? callButton(e.waId, cc.call) : "",
    action: { label: cc.open, href: personHref(e), kind: "secondary" }, // ticket 47: the booking chosen for a note
  });
}

type DayArgs = { ymd: string; entries: Entry[]; busy: { startUtc: string; endUtc: string }[]; m: Member; cc: ConsoleCopy; nowMs: number; p: number | null; many: Map<number, string> | null; holiday: boolean };

// ---------- the agenda: one line per booking (phones; the List view) ----------
function agendaRow(e: Entry, o: DayArgs) {
  const { m, cc } = o;
  const lang = consoleLang(m.locale);
  const full = seesNumber(m, e.practitionerId);
  const st = bookingStatus(e.state, m.locale);
  const meta = [serviceName(e.service, lang), ...entryDetails(e, m, cc, o.many)].join(" · ");
  const past = Date.parse(e.endUtc) <= o.nowMs;
  // The row opens the person; the number is text in it (a link can't hold another), with a one-tap Call beside it.
  return html`<div class="ag ${evClass(e)}${past ? " past" : ""}"><a class="ag-a" href="${personHref(e)}"><span class="ag-t">${clock(e.startUtc, lang)}</span><span class="ag-b"><span class="ag-n">${firstName(e.name, noName(m))} <span class="d">${full ? formatNumber(e.waId) : last4(e.waId)}</span></span><span class="ag-m">${meta}</span></span>${
    st && !st.confirmed ? statusChip(st.word, st.tone) : ""
  }</a>${full ? callButton(e.waId, cc.call) : ""}</div>`;
}

// One day of the agenda: its heading (a link to its Day view) with the count and free time, then its bookings. A closed day with nothing
// on it is one quiet line; `quietEmpty` leaves out a working day with nothing booked (the List view).
function agendaDay(o: DayArgs, opts: { quietEmpty?: boolean; freeLine?: boolean } = {}) {
  const { ymd, m, cc } = o;
  const lang = consoleLang(m.locale);
  const label = dayLabelFor(ymd, lang);
  const today = ymd === istDay(o.nowMs);
  const past = dayEndMs(ymd) <= o.nowMs;
  const working = isWorkingDay(ymd);
  if (!o.entries.length && !o.holiday && (!working || opts.quietEmpty)) return working ? "" : html`<p class="ag-closed"><b>${label}</b><span>${cc.calClosedShort}</span></p>`;
  const free = past || !working || o.holiday ? [] : freeRanges(ymd, o.busy, o.nowMs);
  const freeMin = free.reduce((n, r) => n + minutesOf(r), 0);
  const count = [o.entries.length ? cc.calBooked(o.entries.length) : "", freeMin ? cc.calFreeFor(durationOf(freeMin, cc)) : !past && working && !o.holiday ? cc.calNoFree : ""].filter(Boolean).join(" · ");
  const chips = html`${today ? statusChip(cc.calToday, "accent") : ""}${o.holiday ? statusChip(cc.calHoliday, o.entries.length ? "attention" : "waiting") : ""}`;
  const list = o.entries.length ? html`<div class="ag-list">${o.entries.map((e) => agendaRow(e, o))}</div>` : html`<p class="ag-none">${o.holiday ? cc.calHolidayLine : cc.calNothing}</p>`;
  const freeLine = opts.freeLine && free.length ? html`<p class="ag-free vh">${keepTimes(cc.calFree(free.map((r) => rangeText(r, lang)).join(" · ")))}</p>` : "";
  return html`<section class="ag-day${today ? " today" : ""}${past ? " past" : ""}" id="d-${ymd}"><h3 class="ag-h"><a href="${link({ view: "day", d: ymd, p: o.p })}">${label}</a>${chips}<span class="ag-c">${count}</span></h3>${list}${freeLine}</section>`;
}

// ---------- the time grid (desktop Week and Day) ----------
// Opening to closing from config, widened to the hour around any booking outside it.
function gridHours(entries: Entry[]) {
  let open = toMin(config.hours.start);
  let close = toMin(config.hours.end);
  for (const e of entries) {
    open = Math.min(open, startMin(e));
    close = Math.max(close, endMin(e));
  }
  return { open: Math.floor(open / 60) * 60, close: Math.min(1440, Math.ceil(close / 60) * 60) };
}
// Side by side when two overlap (one calendar makes that rare: a hold and a booking from before a change).
function lanesOf(es: Entry[]) {
  const out = new Map<Entry, { lane: number; of: number }>();
  let group: Entry[] = [];
  let groupEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const e of group) {
      let lane = ends.findIndex((x) => x <= startMin(e));
      if (lane < 0) lane = ends.length;
      ends[lane] = endMin(e);
      out.set(e, { lane, of: 0 });
    }
    for (const e of group) out.get(e)!.of = ends.length;
    group = [];
  };
  for (const e of [...es].sort((a, b) => startMin(a) - startMin(b))) {
    if (group.length && startMin(e) >= groupEnd) flush();
    group.push(e);
    groupEnd = Math.max(groupEnd, endMin(e));
  }
  flush();
  return out;
}

function gridBlock(e: Entry, o: DayArgs & { open: number; px: number; lane: { lane: number; of: number } }) {
  const { m, cc } = o;
  const lang = consoleLang(m.locale);
  const top = (startMin(e) - o.open) * o.px;
  const height = Math.max(20, (endMin(e) - startMin(e)) * o.px - 2);
  const st = bookingStatus(e.state, m.locale);
  const status = st && !st.confirmed ? st : null;
  const name = firstName(e.name, noName(m));
  const kind = e.kind === "CALL" ? cc.calShortCall : cc.calShortSession;
  const details = [serviceName(e.service, lang), ...entryDetails(e, m, cc, o.many)].join(" · ");
  const title = [`${clock(e.startUtc, lang)} – ${clock(e.endUtc, lang)}`, `${name} ${last4(e.waId)}`, details, status?.word ?? ""].filter(Boolean).join(" · ");
  // Overlapping bookings (rare: one calendar) are drawn as Google Calendar does: the first full width, each later one indented and on top,
  // so every block keeps enough width for its time and name (the tooltip has the rest).
  const left = o.lane.of > 1 ? (o.lane.lane * 40) / (o.lane.of - 1) : 0;
  const style = `top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;left:calc(${left.toFixed(2)}% + 3px);width:calc(${(100 - left).toFixed(2)}% - 6px)${o.lane.lane ? `;z-index:${1 + o.lane.lane}` : ""}`;
  const past = Date.parse(e.endUtc) <= o.nowMs;
  const st1 = status ? html` <span class="st ${status.tone}">${status.word}</span>` : "";
  const body =
    height < 40
      ? html`<span class="l1"><b>${shortClock(e.startUtc, lang)}</b><span class="n">${name}</span><span class="p">${last4(e.waId)}</span>${st1}</span>`
      : html`<span class="l1"><b>${clock(e.startUtc, lang)} – ${clock(e.endUtc, lang)}</b></span><span class="l1"><span class="n">${name}</span><span class="p">${last4(e.waId)}</span>${st1}</span><span class="k">${kind} · ${serviceName(e.service, lang)}</span>`;
  return html`<a class="ev2 ${evClass(e)}${past ? " past" : ""}" href="${personHref(e)}" style="${style}" title="${title}" aria-label="${title}">${body}</a>`;
}

// The grid: a gutter of hours and one column per day. A closed day with nothing on it is a slim hatched column.
function timeGrid(days: DayArgs[], o: { px: number; gaps?: boolean }) {
  const all = days.flatMap((d) => d.entries);
  const { open, close } = gridHours(all);
  const height = (close - open) * o.px;
  const { m, cc, nowMs } = days[0];
  const lang = consoleLang(m.locale);
  const todayYmd = istDay(nowMs);
  const slim = (d: DayArgs) => days.length > 1 && !d.entries.length && !d.holiday && !isWorkingDay(d.ymd);
  const cols = `52px ${days.map((d) => (slim(d) ? "40px" : "minmax(0,1fr)")).join(" ")}`;
  const at = (ymd: string, min: number) => iso(Date.parse(dayStartUtc(ymd)) + min * 60_000);
  const hours: unknown[] = [];
  for (let h = open; h < close; h += 60) hours.push(html`<span style="top:${((h - open) * o.px).toFixed(1)}px">${clock(at(days[0].ymd, h), lang).replace(":00", "")}</span>`);
  const head = days.map((d) => {
    const today = d.ymd === todayYmd;
    const past = dayEndMs(d.ymd) <= nowMs;
    const href = link({ view: "day", d: d.ymd, p: d.p });
    const num = Number(d.ymd.slice(8));
    if (slim(d)) return html`<a class="tg-dh slim" href="${href}" aria-label="${dayLabelFor(d.ymd, lang)}, ${cc.calClosedShort}"><span class="dw">${weekdayShort(d.ymd, cc)}</span><span class="dd">${num}</span></a>`;
    const free = past || d.holiday || !isWorkingDay(d.ymd) ? 0 : freeRanges(d.ymd, d.busy, nowMs).reduce((n, r) => n + minutesOf(r), 0);
    const sub = d.holiday ? cc.calHoliday : past || !isWorkingDay(d.ymd) ? (d.entries.length ? cc.calBooked(d.entries.length) : cc.calNothing) : free ? cc.calFreeFor(durationOf(free, cc)) : cc.calFullyBooked;
    const aria = [dayLabelFor(d.ymd, lang), d.entries.length ? cc.calBooked(d.entries.length) : cc.calNothing, sub].join(", ");
    return html`<a class="tg-dh${today ? " today" : ""}${past ? " past" : ""}${d.holiday ? " holi" : ""}" href="${href}" aria-label="${aria}"${today ? raw(' aria-current="date"') : ""}><span class="dw">${weekdayShort(d.ymd, cc)}</span><span class="dl"><span class="dd">${num}</span>${d.entries.length ? html`<span class="dn">${d.entries.length}</span>` : ""}</span><span class="dc">${sub}</span></a>`;
  });
  const body = days.map((d) => {
    const today = d.ymd === todayYmd;
    const past = dayEndMs(d.ymd) <= nowMs;
    if (slim(d)) return html`<div class="tg-col slim" style="height:${height}px"><span class="cl">${cc.calClosedShort}</span></div>`;
    const lanes = lanesOf(d.entries);
    const blocks = d.entries.map((e) => gridBlock(e, { ...d, open, px: o.px, lane: lanes.get(e)! }));
    const gaps =
      o.gaps && !past && !d.holiday
        ? freeRanges(d.ymd, d.busy, nowMs).map((r) => {
            const top = (startMin({ startUtc: r.from }) - open) * o.px;
            const h = Math.max(18, minutesOf(r) * o.px - 4);
            return html`<div class="gap2" style="top:${(top + 2).toFixed(1)}px;height:${h.toFixed(1)}px"><b>${cc.calFreeGap}</b><span>${rangeText(r, lang)} · ${durationOf(minutesOf(r), cc)}</span></div>`;
          })
        : [];
    const nowMin = istMinutes(iso(nowMs));
    const nowY = (nowMin - open) * o.px;
    const nowLine = today && nowMin >= open && nowMin <= close ? html`<div class="tg-now" style="top:${nowY.toFixed(1)}px"><span>${clock(iso(nowMs), lang)}</span></div>` : "";
    const gone = today && nowMin > open ? html`<div class="tg-past" style="height:${Math.min(height, nowY).toFixed(1)}px"></div>` : "";
    return html`<div class="tg-col${today ? " today" : ""}${past ? " past" : ""}${d.holiday ? " holi" : ""}" style="height:${height}px">${gone}${gaps}${blocks}${nowLine}</div>`;
  });
  return html`<div class="tg" style="--cols:${cols};--hh:${30 * o.px}px"><div class="tg-head"><span class="tg-corner"></span>${head}</div><div class="tg-body"><div class="tg-gutter" style="height:${height}px">${hours}</div>${body}</div></div>`;
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

// The Month view: Monday to Sunday, every week that touches the month; each day a link to its Day view. Desktop: up to three bookings
// as small chips, then "+2 more", and a thin bar for how much of the working day is booked. Phones: a dot per booking.
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
    const cls = ["md", ymd.slice(0, 7) !== month ? "out" : "", dayEndMs(ymd) <= o.nowMs ? "past" : "", ymd === todayYmd ? "today" : "", hol ? "holi" : closed ? "closed" : ""].filter(Boolean).join(" ");
    const kinds = [calls ? cc.calCalls(calls) : "", sessions ? cc.calSessions(sessions) : ""].filter(Boolean).join(" · ");
    const aria = [dayLabelFor(ymd, lang), es.length ? `${cc.calBooked(es.length)} (${kinds})` : cc.calNothing, hol ? cc.calHoliday : closed ? cc.calClosedShort : ""].filter(Boolean).join(", ");
    const dots = es.slice(0, 8).map((e) => raw(e.kind === "CALL" ? "<i></i>" : '<i class="s"></i>'));
    // Each chip opens the person with that booking chosen (ticket 47); the rest of the cell opens the day (the link under them).
    const chips = es.slice(0, 3).map((e) => {
      const what = `${shortClock(e.startUtc, lang)} ${firstName(e.name, noName(m))} · ${e.kind === "CALL" ? cc.calShortCall : cc.calShortSession}`;
      return html`<a class="mc ${evClass(e)}" href="${personHref(e)}" title="${clock(e.startUtc, lang)} ${firstName(e.name, noName(m))} ${last4(e.waId)}"><b>${shortClock(e.startUtc, lang)}</b> ${what.slice(what.indexOf(" ") + 1)}</a>`;
    });
    // How full the working day is: booked minutes over the working minutes.
    const work = generateSlots(ymd, "CALL").length * config.slots.callMinutes;
    const booked = es.reduce((n, e) => n + (endMin(e) - startMin(e)), 0);
    const bar = work && booked && !hol && ymd.slice(0, 7) === month ? html`<span class="mbar" style="--b:${Math.min(100, Math.round((booked / work) * 100))}%" title="${cc.calBusyLabel(Math.min(100, Math.round((booked / work) * 100)))}"></span>` : "";
    const dayHref = link({ view: "day", d: ymd, p: o.p });
    return html`<td><div class="mdw"><a class="${cls}" href="${dayHref}" aria-label="${aria}"${ymd === todayYmd ? raw(' aria-current="date"') : ""}><span class="dn">${Number(ymd.slice(8))}</span>${
      es.length ? html`<span class="dots" aria-hidden="true">${dots}</span>` : ""
    }${hol ? html`<span class="tag" aria-hidden="true">${cc.calHoliday}</span>` : ""}${bar}</a>${
      es.length ? html`<span class="m-chips">${chips}${es.length > 3 ? html`<a class="m-more" href="${dayHref}">${cc.calMore(es.length - 3)}</a>` : ""}</span>` : ""
    }</div></td>`;
  };
  const weeks: string[][] = [];
  for (let i = 0; i < o.days.length; i += 7) weeks.push(o.days.slice(i, i + 7));
  const head = cc.calWeekdays.split(" ").map((d) => html`<th scope="col">${d}</th>`);
  return html`<table class="mgrid"><thead><tr>${head}</tr></thead><tbody>${weeks.map((w) => html`<tr>${w.map(cell)}</tr>`)}</tbody></table>${legend(m, cc)}`;
}
const legend = (m: Member, cc: ConsoleCopy) => {
  const t = TODAY_COPY[consoleLang(m.locale)];
  return html`<p class="legend"><span><i></i>${t.kindCall(config.slots.callMinutes)}</span><span><i class="s"></i>${t.kindSession}</span><span><i class="hd"></i>${cc.bookingHeld}</span><span><i class="h"></i>${cc.calHoliday}</span><span><i class="t"></i>${cc.calToday}</span></p>`;
};

const monthTitle = (first: string, cc: ConsoleCopy) => `${cc.calMonthNames.split(" ")[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
const monthStart = (ymd: string) => `${ymd.slice(0, 8)}01`;
const addMonths = (first: string, n: number) => {
  const d = new Date(utcOf(first));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const LIST_DAYS = 30;

async function calendarPage(c: ConsoleCtx) {
  const m = c.get("member");
  if (!canAny(m, "view_calendar")) return refused(c);
  const cc = consoleCopy(m.locale);
  const lang = consoleLang(m.locale);
  const nowMs = Date.now();
  const asked = c.req.query("view");
  const view: CalView = asked === "day" || asked === "month" || asked === "list" ? asked : "week";
  const d = validDay(c.req.query("d")) ?? istDay(nowMs);

  // Whose calendar: a practitioner only their own; owner and staff everyone's, or one practitioner's when there is more than one.
  const all = can(m, "view_calendar") === "yes";
  const team = all ? await practitioners(c.env, m) : [];
  const pAsked = Number(c.req.query("p"));
  const picked = all && team.length > 1 && team.some((x) => x.id === pAsked) ? pAsked : null;
  const scope = all ? picked : m.id;
  const many = all && team.length > 1 && picked === null ? new Map(team.map((x) => [x.id, x.name])) : null;

  // The days on the page: one; Monday to Sunday; every week that touches the month; or 30 days from the day.
  const first = monthStart(d);
  const days =
    view === "week"
      ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(d), i))
      : view === "list"
        ? Array.from({ length: LIST_DAYS }, (_, i) => addDays(d, i))
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

  // Previous and next: a day, a week (Monday to Monday), a month (the 1st to the 1st) or 30 days.
  const todayYmd = istDay(nowMs);
  const step = (n: number) => (view === "month" ? addMonths(first, n) : view === "week" ? addDays(days[0], 7 * n) : view === "list" ? addDays(d, LIST_DAYS * n) : addDays(d, n));
  const here = (o: Partial<{ view: CalView; d: string; p: number | null }>) => link({ view, d, p: picked, ...o });
  const showingToday = view === "month" ? todayYmd.slice(0, 7) === first.slice(0, 7) : days.includes(todayYmd);
  // Switching view keeps the day in sight: today if it is on the page, else the day asked for (Week, Day, List) or the 1st (Month).
  const keep = showingToday ? todayYmd : view === "month" ? first : view === "week" ? days[0] : d;
  const VIEWS: [CalView, string][] = [["day", cc.calDay], ["week", cc.calWeek], ["month", cc.calMonth], ["list", cc.calList]];
  const viewSeg = html`<nav class="seg" aria-label="${cc.calViewLabel4}">${VIEWS.map(
    ([v, word]) => html`<a href="${here({ view: v, d: v === view ? d : keep })}"${v === view ? raw(' class="on" aria-current="page"') : ""}>${word}</a>`,
  )}</nav>`;
  const prevWord = { day: cc.calPrevDay, week: cc.calPrevWeek, month: cc.calPrevMonth, list: cc.calPrevList }[view];
  const nextWord = { day: cc.calNextDay, week: cc.calNextWeek, month: cc.calNextMonth, list: cc.calNextList }[view];
  const nav = html`<nav class="calnav" aria-label="${cc.calViewLabel4}">
<a class="btn arrow" href="${here({ d: step(-1) })}" aria-label="${prevWord}" title="${prevWord}">‹</a>
<a class="btn${showingToday ? " primary" : ""}" href="${here({ d: todayYmd })}"${showingToday ? raw(' aria-current="date"') : ""}>${cc.calToday}</a>
<a class="btn arrow" href="${here({ d: step(1) })}" aria-label="${nextWord}" title="${nextWord}">›</a></nav>`;
  const filter =
    all && team.length > 1
      ? html`<nav class="seg who" aria-label="${cc.calWhose}">${[{ id: null as number | null, name: cc.calEveryone }, ...team].map(
          (x) => html`<a href="${link({ view, d, p: x.id })}"${x.id === picked ? raw(' class="on" aria-current="page"') : ""}>${x.name}</a>`,
        )}</nav>`
      : "";
  // "2 Nov – 8 Nov": the weekday left off so the range fits beside ‹ Today › on a phone.
  const noWeekday = (ymd: string) => dayLabelFor(ymd, lang).replace(/^[^,]+,\s*/, "");
  const rangeLabel =
    view === "week" || view === "list" ? `${noWeekday(days[0])} – ${noWeekday(days.at(-1)!)}` : view === "month" ? monthTitle(first, cc) : dayLabelFor(d, lang);

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
          : view === "list"
            ? nextText ? cc.calEmptyListNext(nextText) : cc.calEmptyList
            : nextText ? cc.calEmptyDay(nextText) : cc.calEmptyDayNone;
    empty = emptyState(sentence, next ? { label: cc.calGoNext, href: link({ view: "day", d: istDay(Date.parse(next)), p: picked }) } : undefined);
  }
  const byDay = (ymd: string) => entries.filter((e) => istDay(Date.parse(e.startUtc)) === ymd);
  const args = (ymd: string): DayArgs => ({ ymd, entries: byDay(ymd), busy, m, cc, nowMs, p: picked, many, holiday: holidays.has(ymd) });
  let main: unknown;
  if (view === "month") {
    // Under the phone's grid: the month's days with bookings (this month: from today on).
    const agenda = days.filter((x) => x.slice(0, 7) === first.slice(0, 7) && x >= (showingToday ? todayYmd : "") && (byDay(x).length || holidays.has(x))).map((x) => agendaDay(args(x), { quietEmpty: true }));
    main = html`${monthGrid({ first, days, entries, holidays, m, cc, nowMs, p: picked })}${agenda.length ? html`<div class="m-agenda">${agenda}</div>` : ""}`;
  } else if (view === "week") {
    const ds = days.map(args);
    main = html`${timeGrid(ds, { px: 1.8 })}<div class="wk-only">${legend(m, cc)}</div><div class="ag-only">${ds.map((x) => agendaDay(x, { freeLine: true }))}</div>`;
  } else if (view === "list") {
    // A closed day with nothing on it is noise in a 30-day list: only days with bookings or a holiday.
    main = days.filter((x) => byDay(x).length || holidays.has(x)).map((x) => agendaDay(args(x), { quietEmpty: true }));
  } else {
    const a = args(d);
    main = isWorkingDay(d) || a.entries.length ? html`<div class="dayview">${timeGrid([a], { px: 2.4, gaps: true })}${dayTimeline(a)}</div>` : dayTimeline(a);
  }

  const body = html`<style>${raw(CAL_CSS)}</style>${screenHead("calendar", m.locale)}
<div class="calbar"><div class="cl">${nav}<p class="range">${rangeLabel}</p></div>${viewSeg}</div>${filter ? html`<div class="who-bar">${filter}</div>` : ""}
${view !== "day" ? html`<p class="calnote">${hoursText(lang)}</p>` : ""}
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
  return html`<div id="days-off">${section(cc.holTitle, html`<div class="hols">${form}<div>${list.length ? html`<h3 class="sub">${cc.holUpcoming}</h3>${cards}` : may ? html`<p class="calnote">${cc.holNone}</p>` : ""}</div></div>`)}</div>`;
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
