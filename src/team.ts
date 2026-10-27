// Settings → Team (/app/settings/team), owner only (the manage_team row of the permission table): invite by email with a one-time
// link that lasts 7 days, change a role, remove a member, hand over ownership. Every change is one guarded batch with its audit row.
// The owner can't remove or demote themselves: ownership only moves by a transfer, so a workspace always has exactly one owner.
import { Hono } from "hono";
import { html } from "hono/html";
import { can, listMembers, memberById, memberCsrf, sha256Hex, WORKSPACE_ID, type Member, type Role } from "./auth";
import { auditStmt, frame, refused, S, visibleTo, type ConsoleCtx, type ConsoleVars } from "./console";
import type { Env } from "./env";
import { sendEmailTo } from "./mail";
import { iso } from "./slots";
import { ago, chip, header } from "./ui";

export const INVITE_DAYS = 7;
const INVITE_ROLES: Role[] = ["PRACTITIONER", "STAFF"]; // nobody is invited as owner: ownership is handed over

// Team words, kept with the console's other ticket 19 words until the string catalogue (ticket 20) takes them.
export const T = {
  title: "Team",
  sub: "Who can open the console, and what each person can do.",
  you: "You",
  invited: "Invite sent",
  lastSeen: (when: string) => `Last opened ${when}`,
  neverSeen: "Hasn't opened the console yet",
  roleLabel: "Role",
  changeRole: "Change role",
  remove: "Remove…",
  removeWhy: (who: string) => `${who} can't open the console any more, from their next page. Their past actions stay in the audit log.`,
  removeYes: "Remove from the team",
  transfer: "Make owner…",
  transferWhy: (who: string) => `${who} becomes the owner, with money, settings and the team. You become Staff. Only the new owner can undo this.`,
  transferYes: "Hand over ownership",
  inviteTitle: "Invite someone",
  email: "Email address",
  name: "Name to show (optional)",
  send: "Send invite",
  inviteMail: {
    subject: "Your invite to the booking console",
    body: (business: string, role: string, link: string) =>
      `You've been invited to join ${business} on the booking console as ${role}.\n\nOpen this link within ${INVITE_DAYS} days and sign in with this email address:\n${link}\n\nThe link works once. If you weren't expecting this, ignore this email.`,
  },
  flash: {
    invited: "Invite sent. The link works once and lasts 7 days.",
    role: "Role changed.",
    removed: "Removed from the team.",
    bademail: "That doesn't look like an email address.",
    member: "That person is already on the team.",
    gone: "Nothing changed: that member has already changed or left.",
    self: "You can't change your own role or remove yourself. Hand over ownership first.",
  } as Record<string, string>,
  notSent: (link: string) => `The invite is saved, but the email didn't go. Send them this link yourself (it works once, for 7 days): ${link}`,
};

export const team = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const back = (c: ConsoleCtx, code: string) => c.redirect(`/app/settings/team?m=${code}`, 303);
const form = async (c: ConsoleCtx) => (await c.req.parseBody()) as Record<string, string | undefined>;
const who = (m: Pick<Member, "displayName" | "email">) => m.displayName || m.email;

