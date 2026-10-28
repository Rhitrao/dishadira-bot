// Settings → Team (/app/settings/team), owner only (the manage_team row of the permission table): invite someone with a one-time
// link that lasts 7 days, change a role, remove a member, hand over ownership. Every change is one guarded batch with its audit row.
// The owner can't remove or demote themselves: ownership only moves by a transfer, so a workspace always has exactly one owner.
// Invites are never emailed (CONTRACT v6: email goes only to verified addresses): the page shows the link once, with a "Send on
// WhatsApp" link and a field to copy it from. On a hand-over the old owner chooses to stay on as Practitioner (the default) or Staff.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, listMembers, memberById, memberCsrf, sha256Hex, WORKSPACE_ID, type Member, type Role } from "./auth";
import { hasOwnName } from "./business";
import { appPage, auditStmt, refused, S, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy, consoleLang } from "./console-copy";
import type { Env } from "./env";
import { iso } from "./slots";
import { agoText, EXTRA_CSS } from "./settings";
import { confirmStep, roleName, section, statusChip } from "./ui";

export const INVITE_DAYS = 7;
const INVITE_ROLES: Role[] = ["PRACTITIONER", "STAFF"]; // nobody is invited as owner: ownership is handed over
const AFTER_HANDOVER: Role[] = ["PRACTITIONER", "STAFF"]; // what the old owner becomes; the first is the default

// Team words, English and Hindi (the owner's language), in the shape of src/console-copy.ts.
const en = {
  title: "Team",
  sub: "Who can open the console, and what each person can do.",
  backToSettings: "Settings",
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
  transferWhy: (who: string) => `${who} becomes the owner, with money, settings and the team. Only the new owner can undo this.`,
  transferAs: "After the hand-over, I stay on as",
  transferYes: "Hand over ownership",
  inviteTitle: "Invite someone",
  email: "Email address",
  name: "Name to show (optional)",
  send: "Make an invite link",
  linkReady: (email: string) => `Invite ready for ${email}. Send them this link yourself: it works once and lasts ${INVITE_DAYS} days, and it's shown only now.`,
  sendOnWhatsApp: "Send on WhatsApp",
  copyLabel: "Or copy the link",
  fRole: "Role changed.",
  fRemoved: "Removed from the team.",
  fBademail: "That doesn't look like an email address.",
  fMember: "That person is already on the team.",
  fGone: "Nothing changed: that member has already changed or left.",
  fSelf: "You can't change your own role or remove yourself. Hand over ownership first.",
};
type TeamCopy = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : string };
const hi: TeamCopy = {
  title: "टीम",
  sub: "कौन कंसोल खोल सकता है, और हर व्यक्ति क्या कर सकता है।",
  backToSettings: "सेटिंग्स",
  you: "आप",
  invited: "निमंत्रण भेजा",
  lastSeen: (when) => `आख़िरी बार खोला ${when}`,
  neverSeen: "अभी तक कंसोल नहीं खोला",
  roleLabel: "रोल",
  changeRole: "रोल बदलें",
  remove: "हटाएँ…",
  removeWhy: (who) => `${who} अगले पेज से कंसोल नहीं खोल पाएँगे। उनके पुराने काम ऑडिट लॉग में रहेंगे।`,
  removeYes: "टीम से हटाएँ",
  transfer: "मालिक बनाएँ…",
  transferWhy: (who) => `${who} मालिक बन जाएँगे, पैसे, सेटिंग्स और टीम के साथ। इसे सिर्फ़ नए मालिक बदल सकते हैं।`,
  transferAs: "सौंपने के बाद मैं रहूँगा/रहूँगी",
  transferYes: "मालिकाना सौंपें",
  inviteTitle: "किसी को बुलाएँ",
  email: "ईमेल पता",
  name: "दिखाने वाला नाम (ज़रूरी नहीं)",
  send: "निमंत्रण लिंक बनाएँ",
  linkReady: (email) => `${email} के लिए निमंत्रण तैयार है। यह लिंक ख़ुद भेजें: यह एक बार चलता है, ${INVITE_DAYS} दिन तक, और सिर्फ़ अभी दिखेगा।`,
  sendOnWhatsApp: "WhatsApp पर भेजें",
  copyLabel: "या लिंक कॉपी करें",
  fRole: "रोल बदल गया।",
  fRemoved: "टीम से हटा दिया।",
  fBademail: "यह ईमेल पता सही नहीं लगता।",
  fMember: "यह व्यक्ति पहले से टीम में है।",
  fGone: "कुछ नहीं बदला: यह सदस्य पहले ही बदल चुके हैं या जा चुके हैं।",
  fSelf: "आप अपना रोल नहीं बदल सकते, न ख़ुद को हटा सकते। पहले मालिकाना सौंपें।",
};
const teamCopy = (locale: string | null | undefined) => (consoleLang(locale) === "hi" ? hi : en);
const FLASH: Record<string, keyof TeamCopy> = { role: "fRole", removed: "fRemoved", bademail: "fBademail", member: "fMember", gone: "fGone", self: "fSelf" };
// The invite message the owner sends themselves (WhatsApp, or copied anywhere), in English: the invited person's language isn't known.
const inviteText = (business: string, role: string, email: string) =>
  `You're invited to join ${business} on the booking console as ${role}. Open this link within ${INVITE_DAYS} days and sign in with ${email}. It works once:`;

