// Noise: strikes, quiet periods and blocks (docs/AGENT.md section 4), the per-person state behind them, and the AI budget counters.
// Labels come from the rule-based classifier now (src/gate.ts) and from the AI in ticket 14; applyLabel() treats both the same.
// Paying customers are never filtered. Message text is only compared with config word lists; it is never stored here or logged.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor } from "./copy";
import type { Env } from "./env";
import { botAudit, hasPhrase, runCrisis, runEmergency } from "./safety";
import { sendMessage, type Out } from "./send";
import { iso, istDay } from "./slots";

export const LABELS = [
  "relevant_question", "personal_concern", "objection", "booking_intent", "existing_booking", "human_request",
  "smalltalk", "off_topic", "astrology_or_prediction", "prohibited_request", "loop", "spam_or_promo", "flirt_or_sexual", "abuse",
  "crisis", "medical_emergency",
] as const;
export type Label = (typeof LABELS)[number];

const DAY = 86_400_000;

export const ensureState = (db: D1Database, convId: number) => db.prepare("INSERT OR IGNORE INTO person_state (conversation_id) VALUES (?1)").bind(convId).run();

export type PersonState = {
  strikes: number;
  lastStrikeAt: string | null;
  quietUntil: string | null;
  quietCount30d: number;
  lastQuietAt: string | null;
  smalltalkDay: string | null;
  smalltalkCount: number;
  aiDay: string | null;
  aiCount: number;
  mediaNoticeDay: string | null;
  noSellUntil: string | null;
  aiCrisisDay: string | null;
  optedOutAt: string | null;
  bookTapAt: string | null;
};

// A person with no row yet has the defaults.
export async function personState(db: D1Database, convId: number): Promise<PersonState> {
  const row = await db
    .prepare(
      `SELECT strikes, last_strike_at AS lastStrikeAt, quiet_until AS quietUntil, quiet_count_30d AS quietCount30d, last_quiet_at AS lastQuietAt,
         smalltalk_day AS smalltalkDay, smalltalk_count AS smalltalkCount, ai_day AS aiDay, ai_count AS aiCount, media_notice_day AS mediaNoticeDay,
         no_sell_until AS noSellUntil, ai_crisis_day AS aiCrisisDay, opted_out_at AS optedOutAt, book_tap_at AS bookTapAt
       FROM person_state WHERE conversation_id = ?1`,
    )
    .bind(convId)
    .first<PersonState>();
  return (
    row ?? {
      strikes: 0, lastStrikeAt: null, quietUntil: null, quietCount30d: 0, lastQuietAt: null, smalltalkDay: null, smalltalkCount: 0, aiDay: null, aiCount: 0,
      mediaNoticeDay: null, noSellUntil: null, aiCrisisDay: null, optedOutAt: null, bookTapAt: null,
    }
  );
}

export const quietActive = (st: PersonState, nowMs: number) => st.quietUntil !== null && Date.parse(st.quietUntil) > nowMs;
export const noSellActiveFor = (st: PersonState, nowMs: number) => st.noSellUntil !== null && Date.parse(st.noSellUntil) > nowMs;
export async function noSellActive(db: D1Database, convId: number, nowMs = Date.now()): Promise<boolean> {
  return noSellActiveFor(await personState(db, convId), nowMs);
}

