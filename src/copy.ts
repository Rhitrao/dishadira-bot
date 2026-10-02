// ALL customer-facing text lives here, keyed by language.
// English is final. Kannada values starting with KN_TODO are placeholders for a family member to write.
// Rules: never name an illness, never promise results, never ask for health details.
import { config } from "./config";

export type Lang = "en" | "kn";
export type FaqId = (typeof config.faqIds)[number];

export type Copy = {
  greeting: string;
  menuBody: string;
  btnBook: string; // max 20 chars
  btnHow: string; // max 20 chars
  btnAsk: string; // max 20 chars
  bookSoon: string;
  askPrompt: string;
  ack: string;
  faqBody: string;
  faqButton: string; // max 20 chars
  faqTitles: Record<FaqId, string>; // max 24 chars each
  faqAnswers: Record<FaqId, string>;
};

// Language choice buttons are the same in every language.
export const LANGUAGE_BUTTONS = { en: "English", kn: "ಕನ್ನಡ" } as const;

const rupees = (paise: number) => `₹${paise / 100}`;

const en: Copy = {
  greeting:
    "Namaste! I'm Disha Dira's booking assistant. Shantha Rao calls you personally. " +
    "This chat is only for booking a call. Please choose your language.",
  menuBody: "What would you like to do?",
  btnBook: `Book a ${rupees(config.prices.introPaise)} call`,
  btnHow: "How it works",
  btnAsk: "Ask a question",
  bookSoon: "Booking opens soon.",
  askPrompt: "Please type your question below.",
  ack: "Thanks, a person will reply within 24 hours.",
  faqBody: "Choose a topic.",
  faqButton: "Choose",
  faqTitles: {
    what_is_this: "What is this?",
    how_it_works: "How it works",
    price: "Price",
    timings: "Call timings",
    refund: "Refunds",
    privacy: "Your privacy",
  },
  faqAnswers: {
    what_is_this:
      "Disha Dira offers protection and healing sessions with Shantha Rao. " +
      "You can first book a short call to speak with her.",
    how_it_works:
      `1. Pick a call time. 2. Pay ${rupees(config.prices.introPaise)}. ` +
      `3. Shantha Rao calls you for ${config.slots.callMinutes} minutes. ` +
      "4. If you both agree, you can book a full session.",
    price:
      `The first call is ${rupees(config.prices.introPaise)}. ` +
      `A full session is ${rupees(config.prices.sessionPaise)}.`,
    timings: `Calls are on weekdays, ${config.hours.start} to ${config.hours.end} (India time).`,
    refund:
      `If Shantha Rao feels the call is not the right fit, your ${rupees(config.prices.introPaise)} is refunded. ` +
      "If we have to cancel, you are refunded too.",
    privacy:
      "We keep only your name, WhatsApp number, bookings and payments. " +
      "Please do not share health details here.",
  },
};

const kn: Copy = {
  greeting: "KN_TODO greeting",
  menuBody: "KN_TODO menu body",
  btnBook: "KN_TODO book",
  btnHow: "KN_TODO how",
  btnAsk: "KN_TODO ask",
  bookSoon: "KN_TODO booking soon",
  askPrompt: "KN_TODO ask prompt",
  ack: "KN_TODO ack",
  faqBody: "KN_TODO faq body",
  faqButton: "KN_TODO choose",
  faqTitles: {
    what_is_this: "KN_TODO what_is_this",
    how_it_works: "KN_TODO how_it_works",
    price: "KN_TODO price",
    timings: "KN_TODO timings",
    refund: "KN_TODO refund",
    privacy: "KN_TODO privacy",
  },
  faqAnswers: {
    what_is_this: "KN_TODO what_is_this answer",
    how_it_works: "KN_TODO how_it_works answer",
    price: "KN_TODO price answer",
    timings: "KN_TODO timings answer",
    refund: "KN_TODO refund answer",
    privacy: "KN_TODO privacy answer",
  },
};

const all: Record<Lang, Copy> = { en, kn };

export function copyFor(locale: string): Copy {
  return locale === "kn" ? all.kn : all.en;
}
