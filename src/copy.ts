// ALL customer-facing text lives here, in English and Hindi (wording: docs/KNOWLEDGE.md §10 and §11; the full list for review: docs/COPY.md).
// Prices come from the prices in force (src/business.ts: the owner's Settings, else config); durations and the hold time from config. Both languages must have exactly the same keys (test/copy.test.ts).
// Rules: never name an illness, never promise results, never ask for health details.
import { config } from "./config";
import { DEFAULT_PRICES, prices, type Prices } from "./business";

export type Lang = "en" | "hi";
export type FaqId = (typeof config.faqIds)[number];
export type ForWhom = "SELF" | "FAMILY" | "PET";

// Any locale we do not know (an old row, a typo) reads as English.
export const langOf = (locale: string | null | undefined): Lang => (locale === "hi" ? "hi" : "en");

// ₹799, ₹5,000 (Indian digit grouping): every amount a customer reads is built from config.
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
// A package's price at the prices in force (src/business.ts).
export const packPrice = (n: number) => {
  const p = prices();
  return rupees(n === p.pack10.sessions ? p.pack10.paise : p.pack20.paise);
};
// Per-session rate of a package: price ÷ sessions (₹500, ₹450).
export const perSession = (pack: { sessions: number; paise: number }) => rupees(pack.paise / pack.sessions);
const rules = config.sessionRules;

// ---- dates and times, as customers see them (India time) ----
export const dateWords = {
  en: {
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  hi: {
    weekdays: ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"],
    months: ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
  },
} as const;
const weekdaysFull = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  hi: ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"],
} as const;

const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

// Hindi part of the day: before noon सुबह, until the evening time दोपहर, then शाम.
const hindiPart = (minutes: number) => (minutes < 720 ? "सुबह" : minutes < hhmm(config.booking.eveningFrom) ? "दोपहर" : "शाम");

// "2:30 pm" / "दोपहर 2:30" / "शाम 5:30"
export function timeLabel(lang: Lang, h: number, m: number): string {
  const mm = String(m).padStart(2, "0");
  if (lang === "hi") return `${hindiPart(h * 60 + m)} ${h % 12 || 12}:${mm}`;
  return `${h % 12 || 12}:${mm} ${h < 12 ? "am" : "pm"}`;
}

// "Wed, 21 Oct" / "बुध, 21 अक्टूबर"
export const dayLabel = (lang: Lang, weekday: number, date: number, month: number) =>
  `${dateWords[lang].weekdays[weekday]}, ${date} ${dateWords[lang].months[month]}`;

// "2 pm" / "दोपहर 2 बजे" (minutes only when not :00), for the timings answer.
function hourPhrase(lang: Lang, t: string): string {
  const minutes = hhmm(t);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  return lang === "hi" ? `${hindiPart(minutes)} ${clock} बजे` : `${clock} ${h < 12 ? "am" : "pm"}`;
}

