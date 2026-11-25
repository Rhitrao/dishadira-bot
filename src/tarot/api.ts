// Ticket 57: the tarot game's routes under /tarot. Off (a plain 404) unless TAROT_GAME is "true".
//   GET  /tarot                 the game (one page; the script and the card art come from this Worker only)
//   GET  /tarot/in?t=<token>    the bot's one-time login link: sets the session cookie and sends the person on to /tarot
//   GET  /tarot/app.js, /tarot/art/<id>.webp, /tarot/fonts/<file>
//   GET  /tarot/api/state       who is logged in, today's readings, the journal, the collection and the streak
//   POST /tarot/api/profile     the person's details (ticket 58); DELETE removes them
//   POST /tarot/api/start       shuffle and cut for today's daily card or reading (a theme, one of its spreads, a ready or own question)
//   POST /tarot/api/check       is a typed question one we can read for (not a crisis, a prediction of health or death, a spell)
//   POST /tarot/api/pick        the cards picked from the fan become the reading
//   POST /tarot/api/note        the person's own note on a reading
//   POST /tarot/api/logout
// Posts must be JSON from this site (Origin checked; the cookie is SameSite=Lax), so another site cannot act for a logged-in person.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import type { Env } from "../env";
import { FILES as FONT_FILES } from "../fonts";
import { istDay } from "../slots";
import { ART } from "./art";
import { APP_JS, pageHtml } from "./page";
import { detectSafety } from "../safety";
import { classifyWithoutAI, readingSafety } from "../gate";
import { insights, personalLines, type Insights } from "./profile";
import { cardView, isSpread, isTheme, spreadFits, SPREADS, summarize, THEMES, type Drawn, type SpreadId, type ThemeId } from "./reading";
import {
  asEntry, deleteProfile, endSession, finishReading, getProfile, history, isTester, journal, latest, newSession, parseProfile, redeemLogin, saveProfile,
  seenCards, sessionConv, setNote, startReading, streak, todayRows, SESSION_DAYS, type JournalEntry,
} from "./store";

type Ctx = Context<{ Bindings: Env }>;
export const COOKIE = "dd_tarot";
export const tarotOn = (env: Env | undefined) => env?.TAROT_GAME === "true";
export const TAROT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const tarot = new Hono<{ Bindings: Env }>();

tarot.use("*", async (c, next) => {
  if (!tarotOn(c.env)) return c.text("Not found", 404);
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  if (!c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", TAROT_CSP);
});

const waDigits = () => config.businessNumber.replace(/\D/g, "");

tarot.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(pageHtml(waDigits()));
});

tarot.get("/app.js", () => new Response(APP_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } }));

