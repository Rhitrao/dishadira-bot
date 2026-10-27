// "Ask owner" (docs/CONSOLE-PRD.md): a member whose role may only ask (staff, for refunds, blocks and money received outside Razorpay)
// creates a request; it waits on the owner's Today until they approve or decline it. Nothing happens before that.
// Approving runs the existing code for that kind (the one refund path in src/pay/refund.ts, the same block as /admin, and for money
// received outside Razorpay the paid-link booking code in src/pay/apply.ts, CONTRACT v6); both the decision and its effect are written
// to audit_log with the deciding member and the request's reason.
//
// Targets: REFUND and MARK_PAID name a payment ("payment:<id>"); a MARK_PAID from the Inbox's cash booking names its held call
// ("intro:<id>", which has no payment row yet); BLOCK names a conversation ("conv:<id>").
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { can, WORKSPACE_ID, type Action, type Member } from "./auth";
import { priceAt } from "./business";
import { rupees } from "./copy";
import type { Env } from "./env";
import { mailConfigured, sendEmail } from "./mail";
import { applyReceived, type Applied } from "./pay/apply";
import type { PaymentProvider } from "./pay/provider";
import { razorpay } from "./pay/razorpay";
import { approveRefund, declineRefund, requestRefund } from "./pay/refund";
import { iso } from "./slots";
import { getSetting } from "./switches";

export type RequestKind = "REFUND" | "MARK_PAID" | "BLOCK";
export const REQUEST_KINDS: readonly RequestKind[] = ["REFUND", "MARK_PAID", "BLOCK"];
export const isRequestKind = (v: unknown): v is RequestKind => typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);

// The permission row behind each kind: staff get "ask" there, the owner "yes".
export const REQUEST_ACTION: Record<RequestKind, Action> = { REFUND: "refund", MARK_PAID: "record_payment", BLOCK: "block" };

const TARGET: Record<RequestKind, RegExp> = { REFUND: /^payment:\d+$/, MARK_PAID: /^(payment|intro):\d+$/, BLOCK: /^conv:\d+$/ };
export const targetId = (target: string) => Number(/:(\d+)$/.exec(target)?.[1]);

export type RequestRow = {
  id: number; kind: RequestKind; target: string; amountPaise: number | null; askedBy: number; reason: string | null; createdAt: string;
  decidedBy: number | null; decision: "APPROVED" | "DECLINED" | null; decidedAt: string | null;
};
const COLS = `id, kind, target, amount_paise AS amountPaise, asked_by AS askedBy, reason, created_at AS createdAt,
  decided_by AS decidedBy, decision, decided_at AS decidedAt`;

// An audit row in the same batch as the change before it, written only if that change happened (SQLite's changes()).
const auditAfter = (env: Env, m: Member, action: string, target: string, detail: string, reason: string | null = null): D1PreparedStatement =>
  env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0").bind(
    m.email, action, target, detail, m.workspaceId, m.id, reason,
  );

// Asks the owner. Only a member whose permission for this kind is "ask" may (the owner does it directly; others can't at all).
// One open request per kind and target: a second ask while one waits changes nothing.
export async function createRequest(
  env: Env,
  asker: Member,
  r: { kind: RequestKind; target: string; amountPaise?: number | null; reason?: string | null },
): Promise<{ ok: true; id: number } | { ok: false; why: "NOT_ALLOWED" | "BAD_TARGET" | "EXISTS" }> {
  if (!isRequestKind(r.kind) || can(asker, REQUEST_ACTION[r.kind]) !== "ask") return { ok: false, why: "NOT_ALLOWED" };
  if (!TARGET[r.kind].test(r.target)) return { ok: false, why: "BAD_TARGET" };
  const reason = r.reason?.trim().slice(0, 200) || null;
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO requests (workspace_id, kind, target, amount_paise, asked_by, reason, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM requests WHERE workspace_id = ?1 AND kind = ?2 AND target = ?3 AND decided_at IS NULL)`,
    ).bind(asker.workspaceId, r.kind, r.target, r.amountPaise ?? null, asker.id, reason, iso(Date.now())),
    auditAfter(env, asker, "REQUEST_CREATED", r.target, r.kind, reason),
  ]);
  return ins.meta.changes ? { ok: true, id: ins.meta.last_row_id } : { ok: false, why: "EXISTS" };
}

export async function openRequests(env: Env, workspaceId = WORKSPACE_ID): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM requests WHERE workspace_id = ?1 AND decided_at IS NULL ORDER BY id`).bind(workspaceId).all<RequestRow>();
  return results;
}

