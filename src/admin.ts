// Rohit's console (/admin). Same rules as /amma: Access JWT (ROHIT_EMAIL only), POST-only changes, Origin + per-form CSRF,
// escaped output (hono/html), no-store, no JavaScript. Every change is written to audit_log with the Access e-mail.
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { allowedJwt, csrf } from "./amma";
import { config } from "./config";
import type { Env } from "./env";
import { HEARTBEAT_KEY, HEARTBEAT_STALE_MIN, MAIL_LAST_KEY, sendAlerts } from "./mail";
import { ensureState, noSellActiveFor, personState, quietActive } from "./noise";
import { markManualRefund, refundUnused, unusedOf } from "./packages";
import { rupees } from "./copy";
import { approveRefund, declineRefund, requestRefund, retryFailedRefund } from "./pay/refund";
import { razorpay } from "./pay/razorpay";
import { bookingsBetween, dayRange, firstName, type DayItem } from "./report";
import { raiseAwayItems } from "./watch";
import { sendMessage } from "./send";
import { formatIstParts, iso, istDay } from "./slots";
import { getSetting, isSwitch, switchStates, type SwitchName } from "./switches";
import { ago, chip, header, ist, left, mask, page, type Tone } from "./ui";

type Ctx = Context<{ Bindings: Env; Variables: { jwt: string; email: string } }>;
export const admin = new Hono<{ Bindings: Env; Variables: { jwt: string; email: string } }>();

const nowIso = () => iso(Date.now());
const MSG: Record<string, string> = {
  sent: "Reply sent.", skipped: "Reply saved but not sent: SENDS is off.", window: "Not sent: the 24-hour window is closed. A template is needed.",
  blocked: "Not sent: this person is blocked.", dup: "That exact reply was already sent.", failed: "The send failed or is unknown. Check before trying again.",
  empty: "Write a reply first.", resolved: "Resolved.", refunded: "Refund started.", norefund: "No refund possible: nothing to refund, or one already exists.",
  nopay: "No payment found for this item.", approved: "Refund approved and started.", kept: "Kept: no refund.", gone: "Nothing to change (already done).",
  blockedok: "Person blocked.", unblocked: "Person unblocked.", switched: "Switch updated.", envoff: "The env flag in wrangler.toml is off; a setting cannot turn it on.",
  done: "Saved.", notyet: "That session has not started yet.",
  cleared: "Strikes cleared and the quiet period ended.", nosellcleared: "Selling is allowed again for this person.",
  packrefunded: "Refund started for the unused sessions. The balance is now 0.",
  packmanual: "The balance is now 0. This payment is too old for Razorpay: pay it by bank or UPI, then tap \"Mark refunded by hand\".",
  packstale: "The balance changed, or there is nothing to refund. Nothing was done.", manualdone: "Marked as refunded by hand.",
};

admin.use("*", async (c, next) => {
  const who = await allowedJwt(c.env, c.req.header("Cf-Access-Jwt-Assertion"), true);
  if (!who) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  c.set("jwt", who.jwt);
  c.set("email", who.email);
  if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
});

const audit = (c: Ctx, action: string, target: string, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?1, ?2, ?3, ?4)").bind(c.get("email"), action, target, detail).run();
const back = (c: Ctx, code: string) => c.redirect(`/admin?m=${code}`, 303);
const resolveItem = (c: Ctx, id: number) => c.env.DB.prepare("UPDATE attention SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL").bind(id, nowIso()).run();

// ---- what an item means, in plain English ----
const WORDS: Record<string, string> = {
  FREE_TEXT: "A customer wrote something that is not a menu choice.",
  OUTSIDE_WINDOW: "We wanted to message a customer but the 24-hour window is closed, so only an approved template could go.",
  TEMPLATE_UNAPPROVED: "A template message could not be sent because Meta has not approved it yet.",
  RUDE_REFUND_APPROVAL: "Amma reported a rude caller. They are blocked. Their ₹99 refund waits for your decision.",
  LATE_PAYMENT_NO_SLOT: "Someone paid after their slot hold ran out, and the slot was no longer free. Offer a new time or refund.",
  PAYMENT_MISMATCH: "A payment arrived with the wrong amount. Check it, then refund or resolve.",
  PARTIAL_PAYMENT: "A payment link was only partly paid.",
  UNSUPPORTED_PAYMENT: "A payment came in for something we do not sell.",
  DUPLICATE_PAYMENT: "Someone paid twice for the same booking. The extra payment should be refunded.",
  REFUND_FAILED: "The payment provider rejected a refund. Retry it, or resolve it if you refunded by hand.",
  REFUND_STUCK: "A refund has not been confirmed for over 30 minutes. The system keeps retrying.",
  OUTCOME_FAILED: "Applying Amma's outcome failed and will be retried. If it keeps failing, look at it.",
  NOT_FIT_REFUND_REFUSED: "Amma said 'not right fit' but the refund limit (once per person, daily cap) stopped it. Nothing was sent.",
  NOT_FIT_NO_PAYMENT: "Amma said 'not right fit' but no paid payment was found.",
  UNKNOWN_PAYMENT_LINK: "A payment event arrived for a link we do not know.",
  CRISIS: "A customer wrote something that may mean they are thinking of ending their life. They were sent the helpline message (Tele-MANAS 14416, 112), the chat is with a person now, and nothing is sold to them for 7 days. Please write to them yourself as soon as you can.",
  EMERGENCY: "A customer described what may be a medical emergency. They were told to call 112 or 108. Check whether they need anything from you.",
  HUMAN_REQUEST: "A customer tapped 'Talk to a person'. The bot is quiet in this chat until you resolve this: resolving hands the chat back to the bot.",
  MEDIA_FROM_CUSTOMER: "A customer with a booking, a held time or a payment in progress sent a photo, voice note or file (never downloaded). It may be a payment screenshot.",
  AMMA_NO_TAP: `Amma has not tapped an outcome ${config.limits.ammaTapReminderHours} hours after a call.`,
  AMMA_AWAY_CALL: "Amma is away. This call is booked: offer a new time or refund.",
  AMMA_AWAY_SESSION: "Amma is away. This session is booked: offer a new time or refund.",
  MANUAL_REFUND: `A package refund is for a payment older than ${config.sessionRules.razorpayRefundDays} days, which Razorpay cannot refund. The balance is already 0. Pay the customer by bank or UPI, then tap "Mark refunded by hand".`,
  CANCEL_REFUND_FAILED: "A single session was cancelled in time, but the refund could not be started. Refund it from the payment.",
  CANCEL_NO_PAYMENT: "A single session was cancelled in time, but no paid payment was found to refund.",
  PAID_NO_PACKAGE: "A package payment arrived for a package we cannot find.",
  PAID_PACKAGE_NOT_BOOKABLE: "A package payment arrived for a package that is already closed. Check it, then refund or resolve.",
};
const REPLY_KINDS = ["CRISIS", "EMERGENCY", "FREE_TEXT", "HUMAN_REQUEST", "MEDIA_FROM_CUSTOMER", "OUTSIDE_WINDOW", "AMMA_AWAY_CALL", "AMMA_AWAY_SESSION", "LATE_PAYMENT_NO_SLOT"];
const REFUND_KINDS = ["LATE_PAYMENT_NO_SLOT", "PAYMENT_MISMATCH", "DUPLICATE_PAYMENT", "REFUND_FAILED", "REFUND_STUCK", "OUTCOME_FAILED", "NOT_FIT_REFUND_REFUSED", "AMMA_AWAY_CALL", "AMMA_AWAY_SESSION"];