tarot.get("/art/:file", (c) => {
  const m = /^([a-z]+\d{2})\.webp$/.exec(c.req.param("file") ?? "");
  const body = m ? ART[m[1]] : undefined;
  if (!body) return c.text("Not found", 404);
  return new Response(body, { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" } });
});

tarot.get("/fonts/:file", (c) => {
  const body = FONT_FILES[c.req.param("file") ?? ""];
  if (!body) return c.text("Not found", 404);
  return new Response(body, { headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" } });
});

// The login link: once, within 15 minutes. A used or old link sends the person to the page, which offers a fresh one through WhatsApp.
tarot.get("/in", async (c) => {
  const conv = await redeemLogin(c.env.DB, c.req.query("t") ?? "");
  if (conv === null) return c.redirect("/tarot?link=old", 303);
  const sid = await newSession(c.env.DB, conv);
  setCookie(c, COOKIE, sid, { path: "/tarot", httpOnly: true, secure: true, sameSite: "Lax", maxAge: SESSION_DAYS * 86_400 });
  return c.redirect("/tarot", 303);
});

const who = (c: Ctx) => sessionConv(c.env.DB, getCookie(c, COOKIE));

const sameSite = (c: Ctx): boolean => {
  const origin = c.req.header("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
};

async function body(c: Ctx): Promise<Record<string, unknown> | null> {
  if (!sameSite(c) || !(c.req.header("Content-Type") ?? "").startsWith("application/json")) return null;
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// What the page shows for a finished reading: each card in its place, the general summary and the lines this person's profile and recent
// readings add (ticket 58).
function readingView(e: JournalEntry, ins: Insights | null, past: Drawn[]) {
  const s = SPREADS[e.spread];
  return {
    id: e.id,
    day: e.day,
    kind: e.kind,
    spreadId: e.spread,
    spread: s.label,
    theme: e.theme,
    question: e.question,
    custom: e.custom,
    note: e.note,
    cards: e.cards.map((d, i) => ({ position: s.positions[i].name, frame: s.positions[i].frame, x: s.positions[i].x, y: s.positions[i].y, cross: !!("cross" in s.positions[i] && s.positions[i].cross), ...cardView(d, e.theme) })),
    personal: personalLines(e.cards, ins, past),
    summary: summarize(e.cards),
  };
}

const themesView = () =>
  Object.fromEntries(
    Object.entries(THEMES).map(([k, t]) => [
      k,
      { label: t.label, blurb: t.blurb, questions: t.questions, spreads: t.spreads.map((id) => ({ id, label: SPREADS[id].label, blurb: SPREADS[id].blurb, count: SPREADS[id].positions.length, layout: SPREADS[id].positions.map((p) => ({ x: p.x, y: p.y, cross: "cross" in p })) })) },
    ]),
  );

async function profileInsights(c: Ctx, conv: number, now: number): Promise<{ profile: Awaited<ReturnType<typeof getProfile>>; ins: Insights | null }> {
  const profile = await getProfile(c.env.DB, conv);
  return { profile, ins: profile ? insights(profile, now, istDay(now)) : null };
}

tarot.get("/api/state", async (c) => {
  c.header("Cache-Control", "no-store");
  const conv = await who(c);
  if (conv === null) return c.json({ in: false });
  const now = Date.now();
  const { profile, ins } = await profileInsights(c, conv, now);
  const tester = await isTester(c.env.DB, conv, c.env.TAROT_TESTERS);
  const rows = await todayRows(c.env.DB, conv, istDay(now));
  const view = async (kind: "daily" | "spread") => {
    const r = latest(rows, kind);
    return r?.done_at && r.cards ? readingView(asEntry(r), ins, await history(c.env.DB, conv, r.id, now)) : null;
  };
  const days = await journal(c.env.DB, conv, now);
  return c.json({
    in: true,
    tester,
    day: istDay(now),
    profile,
    insights: ins && { firstName: ins.firstName, today: ins.today, arts: ins.arts },
    streak: await streak(c.env.DB, conv, now),
    seen: await seenCards(c.env.DB, conv),
    today: { daily: await view("daily"), spread: await view("spread") },
    journal: await Promise.all(days.map(async (j) => readingView(j, ins, await history(c.env.DB, conv, j.id, now)))),
    themes: themesView(),
  });
});

tarot.post("/api/profile", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b) return c.json({ error: "bad" }, 400);
  const p = parseProfile(b);
  if ("error" in p) return c.json({ error: p.error }, 400);
  await saveProfile(c.env.DB, conv, p);
  return c.json({ ok: true });
});

tarot.post("/api/profile/delete", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  if (!(await body(c))) return c.json({ error: "bad" }, 400);
  await deleteProfile(c.env.DB, conv);
  return c.json({ ok: true });
});

// The person's own question: never a crisis, a prediction of health, death, pregnancy, exams or court, a spell, or abuse. Those get a kind
// message instead of a reading; a crisis gets the helpline.
function questionProblem(q: string): "crisis" | "predict" | "spell" | "bad" | null {
  if (detectSafety(q)) return "crisis";
  const rs = readingSafety(q);
  if (rs === "READING_PREDICT") return "predict";
  if (rs === "READING_SPELL") return "spell";
  if (classifyWithoutAI(q) !== "TO_CLASSIFIER") return "bad";
  return null;
}

// The question screen checks a typed question before the ritual starts.
tarot.post("/api/check", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || typeof b.own !== "string") return c.json({ error: "bad" }, 400);
  const q = b.own.replace(/\s+/g, " ").trim();
  if (q.length < 3 || q.length > 300) return c.json({ error: "length" }, 400);
  const problem = questionProblem(q);
  return problem ? c.json({ error: problem }, 422) : c.json({ ok: true });
});

tarot.post("/api/start", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || (b.kind !== "daily" && b.kind !== "spread")) return c.json({ error: "bad" }, 400);
  if (!(await getProfile(c.env.DB, conv))) return c.json({ error: "profile" }, 409);
  const pile = Number.isInteger(b.pile) ? (b.pile as number) : 0;
  const unlimited = await isTester(c.env.DB, conv, c.env.TAROT_TESTERS);
  if (b.kind === "daily") {
    const res = await startReading(c.env.DB, conv, { kind: "daily", spread: "daily", theme: null, question: null, custom: false, pile }, unlimited);
    return res === "done" ? c.json({ error: "done" }, 409) : c.json({ ok: true, count: 1 });
  }
  if (!isTheme(b.theme) || !isSpread(b.spread) || !spreadFits(b.theme, b.spread)) return c.json({ error: "bad" }, 400);
  const theme: ThemeId = b.theme;
  const spread: SpreadId = b.spread;
  let question: string;
  let custom = false;
  if (typeof b.own === "string") {
    question = b.own.replace(/\s+/g, " ").trim();
    if (question.length < 3 || question.length > 300) return c.json({ error: "length" }, 400);
    const problem = questionProblem(question);
    if (problem) return c.json({ error: problem }, 422);
    custom = true;
  } else {
    const qi = Number(b.question);
    if (!Number.isInteger(qi) || qi < 0 || qi >= THEMES[theme].questions.length) return c.json({ error: "bad" }, 400);
    question = THEMES[theme].questions[qi];
  }
  const res = await startReading(c.env.DB, conv, { kind: "spread", spread, theme, question, custom, pile }, unlimited);
  if (res === "done") return c.json({ error: "done" }, 409);
  return c.json({ ok: true, count: SPREADS[spread].positions.length });
});

tarot.post("/api/pick", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || (b.kind !== "daily" && b.kind !== "spread")) return c.json({ error: "bad" }, 400);
  const res = await finishReading(c.env.DB, conv, b.kind, b.picks);
  if (!res) return c.json({ error: "bad" }, 400);
  const now = Date.now();
  const { ins } = await profileInsights(c, conv, now);
  return c.json({ ok: true, reading: readingView(asEntry(res.row), ins, await history(c.env.DB, conv, res.row.id, now)) });
});

tarot.post("/api/note", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || !Number.isInteger(b.id) || typeof b.note !== "string") return c.json({ error: "bad" }, 400);
  return (await setNote(c.env.DB, conv, b.id as number, b.note)) ? c.json({ ok: true }) : c.json({ error: "bad" }, 400);
});

tarot.post("/api/logout", async (c) => {
  if (!sameSite(c)) return c.json({ error: "bad" }, 400);
  await endSession(c.env.DB, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/tarot", secure: true });
  return c.json({ ok: true });
});
