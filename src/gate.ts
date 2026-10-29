// The gatekeeper: what to do with an inbound message, decided by code before any AI. The checks run in exactly the order of
// docs/AGENT.md section 3.2; safety is first, before the blocked check, the greeting, HUMAN mode and the quiet period.
// gate() only decides (it reads, it never writes or sends); src/whatsapp.ts acts on the answer.
import { config } from "./config";
import type { Env } from "./env";
import { budgetUsedUp, isPayingCustomer, personState, quietActive, type Label } from "./noise";
import { detectSafety, hasPhrase, normalize } from "./safety";

export type Gate =
  | "CRISIS" // fixed crisis message, an urgent item, an email, HUMAN mode, no selling for a week
  | "EMERGENCY" // fixed emergency message and an item
  | "IGNORE" // blocked, or a reaction: nothing
  | "GREETING" // first message ever
  | "OPT_OUT" // "stop"
  | "HANDOFF" // "Talk to a person", by button or words
  | "HUMAN_WAIT" // HUMAN mode: typed text waits for Rohit
  | "MEDIA" // voice note, photo, file ...
  | "ACK_WORD" // "ok", "thanks": no reply, no strike
  | "MENU" // "hi", "menu"
  | "BOOKING_WORD" // "book"
  | "BUDGET_FALLBACK" // the day's AI budget is used up
  | "TO_CLASSIFIER" // a real question or remark: the classifier (the AI from ticket 14) decides
  | "TAP"; // a button or list tap (or a template quick reply): the booking, FAQ and menu handlers take it

export type GateConv = { id: number; mode: string; greeted_at: string | null };
export type GateMessage = { type: string; text: string | null; choice: string | null };

// A text that is only a greeting or menu word: lower-cased, with spaces, punctuation and emoji ignored ("Hello 🙏!" -> "hello").
export function plainWord(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‍️]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const MENU_WORDS = new Set(config.menuWords.map(plainWord));
export const isMenuWord = (text: string) => MENU_WORDS.has(plainWord(text));

// The whole message, once normalised, is one of the words (an emoji-only message normalises to nothing and matches nothing here).
const oneOf = (text: string, list: readonly string[]) => {
  const n = normalize(text);
  return n !== "" && list.some((w) => normalize(w) === n);
};
export const isOptOut = (text: string) => oneOf(text, config.words.optOut);
export const isBookingWord = (text: string) => oneOf(text, config.words.booking);
export const isHelpWord = (text: string) => oneOf(text, config.words.help);

// "ok", "Thanks!", "thanks 🙏", or only 👍/🙏 (repeated, with a skin tone, with spaces).
const ACK_EMOJI = config.words.ack.filter((w) => normalize(w) === "");
export function isAckWord(text: string): boolean {
  if (oneOf(text, config.words.ack)) return true;
  if (normalize(text) !== "") return false;
  let rest = text.replace(/[\s\p{P}‍️\u{1F3FB}-\u{1F3FF}]/gu, "");
  for (const e of ACK_EMOJI) rest = rest.split(e).join("");
  return rest === "" && text.trim() !== "" && ACK_EMOJI.some((e) => text.includes(e));
}

// A short message with "human" or "person" in it ("Talk to a human", "insaan se baat karni hai"); a long message that mentions a person is not a request.
export const isHandoffWords = (text: string) => normalize(text).split(" ").length <= config.words.handoffMaxWords && hasPhrase(text, config.words.handoff);

export async function gate(env: Env, conv: GateConv, message: GateMessage, nowMs = Date.now()): Promise<Gate> {
  const text = message.text;
  const isTap = message.choice !== null || message.type === "button";

  // 1. Safety, for everyone. Not on a Worker whose SENDS env flag is off (it cannot send anything).
  if (text !== null && env.SENDS === "true") {
    const safety = detectSafety(text);
    if (safety) return safety;
  }
  // 2. Blocked: nothing.
  if (conv.mode === "BLOCKED") return "IGNORE";
  // 3. First message ever: the greeting.
  if (!conv.greeted_at) return "GREETING";
  // 4. Opt-out.
  if (text !== null && isOptOut(text)) return "OPT_OUT";
  // 5. A person: always honoured, even when quiet. "HELP" on its own too (the payment reminder says "Reply HELP").
  if (message.choice === "menu_person" || (text !== null && (isHandoffWords(text) || isHelpWord(text)))) return "HANDOFF";
  // 6. HUMAN mode: taps still work and a menu word ("hi", "menu") gets the menu without leaving HUMAN mode; everything else typed waits for Rohit.
  if (conv.mode === "HUMAN" && text !== null && isMenuWord(text)) return "MENU";
  if (conv.mode !== "BOT" && !isTap) return "HUMAN_WAIT";
  if (isTap) return "TAP"; // booking buttons work in a quiet period too, without ending it
  if (message.type === "reaction") return "IGNORE";
  // 7. Paying customers skip the quiet period (and strikes, in src/noise.ts).
  // 8. A quiet period: free text gets no reply, but "book" opens the booking flow.
  if (text !== null) {
    const st = await personState(env.DB, conv.id);
    if (quietActive(st, nowMs) && !(await isPayingCustomer(env.DB, conv.id, nowMs))) return isBookingWord(text) ? "BOOKING_WORD" : "IGNORE";
  }
  // 9. Not text.
  if (text === null) return "MEDIA";
  // 10. Short acknowledgements.
  if (isAckWord(text)) return "ACK_WORD";
  // 11. Menu words, and "book".
  if (isMenuWord(text)) return "MENU";
  if (isBookingWord(text)) return "BOOKING_WORD";
  // 12. The day's AI budget.
  if (await budgetUsedUp(env.DB, conv.id, await isPayingCustomer(env.DB, conv.id, nowMs), nowMs)) return "BUDGET_FALLBACK";
  // 13. The classifier.
  return "TO_CLASSIFIER";
}

// The rule-based stand-in for the AI's label (ticket 14 replaces it when AI_REPLIES is on): from the config word lists.
// Ticket 31 (I1, I16): threats count as abuse (a strike, no reply; src/whatsapp.ts also raises an urgent THREAT item), promotions and scams
// are spam even without a link, and influencing or harming another person is prohibited_request (a strike and one firm line).
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|me|co|xyz|info|link)\b/i;
export const isThreat = (text: string) => hasPhrase(text, config.noise.threatWords);
export const isJobText = (text: string) => hasPhrase(text, config.noise.jobWords);
export function classifyWithoutAI(text: string): Extract<Label, "spam_or_promo" | "flirt_or_sexual" | "abuse" | "prohibited_request"> | "TO_CLASSIFIER" {
  if (hasPhrase(text, config.noise.abuseBlockWords) || hasPhrase(text, config.noise.abuseWords) || isThreat(text)) return "abuse";
  if (hasPhrase(text, config.noise.sexualBlockWords) || hasPhrase(text, config.noise.flirtWords)) return "flirt_or_sexual";
  if ((LINK.test(text) && hasPhrase(text, config.noise.spamWords)) || hasPhrase(text, config.noise.promoWords)) return "spam_or_promo";
  if (hasPhrase(text, config.noise.prohibitedWords)) return "prohibited_request";
  return "TO_CLASSIFIER";
}
