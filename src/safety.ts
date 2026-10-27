// Safety, always first: crisis and medical-emergency phrases are found by code (never the AI) in every typed message, and answered with the
// fixed messages (docs/KNOWLEDGE.md section 9), to everyone: blocked, quiet, in HUMAN mode, over budget, a first-ever message.
// The phrase lists are in config.safety. Message text never goes into a log, an email or an audit row.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor, langOf, type Lang } from "./copy";
import type { Env } from "./env";
import { recipients } from "./business";
import { sendEmailToEach } from "./mail";
import { sendMessage } from "./send";
import { iso } from "./slots";

// Lower case, NFC, no nukta (़), ँ read as ं, punctuation and emoji gone, one space between words.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/़/g, "")
    .replace(/ँ/g, "ं")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const phraseCache = new WeakMap<readonly string[], string[]>();
const phrases = (list: readonly string[]): string[] => {
  let hit = phraseCache.get(list);
  if (!hit) phraseCache.set(list, (hit = list.map(normalize).filter(Boolean)));
  return hit;
};

// Whole words or phrases only: "mar jaana chahta hoon" contains "mar jaana chahta", "keystroke" does not contain "stroke".
export function hasPhrase(text: string, list: readonly string[]): boolean {
  const padded = ` ${normalize(text)} `;
  return phrases(list).some((p) => padded.includes(` ${p} `));
}

export type Safety = "CRISIS" | "EMERGENCY";
export function detectSafety(text: string): Safety | null {
  if (hasPhrase(text, config.safety.crisis)) return "CRISIS"; // when both match, the crisis message (which also has 112) goes
  if (hasPhrase(text, config.safety.emergency)) return "EMERGENCY";
  return null;
}

const nowIso = () => iso(Date.now());
const hasDevanagari = (text: string | null) => text !== null && /[ऀ-ॿ]/.test(text);

type SafetyConv = { id: number; locale: string; consent_at: string | null };

// Devanagari in the text: Hindi. Otherwise the language the person chose; before they have chosen (or on a first-ever message): English.
export const safetyLang = (conv: SafetyConv, text: string | null): Lang => (hasDevanagari(text) ? "hi" : conv.consent_at ? langOf(conv.locale) : "en");

// Audit rows by the bot: an action and a target only, never any text.
export async function botAudit(db: D1Database, action: string, target: string, detail = ""): Promise<void> {
  await db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?4, 'bot', ?1, ?2, ?3)").bind(action, target, detail, nowIso()).run();
}

// The person was spoken to by code, so the bot's own greeting must not follow: mark the chat as greeted.
const markGreeted = (db: D1Database, convId: number) => db.prepare("UPDATE conversations SET greeted_at = COALESCE(greeted_at, ?2) WHERE id = ?1").bind(convId, nowIso()).run();

export async function runCrisis(env: Env, conv: SafetyConv, msgId: string, text: string | null): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  await sendMessage(env, conv.id, { type: "text", text: copyFor(safetyLang(conv, text)).crisis }, `${msgId}:crisis`, { safety: true });
  // A person takes over (a blocked chat stays blocked), and nothing is sold for a week.
  await db.prepare("UPDATE conversations SET mode = 'HUMAN', human_since = ?2 WHERE id = ?1 AND mode = 'BOT'").bind(conv.id, nowIso()).run();
  // The crisis message already says a person has been told, so the HUMAN-mode acknowledgement (src/whatsapp.ts) is not sent after it.
  await db.prepare("UPDATE conversations SET last_ack_at = ?2 WHERE id = ?1").bind(conv.id, nowIso()).run();
  await markGreeted(db, conv.id);
  await db.prepare("INSERT OR IGNORE INTO person_state (conversation_id) VALUES (?1)").bind(conv.id).run();
  await db.prepare("UPDATE person_state SET no_sell_until = ?2 WHERE conversation_id = ?1").bind(conv.id, iso(now + config.safety.noSellDays * 86_400_000)).run();
  await botAudit(db, "CRISIS", `conv:${conv.id}`);
  // One open item per person; the email goes to the safety contact (Settings; the owner by default) with a new one, and says where to
  // look, never what was written.
  const open = await db.prepare("SELECT 1 FROM attention WHERE kind = 'CRISIS' AND target = ?1 AND resolved_at IS NULL").bind(`conv:${conv.id}`).first();
  if (!open) {
    await sendEmailToEach(env, await recipients(env, "safety"), "Urgent: crisis message", `A crisis message arrived. Open ${env.PUBLIC_URL ?? ""}/admin/conv/${conv.id} now.`);
    await db.prepare("INSERT INTO attention (kind, target) VALUES ('CRISIS', ?1)").bind(`conv:${conv.id}`).run();
  }
}

export async function runEmergency(env: Env, conv: SafetyConv, msgId: string, text: string | null): Promise<void> {
  const db = env.DB;
  await sendMessage(env, conv.id, { type: "text", text: copyFor(safetyLang(conv, text)).emergency }, `${msgId}:emergency`, { safety: true });
  await markGreeted(db, conv.id);
  await botAudit(db, "EMERGENCY", `conv:${conv.id}`);
  await db.prepare("INSERT INTO attention (kind, target) SELECT 'EMERGENCY', ?1 WHERE NOT EXISTS (SELECT 1 FROM attention WHERE kind = 'EMERGENCY' AND target = ?1 AND resolved_at IS NULL)").bind(`conv:${conv.id}`).run();
}
