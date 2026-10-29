// Ticket 29: our own payment link. WhatsApp (India) re-draws a button whose URL is a Razorpay link as its own "Pay now" card, which
// starts a UPI payment inside WhatsApp instead of opening Razorpay's page (and asked one customer to change their WhatsApp number).
// Meta says wrapped or redirected links don't get that card, so every payment message points at <PUBLIC_URL>/p/<token>, and
// GET /p/<token> sends the person on to the Razorpay page (or says the payment is done, or the link has expired).
//   token = <payments.id>-<first 16 hex of HMAC-SHA256(RAZORPAY_KEY_SECRET, "paylink:" + payments.id)>
// The Razorpay URL and the link's end are kept in one settings row per payment: key paylink:<id>, value {"url", "until"}.
import type { Context } from "hono";
import { html } from "hono/html";
import { config } from "./config";
import { allCopy, copyFor, langOf, type Copy } from "./copy";
import type { Env } from "./env";
import { sendMessage } from "./send";
import { formatIstLang, iso } from "./slots";
import { sendsOn, setSetting } from "./switches";

export const PAYLINK_KEY = (paymentId: number) => `paylink:${paymentId}`;
export const NUDGE_KEY = (paymentId: number) => `paynudge:${paymentId}`;
export const NUDGE_BEFORE_MINUTES = 8; // the reminder goes about this long before the hold ends
const NUDGE_LAST_MINUTES = 1; // ... and not in the last minute, when it could only arrive too late

// No scripts, no fonts, no forms: a page of text and one link.
export const PAYLINK_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function mac(secret: string, paymentId: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`paylink:${paymentId}`))).slice(0, 16);
}

// Compares every character whatever the input, so the time taken says nothing about how much of a guess was right.
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

export async function payToken(env: Pick<Env, "RAZORPAY_KEY_SECRET">, paymentId: number): Promise<string | null> {
  if (!env.RAZORPAY_KEY_SECRET) return null;
  return `${paymentId}-${await mac(env.RAZORPAY_KEY_SECRET, paymentId)}`;
}

// The payment id a token stands for, or null for anything we did not make.
export async function tokenPaymentId(env: Pick<Env, "RAZORPAY_KEY_SECRET">, token: string): Promise<number | null> {
  const m = /^([1-9]\d{0,14})-([0-9a-f]{16})$/.exec(token);
  if (!m || !env.RAZORPAY_KEY_SECRET) return null;
  const id = Number(m[1]);
  return safeEqual(m[2], await mac(env.RAZORPAY_KEY_SECRET, id)) ? id : null;
}

// The link a customer gets for a payment: it stores the Razorpay URL and the link's end, and returns our /p/ link.
// Without PUBLIC_URL or the key secret, or if the row can't be written, it returns the Razorpay URL itself, so a payment message
// always carries a link that works.
export async function customerPayLink(env: Env, paymentId: number, razorpayUrl: string, untilUtc: string): Promise<string> {
  try {
    const base = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
    const token = await payToken(env, paymentId);
    if (!/^https:\/\/[^/]+$/.test(base) || !token) return razorpayUrl;
    await setSetting(env.DB, PAYLINK_KEY(paymentId), JSON.stringify({ url: razorpayUrl, until: untilUtc }));
    return `${base}/p/${token}`;
  } catch {
    return razorpayUrl;
  }
}

// The time a link stays open, as the customer reads it: "2:20 pm" / "दोपहर 2:20" (India time).
export const untilLabel = (untilUtc: string, locale: string | null | undefined) => formatIstLang(untilUtc, langOf(locale)).time;

// ---- GET /p/:token ----

const waLink = () => `https://wa.me/${config.businessNumber.replace(/\D/g, "")}`;

