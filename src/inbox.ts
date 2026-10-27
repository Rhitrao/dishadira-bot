// Inbox (/app/inbox): who is waiting for a reply? (docs/CONSOLE-PRD.md, "Inbox"; ticket 22). Owner and staff only (the reply_chat row).
// The list: chats handed to the team (HUMAN mode) and open safety follow-ups, oldest first, in three views: All, Mine, Unassigned.
// The thread: labelled bubbles; a reply inside WhatsApp's 24-hour window, the approved follow-up template after it. Staff never see the
// text of a safety message (or of the customer's message that set it off), and only an owner can reply to or close a safety follow-up.
// Actions: Assign to me (lapses after config.inbox.claimMinutes without a reply), Hand back to the bot, Done (one-line closing note),
// and Book or move for them (a real slot picker on the existing booking code). Same rules as the rest of /app: every page and POST asks
// can(), POST-only changes with Origin (src/console.ts) and a per-form CSRF token naming the member, escaped output, no scripts.
// The cron's nudgeWaitingChats() emails the team once per handoff when a chat has waited 2 working hours with no reply.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, canAny, memberCsrf, sha256Hex, WORKSPACE_ID, type Member } from "./auth";
import { bookingChoice, SERVICES, WHO } from "./booking";
import { config } from "./config";
import { languageCsrf, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy, consoleLang } from "./console-copy";
import { copyFor, langOf, rupees, type ForWhom } from "./copy";
import type { Env } from "./env";
import { FOLLOW_UP_TEXT, inboxCopy, type InboxCopy } from "./inbox-copy";
import { sendEmailTo } from "./mail";
import { moveSession } from "./mybookings";
import { noSellActiveFor, personState } from "./noise";
import { razorpay } from "./pay/razorpay";
import { sendMessage, templateVariant, type Out } from "./send";
import { availableSlots, generateSlots, holdSlot, iso, istDay, istMinutes, nextWorkingDays, PRACTITIONER_SQL, spreadTimes, type Slot, type SlotKind } from "./slots";
import { bookingsOpen } from "./switches";
import { bubble, clock, consoleFrame, dayName, firstName, forWhomText, last4, listDetail, listRow, rows, screenHead, section, statusChip, emptyState, thread, type From } from "./ui";

const MIN = 60_000;
const HOUR = 3_600_000;
const CHAT_KINDS = ["HUMAN_REQUEST", "FREE_TEXT", "MEDIA_FROM_CUSTOMER", "OUTSIDE_WINDOW"]; // items a reply, Hand back or Done closes
const SAFETY_KINDS = ["CRISIS", "EMERGENCY"]; // closed only by Done, and only by someone who may read safety messages
const sqlList = (xs: string[]) => xs.map((k) => `'${k}'`).join(", ");
const FOLLOW_UP: Out = { type: "template", name: "follow_up", params: [] };

export type View = "all" | "mine" | "unassigned";
const VIEWS: View[] = ["all", "mine", "unassigned"];
const viewOf = (v: string | undefined): View => (VIEWS.includes(v as View) ? (v as View) : "all");

// ---------- the data ----------
export type Chat = {
  id: number; waId: string; name: string | null; locale: string; mode: string; lastUserAt: string | null; humanSince: string | null; ageOk: string | null;
  claimedBy: number | null; claimedAt: string | null; claimer: string | null; kinds: string | null; safetyAt: string | null; waiting: number;
};
const IN_INBOX = `(c.mode = 'HUMAN' OR EXISTS (SELECT 1 FROM attention a WHERE a.target = 'conv:' || c.id AND a.resolved_at IS NULL AND a.kind IN (${sqlList(SAFETY_KINDS)})))`;
const CHAT_SQL = `SELECT c.id, c.wa_id AS waId, c.display_name AS name, c.locale, c.mode, c.last_user_at AS lastUserAt, c.human_since AS humanSince, c.age_ok_at AS ageOk,
  c.claimed_by AS claimedBy, c.claimed_at AS claimedAt, COALESCE(NULLIF(m.display_name, ''), m.email) AS claimer,
  (SELECT group_concat(a.kind) FROM attention a WHERE a.target = 'conv:' || c.id AND a.resolved_at IS NULL) AS kinds,
  (SELECT MIN(a.created_at) FROM attention a WHERE a.target = 'conv:' || c.id AND a.resolved_at IS NULL AND a.kind IN (${sqlList(SAFETY_KINDS)})) AS safetyAt,
  ${IN_INBOX} AS waiting
  FROM conversations c LEFT JOIN members m ON m.id = c.claimed_by`;

const since = (ch: Chat) => ch.humanSince ?? ch.safetyAt ?? ch.lastUserAt ?? "";
export async function waitingChats(env: Env): Promise<Chat[]> {
  const { results } = await env.DB.prepare(`${CHAT_SQL} WHERE ${IN_INBOX} LIMIT 200`).all<Chat>();
  return results.sort((a, b) => since(a).localeCompare(since(b)) || a.id - b.id); // oldest first
}
const chatById = (env: Env, id: number) => env.DB.prepare(`${CHAT_SQL} WHERE c.id = ?1`).bind(id).first<Chat>();

const kindsOf = (ch: Chat) => (ch.kinds ?? "").split(",").filter(Boolean);
export const isSafety = (ch: Chat) => kindsOf(ch).some((k) => SAFETY_KINDS.includes(k));
// "Assign to me" is live for claimMinutes after the claim (a reply by the same member moves it on).
export const claimLive = (ch: Pick<Chat, "claimedBy" | "claimedAt">, nowMs: number) =>
  ch.claimedBy !== null && ch.claimedAt !== null && Date.parse(ch.claimedAt) > nowMs - config.inbox.claimMinutes * MIN;
const otherClaim = (ch: Chat, m: Member, nowMs: number) => claimLive(ch, nowMs) && ch.claimedBy !== m.id;
const windowEnd = (ch: Chat) => (ch.lastUserAt ? Date.parse(ch.lastUserAt) + config.windowHours * HOUR : 0);
const inWindow = (ch: Chat, nowMs: number) => windowEnd(ch) > nowMs;

