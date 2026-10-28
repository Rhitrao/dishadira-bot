// Calendar (/app/calendar): "When am I booked or free?" (docs/CONSOLE-PRD.md, "Calendar"; ticket 27). Read-only in Phase 1.
// Week view (Monday to Sunday, this week by default) or Day view, chosen by links (no script): ?view=day|week&d=YYYY-MM-DD, and for owner
// and staff ?p=<practitioner member id> when there is more than one practitioner. Each day lists its calls, sessions and live holds in
// time order, then the free times left (the slot generator in src/slots.ts, less every active booking or hold, exactly as the bot sees
// them), under the working hours from config. A practitioner sees only their own (the view_calendar row of the permission table is "own").
// Working hours and time off are edited in Phase 2; the page says so in one line and draws no button for it.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, canAny, type Member } from "./auth";
import { config } from "./config";
import { appPage, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy, consoleLang, type ConsoleCopy } from "./console-copy";
import { hoursText, serviceName, type ForWhom } from "./copy";
import type { Env } from "./env";
import { dayLabelFor, generateSlots, iso, istDay } from "./slots";
import { TODAY_COPY } from "./today";
import { appointmentRow, bookingChip, clock, dayName, emptyState, firstName, forWhomText, ledger, screenHead, statusChip } from "./ui";

const DAY = 86_400_000;
export type CalView = "day" | "week";

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
const CAL_CSS = `
.seg{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.seg a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 16px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-decoration:none;font-weight:500}
.seg a.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.calbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
.calnav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.calnav .btn{padding:10px 16px}
.calnav .arrow{min-width:48px;padding:10px 12px}
.range{font-size:20px;font-weight:600;margin:0 0 4px}
.calnote{color:var(--muted);margin:0 0 4px}
.cday{margin:24px 0 0}
.cday h2.sec{margin:0 0 12px}
.cday h2.sec a{color:inherit;text-decoration:none}
.cday h2.sec a:hover{text-decoration:underline}
.cday .chip{text-transform:none;letter-spacing:0}
.free{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0 0 4px;color:var(--muted)}
.free b{color:var(--done);font-weight:600}
.closed{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;color:var(--muted);border-top:1px solid var(--line);padding:12px 0;margin:0}
.closed+.closed{border-top-style:dashed}
.closed b{color:var(--ink);font-weight:500}
.cday .ledger{margin-bottom:8px}
@media (min-width:900px){.calbar{flex-wrap:nowrap}}
`;

const link = (o: { view: CalView; d: string; p: number | null }) => `/app/calendar?view=${o.view}&d=${o.d}${o.p !== null ? `&p=${o.p}` : ""}`;
const rangeText = (r: Range, locale: string) => `${clock(r.from, locale)} – ${clock(r.to, locale)}`;
const isWorkingDay = (ymd: string) => generateSlots(ymd, "CALL").length > 0;

function entryRow(e: Entry, m: Member, cc: ConsoleCopy, many: Map<number, string> | null) {
  const lang = consoleLang(m.locale);
  const t = TODAY_COPY[lang];
  const kind = e.kind === "CALL" ? t.kindCall(config.slots.callMinutes) : e.packSize ? t.kindSessionPackage(e.packNo ?? 0, e.packSize) : t.kindSession;
  const details = [kind, forWhomText(e.forWhom, m.locale)];
  if (e.state === "HELD" && e.holdUntil) details.push(cc.calHeldUntil(clock(e.holdUntil, m.locale)));
  if (many && e.practitionerId !== null && many.has(e.practitionerId)) details.push(many.get(e.practitionerId)!);
  return appointmentRow({
    time: clock(e.startUtc, lang),
    name: firstName(e.name, t.noName),
    waId: e.waId,
    service: serviceName(e.service, lang),
    details,
    status: bookingChip(e.state, m.locale),
    action: { label: cc.open, href: `/app/people/${e.convId}`, kind: "secondary" },
  });
}

// One day: its heading (a link to the Day view from the Week), its bookings, its free times. A day off is one quiet line.
function dayBlock(o: { ymd: string; entries: Entry[]; busy: { startUtc: string; endUtc: string }[]; m: Member; cc: ConsoleCopy; nowMs: number; view: CalView; p: number | null; many: Map<number, string> | null }) {
  const { ymd, m, cc } = o;
  const lang = consoleLang(m.locale);
  const label = dayLabelFor(ymd, lang);
  const today = ymd === istDay(o.nowMs);
  const working = isWorkingDay(ymd);
  if (!working && !o.entries.length) {
    return html`<p class="closed"><b>${label}</b><span>${cc.calClosed}</span></p>`;
  }
  const slots = generateSlots(ymd, "CALL");
  const hours = slots.length ? cc.calOpen(clock(slots[0].startUtc, lang), clock(slots.at(-1)!.endUtc, lang)) : cc.calClosed;
  const past = Date.parse(dayStartUtc(addDays(ymd, 1))) <= o.nowMs;
  const free = freeRanges(ymd, o.busy, o.nowMs);
  const freeLine = past || !working ? "" : free.length ? html`<p class="free"><b>${cc.calFree(free.map((r) => rangeText(r, lang)).join(", "))}</b></p>` : html`<p class="free">${cc.calNoFree}</p>`;
  const title = o.view === "week" ? html`<a href="${link({ view: "day", d: ymd, p: o.p })}">${label}</a>` : html`${label}`;
  const count = o.entries.length ? cc.calBooked(o.entries.length) : cc.calNothing;
  return html`<section class="cday" id="d-${ymd}"><h2 class="sec"><span>${title}${today ? html` ${statusChip(cc.calToday, "accent")}` : ""}</span><span class="n">${count}</span></h2>
${o.entries.length ? ledger(o.entries.map((e) => entryRow(e, m, cc, o.many))) : ""}${freeLine}<p class="calnote">${hours}</p></section>`;
}