export const team = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const back = (c: ConsoleCtx, code: string) => c.redirect(`/app/settings/team?m=${code}`, 303);
const form = async (c: ConsoleCtx) => (await c.req.parseBody()) as Record<string, string | undefined>;
const who = (m: Pick<Member, "displayName" | "email">) => m.displayName || m.email;

// The owner's forms are only drawn for the actions can() allows; each POST asks can() again and checks its own token.
async function teamPage(c: ConsoleCtx, flash: string | null, status: 200 | 400 = 200, ready?: unknown) {
  const me = c.get("member");
  const jwt = c.get("jwt");
  const T = teamCopy(me.locale);
  const role = (r: Role) => roleName(r, me.locale);
  const members = await listMembers(c.env);
  const cards = await Promise.all(
    members.map(async (m) => {
      const chips = html`<div class="chips">${statusChip(role(m.role), "plain")}${m.status === "invited" ? statusChip(T.invited, "attention") : ""}${m.id === me.id ? statusChip(T.you, "accent") : ""}</div>`;
      const seen = m.status === "invited" ? "" : html`<p class="why">${m.lastSeenAt ? T.lastSeen(agoText(m.lastSeenAt, me.locale)) : T.neverSeen}</p>`;
      const head = html`<h3>${who(m)}</h3><p class="why mail">${m.email}</p>${chips}${seen}`;
      if (m.id === me.id || m.role === "OWNER") return html`<article class="card">${head}</article>`;
      const roleForm = html`<form class="rolef" method="post" action="/app/settings/team/role"><input type="hidden" name="member" value="${m.id}">
<input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, `team-role:${m.id}`)}"><label class="fld"><span>${T.roleLabel}</span>
<select name="role">${INVITE_ROLES.map((r) => html`<option value="${r}"${r === m.role ? raw(" selected") : ""}>${role(r)}</option>`)}</select></label>
<button class="btn" type="submit">${T.changeRole}</button></form>`;
      const remove = confirmStep({ label: T.remove, effect: T.removeWhy(who(m)), confirm: T.removeYes, post: { action: "/app/settings/team/remove", csrf: await memberCsrf(jwt, me, `team-remove:${m.id}`), fields: { member: String(m.id) } } });
      const transfer =
        m.status === "active"
          ? html`<details class="confirm"><summary>${T.transfer}</summary><div class="panel"><p class="effect">${T.transferWhy(who(m))}</p>
<form method="post" action="/app/settings/team/transfer"><input type="hidden" name="member" value="${m.id}"><input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, `team-transfer:${m.id}`)}">
<fieldset class="pick"><legend>${T.transferAs}</legend>${AFTER_HANDOVER.map(
              (r, i) => html`<label><input type="radio" name="as" value="${r}"${i === 0 ? raw(" checked") : ""}> ${role(r)}</label>`,
            )}</fieldset>
<button class="btn danger" type="submit">${T.transferYes}</button></form></div></details>`
          : "";
      return html`<article class="card">${head}${roleForm}<div class="acts">${remove}${transfer}</div></article>`;
    }),
  );
  const invite = html`<div class="card"><form method="post" action="/app/settings/team/invite">
<input type="hidden" name="csrf" value="${await memberCsrf(jwt, me, "team-invite")}">
<label class="fld"><span>${T.email}</span><input type="text" name="email" inputmode="email" autocomplete="off" required></label>
<label class="fld"><span>${T.name}</span><input type="text" name="name" maxlength="60" autocomplete="off"></label>
<label class="fld"><span>${T.roleLabel}</span><select name="role">${INVITE_ROLES.map((r) => html`<option value="${r}">${role(r)}</option>`)}</select></label>
<div class="acts"><button class="btn primary" type="submit">${T.send}</button></div></form></div>`;
  const cc = consoleCopy(me.locale);
  const body = html`${raw(EXTRA_CSS)}<style>${raw(TEAM_CSS)}</style><a class="crumb" href="/app/settings">← ${T.backToSettings}</a>
<header class="screen"><h1>${T.title}</h1><p class="visible">${cc.visibleTo(role("OWNER"))}</p></header><p class="muted lead">${T.sub}</p>
${ready ?? ""}${section(T.title, cards, members.length)}${section(T.inviteTitle, invite)}`;
  return appPage(c, { active: "settings", title: T.title, body, flash, status, back: "/app/settings/team" });
}
const TEAM_CSS = `.crumb{display:inline-flex;align-items:center;min-height:48px;font-weight:500}.lead{margin:0 0 8px}.mail{overflow-wrap:anywhere}
.rolef{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;margin:16px 0 0}.rolef .fld{flex:1 1 200px;margin:0}.rolef .btn{flex:0 0 auto}
.card .pick label{flex:1 1 160px}.ready input{width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px}`;

