// The output check: every assistant reply passes through checkReply() before it can be sent (docs/AGENT.md section 6, ticket 14).
// A reply that fails is replaced by the fixed fallback for its label (src/copy.ts). Only the reason CODE is ever recorded, never the reply.
import { config } from "./config";
import { hasPhrase } from "./safety";

export type RejectReason = "TOO_LONG" | "SCRIPT" | "META" | "LINK" | "EMAIL" | "PHONE" | "BANNED_WORD" | "NUMBER";
export type Checked = { ok: true } | { ok: false; reason: RejectReason };

// Devanagari digits read as 0-9.
export const asciiDigits = (text: string): string => text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966));

export const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|net|org|io|me|co|xyz|info|link|app|ly|gl)\b\S*/gi;
export const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A digit run of 6 or more, or a phone number written in groups ("98100 00000", "+91-981-000-0000") with 8 or more digits in all.
export const DIGITS_RE = /\d{6,}/g;
export const GROUPED_DIGITS_RE = /\+?\d[\d\s().-]{5,}\d/g;
const groupedPhone = (m: string) => m.replace(/\D/g, "").length >= 8;

export const phoneLike = (text: string): boolean => {
  const t = asciiDigits(text);
  return /\d{7,}/.test(t) || [...t.matchAll(GROUPED_DIGITS_RE)].some((m) => groupedPhone(m[0]));
};
// Used by the redaction in src/ai.ts so both places agree on what a phone number looks like.
export const redactDigits = (text: string): string =>
  asciiDigits(text).replace(GROUPED_DIGITS_RE, (m) => (groupedPhone(m) ? "[removed]" : m)).replace(DIGITS_RE, "[removed]");

// Latin and Devanagari letters, digits, common punctuation, ₹ and the two allowed emoji.
const ALLOWED_CHARS = /^[\p{Script=Latin}\p{Script=Devanagari}\p{Nd}\s.,!?'"()\-:;/%&+*_…·‘’“”–—×₹।॥\u200c\u200d\uFE0F\u{1F64F}\u{1F33F}]*$/u;

// Numbers in a reply: "5,000" is 5000; "2:30" is 2 and 30.
export function numbersIn(text: string): number[] {
  return [...asciiDigits(text).matchAll(/\d{1,3}(?:,\d{2,3})+(?!\d)|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));
}

// Prices, per-session rates, package sizes, durations, hours and hold minutes all come from config; the person's own booking facts add more.
export function allowedNumbers(factNumbers: readonly number[] = []): Set<number> {
  const p = config.prices;
  const hourOf = (hhmm: string) => Number(hhmm.split(":")[0]);
  const hours = [hourOf(config.hours.start), hourOf(config.hours.end)];
  return new Set<number>([
    p.intro / 100, p.single / 100, p.pack10.paise / 100, p.pack20.paise / 100,
    p.pack10.paise / p.pack10.sessions / 100, p.pack20.paise / p.pack20.sessions / 100,
    p.pack10.sessions, p.pack20.sessions,
    config.slots.callMinutes, config.slots.sessionMinutes, config.holdMinutes,
    ...hours, ...hours.map((h) => h % 12 || 12),
    config.sessionRules.changeBeforeHours, config.sessionRules.maxUpcoming,
    ...config.ai.allowedNumbers,
    ...factNumbers,
  ]);
}

export function checkReply(reply: string, factNumbers: readonly number[] = []): Checked {
  const fail = (reason: RejectReason): Checked => ({ ok: false, reason });
  if (reply.length > config.ai.maxReplyChars) return fail("TOO_LONG");
  if (new RegExp(EMAIL_RE.source).test(reply)) return fail("EMAIL");
  if (new RegExp(URL_RE.source, "i").test(reply)) return fail("LINK");
  if (phoneLike(reply)) return fail("PHONE");
  if (!ALLOWED_CHARS.test(reply)) return fail("SCRIPT");
  if (hasPhrase(reply, config.ai.metaWords)) return fail("META");
  if (hasPhrase(asciiDigits(reply), config.ai.bannedWords)) return fail("BANNED_WORD");
  const ok = allowedNumbers(factNumbers);
  if (numbersIn(reply).some((n) => !ok.has(n))) return fail("NUMBER");
  return { ok: true };
}