type Item = { id: number; kind: string; target: string | null; createdAt: string };
type Conv = { id: number; waId: string; name: string | null; mode: string; lastUserAt: string | null; humanSince: string | null; sourceAd: string | null; adHeadline: string | null };

async function convOf(env: Env, target: string | null): Promise<Conv | null> {
  const m = /(conv|intro|session|payment|package):(\d+)/.exec(target ?? "");
  if (!m) return null;
  const id = Number(m[2]);
  const q: Record<string, string> = {
    conv: "c.id = ?1",
    intro: "c.id = (SELECT conversation_id FROM intros WHERE id = ?1)",
    session: "c.id = (SELECT conversation_id FROM sessions WHERE id = ?1)",
    package: "c.id = (SELECT conversation_id FROM packages WHERE id = ?1)",
    payment: `c.id = (SELECT CASE p.purpose WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id) WHEN 'PACKAGE' THEN (SELECT conversation_id FROM packages WHERE id = p.target_id) ELSE (SELECT conversation_id FROM sessions WHERE id = p.target_id) END FROM payments p WHERE p.id = ?1)`,
  };
  return env.DB
    .prepare(`SELECT c.id, c.wa_id AS waId, c.display_name AS name, c.mode, c.last_user_at AS lastUserAt, c.human_since AS humanSince, c.source_ad_id AS sourceAd, c.ad_headline AS adHeadline FROM conversations c WHERE ${q[m[1]]}`)
    .bind(id)
    .first<Conv>();
}

type Pay = { id: number; state: string; refundState: string | null; paise: number };
async function paymentOf(env: Env, target: string | null): Promise<Pay | null> {
  const m = /^(payment|intro|session):(\d+)$/.exec(target ?? "");
  if (!m) return null;
  const where =
    m[1] === "payment" ? "p.id = ?1" : `p.purpose = '${m[1] === "intro" ? "INTRO" : "SESSION"}' AND p.target_id = ?1 AND p.state IN ('PAID','UNKNOWN','REFUND_PENDING','REFUNDED','REFUND_FAILED')`;
  return env.DB
    .prepare(`SELECT p.id, p.state, r.state AS refundState, COALESCE(p.paid_paise, p.amount_paise) AS paise FROM payments p LEFT JOIN refunds r ON r.payment_id = p.id WHERE ${where} ORDER BY p.id DESC LIMIT 1`)
    .bind(Number(m[2]))
    .first<Pay>();
}

const inWindow = (c: Conv | null) => Boolean(c?.lastUserAt && Date.now() - Date.parse(c.lastUserAt) < config.windowHours * 3_600_000);

// ---- small form helper (token per form scope) ----
async function form(c: Ctx, action: string, scope: string, fields: Record<string, string | number>, label: string, cls = "", extra: unknown = "") {
  const token = await csrf(c.get("jwt"), scope);
  const hidden = Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${String(v)}">`);
  return html`<form method="post" action="/admin/${action}">${hidden}<input type="hidden" name="csrf" value="${token}">${extra}<button class="${cls}" type="submit">${label}</button></form>`;
}

