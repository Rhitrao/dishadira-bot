// Amma's page. Server-rendered, no JavaScript. Shows only: time, first name, service, kind, a tel: button.
// Never chat text or health details. Changes are POST-only, with an Origin check and a per-form CSRF token.
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { csrf, verifiedEmail } from "./auth";
import { config } from "./config";
import { copyFor, langOf, type AmmaCopy, type ForWhom } from "./copy";
import type { Env } from "./env";
import { consoleCopy } from "./console-copy";
import { addHoliday, anyDate, bookingsOn, holidayBounds, holidayDate, removeHoliday, upcomingHolidays } from "./holidays";
import { recordOutcome, undoOutcome } from "./outcomes";
import { dayLabelFor, formatIstParts, iso, istDay } from "./slots";

type Ctx = Context<{ Bindings: Env; Variables: { jwt: string; email: string } }>;
const t = (): AmmaCopy => copyFor("en").amma; // Amma's page is English

const OUTCOMES = { SESSION: "btnSession", NOT_FIT: "btnNotFit", MISSED: "btnMissed", RUDE: "btnRude" } as const;
type Outcome = keyof typeof OUTCOMES;
const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && v in OUTCOMES;

// The Worker verifies the Access JWT itself (src/auth.ts: signature, audience, issuer, expiry) and then the e-mail.
export async function allowedJwt(env: Env, token: string | undefined, rohitOnly = false): Promise<{ jwt: string; email: string } | null> {
  const email = await verifiedEmail(env, token);
  if (!token || !email) return null;
  const allowed = (rohitOnly ? [env.ROHIT_EMAIL] : [env.AMMA_EMAIL, env.ROHIT_EMAIL]).filter(Boolean).map((e) => e.toLowerCase());
  return allowed.includes(email) ? { jwt: token, email } : null;
}

// CSRF token per form (src/auth.ts): SHA-256 of the form's scope + the visitor's own Access JWT. No extra secret.
export { csrf };