// A paying customer: a PAID, CONFIRMED or RESCHEDULED call or session, or a PAID payment, in the last 30 days. A hold alone does not count.
export async function isPayingCustomer(db: D1Database, convId: number, nowMs = Date.now()): Promise<boolean> {
  const since = iso(nowMs - config.noise.payingCustomerDays * DAY);
  const row = await db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM intros WHERE conversation_id = ?1 AND state IN ('PAID', 'CONFIRMED', 'RESCHEDULED') AND COALESCE(updated_at, created_at) >= ?2)
         OR EXISTS (SELECT 1 FROM sessions WHERE conversation_id = ?1 AND state IN ('PAID', 'CONFIRMED', 'RESCHEDULED') AND COALESCE(updated_at, created_at) >= ?2)
         OR EXISTS (SELECT 1 FROM payments p WHERE p.state = 'PAID' AND COALESCE(p.updated_at, p.created_at) >= ?2 AND (
              (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = ?1))
              OR (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = ?1))))`,
    )
    .bind(convId, since)
    .first();
  return row !== null;
}

// A payment clears the slate: strikes, a quiet period and the "second offence" counters.
export async function paymentCleared(db: D1Database, convId: number): Promise<void> {
  await db
    .prepare("UPDATE person_state SET strikes = 0, last_strike_at = NULL, quiet_until = NULL, flirt_offences = 0, abuse_offences = 0 WHERE conversation_id = ?1")
    .bind(convId)
    .run();
}

// ---- AI budgets (counted per India day; ticket 14 spends them) ----
export const dailyCap = (paying: boolean) => (paying ? config.ai.aiRepliesPerPayingCustomerPerDay : config.ai.aiRepliesPerPersonPerDay);

export async function budgetUsedUp(db: D1Database, convId: number, paying: boolean, nowMs = Date.now()): Promise<boolean> {
  const day = istDay(nowMs);
  const st = await personState(db, convId);
  if (st.aiDay === day && st.aiCount >= dailyCap(paying)) return true;
  const total = await db.prepare("SELECT COALESCE(SUM(ai_count), 0) AS n FROM person_state WHERE ai_day = ?1").bind(day).first<{ n: number }>();
  return (total?.n ?? 0) >= config.ai.aiRepliesPerDayTotal;
}

export async function recordAiReply(db: D1Database, convId: number, nowMs = Date.now()): Promise<void> {
  await ensureState(db, convId);
  const day = istDay(nowMs);
  await db
    .prepare("UPDATE person_state SET ai_count = CASE WHEN ai_day = ?2 THEN ai_count + 1 ELSE 1 END, ai_day = ?2 WHERE conversation_id = ?1")
    .bind(convId, day)
    .run();
}

// ---- strikes, quiet, blocks ----
export type NoiseConv = { id: number; wa_id: string; locale: string; consent_at: string | null };
export type Apply = { stop: boolean }; // stop: nothing more is sent for this message (no reply, a closing line, or a block)
type Say = (out: Out, step: string) => Promise<unknown>;

export async function blockPerson(db: D1Database, conv: NoiseConv, reason: "NOISE_ABUSE" | "NOISE_SEXUAL" | "NOISE_REPEAT"): Promise<void> {
  await db.prepare("INSERT INTO blocks (wa_id, reason, by) SELECT ?1, ?2, 'system' WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)").bind(conv.wa_id, reason).run();
  await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
  await botAudit(db, "BLOCK", `conv:${conv.id}`, reason);
}

// A strike counts from 1 again when the last one is more than a week old.
async function addStrike(db: D1Database, convId: number, nowMs: number): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE person_state SET strikes = CASE WHEN last_strike_at IS NULL OR last_strike_at < ?2 THEN 1 ELSE strikes + 1 END, last_strike_at = ?3
       WHERE conversation_id = ?1 RETURNING strikes`,
    )
    .bind(convId, iso(nowMs - config.noise.strikeClearDays * DAY), iso(nowMs))
    .first<{ strikes: number }>();
  return row?.strikes ?? 1;
}

// Third strike: the closing line and a quiet week; a second quiet period within 30 days is a block instead.
async function startQuiet(db: D1Database, conv: NoiseConv, nowMs: number, say: Say): Promise<void> {
  const st = await personState(db, conv.id);
  const recent = st.lastQuietAt !== null && nowMs - Date.parse(st.lastQuietAt) < config.noise.repeatQuietDays * DAY;
  const n = (recent ? st.quietCount30d : 0) + 1;
  await db.prepare("UPDATE person_state SET quiet_count_30d = ?2, last_quiet_at = ?3, strikes = 0 WHERE conversation_id = ?1").bind(conv.id, n, iso(nowMs)).run();
  if (n >= 2) {
    await blockPerson(db, conv, "NOISE_REPEAT");
    return;
  }
  await db.prepare("UPDATE person_state SET quiet_until = ?2 WHERE conversation_id = ?1").bind(conv.id, iso(nowMs + config.noise.quietDays * DAY)).run();
  await botAudit(db, "QUIET", `conv:${conv.id}`);
  await say({ type: "text", text: copyFor(conv.locale).quietClose }, "quiet");
}

