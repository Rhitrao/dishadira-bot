// Rohit's console (/admin). Same rules as /amma: Access JWT (ROHIT_EMAIL only), POST-only changes, Origin + per-form CSRF,
// escaped output (hono/html), no-store, no JavaScript. Every change is written to audit_log with the Access e-mail.
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { allowedJwt, CSS, csrf } from "./amma";
import { config } from "./config";
import type { Env } from "./env";
import { heartbeatStale, sendAlerts } from "./mail";
import { approveRefund, declineRefund, requestRefund, retryFailedRefund } from "./pay/refund";
import { cashfree } from "./pay/cashfree";
import { bookingsBetween, dayRange, firstName, scoreboard, scoreLines, type DayItem } from "./report";
import { raiseAwayItems } from "./watch";
import { sendMessage } from "./send";
import { formatIstParts, iso, istDay } from "./slots";
import { isSwitch, switchStates, type SwitchName } from "./switches";

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
  AMMA_NO_TAP: `Amma has not tapped an outcome ${config.limits.ammaTapReminderHours} hours after a call.`,
  AMMA_AWAY_CALL: "Amma is away. This call is booked: offer a new time or refund.",
  AMMA_AWAY_SESSION: "Amma is away. This session is booked: offer a new time or refund.",
};
const REPLY_KINDS = ["FREE_TEXT", "OUTSIDE_WINDOW", "AMMA_AWAY_CALL", "AMMA_AWAY_SESSION", "LATE_PAYMENT_NO_SLOT"];
const REFUND_KINDS = ["LATE_PAYMENT_NO_SLOT", "PAYMENT_MISMATCH", "DUPLICATE_PAYMENT", "REFUND_FAILED", "REFUND_STUCK", "OUTCOME_FAILED", "NOT_FIT_REFUND_REFUSED", "AMMA_AWAY_CALL", "AMMA_AWAY_SESSION"];

type Item = { id: number; kind: string; target: string | null; createdAt: string };
type Conv = { id: number; waId: string; name: string | null; mode: string; lastUserAt: string | null };

async function convOf(env: Env, target: string | null): Promise<Conv | null> {
  const m = /(conv|intro|session|payment):(\d+)/.exec(target ?? "");
  if (!m) return null;
  const id = Number(m[2]);
  const q: Record<string, string> = {
    conv: "c.id = ?1",
    intro: "c.id = (SELECT conversation_id FROM intros WHERE id = ?1)",
    session: "c.id = (SELECT conversation_id FROM sessions WHERE id = ?1)",
    payment: `c.id = (SELECT CASE p.purpose WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id) ELSE (SELECT conversation_id FROM sessions WHERE id = p.target_id) END FROM payments p WHERE p.id = ?1)`,
  };
  return env.DB
    .prepare(`SELECT c.id, c.wa_id AS waId, c.display_name AS name, c.mode, c.last_user_at AS lastUserAt FROM conversations c WHERE ${q[m[1]]}`)
    .bind(id)
    .first<Conv>();
}