export async function requestById(env: Env, id: number, workspaceId = WORKSPACE_ID): Promise<RequestRow | null> {
  return env.DB.prepare(`SELECT ${COLS} FROM requests WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, id).first<RequestRow>();
}

// What a decision did: DONE (the effect ran; for money received, the booking is confirmed), NOTHING (approved or declined, but there
// was nothing left to do, e.g. a refund already exists or the link was paid meanwhile), LATE (money received, but the held time was
// taken meanwhile: nothing was booked, and the owner is told, as for any late payment), ALREADY (someone decided it first),
// NOT_ALLOWED, GONE (no such open request), FAILED (the effect failed: the decision was put back, so it can be tried again).
export type Decided = "DONE" | "NOTHING" | "LATE" | "ALREADY" | "NOT_ALLOWED" | "GONE" | "FAILED";

// The block of /admin (src/admin.ts blockAction): the chat is BLOCKED and the number goes on the block list (once).
function blockStatements(env: Env, convId: number, by: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(convId),
    env.DB.prepare(
      "INSERT INTO blocks (wa_id, reason, by, created_at) SELECT wa_id, 'ADMIN', ?2, ?3 FROM conversations WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.wa_id = conversations.wa_id)",
    ).bind(convId, by, iso(Date.now())),
  ];
}

// Approve or decline one open request. The claim (decided_at set only if still open) comes first, with its audit row, so two owners
// or two tabs decide it once. Then the effect; if the effect throws, the claim is released and FAILED is returned.
export async function decideRequest(env: Env, provider: PaymentProvider, owner: Member, id: number, decision: "APPROVED" | "DECLINED"): Promise<Decided> {
  const r = await requestById(env, id, owner.workspaceId);
  if (!r) return "GONE";
  if (can(owner, REQUEST_ACTION[r.kind]) !== "yes") return "NOT_ALLOWED";
  if (r.decidedAt) return "ALREADY";
  const at = iso(Date.now());
  const [claim] = await env.DB.batch([
    env.DB.prepare("UPDATE requests SET decision = ?3, decided_by = ?4, decided_at = ?5 WHERE workspace_id = ?1 AND id = ?2 AND decided_at IS NULL").bind(owner.workspaceId, id, decision, owner.id, at),
    auditAfter(env, owner, decision === "APPROVED" ? "REQUEST_APPROVED" : "REQUEST_DECLINED", `request:${id}`, `${r.kind} ${r.target}`),
  ]);
  if (!claim.meta.changes) return "ALREADY";
  try {
    const result = await effect(env, provider, owner, r, decision);
    await env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(owner.email, `REQUEST_${r.kind}_${decision}`, r.target, `request:${id}: ${result}`, owner.workspaceId, owner.id, r.reason)
      .run();
    return result;
  } catch {
    await env.DB.prepare("UPDATE requests SET decision = NULL, decided_by = NULL, decided_at = NULL WHERE id = ?1 AND decided_at = ?2 AND decided_by = ?3").bind(id, at, owner.id).run();
    return "FAILED";
  }
}

async function effect(env: Env, provider: PaymentProvider, owner: Member, r: RequestRow, decision: "APPROVED" | "DECLINED"): Promise<Decided> {
  const tid = targetId(r.target);
  if (r.kind === "REFUND") {
    // A refund already waiting for approval (a rude caller's) moves on, or stays as declined; otherwise a new one, on the one refund path.
    const waiting = await env.DB.prepare("SELECT 1 AS x FROM refunds WHERE payment_id = ?1 AND state = 'PENDING_APPROVAL'").bind(tid).first();
    if (decision === "DECLINED") return waiting ? ((await declineRefund(env, tid)) ? "DONE" : "NOTHING") : "NOTHING";
    if (waiting) return (await approveRefund(env, provider, tid)) ? "DONE" : "NOTHING";
    const pay = await env.DB.prepare("SELECT state FROM payments WHERE id = ?1").bind(tid).first<{ state: string }>();
    if (!pay || !["PAID", "UNKNOWN"].includes(pay.state)) return "NOTHING";
    return (await requestRefund(env, provider, tid, "ADMIN", owner.email)) === "CREATED" ? "DONE" : "NOTHING";
  }
  if (r.kind === "BLOCK") {
    if (decision === "DECLINED") return "NOTHING";
    const res = await env.DB.batch(blockStatements(env, tid, owner.email));
    return res[0].meta.changes ? "DONE" : "NOTHING";
  }
  // MARK_PAID: approving confirms the booking (CONTRACT v6), on the same path as the owner's own record on the person's page.
  const intro = r.target.startsWith("intro:");
  if (decision === "DECLINED") return intro ? ((await releaseCashHold(env, tid)) ? "DONE" : "NOTHING") : "NOTHING";
  const res = intro ? await applyMoneyForIntro(env, tid, provider) : await applyMoneyReceived(env, tid, provider);
  return res === "BOOKED" ? "DONE" : res === "LATE_NO_SLOT" ? "LATE" : "NOTHING";
}

// ---------- money received outside Razorpay (cash or a direct UPI transfer) ----------
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";

// For a link that was sent and not paid: the payment becomes PAID and the booking (call, session or package credits) follows, with the
// customer's confirmation, exactly as for a paid link (src/pay/apply.ts). Only if nothing else is paid for the same booking, so the
// duplicate-payment refund (which goes to Razorpay) can never be set off by money Razorpay never had. Used by the owner's record on the
// person's page (src/people.ts) and by approving a staff member's request (above).
export async function applyMoneyReceived(env: Env, paymentId: number, provider: PaymentProvider = razorpay(env)): Promise<Applied | "NOT_OPEN"> {
  const pay = await env.DB.prepare(
    `SELECT p.provider_link_id AS linkId, p.state,
       (SELECT COUNT(*) FROM payments q WHERE q.purpose = p.purpose AND q.target_id = p.target_id AND q.state IN ${PAID_LIKE}) AS paidSiblings
     FROM payments p WHERE p.id = ?1`,
  )
    .bind(paymentId)
    .first<{ linkId: string | null; state: string; paidSiblings: number }>();
  if (!pay || !pay.linkId || !["PENDING", "FAILED"].includes(pay.state) || pay.paidSiblings > 0) return "NOT_OPEN";
  return applyReceived(env, provider, paymentId);
}

// The Inbox's cash booking: a held call with no payment row. One payment row (provider "manual", the call's price when it was held, so
// the amount check in src/pay/apply.ts agrees) is written once, then the same path as a paid link. If the 20-minute hold has lapsed,
// that path's late-payment rule applies: the same time is booked only if nobody else has it, otherwise nothing is booked, the call
// is closed and the owner is told (LATE_PAYMENT_NO_SLOT). Never a second booking of a time.
export async function applyMoneyForIntro(env: Env, introId: number, provider: PaymentProvider = razorpay(env)): Promise<Applied | "NOT_OPEN"> {
  const intro = await env.DB.prepare("SELECT state, created_at AS at FROM intros WHERE id = ?1").bind(introId).first<{ state: string; at: string }>();
  if (!intro || !["HELD", "EXPIRED"].includes(intro.state)) return "NOT_OPEN";
  const amount = await priceAt(env.DB, "intro", intro.at);
  const ins = await env.DB.prepare(
    `INSERT INTO payments (provider, purpose, target_id, amount_paise, state, created_at)
     SELECT 'manual', 'INTRO', ?1, ?2, 'PENDING', ?3 WHERE NOT EXISTS (SELECT 1 FROM payments WHERE purpose = 'INTRO' AND target_id = ?1 AND state != 'FAILED')`,
  )
    .bind(introId, amount, intro.at)
    .run();
  if (!ins.meta.changes) return "NOT_OPEN";
  return applyReceived(env, provider, ins.meta.last_row_id);
}

// Declining the Inbox's cash booking frees its held time at once (otherwise it would wait out the 20 minutes).
async function releaseCashHold(env: Env, introId: number): Promise<boolean> {
  const now = iso(Date.now());
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(introId, now),
    env.DB.prepare(
      "UPDATE slots SET hold_until = ?2 WHERE state = 'HELD' AND id = (SELECT slot_id FROM intros WHERE id = ?1) AND owner_id = (SELECT conversation_id FROM intros WHERE id = ?1) AND hold_until > ?2",
    ).bind(introId, now),
  ]);
  return res.meta.changes > 0;
}

// ---------- the bundled "ask owner" email (docs/CONSOLE-PRD.md, Notifications: "one email bundling the requests, within 30 minutes") ----------
// Every 2 minutes (the cron): when a request has come in since the last email, one email to the owner's alert address (DIGEST_TO, the
// verified one) lists every open request in plain words, at most once every MAIL_EVERY_MIN. The send time is claimed first in one
// settings row, like the other alerts, and put back if the email didn't go, so two cron runs never send twice. No customer names.
export const REQUESTS_MAIL_KEY = "alert:REQUESTS";
const MAIL_EVERY_MIN = 30;

function requestLine(r: RequestRow & { asker: string | null; last4: string | null }, nowMs: number): string {
  const amount = r.amountPaise ? rupees(r.amountPaise) : "";
  const whom = r.last4 ? ` for the customer whose number ends ${r.last4}` : "";
  const what =
    r.kind === "REFUND" ? `A refund${amount ? ` of ${amount}` : ""}${whom}` : r.kind === "BLOCK" ? `Block a number${r.last4 ? ` ending ${r.last4}` : ""}` : `Money received outside Razorpay${amount ? `: ${amount}` : ""}${whom}`;
  const min = Math.max(0, Math.round((nowMs - Date.parse(r.createdAt)) / 60_000));
  const ago = min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
  return `- ${what}. Asked by ${r.asker || "a team member"}, ${ago}.`;
}

export async function mailOpenRequests(env: Env, nowMs = Date.now()): Promise<boolean> {
  if (env.CONSOLE_V2 !== "true" || !mailConfigured(env)) return false;
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT r.id, r.kind, r.target, r.amount_paise AS amountPaise, r.asked_by AS askedBy, r.reason, r.created_at AS createdAt, NULL AS decidedBy, NULL AS decision, NULL AS decidedAt,
         NULLIF(m.display_name, '') AS asker,
         substr((SELECT c.wa_id FROM conversations c WHERE c.id = CASE
           WHEN r.target LIKE 'conv:%' THEN CAST(substr(r.target, 6) AS INTEGER)
           WHEN r.target LIKE 'intro:%' THEN (SELECT conversation_id FROM intros WHERE id = CAST(substr(r.target, 7) AS INTEGER))
           ELSE (SELECT CASE p.purpose WHEN 'INTRO' THEN (SELECT conversation_id FROM intros WHERE id = p.target_id)
                   WHEN 'SESSION' THEN (SELECT conversation_id FROM sessions WHERE id = p.target_id)
                   ELSE (SELECT conversation_id FROM packages WHERE id = p.target_id) END FROM payments p WHERE p.id = CAST(substr(r.target, 9) AS INTEGER)) END), -4) AS last4
       FROM requests r LEFT JOIN members m ON m.id = r.asked_by WHERE r.workspace_id = ?1 AND r.decided_at IS NULL ORDER BY r.id`,
    )
    .bind(WORKSPACE_ID)
    .all<RequestRow & { asker: string | null; last4: string | null }>();
  if (!results.length) return false;
  const last = await getSetting(db, REQUESTS_MAIL_KEY);
  if (last && !results.some((r) => r.createdAt > last)) return false; // every open request was in an earlier email
  const now = iso(nowMs);
  const claim = await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE settings.value <= ?3",
    )
    .bind(REQUESTS_MAIL_KEY, now, iso(nowMs - MAIL_EVERY_MIN * 60_000))
    .run();
  if (!claim.meta.changes) return false;
  const n = results.length;
  const body = [
    `${n === 1 ? "1 request is" : `${n} requests are`} waiting for your approval:`,
    "",
    ...results.map((r) => requestLine(r, nowMs)),
    "",
    "Nothing happens until you approve or decline. Each one is on Today, with Approve and Decline.",
    `Open ${env.PUBLIC_URL ?? ""}/app`,
  ].join("\n");
  const sent = await sendEmail(env, n === 1 ? "Waiting for your approval: 1 request" : `Waiting for your approval: ${n} requests`, body);
  if (sent === "SENT") return true;
  // Not sent: the claim is put back, so the next run tries again.
  if (last) await db.prepare("UPDATE settings SET value = ?2 WHERE key = ?1 AND value = ?3").bind(REQUESTS_MAIL_KEY, last, now).run();
  else await db.prepare("DELETE FROM settings WHERE key = ?1 AND value = ?2").bind(REQUESTS_MAIL_KEY, now).run();
  return false;
}
