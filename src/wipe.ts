// Privacy clean-up, on the 2-minute cron. Both jobs are safe to run again and again.
//  - Chat text: CHAT_RETENTION_MINUTES after a person's last message (live 10080 = 7 days, test 10) every message body of that conversation
//    (what they wrote and what we sent) is blanked, and the Meta id of any photo or file they sent (ticket 38) with it. The rows stay: dedupe keys, payments, bookings, credits, blocks and audit are untouched,
//    and what the code needs later (greeted, language, age check, last acknowledgement, media notice day) lives on `conversations` / `person_state`.
//  - Names: removed config.retention.nameDaysAfterLastBooking days after the person's last booking (or, with no booking, after their last message).
import { config } from "./config";
import type { Env } from "./env";
import { iso } from "./slots";

const DAY = 86_400_000;

export const retentionMinutes = (env: Env): number => {
  const n = Number(env.CHAT_RETENTION_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : config.retention.defaultMinutes;
};

export async function wipeChats(env: Env, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - retentionMinutes(env) * 60_000);
  const res = await env.DB
    .prepare(
      `UPDATE messages SET body = NULL, media_id = NULL, media_mime = NULL, wiped_at = ?1 WHERE (body IS NOT NULL OR media_id IS NOT NULL)
         AND conversation_id IN (SELECT id FROM conversations WHERE last_user_at < ?2)`,
    )
    .bind(iso(nowMs), cutoff)
    .run();
  // Ticket 47: the chat's gist is made from its text, so it goes with it (notes are the practice's record and stay).
  await env.DB.prepare("DELETE FROM gists WHERE conversation_id IN (SELECT id FROM conversations WHERE last_user_at < ?1)").bind(cutoff).run();
  await removeOldNames(env, nowMs);
  return res.meta.changes;
}

// Ticket 41: the work and the area they gave after paying for the call (intros.profession, help_area) go with the name, and so does the mark
// that they typed the name themselves (name_given_at), so their WhatsApp name is used again if they write later.
const OLD = "COALESCE((SELECT MAX(s.end_utc) FROM slots s WHERE s.owner_id = conversations.id AND s.state = 'BOOKED'), last_user_at, created_at) < ?1";
export async function removeOldNames(env: Env, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - config.retention.nameDaysAfterLastBooking * DAY);
  const [res] = await env.DB.batch([
    env.DB.prepare(`UPDATE conversations SET display_name = NULL, name_given_at = NULL WHERE (display_name IS NOT NULL OR name_given_at IS NOT NULL) AND ${OLD}`).bind(cutoff),
    env.DB
      .prepare(`UPDATE intros SET profession = NULL, help_area = NULL WHERE (profession IS NOT NULL OR help_area IS NOT NULL) AND conversation_id IN (SELECT id FROM conversations WHERE ${OLD})`)
      .bind(cutoff),
  ]);
  return res.meta.changes;
}

// One person's data, now, when the owner removes it (People → Remove their data): every message text and their name, by the same rule
// as the timed wipe above (and the first-message question kept for the bot's reply). Bookings, payments, refunds, credits, blocks, dedupe
// keys and the audit log stay, as the law requires. Ticket 47: the team's notes about them and the chat's gist go too.
// Returned unrun, so the caller batches them with the audit row.
export const wipePersonStmts = (db: Env["DB"], convId: number, nowIso: string) => [
  db.prepare("UPDATE messages SET body = NULL, media_id = NULL, media_mime = NULL, wiped_at = ?2 WHERE conversation_id = ?1 AND (body IS NOT NULL OR media_id IS NOT NULL)").bind(convId, nowIso),
  db.prepare("UPDATE conversations SET display_name = NULL, name_given_at = NULL, first_question_msg = NULL WHERE id = ?1").bind(convId),
  db.prepare("UPDATE intros SET profession = NULL, help_area = NULL WHERE conversation_id = ?1 AND (profession IS NOT NULL OR help_area IS NOT NULL)").bind(convId),
  db.prepare("DELETE FROM notes WHERE conversation_id = ?1").bind(convId),
  db.prepare("DELETE FROM gists WHERE conversation_id = ?1").bind(convId),
];
