// People (/app/people) and the person page (/app/people/<id>), ticket 23 (docs/CONSOLE-PRD.md, "People: who is this customer?").
// Same rules as the rest of /app: the console middleware (src/console.ts) has already checked the Access JWT, the membership and the
// Origin of a POST. Here every screen, section and button asks can() (src/auth.ts), and every POST asks it again with its own
// per-form token (memberCsrf), so a hidden button and a refused POST always agree.
//  - A practitioner sees only customers booked with them, and nothing about money.
//  - Phone numbers show as the last 4 digits everywhere; the full number only through the audited reveal, with a reason.
//  - Opening a person page is audited (PERSON_OPENED), as the PRD asks.
//  - Staff never see the text of a safety message (crisis or emergency), the customer's or the bot's.
//  - Practitioners don't see the chat at all: CONTRACT.md says the practitioner "never sees chats" and it outranks the PRD's table
//    (written under "Blocked" in STATUS.md for the owner to decide).
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, canAny, memberCsrf, WORKSPACE_ID, type Member, type Target } from "./auth";
import { config } from "./config";
import { auditStmt, languageCsrf, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy } from "./console-copy";
import { rupees, serviceName } from "./copy";
import type { Env } from "./env";
import { applyStatus, type Applied } from "./pay/apply";
import { razorpay } from "./pay/razorpay";
import { peopleCopy, type PeopleCopy } from "./people-copy";
import { personState, quietActive, noSellActiveFor, ensureState } from "./noise";
import { iso } from "./slots";
import {
  appointmentRow, bookingChip, bubble, callLangText, clock, consoleFrame, dayName, emptyState, firstName, forWhomText, last4, ledger, listDetail,
  listRow, paymentChip, rows, screenHead, section, statusChip, thread, type From,
} from "./ui";
import { retentionMinutes, wipePersonStmts } from "./wipe";

export const people = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

const PRACTITIONER_CHAT = false; // see the header: CONTRACT.md wins until the owner decides
const LIST_LIMIT = 60;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";

// ---------- who may see what ----------
const isPractitioner = (m: Member) => m.role === "PRACTITIONER";
// Owner and staff see a customer's payments (staff record money received from here); a practitioner sees nothing about money.
const seesPayments = (m: Member) => can(m, "see_money") === "yes" || can(m, "record_payment") !== "no";
// The safety panel's buttons and "Remove their data" are owner-only: they change how the bot treats a person (the bot switches
// row) or delete data (Privacy, in Settings). Both are the business_settings row of the permission table.
const ownerControls = (m: Member) => can(m, "business_settings") === "yes";

// A booking the practitioner has (or had) with this customer: holds and expired holds don't count, as nobody booked.
const OWN_BOOKING = `(EXISTS (SELECT 1 FROM intros i WHERE i.conversation_id = c.id AND i.practitioner_id = ?3 AND i.state NOT IN ('HELD','EXPIRED'))
  OR EXISTS (SELECT 1 FROM sessions se WHERE se.conversation_id = c.id AND se.practitioner_id = ?3 AND se.state NOT IN ('OFFERED','HELD','EXPIRED')))`;
// ?3 is the practitioner's member id, or -1 for owner and staff (who see everyone).
const scopeId = (m: Member) => (isPractitioner(m) ? m.id : -1);
const SCOPE = `(?3 < 0 OR ${OWN_BOOKING})`;

type Person = {
  id: number; waId: string; name: string | null; mode: string; locale: string; lastUserAt: string | null; createdAt: string;
  sourceAd: string | null; adHeadline: string | null;
};
const PERSON_COLS = `c.id, c.wa_id AS waId, c.display_name AS name, c.mode, c.locale, c.last_user_at AS lastUserAt, c.created_at AS createdAt,
  c.source_ad_id AS sourceAd, c.ad_headline AS adHeadline`;

// The person, and the target can() needs: whose customer they are. null: no such person. own=false for a practitioner: not theirs.
async function personFor(c: ConsoleCtx, id: number): Promise<{ p: Person; target: Target } | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const m = c.get("member");
  const row = await c.env.DB.prepare(`SELECT ${PERSON_COLS}, CASE WHEN ?3 < 0 THEN 0 ELSE ${OWN_BOOKING} END AS own FROM conversations c WHERE c.id = ?1 AND ?2 = ?2`)
    .bind(id, 0, scopeId(m))
    .first<Person & { own: number }>();
  if (!row) return null;
  const { own, ...p } = row;
  return { p, target: { practitionerId: own ? m.id : null } };
}

// For a practitioner's reveal: their call or session with this customer that is now within an hour of its start or end.
async function callWindow(env: Env, convId: number, m: Member, nowMs: number): Promise<Target> {
  if (!isPractitioner(m)) return {};
  const row = await env.DB.prepare(
    `SELECT s.start_utc AS startUtc, s.end_utc AS endUtc FROM slots s WHERE s.owner_id = ?1 AND s.state = 'BOOKED' AND s.practitioner_id = ?2
       AND s.start_utc <= ?3 AND s.end_utc >= ?4 ORDER BY s.start_utc LIMIT 1`,
  )
    .bind(convId, m.id, iso(nowMs + HOUR), iso(nowMs - HOUR))
    .first<{ startUtc: string; endUtc: string }>();
  return row ? { callStartMs: Date.parse(row.startUtc), callEndMs: Date.parse(row.endUtc), nowMs } : { nowMs };
}

