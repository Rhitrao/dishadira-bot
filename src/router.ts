// The fixed-answer router (ticket 31, finding I1). With the assistant off (live, until Rohit turns it on) or over its daily budget, a typed
// message that names a common topic gets a short fixed answer, built only from docs/KNOWLEDGE.md and the Help copy (src/copy.ts), with the
// menu buttons under it. The word lists are config.router.topics, matched as whole words or phrases after normalising (src/safety.ts), and
// tried in config order: the first topic that matches wins. Safety (crisis, emergency) and the noise rules always run before this.
// Two topics are actions, not answers: "book" opens the booking flow and "my_booking" shows My bookings (src/whatsapp.ts does those).
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Copy } from "./copy";
import { menuOut } from "./menu";
import { hasPhrase } from "./safety";
import type { Out } from "./send";
import { iso } from "./slots";

export type Topic = keyof typeof config.router.topics;
export const TOPICS = Object.keys(config.router.topics) as Topic[];
export const ACTION_TOPICS: readonly Topic[] = ["book", "my_booking"];

export function matchTopic(text: string): Topic | null {
  for (const t of TOPICS) if (hasPhrase(text, config.router.topics[t])) return t;
  return null;
}

// The answer's words, for an answer that goes on top of an open booking step (src/whatsapp.ts), or null for the two action topics.
export function topicText(cp: Copy, topic: Topic): string | null {
  switch (topic) {
    case "medical":
      return cp.answerMedical;
    case "black_magic":
      return cp.answerConcern;
    case "payment_issue":
      return cp.answerPayment;
    case "refund":
      return cp.faqAnswers.refund;
    case "abroad":
      return cp.answerAbroad;
    case "in_person":
      return cp.answerInPerson;
    case "trust":
      return cp.answerTrust;
    case "price":
      return cp.faqAnswers.price;
    case "how_it_works":
      return `${cp.faqAnswers.how_it_works}\n\n${cp.answerCall}`;
    case "timings":
      return cp.faqAnswers.timings;
    case "what_is_this":
      return cp.faqAnswers.what_is_this;
    default:
      return null;
  }
}

// The answer as one message with buttons. No booking push after an illness is named (KNOWLEDGE.md §5, 59-62): Help and Talk to a person only.
// Money trouble and refunds offer Talk to a person, which is where those go (KNOWLEDGE.md §5, 36, 37, 98).
export function topicOut(cp: Copy, topic: Topic, noSell: boolean): Out | null {
  const text = topicText(cp, topic);
  if (text === null) return null;
  if (topic === "medical") return menuOut(cp, true, text);
  if (topic === "payment_issue") return { type: "buttons", body: text, buttons: [{ id: "menu_person", title: cp.btnPerson }, { id: "menu_bookings", title: cp.rowMyBookings }] };
  return menuOut(cp, noSell, text, topic === "refund" || topic === "abroad");
}

// Was a message with this dedupe-key ending sent to this person in the last `minutes`? (The repeat limits: a topic answered a minute ago,
// the "can't answer typed questions" line, a menu nobody tapped.) OUT rows carry the Worker's clock (src/send.ts).
export async function sentRecently(db: D1Database, convId: number, suffix: string, minutes: number, nowMs = Date.now()): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM messages WHERE conversation_id = ?1 AND direction = 'OUT' AND dedupe_key LIKE ?2 AND status NOT IN ('SKIPPED', 'FAILED') AND created_at > ?3 LIMIT 1")
    .bind(convId, `%:${suffix}`, iso(nowMs - minutes * 60_000))
    .first();
  return row !== null;
}
