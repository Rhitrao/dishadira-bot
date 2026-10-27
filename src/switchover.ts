// Ticket 25: the switch from the old pages (/admin, /amma) to the role-based console under /app, behind CONSOLE_V2.
// On: an old GET redirects (302) to the matching /app page, an old POST gets a page saying the console has moved, and email links
// point to /app. Off (the rollback): the old pages, their POSTs and the email links are exactly the old ones.
// The old pages themselves are removed in a later release, not here.
import type { Context, Next } from "hono";
import { html } from "hono/html";
import type { Env } from "./env";

export const consoleV2 = (env: { CONSOLE_V2?: string }) => env.CONSOLE_V2 === "true";

// The old People filters that have a match in /app/people (src/people.ts); "crisis", "quiet" and "paid" have none and are dropped.
const PEOPLE_FILTERS: Record<string, string> = { all: "all", human: "waiting", blocked: "blocked" };

// The /app page for an old path. Only query strings that still mean something are kept (People's search and filter);
// the old ?m= codes are the old pages' messages and mean nothing in /app. Anything unknown goes to /app (Today).
export function appPathFor(oldPath: string, query = new URLSearchParams()): string {
  const path = oldPath.replace(/\/+$/, "");
  const conv = /^\/admin\/conv\/(\d+)$/.exec(path);
  if (conv) return `/app/people/${conv[1]}`;
  if (path === "/admin/payments") return "/app/payments";
  if (path === "/admin/people") {
    const keep = new URLSearchParams();
    const q = (query.get("q") ?? "").trim();
    if (q) keep.set("q", q);
    const f = PEOPLE_FILTERS[query.get("f") ?? ""];
    if (f) keep.set("f", f);
    const s = keep.toString();
    return `/app/people${s ? `?${s}` : ""}`;
  }
  return "/app"; // /admin, /amma, /amma/confirm and any other old path
}

// A link for an email: the /app page while CONSOLE_V2 is on, the old page while it is off. `appPath` names the /app page when it
// isn't the plain mapping of the old one (a handed-over chat opens in the Inbox, not on the person page).
export const consoleLink = (env: { CONSOLE_V2?: string; PUBLIC_URL?: string }, oldPath: string, appPath = appPathFor(oldPath)) =>
  `${env.PUBLIC_URL ?? ""}${consoleV2(env) ? appPath : oldPath}`;

// "Refund unused sessions" (/admin/pack-refund/<package>) belongs to the buyer's person page.
async function packagePage(env: Env, id: number): Promise<string> {
  const row = await env.DB.prepare("SELECT conversation_id AS conv FROM packages WHERE id = ?1").bind(id).first<{ conv: number }>().catch(() => null);
  return row ? `/app/people/${row.conv}` : "/app/people";
}

// Both languages on one page: this runs before sign-in, so the member's language isn't known yet. [Hindi to be read by a Hindi speaker.]
const movedPage = (to: string) => html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The console has moved</title><style>body{font:19px/1.5 system-ui,sans-serif;max-width:36rem;margin:0 auto;padding:24px 16px;background:#fff;color:#1a1a1a}
a{display:inline-block;min-height:48px;line-height:48px;padding:0 20px;border-radius:8px;background:#1d4d3f;color:#fff;text-decoration:none}</style></head>
<body><h1>The console has moved</h1><p>Nothing was changed. Please do this again in the new console.</p>
<p lang="hi">कंसोल नई जगह पर है। कुछ नहीं बदला गया। कृपया नए कंसोल में फिर से करें।</p>
<p><a href="${to}">Open the new console · नया कंसोल खोलें</a></p></body></html>`;

// Middleware for /admin and /amma (src/index.ts), before their own sign-in check: nothing here reads or changes anything private.
export async function switchOver(c: Context<{ Bindings: Env }>, next: Next) {
  if (!consoleV2(c.env)) return next();
  const url = new URL(c.req.url);
  const pack = /^\/admin\/pack-refund\/(\d+)\/?$/.exec(url.pathname);
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.redirect(pack ? await packagePage(c.env, Number(pack[1])) : appPathFor(url.pathname, url.searchParams), 302);
  }
  return c.html(movedPage(appPathFor(url.pathname)), 410, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
}