// "Monday to Friday", "Monday, Wednesday and Friday" from config.hours.days.
function weekdayRange(lang: Lang): string {
  const order = [1, 2, 3, 4, 5, 6, 0]; // weeks start on Monday
  const days = [...config.hours.days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const names = days.map((d) => weekdaysFull[lang][d]);
  const contiguous = days.every((d, i) => i === 0 || order.indexOf(d) === order.indexOf(days[i - 1]) + 1);
  if (days.length >= 3 && contiguous) return lang === "hi" ? `${names[0]} से ${names[names.length - 1]}` : `${names[0]} to ${names[names.length - 1]}`;
  const and = lang === "hi" ? " और " : " and ";
  return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + and + names[names.length - 1];
}

export const hoursText = (lang: Lang) =>
  lang === "hi"
    ? `कॉल ${weekdayRange("hi")}, ${hourPhrase("hi", config.hours.start)} से ${hourPhrase("hi", config.hours.end)} तक (भारतीय समय) होती हैं।`
    : `Calls are ${weekdayRange("en")}, ${hourPhrase("en", config.hours.start)} to ${hourPhrase("en", config.hours.end)} (India time).`;

// "2" / "2:30": the clock part of a time, for the sentence below.
const clock = (t: string) => {
  const minutes = hhmm(t);
  const m = minutes % 60;
  return `${Math.floor(minutes / 60) % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
};

// The hint on the day and time steps when someone types instead of tapping ("Saturday please"): when calls and sessions happen.
export const hintDaysText = (lang: Lang) =>
  lang === "hi"
    ? `कॉल और सेशन ${weekdayRange("hi")}, ${hindiPart(hhmm(config.hours.start))} ${clock(config.hours.start)} से ${hindiPart(hhmm(config.hours.end))} ${clock(config.hours.end)} बजे तक (भारतीय समय) होते हैं।`
    : `Calls and sessions are ${weekdayRange("en")}, ${hourPhrase("en", config.hours.start)} to ${hourPhrase("en", config.hours.end)} (India time).`;

export const serviceName = (service: string, lang: Lang): string =>
  (config.serviceNames as Record<string, Record<Lang, string>>)[service]?.[lang] ?? service;

// Labels for Amma's page (/amma). Never any chat or health wording here. Amma's page is English.
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
  kindSessionSingle: string;
  kindSessionPackage: (n: number, size: number) => string; // "package 3/10"
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
  callLang: Record<Lang, string>; // the language of the call, next to the name
  forWhom: Record<ForWhom, string>; // who the call is for, next to the name
};

export type Copy = {
  greeting: string; // the same bilingual message in both languages
  chooseLanguage: string; // same in both languages
  menuBody: string;
  btnBook: string; // max 20 chars
  btnPackages: string; // max 20 chars
  btnHelp: string; // max 20 chars
  btnPerson: string; // max 20 chars
  changeLanguageRow: string; // max 24 chars (a list row)
  handoffAck: string;
  humanWaitAck: string; // once per handoff: the first message typed while a person from the team has the chat
  askPrompt: string;
  ack: string;
  bookSoon: string;
  ageCheck: string;
  btnYes: string; // max 20 chars
  btnNo: string; // max 20 chars
  ageNo: string;
  chooseService: string;
  btnHealing: string; // max 20 chars
  btnCleansing: string; // max 20 chars
  whoFor: string;
  btnMe: string; // max 20 chars
  btnFamily: string; // max 20 chars
  btnPet: string; // max 20 chars
  chooseDay: string;
  listButtonDays: string; // max 20 chars: the button that opens the day list
  rowDayBoth: string; // max 72 chars: a day row's description when it has afternoon and evening times
  rowDayAfternoon: string; // max 72 chars
  rowDayEvening: string; // max 72 chars
  timesFor: (day: string) => string;
  sessionTimesFor: (day: string) => string;
  sectionAfternoon: string; // max 24 chars
  sectionEvening: string; // max 24 chars
  rowCall: string; // max 72 chars
  rowSession: string; // max 72 chars
  anotherDay: string; // max 24 chars
  listButtonTimes: string; // max 20 chars
  noSlots: string;
  slotTaken: string;
  alreadyHolding: string;
  callAlreadyBooked: (day: string, time: string) => string;
  // The pay messages (ticket 29): `until` is the hold's end as a clock time (India time), `link` our own /p/ link (src/paylink.ts).
  payBody: (day: string, time: string, until: string, link: string) => string;
  payLabel: string; // max 20 chars
  payFailed: string;
  // She calls the customer's own phone; the number she calls from is never given (owner, 29 Oct 2026).
  confirmed: (day: string, time: string, callLang: Lang) => string;
  // outcomes and the session
  btnChooseTime: string; // max 20 chars
  sessionOfferBody: string;
  noSessionSlots: string;
  sessionNotAvailable: string;
  sessionPayBody: (day: string, time: string, until: string, link: string) => string;
  sessionPayLabel: string; // max 20 chars
  sessionConfirmed: (day: string, time: string, remind?: boolean) => string; // remind: the day-before reminder can reach them (ticket 31, I2)
  notFitRefund: string;
  missedOffer: string;
  rescheduled: (day: string, time: string) => string;
  rescheduleNotAvailable: string;
  missedFinal: string;
  reminderCall: (day: string, time: string) => string;
  reminderSession: (day: string, time: string) => string;
  wordCall: string; // template parameter
  wordSession: string; // template parameter
  mediaNotice: string;
  mediaNoticeCustomer: string;
  // safety, noise and re-prompts (ticket 12)
  crisis: string;
  emergency: string;
  quietClose: string;
  optOutConfirm: string;
  flirtLine: string;
  aiFallback: string; // the menu's body when the AI cannot answer (ticket 14), and when a daily AI budget is used up
  aiFallbackNoSell: string; // the same, while selling is paused (after a crisis message): no call is offered
  btnSeeTimes: string; // max 20 chars: under an assistant answer that leads to booking
  // Sent instead of an assistant answer that failed the output check (docs/KNOWLEDGE.md section 11, "Fallbacks"), one per group of labels.
  fallbackQuestion: string; // relevant_question, objection, booking_intent
  fallbackConcern: string; // personal_concern
  fallbackBooking: string; // existing_booking
  fallbackOffTopic: string; // off_topic, astrology_or_prediction, prohibited_request, loop, smalltalk
  reprompt: (hint: string) => string;
  hintDays: string;
  repromptHelp: string;
  callRequest: string; // "call me", "number please" (ticket 30): the body of the menu message
  repromptQuestion: string; // above the open step when the assistant could not answer a typed question
  alreadyBookedStart: (day: string, time: string) => string;
  btnKeep: string; // max 20 chars
  helpListBody: string;
  faqButton: string; // max 20 chars
  rowMyBookings: string; // max 24 chars (a list row)
  faqTitles: Record<FaqId, string>; // max 24 chars each
  faqAnswers: Record<FaqId, string>;
  // sessions and packages (ticket 13)
  packagesBody: string;
  packagesButton: string; // max 20 chars
  rowIntroTitle: string; // max 24 chars (list rows below)
  rowIntroDesc: string; // max 72 chars
  rowSingleTitle: string;
  rowSingleDesc: string;
  rowPack10Title: string;
  rowPack10Desc: string;
  rowPack20Title: string;
  rowPack20Desc: string;
  softGate: string;
  btnContinue: string; // max 20 chars
  packPayBody: (n: number, price: string, until: string, link: string) => string;
  packPayLabel: (price: string) => string; // max 20 chars
  packPending: string;
  packConfirmed: (n: number) => string;
  btnBookSession: string; // max 20 chars
  creditBooked: (day: string, time: string, left: number) => string;
  maxUpcoming: string;
  noCredits: string;
  creditsLeft: (left: number) => string;
  myBookingsBody: (list: string, left: number) => string;
  myBookingsNoPack: (list: string) => string;
  myBookingsNone: string;
  bookingItem: (word: string, day: string, time: string) => string;
  sessionActions: (day: string, time: string) => string;
  btnMove: string; // max 20 chars
  btnCancel: string; // max 20 chars
  bookingNotFound: string;
  moveTooLate: string;
  moveOnlyOnce: string;
  moved: (day: string, time: string) => string;
  cancelledCredit: (left: number) => string;
  cancelledSingleRefund: string;
  cancelledSingleNoRefund: string;
  notFitRefundSession: (amount: string) => string;
  packRefunded: (amount: string) => string;
  // The payment reminder about 8 minutes before a hold ends (ticket 29), and the small page behind our /p/ link (src/paylink.ts).
  payNudge: (until: string, link: string) => string;
  pageBrand: string;
  pageBtnWhatsApp: string;
  pagePaidTitle: string;
  pagePaidBody: string;
  pagePaidPackBody: string;
  pageExpiredTitle: string;
  pageExpiredBody: string;
  pageExpiredPackBody: string;
  pageNotFoundTitle: string;
  pageNotFoundBody: string;
  pageErrorTitle: string;
  pageErrorBody: string;
  // ticket 31: fixes from the launch simulations
  timePassed: string; // B1: an old list row whose time has passed or is too soon
  stillHeld: (day: string, time: string, until: string, link: string) => string; // B2: the same time tapped again while its hold is unpaid
  dupRefund: (amount: string) => string; // B3: a second payment, refunded automatically
  dupKeeps: (day: string, time: string) => string; // B3: ... and the booking that stays
  latePaidTaken: (amount: string) => string; // B4: paid after the hold ended, and someone else has the time
  checkingPayment: string; // I19: a payment with the wrong amount
  holdReleased: string; // I11: a hold that ended unpaid
  handbackNotice: string; // I14: a handoff nobody answered in time
  answerCall: string; // I1: the fixed answers (src/router.ts)
  answerTrust: string;
  answerAbroad: string;
  answerInPerson: string;
  answerMedical: string;
  answerConcern: string;
  answerPayment: string;
  prohibitedLine: string; // I16
  jobsLine: string;
  pageLateBody: string; // the /p/ page: paid, but the time went to someone else
  pageCheckTitle: string; // ... a payment we need to check
  pageCheckBody: string;
  pageOpeningTitle: string; // ... the short page before Razorpay's
  pageOpeningBody: string;
  pageBtnContinue: string;
  amma: AmmaCopy;
};

// Language choice buttons are the same in every language.
export const LANGUAGE_BUTTONS = { en: "English", hi: "हिंदी" } as const;

// KNOWLEDGE.md §10: one bilingual message, then the two language buttons.
const GREETING =
  "Namaste! This is Disha Dira's automated booking assistant. This chat is for booking a call. Shantha Rao calls you personally. " +
  "To answer you, your messages are processed by our assistant and AI provider. Privacy: disha-dira.com/privacy.html\n\n" +
  "नमस्ते! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। यह चैट कॉल बुक करने के लिए है। शांता राव जी आपको खुद कॉल करती हैं। " +
  "आपको जवाब देने के लिए आपके मैसेज हमारे असिस्टेंट और AI सेवा प्रदाता द्वारा प्रोसेस किए जाते हैं। प्राइवेसी: disha-dira.com/privacy.html\n\n" +
  "Please choose your language / कृपया भाषा चुनें:";
const CHOOSE_LANGUAGE = "Please choose your language / कृपया भाषा चुनें:";

// Every message with a price in it is built from one set of prices. The body below is the builder's, left unindented so the wording
// reads as before; copyFor() builds it once per set of prices.
function buildCopy(P: Prices): Record<Lang, Copy> {
const intro = rupees(P.intro);
const sessionPrice = rupees(P.single);
const p10 = P.pack10;
const p20 = P.pack20;
const packPrice = (n: number) => rupees(n === p10.sessions ? p10.paise : p20.paise);

const ammaEn: AmmaCopy = {
  title: "Calls and sessions",
  today: "Today",
  tomorrow: "Tomorrow",
  nothingToday: "No calls today",
  nothingTomorrow: "No calls tomorrow",
  refresh: "Refresh",
  howDidItGo: "How did it go?",
  notYet: "This call has not started yet.",
  protection: serviceName("PROTECTION", "en"),
  healing: serviceName("HEALING", "en"),
  kindCall: `Call ${intro}`,
  kindSessionSingle: `Session ${sessionPrice} · single`,
  kindSessionPackage: (n, size) => `Session · package ${n}/${size}`,
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
  callLang: { en: "English", hi: "Hindi" },
  forWhom: { SELF: "self", FAMILY: "family", PET: "pet" },
};

const en: Copy = {
  greeting: GREETING,
  chooseLanguage: CHOOSE_LANGUAGE,
  menuBody: "What would you like to do? You can also type your question.",
  btnBook: `Book ${intro} call`,
  btnPackages: "Sessions & packages",
  btnHelp: "Help",
  btnPerson: "Talk to a person",
  changeLanguageRow: "Change language",
  rowMyBookings: "My bookings",
  handoffAck: "Thank you. A person from our team will reply here, usually within 24 hours.",
  humanWaitAck: "Got it. This is with our team, and they'll reply here.",
  askPrompt: "Please type your question below.",
  ack: "I'm the booking assistant and can't answer typed questions. Tap below to book, or \"Talk to a person\".",
  bookSoon: "New bookings are paused for a short while. Please message us again in a day or two, or tap below to talk to our team.",
  ageCheck: "Are you 18 or older?",
  btnYes: "Yes",
  btnNo: "No",
  ageNo: "Please ask a parent or guardian to message us. They can book the call for you.",
  chooseService: "Which would you like?",
  btnHealing: serviceName("HEALING", "en"),
  btnCleansing: serviceName("PROTECTION", "en"),
  whoFor: "Who is this for?",
  btnMe: "Me",
  btnFamily: "Family member",
  btnPet: "Pet",
  chooseDay: "Which day suits you? (India time)",
  listButtonDays: "Choose a day",
  rowDayBoth: "Afternoon and evening times",
  rowDayAfternoon: "Afternoon times",
  rowDayEvening: "Evening times",
  timesFor: (day) => `Free times on ${day} (India time). Each call is ${config.slots.callMinutes} minutes.`,
  sessionTimesFor: (day) => `Free times on ${day} (India time). Each session is ${config.slots.sessionMinutes} minutes.`,
  sectionAfternoon: "Afternoon",
  sectionEvening: "Evening",
  rowCall: `${config.slots.callMinutes}-min call`,
  rowSession: `${config.slots.sessionMinutes}-min session`,
  anotherDay: "Another day",
  listButtonTimes: "Choose a time",
  noSlots: "There are no free call times in the next few days. Tap \"Talk to a person\", or check back tomorrow.",
  slotTaken: "Sorry, that time was just taken. Please choose another.",
  alreadyHolding: "A time is already held for you. Please use the payment button above, or try again in a few minutes.",
  callAlreadyBooked: (day, time) => `Your call is already booked for ${day} at ${time}. Shantha Rao will call you then.`,
  payBody: (day, time, until, link) =>
    `${day} at ${time} is held for you until ${until} (India time).\n\n` +
    `Tap "Pay ${intro}" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice.\n\n` +
    `If the button does not open, use this link: ${link}`,
  payLabel: `Pay ${intro}`,
  payFailed: "Sorry, we couldn't create the payment link. Nothing was charged. Please try again.",
  confirmed: (day, time, callLang) =>
    `Received your ${intro}. Shantha Rao will call you on ${day} at ${time} (India time), on the number you are messaging from. Call in ${callLang === "hi" ? "Hindi" : "English"}. ` +
    "The call may come from a number you don't know, so please keep your phone nearby. This WhatsApp number is for messages only, not calls.",
  btnChooseTime: "Choose a time",
  sessionOfferBody: `Thank you for speaking with Shantha Rao. She would be glad to offer you a full session. Choose an option below: a single session, or a package of ${p10.sessions} or ${p20.sessions}.`,
  noSessionSlots: "There are no free session times in the next few days. Tap \"Talk to a person\", or check back tomorrow.",
  sessionNotAvailable: "Sorry, we cannot book a session from this message. A person will look into it.",
  sessionPayBody: (day, time, until, link) =>
    `${day} at ${time} is held for your session until ${until} (India time).\n\n` +
    `Tap "Pay ${sessionPrice}" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. Please don't pay twice.\n\n` +
    `If the button does not open, use this link: ${link}`,
  sessionPayLabel: `Pay ${sessionPrice}`,
  sessionConfirmed: (day, time, remind = true) =>
    `Your session with Shantha Rao is confirmed for ${day} at ${time} (India time). ` +
    "It is a distance session: you stay where you are and she calls you at the booked time. " +
    `Please keep your phone with you in a quiet place. ${remind ? "We will remind you the day before." : "Please note the time; we'll message you here if anything changes."}`,
  notFitRefund: `Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we're refunding your ${intro}. It usually reaches your account in 5–7 working days.`,
  missedOffer: "Sorry we missed each other. Choose a new time for your call. There is nothing more to pay.",
  rescheduled: (day, time) =>
    `Your call is now booked for ${day} at ${time} (India time). Shantha Rao will call you on the number you are messaging from. ` +
    "The call may come from a number you don't know, so please keep your phone nearby. There is nothing more to pay. This WhatsApp number is for messages only, not calls.",
  rescheduleNotAvailable: "Sorry, this call cannot be moved again. A person will look into it.",
  missedFinal:
    "We were not able to reach you for the second time, so we are closing this booking. Thank you for your interest, and you are welcome to write to us again.",
  reminderCall: (day, time) =>
    `Reminder: your call with Shantha Rao is tomorrow, ${day} at ${time} (India time). Please keep your phone with you.`,
  reminderSession: (day, time) =>
    `Reminder: your session with Shantha Rao is tomorrow, ${day} at ${time} (India time). Please keep your phone with you.`,
  wordCall: "call",
  wordSession: "session",
  mediaNotice: "Only typed messages can be read here. Please type your question, or tap a button below.",
  mediaNoticeCustomer: "Only typed messages can be read here. If this was about your payment or booking, our team will check and reply here.",
  crisis:
    "We're really sorry you're going through this. You don't have to face it alone. Please talk to someone right now: Tele-MANAS is a free government helpline, open 24×7. " +
    "Call *14416* or *1-800-891-4416*. If you or anyone else is in danger right now, call *112*. A person from our team has been told and will message you here as soon as they can.",
  emergency: "This sounds like an emergency. Please call *112*, or *108* for an ambulance, right now, or go to the nearest hospital.",
  quietClose: "It seems we can't help with this. If you'd like to book a call with Shantha Rao later, just type *book*.",
  optOutConfirm: "Done. We won't send you any more messages. If you write to us again, we'll reply.",
  flirtLine: "This chat is only for bookings.",
  aiFallback: "Sorry, we can't answer that right now. You can book a call below or talk to a person.",
  aiFallbackNoSell: "Sorry, we can't answer that right now. You can talk to a person from our team below.",
  btnSeeTimes: "See call times",
  fallbackQuestion: `Thanks for asking. Shantha Rao can explain this properly on a short ${intro} call, or you can ask a person from our team.`,
  fallbackConcern: `We're sorry you're going through this. If you'd like, Shantha Rao can listen on a short call. Please also keep following your doctor's advice.`,
  fallbackBooking: "Our team will check this and reply to you here.",
  fallbackOffTopic: "We can only help with Disha Dira calls and bookings.",
  reprompt: (hint) => `${hint ? `${hint} ` : ""}Please choose from the options below.`,
  hintDays: hintDaysText("en"),
  repromptHelp: "If you would rather talk to a person from our team, tap below.",
  callRequest: `We don't take calls on this WhatsApp number. The quickest way to talk to Shantha Rao is the ${intro} ${config.slots.callMinutes}-minute call: you choose a time, and she calls you.`,
  repromptQuestion: "Thanks for asking. Shantha Rao can explain this on your call. When you're ready, choose an option below.",
  alreadyBookedStart: (day, time) => `You already have a call on ${day} at ${time}. Shantha Rao will call you then.`,
  btnKeep: "Keep it",
  helpListBody: "How can we help?",
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
      "Disha Dira offers no-touch pranic healing by phone with Shantha Rao, a certified Pranic Healer trained in the MCKS system. " +
      `The first step is a ${config.slots.callMinutes}-minute call with her for ${intro}.`,
    how_it_works:
      `1. Pick a call time. 2. Pay ${intro}. ` +
      `3. Shantha Rao calls you for ${config.slots.callMinutes} minutes. ` +
      "4. If you both agree, you can book a full session or a package.",
    price:
      `The first call is ${intro}. A single session is ${sessionPrice}. ` +
      `Packages: ${p10.sessions} sessions for ${packPrice(p10.sessions)} (${perSession(p10)} each) or ${p20.sessions} for ${packPrice(p20.sessions)} (${perSession(p20)} each), with no expiry.`,
    timings: hoursText("en"),
    refund:
      `If Shantha Rao feels the call is not the right fit, your ${intro} is refunded. ` +
      `A single session can be moved once, up to ${rules.changeBeforeHours} hours before, and cancelled for a full refund ${rules.singleRefundBeforeHours} hours or more before. ` +
      `A package session that you move or cancel ${rules.changeBeforeHours} hours or more before goes back to your package. ` +
      "If we have to cancel, you are refunded too.",
    privacy:
      "We keep only your name, WhatsApp number, bookings and payments. Please do not share health details here.",
  },
  // sessions and packages (ticket 13)
  packagesBody: "Sessions are 60 minutes by phone. Choose an option. Most people start with the ₹99 call, so Shantha Rao can suggest what suits them.",
  packagesButton: "See options",
  rowIntroTitle: `${intro} first call`,
  rowIntroDesc: `${config.slots.callMinutes} min with Shantha Rao`,
  rowSingleTitle: "Single session",
  rowSingleDesc: sessionPrice,
  rowPack10Title: `${p10.sessions} sessions`,
  rowPack10Desc: `${packPrice(p10.sessions)} · ${perSession(p10)} each · no expiry`,
  rowPack20Title: `${p20.sessions} sessions`,
  rowPack20Desc: `${packPrice(p20.sessions)} · ${perSession(p20)} each · no expiry`,
  softGate:
    `Most people start with a ${intro} call, so Shantha Rao can understand what you need first. Would you like to do that, or continue?`,
  btnContinue: "Continue",
  packPayBody: (n, price, until, link) =>
    `${n} sessions for ${price}. After paying, you book each session whenever you like, with no payment per session.\n\n` +
    `Tap "Pay ${price}" below to open Razorpay's secure payment page. Pay by any UPI app, card or net banking. The link is open until ${until} (India time). Please don't pay twice.\n\n` +
    `If the button does not open, use this link: ${link}`,
  packPayLabel: (price) => `Pay ${price}`,
  packPending: "A payment link for a package is already open. Please use the payment button above, or try again in a few minutes.",
  packConfirmed: (n) => `Payment received. You have ${n} sessions. Book your first one now?`,
  btnBookSession: "Book a session",
  creditBooked: (day, time, left) => `Your session is booked for ${day} at ${time} (India time). Shantha Rao will call you then. Sessions left: ${left}.`,
  maxUpcoming: `You already have ${rules.maxUpcoming} upcoming sessions. You can book the next one after one of them.`,
  noCredits: "You have no sessions left in your package. You can buy a single session or a new package from \"Sessions & packages\".",
  creditsLeft: (left) => `Sessions left in your package: ${left}.`,
  myBookingsBody: (list, left) => `Your bookings: ${list}. Sessions left in your package: ${left}.`,
  myBookingsNoPack: (list) => `Your bookings: ${list}.`,
  myBookingsNone: "You have no upcoming bookings.",
  bookingItem: (word, day, time) => `${word} on ${day} at ${time}`,
  sessionActions: (day, time) => `Your session on ${day} at ${time}. What would you like to do?`,
  btnMove: "Move",
  btnCancel: "Cancel",
  bookingNotFound: "Sorry, we couldn't find that booking. It may have changed. Please open My bookings again.",
  moveTooLate: `Sorry, sessions can only be moved or cancelled up to ${rules.changeBeforeHours} hours before.`,
  moveOnlyOnce: "This session has already been moved once, so it can't be moved again. If you need help, please talk to a person from our team.",
  moved: (day, time) => `Done. Your session is now on ${day} at ${time} (India time).`,
  cancelledCredit: (left) => `Cancelled. The session is back in your package. Sessions left: ${left}.`,
  cancelledSingleRefund: `Cancelled. As it was ${rules.singleRefundBeforeHours} hours or more before, the full amount will be refunded to your original payment method.`,
  cancelledSingleNoRefund: `Between ${rules.changeBeforeHours} and ${rules.singleRefundBeforeHours} hours before, a single session can't be refunded, but you can move it once. Move it instead?`,
  notFitRefundSession: (amount) =>
    `Thank you for speaking with Shantha Rao. She feels this isn't the right fit just now, so we're refunding your payment of ${amount}. It usually reaches your account in 5–7 working days.`,
  packRefunded: (amount) => `We've refunded ${amount} for the sessions you didn't use. It goes back to your original payment method.`,
  payNudge: (until, link) =>
    `Your time is still held until ${until} (India time). Pay here: ${link}\n\nHaving trouble paying? Reply HELP and we will help you.`,
  pageBrand: "Disha Dira",
  pageBtnWhatsApp: "Back to WhatsApp",
  pagePaidTitle: "Payment received",
  pagePaidBody: "Your booking is confirmed; the details are in WhatsApp. You can close this page.",
  pagePaidPackBody: "Your sessions are added to your package; the details are in WhatsApp. You can close this page.",
  pageExpiredTitle: "This payment link has expired",
  pageExpiredBody: "Your time is no longer held. Go back to WhatsApp and tap Book again.",
  pageExpiredPackBody: "Go back to WhatsApp and choose your package again.",
  pageNotFoundTitle: "Link not found",
  pageNotFoundBody: "This payment link is not right. Please go back to WhatsApp and use the latest payment message.",
  pageErrorTitle: "Please try again",
  pageErrorBody: "We couldn't open the payment page just now. Please open the link again in a minute.",
  // ticket 31
  timePassed: "Sorry, that time is too soon or has already passed. Please choose another.",
  stillHeld: (day, time, until, link) =>
    `${day} at ${time} is still held for you until ${until} (India time). It is booked once you pay.\n\n` +
    `Tap "Pay ${intro}" below to open Razorpay's secure payment page. Please don't pay twice.\n\n` +
    `If the button does not open, use this link: ${link}`,
  dupRefund: (amount) => `We received a second payment of ${amount} by mistake, so we are refunding it. It usually reaches your account in 5–7 working days.`,
  dupKeeps: (day, time) => `Your booking stays on ${day} at ${time} (India time).`,
  latePaidTaken: (amount) =>
    `We received your ${amount}, but the time you picked was booked by someone else after your hold ended. Our team will message you here today with a new time or a full refund.`,
  checkingPayment: "We received a payment that we need to check. Our team will sort it out and reply here today. Please don't pay again.",
  holdReleased: "Your held time has been released. Nothing was charged. Tap below to choose a time again.",
  handbackNotice: "Sorry we couldn't reply in time. You can book below, or ask again for a person.",
  answerCall:
    `The first call is ${config.slots.callMinutes} minutes, by phone, at the time you pick. Shantha Rao calls you herself, listens to what is going on, ` +
    "and explains how she works and whether a full session would suit you. The call is in the language you chat in, English or Hindi.",
  answerTrust:
    "That's a fair question. Shantha Rao is a certified Pranic Healer trained in the MCKS system. Payment happens only on Razorpay's secure page, " +
    `and we never ask for your PIN or OTP. If she feels a session isn't the right fit after your first call, your ${intro} is refunded. We make no health promises.`,
  answerAbroad:
    `${hoursText("en")} Please check the time difference where you are. Calls are by phone, so you can join from anywhere. ` +
    "Payment is on Razorpay's secure page: UPI needs an Indian bank account, and cards may work. If paying doesn't work, tap \"Talk to a person\".",
  answerInPerson: "Calls and sessions are only by phone, so you can join from anywhere and nobody needs to travel. Shantha Rao is based in Bengaluru.",
  answerMedical:
    "Pranic healing is meant to support your wellbeing alongside your doctor's care, not replace it, so we never promise to treat any illness. " +
    "Please keep following your doctor's advice, and never stop or change a medicine without your doctor.",
  answerConcern:
    "We don't look into, confirm or remove anything like that. If you've been feeling stressed or unsettled, Shantha Rao can listen on a call " +
    "and tell you whether a calming session suits you. If you ever feel unsafe, please call 112.",
  answerPayment:
    "Sorry about this. Please don't pay again. If money was taken and no confirmation came, tap \"Talk to a person\" and our team will check. " +
    "When a payment fails, banks usually return the money on their own.",
  prohibitedLine: "We can't help with influencing or controlling another person. Our sessions are only about helping you feel calmer and steadier.",
  jobsLine: "This chat is only for booking calls with Shantha Rao. For anything else, tap \"Talk to a person\".",
  pageLateBody: "Our team will message you on WhatsApp about your time. You can close this page.",
  pageCheckTitle: "We're checking your payment",
  pageCheckBody: "Our team will message you on WhatsApp today. Please don't pay again.",
  pageOpeningTitle: "Opening Razorpay's secure payment page…",
  pageOpeningBody: "If it doesn't open in a moment, tap Continue.",
  pageBtnContinue: "Continue",
  amma: ammaEn,
};

