// The role-based console under /app (docs/CONSOLE-PRD.md), behind CONSOLE_V2. Same rules as /admin: Access JWT verified by the
// Worker, POST-only changes, Origin + per-form CSRF, escaped output, no-store, the strict CSP and no scripts. Membership is the gate:
// a verified email without an active membership sees "No access". Every tab, screen and button asks can() / canAny() (src/auth.ts).
// Every page, refusals and the invite included, is drawn on the design system in src/ui.ts (consoleFrame, or plainFrame with no tabs).
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { activeMember, csrf, memberCsrf, seedMembers, sha256Hex, touchMember, verifiedEmail, WORKSPACE_ID, type Action, type Member, type Role } from "./auth";
import { accentOf, type AccentName } from "./business";
import { calendar } from "./calendar";
import { consoleCopy } from "./console-copy";
import type { Env } from "./env";
import { iso } from "./slots";
import { inbox } from "./inbox";
import { payments } from "./payments";
import { people } from "./people";
import { settings } from "./settings";
import { team } from "./team";
import { today } from "./today";
import { CONSOLE_CSP, consoleFrame, emptyState, plainFrame, type TabId } from "./ui";

// accent and business (the workspace name): Settings → Business, read once per request
export type ConsoleVars = { jwt: string; email: string; member: Member; accent: AccentName; business: string };
export type ConsoleCtx = Context<{ Bindings: Env; Variables: ConsoleVars }>;

// Invite and hand-over words from ticket 19 (the invite page is seen before the person is a member, so it is in English).
export const S = {
  roles: { OWNER: "Owner", PRACTITIONER: "Practitioner", STAFF: "Staff" } as Record<Role, string>,
  noAccessLong: "This email address isn't a member of this business. Ask the owner to invite you, then open the invite link they send you.",
  transferred: "Ownership handed over. You're now Staff.",
  transferredPractitioner: "Ownership handed over. You're now a Practitioner.",
  invite: {
    title: "Join the team",
    asRole: (role: string) => `You're invited to join as ${role}.`,
    accept: "Accept the invite",
    invalid: "This invite link isn't valid.",
    used: "This invite has already been used. Open the console from your bookmark, or ask the owner for a new invite.",
    expired: "This invite has expired. Ask the owner to send a new one.",
    otherEmail: "This invite is for a different email address. Sign in with the address the invite was sent to.",
    joined: "Welcome. You're now a member of the team.",
  },
};

// Each tab is shown only to the roles whose permission row allows it, so a practitioner sees three tabs: Today, Calendar, People.
// (The frame in src/ui.ts draws them; this list is the permission each one needs.)
export const TABS: { id: TabId; href: string; action: Action }[] = [
  { id: "today", href: "/app", action: "view_today" },
  { id: "inbox", href: "/app/inbox", action: "reply_chat" },
  { id: "calendar", href: "/app/calendar", action: "view_calendar" },
  { id: "people", href: "/app/people", action: "view_people" },
  { id: "payments", href: "/app/payments", action: "see_money" },
  { id: "settings", href: "/app/settings", action: "business_settings" },
];

const secure = (res: Response) => {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Content-Security-Policy", CONSOLE_CSP);
  return res;
};

// A screen for a signed-in member on the console's frame: the workspace name and accent (read once per request in the middleware
// below), the member's tabs and the language switch.
export async function appPage(c: ConsoleCtx, o: { active: TabId | null; title: string; body: unknown; flash?: string | null; back?: string; status?: 200 | 400 | 403 | 404 | 409 | 500 | 503 }) {
  const m = c.get("member");
  return c.html(
    consoleFrame({
      role: m.role, locale: m.locale, active: o.active, title: o.title, body: o.body, business: c.get("business") ?? "", member: m.displayName || undefined,
      flash: o.flash ?? null, language: { csrf: await languageCsrf(c.get("jwt"), m), back: o.back ?? "/app" }, accent: c.get("accent"),
    }),
    o.status ?? 200,
  );
}

// Someone signed in whose email isn't an active member: no tabs, nothing about the business, English and Hindi.
export const noAccess = async (c: Context) => {
  console.log("app: no access"); // never the email
  const en = consoleCopy("en");
  const hi = consoleCopy("hi");
  const body = html`<header class="screen"><h1>${en.noAccess}</h1></header><div class="empty"><p>${S.noAccessLong}</p><p lang="hi">${hi.noAccessBody}</p></div>`;
  return secure(await c.html(plainFrame({ title: en.noAccess, body }), 403));
};

