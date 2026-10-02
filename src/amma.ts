// Amma's page. Server-rendered, no JavaScript. Shows only: time, first name, service, kind, a tel: button.
// Never chat text or health details. Changes are POST-only, with an Origin check and a per-form CSRF token.
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config";
import { copyFor, type AmmaCopy } from "./copy";
import type { Env } from "./env";
import { formatIstParts, iso, istDay } from "./slots";

type Ctx = Context<{ Bindings: Env; Variables: { jwt: string } }>;
const t = (): AmmaCopy => copyFor("en").amma; // Amma's page is English until the Kannada copy is written

const OUTCOMES = { SESSION: "btnSession", NOT_FIT: "btnNotFit", MISSED: "btnMissed", RUDE: "btnRude" } as const;
type Outcome = keyof typeof OUTCOMES;
const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && v in OUTCOMES;

const teamHost = (team: string) => (team.includes(".") ? team : `${team}.cloudflareaccess.com`);
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const keysFor = (host: string) => {
  let k = keySets.get(host);
  if (!k) keySets.set(host, (k = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`))));
  return k;
};

// The Worker verifies the Access JWT itself (signature, audience, issuer, expiry) and then the e-mail.
async function allowedJwt(env: Env, token: string | undefined): Promise<string | null> {
  if (!token || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  try {
    const host = teamHost(env.ACCESS_TEAM);
    const { payload } = await jwtVerify(token, keysFor(host), { audience: env.ACCESS_AUD, issuer: `https://${host}` });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const allowed = [env.AMMA_EMAIL, env.ROHIT_EMAIL].filter(Boolean).map((e) => e.toLowerCase());
    return email && allowed.includes(email) ? token : null;
  } catch {
    return null;
  }
}

// CSRF token per form: SHA-256 of the form's scope + the visitor's own Access JWT (unknown to other sites). No extra secret.
async function csrf(jwt: string, scope: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`csrf|${scope}|${jwt}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:16px;font:20px/1.4 system-ui,sans-serif;color:#000;background:#fff;max-width:600px}
h1{font-size:28px;margin:0 0 16px}h2{font-size:24px;margin:28px 0 8px;border-bottom:3px solid #000}
.row{border:2px solid #000;border-radius:8px;padding:12px;margin:12px 0}
.top{font-size:24px;font-weight:bold}.sub{margin:4px 0 12px}
a.btn,button{display:block;width:100%;min-height:56px;margin:8px 0;padding:12px;border:2px solid #000;border-radius:8px;
 font:bold 20px system-ui,sans-serif;text-align:center;text-decoration:none;color:#000;background:#fff;cursor:pointer}
a.call,button.go{background:#000;color:#fff}
.small a.btn,.small button{min-height:56px;font-size:18px;font-weight:normal}
.msg{font-size:22px;margin:16px 0}
form{margin:0}`;

const page = (body: unknown) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${t().title}</title><style>${CSS as unknown as never}</style></head><body>${body}</body></html>`;

const telHref = (waId: string) => `tel:+${waId.replace(/\D/g, "")}`;
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || t().noName;

type Row = {
  startUtc: string; name: string; waId: string; service: string; kind: "CALL" | "SESSION";
  introId: number | null; oid: number | null; value: string | null; undoUntil: string | null;
};

async function rowsBetween(env: Env, fromUtc: string, toUtc: string): Promise<Row[]> {
  const calls = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, c.wa_id AS waId, i.service, i.id AS introId,
              o.id AS oid, o.value, o.undo_until AS undoUntil
       FROM intros i JOIN slots s ON s.id = i.slot_id JOIN conversations c ON c.id = i.conversation_id
       LEFT JOIN outcomes o ON o.intro_id = i.id
       WHERE s.kind = 'CALL' AND i.state IN ('PAID','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE')
         AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<Row, "kind">>();
  const sessions = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, c.wa_id AS waId, se.service
       FROM sessions se JOIN slots s ON s.id = se.slot_id JOIN conversations c ON c.id = se.conversation_id
       WHERE se.state = 'CONFIRMED' AND s.kind = 'SESSION' AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<Row, "kind">>();
  const all: Row[] = [
    ...calls.results.map((r) => ({ ...r, kind: "CALL" as const })),
    ...sessions.results.map((r) => ({ ...r, kind: "SESSION" as const, introId: null, oid: null, value: null, undoUntil: null })),
  ];
  return all.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

const serviceLabel = (s: string) => (s === "HEALING" ? t().healing : t().protection);
const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));

function undoForm(oid: number, jwtToken: string, label: string) {
  return html`<form method="post" action="/amma/undo"><input type="hidden" name="outcome" value="${oid}">
<input type="hidden" name="csrf" value="${jwtToken}"><button type="submit">${label}</button></form>`;
}

async function rowHtml(r: Row, jwt: string, nowIsoStr: string) {
  const c = t();
  const time = formatIstParts(r.startUtc).time;
  const head = html`<div class="top">${time} · ${firstName(r.name)}</div>
<div class="sub">${serviceLabel(r.service)} · ${r.kind === "CALL" ? c.kindCall : c.kindSession}</div>
<a class="btn call" href="${telHref(r.waId)}">${c.btnCall}</a>`;
  if (r.kind !== "CALL" || r.introId === null) return html`<div class="row">${head}</div>`;
  if (r.oid !== null && r.value && isOutcome(r.value)) {
    const label = c[OUTCOMES[r.value]];
    const canUndo = (r.undoUntil ?? "") > nowIsoStr;
    return html`<div class="row">${head}<div class="msg">${c.answered(label)}</div>
${canUndo ? undoForm(r.oid, await csrf(jwt, `undo:${r.oid}`), c.undo) : ""}</div>`;
  }
  const link = (v: Outcome, cls: string) =>
    html`<a class="btn ${cls}" href="/amma/confirm?intro=${r.introId}&v=${v}">${c[OUTCOMES[v]]}</a>`;
  return html`<div class="row">${head}${link("SESSION", "")}${link("NOT_FIT", "")}${link("MISSED", "")}
<div class="small">${link("RUDE", "")}</div></div>`;
}

export const amma = new Hono<{ Bindings: Env; Variables: { jwt: string } }>();

amma.use("*", async (c, next) => {
  const jwt = await allowedJwt(c.env, c.req.header("Cf-Access-Jwt-Assertion"));
  if (!jwt) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  c.set("jwt", jwt);
  if (c.req.method === "POST") {
    // Browsers always send Origin on a POST; a missing or foreign one is refused.
    if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  }
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
});

amma.get("/", async (c) => {
  const now = Date.now();
  const today = istDay(now);
  const tomorrow = istDay(now + 86_400_000);
  const nowStr = iso(now);
  const cp = t();
  const section = async (title: string, from: string, to: string) => {
    const rows = await rowsBetween(c.env, dayStartUtc(from), dayStartUtc(to));
    const items = await Promise.all(rows.map((r) => rowHtml(r, c.get("jwt"), nowStr)));
    return html`<h2>${title}</h2>${rows.length ? items : html`<p>${cp.nothing}</p>`}`;
  };
  const dayAfter = istDay(now + 2 * 86_400_000);
  return c.html(page(html`<h1>${cp.title}</h1>${await section(cp.today, today, tomorrow)}${await section(cp.tomorrow, tomorrow, dayAfter)}`));
});

const message = (c: Ctx, text: string, status: 200 | 400 | 403 | 404 | 409) =>
  c.html(page(html`<p class="msg">${text}</p><a class="btn go" href="/amma">${t().back}</a>`), status);

async function introFor(env: Env, id: number) {
  return env.DB
    .prepare(
      `SELECT i.id, i.state, s.start_utc AS startUtc, c.display_name AS name FROM intros i
       JOIN slots s ON s.id = i.slot_id JOIN conversations c ON c.id = i.conversation_id WHERE i.id = ?1 AND s.kind = 'CALL'`,
    )
    .bind(id)
    .first<{ id: number; state: string; startUtc: string; name: string | null }>();
}

amma.get("/confirm", async (c) => {
  const id = Number(c.req.query("intro"));
  const v = c.req.query("v");
  const intro = Number.isInteger(id) ? await introFor(c.env, id) : null;
  if (!intro || intro.state !== "PAID" || !isOutcome(v)) return message(c, t().notFound, 404);
  const cp = t();
  const token = await csrf(c.get("jwt"), `outcome:${id}:${v}`);
  return c.html(
    page(html`<p class="msg">${cp.confirm(cp[OUTCOMES[v]], firstName(intro.name), formatIstParts(intro.startUtc).time)}</p>
<form method="post" action="/amma/outcome"><input type="hidden" name="intro" value="${id}"><input type="hidden" name="v" value="${v}">
<input type="hidden" name="csrf" value="${token}"><button class="go" type="submit">${cp.yes}</button></form>
<a class="btn" href="/amma">${cp.back}</a>`),
  );
});

amma.post("/outcome", async (c) => {
  const f = await c.req.parseBody();
  const id = Number(f.intro);
  const v = f.v;
  if (!Number.isInteger(id) || !isOutcome(v) || f.csrf !== (await csrf(c.get("jwt"), `outcome:${id}:${v}`))) {
    return c.text("Forbidden", 403);
  }
  const cp = t();
  const intro = await introFor(c.env, id);
  if (!intro || intro.state !== "PAID") return message(c, cp.notFound, 404);
  const now = Date.now();
  // One atomic write: refused if this call already has an outcome. Effects are NOT applied here (Ticket 06).
  const res = await c.env.DB
    .prepare(
      `INSERT INTO outcomes (intro_id, value, tapped_at, undo_until)
       SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM outcomes WHERE intro_id = ?1)`,
    )
    .bind(id, v, iso(now), iso(now + config.undoMinutes * 60_000))
    .run();
  if (!res.meta.changes) return message(c, cp.alreadyAnswered, 409);
  const oid = res.meta.last_row_id;
  return c.html(
    page(html`<p class="msg">${cp.saved(config.undoMinutes)}</p>${undoForm(oid, await csrf(c.get("jwt"), `undo:${oid}`), cp.undo)}
<a class="btn go" href="/amma">${cp.back}</a>`),
  );
});

amma.post("/undo", async (c) => {
  const f = await c.req.parseBody();
  const oid = Number(f.outcome);
  if (!Number.isInteger(oid) || f.csrf !== (await csrf(c.get("jwt"), `undo:${oid}`))) return c.text("Forbidden", 403);
  const cp = t();
  const res = await c.env.DB
    .prepare("DELETE FROM outcomes WHERE id = ?1 AND undo_until > ?2 AND applied_at IS NULL")
    .bind(oid, iso(Date.now()))
    .run();
  return res.meta.changes ? message(c, cp.undone, 200) : message(c, cp.undoTooLate, 409);
});