// The owner's forms are only drawn for the actions can() allows; each POST asks can() again and checks its own token.
async function teamPage(c: ConsoleCtx, flash: string | null, status: 200 | 400 = 200) {
  const me = c.get("member");
  const jwt = c.get("jwt");
  const members = await listMembers(c.env);
  const rows = await Promise.all(
    members.map(async (m) => {
      const chips = html`<div class="chips">${chip(S.roles[m.role])}${m.status === "invited" ? chip(T.invited, "amber") : ""}${m.id === me.id ? chip(T.you, "green") : ""}</div>`;
      const seen = m.status === "invited" ? "" : html`<p class="small muted">${m.lastSeenAt ? T.lastSeen(ago(m.lastSeenAt)) : T.neverSeen}</p>`;
      if (m.id === me.id || m.role === "OWNER") return html`<div class="card"><h3>${who(m)}</h3><p class="who">${m.email}</p>${chips}${seen}</div>`;
      const roleForm = html`<form method="post" action="/app/settings/team/role"><input type="hidden" name="member" value="${m.id}">
<input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, `team-role:${m.id}`)}"><label class="small muted">${T.roleLabel}
<select name="role">${INVITE_ROLES.map((r) => html`<option value="${r}"${r === m.role ? " selected" : ""}>${S.roles[r]}</option>`)}</select></label>
<button type="submit">${T.changeRole}</button></form>`;
      const remove = html`<details class="confirm danger"><summary>${T.remove}</summary><p class="why">${T.removeWhy(who(m))}</p>
<form method="post" action="/app/settings/team/remove"><input type="hidden" name="member" value="${m.id}"><input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, `team-remove:${m.id}`)}">
<button class="danger solid" type="submit">${T.removeYes}</button></form></details>`;
      const transfer =
        m.status === "active"
          ? html`<details class="confirm"><summary>${T.transfer}</summary><p class="why">${T.transferWhy(who(m))}</p>
<form method="post" action="/app/settings/team/transfer"><input type="hidden" name="member" value="${m.id}"><input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, `team-transfer:${m.id}`)}">
<button class="danger solid" type="submit">${T.transferYes}</button></form></details>`
          : "";
      return html`<div class="card"><h3>${who(m)}</h3><p class="who">${m.email}</p>${chips}${seen}<div class="actions">${roleForm}${remove}${transfer}</div></div>`;
    }),
  );
  const invite = html`<h2>${T.inviteTitle}</h2><div class="card"><form method="post" action="/app/settings/team/invite">
<input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, "team-invite")}">
<p><label>${T.email}<br><input type="text" name="email" inputmode="email" autocomplete="off" required></label></p>
<p><label>${T.name}<br><input type="text" name="name" maxlength="60" autocomplete="off"></label></p>
<p><label>${T.roleLabel} <select name="role">${INVITE_ROLES.map((r) => html`<option value="${r}">${S.roles[r]}</option>`)}</select></label></p>
<div class="actions"><button class="primary" type="submit">${T.send}</button></div></form></div>`;
  const body = html`${header(T.title, T.sub)}<p class="small muted">${visibleTo("manage_team")}</p>${rows}${invite}`;
  return c.html(frame({ title: T.title, member: me, tab: "settings", body, flash }), status);
}

// Only the owner reaches anything here (GET or POST).
team.use("*", async (c, next) => {
  if (can(c.get("member"), "manage_team") !== "yes") return refused(c);
  await next();
});

team.get("/", (c) => teamPage(c, T.flash[c.req.query("m") ?? ""] ?? null));

// A target member: another member of this workspace, not removed, not the owner, not me.
async function targetOf(c: ConsoleCtx, raw: string | undefined): Promise<Member | "self" | null> {
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  if (id === c.get("member").id) return "self";
  const m = await memberById(c.env, id);
  return m && m.status !== "removed" && m.role !== "OWNER" ? m : null;
}