// What each member may do with this chat, from the permission table. Every button below is drawn from this, and every POST asks it again.
export function rights(m: Member, ch: Chat) {
  const act = ch.waiting === 1 && can(m, "reply_chat") === "yes" && can(m, "read_chat", { safety: isSafety(ch) }) === "yes";
  const book = act && can(m, "move_booking", { practitionerId: null }) === "yes";
  return {
    act,
    seeSafety: can(m, "read_chat", { safety: true }) === "yes",
    book,
    cashAsk: book && can(m, "record_payment") === "ask", // staff: the owner approves the money (a requests row)
    cashYes: book && can(m, "record_payment") === "yes", // the owner records it on the person's page (ticket 23)
  };
}

// ---------- words and times ----------
function ago(ms: number, ic: InboxCopy): string {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 1) return ic.justNow;
  if (m < 60) return ic.minutes(m);
  if (m < 48 * 60) return ic.hours(Math.floor(m / 60), m % 60);
  return ic.days(Math.floor(m / 1440));
}
// "6:40 pm" today, otherwise "Thu, 29 Oct, 6:40 pm" (Bengaluru time, the member's language).
const when = (utc: string, locale: string, nowMs: number) => (istDay(Date.parse(utc)) === istDay(nowMs) ? clock(utc, locale) : inboxCopy(locale).at(dayName(utc, locale), clock(utc, locale)));

function why(ch: Chat, ic: InboxCopy): string {
  const k = kindsOf(ch);
  if (k.some((x) => SAFETY_KINDS.includes(x))) return ic.whySafety;
  if (k.includes("MEDIA_FROM_CUSTOMER")) return ic.whyPayment;
  if (k.includes("HUMAN_REQUEST")) return ic.whyPerson;
  if (k.includes("FREE_TEXT")) return ic.whyQuestion;
  return ic.whyPerson;
}
const replyLine = (ch: Chat, locale: string, nowMs: number) => {
  const ic = inboxCopy(locale);
  return inWindow(ch, nowMs) ? ic.replyBy(when(iso(windowEnd(ch)), locale, nowMs)) : ic.windowClosed;
};
const customerName = (ch: Chat, locale: string) => `${firstName(ch.name, consoleCopy(locale).fromCustomer)} ${last4(ch.waId)}`;

// ---------- the page ----------
const INBOX_CSS = `
.views{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.views a{display:inline-flex;align-items:center;min-height:48px;padding:0 16px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-decoration:none;font-weight:500}
.views a.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.views .n{margin-left:8px;color:inherit;opacity:.85}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}
.who-h{font-size:20px;font-weight:600;margin:0}
.field{display:block;font-weight:500;margin:0 0 8px}
.ibx textarea,.ibx input[type=text]{display:block;width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:12px}
.ibx textarea{min-height:120px;resize:vertical}
.quote{border-left:4px solid var(--accent);background:var(--sunk);border-radius:var(--r-sm);padding:12px 16px;margin:8px 0 0}
details.done>summary{list-style:none;cursor:pointer}
details.done>summary::-webkit-details-marker{display:none}
details.done[open]{flex:1 1 100%}
details.done .panel{margin-top:8px;background:var(--sunk);border-radius:var(--r-sm);padding:16px}
details.done .panel .btn{width:100%;margin-top:12px}
.pick fieldset{border:0;margin:0 0 16px;padding:0;min-width:0}
.pick legend{font-weight:600;padding:0;margin:0 0 8px}
.opts{display:flex;flex-wrap:wrap;gap:8px}
.opts label{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer}
.opts.stack label{display:flex;width:100%}
.opts input{width:20px;height:20px;margin:0;accent-color:var(--accent);flex:none}
.opts label:has(input:checked){border-color:var(--accent);background:var(--accent-tint)}
.pick .btn{width:100%}
`;

type Flash = { text: string } | null;
const FLASH: Record<string, keyof InboxCopy> = {
  sent: "flashSent", followup: "flashFollowUp", skipped: "flashSkipped", dup: "flashDup", blocked: "flashBlocked", window: "flashWindow",
  notapproved: "flashNotApproved", assigned: "flashAssigned", handedback: "flashHandedBack", done: "flashDone", gone: "flashGone",
};
const flashFor = (code: string | undefined, locale: string): Flash => (code && FLASH[code] ? { text: inboxCopy(locale)[FLASH[code]] as string } : null);

const token = (c: ConsoleCtx, m: Member, action: string, id: number) => memberCsrf(c.get("jwt"), m, `inbox:${action}:${id}`);
const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
async function postButton(c: ConsoleCtx, m: Member, id: number, action: string, label: string, kind = "secondary", fields: Record<string, string> = {}) {
  return html`<form method="post" action="/app/inbox/${id}/${action}">${hidden("csrf", await token(c, m, action, id))}${Object.entries(fields).map(([k, v]) => hidden(k, v))}<button class="btn ${kind}" type="submit">${label}</button></form>`;
}

async function renderScreen(c: ConsoleCtx, o: { view: View; openId?: number; detail?: unknown; flash?: Flash; status?: 200 | 400 | 409 | 503 }) {
  const m = c.get("member");
  const now = Date.now();
  const locale = m.locale;
  const ic = inboxCopy(locale);
  const chats = await waitingChats(c.env);
  const counts: Record<View, number> = {
    all: chats.length,
    mine: chats.filter((ch) => claimLive(ch, now) && ch.claimedBy === m.id).length,
    unassigned: chats.filter((ch) => !claimLive(ch, now)).length,
  };
  const shown = chats.filter((ch) => (o.view === "mine" ? claimLive(ch, now) && ch.claimedBy === m.id : o.view === "unassigned" ? !claimLive(ch, now) : true));
  const label: Record<View, string> = { all: ic.viewAll, mine: ic.viewMine, unassigned: ic.viewUnassigned };
  const views = html`<nav class="views" aria-label="${ic.viewsLabel}">${VIEWS.map(
    (v) => html`<a href="/app/inbox?v=${v}"${v === o.view ? raw(' class="on" aria-current="page"') : ""}>${label[v]}<span class="n">${counts[v]}</span></a>`,
  )}</nav>`;
  const items = shown.map((ch) => {
    const claim = claimLive(ch, now)
      ? statusChip(ch.claimedBy === m.id ? ic.replyingYou : ic.replyingNow(ch.claimer ?? ""), "accent")
      : isSafety(ch)
        ? statusChip(ic.ownerNeeded, "danger")
        : statusChip(ic.nobodyYet, "attention");
    return listRow({
      href: `/app/inbox/${ch.id}${o.view === "all" ? "" : `?v=${o.view}`}`,
      title: customerName(ch, locale),
      sub: [why(ch, ic), ic.waited(ago(now - Date.parse(since(ch)), ic)), replyLine(ch, locale, now)].join(" · "),
      end: claim,
      on: ch.id === o.openId,
    });
  });
  const empty = { all: ic.emptyAll, mine: ic.emptyMine, unassigned: ic.emptyUnassigned }[o.view];
  const list = section(ic.secWaiting, html`${views}${shown.length ? rows(items) : emptyState(empty, o.view === "all" ? { label: ic.backToToday, href: "/app" } : { label: ic.seeAll, href: "/app/inbox" })}`, shown.length);
  const business = (await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(m.workspaceId).first<{ name: string }>())?.name ?? "";
  const back = o.openId ? `/app/inbox/${o.openId}` : "/app/inbox";
  const body = html`<style>${raw(INBOX_CSS)}</style>${screenHead("inbox", locale)}<div class="ibx">${listDetail({ list, detail: o.detail, backHref: `/app/inbox${o.view === "all" ? "" : `?v=${o.view}`}`, locale })}</div>`;
  return c.html(
    consoleFrame({
      role: m.role, locale, active: "inbox", title: consoleCopy(locale).tabInbox, body, business, member: m.displayName ?? undefined,
      flash: o.flash?.text ?? null, badges: { inbox: counts.unassigned }, language: { csrf: await languageCsrf(c.get("jwt"), m), back },
    }),
    o.status ?? 200,
  );
}

