// ALL customer-facing text lives here, keyed by language.
// English is final. Kannada values starting with KN_TODO are placeholders for a family member to write.
// Rules: never name an illness, never promise results, never ask for health details.
import { config } from "./config";

export type Lang = "en" | "kn";
export type FaqId = (typeof config.faqIds)[number];

// Labels for Amma's page (/amma). Never any chat or health wording here.
export type AmmaCopy = {
  title: string;
  today: string;
  tomorrow: string;
  nothing: string;
  protection: string;
  healing: string;
  kindCall: string;
  kindSession: string;
  btnCall: string;
  btnSession: string;
  btnNotFit: string;
  btnMissed: string;
  btnRude: string;
  confirm: (label: string, name: string, time: string) => string;
  yes: string;
  back: string;
  saved: (minutes: number) => string;
  undo: string;
  undone: string;
  answered: (label: string) => string;
  alreadyAnswered: string;
  undoTooLate: string;
  expired: string;
  notFound: string;
  noName: string;
};

export type Copy = {
  greeting: string;
  menuBody: string;
  btnBook: string; // max 20 chars
  btnHow: string; // max 20 chars
  btnAsk: string; // max 20 chars
  bookSoon: string;
  chooseService: string;
  btnProtection: string; // max 20 chars
  btnHealing: string; // max 20 chars
  slotListBody: string;
  slotListButton: string; // max 20 chars
  noSlots: string;
  slotTaken: string;
  alreadyHolding: string;
  callAlreadyBooked: (day: string, time: string) => string;
  amma: AmmaCopy;
  payBody: string;
  payLabel: string; // max 20 chars
  payFailed: string;
  confirmed: (day: string, time: string, businessNumber: string) => string;
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
  chooseService: "Which would you like?",
  btnProtection: "Protection",
  btnHealing: "Healing",
  slotListBody: `Choose a time for your ${config.slots.callMinutes}-minute call with Shantha Rao (India time).`,
  slotListButton: "Choose a time",
  noSlots: "There are no free call times right now. Please check again later.",
  slotTaken: "Sorry, that time was just taken. Please choose another.",
  alreadyHolding: "You already have a time held for you. Please use the payment button above, or wait a few minutes and try again.",
  callAlreadyBooked: (day, time) => `Your call is already booked for ${day} ${time}. Shantha Rao will call you then.`,
  amma: {
    title: "Calls and sessions",
    today: "Today",
    tomorrow: "Tomorrow",
    nothing: "Nothing booked.",
    protection: "Protection",
    healing: "Healing",
    kindCall: `Call ${rupees(config.prices.introPaise)}`,
    kindSession: `Session ${rupees(config.prices.sessionPaise)}`,
    btnCall: "Call",
    btnSession: "Session",
    btnNotFit: "Not right fit",
    btnMissed: "Missed",
    btnRude: "Report rude",
    confirm: (label, name, time) => `Confirm: ${label} for ${name}, ${time}?`,
    yes: "Yes",
    back: "Back",
    saved: (m) => `Saved. Undo (${m} min)`,
    undo: "Undo",
    undone: "Undone.",
    answered: (label) => `Saved: ${label}`,
    alreadyAnswered: "This call already has an answer. If it was a mistake, please tell Rohit.",
    undoTooLate: "Sorry, it is too late to undo this.",
    expired: "This page has expired. Please go back and try again.",
    notFound: "Not found.",
    noName: "Customer",
  },
  payBody:
    `Your time is held for ${config.holdMinutes} minutes. Tap below to pay ${rupees(config.prices.introPaise)}. ` +
    "Please don't pay twice.",
  payLabel: `Pay ${rupees(config.prices.introPaise)}`,
  payFailed: "Sorry, we could not create the payment link. Nothing was charged. Please try again.",
  confirmed: (day, time, number) =>
    `Received your ${rupees(config.prices.introPaise)}. Shantha Rao will call you on ${day} at ${time} from ${number}. ` +
    "That number is for her calls only, so please message us here.",
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
  chooseService: "KN_TODO choose service",
  btnProtection: "KN_TODO protection",
  btnHealing: "KN_TODO healing",
  slotListBody: "KN_TODO slot list",
  slotListButton: "KN_TODO choose time",
  noSlots: "KN_TODO no slots",
  slotTaken: "KN_TODO slot taken",
  alreadyHolding: "KN_TODO already holding",
  callAlreadyBooked: (day, time) => `KN_TODO call already booked ${day} ${time}`,
  amma: {
    title: "KN_TODO title",
    today: "KN_TODO today",
    tomorrow: "KN_TODO tomorrow",
    nothing: "KN_TODO nothing booked",
    protection: "KN_TODO protection",
    healing: "KN_TODO healing",
    kindCall: "KN_TODO call",
    kindSession: "KN_TODO session",
    btnCall: "KN_TODO call",
    btnSession: "KN_TODO session",
    btnNotFit: "KN_TODO not right fit",
    btnMissed: "KN_TODO missed",
    btnRude: "KN_TODO report rude",
    confirm: (label, name, time) => `KN_TODO confirm ${label} ${name} ${time}`,
    yes: "KN_TODO yes",
    back: "KN_TODO back",
    saved: (m) => `KN_TODO saved ${m}`,
    undo: "KN_TODO undo",
    undone: "KN_TODO undone",
    answered: (label) => `KN_TODO saved ${label}`,
    alreadyAnswered: "KN_TODO already answered",
    undoTooLate: "KN_TODO too late",
    expired: "KN_TODO expired",
    notFound: "KN_TODO not found",
    noName: "KN_TODO customer",
  },
  payBody: "KN_TODO pay body",
  payLabel: "KN_TODO pay",
  payFailed: "KN_TODO pay failed",
  confirmed: (day, time, number) => `KN_TODO confirmed ${day} ${time} ${number}`,
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
