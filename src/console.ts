// The role-based console under /app (docs/CONSOLE-PRD.md), behind CONSOLE_V2. Same rules as /admin: Access JWT verified by the
// Worker, POST-only changes, Origin + per-form CSRF, escaped output, no-store, the strict CSP and no scripts. Membership is the gate:
// a verified email without an active membership sees "No access". Every tab, screen and button asks can() / canAny() (src/auth.ts).
// Ticket 19 builds the frame, the role-filtered tabs (screens are placeholders until tickets 21-24) and the team page (src/team.ts).
// The page still uses today's stylesheet from src/ui.ts; ticket 21 moves it onto the new design system and the string catalogue.
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { activeMember, canAny, csrf, memberCsrf, ROLES, seedMembers, sha256Hex, touchMember, verifiedEmail, WORKSPACE_ID, type Action, type Member, type Role } from "./auth";
import type { Env } from "./env";
import { iso } from "./slots";
import { inbox } from "./inbox";
import { people } from "./people";
import { team } from "./team";
import { today } from "./today";
import { CONSOLE_CSS, header } from "./ui";

export type ConsoleVars = { jwt: string; email: string; member: Member };
export type ConsoleCtx = Context<{ Bindings: Env; Variables: ConsoleVars }>;

// Console words added by ticket 19, in one place so they can move to the string catalogue (src/console-copy.ts, ticket 20).
export const S = {
  brand: "Console",
  noAccessTitle: "No access",
  noAccess: "This email address isn't a member of this business. Ask the owner to invite you, then open the link in the invite email.",
  notForRole: "Your role can't open this page.",
  backToToday: "Back to Today",
  comingSoon: "This screen comes in the next release.",
  visibleTo: "Visible to",
  roles: { OWNER: "Owner", PRACTITIONER: "Practitioner", STAFF: "Staff" } as Record<Role, string>,
  tabs: { today: "Today", inbox: "Inbox", calendar: "Calendar", people: "People", payments: "Payments", settings: "Settings" },
  questions: {
    today: "What needs me now?",
    inbox: "Who is waiting for a reply?",
    calendar: "When am I booked or free?",
    people: "Who is this customer?",
    payments: "Is the money right?",
    settings: "How does the business run?",
  },
  settingsTeam: "Team",
  settingsTeamWhy: "Invite people, set their roles, remove members.",
  transferred: "Ownership handed over. You're now Staff.",
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

type TabId = keyof typeof S.tabs;
// Each tab is shown only to the roles whose permission row allows it, so a practitioner sees three tabs: Today, Calendar, People.
export const TABS: { id: TabId; href: string; action: Action; icon: string }[] = [
  { id: "today", href: "/app", action: "view_today", icon: "◷" },
  { id: "inbox", href: "/app/inbox", action: "reply_chat", icon: "✉" },
  { id: "calendar", href: "/app/calendar", action: "view_calendar", icon: "▦" },
  { id: "people", href: "/app/people", action: "view_people", icon: "☺" },
  { id: "payments", href: "/app/payments", action: "see_money", icon: "₹" },
  { id: "settings", href: "/app/settings", action: "business_settings", icon: "⚙" },
];
export const tabsFor = (m: Member) => TABS.filter((t) => canAny(m, t.action));

// "Visible to: Owner, Staff", from the same permission table.
export const visibleTo = (action: Action) => `${S.visibleTo}: ${ROLES.filter((r) => canAny({ id: 0, workspaceId: 0, email: "", displayName: null, role: r, locale: "en", status: "active" }, action)).map((r) => S.roles[r]).join(", ")}`;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'";
const secure = (res: Response) => {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Content-Security-Policy", CSP);
  return res;
};

// The page frame: the stylesheet, the member's tabs and the flash line. `body` is already-escaped html.
export function frame(opts: { title: string; member: Member | null; tab: TabId | null; body: unknown; flash?: string | null }) {
  const tabs = opts.member
    ? tabsFor(opts.member).map(
        (t) => html`<a href="${t.href}" class="${t.id === opts.tab ? "on" : ""}"${t.id === opts.tab ? raw(' aria-current="page"') : ""}><span class="i" aria-hidden="true">${t.icon}</span><span>${S.tabs[t.id]}</span></a>`,
      )
    : [];
  const lang = opts.member?.locale === "hi" ? "hi" : "en";
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${opts.title} · ${S.brand}</title><style>${raw(CONSOLE_CSS)}</style></head><body>
${tabs.length ? html`<nav class="tabs" aria-label="${S.brand}"><span class="brand">${S.brand}</span>${tabs}</nav>` : ""}
<div class="wrap">${opts.flash ? html`<p class="flash" role="status">${opts.flash}</p>` : ""}${opts.body}</div></body></html>`;
}

export const noAccess = async (c: Context) => {
  console.log("app: no access"); // never the email
  return secure(await c.html(frame({ title: S.noAccessTitle, member: null, tab: null, body: html`${header(S.noAccessTitle, "")}<p>${S.noAccess}</p>` }), 403));
};

// A role that can't do this: the same refusal for a hand-made POST as for a page the tabs never showed.
export const refused = (c: ConsoleCtx) =>
  c.html(frame({ title: S.noAccessTitle, member: c.get("member"), tab: null, body: html`${header(S.noAccessTitle, "")}<p>${S.notForRole}</p><p><a class="btn" href="/app">${S.backToToday}</a></p>` }), 403);

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
    await touchMember(c.env, m).catch(() => undefined);
  }
  await next();
  secure(c.res);
});

// ---- the screens: placeholders until tickets 21-24 build them, each behind its own permission row ----
const placeholder = (id: TabId) => async (c: ConsoleCtx) => {
  const tab = TABS.find((t) => t.id === id)!;
  const m = c.get("member");
  if (!canAny(m, tab.action)) return refused(c);
  const extra =
    id === "settings" && canAny(m, "manage_team")
      ? html`<h2>${S.tabs.settings}</h2><div class="list"><a class="li" href="/app/settings/team"><span class="main"><b>${S.settingsTeam}</b><div class="muted">${S.settingsTeamWhy}</div></span><span class="go" aria-hidden="true">›</span></a></div>`
      : html`<p class="muted">${S.comingSoon}</p>`;
  const flash = id === "today" ? (({ joined: S.invite.joined, transferred: S.transferred }) as Record<string, string>)[c.req.query("m") ?? ""] ?? null : null;
  return c.html(frame({ title: S.tabs[id], member: m, tab: id, flash, body: html`${header(S.tabs[id], S.questions[id])}<p class="small muted">${visibleTo(tab.action)}</p>${extra}` }));
};
consoleApp.route("/", today); // Today (ticket 21, src/today.ts): GET /app and its POSTs under /app/today/*
consoleApp.route("/inbox", inbox); // ticket 22: src/inbox.ts
consoleApp.get("/calendar", placeholder("calendar"));
consoleApp.route("/people", people); // ticket 23: the list and /app/people/<id> (src/people.ts)
consoleApp.get("/payments", placeholder("payments"));
consoleApp.get("/settings", placeholder("settings"));
consoleApp.route("/settings/team", team);

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
  c.html(frame({ title: S.invite.title, member: null, tab: null, body: html`${header(S.invite.title, "")}${body}` }), status);

consoleApp.get("/invite/:token", async (c) => {
  const { hash, inv } = await inviteFor(c);
  const problem = inviteProblem(inv, c.get("email"), Date.now());
  if (problem) return invitePage(c, html`<p>${problem.text}</p>`, problem.status);
  const token = await csrf(c.get("jwt"), `invite:${hash}`);
  return invitePage(
    c,
    html`<p>${S.invite.asRole(S.roles[inv!.role])}</p><form method="post" action="/app/invite/${c.req.param("token")}"><input type="hidden" name="csrf" value="${token}"><button class="primary" type="submit">${S.invite.accept}</button></form>`,
  );
});

consoleApp.post("/invite/:token", async (c) => {
  const { hash, inv } = await inviteFor(c);
  const now = Date.now();
  const problem = inviteProblem(inv, c.get("email"), now);
  if (problem) return invitePage(c, html`<p>${problem.text}</p>`, problem.status);
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
  if (!res[1].meta.changes) return invitePage(c, html`<p>${S.invite.used}</p>`, 410);
  return c.redirect("/app?m=joined", 303);
});