// ---------- the thread ----------
type Line = { id: number; dir: string; waMsg: string | null; body: string | null; wipedAt: string | null; at: string; key: string | null; status: string; kind: string };
type Sender = { from: From; memberId?: number; owner?: boolean; followUp?: boolean };
// Who wrote an outgoing message, from its key. Inbox replies carry the member (admin-reply:inbox:<chat>:m<member>:…); older /admin replies were the owner's.
function sender(key: string | null): Sender {
  const k = key ?? "";
  const inbox = /^admin-reply:inbox:\d+:m(\d+):(followup:)?/.exec(k);
  if (inbox) return { from: "team", memberId: Number(inbox[1]), followUp: Boolean(inbox[2]) };
  if (k.startsWith("admin-reply:")) return { from: "team", owner: true };
  if (/:(crisis|emergency)$/.test(k)) return { from: "safety" };
  if (/:ai(-help)?$/.test(k)) return { from: "assistant" };
  return { from: "bot" };
}

async function threadHtml(env: Env, ch: Chat, m: Member, nowMs: number) {
  const locale = m.locale;
  const ic = inboxCopy(locale);
  const cc = consoleCopy(locale);
  const lines = (
    await env.DB.prepare(
      `SELECT id, direction AS dir, wa_message_id AS waMsg, body, wiped_at AS wipedAt, created_at AS at, dedupe_key AS key, status, kind FROM messages
       WHERE conversation_id = ?1 AND NOT (direction = 'OUT' AND body IS NULL) ORDER BY id DESC LIMIT 40`,
    )
      .bind(ch.id)
      .all<Line>()
  ).results.reverse();
  if (!lines.length) return emptyState(ic.noMessages);
  // The customer's own message that set off a safety message is hidden from staff too: its id is the safety message's key without the suffix.
  const safetyIn = new Set(lines.filter((l) => l.dir === "OUT" && /:(crisis|emergency)$/.test(l.key ?? "")).map((l) => (l.key ?? "").replace(/:(crisis|emergency)$/, "")));
  const ids = [...new Set(lines.map((l) => sender(l.key).memberId).filter((x): x is number => x !== undefined))];
  const names = new Map<number, string>();
  if (ids.length) {
    const r = await env.DB.prepare(`SELECT id, COALESCE(NULLIF(display_name, ''), email) AS name FROM members WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; name: string }>();
    for (const x of r.results) names.set(x.id, x.name);
  }
  const ai = (
    await env.DB.prepare("SELECT at, detail FROM audit_log WHERE target = ?1 AND action = 'AI_REPLY' ORDER BY id DESC LIMIT 80").bind(`conv:${ch.id}`).all<{ at: string; detail: string }>()
  ).results;
  const seeSafety = rights(m, ch).seeSafety;
  return thread(
    lines.map((l) => {
      const time = when(l.at, locale, nowMs);
      if (l.dir === "IN") {
        const text = l.wipedAt ? ic.textRemoved : !seeSafety && l.waMsg && safetyIn.has(l.waMsg) ? ic.safetyInHidden : (l.body ?? "");
        return bubble({ from: "customer", text, time, locale });
      }
      const s = sender(l.key);
      const text = l.wipedAt ? ic.textRemoved : s.followUp || l.body === "template:follow_up" ? ic.followUpBubble : l.body?.startsWith("template:") ? ic.templateBubble : (l.body ?? "");
      const label = s.from === "assistant" ? ai.find((a) => a.at <= l.at && Date.parse(l.at) - Date.parse(a.at) < MIN) : undefined;
      const labelText = label ? ((ic as Record<string, unknown>)[`label_${label.detail}`] as string | undefined) : undefined;
      const status = l.status === "FAILED" ? cc.notDelivered : l.status === "SKIPPED" ? ic.chipNotSent : "";
      const kind = [labelText, status].filter(Boolean).join(" · ") || undefined;
      const teamName = s.owner ? ic.ownerBeforeRoles : s.memberId !== undefined ? names.get(s.memberId) : undefined;
      return bubble({ from: s.from, text, time, teamName, kind, hideSafety: !seeSafety, locale });
    }),
  );
}

// The open chat: who, why, the claim, the thread, the reply box (or the follow-up), then the actions.
async function detailHtml(c: ConsoleCtx, ch: Chat, o: { text?: string; note?: string; warn?: string } = {}) {
  const m = c.get("member");
  const now = Date.now();
  const locale = m.locale;
  const ic = inboxCopy(locale);
  const r = rights(m, ch);
  const live = claimLive(ch, now);
  const head = html`<article class="card${isSafety(ch) ? " danger" : ""}"><h2 class="who-h">${customerName(ch, locale)}</h2>
<div class="chips">${statusChip(why(ch, ic), isSafety(ch) ? "danger" : "attention")}${statusChip(ic.waited(ago(now - Date.parse(since(ch)), ic)))}${statusChip(replyLine(ch, locale, now), inWindow(ch, now) ? "plain" : "danger")}</div></article>`;
  const notes: unknown[] = [];
  if (!ch.waiting) notes.push(html`<p class="card">${ic.notInInbox}</p>`);
  else if (isSafety(ch) && !r.act) notes.push(html`<p class="card danger">${ic.safetyForOwner}</p>`);
  if (o.warn) notes.push(html`<p class="card attention" role="alert">${o.warn}</p>`);
  else if (live && ch.claimedBy !== m.id) notes.push(html`<p class="card attention" role="status">${ic.claimWarning(ch.claimer ?? "", ago(now - Date.parse(ch.claimedAt!), ic))}</p>`);
  else if (live) notes.push(html`<p class="card" role="status">${ic.claimYours(clock(iso(Date.parse(ch.claimedAt!) + config.inbox.claimMinutes * MIN), locale))}</p>`);

  let reply: unknown = "";
  if (r.act && inWindow(ch, now)) {
    const seen = otherClaim(ch, m, now) ? String(ch.claimedBy) : "";
    reply = section(
      ic.secReply,
      html`<form method="post" action="/app/inbox/${ch.id}/reply">${hidden("csrf", await token(c, m, "reply", ch.id))}${hidden("seen", seen)}
<label class="field" for="reply-text">${ic.replyLabel}</label><textarea id="reply-text" name="text" rows="4" maxlength="1000" required placeholder="${ic.replyPlaceholder}">${o.text ?? ""}</textarea>
<div class="acts"><button class="btn primary" type="submit">${ic.sendReply}</button></div></form>`,
    );
  } else if (r.act) {
    // WhatsApp's window has closed: only the approved follow-up can go, in the language the customer will get it in.
    const v = templateVariant(FOLLOW_UP as Extract<Out, { type: "template" }>, ch.locale);
    const words = FOLLOW_UP_TEXT[v.language === "hi" ? "hi" : "en"];
    reply = section(
      ic.secReply,
      html`<div class="card attention"><p><b>${ic.windowClosed}</b></p>${
        v.approved
          ? html`<p>${ic.followUpIntro}</p><p class="quote" lang="${v.language}">${words}</p><div class="acts">${await postButton(c, m, ch.id, "follow-up", ic.sendFollowUp, "primary")}</div>`
          : html`<p class="quote" lang="${v.language}">${words}</p><p class="muted">${ic.followUpNotApproved}</p>`
      }</div>`,
    );
  }

  const acts: unknown[] = [];
  if (r.act && !live) acts.push(await postButton(c, m, ch.id, "assign", ic.assignToMe, "primary"));
  if (r.book) acts.push(html`<a class="btn" href="/app/inbox/${ch.id}/book">${ic.bookOrMove}</a>`);
  if (r.act && ch.mode === "HUMAN") acts.push(await postButton(c, m, ch.id, "hand-back", ic.handBack));
  if (r.act)
    acts.push(
      html`<details class="done"${o.note !== undefined ? raw(" open") : ""}><summary class="btn">${ic.done}</summary><form class="panel" method="post" action="/app/inbox/${ch.id}/done">${hidden("csrf", await token(c, m, "done", ch.id))}
<label class="field" for="done-note">${ic.doneNote}</label><input id="done-note" type="text" name="note" maxlength="200" required placeholder="${ic.donePlaceholder}" value="${o.note ?? ""}"><p class="muted">${ic.doneWhy}</p><button class="btn primary" type="submit">${ic.doneButton}</button></form></details>`,
    );
  return html`${head}${notes}${section(ic.secChat, await threadHtml(c.env, ch, m, now))}${reply}${acts.length ? section(ic.secMore, html`<div class="acts">${acts}</div>`) : ""}`;
}

// ---------- book or move for them ----------
type FreeDay = { ymd: string; slots: Slot[] };
async function freeTimes(env: Env, kind: SlotKind, nowMs: number): Promise<FreeDay[]> {
  const out: FreeDay[] = [];
  for (const ymd of nextWorkingDays(nowMs, config.booking.lookaheadDays)) {
    if (out.length >= config.booking.workingDays) break;
    const free = await availableSlots(env.DB, kind, ymd, nowMs + config.booking.leadMinutes * MIN, nowMs);
    if (free.length) out.push({ ymd, slots: kind === "CALL" ? spreadTimes(free, config.booking.timeRows) : free });
  }
  return out;
}
type Upcoming = { id: number; state: string; origin: string; moves: number; practitionerId: number | null; slotId: number; startUtc: string };
const upcomingSessions = (env: Env, convId: number, nowMs: number) =>
  env.DB.prepare(
    `SELECT se.id, se.state, se.origin, se.moves, se.practitioner_id AS practitionerId, sl.id AS slotId, sl.start_utc AS startUtc
     FROM sessions se JOIN slots sl ON sl.id = se.slot_id WHERE se.conversation_id = ?1 AND sl.kind = 'SESSION' AND se.state IN ('CONFIRMED', 'CREDIT_BOOKED') AND sl.start_utc > ?2 ORDER BY sl.start_utc`,
  )
    .bind(convId, iso(nowMs))
    .all<Upcoming>()
    .then((r) => r.results);

const timeFieldsets = (days: FreeDay[], locale: string, name: string) =>
  days.map(
    (d) => html`<fieldset><legend>${dayName(d.slots[0].startUtc, locale)}</legend><div class="opts">${d.slots.map(
      (s) => html`<label><input type="radio" name="${name}" value="${s.startUtc}" required><span>${clock(s.startUtc, locale)}</span></label>`,
    )}</div></fieldset>`,
  );

async function bookHtml(c: ConsoleCtx, ch: Chat) {
  const m = c.get("member");
  const now = Date.now();
  const locale = m.locale;
  const lang = consoleLang(locale);
  const ic = inboxCopy(locale);
  const r = rights(m, ch);
  const parts: unknown[] = [html`<p><a class="ld-back" href="/app/inbox/${ch.id}">← ${ic.backToChat}</a></p><h2 class="who-h">${customerName(ch, locale)}</h2>`];
  const st = await personState(c.env.DB, ch.id);
  if (noSellActiveFor(st, now)) parts.push(html`<p class="card attention">${ic.noSell(dayName(st.noSellUntil!, locale))}</p>`);
  else {
    const days = await freeTimes(c.env, "CALL", now);
    const svc = SERVICES.map((s) => html`<label><input type="radio" name="service" value="${s}" required><span>${config.serviceNames[s as keyof typeof config.serviceNames][lang]}</span></label>`);
    const who = WHO.map((w) => html`<label><input type="radio" name="who" value="${w}" required><span>${forWhomText(w, locale)}</span></label>`);
    const pays = [
      inWindow(ch, now) ? html`<label><input type="radio" name="pay" value="link" required checked><span>${ic.payLink}</span></label>` : "",
      r.cashAsk ? html`<label><input type="radio" name="pay" value="cash" required${inWindow(ch, now) ? "" : raw(" checked")}><span>${ic.payCash}</span></label>` : "",
    ];
    const payable = inWindow(ch, now) || r.cashAsk;
    parts.push(
      section(
        ic.bookTitle(rupees(config.prices.intro)),
        days.length
          ? html`<form class="pick card" method="post" action="/app/inbox/${ch.id}/book">${hidden("csrf", await token(c, m, "book", ch.id))}${hidden("n", crypto.randomUUID().slice(0, 12))}
<fieldset><legend>${ic.serviceLabel}</legend><div class="opts">${svc}</div></fieldset><fieldset><legend>${ic.forWhomLabel}</legend><div class="opts">${who}</div></fieldset>
<fieldset><legend>${ic.timeLabel}</legend></fieldset>${timeFieldsets(days, locale, "time")}
${payable ? html`<fieldset><legend>${ic.payLabel}</legend><div class="opts stack">${pays}</div></fieldset>` : html`<p class="muted">${ic.linkNeedsWindow}</p>`}
${r.cashYes ? html`<p class="muted">${ic.ownerCash} <a href="/app/people/${ch.id}">${ic.openTheirPage}</a></p>` : ""}
${payable ? html`<button class="btn primary" type="submit">${ic.holdButton}</button>` : ""}</form>`
          : emptyState(ic.noTimes),
      ),
    );
  }
  for (const s of await upcomingSessions(c.env, ch.id, now)) {
    if (can(m, "move_booking", { practitionerId: s.practitionerId }) !== "yes") continue;
    const days = await freeTimes(c.env, "SESSION", now);
    const what = `${ic.sessionWord}, ${dayName(s.startUtc, locale)}, ${clock(s.startUtc, locale)}`;
    parts.push(
      section(
        ic.moveTitle(what),
        days.length
          ? html`<form class="pick card" method="post" action="/app/inbox/${ch.id}/move">${hidden("csrf", await token(c, m, "move", ch.id))}${hidden("session", String(s.id))}
<p class="muted">${ic.moveRule(config.sessionRules.changeBeforeHours)}</p>${timeFieldsets(days, locale, "time")}<button class="btn primary" type="submit">${ic.moveButton}</button></form>`
          : emptyState(ic.noTimes),
      ),
    );
  }
  return html`${parts}`;
}

// ---------- the "ask owner" request (ticket 21 owns src/requests.ts; this is the Inbox's one insert) ----------
const askOwnerStmt = (env: Env, m: Member, kind: "MARK_PAID", target: string, amountPaise: number, reason: string) =>
  env.DB.prepare("INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(m.workspaceId, kind, target, amountPaise, m.id, reason);

const auditStmt = (c: ConsoleCtx, action: string, target: string, detail: string, reason: string | null = null) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(
    c.get("email"), action, target, detail, c.get("member").workspaceId ?? WORKSPACE_ID, c.get("member").id, reason,
  );

// The same row, written only if the statement just before it in the batch changed something (SQLite's changes()).
const auditIfChanged = (c: ConsoleCtx, action: string, target: string, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() > 0").bind(
    c.get("email"), action, target, detail, c.get("member").workspaceId, c.get("member").id,
  );

// A reply (or the follow-up) by this member takes the chat if nobody holds it, or moves their own claim on. It never takes another's live claim.
const claimStmt = (env: Env, convId: number, m: Member, nowMs: number) =>
  env.DB.prepare("UPDATE conversations SET claimed_by = ?2, claimed_at = ?3 WHERE id = ?1 AND (claimed_by IS NULL OR claimed_by = ?2 OR claimed_at <= ?4)").bind(
    convId, m.id, iso(nowMs), iso(nowMs - config.inbox.claimMinutes * MIN),
  );

// ---------- routes ----------
export const inbox = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

// Owner and staff only: a practitioner (or a hand-made request from one) gets the same refusal as a tab they never see.
inbox.use("*", async (c, next) => {
  if (!canAny(c.get("member"), "reply_chat")) return refused(c);
  await next();
});

inbox.get("/", (c) => renderScreen(c, { view: viewOf(c.req.query("v")) }));

inbox.get("/:id{[0-9]+}", async (c) => {
  const ch = await chatById(c.env, Number(c.req.param("id")));
  if (!ch) return renderScreen(c, { view: "all", flash: flashFor("gone", c.get("member").locale) });
  return renderScreen(c, { view: viewOf(c.req.query("v")), openId: ch.id, detail: await detailHtml(c, ch), flash: flashFor(c.req.query("m"), c.get("member").locale) });
});

inbox.get("/:id{[0-9]+}/book", async (c) => {
  const ch = await chatById(c.env, Number(c.req.param("id")));
  if (!ch || !rights(c.get("member"), ch).book) return refused(c);
  return renderScreen(c, { view: "all", openId: ch.id, detail: await bookHtml(c, ch) });
});

type Form = Record<string, string | undefined>;
// Every POST: the member's token for this action and chat, the chat still in the Inbox, and the same rights() the buttons were drawn from.
async function guard(c: ConsoleCtx, action: string, need: "act" | "book" = "act"): Promise<{ ch: Chat; f: Form; m: Member } | Response> {
  const m = c.get("member");
  const id = Number(c.req.param("id"));
  const f = (await c.req.parseBody()) as Form;
  if (!Number.isInteger(id) || f.csrf !== (await token(c, m, action, id))) return c.text("Forbidden", 403);
  const ch = await chatById(c.env, id);
  if (!ch || !ch.waiting) return c.redirect(`/app/inbox/${id}?m=gone`, 303);
  if (!rights(m, ch)[need]) return refused(c);
  return { ch, f, m };
}
const to = (c: ConsoleCtx, id: number, code: string) => c.redirect(`/app/inbox/${id}?m=${code}`, 303);
const again = async (c: ConsoleCtx, ch: Chat, text: string, extra: { warn?: string; text?: string; note?: string; status?: 200 | 400 | 409 | 503 } = {}) =>
  renderScreen(c, { view: "all", openId: ch.id, detail: await detailHtml(c, ch, extra), flash: { text }, status: extra.status ?? 200 });

inbox.post("/:id{[0-9]+}/assign", async (c) => {
  const g = await guard(c, "assign");
  if (g instanceof Response) return g;
  const now = Date.now();
  const res = await c.env.DB.batch([claimStmt(c.env, g.ch.id, g.m, now), auditIfChanged(c, "INBOX_ASSIGN", `conv:${g.ch.id}`, "")]);
  if (!res[0].meta.changes) return to(c, g.ch.id, "gone"); // someone else took it first: the page now shows who
  return to(c, g.ch.id, "assigned");
});

inbox.post("/:id{[0-9]+}/reply", async (c) => {
  const g = await guard(c, "reply");
  if (g instanceof Response) return g;
  const { ch, f, m } = g;
  const ic = inboxCopy(m.locale);
  const now = Date.now();
  const text = (f.text ?? "").trim().slice(0, 1000);
  if (!text) return again(c, ch, ic.flashEmpty, { status: 400 });
  // Done on the server: if someone else took the chat after this form was drawn, nothing goes and the text stays in the box.
  if (otherClaim(ch, m, now) && f.seen !== String(ch.claimedBy)) return again(c, ch, ic.claimTaken(ch.claimer ?? ""), { warn: ic.claimTaken(ch.claimer ?? ""), text, status: 409 });
  if (!inWindow(ch, now)) return again(c, ch, ic.flashWindow, { status: 409 });
  try {
    const key = `admin-reply:inbox:${ch.id}:m${m.id}:${(await sha256Hex(text)).slice(0, 16)}`;
    const res = await sendMessage(c.env, ch.id, { type: "text", text }, key);
    const went = res === "SENT" || res === "SKIPPED" || res === "UNKNOWN";
    const resolve = c.env.DB.prepare(`UPDATE attention SET resolved_at = ?2 WHERE target = ?1 AND resolved_at IS NULL AND kind IN ('FREE_TEXT', 'MEDIA_FROM_CUSTOMER', 'OUTSIDE_WINDOW')`).bind(`conv:${ch.id}`, iso(now));
    await c.env.DB.batch([...(went ? [claimStmt(c.env, ch.id, m, now)] : []), ...(res === "SENT" ? [resolve] : []), auditStmt(c, "INBOX_REPLY", `conv:${ch.id}`, res)]);
    const code = ({ SENT: "sent", SKIPPED: "skipped", DUPLICATE: "dup", BLOCKED: "blocked", WINDOW_CLOSED: "window" } as Record<string, string>)[res];
    if (code) return to(c, ch.id, code);
    return again(c, ch, ic.flashNotDelivered, { text, status: 200 }); // FAILED or UNKNOWN: the card stays, with the text, for a retry
  } catch {
    return again(c, ch, consoleCopy(m.locale).notSaved, { text, status: 503 });
  }
});

inbox.post("/:id{[0-9]+}/follow-up", async (c) => {
  const g = await guard(c, "follow-up");
  if (g instanceof Response) return g;
  const { ch, m } = g;
  const now = Date.now();
  if (inWindow(ch, now)) return to(c, ch.id, "gone"); // the window is open again: the reply box is back
  if (!templateVariant(FOLLOW_UP as Extract<Out, { type: "template" }>, ch.locale).approved) return to(c, ch.id, "notapproved");
  // One follow-up per handoff, whoever sends it.
  const handoff = since(ch);
  const sent = await c.env.DB
    .prepare("SELECT 1 FROM messages WHERE conversation_id = ?1 AND direction = 'OUT' AND dedupe_key LIKE 'admin-reply:inbox:%' AND instr(dedupe_key, ?2) > 0 AND status NOT IN ('FAILED', 'SKIPPED')")
    .bind(ch.id, `:followup:${handoff}`) // instr, not a long LIKE: D1 refuses LIKE patterns over 50 characters
    .first();
  if (sent) return to(c, ch.id, "dup");
  const res = await sendMessage(c.env, ch.id, FOLLOW_UP, `admin-reply:inbox:${ch.id}:m${m.id}:followup:${handoff}`);
  await c.env.DB.batch([...(res === "SENT" || res === "UNKNOWN" ? [claimStmt(c.env, ch.id, m, now)] : []), auditStmt(c, "INBOX_FOLLOW_UP", `conv:${ch.id}`, res)]);
  const code = ({ SENT: "followup", SKIPPED: "skipped", DUPLICATE: "dup", BLOCKED: "blocked", TEMPLATE_UNAPPROVED: "notapproved", OPTED_OUT: "blocked" } as Record<string, string>)[res];
  if (code) return to(c, ch.id, code);
  return again(c, ch, inboxCopy(m.locale).flashNotDelivered);
});

// Hand back: the bot answers again (HUMAN -> BOT) and the chat's waiting items close. Safety items stay for Done.
inbox.post("/:id{[0-9]+}/hand-back", async (c) => {
  const g = await guard(c, "hand-back");
  if (g instanceof Response) return g;
  const at = iso(Date.now());
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE conversations SET mode = 'BOT', human_since = NULL, claimed_by = NULL, claimed_at = NULL WHERE id = ?1 AND mode = 'HUMAN'").bind(g.ch.id),
    auditIfChanged(c, "INBOX_HAND_BACK", `conv:${g.ch.id}`, "HUMAN -> BOT"),
    c.env.DB.prepare(`UPDATE attention SET resolved_at = ?2 WHERE target = ?1 AND resolved_at IS NULL AND kind IN (${sqlList(CHAT_KINDS)}) AND EXISTS (SELECT 1 FROM conversations WHERE id = ?3 AND mode = 'BOT')`).bind(`conv:${g.ch.id}`, at, g.ch.id),
  ]);
  return to(c, g.ch.id, res[0].meta.changes ? "handedback" : "gone");
});

// Done: a one-line closing note, then every waiting item of the chat closes (safety ones too: only someone allowed to read them gets here),
// the chat goes back to the bot and leaves the Inbox. The audit row is checked first, inside the same batch, so it is written only if something changes.
inbox.post("/:id{[0-9]+}/done", async (c) => {
  const g = await guard(c, "done");
  if (g instanceof Response) return g;
  const { ch, f, m } = g;
  const note = (f.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!note) return again(c, ch, inboxCopy(m.locale).flashNoteNeeded, { note: "", status: 400 });
  const at = iso(Date.now());
  const kinds = sqlList([...CHAT_KINDS, ...SAFETY_KINDS]);
  const target = `conv:${ch.id}`;
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) SELECT ?1, 'INBOX_DONE', ?2, ?3, ?4, ?5, ?6
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?7 AND mode = 'HUMAN') OR EXISTS (SELECT 1 FROM attention WHERE target = ?2 AND resolved_at IS NULL AND kind IN (${kinds}))`,
      ).bind(c.get("email"), target, why(ch, inboxCopy("en")), m.workspaceId, m.id, note, ch.id),
      c.env.DB.prepare(`UPDATE attention SET resolved_at = ?2 WHERE target = ?1 AND resolved_at IS NULL AND kind IN (${kinds})`).bind(target, at),
      c.env.DB.prepare("UPDATE conversations SET mode = CASE mode WHEN 'HUMAN' THEN 'BOT' ELSE mode END, human_since = NULL, claimed_by = NULL, claimed_at = NULL WHERE id = ?1").bind(ch.id),
    ]);
    return to(c, ch.id, res[0].meta.changes ? "done" : "gone");
  } catch {
    return again(c, ch, consoleCopy(m.locale).notSaved, { note, status: 503 });
  }
});