// ---- how an item reads on a phone: a title, who, what happened, what to do, and the deadline ----
const TITLE: Record<string, string> = {
  CRISIS: "Crisis message", EMERGENCY: "Possible medical emergency", HUMAN_REQUEST: "Wants to talk to a person",
  FREE_TEXT: "Wrote something the bot could not handle", MEDIA_FROM_CUSTOMER: "Sent a photo, voice note or file", OUTSIDE_WINDOW: "Could not message them: window closed",
  TEMPLATE_UNAPPROVED: "A template is not approved yet", RUDE_REFUND_APPROVAL: "Refund waiting for your decision", LATE_PAYMENT_NO_SLOT: "Paid after the hold ran out",
  PAYMENT_MISMATCH: "Payment with the wrong amount", PARTIAL_PAYMENT: "Payment only partly paid", UNSUPPORTED_PAYMENT: "Payment for something we don't sell",
  DUPLICATE_PAYMENT: "Paid twice", REFUND_FAILED: "Refund failed", REFUND_STUCK: "Refund not confirmed yet", OUTCOME_FAILED: "Amma's outcome did not apply",
  NOT_FIT_REFUND_REFUSED: "'Not right fit' refund was stopped", NOT_FIT_NO_PAYMENT: "'Not right fit' but no payment found", UNKNOWN_PAYMENT_LINK: "Payment for an unknown link",
  AMMA_NO_TAP: "Amma has not marked a call", AMMA_AWAY_CALL: "Amma away: a booked call to move", AMMA_AWAY_SESSION: "Amma away: a booked session to move",
  MANUAL_REFUND: "Refund to pay by hand", CANCEL_REFUND_FAILED: "Cancelled session: refund did not start", CANCEL_NO_PAYMENT: "Cancelled session: no payment found",
  PAID_NO_PACKAGE: "Package payment, package missing", PAID_PACKAGE_NOT_BOOKABLE: "Package payment for a closed package",
};
const TODO: Record<string, string> = {
  CRISIS: "Write to them yourself now. Tap Done once you have.",
  EMERGENCY: "Check whether they need anything from you, then tap Done.",
  HUMAN_REQUEST: "Reply below. Done gives the chat back to the bot.",
  FREE_TEXT: "Reply if it needs one, otherwise tap Done.",
  MEDIA_FROM_CUSTOMER: "It may be a payment screenshot: check the payment, reply, then tap Done.",
  RUDE_REFUND_APPROVAL: "Approve the refund or keep it.",
  MANUAL_REFUND: "Pay them by bank or UPI, then mark it refunded.",
  DUPLICATE_PAYMENT: "Refund the extra payment.",
  REFUND_FAILED: "Retry the refund, or tap Done if you refunded by hand.",
  LATE_PAYMENT_NO_SLOT: "Offer a new time, or refund.",
  AMMA_AWAY_CALL: "Offer a new time, or refund.",
  AMMA_AWAY_SESSION: "Offer a new time, or refund.",
};
const MONEY_KINDS = new Set([...REFUND_KINDS, "MANUAL_REFUND", "RUDE_REFUND_APPROVAL", "PARTIAL_PAYMENT", "UNSUPPORTED_PAYMENT", "UNKNOWN_PAYMENT_LINK", "NOT_FIT_NO_PAYMENT", "CANCEL_REFUND_FAILED", "CANCEL_NO_PAYMENT", "PAID_NO_PACKAGE", "PAID_PACKAGE_NOT_BOOKABLE"]);
// 0: someone may be in danger, 1: someone is waiting for a person, 2: money, 3: everything else.
const rank = (kind: string) => (kind === "CRISIS" || kind === "EMERGENCY" ? 0 : kind === "HUMAN_REQUEST" ? 1 : MONEY_KINDS.has(kind) ? 2 : 3);
const toneOf = (kind: string): Tone => (rank(kind) === 0 ? "red" : rank(kind) <= 2 ? "amber" : "");
export const sortItems = <T extends { kind: string; id: number }>(items: T[]) => [...items].sort((a, b) => rank(a.kind) - rank(b.kind) || a.id - b.id);
const titleOf = (kind: string) => TITLE[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase().replaceAll("_", " ");

// Chips for the deadlines that matter: the 24-hour reply window, and when a chat waiting for a person goes back to the bot.
function deadlineChips(it: Item, conv: Conv | null, now: number) {
  const out: unknown[] = [];
  if (conv && REPLY_KINDS.includes(it.kind)) {
    const w = conv.lastUserAt ? left(Date.parse(conv.lastUserAt) + config.windowHours * 3_600_000, now) : null;
    const urgent = conv.lastUserAt && Date.parse(conv.lastUserAt) + config.windowHours * 3_600_000 - now < 2 * 3_600_000;
    out.push(w ? chip(`Reply window: ${w} left`, urgent ? "red" : "amber") : chip("Reply window closed"));
  }
  if (conv?.mode === "HUMAN" && conv.humanSince && (it.kind === "HUMAN_REQUEST" || it.kind === "CRISIS")) {
    const b = left(Date.parse(conv.humanSince) + config.handoff.autoReturnHours * 3_600_000, now);
    if (b) out.push(chip(`Back to the bot in ${b}`, "amber"));
  }
  out.push(chip(`Raised ${ago(it.createdAt, now)}`));
  return out;
}

// A dangerous action: one tap opens it, it says what will happen, and the button names the exact action ("Refund ₹799 to …4821").
async function confirmForm(c: Ctx, action: string, scope: string, fields: Record<string, string | number>, summary: string, button: string, why: string) {
  return html`<details class="confirm danger"><summary>${summary}</summary><p class="why">${why}</p>${await form(c, action, scope, fields, button, "danger solid")}</details>`;
}

async function itemHtml(c: Ctx, it: Item, now = Date.now(), onPerson = false) {
  const env = c.env;
  const conv = await convOf(env, it.target);
  const pay = REFUND_KINDS.includes(it.kind) || it.kind === "RUDE_REFUND_APPROVAL" ? await paymentOf(env, it.target) : null;
  const tone = toneOf(it.kind);
  const who = conv
    ? html`<div class="who">${firstName(conv.name)} · ${mask(conv.waId)}${conv.mode === "BLOCKED" ? " · blocked" : ""}${conv.adHeadline || conv.sourceAd ? " · came from an ad" : ""}</div>`
    : "";
  const parts: unknown[] = [];
  const actions: unknown[] = [];
  const to = conv ? mask(conv.waId) : "";

  if (REPLY_KINDS.includes(it.kind) && conv) {
    const msgs = await env.DB
      .prepare("SELECT body, wiped_at AS wipedAt, created_at AS at FROM messages WHERE conversation_id = ?1 AND direction = 'IN' ORDER BY id DESC LIMIT 5")
      .bind(conv.id)
      .all<{ body: string | null; wipedAt: string | null; at: string }>();
    if (msgs.results.length)
      parts.push(
        html`<div class="msgs">${msgs.results.reverse().map((m) => html`<p class="msg"><span class="t">${ist(m.at, now)}</span>${m.wipedAt ? html`<span class="muted">(message text removed)</span>` : (m.body ?? "")}</p>`)}</div>`,
      );
    parts.push(
      inWindow(conv)
        ? html`<div class="reply">${await form(c, "reply", `reply:${it.id}`, { item: it.id }, "Send reply", "primary", html`<textarea name="text" rows="3" maxlength="1000" required placeholder="Write your reply…" aria-label="Reply"></textarea>`)}</div>`
        : html`<p class="small muted">The 24-hour window is closed, so a WhatsApp reply can't go. Call them instead: open their page for the number.</p>`,
    );
  }
  if (it.kind === "RUDE_REFUND_APPROVAL" && pay?.refundState === "PENDING_APPROVAL") {
    actions.push(await confirmForm(c, "approve", `approve:${it.id}`, { item: it.id }, "Approve refund…", `Refund ${rupees(pay.paise)} to ${to}`, "The money goes back to the original payment method. The bank takes a few days."));
    actions.push(await form(c, "keep", `keep:${it.id}`, { item: it.id }, "Keep (no refund)"));
  } else if (REFUND_KINDS.includes(it.kind) && pay && (pay.refundState === "FAILED" || (!pay.refundState && ["PAID", "UNKNOWN"].includes(pay.state)))) {
    const label = pay.refundState === "FAILED" ? "Retry refund" : "Refund";
    actions.push(await confirmForm(c, "refund", `refund:${it.id}`, { item: it.id }, `${label}…`, `${label} ${rupees(pay.paise)} to ${to}`, "The money goes back to the original payment method. The bank takes a few days."));
  }
  if (it.kind === "MANUAL_REFUND") {
    const pid = Number(/^package:(\d+)$/.exec(it.target ?? "")?.[1]);
    const pk = Number.isInteger(pid) ? await unusedOf(env.DB, pid) : null;
    const gave = pk ? await env.DB.prepare("SELECT -delta AS n FROM credits WHERE package_id = ?1 AND reason = 'REFUND' ORDER BY id DESC LIMIT 1").bind(pid).first<{ n: number }>() : null;
    if (pk && gave) {
      parts.push(html`<p class="todo">Pay ${gave.n} unused × ${rupees(pk.price / pk.size)} = ${rupees(gave.n * (pk.price / pk.size))}</p>`);
      actions.push(await form(c, "manual-paid", `manual-paid:${it.id}`, { item: it.id }, "Mark refunded by hand", "primary"));
    }
  }
  if (conv && !onPerson) actions.push(html`<a class="btn" href="/admin/conv/${conv.id}">Open person</a>`);
  actions.push(await form(c, "resolve", `resolve:${it.id}`, { item: it.id }, "Done", "", html`<input type="hidden" name="note" value="">`));
  if (conv)
    actions.push(
      conv.mode === "BLOCKED"
        ? await form(c, "unblock", `unblock:${conv.id}`, { conv: conv.id }, "Unblock")
        : await confirmForm(c, "block", `block:${conv.id}`, { conv: conv.id }, "Block…", `Block ${to}`, "They get no more replies from the bot. You can unblock them on their page."),
    );
  return html`<article class="card ${tone}" id="item-${it.id}"><div class="head"><h3>${titleOf(it.kind)}</h3></div>${who}
${TODO[it.kind] ? html`<p class="todo">${TODO[it.kind]}</p>` : ""}<p class="what small muted">${WORDS[it.kind] ?? "Needs a look."}</p>
<div class="chips">${deadlineChips(it, conv, now)}</div>${parts}<div class="actions">${actions}</div></article>`;
}

const STATE_WORDS: Record<string, [string, Tone]> = {
  PAID: ["Booked, paid", "green"], RESCHEDULED: ["Moved, paid", "green"], CONFIRMED: ["Booked, paid", "green"], CREDIT_BOOKED: ["Booked from package", "green"],
  CALLED_SESSION: ["Called: session suggested", ""], CALLED_NOT_FIT: ["Called: not right fit", ""], MISSED: ["Missed", "amber"], RUDE: ["Rude caller", "red"],
  CANCELLED_BY_US: ["Cancelled by us", "amber"], COMPLETED: ["Completed", ""], NO_SHOW: ["No-show", "amber"], CANCELLED: ["Cancelled", ""], NOT_FIT: ["Not right fit", ""],
};

async function bookingRow(c: Ctx, d: DayItem, nowStr: string) {
  const [word, tone] = STATE_WORDS[d.state] ?? [d.state.replaceAll("_", " ").toLowerCase(), ""];
  const past = d.startUtc <= nowStr;
  const btns =
    d.kind === "SESSION" && ["CONFIRMED", "CREDIT_BOOKED"].includes(d.state) && past
      ? html`<div class="act">${await form(c, "session", `session:${d.id}:COMPLETED`, { id: d.id, v: "COMPLETED" }, "Completed", "primary")}${await form(c, "session", `session:${d.id}:NO_SHOW`, { id: d.id, v: "NO_SHOW" }, "No-show")}</div>`
      : "";
  const service = d.service === "PROTECTION" ? "Energy cleansing" : "Healing";
  return html`<div class="li"><span class="time">${formatIstParts(d.startUtc).time}</span><div class="main"><a href="/admin/conv/${d.convId}"><b>${firstName(d.name)}</b></a>
<div class="muted">${d.kind === "CALL" ? `${rupees(config.prices.intro)} call · 15 min` : "Session · 60 min"} · ${service}</div>${btns}</div><div class="end">${chip(word, tone)}</div></div>`;
}

// ---- the line that says whether the machine is healthy ----
async function health(env: Env, now: number) {
  const beat = await getSetting(env.DB, HEARTBEAT_KEY);
  const stale = !beat || now - Date.parse(beat) > HEARTBEAT_STALE_MIN * 60_000;
  const sent = await env.DB.prepare("SELECT MAX(created_at) AS at FROM messages WHERE direction = 'OUT' AND status = 'SENT'").first<{ at: string | null }>();
  const ai = await env.DB.prepare("SELECT COALESCE(SUM(ai_count), 0) AS n FROM person_state WHERE ai_day = ?1").bind(istDay(now)).first<{ n: number }>();
  const mail = (await getSetting(env.DB, MAIL_LAST_KEY))?.split("|") ?? null;
  const mailFailed = mail?.[0] === "FAILED";
  const aiHigh = (ai?.n ?? 0) >= config.ai.aiRepliesPerDayTotal * 0.8;
  const bad = stale || mailFailed;
  const banner = stale
    ? html`<div class="banner red" role="alert">The bot's 2-minute timer has not run in the last ${HEARTBEAT_STALE_MIN} minutes.<span class="small">Reminders, payment checks and the chat wipe wait for it. Check the Worker's cron triggers in Cloudflare.</span></div>`
    : mailFailed
      ? html`<div class="banner red" role="alert">The last alert email failed to send.<span class="small">Crisis and "talk to a person" emails may not be reaching you. Check the email settings (GO-LIVE step 6).</span></div>`
      : "";
  return {
    bad,
    banner,
    html: html`<div class="health" aria-label="System health"><span><span class="dot ${stale ? "red" : ""}"></span><b>${stale ? "Bot timer stopped" : "Bot running"}</b>${beat ? html` · checked ${ago(beat, now)}` : ""}</span>
<span>Last message sent: <b>${sent?.at ? ist(sent.at, now) : "none yet"}</b></span>
<span${aiHigh ? raw(' class="chip amber"') : ""}>AI replies today: <b>${ai?.n ?? 0} / ${config.ai.aiRepliesPerDayTotal}</b></span>
<span>Last alert email: <b>${mail ? `${mailFailed ? "FAILED " : ""}${ist(mail[1], now)}` : "none yet"}</b></span></div>`,
  };
}

// ---- this week against last week, from our own tables ----
const PAID_STATES = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
async function weekStats(env: Env, a: string, b: string) {
  const n = async (sql: string) => (await env.DB.prepare(sql).bind(a, b).first<{ n: number }>())!.n;
  return {
    chats: await n("SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?1 AND created_at < ?2"),
    adChats: await n("SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?1 AND created_at < ?2 AND (source_ad_id IS NOT NULL OR ad_click_id IS NOT NULL)"),
    intros: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose = 'INTRO' AND state IN ${PAID_STATES} AND created_at >= ?1 AND created_at < ?2`),
    later: await n(`SELECT COUNT(*) AS n FROM payments WHERE purpose IN ('SESSION','PACKAGE') AND state IN ${PAID_STATES} AND created_at >= ?1 AND created_at < ?2`),
    paise: await n(`SELECT COALESCE(SUM(COALESCE(paid_paise, amount_paise)), 0) AS n FROM payments WHERE state IN ${PAID_STATES} AND created_at >= ?1 AND created_at < ?2`),
    refundPaise: await n(
      "SELECT COALESCE(SUM(COALESCE(p.paid_paise, p.amount_paise)), 0) AS n FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.state = 'REFUNDED' AND r.created_at >= ?1 AND r.created_at < ?2",
    ),
  };
}
const kpi = (k: string, v: string, d: string) => html`<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

// ---- the switches, each saying what stops and what keeps working ----
const SWITCH_TEXT: Record<SwitchName, { label: string; off: string; banner: string }> = {
  NEW_BOOKINGS: {
    label: "New bookings",
    off: "When paused, nobody can start a booking (they're told booking opens soon). Booked calls, reminders and answers carry on.",
    banner: "New bookings are paused: nobody can book.",
  },
  AMMA_AWAY: {
    label: "Amma away",
    off: "When Amma is away, new bookings pause and every call and session today and tomorrow becomes an item for you to move or refund.",
    banner: "Amma is marked away: bookings are paused.",
  },
  SENDS: {
    label: "Outbound messages",
    off: "When paused, the bot sends nothing except the crisis and emergency safety messages. Incoming messages are still saved.",
    banner: "Outbound messages are paused: customers get no replies.",
  },
  AI_REPLIES: {
    label: "AI answers",
    off: "When paused, typed questions get a short fixed reply and an item for you; nothing goes to the AI. Buttons and booking keep working.",
    banner: "AI answers are paused: typed questions get a fixed reply.",
  },
};

admin.get("/", async (c) => {
  const now = Date.now();
  await sendAlerts(c.env, now, { heartbeat: true }).catch(() => []); // opening /admin also checks the heartbeat
  const sw = await switchStates(c.env);
  const banners: unknown[] = [];
  const cards = await Promise.all(
    sw.map(async (s) => {
      const t = SWITCH_TEXT[s.name];
      const away = s.name === "AMMA_AWAY";
      const on = away ? !s.on : s.on; // "on" here means: working normally
      const state = away ? (s.on ? "Away" : "Here") : s.on ? "On" : "Paused";
      const note = !away && !s.envOn ? " (off in wrangler.toml, the master switch)" : s.name === "NEW_BOOKINGS" && s.paused && sw[1].on ? " (paused by Amma away)" : "";
      if (!on) banners.push(html`<div class="banner ${s.name === "SENDS" ? "red" : "amber"}" role="alert">${t.banner}<span class="small">${note ? note.trim() : "Change it under Controls below."}</span></div>`);
      let btn: unknown = "";
      if (away)
        btn = s.on
          ? await form(c, "switch", `switch:AMMA_AWAY:off`, { name: s.name, v: "off" }, "Amma is back", "primary")
          : await confirmForm(c, "switch", `switch:AMMA_AWAY:on`, { name: s.name, v: "on" }, "Amma is away…", "Mark Amma away", t.off);
      else if (s.envOn)
        btn = s.paused
          ? await form(c, "switch", `switch:${s.name}:on`, { name: s.name, v: "on" }, `Resume ${t.label.toLowerCase()}`, "primary")
          : await confirmForm(c, "switch", `switch:${s.name}:off`, { name: s.name, v: "off" }, "Pause…", `Pause ${t.label.toLowerCase()}`, t.off);
      return html`<div class="card switch"><div class="head"><h3>${t.label}</h3>${chip(state, on ? "green" : away ? "amber" : "red")}</div>
<p class="small muted">${t.off}${note}</p>${btn ? html`<div class="actions">${btn}</div>` : ""}</div>`;
    }),
  );
  const items = await c.env.DB.prepare("SELECT id, kind, target, created_at AS createdAt FROM attention WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 50").all<Item>();
  const sorted = sortItems(items.results);
  const itemsHtml = await Promise.all(sorted.map((i) => itemHtml(c, i, now)));
  const nowStr = iso(now);
  const day = async (title: string, ymd: string) => {
    const rows = await bookingsBetween(c.env, ...dayRange(ymd));
    const out = await Promise.all(rows.map((r) => bookingRow(c, r, nowStr)));
    return html`<div class="daylabel">${title} · ${formatIstParts(dayRange(ymd)[0]).day}</div>${rows.length ? html`<div class="list">${out}</div>` : html`<div class="list"><p class="empty">Nothing booked.</p></div>`}`;
  };
  const h = await health(c.env, now);
  const wk = await weekStats(c.env, iso(now - 7 * 86_400_000), "9999-12-31T00:00:00Z");
  const prev = await weekStats(c.env, iso(now - 14 * 86_400_000), iso(now - 7 * 86_400_000));
  const was = (n: number) => `last week ${n}`;
  const m = c.req.query("m");
  const test = (c.env.PUBLIC_URL ?? "").includes("bot-test");
  const urgent = sorted.filter((i) => rank(i.kind) === 0).length;
  const body = html`${header("Home", `Disha Dira console${test ? " · test copy" : ""} · ${ist(nowStr, now)}`, html`<a class="btn" href="/admin">Refresh</a>`)}
${h.banner}${banners}${h.html}
<div class="cols"><section aria-label="Needs you">
<h2>Needs you <span class="count">${sorted.length}</span></h2>
${sorted.length ? itemsHtml : html`<div class="card"><p class="empty"><b>Nothing needs you.</b><br>The bot is handling everything.</p></div>`}
</section><aside>
<h2>Today and tomorrow</h2>${await day("Today", istDay(now))}${await day("Tomorrow", istDay(now + 86_400_000))}
<h2>Last 7 days</h2>
<div class="week">${kpi("New chats", String(wk.chats), `${wk.adChats} from ads · ${was(prev.chats)}`)}${kpi(`${rupees(config.prices.intro)} calls paid`, String(wk.intros), was(prev.intros))}${kpi(
    "Sessions & packs paid",
    String(wk.later),
    was(prev.later),
  )}${kpi("Money in", rupees(wk.paise), `refunds ${rupees(wk.refundPaise)} · last week ${rupees(prev.paise)}`)}</div>
<h2>Controls</h2>${cards}</aside></div>`;
  return c.html(page({ title: urgent ? `(${urgent}) Home` : "Home", tab: "home", body, flash: m && MSG[m] ? MSG[m] : null, badge: sorted.length }));
});

// ---- POST actions: each re-checks its own CSRF token, then makes one conditional change and one audit row ----
const bad = (c: Ctx) => c.text("Forbidden", 403);

async function itemAction(c: Ctx, scope: string, run: (item: Item, f: Record<string, string | File>) => Promise<string>) {
  const f = await c.req.parseBody();
  const id = Number(f.item);
  if (!Number.isInteger(id) || f.csrf !== (await csrf(c.get("jwt"), `${scope}:${id}`))) return bad(c);
  const item = await c.env.DB.prepare("SELECT id, kind, target, created_at AS createdAt FROM attention WHERE id = ?1").bind(id).first<Item>();
  if (!item) return back(c, "gone");
  return back(c, await run(item, f));
}

admin.post("/reply", (c) =>
  itemAction(c, "reply", async (item, f) => {
    const text = String(f.text ?? "").trim().slice(0, 1000);
    const conv = await convOf(c.env, item.target);
    if (!conv) return "gone";
    if (!text) return "empty";
    if (!inWindow(conv)) return "window"; // free-form only inside the 24h window
    const key = `admin-reply:${item.id}:${await sha(text)}`;
    const res = await sendMessage(c.env, conv.id, { type: "text", text }, key);
    await audit(c, "ADMIN_REPLY", `conv:${conv.id}`, `item ${item.id}: ${res}`);
    return res === "SENT" ? "sent" : res === "SKIPPED" ? "skipped" : res === "BLOCKED" ? "blocked" : res === "DUPLICATE" ? "dup" : res === "WINDOW_CLOSED" ? "window" : "failed";
  }),
);

admin.post("/resolve", (c) =>
  itemAction(c, "resolve", async (item, f) => {
    const res = await resolveItem(c, item.id);
    if (!res.meta.changes) return "gone";
    await audit(c, "ADMIN_RESOLVE", `attention:${item.id}`, `${item.kind}: ${String(f.note ?? "").slice(0, 200)}`);
    if (item.kind === "HUMAN_REQUEST" || item.kind === "CRISIS") {
      // The person asked for a human (or wrote a crisis message) and one has now answered: the chat goes back to the bot (a blocked chat stays blocked).
      // A crisis message also stopped selling for 7 days; that stays until it runs out or Rohit clears it on the person's page.
      const conv = await convOf(c.env, item.target);
      const back = conv ? await c.env.DB.prepare("UPDATE conversations SET mode = 'BOT', human_since = NULL WHERE id = ?1 AND mode = 'HUMAN'").bind(conv.id).run() : null;
      if (back?.meta.changes) await audit(c, "ADMIN_HUMAN_DONE", `conv:${conv!.id}`, "mode HUMAN -> BOT");
    }
    return "resolved";
  }),
);

admin.post("/refund", (c) =>
  itemAction(c, "refund", async (item) => {
    const pay = await paymentOf(c.env, item.target);
    if (!pay) return "nopay";
    const provider = razorpay(c.env);
    let did = false;
    if (pay.refundState === "FAILED") did = await retryFailedRefund(c.env, provider, pay.id);
    else if (!pay.refundState && ["PAID", "UNKNOWN"].includes(pay.state)) did = (await requestRefund(c.env, provider, pay.id, "ADMIN", c.get("email"))) === "CREATED";
    if (!did) return "norefund";
    await resolveItem(c, item.id);
    await audit(c, "ADMIN_REFUND", `payment:${pay.id}`, item.kind);
    return "refunded";
  }),
);

admin.post("/approve", (c) =>
  itemAction(c, "approve", async (item) => {
    const pay = await paymentOf(c.env, item.target);
    if (!pay || !(await approveRefund(c.env, razorpay(c.env), pay.id))) return "gone";
    await resolveItem(c, item.id);
    await audit(c, "ADMIN_APPROVE_REFUND", `payment:${pay.id}`, item.kind);
    return "approved";
  }),
);

admin.post("/keep", (c) =>
  itemAction(c, "keep", async (item) => {
    const pay = await paymentOf(c.env, item.target);
    if (!pay || !(await declineRefund(c.env, pay.id))) return "gone";
    await resolveItem(c, item.id);
    await audit(c, "ADMIN_KEEP_NO_REFUND", `payment:${pay.id}`, `${item.kind}: declined by ${c.get("email")}`);
    return "kept";
  }),
);

async function blockAction(c: Ctx, block: boolean) {
  const f = await c.req.parseBody();
  const id = Number(f.conv);
  if (!Number.isInteger(id) || f.csrf !== (await csrf(c.get("jwt"), `${block ? "block" : "unblock"}:${id}`))) return bad(c);
  const conv = await c.env.DB.prepare("SELECT id, wa_id AS waId FROM conversations WHERE id = ?1").bind(id).first<{ id: number; waId: string }>();
  if (!conv) return back(c, "gone");
  if (block) {
    await c.env.DB.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(id).run();
    await c.env.DB.prepare("INSERT INTO blocks (wa_id, reason, by, created_at) SELECT ?1, 'ADMIN', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)").bind(conv.waId, c.get("email"), nowIso()).run();
  } else {
    await c.env.DB.prepare("DELETE FROM blocks WHERE wa_id = ?1").bind(conv.waId).run();
    await c.env.DB.prepare("UPDATE conversations SET mode = 'BOT' WHERE id = ?1 AND mode = 'BLOCKED'").bind(id).run();
  }
  await audit(c, block ? "ADMIN_BLOCK" : "ADMIN_UNBLOCK", `conv:${id}`, "");
  return back(c, block ? "blockedok" : "unblocked");
}
admin.post("/block", (c) => blockAction(c, true));
admin.post("/unblock", (c) => blockAction(c, false));

// ---- one person: their open items, strikes, quiet period, no-sell, opt-out and packages ----
const when = (v: string | null, now = Date.now()) => (v ? ist(v, now) : "no");
const MODE_WORDS: Record<string, [string, Tone]> = { BOT: ["Bot is answering", "green"], HUMAN: ["Waiting for a person", "amber"], BLOCKED: ["Blocked", "red"] };

admin.get("/conv/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const conv = Number.isInteger(id)
    ? await c.env.DB.prepare(
        "SELECT id, wa_id AS waId, display_name AS name, mode, locale, last_user_at AS lastUserAt, human_since AS humanSince, source_ad_id AS sourceAd, ad_headline AS adHeadline, created_at AS createdAt FROM conversations WHERE id = ?1",
      )
        .bind(id)
        .first<Conv & { locale: string; createdAt: string }>()
    : null;
  if (!conv) return c.text("Not found", 404);
  const st = await personState(c.env.DB, id);
  const now = Date.now();
  const quiet = quietActive(st, now);
  const noSell = noSellActiveFor(st, now);
  const m = c.req.query("m");
  const clearStrikes = await form(c, "clear-strikes", `clear-strikes:${id}`, { conv: id }, "Clear strikes / end quiet", "");
  const clearNoSell = await form(c, "clear-nosell", `clear-nosell:${id}`, { conv: id }, "Clear no-sell", "");
  const open = await c.env.DB
    .prepare("SELECT id, kind, target, created_at AS createdAt FROM attention WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 100")
    .all<Item>();
  const mine: Item[] = [];
  for (const it of open.results) if ((await convOf(c.env, it.target))?.id === id) mine.push(it);
  const items = await Promise.all(sortItems(mine).map((i) => itemHtml(c, i, now, true)));
  const packs = await c.env.DB.prepare("SELECT id FROM packages WHERE conversation_id = ?1 AND state IN ('PAID', 'CLOSED') ORDER BY id").bind(id).all<{ id: number }>();
  const packBlock = packs.results.length
    ? await Promise.all(
        packs.results.map(async (r) => {
          const pk = (await unusedOf(c.env.DB, r.id))!;
          const rate = pk.price / pk.size;
          return html`<div class="card"><div class="head"><h3>${pk.size} sessions · ${rupees(pk.price)}</h3>${chip(pk.state === "CLOSED" ? "Closed" : `${pk.unused} left`, pk.state === "CLOSED" ? "" : "green")}</div>
<p class="small muted">${pk.state === "CLOSED" ? "Closed. " : ""}Unused: ${pk.unused} × ${rupees(rate)} = ${rupees(pk.unused * rate)}</p>
${pk.state === "PAID" && pk.unused > 0 ? html`<div class="actions"><a class="btn danger" href="/admin/pack-refund/${pk.id}">Refund unused sessions</a></div>` : ""}</div>`;
        }),
      )
    : html`<div class="list"><p class="empty">No packages.</p></div>`;
  const [modeWord, modeTone] = MODE_WORDS[conv.mode] ?? [conv.mode, ""];
  const ad = conv.adHeadline ? `Came from the ad "${conv.adHeadline}"` : conv.sourceAd ? "Came from an ad" : "Did not come from an ad";
  const body = html`${header(firstName(conv.name), `${mask(conv.waId)} · ${conv.locale === "hi" ? "Hindi" : "English"} · first message ${ist(conv.createdAt, now)}`, html`<a class="btn" href="/admin">Back</a>`)}
<div class="chips">${chip(modeWord, modeTone)}${quiet ? chip("Quiet period", "amber") : ""}${noSell ? chip("No selling", "amber") : ""}${st.optedOutAt ? chip("Opted out") : ""}</div>
<p class="small muted">${ad}. Last message from them ${conv.lastUserAt ? ago(conv.lastUserAt, now) : "never"}.</p>
<div class="cols"><section>${items.length ? html`<h2>Needs you <span class="count">${items.length}</span></h2>${items}` : html`<h2>Needs you</h2><div class="card"><p class="empty">Nothing open for this person.</p></div>`}</section><aside>
<h2>Safety and noise</h2>
<div class="list"><div class="li"><div class="main">Strikes: ${st.strikes}${st.lastStrikeAt ? ` (last ${when(st.lastStrikeAt, now)})` : ""}</div>${chip(st.strikes ? "Has strikes" : "None", st.strikes ? "amber" : "green")}</div>
<div class="li"><div class="main">${quiet ? `Quiet until: ${when(st.quietUntil, now)}` : "Quiet: not in a quiet period"}</div>${chip(quiet ? "Quiet" : "Normal", quiet ? "amber" : "green")}</div>
<div class="li"><div class="main">${noSell ? `No selling until: ${when(st.noSellUntil, now)}` : "Selling: selling is allowed"}</div>${chip(noSell ? "No selling" : "Allowed", noSell ? "amber" : "green")}</div>
<div class="li"><div class="main">Opted out of messages: ${st.optedOutAt ? `yes, since ${when(st.optedOutAt, now)}` : "no"}</div></div></div>
<div class="actions">${clearStrikes}${clearNoSell}</div>
<h2>Packages</h2>${packBlock}</aside></div>`;
  return c.html(page({ title: firstName(conv.name), tab: null, body, flash: m && MSG[m] ? MSG[m] : null }));
});

// ---- packages: "Refund unused sessions" shows unused × rate and asks again before anything happens ----
admin.get("/pack-refund/:pid", async (c) => {
  const pid = Number(c.req.param("pid"));
  const pk = Number.isInteger(pid) ? await unusedOf(c.env.DB, pid) : null;
  if (!pk || pk.state !== "PAID" || pk.unused <= 0) return c.redirect("/admin?m=packstale", 303);
  const rate = pk.price / pk.size;
  const confirmForm = await form(c, "pack-refund", `pack-refund:${pid}:${pk.unused}`, { pkg: pid, unused: pk.unused }, `Yes, refund ${rupees(pk.unused * rate)}`, "danger solid");
  const old = pk.paidAt && Date.now() - Date.parse(pk.paidAt) >= config.sessionRules.razorpayRefundDays * 86_400_000;
  const body = html`${header("Refund unused sessions", `${pk.size}-session package · ${rupees(pk.price)}`)}
<div class="card amber"><h3>${pk.unused} unused × ${rupees(rate)} = ${rupees(pk.unused * rate)}</h3>
<p class="small muted">The balance goes to 0 and the money goes back to the original payment method${old ? ". This payment is older than " + config.sessionRules.razorpayRefundDays + " days, so you pay it by hand" : ""}.</p>
<div class="actions">${confirmForm}<a class="btn" href="/admin/conv/${pk.conv}">Back</a></div></div>`;
  return c.html(page({ title: "Refund unused sessions", tab: null, body }));
});

admin.post("/pack-refund", async (c) => {
  const f = await c.req.parseBody();
  const pid = Number(f.pkg);
  const unused = Number(f.unused);
  if (!Number.isInteger(pid) || !Number.isInteger(unused) || f.csrf !== (await csrf(c.get("jwt"), `pack-refund:${pid}:${unused}`))) return bad(c);
  const res = await refundUnused(c.env, razorpay(c.env), pid, unused, c.get("email"));
  if (res.kind === "NOTHING" || res.kind === "STALE") return back(c, "packstale");
  await audit(c, "ADMIN_PACKAGE_REFUND", `package:${pid}`, `${res.unused} unused, ${rupees(res.paise)}, ${res.kind === "MANUAL" ? "by hand" : "Razorpay"}`);
  return back(c, res.kind === "MANUAL" ? "packmanual" : "packrefunded");
});

admin.post("/manual-paid", (c) =>
  itemAction(c, "manual-paid", async (item) => {
    const pid = Number(/^package:(\d+)$/.exec(item.target ?? "")?.[1]);
    if (item.kind !== "MANUAL_REFUND" || !Number.isInteger(pid) || !(await markManualRefund(c.env, pid, c.get("email")))) return "gone";
    await resolveItem(c, item.id);
    await audit(c, "ADMIN_MANUAL_REFUND_PAID", `package:${pid}`, "");
    return "manualdone";
  }),
);

async function stateAction(c: Ctx, scope: string, action: string, sql: string, code: string) {
  const f = await c.req.parseBody();
  const id = Number(f.conv);
  if (!Number.isInteger(id) || f.csrf !== (await csrf(c.get("jwt"), `${scope}:${id}`))) return bad(c);
  const conv = await c.env.DB.prepare("SELECT id FROM conversations WHERE id = ?1").bind(id).first();
  if (!conv) return c.redirect("/admin?m=gone", 303);
  await ensureState(c.env.DB, id);
  await c.env.DB.prepare(sql).bind(id).run();
  await audit(c, action, `conv:${id}`, "");
  return c.redirect(`/admin/conv/${id}?m=${code}`, 303);
}
admin.post("/clear-strikes", (c) =>
  stateAction(c, "clear-strikes", "ADMIN_CLEAR_STRIKES", "UPDATE person_state SET strikes = 0, last_strike_at = NULL, quiet_until = NULL WHERE conversation_id = ?1", "cleared"),
);
admin.post("/clear-nosell", (c) => stateAction(c, "clear-nosell", "ADMIN_CLEAR_NOSELL", "UPDATE person_state SET no_sell_until = NULL WHERE conversation_id = ?1", "nosellcleared"));

// A setting can only turn something OFF that the env allows. "Resume" removes the pause; it never overrides an env flag that is off.
admin.post("/switch", async (c) => {
  const f = await c.req.parseBody();
  const name = f.name;
  const v = f.v;
  if (!isSwitch(name) || (v !== "on" && v !== "off") || f.csrf !== (await csrf(c.get("jwt"), `switch:${name}:${v}`))) return bad(c);
  const sw = (await switchStates(c.env)).find((s) => s.name === name)!;
  if (name !== "AMMA_AWAY" && v === "on" && !sw.envOn) return back(c, "envoff");
  const key: SwitchName = name;
  const value = key === "AMMA_AWAY" ? (v === "on" ? "true" : "false") : v === "off" ? "false" : "true";
  await c.env.DB
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, value, nowIso())
    .run();
  await audit(c, "ADMIN_SWITCH", key, v);
  if (key === "AMMA_AWAY" && v === "on") await raiseAwayItems(c.env);
  return back(c, "switched");
});

admin.post("/session", async (c) => {
  const f = await c.req.parseBody();
  const id = Number(f.id);
  const v = f.v;
  if (!Number.isInteger(id) || (v !== "COMPLETED" && v !== "NO_SHOW") || f.csrf !== (await csrf(c.get("jwt"), `session:${id}:${v}`))) return bad(c);
  const res = await c.env.DB
    .prepare("UPDATE sessions SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ('CONFIRMED', 'CREDIT_BOOKED') AND slot_id IN (SELECT id FROM slots WHERE start_utc <= ?3)")
    .bind(id, v, nowIso())
    .run();
  if (!res.meta.changes) return back(c, "notyet");
  await audit(c, "ADMIN_SESSION", `session:${id}`, v);
  return back(c, "done");
});

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
