// "Talk to a person": the chat goes to HUMAN mode, Rohit gets one open item and one email (docs/AGENT.md section 3.2 step 6).
// The email says where to look and never what was written. Used by the button and words, and by the assistant when it hands over.
// Ticket 36: also when someone at the time step twice in a row types something the bot can't book (why = "time"), and the team's
// "Take over this chat" (takeOverStmt, below), which changes the mode the same way but sends nothing and raises nothing.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Env } from "./env";
import { sendEmail } from "./mail";
import { consoleLink } from "./switchover";
import { raiseAttention } from "./send";
import { iso } from "./slots";
import { clearStep } from "./steps";

const HOUR = 3_600_000;

export type HandoffWhy = "asked" | "time";
const MAIL: Record<HandoffWhy, { subject: string; body: string }> = {
  asked: { subject: "A customer asked for a person", body: "A customer asked to talk to a person." },
  time: { subject: "A customer needs help choosing a time", body: "A customer could not pick a call time from the list, twice in a row, so the bot passed the chat to the team." },
};

export async function requestHuman(env: Env, convId: number, nowMs = Date.now(), why: HandoffWhy = "asked"): Promise<void> {
  const db = env.DB;
  await clearStep(db, convId);
  await db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE id = ?1 AND mode = 'BOT'").bind(convId, iso(nowMs)).run();
  const opened = await raiseAttention(db, "HUMAN_REQUEST", `conv:${convId}`); // at most one open item per person
  if (!opened) return;
  // At most one email per person per 6 hours: the claim is one conditional update.
  const claim = await db
    .prepare("UPDATE person_state SET human_mail_at = ?2 WHERE conversation_id = ?1 AND (human_mail_at IS NULL OR human_mail_at <= ?3)")
    .bind(convId, iso(nowMs), iso(nowMs - config.handoff.mailEveryHours * HOUR))
    .run();
  if (claim.meta.changes) await sendEmail(env, MAIL[why].subject, `${MAIL[why].body} Open ${consoleLink(env, `/admin/conv/${convId}`, `/app/inbox/${convId}`)}`);
}

// Ticket 36: the team takes over a chat the bot is handling (the person page in /app, or /admin/conv/<id>). BOT -> HUMAN with human_since
// now, exactly as above, and the open booking step closes, so the bot stays quiet and the chat is in the Inbox. Nothing is sent to the
// customer and no item or email is raised: whoever took it is already there. Never for a blocked number. `memberId`: the console member,
// who is also given the chat ("Assign to me"). One statement, so the caller can batch it with its audit row (written only if this changed).
export const takeOverStmt = (db: D1Database, convId: number, nowMs = Date.now(), memberId: number | null = null) =>
  db
    .prepare(
      `UPDATE conversations SET mode = 'HUMAN', human_since = ?2, pending_step = NULL, pending_out = NULL, pending_until = NULL, pending_reprompts = 0,
         claimed_by = COALESCE(?3, claimed_by), claimed_at = CASE WHEN ?3 IS NULL THEN claimed_at ELSE ?2 END
       WHERE id = ?1 AND mode = 'BOT' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.wa_id = conversations.wa_id)`,
    )
    .bind(convId, iso(nowMs), memberId);