// ---------- small words ----------
function agoText(p: PeopleCopy, utc: string, nowMs: number): string {
  const m = Math.max(0, Math.round((nowMs - Date.parse(utc)) / MIN));
  if (m < 1) return p.justNow;
  if (m < 60) return p.minAgo(m);
  const h = Math.round(m / 60);
  if (h < 48) return p.hoursAgo(h);
  return p.daysAgo(Math.round(h / 24));
}
const when = (p: PeopleCopy, utc: string, locale: string) => p.dayAt(dayName(utc, locale), clock(utc, locale));
const nameOf = (p: PeopleCopy, name: string | null) => firstName(name, p.noName);
const langName = (lang: string, locale: string) => (lang === "hi" ? consoleCopy(locale).langHindi : consoleCopy(locale).langEnglish);
const service = (s: string, locale: string) => serviceName(s, locale === "hi" ? "hi" : "en");

// A little layout the shared stylesheet doesn't have: the filter links, a search box inside the list (the laptop rail has its own),
// and the fields inside a confirm panel. Inline <style> is allowed by the console's CSP.
const PEOPLE_CSS = `
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.filters a{display:inline-flex;align-items:center;min-height:48px;padding:0 16px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-decoration:none;font-weight:500}
.filters a.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.people-find{margin:0 0 12px}
.person h2{font-size:26px;line-height:1.25;font-weight:600;margin:0}
.person h2 .d{color:var(--muted);font-weight:400}
.person p{margin:4px 0 0;color:var(--muted)}
.person .chip{margin:12px 8px 0 0}
.panel label{display:block;margin:0 0 8px;font-weight:500}
.panel input[type=text]{width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px;margin:4px 0 12px}
.panel fieldset{border:0;margin:0 0 8px;padding:0}
.panel fieldset label{display:flex;align-items:center;gap:12px;min-height:48px;font-weight:400}
.panel input[type=radio]{width:24px;height:24px;margin:0}
.safety{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:4px 20px;margin:0 0 12px}
.safety p{margin:12px 0}
.safety p+p{border-top:1px solid var(--line);padding-top:12px}
.callnum{margin:0 0 12px}
details.confirm.calm>summary{color:var(--accent);border-color:var(--accent)}
details.confirm.calm .panel{background:var(--accent-tint)}
@media (min-width:900px){.people-find{display:none}}
`;

// ---------- the list ----------
type Filter = "all" | "waiting" | "upcoming" | "package" | "blocked";
const FILTERS: { id: Filter; label: keyof PeopleCopy; where: string }[] = [
  { id: "all", label: "filterAll", where: "1 = 1" },
  { id: "waiting", label: "filterWaiting", where: "c.mode = 'HUMAN'" },
  { id: "upcoming", label: "filterUpcoming", where: "EXISTS (SELECT 1 FROM slots s WHERE s.owner_id = c.id AND s.state = 'BOOKED' AND s.end_utc > ?2 AND (?3 < 0 OR s.practitioner_id = ?3))" },
  { id: "package", label: "filterPackage", where: "EXISTS (SELECT 1 FROM packages k WHERE k.conversation_id = c.id AND k.state = 'PAID')" },
  { id: "blocked", label: "filterBlocked", where: "c.mode = 'BLOCKED'" },
];
const filterOf = (v: string | undefined) => FILTERS.find((f) => f.id === v) ?? FILTERS[0];

// Search by name, or by the last 4 digits of the number. A longer run of digits is cut to its last 4, so a search can never be used
// to test a full number digit by digit: the answer only ever depends on the last 4, which everyone may see.
export function searchClause(q: string): { sql: string; value: string } {
  const t = q.trim();
  if (!t) return { sql: "?1 = ?1", value: "" };
  if (/^[\d\s+()-]+$/.test(t)) {
    const d = t.replace(/\D/g, "").slice(-4);
    return d ? { sql: "c.wa_id LIKE ?1", value: `%${d}` } : { sql: "?1 = ?1", value: "" };
  }
  return { sql: "c.display_name LIKE ?1 ESCAPE '\\'", value: `%${t.replace(/[\\%_]/g, (x) => `\\${x}`)}%` };
}

// The query as used: a number is kept as its last 4 digits only, so even the search box never shows more (PRD check 9).
export function cleanQuery(raw: string | undefined): string {
  const t = (raw ?? "").trim().slice(0, 40);
  return /^[\d\s+()-]+$/.test(t) ? t.replace(/\D/g, "").slice(-4) : t;
}

type ListRow = { id: number; waId: string; name: string | null; mode: string; lastUserAt: string | null; nextAt: string | null };

