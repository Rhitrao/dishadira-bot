// Privacy clean-up, on the 2-minute cron. Both jobs are safe to run again and again.
//  - Chat text: CHAT_RETENTION_MINUTES after a person's last message (live 10080 = 7 days, test 10) every message body of that conversation
//    (what they wrote and what we sent) is blanked. The rows stay: dedupe keys, payments, bookings, credits, blocks and audit are untouched,
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
    .prepare("UPDATE messages SET body = NULL, wiped_at = ?1 WHERE body IS NOT NULL AND conversation_id IN (SELECT id FROM conversations WHERE last_user_at < ?2)")
    .bind(iso(nowMs), cutoff)
    .run();
  await removeOldNames(env, nowMs);
  return res.meta.changes;
}

export async function removeOldNames(env: Env, nowMs = Date.now()): Promise<number> {
  const cutoff = iso(nowMs - config.retention.nameDaysAfterLastBooking * DAY);
  const res = await env.DB
    .prepare(
      `UPDATE conversations SET display_name = NULL WHERE display_name IS NOT NULL
         AND COALESCE((SELECT MAX(s.end_utc) FROM slots s WHERE s.owner_id = conversations.id AND s.state = 'BOOKED'), last_user_at, created_at) < ?1`,
    )
    .bind(cutoff)
    .run();
  return res.meta.changes;
}