const STRIKE_ONLY: Label[] = ["off_topic", "astrology_or_prediction", "prohibited_request", "loop"];

// Applies what a label means (AGENT.md section 4). It sends only fixed lines (the flirting line, the closing line); a reply written by the AI is
// the caller's to send when `stop` is false. Paying customers get no strikes, quiet period or block.
export async function applyLabel(env: Env, conv: NoiseConv, label: Label, text: string, o: { msgId: string; say?: Say; nowMs?: number }): Promise<Apply> {
  const db = env.DB;
  const nowMs = o.nowMs ?? Date.now();
  const say: Say = o.say ?? ((out, step) => sendMessage(env, conv.id, out, `${o.msgId}:${step}`));

  if (label === "crisis") {
    // Only the AI gets here (no phrase matched): the fixed message, at most once per person per India day. The AI's own words are never sent.
    await ensureState(db, conv.id);
    const claim = await db.prepare("UPDATE person_state SET ai_crisis_day = ?2 WHERE conversation_id = ?1 AND (ai_crisis_day IS NULL OR ai_crisis_day != ?2)").bind(conv.id, istDay(nowMs)).run();
    if (claim.meta.changes) await runCrisis(env, conv, o.msgId, text);
    return { stop: true };
  }
  if (label === "medical_emergency") {
    await runEmergency(env, conv, o.msgId, text);
    return { stop: true };
  }
  const strikes = label === "smalltalk" || label === "spam_or_promo" || label === "flirt_or_sexual" || label === "abuse" || STRIKE_ONLY.includes(label);
  if (!strikes) return { stop: false };
  if (await isPayingCustomer(db, conv.id, nowMs)) return { stop: false };
  await ensureState(db, conv.id);

  if (label === "smalltalk") {
    // The first two a day are free.
    const row = await db
      .prepare("UPDATE person_state SET smalltalk_count = CASE WHEN smalltalk_day = ?2 THEN smalltalk_count + 1 ELSE 1 END, smalltalk_day = ?2 WHERE conversation_id = ?1 RETURNING smalltalk_count AS n")
      .bind(conv.id, istDay(nowMs))
      .first<{ n: number }>();
    if ((row?.n ?? 1) <= config.noise.smalltalkFreePerDay) return { stop: false };
  }

  if (label === "flirt_or_sexual" || label === "abuse") {
    // Blocked on a code-list word, or on a second offence.
    const col = label === "abuse" ? "abuse_offences" : "flirt_offences";
    const row = await db.prepare(`UPDATE person_state SET ${col} = ${col} + 1 WHERE conversation_id = ?1 RETURNING ${col} AS n`).bind(conv.id).first<{ n: number }>();
    const words = label === "abuse" ? config.noise.abuseBlockWords : config.noise.sexualBlockWords;
    if (hasPhrase(text, words) || (row?.n ?? 1) >= 2) {
      await blockPerson(db, conv, label === "abuse" ? "NOISE_ABUSE" : "NOISE_SEXUAL");
      return { stop: true };
    }
  }

  const count = await addStrike(db, conv.id, nowMs);
  if (count >= config.noise.strikesToQuiet) {
    await startQuiet(db, conv, nowMs, say);
    return { stop: true };
  }
  if (label === "flirt_or_sexual") {
    await say({ type: "text", text: copyFor(conv.locale).flirtLine }, "flirt");
    return { stop: true };
  }
  return { stop: label === "spam_or_promo" || label === "abuse" }; // no reply for those; the others get the AI's line
}