// Only the owner reaches anything here (GET or POST).
team.use("*", async (c, next) => {
  if (can(c.get("member"), "manage_team") !== "yes") return refused(c);
  await next();
});

team.get("/", (c) => {
  const code = FLASH[c.req.query("m") ?? ""];
  return teamPage(c, code ? (teamCopy(c.get("member").locale)[code] as string) : null);
});

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
  if (email.length > 254 || !EMAIL_RE.test(email)) return teamPage(c, teamCopy(me.locale).fBademail, 400);
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
  // No email and no redirect: the link is shown once, on this response, and never put in this page's own URL.
  const message = `${inviteText(hasOwnName(ws?.name) ? ws!.name : "the team", S.roles[role], email)}\n${link}`;
  const T = teamCopy(me.locale);
  const ready = html`<div class="card attention ready" role="status"><p>${T.linkReady(email)}</p>
<div class="acts"><a class="btn primary" href="https://wa.me/?text=${encodeURIComponent(message)}" rel="noopener noreferrer" target="_blank">${T.sendOnWhatsApp}</a></div>
<label class="fld"><span>${T.copyLabel}</span><input type="text" id="invite-link" readonly value="${link}"></label></div>`;
  return teamPage(c, null, 200, ready);
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

// The old owner becomes the role they chose (Practitioner by default, or Staff) in the same batch, and the new owner is promoted only if
// that demotion happened (changes() = 1).
// The one-owner index refuses the whole batch if two hand-overs race. If the new owner left in between, the demotion is put back.
team.post("/transfer", async (c) => {
  const me = c.get("member");
  const f = await form(c);
  if (f.csrf !== (await memberCsrf(c.get("jwt"), me, `team-transfer:${f.member}`))) return c.text("Forbidden", 403);
  const as = (f.as ?? AFTER_HANDOVER[0]) as Role;
  if (!AFTER_HANDOVER.includes(as)) return c.text("Bad request", 400);
  const m = await targetOf(c, f.member);
  if (m === "self") return back(c, "self");
  if (!m || m.status !== "active") return back(c, "gone");
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE members SET role = ?3 WHERE workspace_id = ?1 AND id = ?2 AND role = 'OWNER' AND status = 'active'").bind(WORKSPACE_ID, me.id, as),
      c.env.DB.prepare("UPDATE members SET role = 'OWNER' WHERE workspace_id = ?1 AND id = ?2 AND status = 'active' AND role != 'OWNER' AND changes() = 1").bind(WORKSPACE_ID, m.id),
      auditStmt(c, "ownership_transferred", `member:${m.id}`, `from member:${me.id}, now ${as}`),
    ]);
    if (!res[1].meta.changes) throw new Error("not changed");
  } catch {
    await c.env.DB.prepare(
      "UPDATE members SET role = 'OWNER' WHERE workspace_id = ?1 AND id = ?2 AND role = ?3 AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = ?1 AND role = 'OWNER' AND status != 'removed')",
    ).bind(WORKSPACE_ID, me.id, as).run();
    return back(c, "gone");
  }
  return c.redirect(`/app?m=${as === "STAFF" ? "transferred" : "transferred_p"}`, 303);
});

// 32 random bytes, URL-safe. Only its SHA-256 is stored.
function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