type Page = { title: string; body: string };
function page(lang: "en" | "hi", brand: string, parts: Page[], button: string) {
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${parts[0].title} · ${brand}</title><style>
:root{--bg:#FBFAF7;--card:#FFFFFF;--ink:#14302F;--muted:#5B6B69;--line:#E2DED3;--accent:#1B6F73;--accent-ink:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--bg:#121615;--card:#1A201F;--ink:#E8EEEC;--muted:#9FB0AD;--line:#2C3533;--accent:#5CC2BE;--accent-ink:#0E1A19}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif}
main{max-width:30rem;margin:0 auto;padding:32px 16px}
.brand{color:var(--muted);font-size:16px;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 20px}
h1{font-size:24px;line-height:1.3;margin:0 0 12px}p{margin:0 0 16px}
.btn{display:flex;align-items:center;justify-content:center;min-height:52px;padding:12px 20px;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;margin-top:8px}
</style></head><body><main><p class="brand">${brand}</p><div class="card">${parts.map((p, i) => html`<h1${i ? html` lang="hi"` : ""}>${p.title}</h1><p${i ? html` lang="hi"` : ""}>${p.body}</p>`)}<a class="btn" href="${waLink()}">${button}</a></div></main></body></html>`;
}

const headers = { "Cache-Control": "no-store", "Content-Security-Policy": PAYLINK_CSP, "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
const onePage = (cp: Copy, lang: "en" | "hi", title: string, body: string) => page(lang, cp.pageBrand, [{ title, body }], cp.pageBtnWhatsApp);
// Before we know whose link it is (a bad link, or the database not answering): both languages on one page.
const bothPages = (title: (c: Copy) => string, body: (c: Copy) => string) =>
  page("en", allCopy.en.pageBrand, [{ title: title(allCopy.en), body: body(allCopy.en) }, { title: title(allCopy.hi), body: body(allCopy.hi) }], `${allCopy.en.pageBtnWhatsApp} · ${allCopy.hi.pageBtnWhatsApp}`);

const PAID_STATES = ["PAID", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED"];

export async function payLinkPage(c: Context<{ Bindings: Env }>) {
  const id = await tokenPaymentId(c.env, c.req.param("token") ?? "");
  if (id === null) return c.html(bothPages((x) => x.pageNotFoundTitle, (x) => x.pageNotFoundBody), 404, headers);
  let row: { state: string; purpose: string; link: string | null; locale: string | null } | null;
  try {
    row = await c.env.DB.prepare(
      `SELECT p.state, p.purpose, st.value AS link, c.locale FROM payments p
       LEFT JOIN settings st ON st.key = 'paylink:' || p.id
       LEFT JOIN conversations c ON c.id = CASE p.purpose
         WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id)
         WHEN 'SESSION' THEN (SELECT conversation_id FROM sessions WHERE id = p.target_id)
         WHEN 'PACKAGE' THEN (SELECT conversation_id FROM packages WHERE id = p.target_id) END
       WHERE p.id = ?1`,
    )
      .bind(id)
      .first();
  } catch {
    return c.html(bothPages((x) => x.pageErrorTitle, (x) => x.pageErrorBody), 503, { ...headers, "Retry-After": "30" });
  }
  if (!row) return c.html(bothPages((x) => x.pageNotFoundTitle, (x) => x.pageNotFoundBody), 404, headers);
  const lang = langOf(row.locale);
  const cp = copyFor(row.locale);
  const pack = row.purpose === "PACKAGE";
  if (PAID_STATES.includes(row.state)) return c.html(onePage(cp, lang, cp.pagePaidTitle, pack ? cp.pagePaidPackBody : cp.pagePaidBody), 200, headers);

  let link: { url?: unknown; until?: unknown } = {};
  try {
    link = JSON.parse(row.link ?? "{}");
  } catch {
    // an unreadable row is treated as an expired link
  }
  const open = (row.state === "PENDING" || row.state === "CREATING") && typeof link.until === "string" && Date.now() < Date.parse(link.until);
  if (open && typeof link.url === "string" && /^https:\/\//.test(link.url)) {
    return new Response(null, { status: 302, headers: { Location: link.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return c.html(onePage(cp, lang, cp.pageExpiredTitle, pack ? cp.pageExpiredPackBody : cp.pageExpiredBody), 200, headers);
}

// ---- the reminder before a hold ends (2-minute cron) ----
// Nothing else tells a customer that their held time is running out (raiseTapReminders is for the practitioner, nudgeWaitingChats emails
// the team), so: one text about 8 minutes before the hold of a PENDING call or session payment ends. Only while SENDS is on (nothing is
// claimed while it is paused), inside the 24-hour window (outside it we stay quiet rather than raise an item), for a chat the bot is
// answering, not opted out and not in the no-selling week after a crisis message. Once per payment: claimed in the settings row
// paynudge:<id> (given back if the send fails), and the message's own dedupe key.
export async function nudgeUnpaidHolds(env: Env, nowMs = Date.now()): Promise<number> {
  if (!(await sendsOn(env))) return 0;
  const now = iso(nowMs);
  const { results } = await env.DB.prepare(
    `SELECT p.id, json_extract(st.value, '$.until') AS until, c.id AS conv, c.locale, c.last_user_at AS lastUserAt FROM payments p
     JOIN settings st ON st.key = 'paylink:' || p.id
     JOIN conversations c ON c.id = CASE p.purpose
       WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id AND state = 'HELD')
       WHEN 'SESSION' THEN (SELECT conversation_id FROM sessions WHERE id = p.target_id AND state = 'HELD') END
     LEFT JOIN person_state ps ON ps.conversation_id = c.id
     WHERE p.state = 'PENDING' AND p.purpose IN ('INTRO', 'SESSION') AND c.mode = 'BOT'
       AND json_extract(st.value, '$.until') > ?2 AND json_extract(st.value, '$.until') <= ?3
       AND ps.opted_out_at IS NULL AND (ps.no_sell_until IS NULL OR ps.no_sell_until <= ?1)
       AND NOT EXISTS (SELECT 1 FROM settings n WHERE n.key = 'paynudge:' || p.id)
     ORDER BY p.id LIMIT 20`,
  )
    .bind(now, iso(nowMs + NUDGE_LAST_MINUTES * 60_000), iso(nowMs + NUDGE_BEFORE_MINUTES * 60_000))
    .all<{ id: number; until: string; conv: number; locale: string; lastUserAt: string | null }>();
  let sent = 0;
  for (const r of results) {
    if (!(r.lastUserAt && nowMs - Date.parse(r.lastUserAt) < config.windowHours * 3_600_000)) continue;
    const token = await payToken(env, r.id);
    if (!token) continue;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, 'sent', ?2)").bind(NUDGE_KEY(r.id), now).run();
    if (!claim.meta.changes) continue;
    const link = `${(env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/p/${token}`;
    const res = await sendMessage(env, r.conv, { type: "text", text: copyFor(r.locale).payNudge(untilLabel(r.until, r.locale), link) }, NUDGE_KEY(r.id));
    if (res === "SENT" || res === "UNKNOWN") sent++;
    else if (res !== "DUPLICATE") await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(NUDGE_KEY(r.id)).run();
  }
  return sent;
}