const hi: Copy = {
  greeting: GREETING,
  chooseLanguage: CHOOSE_LANGUAGE,
  menuBody: "आप क्या करना चाहेंगे? आप अपना सवाल लिखकर भी पूछ सकते हैं।",
  btnBook: `${intro} कॉल बुक करें`,
  btnPackages: "सेशन और पैकेज",
  btnHelp: "मदद",
  btnPerson: "किसी से बात करें",
  changeLanguageRow: "भाषा बदलें",
  rowMyBookings: "मेरी बुकिंग",
  handoffAck: "धन्यवाद। हमारी टीम का कोई व्यक्ति आमतौर पर 24 घंटे के अंदर यहीं जवाब देगा।",
  humanWaitAck: "ठीक है। आपका मैसेज हमारी टीम तक पहुँच गया है, वे यहीं जवाब देंगे।",
  askPrompt: "कृपया अपना सवाल नीचे लिखें।",
  ack: "मैं बुकिंग असिस्टेंट हूँ और लिखे हुए सवालों का जवाब नहीं दे सकता। बुक करने के लिए नीचे दबाएँ, या \"किसी से बात करें\" चुनें।",
  bookSoon: "नई बुकिंग कुछ समय के लिए रुकी हुई है। कृपया एक-दो दिन बाद फिर मैसेज करें, या हमारी टीम से बात करने के लिए नीचे दबाएँ।",
  ageCheck: "क्या आपकी उम्र 18 साल या उससे ज़्यादा है?",
  btnYes: "हाँ",
  btnNo: "नहीं",
  ageNo: "कृपया अपने माता-पिता या अभिभावक से हमें मैसेज करने को कहें। वे आपके लिए कॉल बुक कर सकते हैं।",
  chooseService: "आप किस तरह का सेशन चाहेंगे?",
  btnHealing: serviceName("HEALING", "hi"),
  btnCleansing: serviceName("PROTECTION", "hi"),
  whoFor: "यह किसके लिए है?",
  btnMe: "मेरे लिए",
  btnFamily: "परिवार के लिए",
  btnPet: "पालतू जानवर के लिए",
  chooseDay: "कौन सा दिन आपके लिए ठीक रहेगा? (भारतीय समय)",
  listButtonDays: "दिन चुनें",
  rowDayBoth: "दोपहर और शाम का समय",
  rowDayAfternoon: "दोपहर का समय",
  rowDayEvening: "शाम का समय",
  timesFor: (day) => `${day} के लिए खाली समय (भारतीय समय)। हर कॉल ${config.slots.callMinutes} मिनट की होती है।`,
  sessionTimesFor: (day) => `${day} के लिए खाली समय (भारतीय समय)। हर सेशन ${config.slots.sessionMinutes} मिनट का होता है।`,
  sectionAfternoon: "दोपहर",
  sectionEvening: "शाम",
  rowCall: `${config.slots.callMinutes} मिनट की कॉल`,
  rowSession: `${config.slots.sessionMinutes} मिनट का सेशन`,
  anotherDay: "दूसरा दिन",
  listButtonTimes: "समय चुनें",
  noSlots: "अगले कुछ दिनों में कॉल का कोई खाली समय नहीं है। \"किसी से बात करें\" दबाएँ, या कल फिर देखें।",
  slotTaken: "माफ़ कीजिए, यह समय अभी-अभी बुक हो गया। कृपया दूसरा समय चुनें।",
  alreadyHolding: "आपके लिए एक समय पहले से रोका गया है। ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें।",
  callAlreadyBooked: (day, time) => `आपकी कॉल पहले से ${day} को ${time} बजे बुक है। शांता राव जी उसी समय आपको कॉल करेंगी।`,
  payBody: (day, time, until, link) =>
    `${day}, ${time} का समय आपके लिए ${until} बजे तक (भारतीय समय) रोका गया है।\n\n` +
    `नीचे "${intro} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें।\n\n` +
    `अगर बटन न खुले, तो यह लिंक खोलें: ${link}`,
  payLabel: `${intro} भुगतान करें`,
  payFailed: "माफ़ कीजिए, भुगतान लिंक नहीं बन पाया। कोई पैसा नहीं कटा है। कृपया फिर से कोशिश करें।",
  confirmed: (day, time, callLang) =>
    `हमें आपके ${intro} मिल गए हैं। शांता राव जी ${day} को ${time} बजे (भारतीय समय) आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। कॉल ${callLang === "hi" ? "हिंदी" : "अंग्रेज़ी"} में होगी। ` +
    "कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं।",
  btnChooseTime: "समय चुनें",
  sessionOfferBody: `शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन देना चाहेंगी। नीचे एक विकल्प चुनें: एक सेशन, या ${p10.sessions} या ${p20.sessions} सेशन का पैकेज।`,
  noSessionSlots: "अगले कुछ दिनों में सेशन का कोई खाली समय नहीं है। \"किसी से बात करें\" दबाएँ, या कल फिर देखें।",
  sessionNotAvailable: "माफ़ कीजिए, इस मैसेज से सेशन बुक नहीं हो सकता। हमारी टीम इसे देखेगी।",
  sessionPayBody: (day, time, until, link) =>
    `${day}, ${time} का समय आपके सेशन के लिए ${until} बजे तक (भारतीय समय) रोका गया है।\n\n` +
    `नीचे "${sessionPrice} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। कृपया दो बार भुगतान न करें।\n\n` +
    `अगर बटन न खुले, तो यह लिंक खोलें: ${link}`,
  sessionPayLabel: `${sessionPrice} भुगतान करें`,
  sessionConfirmed: (day, time, remind = true) =>
    `शांता राव जी के साथ आपका सेशन ${day} को ${time} बजे (भारतीय समय) तय हो गया है। ` +
    "यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। " +
    `कृपया किसी शांत जगह पर फ़ोन साथ रखें। ${remind ? "एक दिन पहले हम आपको याद दिलाएँगे।" : "कृपया समय नोट कर लें; अगर कुछ बदलता है तो हम यहीं मैसेज करेंगे।"}`,
  notFitRefund: `शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके ${intro} वापस किए जा रहे हैं। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है।`,
  missedOffer: "माफ़ कीजिए, हमारी बात नहीं हो पाई। अपनी कॉल के लिए नया समय चुनें। आपको कोई और भुगतान नहीं करना है।",
  rescheduled: (day, time) =>
    `आपकी कॉल अब ${day} को ${time} बजे (भारतीय समय) बुक है। शांता राव जी आपको उसी नंबर पर कॉल करेंगी जिससे आप मैसेज कर रहे हैं। ` +
    "कॉल किसी अनजान नंबर से आ सकती है, इसलिए कृपया फ़ोन पास रखें। आपको कोई और भुगतान नहीं करना है। यह WhatsApp नंबर सिर्फ़ मैसेज के लिए है, कॉल के लिए नहीं।",
  rescheduleNotAvailable: "माफ़ कीजिए, यह कॉल दोबारा नहीं बदली जा सकती। हमारी टीम इसे देखेगी।",
  missedFinal:
    "दूसरी बार भी आपसे बात नहीं हो पाई, इसलिए हम यह बुकिंग बंद कर रहे हैं। आपकी रुचि के लिए धन्यवाद। आप कभी भी हमें फिर से लिख सकते हैं।",
  reminderCall: (day, time) =>
    `याद दिला दें: शांता राव जी के साथ आपकी कॉल कल, ${day} को ${time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।`,
  reminderSession: (day, time) =>
    `याद दिला दें: शांता राव जी के साथ आपका सेशन कल, ${day} को ${time} बजे (भारतीय समय) है। कृपया फ़ोन अपने पास रखें।`,
  wordCall: "कॉल",
  wordSession: "सेशन",
  mediaNotice: "यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। कृपया अपना सवाल लिखें या नीचे कोई बटन दबाएँ।",
  mediaNoticeCustomer: "यहाँ सिर्फ़ लिखे हुए मैसेज पढ़े जा सकते हैं। अगर यह आपके भुगतान या बुकिंग के बारे में था, तो हमारी टीम देखकर यहीं जवाब देगी।",
  crisis:
    "हमें बहुत दुख है कि आप इस मुश्किल से गुज़र रहे हैं। आप अकेले नहीं हैं। कृपया अभी किसी से बात करें। टेली-मानस (Tele-MANAS) सरकार की मुफ़्त हेल्पलाइन है, जो हर दिन 24 घंटे खुली रहती है: " +
    "*14416* या *1-800-891-4416* पर कॉल करें। अगर आप या कोई और अभी खतरे में है, तो *112* पर कॉल करें। हमने अपनी टीम को बता दिया है, वे जल्द से जल्द आपको यहीं मैसेज करेंगे।",
  emergency: "यह इमरजेंसी लग रही है। कृपया तुरंत *112* पर, या एम्बुलेंस के लिए *108* पर कॉल करें, या सबसे नज़दीकी अस्पताल जाएँ।",
  quietClose: "लगता है हम इसमें मदद नहीं कर पाएँगे। अगर आप बाद में शांता राव जी के साथ कॉल बुक करना चाहें, तो बस *बुक* लिखें।",
  optOutConfirm: "ठीक है। अब हम आपको कोई मैसेज नहीं भेजेंगे। अगर आप फिर से लिखेंगे, तो हम जवाब देंगे।",
  flirtLine: "यह चैट सिर्फ़ बुकिंग के लिए है।",
  aiFallback: "माफ़ कीजिए, अभी इसका जवाब नहीं दिया जा सका। आप नीचे से कॉल बुक कर सकते हैं या किसी व्यक्ति से बात कर सकते हैं।",
  aiFallbackNoSell: "माफ़ कीजिए, अभी इसका जवाब नहीं दिया जा सका। आप नीचे से हमारी टीम के किसी व्यक्ति से बात कर सकते हैं।",
  btnSeeTimes: "कॉल का समय देखें",
  fallbackQuestion: `पूछने के लिए धन्यवाद। शांता राव जी ${intro} की छोटी कॉल पर इसे अच्छे से समझा सकती हैं, या आप हमारी टीम के किसी व्यक्ति से बात कर सकते हैं।`,
  fallbackConcern: "हमें दुख है कि आप इससे गुज़र रहे हैं। अगर आप चाहें, तो शांता राव जी एक छोटी कॉल पर आपकी बात सुन सकती हैं। कृपया अपने डॉक्टर की सलाह भी मानते रहें।",
  fallbackBooking: "हमारी टीम इसे देखकर यहीं आपको जवाब देगी।",
  fallbackOffTopic: "हम सिर्फ़ दिशा दिरा की कॉल और बुकिंग में मदद कर सकते हैं।",
  reprompt: (hint) => `${hint ? `${hint} ` : ""}कृपया नीचे दिए विकल्पों में से चुनें।`,
  hintDays: hintDaysText("hi"),
  repromptHelp: "अगर आप हमारी टीम के किसी व्यक्ति से बात करना चाहें, तो नीचे टैप करें।",
  callRequest: `इस WhatsApp नंबर पर हम कॉल नहीं लेते। शांता राव जी से बात करने का सबसे आसान तरीका ${intro} की ${config.slots.callMinutes} मिनट की कॉल है: आप समय चुनें, और वे आपको कॉल करेंगी।`,
  repromptQuestion: "पूछने के लिए धन्यवाद। शांता राव जी कॉल पर इसे समझा सकती हैं। जब आप तैयार हों, नीचे दिए विकल्पों में से चुनें।",
  alreadyBookedStart: (day, time) => `आपकी कॉल पहले से ${day} को ${time} बजे बुक है। शांता राव जी उसी समय कॉल करेंगी।`,
  btnKeep: "ठीक है",
  helpListBody: "हम कैसे मदद कर सकते हैं?",
  faqButton: "चुनें",
  faqTitles: {
    what_is_this: "यह क्या है?",
    how_it_works: "यह कैसे होता है",
    price: "फ़ीस",
    timings: "कॉल का समय",
    refund: "रिफ़ंड",
    privacy: "आपकी प्राइवेसी",
  },
  faqAnswers: {
    what_is_this:
      "दिशा दिरा में शांता राव जी, जो MCKS पद्धति में प्रशिक्षित सर्टिफ़ाइड प्राणिक हीलर हैं, फ़ोन पर बिना छुए प्राणिक हीलिंग करती हैं। " +
      `पहला कदम उनके साथ ${config.slots.callMinutes} मिनट की ${intro} की कॉल है।`,
    how_it_works:
      `1. कॉल का समय चुनें। 2. ${intro} का भुगतान करें। 3. शांता राव जी आपको ${config.slots.callMinutes} मिनट के लिए कॉल करेंगी। ` +
      "4. अगर आप दोनों को ठीक लगे, तो आप पूरा सेशन या पैकेज बुक कर सकते हैं।",
    price:
      `पहली कॉल ${intro} की है। एक सेशन ${sessionPrice} का है। ` +
      `पैकेज: ${p10.sessions} सेशन ${packPrice(p10.sessions)} में (${perSession(p10)} प्रति सेशन) या ${p20.sessions} सेशन ${packPrice(p20.sessions)} में (${perSession(p20)} प्रति सेशन), कोई समय-सीमा नहीं।`,
    timings: hoursText("hi"),
    refund:
      `अगर पहली कॉल के बाद शांता राव जी को लगे कि यह आपके लिए सही नहीं है, तो आपके ${intro} वापस कर दिए जाते हैं। ` +
      `एक सेशन का समय ${rules.changeBeforeHours} घंटे पहले तक एक बार बदला जा सकता है, और ${rules.singleRefundBeforeHours} घंटे या उससे पहले रद्द करने पर पूरे पैसे वापस मिलते हैं। ` +
      `पैकेज का सेशन ${rules.changeBeforeHours} घंटे या उससे पहले बदलने या रद्द करने पर आपके पैकेज में वापस जुड़ जाता है। ` +
      "अगर हमें कॉल रद्द करनी पड़े, तब भी पैसे वापस मिलते हैं।",
    privacy:
      "हम सिर्फ़ आपका नाम, WhatsApp नंबर, बुकिंग और भुगतान की जानकारी रखते हैं। चैट के मैसेज आख़िरी मैसेज के 7 दिन बाद मिटा दिए जाते हैं। " +
      "कृपया यहाँ सेहत से जुड़ी जानकारी या रिपोर्ट न भेजें।",
  },
  // सेशन और पैकेज (ticket 13)
  packagesBody: "हर सेशन 60 मिनट का होता है, फ़ोन पर। एक विकल्प चुनें। ज़्यादातर लोग ₹99 की कॉल से शुरू करते हैं, ताकि शांता राव जी बता सकें कि उनके लिए क्या ठीक रहेगा।",
  packagesButton: "विकल्प देखें",
  rowIntroTitle: `${intro} पहली कॉल`,
  rowIntroDesc: `शांता राव जी से ${config.slots.callMinutes} मिनट`,
  rowSingleTitle: "एक सेशन",
  rowSingleDesc: sessionPrice,
  rowPack10Title: `${p10.sessions} सेशन`,
  rowPack10Desc: `${packPrice(p10.sessions)} · ${perSession(p10)} प्रति सेशन · कोई समय-सीमा नहीं`,
  rowPack20Title: `${p20.sessions} सेशन`,
  rowPack20Desc: `${packPrice(p20.sessions)} · ${perSession(p20)} प्रति सेशन · कोई समय-सीमा नहीं`,
  softGate:
    `ज़्यादातर लोग पहले ${intro} की कॉल करते हैं, ताकि शांता राव जी आपकी ज़रूरत समझ सकें। क्या आप ऐसा करना चाहेंगे, या आगे बढ़ें?`,
  btnContinue: "आगे बढ़ें",
  packPayBody: (n, price, until, link) =>
    `${n} सेशन ${price} में। भुगतान के बाद आप जब चाहें हर सेशन बुक कर सकते हैं, हर बार भुगतान नहीं करना होगा।\n\n` +
    `नीचे "${price} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। किसी भी UPI ऐप, कार्ड या नेट बैंकिंग से भुगतान करें। यह लिंक ${until} बजे तक (भारतीय समय) खुला है। कृपया दो बार भुगतान न करें।\n\n` +
    `अगर बटन न खुले, तो यह लिंक खोलें: ${link}`,
  packPayLabel: (price) => `${price} भुगतान करें`,
  packPending: "पैकेज का भुगतान लिंक पहले से खुला है। कृपया ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें।",
  packConfirmed: (n) => `भुगतान मिल गया। आपके पास ${n} सेशन हैं। क्या अभी पहला सेशन बुक करें?`,
  btnBookSession: "सेशन बुक करें",
  creditBooked: (day, time, left) => `आपका सेशन ${day} को ${time} बजे (भारतीय समय) बुक हो गया है। शांता राव जी उसी समय कॉल करेंगी। बचे हुए सेशन: ${left}।`,
  maxUpcoming: `आपके ${rules.maxUpcoming} सेशन पहले से बुक हैं। उनमें से एक होने के बाद आप अगला बुक कर सकते हैं।`,
  noCredits: "आपके पैकेज में कोई सेशन नहीं बचा है। आप \"सेशन और पैकेज\" से एक सेशन या नया पैकेज ले सकते हैं।",
  creditsLeft: (left) => `पैकेज में बचे सेशन: ${left}।`,
  myBookingsBody: (list, left) => `आपकी बुकिंग: ${list}। पैकेज में बचे सेशन: ${left}।`,
  myBookingsNoPack: (list) => `आपकी बुकिंग: ${list}।`,
  myBookingsNone: "आपकी कोई आने वाली बुकिंग नहीं है।",
  bookingItem: (word, day, time) => `${word}, ${day} को ${time} बजे`,
  sessionActions: (day, time) => `${day} को ${time} बजे आपका सेशन। आप क्या करना चाहेंगे?`,
  btnMove: "समय बदलें",
  btnCancel: "रद्द करें",
  bookingNotFound: "माफ़ कीजिए, वह बुकिंग नहीं मिली। शायद वह बदल गई है। कृपया \"मेरी बुकिंग\" फिर से खोलें।",
  moveTooLate: `माफ़ कीजिए, सेशन का समय सिर्फ़ ${rules.changeBeforeHours} घंटे पहले तक बदला या रद्द किया जा सकता है।`,
  moveOnlyOnce: "इस सेशन का समय एक बार बदला जा चुका है, इसलिए इसे दोबारा नहीं बदला जा सकता। मदद चाहिए तो कृपया हमारी टीम के किसी व्यक्ति से बात करें।",
  moved: (day, time) => `हो गया। आपका सेशन अब ${day} को ${time} बजे (भारतीय समय) है।`,
  cancelledCredit: (left) => `रद्द हो गया। सेशन आपके पैकेज में वापस जुड़ गया है। बचे हुए सेशन: ${left}।`,
  cancelledSingleRefund: `रद्द हो गया। क्योंकि यह ${rules.singleRefundBeforeHours} घंटे या उससे पहले था, पूरी राशि आपके भुगतान के तरीके में वापस कर दी जाएगी।`,
  cancelledSingleNoRefund: `${rules.changeBeforeHours} से ${rules.singleRefundBeforeHours} घंटे पहले, एक सेशन का पैसा वापस नहीं होता, लेकिन आप एक बार समय बदल सकते हैं। क्या समय बदलें?`,
  notFitRefundSession: (amount) =>
    `शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी यह आपके लिए सही नहीं है, इसलिए आपके ${amount} वापस किए जा रहे हैं। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है।`,
  packRefunded: (amount) => `आपके बिना इस्तेमाल हुए सेशन के ${amount} वापस कर दिए गए हैं। यह राशि आपके भुगतान के तरीके में लौटेगी।`,
  payNudge: (until, link) =>
    `आपका समय अभी ${until} बजे तक (भारतीय समय) रोका गया है। यहाँ भुगतान करें: ${link}\n\nभुगतान में दिक्कत हो रही है? HELP या मदद लिखकर भेजें, हम आपकी मदद करेंगे।`,
  pageBrand: "दिशा दिरा",
  pageBtnWhatsApp: "WhatsApp पर वापस जाएँ",
  pagePaidTitle: "भुगतान मिल गया",
  pagePaidBody: "आपकी बुकिंग तय हो गई है; पूरी जानकारी WhatsApp पर है। आप यह पेज बंद कर सकते हैं।",
  pagePaidPackBody: "आपके सेशन आपके पैकेज में जुड़ गए हैं; पूरी जानकारी WhatsApp पर है। आप यह पेज बंद कर सकते हैं।",
  pageExpiredTitle: "इस भुगतान लिंक का समय खत्म हो गया है",
  pageExpiredBody: "आपका समय अब रोका हुआ नहीं है। WhatsApp पर वापस जाएँ और फिर से \"बुक करें\" दबाएँ।",
  pageExpiredPackBody: "WhatsApp पर वापस जाएँ और पैकेज फिर से चुनें।",
  pageNotFoundTitle: "लिंक नहीं मिला",
  pageNotFoundBody: "यह भुगतान लिंक सही नहीं है। कृपया WhatsApp पर वापस जाएँ और सबसे नए भुगतान मैसेज का लिंक खोलें।",
  pageErrorTitle: "कृपया फिर से कोशिश करें",
  pageErrorBody: "अभी भुगतान पेज नहीं खुल पाया। कृपया एक मिनट बाद लिंक फिर से खोलें।",
  // ticket 31
  timePassed: "माफ़ कीजिए, यह समय बहुत पास है या निकल चुका है। कृपया दूसरा समय चुनें।",
  stillHeld: (day, time, until, link) =>
    `${day}, ${time} का समय आपके लिए ${until} बजे तक (भारतीय समय) रोका हुआ है। भुगतान के बाद ही बुकिंग पक्की होगी।\n\n` +
    `नीचे "${intro} भुगतान करें" बटन दबाएँ, Razorpay का सुरक्षित भुगतान पेज खुलेगा। कृपया दो बार भुगतान न करें।\n\n` +
    `अगर बटन न खुले, तो यह लिंक खोलें: ${link}`,
  dupRefund: (amount) => `हमें गलती से ${amount} का दूसरा भुगतान मिला, इसलिए उसे वापस किया जा रहा है। यह आमतौर पर 5–7 कामकाजी दिनों में आपके खाते में आ जाता है।`,
  dupKeeps: (day, time) => `आपकी बुकिंग ${day} को ${time} बजे (भारतीय समय) ही रहेगी।`,
  latePaidTaken: (amount) =>
    `हमें आपके ${amount} मिल गए हैं, लेकिन रोकने का समय खत्म होने के बाद आपका चुना हुआ समय किसी और ने बुक कर लिया। हमारी टीम आज ही यहीं आपको नया समय या पूरा रिफ़ंड देगी।`,
  checkingPayment: "हमें एक भुगतान मिला है जिसे हमें जाँचना है। हमारी टीम आज ही इसे ठीक करके यहीं जवाब देगी। कृपया दोबारा भुगतान न करें।",
  holdReleased: "आपके लिए रोका गया समय छोड़ दिया गया है। कोई पैसा नहीं कटा। फिर से समय चुनने के लिए नीचे दबाएँ।",
  handbackNotice: "माफ़ कीजिए, हम समय पर जवाब नहीं दे पाए। आप नीचे से बुक कर सकते हैं, या फिर से किसी व्यक्ति से बात करने को कह सकते हैं।",
  answerCall:
    `पहली कॉल ${config.slots.callMinutes} मिनट की होती है, फ़ोन पर, आपके चुने हुए समय पर। शांता राव जी खुद आपको कॉल करती हैं, आपकी बात सुनती हैं, ` +
    "और बताती हैं कि वे कैसे काम करती हैं और क्या पूरा सेशन आपके लिए ठीक रहेगा। कॉल उसी भाषा में होती है जिसमें आप चैट करते हैं, अंग्रेज़ी या हिंदी।",
  answerTrust:
    "यह सही सवाल है। शांता राव जी MCKS पद्धति में प्रशिक्षित सर्टिफ़ाइड प्राणिक हीलर हैं। भुगतान सिर्फ़ Razorpay के सुरक्षित पेज पर होता है, " +
    `और हम कभी आपका PIN या OTP नहीं माँगते। अगर पहली कॉल के बाद उन्हें लगे कि सेशन आपके लिए सही नहीं है, तो आपके ${intro} वापस कर दिए जाते हैं। हम सेहत को लेकर कोई वादा नहीं करते।`,
  answerAbroad:
    `${hoursText("hi")} कृपया अपने यहाँ के समय का अंतर देख लें। कॉल फ़ोन पर होती है, इसलिए आप कहीं से भी जुड़ सकते हैं। ` +
    "भुगतान Razorpay के सुरक्षित पेज पर होता है: UPI के लिए भारतीय बैंक खाता चाहिए, कार्ड से भुगतान हो सकता है। अगर भुगतान न हो पाए, तो \"किसी से बात करें\" दबाएँ।",
  answerInPerson: "कॉल और सेशन सिर्फ़ फ़ोन पर होते हैं, इसलिए आप कहीं से भी जुड़ सकते हैं और कहीं जाना नहीं पड़ता। शांता राव जी बेंगलुरु में रहती हैं।",
  answerMedical:
    "प्राणिक हीलिंग डॉक्टर के इलाज के साथ आपकी सेहत को सहारा देने के लिए है, उसकी जगह नहीं, इसलिए हम किसी बीमारी के इलाज का वादा नहीं करते। " +
    "कृपया अपने डॉक्टर की सलाह मानते रहें, और डॉक्टर से पूछे बिना कोई दवा बंद न करें या न बदलें।",
  answerConcern:
    "हम ऐसी किसी बात की जाँच, पुष्टि या उसे हटाने का काम नहीं करते। अगर आप तनाव या बेचैनी महसूस कर रहे हैं, तो शांता राव जी एक कॉल पर आपकी बात सुनकर " +
    "बता सकती हैं कि क्या एक शांत करने वाला सेशन आपके लिए ठीक रहेगा। अगर आप कभी असुरक्षित महसूस करें, तो 112 पर कॉल करें।",
  answerPayment:
    "इसके लिए माफ़ कीजिए। कृपया दोबारा भुगतान न करें। अगर पैसे कट गए और पुष्टि का मैसेज नहीं आया, तो \"किसी से बात करें\" दबाएँ, हमारी टीम जाँच करेगी। " +
    "भुगतान फेल होने पर बैंक आमतौर पर पैसे खुद लौटा देते हैं।",
  prohibitedLine: "हम किसी दूसरे व्यक्ति को प्रभावित करने या उस पर काबू करने में मदद नहीं कर सकते। हमारे सेशन सिर्फ़ आपको शांत और स्थिर महसूस कराने के लिए हैं।",
  jobsLine: "यह चैट सिर्फ़ शांता राव जी के साथ कॉल बुक करने के लिए है। किसी और बात के लिए \"किसी से बात करें\" दबाएँ।",
  pageLateBody: "आपके समय के बारे में हमारी टीम WhatsApp पर मैसेज करेगी। आप यह पेज बंद कर सकते हैं।",
  pageCheckTitle: "हम आपका भुगतान जाँच रहे हैं",
  pageCheckBody: "हमारी टीम आज ही WhatsApp पर मैसेज करेगी। कृपया दोबारा भुगतान न करें।",
  pageOpeningTitle: "Razorpay का सुरक्षित भुगतान पेज खुल रहा है…",
  pageOpeningBody: "अगर यह थोड़ी देर में न खुले, तो \"आगे बढ़ें\" दबाएँ।",
  pageBtnContinue: "आगे बढ़ें",
  amma: ammaEn, // Amma's page copy stays English
};

return { en, hi };
}

// The copy at config's prices (what tests and docs/COPY.md compare against), and the copy at the prices in force.
export const allCopy: Record<Lang, Copy> = buildCopy(DEFAULT_PRICES);
const built = new Map<string, Record<Lang, Copy>>([[JSON.stringify(DEFAULT_PRICES), allCopy]]);

export function copyFor(locale: string | null | undefined): Copy {
  const p = prices();
  const key = JSON.stringify(p);
  let c = built.get(key);
  if (!c) built.set(key, (c = buildCopy(p)));
  return c[langOf(locale)];
}