// Book a ₹99 call for them. The payment link goes by the existing booking code (block check, one open call, one guarded hold, the link);
// or, for staff, money received outside Razorpay: the same guarded hold and a HELD call, plus an "ask owner" MARK_PAID request.
inbox.post("/:id{[0-9]+}/book", async (c) => {
  const g = await guard(c, "book", "book");
  if (g instanceof Response) return g;
  const { ch, f, m } = g;
  const ic = inboxCopy(m.locale);
  const r = rights(m, ch);
  const now = Date.now();
  const service = f.service ?? "";
  const who = (f.who ?? "") as ForWhom;
  const startUtc = f.time ?? "";
  const pay = f.pay === "cash" ? "cash" : "link";
  const answer = async (text: string, status: 200 | 400 | 409 = 200) => renderScreen(c, { view: "all", openId: ch.id, detail: await bookHtml(c, ch), flash: { text }, status });
  if (!SERVICES.includes(service) || !WHO.includes(who) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startUtc) || !/^[\w-]{1,40}$/.test(f.n ?? "")) return answer(ic.pickAll, 400);
  if (pay === "cash" && !r.cashAsk) return refused(c);
  if (Date.parse(startUtc) <= now + config.booking.leadMinutes * MIN) return answer(ic.taken, 409);
  if (!(await bookingsOpen(c.env))) return answer(ic.paused, 409);
  if (await c.env.DB.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(ch.waId).first()) return answer(ic.blocked, 409);
  const st = await personState(c.env.DB, ch.id);
  if (noSellActiveFor(st, now)) return answer(ic.noSell(dayName(st.noSellUntil!, m.locale)), 409);
  if (pay === "link" && !inWindow(ch, now)) return answer(ic.linkNeedsWindow, 409);
  const open = await c.env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, i.state FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.conversation_id = ?1 AND ((i.state IN ('PAID', 'RESCHEDULED') AND s.end_utc > ?2) OR (i.state = 'HELD' AND s.hold_until > ?2)) ORDER BY s.start_utc LIMIT 1`,
    )
    .bind(ch.id, iso(now))
    .first<{ startUtc: string; state: string }>();
  if (open) return answer(open.state === "HELD" ? ic.alreadyHolding : ic.hasCall(when(open.startUtc, m.locale, now)), 409);
  // A time someone else holds is refused here, so the customer never gets the bot's "that time was just taken" for the team's pick.
  const slot = generateSlots(istDay(Date.parse(startUtc)), "CALL").find((x) => x.startUtc === startUtc);
  if (!slot) return answer(ic.pickAll, 400);
  const busy = await c.env.DB
    .prepare("SELECT 1 FROM slots WHERE (state = 'BOOKED' OR hold_until > ?3) AND start_utc < ?2 AND end_utc > ?1 AND NOT (owner_id = ?4 AND kind = 'CALL' AND start_utc = ?1)")
    .bind(slot.startUtc, slot.endUtc, iso(now), ch.id)
    .first();
  if (busy) return answer(ic.taken, 409);
  const msgId = `inbox:${ch.id}:${f.n}`; // one booking per drawn form: a double submit sends nothing twice
  if (!ch.ageOk) {
    // The age question goes first, from the bot, exactly as when the customer taps Book; nothing is held yet.
    await bookingChoice(c.env, `svc_${service}`, ch.id, msgId, razorpay(c.env));
    await auditStmt(c, "INBOX_BOOK", `conv:${ch.id}`, "age question sent").run();
    return answer(ic.ageAsked);
  }
  if (pay === "link") {
    await bookingChoice(c.env, `time_${service}_${who}_${startUtc}`, ch.id, msgId, razorpay(c.env));
    const held = await c.env.DB
      .prepare(
        `SELECT i.id, s.hold_until AS until, p.state AS payState FROM intros i JOIN slots s ON s.id = i.slot_id LEFT JOIN payments p ON p.purpose = 'INTRO' AND p.target_id = i.id
         WHERE i.conversation_id = ?1 AND s.start_utc = ?2 AND s.kind = 'CALL' ORDER BY i.id DESC LIMIT 1`,
      )
      .bind(ch.id, startUtc)
      .first<{ id: number; until: string | null; payState: string | null }>();
    if (held && held.payState === "PENDING" && held.until && held.until > iso(now)) {
      await auditStmt(c, "INBOX_BOOK", `conv:${ch.id}`, `intro:${held.id} payment link`).run();
      return answer(ic.heldLink(clock(held.until, m.locale)));
    }
    if (held && held.payState === "FAILED") return answer(consoleCopy(m.locale).razorpayDown, 409); // the hold was freed again
    return answer(ic.taken, 409);
  }
  // Money received outside Razorpay (staff): hold, a HELD call, then the request for the owner and the audit row.
  const hold = await holdSlot(c.env.DB, { kind: "CALL", startUtc, ownerId: ch.id, nowMs: now });
  if (!hold.ok) return answer(hold.reason === "ALREADY_HOLDING" ? ic.alreadyHolding : ic.taken, 409);
  const intro = await c.env.DB
    .prepare(
      `INSERT INTO intros (conversation_id, slot_id, service, for_whom, call_lang, practitioner_id)
       SELECT ?1, id, ?2, ?3, ?4, ${PRACTITIONER_SQL} FROM slots WHERE kind = 'CALL' AND start_utc = ?5 AND owner_id = ?1 AND state = 'HELD'`,
    )
    .bind(ch.id, service, who, langOf(ch.locale), startUtc)
    .run();
  const introId = intro.meta.last_row_id;
  await c.env.DB.batch([
    askOwnerStmt(c.env, m, "MARK_PAID", `intro:${introId}`, config.prices.intro, "Paid outside Razorpay (cash or UPI), recorded from the Inbox"),
    auditStmt(c, "INBOX_BOOK", `conv:${ch.id}`, `intro:${introId} money received, owner to approve`),
  ]);
  return answer(ic.heldCash(clock(hold.holdUntil, m.locale)));
});

// Move a booked session to another free time: the existing guarded move (src/mybookings.ts), with its rules (3 hours, a single session once).
inbox.post("/:id{[0-9]+}/move", async (c) => {
  const g = await guard(c, "move", "book");
  if (g instanceof Response) return g;
  const { ch, f, m } = g;
  const ic = inboxCopy(m.locale);
  const now = Date.now();
  const sid = Number(f.session);
  const startUtc = f.time ?? "";
  const ses = (await upcomingSessions(c.env, ch.id, now)).find((s) => s.id === sid);
  const answer = async (text: string, status: 200 | 400 | 409 = 200) => renderScreen(c, { view: "all", openId: ch.id, detail: await bookHtml(c, ch), flash: { text }, status });
  if (!ses || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startUtc)) return answer(ic.pickAll, 400);
  if (can(m, "move_booking", { practitionerId: ses.practitionerId }) !== "yes") return refused(c);
  if (!(await moveSession(c.env.DB, ch.id, ses, startUtc, now))) return answer(ic.moveRefused, 409);
  await auditStmt(c, "INBOX_MOVE", `session:${ses.id}`, `${ses.startUtc} -> ${startUtc}`).run();
  const p = { day: dayName(startUtc, m.locale), time: clock(startUtc, m.locale) };
  if (!inWindow(ch, now)) return answer(ic.movedQuiet(ic.at(p.day, p.time)));
  const lang = langOf(ch.locale);
  const cust = { day: dayName(startUtc, lang), time: clock(startUtc, lang) };
  await sendMessage(c.env, ch.id, { type: "text", text: copyFor(ch.locale).moved(cust.day, cust.time) }, `inbox-move:${ses.id}:${startUtc}`);
  return answer(ic.moved(ic.at(p.day, p.time)));
});

// ---------- the 2-hour email ----------
const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const dayStart = (ymd: string) => Date.parse(`${ymd}T00:00:00+05:30`);
const isWorkday = (ymd: string) => (config.hours.days as readonly number[]).includes(new Date(Date.parse(`${ymd}T00:00:00Z`)).getUTCDay());

// Minutes between two instants that fall inside the business's hours (config.hours, Bengaluru time).
export function workingMinutes(fromMs: number, toMs: number): number {
  let total = 0;
  let ymd = istDay(fromMs);
  for (let i = 0; i < 15 && dayStart(ymd) <= toMs; i++) {
    if (isWorkday(ymd)) {
      const a = Math.max(fromMs, dayStart(ymd) + hhmm(config.hours.start) * MIN);
      const b = Math.min(toMs, dayStart(ymd) + hhmm(config.hours.end) * MIN);
      if (b > a) total += (b - a) / MIN;
    }
    ymd = istDay(dayStart(ymd) + 36 * HOUR);
  }
  return Math.floor(total);
}
export const inWorkingHours = (ms: number) => {
  const ymd = istDay(ms);
  const t = istMinutes(iso(ms));
  return isWorkday(ymd) && t >= hhmm(config.hours.start) && t < hhmm(config.hours.end);
};

// Every 2 minutes (the cron): a handed-over chat with no team reply for 2 working hours gets one email to the owner and staff, once per
// handoff (inbox_mail_at is claimed first, and released if no email went). The email says where to look, never who or what was written.
export async function nudgeWaitingChats(env: Env, nowMs = Date.now()): Promise<number> {
  if (env.CONSOLE_V2 !== "true" || !inWorkingHours(nowMs)) return 0;
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.human_since AS humanSince, c.inbox_mail_at AS mailAt FROM conversations c
       WHERE c.mode = 'HUMAN' AND c.human_since IS NOT NULL AND (c.inbox_mail_at IS NULL OR c.inbox_mail_at < c.human_since)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'OUT' AND m.dedupe_key LIKE 'admin-reply:%'
                           AND m.created_at >= c.human_since AND m.status NOT IN ('FAILED', 'SKIPPED'))
       ORDER BY c.human_since LIMIT 20`,
    )
    .all<{ id: number; humanSince: string; mailAt: string | null }>();
  let sent = 0;
  for (const r of results) {
    if (workingMinutes(Date.parse(r.humanSince), nowMs) < config.inbox.mailAfterWorkingMinutes) continue;
    const claim = await env.DB
      .prepare("UPDATE conversations SET inbox_mail_at = ?2 WHERE id = ?1 AND mode = 'HUMAN' AND (inbox_mail_at IS NULL OR inbox_mail_at < human_since)")
      .bind(r.id, iso(nowMs))
      .run();
    if (!claim.meta.changes) continue;
    const team = (
      await env.DB.prepare("SELECT email, role, locale FROM members WHERE workspace_id = ?1 AND status = 'active' AND role IN ('OWNER', 'STAFF')").bind(WORKSPACE_ID).all<{ email: string; role: Member["role"]; locale: string }>()
    ).results.filter((x) => canAny({ id: 0, workspaceId: WORKSPACE_ID, email: x.email, displayName: null, role: x.role, locale: x.locale, status: "active" }, "reply_chat"));
    let went = false;
    for (const t of team) {
      const ic = inboxCopy(t.locale);
      if ((await sendEmailTo(env, t.email, ic.mailSubject, ic.mailBody(`${env.PUBLIC_URL ?? ""}/app/inbox/${r.id}`))) === "SENT") went = true;
    }
    if (went) sent++;
    else await env.DB.prepare("UPDATE conversations SET inbox_mail_at = ?2 WHERE id = ?1 AND inbox_mail_at = ?3").bind(r.id, r.mailAt, iso(nowMs)).run();
  }
  return sent;
}