export const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:16px;font:20px/1.4 system-ui,sans-serif;color:#000;background:#fff;max-width:600px}
h1{font-size:28px;margin:0 0 16px}h2{font-size:24px;margin:28px 0 8px;border-bottom:3px solid #000}
.row{border:2px solid #000;border-radius:8px;padding:12px;margin:12px 0}
.top{font-size:24px;font-weight:bold}.sub{margin:4px 0 12px}
a.btn,button{display:block;width:100%;min-height:56px;margin:8px 0;padding:12px;border:2px solid #000;border-radius:8px;
 font:bold 20px system-ui,sans-serif;text-align:center;text-decoration:none;color:#000;background:#fff;cursor:pointer}
a.call,button.go{background:#000;color:#fff}
.rude{margin-top:40px}.rude a.btn{min-height:56px;font-size:18px;font-weight:normal;color:#b00000;border-color:#b00000}
.msg{font-size:22px;margin:16px 0}a.refresh{margin:0 0 8px}
form{margin:0}
label{display:block;font-weight:bold;margin:8px 0 4px}input[type=date]{display:block;width:100%;min-height:56px;font:20px system-ui,sans-serif;padding:8px 12px;border:2px solid #000;border-radius:8px;background:#fff;color:#000}
.warn{border-color:#8a5a00;background:#fff8e6}.note{font-size:18px}`;

const page = (body: unknown) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${t().title}</title><style>${CSS as unknown as never}</style></head><body>${body}</body></html>`;

const telHref = (waId: string) => `tel:+${waId.replace(/\D/g, "")}`;
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || t().noName;

type Row = {
  startUtc: string; name: string; waId: string; service: string; kind: "CALL" | "SESSION";
  introId: number | null; oid: number | null; value: string | null; undoUntil: string | null; appliedAt: string | null;
  locale: string; callLang: string | null; forWhom: ForWhom | null;
  sessionId: number | null; origin: string | null; packSize: number | null; packNo: number | null; firstBuy: number;
};

// A buyer's very first session: they never paid for a 99 call, and this is their earliest session. Amma may answer "Not right fit" on it.
export const FIRST_BUY = `(CASE WHEN se.origin IN ('SELF','CREDIT')
    AND NOT EXISTS (SELECT 1 FROM intros i2 WHERE i2.conversation_id = se.conversation_id AND i2.state IN ('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE'))
    AND se.id = (SELECT se2.id FROM sessions se2 JOIN slots s2 ON s2.id = se2.slot_id
                 WHERE se2.conversation_id = se.conversation_id AND se2.state IN ('CONFIRMED','CREDIT_BOOKED','COMPLETED','NO_SHOW','NOT_FIT') ORDER BY s2.start_utc LIMIT 1)
  THEN 1 ELSE 0 END)`;

async function rowsBetween(env: Env, fromUtc: string, toUtc: string): Promise<Row[]> {
  const calls = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, c.wa_id AS waId, i.service, i.id AS introId,
              c.locale, i.call_lang AS callLang, i.for_whom AS forWhom,
              o.id AS oid, o.value, o.undo_until AS undoUntil, o.applied_at AS appliedAt
       FROM intros i JOIN slots s ON s.id = i.slot_id JOIN conversations c ON c.id = i.conversation_id
       LEFT JOIN outcomes o ON o.intro_id = i.id AND o.slot_id = i.slot_id
       WHERE s.kind = 'CALL' AND i.state IN ('PAID','RESCHEDULED','CALLED_SESSION','CALLED_NOT_FIT','MISSED','RUDE')
         AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<Row, "kind" | "sessionId" | "origin" | "packSize" | "packNo" | "firstBuy">>();
  const sessions = await env.DB
    .prepare(
      `SELECT s.start_utc AS startUtc, c.display_name AS name, c.wa_id AS waId, se.service, se.id AS sessionId, se.origin,
              c.locale, COALESCE(se.call_lang, i.call_lang) AS callLang, COALESCE(se.for_whom, i.for_whom) AS forWhom,
              (SELECT k.size FROM packages k WHERE k.id = se.package_id) AS packSize,
              (SELECT COUNT(*) FROM credits cr WHERE cr.package_id = se.package_id AND cr.reason = 'BOOK' AND cr.session_id <= se.id) AS packNo,
              ${FIRST_BUY} AS firstBuy,
              o.id AS oid, o.value, o.undo_until AS undoUntil, o.applied_at AS appliedAt
       FROM sessions se JOIN slots s ON s.id = se.slot_id JOIN conversations c ON c.id = se.conversation_id
       LEFT JOIN intros i ON i.id = se.intro_id
       LEFT JOIN outcomes o ON o.session_id = se.id
       WHERE se.state IN ('CONFIRMED','CREDIT_BOOKED','NOT_FIT') AND s.kind = 'SESSION' AND s.start_utc >= ?1 AND s.start_utc < ?2`,
    )
    .bind(fromUtc, toUtc)
    .all<Omit<Row, "kind" | "introId">>();
  const all: Row[] = [
    ...calls.results.map((r) => ({ ...r, kind: "CALL" as const, sessionId: null, origin: null, packSize: null, packNo: null, firstBuy: 0 })),
    ...sessions.results.map((r) => ({ ...r, kind: "SESSION" as const, introId: null })),
  ];
  return all.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

const serviceLabel = (s: string) => (s === "HEALING" ? t().healing : t().protection); // names come from config.serviceNames
const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));

function undoForm(oid: number, jwtToken: string, label: string) {
  return html`<form method="post" action="/amma/undo"><input type="hidden" name="outcome" value="${oid}">
<input type="hidden" name="csrf" value="${jwtToken}"><button type="submit">${label}</button></form>`;
}

async function rowHtml(r: Row, jwt: string, nowIsoStr: string) {
  const c = t();
  const time = formatIstParts(r.startUtc).time;
  // "Priya · Hindi · family": the language to speak and who it is for (a session takes both from the call before it).
  const lang = c.callLang[langOf(r.callLang ?? r.locale)];
  const who = r.forWhom ? ` · ${c.forWhom[r.forWhom]}` : "";
  const kind = r.kind === "CALL" ? c.kindCall : r.origin === "CREDIT" && r.packSize ? c.kindSessionPackage(r.packNo ?? 0, r.packSize) : c.kindSessionSingle; // "package 3/10" or "single"
  const head = html`<div class="top">${time} · ${firstName(r.name)} · ${lang}${who}</div>
<div class="sub">${serviceLabel(r.service)} · ${kind}</div>
<a class="btn call" href="${telHref(r.waId)}">${c.btnCall}</a>`;
  if (r.kind === "SESSION" && !r.firstBuy && r.value !== "NOT_FIT") return html`<div class="row">${head}</div>`;
  if (r.kind !== "CALL" && r.sessionId === null) return html`<div class="row">${head}</div>`;
  if (r.oid !== null && r.value && isOutcome(r.value)) {
    const label = c[OUTCOMES[r.value]];
    if (r.appliedAt) return html`<div class="row">${head}<div class="msg">${c.done(label)}</div></div>`; // applied: no buttons, no undo
    const canUndo = (r.undoUntil ?? "") > nowIsoStr;
    return html`<div class="row">${head}<div class="msg">${c.answered(label)}</div>
${canUndo ? undoForm(r.oid, await csrf(jwt, `undo:${r.oid}`), c.undo) : ""}</div>`;
  }
  if (r.startUtc > nowIsoStr) return html`<div class="row">${head}</div>`; // outcome buttons only once the call has started
  const link = (v: Outcome, cls: string) =>
    html`<a class="btn ${cls}" href="/amma/confirm?${r.kind === "SESSION" ? `session=${r.sessionId}` : `intro=${r.introId}`}&v=${v}">${c[OUTCOMES[v]]}</a>`;
  // A session the buyer reached without a 99 call has just one answer: Not right fit (the whole purchase is refunded).
  if (r.kind === "SESSION") return html`<div class="row">${head}<div class="msg">${c.howDidItGo}</div>${link("NOT_FIT", "")}</div>`;
  return html`<div class="row">${head}<div class="msg">${c.howDidItGo}</div>${link("SESSION", "")}${link("NOT_FIT", "")}${link("MISSED", "")}
<div class="rude">${link("RUDE", "")}</div></div>`;
}

export const amma = new Hono<{ Bindings: Env; Variables: { jwt: string; email: string } }>();

amma.use("*", async (c, next) => {
  const who = await allowedJwt(c.env, c.req.header("Cf-Access-Jwt-Assertion"));
  if (!who) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  c.set("jwt", who.jwt);
  c.set("email", who.email);
  if (c.req.method === "POST") {
    // Browsers always send Origin on a POST; a missing or foreign one is refused.
    if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Forbidden", 403, { "Cache-Control": "no-store" });
  }
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
});

// Who did it: the Access e-mail goes in audit_log (D1 only, never in git or logs).
const audit = (c: Ctx, action: string, target: string, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?1, ?2, ?3, ?4)").bind(c.get("email"), action, target, detail).run();

amma.get("/", async (c) => {
  const now = Date.now();
  const today = istDay(now);
  const tomorrow = istDay(now + 86_400_000);
  const nowStr = iso(now);
  const cp = t();
  const section = async (title: string, from: string, to: string, empty: string) => {
    const rows = await rowsBetween(c.env, dayStartUtc(from), dayStartUtc(to));
    const items = await Promise.all(rows.map((r) => rowHtml(r, c.get("jwt"), nowStr)));
    return html`<h2>${title} · ${formatIstParts(dayStartUtc(from)).day}</h2>${rows.length ? items : html`<p class="msg">${empty}</p>`}`;
  };
  const dayAfter = istDay(now + 2 * 86_400_000);
  const todayHtml = await section(cp.today, today, tomorrow, cp.nothingToday);
  const tomorrowHtml = await section(cp.tomorrow, tomorrow, dayAfter, cp.nothingTomorrow);
  const flash = holidayFlash(c.req.query("h"), c.req.query("d"));
  return c.html(page(html`<h1>${cp.title}</h1>${flash ? html`<p class="msg" role="status">${flash}</p>` : ""}<a class="btn go refresh" href="/amma">${cp.refresh}</a>${todayHtml}${tomorrowHtml}${await daysOff(c)}`));
});

// ---- days off (ticket 30): a date and one button; no note here (this page has no free text). Bookings already on a day off stay. ----
const hw = () => consoleCopy("en");
function holidayFlash(code: string | undefined, d: string | undefined): string | null {
  const day = anyDate(d);
  if (code === "added" && day) return hw().holAdded(dayLabelFor(day, "en"));
  if (code === "removed" && day) return hw().holRemoved(dayLabelFor(day, "en"));
  if (code === "bad") return hw().holBadDate(config.holidays.maxDaysAhead);
  return null;
}
async function daysOff(c: Ctx) {
  const w = hw();
  const b = holidayBounds();
  const list = await Promise.all(
    (await upcomingHolidays(c.env.DB)).map(async (h) => {
      const label = dayLabelFor(h.ymd, "en");
      const booked = await bookingsOn(c.env.DB, h.ymd);
      const warn = booked.length
        ? html`<p class="note">${w.holWarnTeam(booked.length, label)}</p><p class="note">${booked.map((x, i) => html`${i ? ", " : ""}${formatIstParts(x.startUtc).time} ${firstName(x.name)}`)}</p>`
        : "";
      return html`<div class="row${booked.length ? " warn" : ""}"><div class="top">${label}</div>${warn}
<form method="post" action="/amma/holiday/remove"><input type="hidden" name="day" value="${h.ymd}"><input type="hidden" name="csrf" value="${await csrf(c.get("jwt"), `holiday:remove:${h.ymd}`)}"><button type="submit">${w.holRemove}</button></form></div>`;
    }),
  );
  return html`<h2>${w.holTitle}</h2><p class="note">${w.holIntro}</p>
<form method="post" action="/amma/holiday"><label for="hday">${w.holDate}</label><input id="hday" type="date" name="day" min="${b.min}" max="${b.max}" required>
<input type="hidden" name="csrf" value="${await csrf(c.get("jwt"), "holiday:add")}"><button class="go" type="submit">${w.holMark}</button></form>
<h2>${w.holUpcoming}</h2>${list.length ? list : html`<p class="msg">${w.holNone}</p>`}`;
}

amma.post("/holiday", async (c) => {
  const f = await c.req.parseBody();
  if (f.csrf !== (await csrf(c.get("jwt"), "holiday:add"))) return c.text("Forbidden", 403);
  const day = holidayDate(f.day);
  if (!day) return c.redirect("/amma?h=bad", 303);
  const res = await addHoliday(c.env, day, "");
  if (res.added) await audit(c, "HOLIDAY_ADDED", `holiday:${day}`, `${res.bookings.length} booked that day`);
  return c.redirect(`/amma?h=added&d=${day}`, 303);
});

amma.post("/holiday/remove", async (c) => {
  const f = await c.req.parseBody();
  const day = anyDate(f.day);
  if (!day || f.csrf !== (await csrf(c.get("jwt"), `holiday:remove:${day}`))) return c.text("Forbidden", 403);
  if (await removeHoliday(c.env, day)) await audit(c, "HOLIDAY_REMOVED", `holiday:${day}`, "");
  return c.redirect(`/amma?h=removed&d=${day}`, 303);
});

const message = (c: Ctx, text: string, status: 200 | 400 | 403 | 404 | 409) =>
  c.html(page(html`<p class="msg">${text}</p><a class="btn go" href="/amma">${t().back}</a>`), status);

async function introFor(env: Env, id: number) {
  return env.DB
    .prepare(
      `SELECT i.id, i.state, i.slot_id AS slotId, s.start_utc AS startUtc, c.display_name AS name FROM intros i
       JOIN slots s ON s.id = i.slot_id JOIN conversations c ON c.id = i.conversation_id WHERE i.id = ?1 AND s.kind = 'CALL'`,
    )
    .bind(id)
    .first<{ id: number; state: string; slotId: number; startUtc: string; name: string | null }>();
}

// A session that may get "Not right fit": live, and the buyer's very first (no 99 call before it).
async function sessionFor(env: Env, id: number) {
  return env.DB
    .prepare(
      `SELECT se.id, se.state, se.slot_id AS slotId, s.start_utc AS startUtc, c.display_name AS name, ${FIRST_BUY} AS firstBuy
       FROM sessions se JOIN slots s ON s.id = se.slot_id JOIN conversations c ON c.id = se.conversation_id WHERE se.id = ?1 AND s.kind = 'SESSION'`,
    )
    .bind(id)
    .first<{ id: number; state: string; slotId: number; startUtc: string; name: string | null; firstBuy: number }>();
}
const sessionOk = (s: Awaited<ReturnType<typeof sessionFor>>) => s !== null && ["CONFIRMED", "CREDIT_BOOKED"].includes(s.state) && s.firstBuy === 1;

amma.get("/confirm", async (c) => {
  const v = c.req.query("v");
  if (c.req.query("session") !== undefined) {
    const sid = Number(c.req.query("session"));
    const ses = Number.isInteger(sid) ? await sessionFor(c.env, sid) : null;
    if (!ses || !sessionOk(ses) || v !== "NOT_FIT") return message(c, t().notFound, 404);
    if (ses.startUtc > iso(Date.now())) return message(c, t().notYet, 409);
    const cp = t();
    const token = await csrf(c.get("jwt"), `session-outcome:${sid}:${v}`);
    return c.html(
      page(html`<p class="msg">${cp.confirm(cp[OUTCOMES[v]], firstName(ses.name), formatIstParts(ses.startUtc).time)}</p>
<form method="post" action="/amma/outcome"><input type="hidden" name="session" value="${sid}"><input type="hidden" name="v" value="${v}">
<input type="hidden" name="csrf" value="${token}"><button class="go" type="submit">${cp.yes}</button></form>
<a class="btn" href="/amma">${cp.back}</a>`),
    );
  }
  const id = Number(c.req.query("intro"));
  const intro = Number.isInteger(id) ? await introFor(c.env, id) : null;
  if (!intro || !["PAID", "RESCHEDULED"].includes(intro.state) || !isOutcome(v)) return message(c, t().notFound, 404);
  if (intro.startUtc > iso(Date.now())) return message(c, t().notYet, 409);
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
  if (f.session !== undefined) {
    const sid = Number(f.session);
    if (!Number.isInteger(sid) || f.v !== "NOT_FIT" || f.csrf !== (await csrf(c.get("jwt"), `session-outcome:${sid}:NOT_FIT`))) return c.text("Forbidden", 403);
    const cp = t();
    const ses = await sessionFor(c.env, sid);
    if (!ses || !sessionOk(ses)) return message(c, cp.notFound, 404);
    const now = Date.now();
    if (ses.startUtc > iso(now)) return message(c, cp.notYet, 409);
    // Same as a call: one atomic write, refused if this session already has an answer; the cron applies it after the undo window.
    const oid = await recordOutcome(c.env.DB, { sessionId: sid, slotId: ses.slotId, value: "NOT_FIT", nowMs: now });
    if (oid === null) return message(c, cp.alreadyAnswered, 409);
    await audit(c, "AMMA_OUTCOME", `session:${sid}`, "NOT_FIT");
    return c.html(
      page(html`<p class="msg">${cp.saved(config.undoMinutes)}</p>${undoForm(oid, await csrf(c.get("jwt"), `undo:${oid}`), cp.undo)}
<a class="btn go" href="/amma">${cp.back}</a>`),
    );
  }
  const id = Number(f.intro);
  const v = f.v;
  if (!Number.isInteger(id) || !isOutcome(v) || f.csrf !== (await csrf(c.get("jwt"), `outcome:${id}:${v}`))) {
    return c.text("Forbidden", 403);
  }
  const cp = t();
  const intro = await introFor(c.env, id);
  if (!intro || !["PAID", "RESCHEDULED"].includes(intro.state)) return message(c, cp.notFound, 404);
  const now = Date.now();
  if (intro.startUtc > iso(now)) return message(c, cp.notYet, 409);
  // One atomic write: refused if this call already has an outcome. Effects are applied later by the cron (src/outcomes.ts), once undo_until has passed.
  const oid = await recordOutcome(c.env.DB, { introId: id, slotId: intro.slotId, value: v, nowMs: now });
  if (oid === null) return message(c, cp.alreadyAnswered, 409);
  await audit(c, "AMMA_OUTCOME", `intro:${id}`, v);
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
  const was = await c.env.DB.prepare("SELECT intro_id AS introId, session_id AS sessionId, value FROM outcomes WHERE id = ?1").bind(oid).first<{ introId: number | null; sessionId: number | null; value: string }>();
  if (!(await undoOutcome(c.env.DB, oid, Date.now()))) return message(c, cp.undoTooLate, 409);
  await audit(c, "AMMA_UNDO", was?.introId != null ? `intro:${was.introId}` : `session:${was?.sessionId}`, was?.value ?? "");
  return message(c, cp.undone, 200);
});
