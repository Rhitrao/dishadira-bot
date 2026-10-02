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
  nothingToday: string;
  nothingTomorrow: string;
  refresh: string;
  howDidItGo: string;
  notYet: string;
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
  done: (label: string) => string;
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
  // Ticket 06: outcomes and the session
  btnChooseTime: string; // max 20 chars
  sessionOfferBody: string;
  sessionSlotBody: string;
  noSessionSlots: string;
  sessionNotAvailable: string;
  sessionPayBody: string;
  sessionPayLabel: string; // max 20 chars
  sessionConfirmed: (day: string, time: string) => string;
  notFitRefund: string;
  missedOffer: string;
  rescheduled: (day: string, time: string, businessNumber: string) => string;
  rescheduleNotAvailable: string;
  missedFinal: string;
  reminder: (kind: "call" | "session", day: string, time: string) => string;
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
    nothingToday: "No calls today",
    nothingTomorrow: "No calls tomorrow",
    refresh: "Refresh",
    howDidItGo: "How did it go?",
    notYet: "This call has not started yet.",
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
    done: (label) => `Done: ${label}`,
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
  btnChooseTime: "Choose a time",
  sessionOfferBody: `Thank you for speaking with Shantha Rao. She would be glad to offer you a full session (${rupees(config.prices.sessionPaise)}). Tap below to choose a time.`,
  sessionSlotBody: `Choose a time for your ${config.slots.sessionMinutes}-minute session with Shantha Rao (India time).`,
  noSessionSlots: "There are no free session times right now. We will message you when new times are open.",
  sessionNotAvailable: "Sorry, we cannot book a session from this message. A person will look into it.",
  sessionPayBody:
    `Your time is held for ${config.holdMinutes} minutes. Tap below to pay ${rupees(config.prices.sessionPaise)} for your session. ` +
    "Please don't pay twice.",
  sessionPayLabel: `Pay ${rupees(config.prices.sessionPaise)}`,
  sessionConfirmed: (day, time) =>
    `Your session with Shantha Rao is confirmed for ${day} at ${time} (India time). ` +
    "It is a distance session: you stay where you are and she calls you at the booked time. " +
    "Please keep your phone with you in a quiet place. We will remind you the day before.",
  notFitRefund:
    "Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ₹99.",
  missedOffer: "Sorry we missed each other. Choose a new time for your call. There is nothing more to pay.",
  rescheduled: (day, time, number) =>
    `Your call is now booked for ${day} at ${time}. Shantha Rao will call you from ${number}. There is nothing more to pay.`,
  rescheduleNotAvailable: "Sorry, this call cannot be moved again. A person will look into it.",
  missedFinal:
    "We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again.",
  reminder: (kind, day, time) =>
    `Reminder: your ${kind} with Shantha Rao is tomorrow, ${day} at ${time} (India time). Please keep your phone with you.`,
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
    nothingToday: "KN_TODO no calls today",
    nothingTomorrow: "KN_TODO no calls tomorrow",
    refresh: "KN_TODO refresh",
    howDidItGo: "KN_TODO how did it go",
    notYet: "KN_TODO not yet",
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
    done: (label) => `KN_TODO done ${label}`,
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
  btnChooseTime: "KN_TODO choose time",
  sessionOfferBody: "KN_TODO session offer",
  sessionSlotBody: "KN_TODO session slot list",
  noSessionSlots: "KN_TODO no session slots",
  sessionNotAvailable: "KN_TODO session not available",
  sessionPayBody: "KN_TODO session pay body",
  sessionPayLabel: "KN_TODO pay session",
  sessionConfirmed: (day, time) => `KN_TODO session confirmed ${day} ${time}`,
  notFitRefund: "KN_TODO not fit refund",
  missedOffer: "KN_TODO missed offer",
  rescheduled: (day, time, number) => `KN_TODO rescheduled ${day} ${time} ${number}`,
  rescheduleNotAvailable: "KN_TODO reschedule not available",
  missedFinal: "KN_TODO missed final",
  reminder: (kind, day, time) => `KN_TODO reminder ${kind} ${day} ${time}`,
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