type Pay = { id: number; state: string; refundState: string | null };
async function paymentOf(env: Env, target: string | null): Promise<Pay | null> {
  const m = /^(payment|intro|session):(\d+)$/.exec(target ?? "");
  if (!m) return null;
  const where =
    m[1] === "payment" ? "p.id = ?1" : `p.purpose = '${m[1] === "intro" ? "INTRO" : "SESSION"}' AND p.target_id = ?1 AND p.state IN ('PAID','UNKNOWN','REFUND_PENDING','REFUNDED','REFUND_FAILED')`;
  return env.DB
    .prepare(`SELECT p.id, p.state, r.state AS refundState FROM payments p LEFT JOIN refunds r ON r.payment_id = p.id WHERE ${where} ORDER BY p.id DESC LIMIT 1`)
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

async function itemHtml(c: Ctx, it: Item) {
  const env = c.env;
  const conv = await convOf(env, it.target);
  const pay = REFUND_KINDS.includes(it.kind) || it.kind === "RUDE_REFUND_APPROVAL" ? await paymentOf(env, it.target) : null;
  const who = conv ? html`<div class="sub">${firstName(conv.name)} · …${conv.waId.slice(-4)}${conv.mode === "BLOCKED" ? " · BLOCKED" : ""}</div>` : "";
  const parts: unknown[] = [];

  if (REPLY_KINDS.includes(it.kind) && conv) {
    const msgs = await env.DB.prepare("SELECT body, created_at AS at FROM messages WHERE conversation_id = ?1 AND direction = 'IN' ORDER BY id DESC LIMIT 5").bind(conv.id).all<{ body: string | null; at: string }>();
    parts.push(html`<div class="msgs">${msgs.results.reverse().map((m) => html`<div class="m">${m.at.slice(0, 16).replace("T", " ")} UTC · ${m.body ?? ""}</div>`)}</div>`);
    parts.push(
      inWindow(conv)
        ? await form(c, "reply", `reply:${it.id}`, { item: it.id }, "Send reply", "go", html`<textarea name="text" rows="3" maxlength="1000" required></textarea>`)
        : html`<p class="msg">The 24-hour window is closed. Only an approved template can be sent.</p>`,
    );
  }
  if (it.kind === "RUDE_REFUND_APPROVAL" && pay?.refundState === "PENDING_APPROVAL") {
    parts.push(await form(c, "approve", `approve:${it.id}`, { item: it.id }, "Approve refund", "go"));
    parts.push(await form(c, "keep", `keep:${it.id}`, { item: it.id }, "Keep (no refund)"));
  } else if (REFUND_KINDS.includes(it.kind) && pay && (pay.refundState === "FAILED" || (!pay.refundState && ["PAID", "UNKNOWN"].includes(pay.state)))) {
    parts.push(await form(c, "refund", `refund:${it.id}`, { item: it.id }, pay.refundState === "FAILED" ? "Retry refund" : "Refund"));
  }
  parts.push(await form(c, "resolve", `resolve:${it.id}`, { item: it.id }, "Resolve", "", html`<input type="text" name="note" maxlength="200" placeholder="Note (optional)">`));
  if (conv) {
    parts.push(
      conv.mode === "BLOCKED"
        ? await form(c, "unblock", `unblock:${conv.id}`, { conv: conv.id }, "Unblock contact")
        : await form(c, "block", `block:${conv.id}`, { conv: conv.id }, "Block contact", "red"),
    );
  }
  return html`<div class="row"><div class="top">${it.kind.replaceAll("_", " ")}</div>${who}<div class="msg">${WORDS[it.kind] ?? "Needs a look."}</div>
<div class="sub">${it.createdAt.slice(0, 16).replace("T", " ")} UTC · ${it.target ?? ""}</div>${parts}</div>`;
}

async function bookingRow(c: Ctx, d: DayItem, nowStr: string) {
  const status = d.state.replaceAll("_", " ").toLowerCase();
  const past = d.startUtc <= nowStr;
  const btns =
    d.kind === "SESSION" && d.state === "CONFIRMED" && past
      ? html`${await form(c, "session", `session:${d.id}:COMPLETED`, { id: d.id, v: "COMPLETED" }, "Completed", "go")}${await form(c, "session", `session:${d.id}:NO_SHOW`, { id: d.id, v: "NO_SHOW" }, "No-show")}`
      : "";
  return html`<div class="row"><div class="top">${formatIstParts(d.startUtc).time} · ${firstName(d.name)}</div><div class="sub">${d.kind === "CALL" ? "Call" : "Session"} · ${d.service} · ${status}</div>${btns}</div>`;
}

admin.get("/", async (c) => {
  const now = Date.now();
  const stale = await heartbeatStale(c.env, now);
  await sendAlerts(c.env, now, { heartbeat: true }).catch(() => []); // opening /admin also checks the heartbeat
  const sw = await switchStates(c.env);
  const swRows = await Promise.all(
    sw.map(async (s) => {
      const label = s.name === "NEW_BOOKINGS" ? "New bookings" : s.name === "SENDS" ? "Outbound messages" : "Amma away";
      const state = s.name === "AMMA_AWAY" ? (s.on ? "AWAY" : "here") : s.on ? "ON" : "PAUSED";
      const note = s.name !== "AMMA_AWAY" && !s.envOn ? " (off in wrangler.toml, the master switch)" : s.name === "NEW_BOOKINGS" && s.paused && sw[1].on ? " (paused by Amma away)" : "";
      let btn: unknown = "";
      if (s.name === "AMMA_AWAY") btn = await form(c, "switch", `switch:AMMA_AWAY:${s.on ? "off" : "on"}`, { name: s.name, v: s.on ? "off" : "on" }, s.on ? "Amma is back" : "Amma is away", s.on ? "go" : "red");
      else if (s.envOn) btn = await form(c, "switch", `switch:${s.name}:${s.paused ? "on" : "off"}`, { name: s.name, v: s.paused ? "on" : "off" }, s.paused ? `Resume ${label.toLowerCase()}` : `Pause ${label.toLowerCase()}`, s.paused ? "go" : "red");
      return html`<div class="row"><div class="top">${label}: ${state}</div><div class="sub">${note}</div>${btn}</div>`;
    }),
  );
  const items = await c.env.DB.prepare("SELECT id, kind, target, created_at AS createdAt FROM attention WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 50").all<Item>();
  const itemsHtml = await Promise.all(items.results.map((i) => itemHtml(c, i)));
  const nowStr = iso(now);
  const day = async (title: string, ymd: string) => {
    const rows = await bookingsBetween(c.env, ...dayRange(ymd));
    const out = await Promise.all(rows.map((r) => bookingRow(c, r, nowStr)));
    return html`<h3>${title} · ${formatIstParts(dayRange(ymd)[0]).day}</h3>${rows.length ? out : html`<p class="msg">Nothing booked.</p>`}`;
  };
  const score = scoreLines(await scoreboard(c.env, now));
  const m = c.req.query("m");
  return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Disha Dira admin</title><style>${(CSS + "h3{font-size:22px;margin:16px 0 4px}.red{color:#b00000;border-color:#b00000}.warn{border:3px solid #b00000;padding:12px;font-weight:bold}.m{font-size:17px;margin:4px 0}.msgs{margin:8px 0}textarea,input[type=text]{width:100%;font:18px system-ui,sans-serif;border:2px solid #000;border-radius:8px;padding:8px}") as unknown as never}</style></head><body>
<h1>Disha Dira admin</h1>${m && MSG[m] ? html`<p class="msg"><b>${MSG[m]}</b></p>` : ""}
${stale ? html`<p class="warn">The 2-minute cron has not run in the last 15 minutes.</p>` : ""}
<h2>Switches</h2>${swRows}
<h2>Needs attention (${items.results.length})</h2>${items.results.length ? itemsHtml : html`<p class="msg">Nothing needs you.</p>`}
<h2>Today and tomorrow</h2>${await day("Today", istDay(now))}${await day("Tomorrow", istDay(now + 86_400_000))}
<h2>Last 7 days</h2><div class="row">${score.map((l) => html`<div>${l}</div>`)}</div>
<a class="btn go" href="/admin">Refresh</a></body></html>`);
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
    return "resolved";
  }),
);

admin.post("/refund", (c) =>
  itemAction(c, "refund", async (item) => {
    const pay = await paymentOf(c.env, item.target);
    if (!pay) return "nopay";
    const provider = cashfree(c.env);
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
    if (!pay || !(await approveRefund(c.env, cashfree(c.env), pay.id))) return "gone";
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
    .prepare("UPDATE sessions SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'CONFIRMED' AND slot_id IN (SELECT id FROM slots WHERE start_utc <= ?3)")
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