// A role that can't do this: the same refusal for a hand-made POST as for a page the tabs never showed.
export const refused = async (c: ConsoleCtx) => {
  const cc = consoleCopy(c.get("member").locale);
  const body = html`<header class="screen"><h1>${cc.noAccess}</h1></header>${emptyState(cc.notForRole, { label: cc.backToToday, href: "/app" })}`;
  return appPage(c, { active: null, title: cc.noAccess, body, status: 403 });
};

// An audit row: who (the member), what, on what, and why. Returned unrun so it joins the change's batch, right after the change:
// it is written only if that statement changed a row (SQLite's changes()), so the log never records something that didn't happen.
export const auditStmt = (c: ConsoleCtx, action: string, target: string, detail: string, reason: string | null = null) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0").bind(
    c.get("email"), action, target, detail, c.get("member")?.workspaceId ?? WORKSPACE_ID, c.get("member")?.id ?? null, reason,
  );

export const consoleApp = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

consoleApp.use("*", async (c, next) => {
  if (c.env.CONSOLE_V2 !== "true") return c.text("Not found", 404);
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  const email = await verifiedEmail(c.env, token);
  if (!token || !email) return noAccess(c);
  // Browsers always send Origin on a POST; a missing or foreign one is refused.
  if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.req.url).origin) return secure(c.text("Forbidden", 403));
  c.set("jwt", token);
  c.set("email", email);
  await seedMembers(c.env);
  // The invite link is the one page for someone who isn't an active member yet; it checks the invite itself.
  if (!c.req.path.startsWith("/app/invite/")) {
    const m = await activeMember(c.env, email);
    if (!m) return noAccess(c);
    c.set("member", m);
    c.set("accent", await accentOf(c.env.DB).catch((): AccentName => "teal"));
    const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(m.workspaceId).first<{ name: string }>().catch(() => null);
    c.set("business", ws?.name ?? "");
    await touchMember(c.env, m).catch(() => undefined);
  }
  await next();
  // A bare-text refusal from a screen (an old form's token, a bad field, an unknown address) is shown on the console's own look.
  const status = c.res.status;
  if (c.get("member") && (status === 400 || status === 403 || status === 404) && (c.res.headers.get("Content-Type") ?? "").startsWith("text/plain")) {
    c.res = undefined;
    c.res = await errorPage(c, status);
  }
  secure(c.res);
});

async function errorPage(c: ConsoleCtx, status: 400 | 403 | 404 | 500) {
  const cc = consoleCopy(c.get("member").locale);
  const text = { 400: cc.errBad, 403: cc.errForm, 404: cc.notFound, 500: cc.errServer }[status];
  const body = html`<header class="screen"><h1>${status === 404 ? cc.notFound : cc.errTitle}</h1></header>${emptyState(text, { label: cc.backToToday, href: "/app" })}`;
  return appPage(c, { active: null, title: status === 404 ? cc.notFound : cc.errTitle, body, status });
}
consoleApp.onError(async (_e, c) => {
  console.error("app: unhandled error", c.req.method, c.req.routePath); // the route only: error text can carry user data
  if (!c.get("member")) return c.text("error", 500);
  return secure(await errorPage(c, 500));
});

// ---- the screens, each behind its own permission row ----
consoleApp.route("/", today); // Today (ticket 21, src/today.ts): GET /app and its POSTs under /app/today/*
consoleApp.route("/inbox", inbox); // ticket 22: src/inbox.ts
consoleApp.route("/calendar", calendar); // ticket 27: src/calendar.ts
consoleApp.route("/people", people); // ticket 23: the list and /app/people/<id> (src/people.ts)
consoleApp.route("/payments", payments); // ticket 24 (src/payments.ts)
consoleApp.route("/settings/team", team);
consoleApp.route("/settings", settings); // ticket 24 (src/settings.ts)