team.post("/invite", async (c) => {
  const me = c.get("member");
  const f = await form(c);
  if (f.csrf !== (await memberCsrf(c.get("jwt"), me, "team-invite"))) return c.text("Forbidden", 403);
  const email = (f.email ?? "").trim().toLowerCase();
  const role = f.role as Role;
  const name = (f.name ?? "").trim().slice(0, 60) || null;
  if (!INVITE_ROLES.includes(role)) return c.text("Bad request", 400);
  if (email.length > 254 || !EMAIL_RE.test(email)) return teamPage(c, T.flash.bademail, 400);
  const now = Date.now();
  const at = iso(now);
  const token = randomToken();
  const hash = await sha256Hex(token);
  // The member row is new, or a removed or still-invited one coming back; an active member is never touched.
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO members (workspace_id, email, display_name, role, status, locale)
       VALUES (?1, ?2, ?3, ?4, 'invited', COALESCE((SELECT value FROM settings WHERE key = 'business.default_locale' AND value IN ('en', 'hi')), 'en'))
       ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role, status = 'invited', display_name = COALESCE(excluded.display_name, members.display_name)
       WHERE members.status != 'active'`,
    ).bind(WORKSPACE_ID, email, name, role),
    // Older unused links for this email stop working (only when the member row above changed).
    c.env.DB.prepare("UPDATE invites SET used_at = ?3 WHERE workspace_id = ?1 AND email = ?2 AND used_at IS NULL AND (SELECT status FROM members WHERE workspace_id = ?1 AND email = ?2) = 'invited'").bind(WORKSPACE_ID, email, at),
    c.env.DB.prepare(
      `INSERT INTO invites (workspace_id, email, role, token_hash, expires_at, invited_by)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT status FROM members WHERE workspace_id = ?1 AND email = ?2) = 'invited'`,
    ).bind(WORKSPACE_ID, email, role, hash, iso(now + INVITE_DAYS * 86_400_000), me.id),
    auditStmt(c, "member_invited", `email:${email}`, role),
  ]);
  if (!res[2].meta.changes) return back(c, "member"); // already active: nothing was written
  const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(WORKSPACE_ID).first<{ name: string }>();
  const link = `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/app/invite/${token}`;
  const sent = await sendEmailTo(c.env, email, T.inviteMail.subject, T.inviteMail.body(ws?.name ?? "", S.roles[role], link));
  if (sent === "SENT") return back(c, "invited");
  // No redirect here: the link is shown once, on this page, and never put in a URL.
  return teamPage(c, T.notSent(link));
});

team.post("/role", async (c) => {
  const me = c.get("member");
  const f = await form(c);
  if (f.csrf !== (await memberCsrf(c.get("jwt"), me, `team-role:${f.member}`))) return c.text("Forbidden", 403);
  const role = f.role as Role;
  if (!INVITE_ROLES.includes(role)) return c.text("Bad request", 400);
  const m = await targetOf(c, f.member);
  if (m === "self") return back(c, "self");
  if (!m) return back(c, "gone");
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET role = ?3 WHERE workspace_id = ?1 AND id = ?2 AND role != 'OWNER' AND status != 'removed'").bind(WORKSPACE_ID, m.id, role),
    auditStmt(c, "member_role_changed", `member:${m.id}`, `${m.role} -> ${role}`),
  ]);
  if (!res[0].meta.changes) return back(c, "gone");
  return back(c, "role");
});

team.post("/remove", async (c) => {
  const me = c.get("member");
  const f = await form(c);
  if (f.csrf !== (await memberCsrf(c.get("jwt"), me, `team-remove:${f.member}`))) return c.text("Forbidden", 403);
  const m = await targetOf(c, f.member);
  if (m === "self") return back(c, "self");
  if (!m) return back(c, "gone");
  const at = iso(Date.now());
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET status = 'removed' WHERE workspace_id = ?1 AND id = ?2 AND role != 'OWNER' AND status != 'removed'").bind(WORKSPACE_ID, m.id),
    auditStmt(c, "member_removed", `member:${m.id}`, m.role),
    // Their unused invite links stop working too.
    c.env.DB.prepare("UPDATE invites SET used_at = ?3 WHERE workspace_id = ?1 AND email = ?2 AND used_at IS NULL").bind(WORKSPACE_ID, m.email, at),
  ]);
  if (!res[0].meta.changes) return back(c, "gone");
  return back(c, "removed");
});

// The old owner becomes Staff in the same batch, and the new owner is promoted only if that demotion happened (changes() = 1).
// The one-owner index refuses the whole batch if two hand-overs race. If the new owner left in between, the demotion is put back.
team.post("/transfer", async (c) => {
  const me = c.get("member");
  const f = await form(c);
  if (f.csrf !== (await memberCsrf(c.get("jwt"), me, `team-transfer:${f.member}`))) return c.text("Forbidden", 403);
  const m = await targetOf(c, f.member);
  if (m === "self") return back(c, "self");
  if (!m || m.status !== "active") return back(c, "gone");
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE members SET role = 'STAFF' WHERE workspace_id = ?1 AND id = ?2 AND role = 'OWNER' AND status = 'active'").bind(WORKSPACE_ID, me.id),
      c.env.DB.prepare("UPDATE members SET role = 'OWNER' WHERE workspace_id = ?1 AND id = ?2 AND status = 'active' AND role != 'OWNER' AND changes() = 1").bind(WORKSPACE_ID, m.id),
      auditStmt(c, "ownership_transferred", `member:${m.id}`, `from member:${me.id}`),
    ]);
    if (!res[1].meta.changes) throw new Error("not changed");
  } catch {
    await c.env.DB.prepare(
      "UPDATE members SET role = 'OWNER' WHERE workspace_id = ?1 AND id = ?2 AND role = 'STAFF' AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND role = 'OWNER' AND status != 'removed')",
    ).bind(WORKSPACE_ID, me.id).run();
    return back(c, "gone");
  }
  return c.redirect("/app?m=transferred", 303);
});

// 32 random bytes, URL-safe. Only its SHA-256 is stored.
function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
