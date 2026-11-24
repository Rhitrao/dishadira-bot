// Ticket 57: the tarot game's routes under /tarot. Off (a plain 404) unless TAROT_GAME is "true".
//   GET  /tarot                 the game (one page; the script and the card art come from this Worker only)
//   GET  /tarot/in?t=<token>    the bot's one-time login link: sets the session cookie and sends the person on to /tarot
//   GET  /tarot/app.js, /tarot/art/<id>.webp, /tarot/fonts/<file>
//   GET  /tarot/api/state       who is logged in, today's readings, the journal, the collection and the streak
//   POST /tarot/api/start       shuffle and cut for today's daily card or free spread
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
import { cardView, isSpread, isTheme, SPREADS, summarize, THEMES, type Drawn, type SpreadId, type ThemeId } from "./reading";
import { endSession, finishReading, journal, newSession, redeemLogin, seenCards, sessionConv, setNote, startReading, streak, todayRows, SESSION_DAYS } from "./store";

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

const readingView = (kind: SpreadId, theme: ThemeId | null, question: string | null, cards: Drawn[], id: number, note: string | null) => ({
  id,
  kind,
  theme,
  question,
  note,
  spread: SPREADS[kind].label,
  cards: cards.map((d, i) => ({ position: SPREADS[kind].positions[i].name, frame: SPREADS[kind].positions[i].frame, ...cardView(d, theme) })),
  summary: summarize(cards),
});

tarot.get("/api/state", async (c) => {
  c.header("Cache-Control", "no-store");
  const conv = await who(c);
  if (conv === null) return c.json({ in: false });
  const now = Date.now();
  const today = await todayRows(c.env.DB, conv, istDay(now));
  const done = (k: SpreadId) => {
    const r = today.find((x) => x.kind === k && x.done_at && x.cards);
    return r ? readingView(k, r.theme, r.question, JSON.parse(r.cards!) as Drawn[], r.id, r.note) : null;
  };
  const days = await journal(c.env.DB, conv, now);
  return c.json({
    in: true,
    day: istDay(now),
    streak: await streak(c.env.DB, conv, now),
    seen: await seenCards(c.env.DB, conv),
    today: { daily: done("daily"), ppf: done("ppf") },
    journal: days.map((j) => ({ day: j.day, ...readingView(j.kind, j.theme, j.question, j.cards, j.id, j.note) })),
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, { label: t.label, blurb: t.blurb, questions: t.questions }])),
  });
});

tarot.post("/api/start", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || !isSpread(b.kind)) return c.json({ error: "bad" }, 400);
  let theme: ThemeId | null = null;
  let question: string | null = null;
  if (b.kind === "ppf") {
    if (!isTheme(b.theme)) return c.json({ error: "bad" }, 400);
    theme = b.theme;
    const qi = Number(b.question);
    if (!Number.isInteger(qi) || qi < 0 || qi >= THEMES[theme].questions.length) return c.json({ error: "bad" }, 400);
    question = THEMES[theme].questions[qi];
  }
  const pile = Number.isInteger(b.pile) ? (b.pile as number) : 0;
  const res = await startReading(c.env.DB, conv, b.kind, theme, question, pile);
  if (res === "done") return c.json({ error: "done" }, 409);
  return c.json({ ok: true, count: SPREADS[b.kind].positions.length });
});

tarot.post("/api/pick", async (c) => {
  const conv = await who(c);
  if (conv === null) return c.json({ error: "login" }, 401);
  const b = await body(c);
  if (!b || !isSpread(b.kind)) return c.json({ error: "bad" }, 400);
  const res = await finishReading(c.env.DB, conv, b.kind, b.picks);
  if (!res) return c.json({ error: "bad" }, 400);
  const row = (await todayRows(c.env.DB, conv, istDay(Date.now()))).find((r) => r.id === res.id);
  return c.json({ ok: true, reading: readingView(b.kind, row?.theme ?? null, row?.question ?? null, res.cards, res.id, null) });
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