// ---- the language switch in the page frame (ticket 20): every member may choose English or Hindi for their own console ----
// The frame's form sends csrf (languageCsrf below), locale (the language to switch to) and back (the page it was on).
export const languageCsrf = (jwt: string, m: Member) => memberCsrf(jwt, m, "language");
// Only a path inside the console, never another site ("//host") or a full URL.
export function backTo(raw: string | null | undefined): string {
  let path = raw ?? "";
  try {
    if (/^https?:/i.test(path)) path = new URL(path).pathname + new URL(path).search;
  } catch {
    return "/app";
  }
  return /^\/app(?:[/?]|$)/.test(path) && !path.startsWith("//") && !path.includes("\\") ? path : "/app";
}
consoleApp.post("/language", async (c) => {
  const m = c.get("member");
  const f = (await c.req.parseBody()) as Record<string, string | undefined>;
  if (f.csrf !== (await languageCsrf(c.get("jwt"), m))) return c.text("Forbidden", 403);
  if (f.locale !== "en" && f.locale !== "hi") return c.text("Bad request", 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET locale = ?3 WHERE workspace_id = ?1 AND id = ?2 AND status = 'active' AND locale != ?3").bind(m.workspaceId, m.id, f.locale),
    auditStmt(c, "MEMBER_LOCALE", `member:${m.id}`, `${m.locale} -> ${f.locale}`),
  ]);
  // The Referer carries the whole URL; only its path is used, and only inside /app.
  const back = f.back ? backTo(f.back) : backTo(c.req.header("Referer"));
  return c.redirect(back, 303);
});

// ---- accepting an invite: GET shows one button (mail scanners only ever GET), the POST does it ----
type InviteRow = { id: number; email: string; role: Role; expiresAt: string; usedAt: string | null; memberStatus: string | null };

async function inviteFor(c: ConsoleCtx): Promise<{ hash: string; inv: InviteRow | null }> {
  const hash = await sha256Hex(c.req.param("token") ?? "");
  const inv = await c.env.DB
    .prepare(
      `SELECT i.id, i.email, i.role, i.expires_at AS expiresAt, i.used_at AS usedAt, m.status AS memberStatus FROM invites i
       LEFT JOIN members m ON m.workspace_id = i.workspace_id AND m.email = i.email WHERE i.token_hash = ?1 AND i.workspace_id = ?2`,
    )
    .bind(hash, WORKSPACE_ID)
    .first<InviteRow>();
  return { hash, inv };
}

// Why an invite can't be used, or null when it can.
function inviteProblem(inv: InviteRow | null, email: string, nowMs: number): { text: string; status: 403 | 404 | 410 } | null {
  if (!inv) return { text: S.invite.invalid, status: 404 };
  if (inv.usedAt || inv.memberStatus !== "invited") return { text: S.invite.used, status: 410 };
  if (Date.parse(inv.expiresAt) <= nowMs) return { text: S.invite.expired, status: 410 };
  if (inv.email !== email) return { text: S.invite.otherEmail, status: 403 };
  return null;
}

const invitePage = (c: ConsoleCtx, body: unknown, status: 200 | 403 | 404 | 410 = 200) =>
  c.html(plainFrame({ title: S.invite.title, body: html`<header class="screen"><h1>${S.invite.title}</h1></header>${body}` }), status);

consoleApp.get("/invite/:token", async (c) => {
  const { hash, inv } = await inviteFor(c);
  const problem = inviteProblem(inv, c.get("email"), Date.now());
  if (problem) return invitePage(c, emptyState(problem.text), problem.status);
  const token = await csrf(c.get("jwt"), `invite:${hash}`);
  return invitePage(
    c,
    html`<div class="card"><p>${S.invite.asRole(S.roles[inv!.role])}</p><div class="acts"><form method="post" action="/app/invite/${c.req.param("token")}"><input type="hidden" name="csrf" value="${token}"><button class="btn primary" type="submit">${S.invite.accept}</button></form></div></div>`,
  );
});

consoleApp.post("/invite/:token", async (c) => {
  const { hash, inv } = await inviteFor(c);
  const now = Date.now();
  const problem = inviteProblem(inv, c.get("email"), now);
  if (problem) return invitePage(c, emptyState(problem.text), problem.status);
  const f = await c.req.parseBody();
  if (f.csrf !== (await csrf(c.get("jwt"), `invite:${hash}`))) return c.text("Forbidden", 403);
  const at = iso(now);
  // One batch: use the invite (only if unused and in date), activate the invited member (only if that just happened), audit it.
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invites SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2").bind(inv!.id, at),
    c.env.DB.prepare(
      "UPDATE members SET status = 'active' WHERE workspace_id = ?1 AND email = ?2 AND status = 'invited' AND EXISTS (SELECT 1 FROM invites WHERE id = ?3 AND used_at = ?4)",
    ).bind(WORKSPACE_ID, inv!.email, inv!.id, at),
    c.env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id)
       SELECT ?1, 'invite_accepted', 'member:' || id, role, workspace_id, id FROM members WHERE workspace_id = ?2 AND email = ?1 AND changes() > 0`,
    ).bind(inv!.email, WORKSPACE_ID),
  ]);
  if (!res[1].meta.changes) return invitePage(c, emptyState(S.invite.used), 410);
  return c.redirect("/app?m=joined", 303);
});
