// Sign-in, members and the one permission check. Identity comes from Cloudflare Access (the Worker verifies the JWT itself);
// membership is the gate: a verified email with no active membership gets "No access" and nothing else.
// Every console route and every button asks can(member, action, target), so a hidden button and a refused POST always agree.
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { iso, PRACTITIONER_SQL } from "./slots";

export type Role = "OWNER" | "PRACTITIONER" | "STAFF";
export const ROLES: readonly Role[] = ["OWNER", "PRACTITIONER", "STAFF"];
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export type Member = { id: number; workspaceId: number; email: string; displayName: string | null; role: Role; locale: string; status: string };

// Phase 1 has one workspace; Phase 3 picks one after sign-in.
export const WORKSPACE_ID = 1;

// ---- the Access JWT ----
const teamHost = (team: string) => (team.includes(".") ? team : `${team}.cloudflareaccess.com`);
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const keysFor = (host: string) => {
  let k = keySets.get(host);
  if (!k) keySets.set(host, (k = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`))));
  return k;
};

// Signature, audience, issuer and expiry; then the email, lower-cased. Any verified email passes here: membership decides the rest.
export async function verifiedEmail(env: Env, token: string | undefined): Promise<string | null> {
  if (!token || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  try {
    const host = teamHost(env.ACCESS_TEAM);
    const { payload } = await jwtVerify(token, keysFor(host), { audience: env.ACCESS_AUD, issuer: `https://${host}` });
    return typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

// CSRF token per form: SHA-256 of the form's scope + the visitor's own Access JWT (unknown to other sites). No extra secret.
export async function csrf(jwt: string, scope: string): Promise<string> {
  return sha256Hex(`csrf|${scope}|${jwt}`);
}

// A console form's token also names the member and their role, so a removed member's or a changed role's open forms fail.
export const memberCsrf = (jwt: string, m: Member, scope: string) => csrf(jwt, `${m.id}:${m.role}:${scope}`);

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- members ----
const MEMBER_COLS = "id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status";

export async function activeMember(env: Env, email: string, workspaceId = WORKSPACE_ID): Promise<Member | null> {
  return env.DB.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE workspace_id = ?1 AND email = ?2 AND status = 'active'`).bind(workspaceId, email).first<Member>();
}

export async function memberById(env: Env, id: number, workspaceId = WORKSPACE_ID): Promise<Member | null> {
  return env.DB.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, id).first<Member>();
}

export async function listMembers(env: Env, workspaceId = WORKSPACE_ID): Promise<(Member & { lastSeenAt: string | null })[]> {
  const { results } = await env.DB
    .prepare(`SELECT ${MEMBER_COLS}, last_seen_at AS lastSeenAt FROM members WHERE workspace_id = ?1 AND status != 'removed' ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'PRACTITIONER' THEN 1 ELSE 2 END, id`)
    .bind(workspaceId)
    .all<Member & { lastSeenAt: string | null }>();
  return results;
}

// Written at most every 5 minutes per member, so a page load is not always a write.
export async function touchMember(env: Env, m: Member, nowMs = Date.now()): Promise<void> {
  await env.DB
    .prepare("UPDATE members SET last_seen_at = ?2 WHERE id = ?1 AND (last_seen_at IS NULL OR last_seen_at < ?3)")
    .bind(m.id, iso(nowMs), iso(nowMs - 5 * 60_000))
    .run();
}

// One-time seed, on the first request while `members` is empty: the two sign-in emails of before roles become the owner and the
// practitioner, and every existing call, session and slot points to that practitioner. Each statement is guarded, so two first
// requests at once seed once. ROHIT_EMAIL / AMMA_EMAIL are read here and nowhere else in the console.
export async function seedMembers(env: Env): Promise<boolean> {
  const owner = env.ROHIT_EMAIL?.trim().toLowerCase();
  if (!owner) return false;
  const empty = await env.DB.prepare("SELECT 1 AS x FROM members LIMIT 1").first();
  if (empty) return false;
  const practitioner = env.AMMA_EMAIL?.trim().toLowerCase();
  const ws = WORKSPACE_ID;
  const pid = PRACTITIONER_SQL;
  const stmts = [
    env.DB.prepare("INSERT INTO members (workspace_id, email, role, status) SELECT ?1, ?2, 'OWNER', 'active' WHERE NOT EXISTS (SELECT 1 FROM members)").bind(ws, owner),
  ];
  if (practitioner && practitioner !== owner) {
    stmts.push(
      env.DB.prepare("INSERT INTO members (workspace_id, email, role, status) SELECT ?1, ?2, 'PRACTITIONER', 'active' WHERE (SELECT COUNT(*) FROM members) = 1").bind(ws, practitioner),
      env.DB.prepare(`UPDATE slots SET practitioner_id = ${pid} WHERE practitioner_id IS NULL`),
      env.DB.prepare(`UPDATE intros SET practitioner_id = ${pid} WHERE practitioner_id IS NULL`),
      env.DB.prepare(`UPDATE sessions SET practitioner_id = ${pid} WHERE practitioner_id IS NULL`),
    );
  }
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) return false;
  await env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id) VALUES ('system', 'members_seeded', 'workspace:1', ?1, ?2)")
    .bind(practitioner && practitioner !== owner ? "owner and practitioner" : "owner", ws)
    .run();
  return true;
}

// ---- the permission table (docs/CONSOLE-PRD.md, "Users, roles and permissions"), one row per action ----
// yes | no | ask: as written. own: only for the practitioner's own calls, sessions and customers (target.practitionerId).
// own-call-window: own, and only from 1 hour before the call starts to 1 hour after it ends. not-safety: yes, except safety messages.
export type Decision = "yes" | "no" | "ask";
type Cell = Decision | "own" | "own-call-window" | "not-safety";

export const PERMISSIONS = {
  view_today: { OWNER: "yes", PRACTITIONER: "own", STAFF: "yes" }, // See Today (staff: inbox and bookings)
  view_calendar: { OWNER: "yes", PRACTITIONER: "own", STAFF: "yes" }, // See the calendar
  set_hours: { OWNER: "yes", PRACTITIONER: "own", STAFF: "no" }, // Set working hours and block time off
  mark_outcome: { OWNER: "yes", PRACTITIONER: "own", STAFF: "no" }, // Mark a call outcome, offer a session
  reply_chat: { OWNER: "yes", PRACTITIONER: "no", STAFF: "yes" }, // Reply to a handed-over chat
  reveal_phone: { OWNER: "yes", PRACTITIONER: "own-call-window", STAFF: "no" }, // See a customer's full phone number (always logged)
  read_chat: { OWNER: "yes", PRACTITIONER: "own", STAFF: "not-safety" }, // Read a customer's chat
  move_booking: { OWNER: "yes", PRACTITIONER: "own", STAFF: "yes" }, // Move or cancel a booking
  record_payment: { OWNER: "yes", PRACTITIONER: "no", STAFF: "ask" }, // Record money received outside Razorpay
  refund: { OWNER: "yes", PRACTITIONER: "no", STAFF: "ask" }, // Refund
  block: { OWNER: "yes", PRACTITIONER: "no", STAFF: "ask" }, // Block or unblock a number
  see_money: { OWNER: "yes", PRACTITIONER: "no", STAFF: "no" }, // See payment totals and export
  business_settings: { OWNER: "yes", PRACTITIONER: "no", STAFF: "no" }, // Prices, hours, bot switches, payment keys
  manage_team: { OWNER: "yes", PRACTITIONER: "no", STAFF: "no" }, // Invite, change roles, remove members
  read_audit: { OWNER: "yes", PRACTITIONER: "no", STAFF: "no" }, // Read the audit log
  // Not a row of the PRD table: the People screen, from "a practitioner sees only customers booked with them".
  view_people: { OWNER: "yes", PRACTITIONER: "own", STAFF: "yes" },
} as const satisfies Record<string, Record<Role, Cell>>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

// What the action is about. practitionerId: whose call, session or customer it is. callStartMs/callEndMs: for a reveal.
// safety: the chat or message is a safety (crisis or emergency) one.
export type Target = { practitionerId?: number | null; callStartMs?: number; callEndMs?: number; safety?: boolean; nowMs?: number };

const HOUR = 3_600_000;

export function can(member: Member | null | undefined, action: Action, target?: Target): Decision {
  if (!member || member.status !== "active" || !isRole(member.role)) return "no";
  const cell: Cell = PERMISSIONS[action][member.role];
  if (cell === "yes" || cell === "no" || cell === "ask") return cell;
  if (cell === "not-safety") return target && !target.safety ? "yes" : "no";
  // "own" cells need a target that names this member; no target means no (use canAny for tabs and screens).
  const own = target?.practitionerId != null && target.practitionerId === member.id;
  if (cell === "own") return own ? "yes" : "no";
  const now = target?.nowMs ?? Date.now();
  const start = target?.callStartMs;
  const end = target?.callEndMs ?? start;
  return own && start != null && end != null && now >= start - HOUR && now <= end + HOUR ? "yes" : "no";
}

// Whether the member may do this to anything at all (their own items included): for tabs and screens, never for a change.
export function canAny(member: Member | null | undefined, action: Action): boolean {
  if (!member || member.status !== "active" || !isRole(member.role)) return false;
  return PERMISSIONS[action][member.role] !== "no";
}