async function listPeople(env: Env, m: Member, q: string, f: Filter, nowMs: number): Promise<ListRow[]> {
  const s = searchClause(q);
  const where = filterOf(f).where;
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.wa_id AS waId, c.display_name AS name, c.mode, c.last_user_at AS lastUserAt,
       (SELECT MIN(s.start_utc) FROM slots s WHERE s.owner_id = c.id AND s.state = 'BOOKED' AND s.end_utc > ?2 AND (?3 < 0 OR s.practitioner_id = ?3)) AS nextAt
     FROM conversations c WHERE (${s.sql}) AND (${where}) AND ${SCOPE}
     ORDER BY COALESCE(c.last_user_at, c.created_at) DESC, c.id DESC LIMIT ?4`,
  )
    .bind(s.value, iso(nowMs), scopeId(m), LIST_LIMIT)
    .all<ListRow>();
  return results;
}

const qs = (q: string, f: Filter) => {
  const u = new URLSearchParams();
  if (q) u.set("q", q);
  if (f !== "all") u.set("f", f);
  const s = u.toString();
  return s ? `?${s}` : "";
};

function listHtml(o: { m: Member; p: PeopleCopy; rows: ListRow[]; q: string; f: Filter; openId?: number; nowMs: number }) {
  const { m, p, q, f } = o;
  const cc = consoleCopy(m.locale);
  const loc = m.locale;
  const filters = html`<nav class="filters" aria-label="${p.filtersLabel}">${FILTERS.map(
    (x) => html`<a class="${x.id === f ? "on" : ""}" href="/app/people${qs(q, x.id)}"${x.id === f ? raw(' aria-current="true"') : ""}>${p[x.label] as string}</a>`,
  )}</nav>`;
  const find = html`<form class="find people-find" method="get" action="/app/people" role="search"><label class="vh" for="people-q">${cc.searchLabel}</label>${
    f !== "all" ? html`<input type="hidden" name="f" value="${f}">` : ""
  }<input id="people-q" type="search" name="q" value="${q}" placeholder="${cc.searchPlaceholder}" autocomplete="off"><button class="btn" type="submit">${cc.searchButton}</button></form>`;
  const items = o.rows.map((r) => {
    const sub = [r.lastUserAt ? p.lastMessage(agoText(p, r.lastUserAt, o.nowMs)) : p.noMessageYet, r.nextAt ? p.nextShort(when(p, r.nextAt, loc)) : ""].filter(Boolean).join(" · ");
    const end = r.mode === "HUMAN" ? statusChip(p.chipWaiting, "attention") : r.mode === "BLOCKED" ? statusChip(p.chipBlocked, "danger") : "";
    return listRow({ href: `/app/people/${r.id}${qs(q, f)}`, title: `${nameOf(p, r.name)} ${last4(r.waId)}`, sub, end, on: r.id === o.openId });
  });
  const empty =
    q || f !== "all"
      ? emptyState(p.nobodyMatches, { label: p.seeEveryone, href: "/app/people" })
      : emptyState(isPractitioner(m) ? p.nobodyYours : p.nobodyYet, { label: p.openToday, href: "/app" });
  return html`${find}${filters}${o.rows.length ? rows(items) : empty}${o.rows.length === LIST_LIMIT ? html`<p class="muted">${p.showingRecent(LIST_LIMIT)}</p>` : ""}`;
}

// ---------- the page frame ----------
async function frameFor(c: ConsoleCtx, o: { title: string; body: unknown; flash?: string | null; back: string; q?: string }) {
  const m = c.get("member");
  const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(m.workspaceId ?? WORKSPACE_ID).first<{ name: string }>();
  return consoleFrame({
    role: m.role, locale: m.locale, active: "people", title: o.title, business: ws?.name ?? "", member: m.displayName ?? undefined,
    flash: o.flash, query: o.q, language: { csrf: await languageCsrf(c.get("jwt"), m), back: o.back },
    body: html`<style>${raw(PEOPLE_CSS)}</style>${o.body}`,
  });
}

// The same plain refusal for a page a role can't open and a hand-made POST it can't send.
async function refusedPage(c: ConsoleCtx, status: 403 | 404 = 403) {
  const m = c.get("member");
  const cc = consoleCopy(m.locale);
  const p = peopleCopy(m.locale);
  const body = html`${screenHead("people", m.locale)}${emptyState(status === 404 ? p.notFound : cc.noAccessBody, { label: cc.tabPeople, href: "/app/people" })}`;
  return c.html(await frameFor(c, { title: status === 404 ? cc.tabPeople : cc.noAccess, body, back: "/app/people" }), status);
}

people.get("/", async (c) => {
  const m = c.get("member");
  if (!canAny(m, "view_people")) return refusedPage(c);
  const p = peopleCopy(m.locale);
  const q = cleanQuery(c.req.query("q"));
  const f = filterOf(c.req.query("f")).id;
  const nowMs = Date.now();
  const list = listHtml({ m, p, rows: await listPeople(c.env, m, q, f, nowMs), q, f, nowMs });
  const body = html`${screenHead("people", m.locale)}${listDetail({ list, backHref: `/app/people${qs(q, f)}`, locale: m.locale })}`;
  return c.html(await frameFor(c, { title: consoleCopy(m.locale).tabPeople, body, back: `/app/people${qs(q, f)}`, q }));
});

// ---------- the person page ----------
type Draft = Record<string, string>;
type PageOpts = { reveal?: boolean; flash?: string | null; draft?: Draft; status?: 200 | 400 | 500 };

const token = (c: ConsoleCtx, scope: string) => memberCsrf(c.get("jwt"), c.get("member"), scope);

// A confirm step with fields: the details panel opens in place, names the effect, and the red button sends it with its token.
function confirmWith(o: { label: string; effect: string; confirm: string; action: string; csrf: string; fields?: unknown; danger?: boolean }) {
  return html`<details class="confirm${o.danger === false ? " calm" : ""}"><summary>${o.label}</summary><div class="panel"><p class="effect">${o.effect}</p><form method="post" action="${o.action}"><input type="hidden" name="csrf" value="${o.csrf}">${o.fields ?? ""}<button class="btn ${o.danger === false ? "primary" : "danger"}" type="submit">${o.confirm}</button></form></div></details>`;
}
const reasonField = (p: PeopleCopy, id: string, value = "") =>
  html`<label for="${id}">${p.reason}</label><input type="text" id="${id}" name="reason" maxlength="200" required value="${value}" autocomplete="off">`;
const post = (label: string, action: string, csrf: string, kind = "secondary") =>
  html`<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><button class="btn ${kind}" type="submit">${label}</button></form>`;

type Booking = { kind: "CALL" | "SESSION"; startUtc: string; state: string; service: string; forWhom: "SELF" | "FAMILY" | "PET" | null; callLang: string | null };
async function nextBooking(env: Env, convId: number, m: Member, nowMs: number): Promise<Booking | null> {
  return env.DB.prepare(
    `SELECT 'CALL' AS kind, s.start_utc AS startUtc, i.state, i.service, i.for_whom AS forWhom, i.call_lang AS callLang FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.conversation_id = ?1 AND i.state IN ('PAID','RESCHEDULED') AND s.end_utc > ?2 AND (?3 < 0 OR i.practitioner_id = ?3)
     UNION ALL SELECT 'SESSION', s.start_utc, se.state, se.service, se.for_whom, se.call_lang FROM sessions se JOIN slots s ON s.id = se.slot_id
       WHERE se.conversation_id = ?1 AND se.state IN ('CONFIRMED','CREDIT_BOOKED') AND s.end_utc > ?2 AND (?3 < 0 OR se.practitioner_id = ?3)
     ORDER BY 2 LIMIT 1`,
  )
    .bind(convId, iso(nowMs), scopeId(m))
    .first<Booking>();
}

type Pack = { id: number; size: number; state: string; left: number };
type Credit = { packageId: number; delta: number; reason: string; at: string; sessionStart: string | null };
async function packagesOf(env: Env, convId: number) {
  const packs = (
    await env.DB.prepare(
      "SELECT k.id, k.size, k.state, (SELECT COALESCE(SUM(delta), 0) FROM credits WHERE package_id = k.id) AS left FROM packages k WHERE k.conversation_id = ?1 AND k.state IN ('PAID','CLOSED') ORDER BY k.id",
    )
      .bind(convId)
      .all<Pack>()
  ).results;
  const credits = (
    await env.DB.prepare(
      `SELECT cr.package_id AS packageId, cr.delta, cr.reason, cr.at, (SELECT s.start_utc FROM sessions se JOIN slots s ON s.id = se.slot_id WHERE se.id = cr.session_id) AS sessionStart
       FROM credits cr JOIN packages k ON k.id = cr.package_id WHERE k.conversation_id = ?1 ORDER BY cr.id`,
    )
      .bind(convId)
      .all<Credit>()
  ).results;
  return { packs, credits };
}

function ledgerLine(p: PeopleCopy, cr: Credit, locale: string): string {
  if (cr.reason === "PURCHASE") return p.ledgerBought(cr.delta);
  if (cr.reason === "BOOK") return cr.sessionStart ? p.ledgerUsed(when(p, cr.sessionStart, locale)) : p.ledgerUsedNoDate;
  if (cr.reason === "CANCEL_RETURN") return p.ledgerReturned;
  if (cr.reason === "REFUND") return p.ledgerRefunded(-cr.delta);
  return cr.delta === 0 ? p.ledgerHandRefund : p.ledgerAdjusted;
}
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

type PayRow = { id: number; purpose: string; amount: number; state: string; at: string; linkId: string | null; size: number | null; asked: number | null; paidSiblings: number };
async function paymentsOf(env: Env, convId: number): Promise<PayRow[]> {
  return (
    await env.DB.prepare(
      `SELECT p.id, p.purpose, COALESCE(p.paid_paise, p.amount_paise) AS amount, p.state, p.created_at AS at, p.provider_link_id AS linkId, pk.size,
         (SELECT 1 FROM requests r WHERE r.kind = 'MARK_PAID' AND r.target = 'payment:' || p.id AND r.decided_at IS NULL) AS asked,
         (SELECT COUNT(*) FROM payments q WHERE q.purpose = p.purpose AND q.target_id = p.target_id AND q.state IN ${PAID_LIKE}) AS paidSiblings
       FROM payments p
       LEFT JOIN intros i ON p.purpose = 'INTRO' AND i.id = p.target_id
       LEFT JOIN sessions s ON p.purpose = 'SESSION' AND s.id = p.target_id
       LEFT JOIN packages pk ON p.purpose = 'PACKAGE' AND pk.id = p.target_id
       WHERE COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id) = ?1 AND p.state != 'CREATING' ORDER BY p.id DESC LIMIT 20`,
    )
      .bind(convId)
      .all<PayRow>()
  ).results;
}
const whatPaid = (p: PeopleCopy, r: { purpose: string; size: number | null }) =>
  r.purpose === "INTRO" ? p.payCall(rupees(config.prices.intro)) : r.purpose === "PACKAGE" ? p.payPackage(r.size ?? 0) : p.paySession;
// Money received outside Razorpay can be recorded only for a link sent and not paid (waiting, or expired unpaid), when nothing else has
// been paid for the same booking, and no request for it is already waiting.
const canRecord = (r: PayRow) => (r.state === "PENDING" || r.state === "FAILED") && r.linkId !== null && r.paidSiblings === 0 && !r.asked;

type Line = { dir: string; body: string | null; wipedAt: string | null; at: string; key: string | null; status: string; safety: number };
async function chatOf(env: Env, convId: number): Promise<Line[]> {
  // safety = 1: a crisis or emergency message from the bot, or the customer's message that set it off.
  const { results } = await env.DB.prepare(
    `SELECT m.direction AS dir, m.body, m.wiped_at AS wipedAt, m.created_at AS at, m.dedupe_key AS key, m.status,
       CASE WHEN m.direction = 'OUT' AND (m.dedupe_key LIKE '%:crisis' OR m.dedupe_key LIKE '%:emergency') THEN 1
            WHEN m.direction = 'IN' AND m.wa_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages o WHERE o.dedupe_key IN (m.wa_message_id || ':crisis', m.wa_message_id || ':emergency')) THEN 1
            ELSE 0 END AS safety
     FROM messages m WHERE m.conversation_id = ?1 ORDER BY m.id DESC LIMIT 40`,
  )
    .bind(convId)
    .all<Line>();
  return results.reverse();
}
const fromOf = (l: Line): From =>
  l.dir === "IN" ? "customer" : l.safety ? "safety" : l.key?.startsWith("admin-reply:") || l.key?.startsWith("app-reply:") ? "team" : /:ai(-help)?$/.test(l.key ?? "") ? "assistant" : "bot";

async function personPage(c: ConsoleCtx, id: number, opts: PageOpts = {}) {
  const m = c.get("member");
  const loc = m.locale;
  const p = peopleCopy(loc);
  const cc = consoleCopy(loc);
  const found = await personFor(c, id);
  if (!found) return refusedPage(c, 404);
  const { p: person, target } = found;
  if (can(m, "view_people", target) !== "yes") return refusedPage(c);
  const nowMs = Date.now();
  const base = `/app/people/${id}`;
  const q = cleanQuery(c.req.query("q"));
  const f = filterOf(c.req.query("f")).id;
  const draft = opts.draft ?? {};

  // Header: name, last 4 digits, language, first contact, the ad.
  const ad = person.adHeadline ? p.cameFromAd(person.adHeadline) : person.sourceAd ? p.cameFromAdNoName : p.notFromAd;
  const head = html`<div class="card person"><h2>${person.name?.trim() || p.noName} <span class="d">${last4(person.waId)}</span></h2>
