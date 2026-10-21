// "Talk to a person": the chat goes to HUMAN mode, Rohit gets one open item and one email (docs/AGENT.md section 3.2 step 6).
// The email says where to look and never what was written. Used by the button and words, and by the assistant when it hands over.
import { config } from "./config";
import type { Env } from "./env";
import { sendEmail } from "./mail";
import { raiseAttention } from "./send";
import { iso } from "./slots";
import { clearStep } from "./steps";

const HOUR = 3_600_000;

export async function requestHuman(env: Env, convId: number, nowMs = Date.now()): Promise<void> {
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
  if (claim.meta.changes) await sendEmail(env, "A customer asked for a person", `A customer asked to talk to a person. Open ${env.PUBLIC_URL ?? ""}/admin/conv/${convId}`);
}