async function calendarPage(c: ConsoleCtx) {
  const m = c.get("member");
  if (!canAny(m, "view_calendar")) return refused(c);
  const cc = consoleCopy(m.locale);
  const lang = consoleLang(m.locale);
  const nowMs = Date.now();
  const view: CalView = c.req.query("view") === "day" ? "day" : "week";
  const d = validDay(c.req.query("d")) ?? istDay(nowMs);

  // Whose calendar: a practitioner only their own; owner and staff everyone's, or one practitioner's when there is more than one.
  const all = can(m, "view_calendar") === "yes";
  const team = all ? await practitioners(c.env, m) : [];
  const asked = Number(c.req.query("p"));
  const picked = all && team.length > 1 && team.some((x) => x.id === asked) ? asked : null;
  const scope = all ? picked : m.id;
  const many = all && team.length > 1 && picked === null ? new Map(team.map((x) => [x.id, x.name])) : null;

  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(d), i)) : [d];
  const from = dayStartUtc(days[0]);
  const to = dayStartUtc(addDays(days.at(-1)!, 1));
  const [entries, busy] = await Promise.all([entriesBetween(c.env, from, to, scope, nowMs), busyBetween(c.env, from, to, nowMs)]);

  const step = view === "week" ? 7 : 1;
  const here = (o: Partial<{ view: CalView; d: string; p: number | null }>) => link({ view, d, p: picked, ...o });
  const todayYmd = istDay(nowMs);
  const showingToday = days.includes(todayYmd);
  const viewSeg = html`<nav class="seg" aria-label="${cc.calViewLabel}">${(["day", "week"] as CalView[]).map(
    (v) => html`<a href="${here({ view: v, d: v === view ? d : showingToday ? todayYmd : days[0] })}"${v === view ? raw(' class="on" aria-current="page"') : ""}>${v === "day" ? cc.calDay : cc.calWeek}</a>`,
  )}</nav>`;
  const nav = html`<nav class="calnav" aria-label="${cc.calViewLabel}">
<a class="btn arrow" href="${here({ d: addDays(d, -step) })}" aria-label="${view === "week" ? cc.calPrevWeek : cc.calPrevDay}" title="${view === "week" ? cc.calPrevWeek : cc.calPrevDay}">‹</a>
<a class="btn${showingToday ? " primary" : ""}" href="${here({ d: todayYmd })}"${showingToday ? raw(' aria-current="date"') : ""}>${cc.calToday}</a>
<a class="btn arrow" href="${here({ d: addDays(d, step) })}" aria-label="${view === "week" ? cc.calNextWeek : cc.calNextDay}" title="${view === "week" ? cc.calNextWeek : cc.calNextDay}">›</a></nav>`;
  const filter =
    all && team.length > 1
      ? html`<nav class="seg who" aria-label="${cc.calWhose}">${[{ id: null as number | null, name: cc.calEveryone }, ...team].map(
          (x) => html`<a href="${link({ view, d, p: x.id })}"${x.id === picked ? raw(' class="on" aria-current="page"') : ""}>${x.name}</a>`,
        )}</nav>`
      : "";
  const rangeLabel = view === "week" ? `${dayLabelFor(days[0], lang)} – ${dayLabelFor(days[6], lang)}` : dayLabelFor(d, lang);

  let empty: unknown = "";
  if (!entries.length) {
    const next = await nextAfter(c.env, to, scope);
    const nextText = next ? `${dayName(next, m.locale)}, ${clock(next, m.locale)}` : null;
    const sentence = view === "week" ? (nextText ? cc.calEmptyWeek(nextText) : cc.calEmptyWeekNone) : nextText ? cc.calEmptyDay(nextText) : cc.calEmptyDayNone;
    empty = emptyState(sentence, next ? { label: cc.calGoNext, href: link({ view: "day", d: istDay(Date.parse(next)), p: picked }) } : undefined);
  }
  const byDay = (ymd: string) => entries.filter((e) => istDay(Date.parse(e.startUtc)) === ymd);
  const blocks = days.map((ymd) => dayBlock({ ymd, entries: byDay(ymd), busy, m, cc, nowMs, view, p: picked, many }));

  const body = html`<style>${raw(CAL_CSS)}</style>${screenHead("calendar", m.locale)}
<div class="calbar">${viewSeg}${nav}</div>${filter ? html`<div class="calbar">${filter}</div>` : ""}
<p class="range">${rangeLabel}</p><p class="calnote">${hoursText(lang)} ${cc.calPhase2}</p>
${empty}${blocks}`;
  return appPage(c, { active: "calendar", title: cc.tabCalendar, body, back: here({}) });
}

export const calendar = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();
calendar.get("/", calendarPage);