<p>${p.speaks(langName(person.locale, loc))} · ${p.firstContact(dayName(person.createdAt, loc))}</p><p>${ad}</p>
${person.mode === "HUMAN" ? statusChip(p.chipWaiting, "attention") : ""}${person.mode === "BLOCKED" ? statusChip(p.chipBlocked, "danger") : ""}</div>`;

  // The next booking (a practitioner: the next one with them).
  const nb = await nextBooking(c.env, id, m, nowMs);
  const next = nb
    ? ledger(
        appointmentRow({
          time: clock(nb.startUtc, loc), name: dayName(nb.startUtc, loc),
          service: `${nb.kind === "CALL" ? p.callKind(rupees(config.prices.intro)) : p.sessionKind} · ${service(nb.service, loc)}`,
          details: [forWhomText(nb.forWhom, loc), callLangText(nb.callLang, loc)], status: bookingChip(nb.state, loc),
        }),
      )
    : emptyState(p.noNextBooking, { label: p.openCalendar, href: "/app/calendar" });

  // Package: "6 of 10 left", with the ledger of bought, used, returned and refunded sessions.
  const { packs, credits } = await packagesOf(c.env, id);
  const packHtml = packs.length
    ? packs.map(
        (k) => html`<div class="card"><h3>${k.state === "CLOSED" ? p.packClosed(k.size) : p.packLeft(k.left, k.size)}</h3>${rows(
          credits.filter((cr) => cr.packageId === k.id).map((cr) => html`<div class="row"><div><p class="t">${ledgerLine(p, cr, loc)}</p><p class="s">${dayName(cr.at, loc)}</p></div><span class="num">${signed(cr.delta)}</span></div>`),
        )}</div>`,
      )
    : emptyState(p.noPackage);

  // Payments (owner and staff), each with its status in words, and "Record money received outside Razorpay" where it fits.
  let payHtml: unknown = "";
  if (seesPayments(m)) {
    const pays = await paymentsOf(c.env, id);
    const rec = can(m, "record_payment");
    const items = await Promise.all(
      pays.map(async (r) => {
        const what = whatPaid(p, r);
        const money =
          rec !== "no" && canRecord(r)
            ? confirmWith({
                label: p.recordMoney, action: `${base}/money`, csrf: await token(c, `people-money:${id}:${r.id}`), danger: false,
                effect: rec === "yes" ? p.recordEffectOwner(rupees(r.amount), what) : p.recordEffectStaff(rupees(r.amount), what),
                confirm: rec === "yes" ? p.recordYesOwner(rupees(r.amount)) : p.recordYesStaff,
                fields: html`<input type="hidden" name="payment" value="${r.id}"><fieldset><legend>${p.howPaid}</legend>
<label><input type="radio" name="method" value="cash"${draft.method !== "upi" ? raw(" checked") : ""}> ${p.paidCash}</label><label><input type="radio" name="method" value="upi"${draft.method === "upi" ? raw(" checked") : ""}> ${p.paidUpi}</label></fieldset>
<label for="note-${r.id}">${p.moneyNote}</label><input type="text" id="note-${r.id}" name="reason" maxlength="200" required value="${draft.payment === String(r.id) ? draft.reason ?? "" : ""}" autocomplete="off">`,
              })
            : "";
        return html`<div class="row"><div><p class="t">${what} · <span class="num">${rupees(r.amount)}</span></p><p class="s">${when(p, r.at, loc)}</p>${money}</div><div>${paymentChip(r.state, loc)}${r.asked ? html` ${statusChip(p.askedOwner, "attention")}` : ""}</div></div>`;
      }),
    );
    payHtml = section(p.secPayments, pays.length ? rows(items) : emptyState(p.noPayments));
  }

  // The chat, with the date its text is deleted. Staff never see a safety message's text; practitioners don't see the chat.
  let chatHtml: unknown;
  if (isPractitioner(m) && !PRACTITIONER_CHAT) chatHtml = emptyState(p.chatForCalls);
  else {
    const lines = await chatOf(c.env, id);
    const keepMin = retentionMinutes(c.env);
    const keep = keepMin >= 1440 ? p.keepDays(Math.round(keepMin / 1440)) : p.keepMinutes(keepMin);
    const live = lines.some((l) => l.body !== null && !l.wipedAt);
    const deleteAt = person.lastUserAt ? iso(Date.parse(person.lastUserAt) + keepMin * MIN) : null;
    const note = !lines.length
      ? ""
      : live && deleteAt
        ? html`<p class="muted">${p.chatDeletedOn(keepMin >= 1440 ? dayName(deleteAt, loc) : when(p, deleteAt, loc))}. ${p.chatKept(keep)}</p>`
        : lines.every((l) => l.wipedAt || l.body === null)
          ? html`<p class="muted">${p.chatDeleted}</p>`
          : html`<p class="muted">${p.chatKept(keep)}</p>`;
    const bubbles = lines.map((l) => {
      const from = fromOf(l);
      const hidden = l.safety === 1 && can(m, "read_chat", { ...target, safety: true }) !== "yes";
      const text = hidden ? cc.safetyHidden : l.wipedAt ? p.textRemoved : l.body ?? p.noText;
      const kind = l.dir === "OUT" && l.status === "FAILED" ? p.notDeliveredChip : l.dir === "OUT" && l.status === "SKIPPED" ? p.notSentChip : undefined;
      return bubble({ from, text, time: when(p, l.at, loc), kind, hideSafety: hidden, locale: loc, teamName: l.key?.startsWith("admin-reply:") ? cc.roleOWNER : undefined });
    });
    chatHtml = html`${note}${lines.length ? thread(bubbles) : emptyState(p.noMessages)}`;
  }

  // The safety panel, in plain words, one line per state, with the owner's buttons.
  const st = await personState(c.env.DB, id);
  const blockRow = person.mode === "BLOCKED" ? await c.env.DB.prepare("SELECT created_at AS at FROM blocks WHERE wa_id = ?1 ORDER BY id LIMIT 1").bind(person.waId).first<{ at: string }>() : null;
  const strikesLive = st.strikes > 0 && st.lastStrikeAt !== null && nowMs - Date.parse(st.lastStrikeAt) < config.noise.strikeClearDays * DAY;
  const noSell = noSellActiveFor(st, nowMs);
  const quiet = quietActive(st, nowMs);
  const lines: unknown[] = [];
  const btns: unknown[] = [];
  const owner = ownerControls(m);
  if (person.mode === "BLOCKED") lines.push(blockRow ? p.safetyBlocked(dayName(blockRow.at, loc)) : p.safetyBlockedNoDate);
  if (st.optedOutAt) lines.push(p.safetyOptedOut(dayName(st.optedOutAt, loc)));
  if (noSell) {
    lines.push(m.role === "STAFF" ? p.safetyNoSellStaff(dayName(st.noSellUntil!, loc)) : p.safetyNoSell(dayName(st.noSellUntil!, loc)));
    if (owner) btns.push(post(p.allowBookings, `${base}/allow-bookings`, await token(c, `people-allow:${id}`), "primary"));
  }
  if (quiet) lines.push(p.safetyQuiet(dayName(st.quietUntil!, loc)));
  else if (strikesLive) lines.push(p.safetyWarnings(st.strikes, config.noise.strikesToQuiet, dayName(st.lastStrikeAt!, loc)));
  if ((quiet || strikesLive) && owner) btns.push(post(p.clearWarnings, `${base}/clear-warnings`, await token(c, `people-clear:${id}`)));
  if (!lines.length) lines.push(p.safetyNormal);
  const safetyHtml = html`<div class="safety">${lines.map((l) => html`<p>${l}</p>`)}</div>${btns.length ? html`<div class="acts">${btns}</div>` : ""}`;

  // More: show the full number (with a reason, logged), block, remove their data. Each only where can() says so.
  const more: unknown[] = [];
  const revealTarget = { ...target, ...(await callWindow(c.env, id, m, nowMs)) };
  if (can(m, "reveal_phone", revealTarget) === "yes") {
    more.push(
      opts.reveal
        ? html`<p class="callnum"><a class="btn primary" href="tel:+${person.waId}">${p.callNumber(`+${person.waId}`)}</a></p><p class="muted">${p.numberShown}</p>`
        : confirmWith({ label: p.showNumber, effect: p.showNumberEffect, confirm: p.showNumberYes, action: `${base}/reveal`, csrf: await token(c, `people-reveal:${id}`), fields: reasonField(p, "reveal-reason", draft.form === "reveal" ? draft.reason : "") }),
    );
  }
  const blk = can(m, "block");
  if (person.mode === "BLOCKED") {
    if (blk === "yes") more.push(post(p.unblock, `${base}/unblock`, await token(c, `people-unblock:${id}`)));
  } else if (blk === "yes") {
    more.push(confirmWith({ label: p.block, effect: p.blockEffect, confirm: p.blockYes(last4(person.waId)), action: `${base}/block`, csrf: await token(c, `people-block:${id}`), fields: reasonField(p, "block-reason", draft.form === "block" ? draft.reason : "") }));
  } else if (blk === "ask") {
    more.push(confirmWith({ label: p.askBlock, effect: p.askBlockEffect, confirm: p.askBlockYes, action: `${base}/block`, csrf: await token(c, `people-block:${id}`), danger: false, fields: reasonField(p, "block-reason", draft.form === "block" ? draft.reason : "") }));
  }
  if (owner) more.push(confirmWith({ label: p.removeData, effect: p.removeDataEffect, confirm: p.removeDataYes, action: `${base}/remove-data`, csrf: await token(c, `people-remove:${id}`), fields: reasonField(p, "remove-reason", draft.form === "remove" ? draft.reason : "") }));

  const detail = html`${head}${section(p.secNext, next)}${section(p.secPackage, packHtml)}${payHtml}${section(p.secChat, chatHtml)}${section(p.secSafety, safetyHtml)}${
    more.length ? section(p.secMore, html`<div class="acts">${more}</div>`) : ""
  }`;
  const list = listHtml({ m, p, rows: await listPeople(c.env, m, q, f, nowMs), q, f, openId: id, nowMs });
  const flashCode = c.req.query("m");
  const flash = opts.flash ?? (flashCode ? p.flash[flashCode] ?? null : null);
  const body = html`${screenHead("people", loc)}${listDetail({ list, detail, backHref: `/app/people${qs(q, f)}`, locale: loc })}`;
  return c.html(await frameFor(c, { title: nameOf(p, person.name), body, flash, back: base, q }), opts.status ?? 200);
}

people.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const found = await personFor(c, id);
  const m = c.get("member");
  // Opening a customer's page is a sensitive action: recorded, with who and when. Only a page the member may see is recorded as opened.
  if (found && can(m, "view_people", found.target) === "yes") {
    await c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) VALUES (?1, 'PERSON_OPENED', ?2, '', ?3, ?4)")
      .bind(c.get("email"), `conv:${id}`, m.workspaceId, m.id)
      .run();
  }
  return personPage(c, id);
});

// ---------- the POSTs ----------
type Form = Record<string, string | undefined>;
type Done = { to: string } | { page: PageOpts };

// Every POST: the person must exist and be visible to this member, the role must be allowed (the same can() the button used), and the
// form's own token must match. A refused POST changes nothing. A failed write re-shows the page with "That didn't save" and the form filled in.
function action(scope: string, allowed: (m: Member, c: ConsoleCtx, id: number, target: Target) => Promise<boolean> | boolean, run: (c: ConsoleCtx, id: number, f: Form, person: Person) => Promise<Done>, draftOf?: (f: Form) => Draft) {
  return async (c: ConsoleCtx) => {
    const id = Number(c.req.param("id"));
    const m = c.get("member");
    const found = await personFor(c, id);
    if (!found) return refusedPage(c, 404);
    if (can(m, "view_people", found.target) !== "yes" || !(await allowed(m, c, id, found.target))) return refusedPage(c);
    const f = (await c.req.parseBody()) as Form;
    if (f.csrf !== (await token(c, `${scope}:${id}${scope === "people-money" ? `:${f.payment ?? ""}` : ""}`))) return c.text("Forbidden", 403);
    try {
      const done = await run(c, id, f, found.p);
      if ("to" in done) return c.redirect(`/app/people/${id}?m=${done.to}`, 303);
      return personPage(c, id, done.page);
    } catch {
      return personPage(c, id, { flash: consoleCopy(m.locale).notSaved, draft: draftOf?.(f), status: 500 });
    }
  };
}
const reasonOf = (f: Form) => String(f.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
const needReason = (c: ConsoleCtx, _id: number, form: string): Done => ({ page: { flash: peopleCopy(c.get("member").locale).flash.needReason, draft: { form }, status: 400 } });
// An audit row written whatever happened (a view or a reveal), with the reason.
const auditNow = (c: ConsoleCtx, act: string, target: string, detail: string, reason: string | null) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(
    c.get("email"), act, target, detail, c.get("member").workspaceId, c.get("member").id, reason,
  );

// Show the full number: a reason is required, the reveal is logged first, and the number is shown on this response only.
people.post(
  "/:id/reveal",
  action(
    "people-reveal",
    async (m, c, id, target) => can(m, "reveal_phone", { ...target, ...(await callWindow(c.env, id, m, Date.now())) }) === "yes",
    async (c, id, f) => {
      const reason = reasonOf(f);
      if (reason.length < 3) return needReason(c, id, "reveal");
      await auditNow(c, "PERSON_REVEAL_NUMBER", `conv:${id}`, "", reason).run();
      return { page: { reveal: true } };
    },
    (f) => ({ form: "reveal", reason: String(f.reason ?? "") }),
  ),
);

// Allow bookings again: ends the "no selling" period after a crisis message (owner).
people.post(
  "/:id/allow-bookings",
  action("people-allow", (m) => ownerControls(m), async (c, id) => {
    await ensureState(c.env.DB, id);
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE person_state SET no_sell_until = NULL WHERE conversation_id = ?1 AND no_sell_until IS NOT NULL").bind(id),
      auditStmt(c, "PERSON_ALLOW_BOOKINGS", `conv:${id}`, "no-sell ended"),
    ]);
    return { to: res.meta.changes ? "nosell" : "gone" };
  }),
);

// Let the bot answer again: clears the warnings and ends a quiet period (owner).
people.post(
  "/:id/clear-warnings",
  action("people-clear", (m) => ownerControls(m), async (c, id) => {
    await ensureState(c.env.DB, id);
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE person_state SET strikes = 0, last_strike_at = NULL, quiet_until = NULL WHERE conversation_id = ?1 AND (strikes > 0 OR quiet_until IS NOT NULL)").bind(id),
      auditStmt(c, "PERSON_CLEAR_WARNINGS", `conv:${id}`, "strikes and quiet cleared"),
    ]);
    return { to: res.meta.changes ? "cleared" : "gone" };
  }),
);

// Block: the owner blocks at once; staff ask the owner (a `requests` row, decided on the owner's Today).
people.post(
  "/:id/block",
  action(
    "people-block",
    (m) => can(m, "block") !== "no",
    async (c, id, f, person) => {
      const m = c.get("member");
      const reason = reasonOf(f);
      const db = c.env.DB;
      if (can(m, "block") === "ask") {
        if (reason.length < 3) return needReason(c, id, "block");
        return askOwner(c, "BLOCK", `conv:${id}`, null, reason);
      }
      const now = iso(Date.now());
      const [res] = await db.batch([
        db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1 AND mode != 'BLOCKED'").bind(id),
        auditStmt(c, "PERSON_BLOCK", `conv:${id}`, "", reason || null),
        db.prepare("INSERT INTO blocks (wa_id, reason, by, created_at) SELECT ?1, 'ADMIN', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)").bind(person.waId, c.get("email"), now),
      ]);
      return { to: res.meta.changes ? "blocked" : "gone" };
    },
    (f) => ({ form: "block", reason: String(f.reason ?? "") }),
  ),
);

people.post(
  "/:id/unblock",
  action("people-unblock", (m) => can(m, "block") === "yes", async (c, id, _f, person) => {
    const db = c.env.DB;
    const [, res] = await db.batch([
      db.prepare("DELETE FROM blocks WHERE wa_id = ?1").bind(person.waId),
      db.prepare("UPDATE conversations SET mode = 'BOT' WHERE id = ?1 AND mode = 'BLOCKED'").bind(id),
      auditStmt(c, "PERSON_UNBLOCK", `conv:${id}`, ""),
    ]);
    return { to: res.meta.changes ? "unblocked" : "gone" };
  }),
);

// Remove their data (owner, with a reason): the name and every message's text go now, by the same rule as the timed wipe (src/wipe.ts).
// Bookings, payments, refunds, the credits ledger, blocks and the audit log stay: the law requires them.
people.post(
  "/:id/remove-data",
  action(
    "people-remove",
    (m) => ownerControls(m),
    async (c, id, f) => {
      const reason = reasonOf(f);
      if (reason.length < 3) return needReason(c, id, "remove");
      const now = iso(Date.now());
      await c.env.DB.batch([...wipePersonStmts(c.env.DB, id, now), auditNow(c, "PERSON_DATA_REMOVED", `conv:${id}`, "name and message text", reason)]);
      return { to: "removed" };
    },
    (f) => ({ form: "remove", reason: String(f.reason ?? "") }),
  ),
);

// Record money received outside Razorpay (cash or a direct UPI transfer) for a link that was sent and not paid.
// Owner: applied at once, through the same code a paid Razorpay link goes through (src/pay/apply.ts), so the booking, the credits and the
// customer's confirmation are exactly as for a link payment. Staff: a `requests` row; nothing changes until the owner approves on Today.
people.post(
  "/:id/money",
  action(
    "people-money",
    (m) => can(m, "record_payment") !== "no",
    async (c, id, f) => {
      const m = c.get("member");
      const reason = reasonOf(f);
      const method = f.method === "upi" ? "UPI" : "cash";
      const payId = Number(f.payment);
      const pay = Number.isInteger(payId) ? (await paymentsOf(c.env, id)).find((r) => r.id === payId) : undefined;
      if (!pay || !canRecord(pay)) return { to: "moneyGone" };
      if (reason.length < 3) return { page: { flash: peopleCopy(m.locale).flash.needReason, draft: { form: "money", payment: String(payId), method: f.method ?? "" }, status: 400 } };
      if (can(m, "record_payment") === "ask") return askOwner(c, "MARK_PAID", `payment:${payId}`, pay.amount, `${method}: ${reason}`);
      const res = await applyMoneyReceived(c.env, payId);
      if (res === "NOT_OPEN") return { to: "moneyGone" };
      await auditNow(c, "PERSON_MONEY_RECEIVED", `payment:${payId}`, `${rupees(pay.amount)} ${method}: ${res}`, reason).run();
      return { to: res === "BOOKED" ? "money" : "moneyLate" };
    },
    (f) => ({ form: "money", payment: String(f.payment ?? ""), method: String(f.method ?? ""), reason: String(f.reason ?? "") }),
  ),
);

// "Ask owner": one open request per kind and target, written with its audit row in one batch (the audit only if the request was new).
// A small local helper on purpose: the shared requests code (approve / decline) belongs to the Today screen (ticket 21).
async function askOwner(c: ConsoleCtx, kind: "BLOCK" | "MARK_PAID", target: string, amountPaise: number | null, reason: string): Promise<Done> {
  const m = c.get("member");
  const db = c.env.DB;
  const [res] = await db.batch([
    db.prepare(
      `INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE NOT EXISTS (SELECT 1 FROM requests WHERE workspace_id = ?1 AND kind = ?2 AND target = ?3 AND decided_at IS NULL)`,
    ).bind(m.workspaceId, kind, target, amountPaise, m.id, reason, iso(Date.now())),
    auditStmt(c, `REQUEST_${kind}`, target, amountPaise ? rupees(amountPaise) : "", reason),
  ]);
  return { to: res.meta.changes ? "asked" : "already" };
}

// Money received outside Razorpay, applied as a paid link would be: the payment becomes PAID and the booking (call, session or package
// credits) follows, with the customer's confirmation. Only for a link sent and not paid, and only if nothing else is paid for the same
// booking, so the duplicate-payment refund (which goes to Razorpay) can never be set off by money Razorpay never had.
// Exported so the owner's approval of a staff request (ticket 21) can run the same code.
export async function applyMoneyReceived(env: Env, paymentId: number): Promise<Applied | "NOT_OPEN"> {
  const pay = await env.DB.prepare(
    `SELECT p.id, p.provider_link_id AS linkId, p.amount_paise AS amount, p.state,
       (SELECT COUNT(*) FROM payments q WHERE q.purpose = p.purpose AND q.target_id = p.target_id AND q.state IN ${PAID_LIKE}) AS paidSiblings
     FROM payments p WHERE p.id = ?1`,
  )
    .bind(paymentId)
    .first<{ id: number; linkId: string | null; amount: number; state: string; paidSiblings: number }>();
  if (!pay || !pay.linkId || !["PENDING", "FAILED"].includes(pay.state) || pay.paidSiblings > 0) return "NOT_OPEN";
  return applyStatus(env, razorpay(env), { linkId: pay.linkId, status: "PAID", paidPaise: pay.amount, currency: config.currency });
}
