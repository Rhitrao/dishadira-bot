// ALL customer-facing text lives here, in English and Hindi (wording: docs/KNOWLEDGE.md §10 and §11; the full list for review: docs/COPY.md).
// Prices, durations and the hold time are built from config, never typed in. Both languages must have exactly the same keys (test/copy.test.ts).
// Rules: never name an illness, never promise results, never ask for health details.
import { config } from "./config";

export type Lang = "en" | "hi";
export type FaqId = (typeof config.faqIds)[number];
export type ForWhom = "SELF" | "FAMILY" | "PET";

// Any locale we do not know (an old row, a typo) reads as English.
export const langOf = (locale: string | null | undefined): Lang => (locale === "hi" ? "hi" : "en");

const rupees = (paise: number) => `₹${paise / 100}`;
const intro = rupees(config.prices.introPaise);
const sessionPrice = rupees(config.prices.sessionPaise);

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
  callLang: Record<Lang, string>; // the language of the call, next to the name
  forWhom: Record<ForWhom, string>; // who the call is for, next to the name
};

export type Copy = {
  greeting: string; // the same bilingual message in both languages
  chooseLanguage: string; // same in both languages
  menuBody: string;
  btnBook: string; // max 20 chars
  btnHow: string; // max 20 chars
  btnPerson: string; // max 20 chars
  changeLanguageRow: string; // max 24 chars (a list row)
  handoffAck: string;
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
  payBody: (day: string, time: string) => string;
  payLabel: string; // max 20 chars
  payFailed: string;
  confirmed: (day: string, time: string, callLang: Lang, businessNumber: string) => string;
  // outcomes and the session
  btnChooseTime: string; // max 20 chars
  sessionOfferBody: string;
  noSessionSlots: string;
  sessionNotAvailable: string;
  sessionPayBody: (day: string, time: string) => string;
  sessionPayLabel: string; // max 20 chars
  sessionConfirmed: (day: string, time: string) => string;
  notFitRefund: string;
  missedOffer: string;
  rescheduled: (day: string, time: string, businessNumber: string) => string;
  rescheduleNotAvailable: string;
  missedFinal: string;
  reminderCall: (day: string, time: string) => string;
  reminderSession: (day: string, time: string) => string;
  wordCall: string; // template parameter
  wordSession: string; // template parameter
  mediaNotice: string;
  mediaNoticeCustomer: string;
  faqBody: string;
  faqButton: string; // max 20 chars
  faqTitles: Record<FaqId, string>; // max 24 chars each
  faqAnswers: Record<FaqId, string>;
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
  kindSession: `Session ${sessionPrice}`,
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
  btnHow: "How it works",
  btnPerson: "Talk to a person",
  changeLanguageRow: "Change language",
  handoffAck: "Thank you. A person from our team will reply here, usually within 24 hours.",
  askPrompt: "Please type your question below.",
  ack: "Thanks, a person will reply within 24 hours.",
  bookSoon: "Booking opens soon.",
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
  timesFor: (day) => `Free times on ${day} (India time). Each call is ${config.slots.callMinutes} minutes.`,
  sessionTimesFor: (day) => `Free times on ${day} (India time). Each session is ${config.slots.sessionMinutes} minutes.`,
  sectionAfternoon: "Afternoon",
  sectionEvening: "Evening",
  rowCall: `${config.slots.callMinutes}-min call`,
  rowSession: `${config.slots.sessionMinutes}-min session`,
  anotherDay: "Another day",
  listButtonTimes: "Choose a time",
  noSlots: "There are no free call times right now. Please check again later.",
  slotTaken: "Sorry, that time was just taken. Please choose another.",
  alreadyHolding: "A time is already held for you. Please use the payment button above, or try again in a few minutes.",
  callAlreadyBooked: (day, time) => `Your call is already booked for ${day} at ${time}. Shantha Rao will call you then.`,
  payBody: (day, time) =>
    `${day} at ${time} is held for you for ${config.holdMinutes} minutes. Tap below to pay ${intro} and confirm. Please don't pay twice.`,
  payLabel: `Pay ${intro}`,
  payFailed: "Sorry, we couldn't create the payment link. Nothing was charged. Please try again.",
  confirmed: (day, time, callLang, number) =>
    `Received your ${intro}. Shantha Rao will call you on ${day} at ${time} from ${number}. Call in ${callLang === "hi" ? "Hindi" : "English"}. ` +
    "That number is for her calls only, so please message us here.",
  btnChooseTime: "Choose a time",
  sessionOfferBody: `Thank you for speaking with Shantha Rao. She would be glad to offer you a full session (${sessionPrice}). Tap below to choose a time.`,
  noSessionSlots: "There are no free session times right now. We will message you when new times are open.",
  sessionNotAvailable: "Sorry, we cannot book a session from this message. A person will look into it.",
  sessionPayBody: (day, time) =>
    `${day} at ${time} is held for your session for ${config.holdMinutes} minutes. Tap below to pay ${sessionPrice} and confirm. Please don't pay twice.`,
  sessionPayLabel: `Pay ${sessionPrice}`,
  sessionConfirmed: (day, time) =>
    `Your session with Shantha Rao is confirmed for ${day} at ${time} (India time). ` +
    "It is a distance session: you stay where you are and she calls you at the booked time. " +
    "Please keep your phone with you in a quiet place. We will remind you the day before.",
  notFitRefund: `Thank you for speaking with Shantha Rao. She feels a session isn't the right fit just now, so we've refunded your ${intro}.`,
  missedOffer: "Sorry we missed each other. Choose a new time for your call. There is nothing more to pay.",
  rescheduled: (day, time, number) =>
    `Your call is now booked for ${day} at ${time}. Shantha Rao will call you from ${number}. There is nothing more to pay.`,
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
      `Disha Dira offers ${serviceName("PROTECTION", "en").toLowerCase()} and ${serviceName("HEALING", "en").toLowerCase()} sessions with Shantha Rao. ` +
      "You can first book a short call to speak with her.",
    how_it_works:
      `1. Pick a call time. 2. Pay ${intro}. ` +
      `3. Shantha Rao calls you for ${config.slots.callMinutes} minutes. ` +
      "4. If you both agree, you can book a full session.",
    price: `The first call is ${intro}. A full session is ${sessionPrice}.`,
    timings: hoursText("en"),
    refund:
      `If Shantha Rao feels the call is not the right fit, your ${intro} is refunded. ` +
      "If we have to cancel, you are refunded too.",
    privacy:
      "We keep only your name, WhatsApp number, bookings and payments. Please do not share health details here.",
  },
  amma: ammaEn,
};

const hi: Copy = {
  greeting: GREETING,
  chooseLanguage: CHOOSE_LANGUAGE,
  menuBody: "आप क्या करना चाहेंगे? आप अपना सवाल लिखकर भी पूछ सकते हैं।",
  btnBook: `${intro} कॉल बुक करें`,
  btnHow: "यह कैसे काम करता है",
  btnPerson: "किसी से बात करें",
  changeLanguageRow: "भाषा बदलें",
  handoffAck: "धन्यवाद। हमारी टीम का कोई व्यक्ति आमतौर पर 24 घंटे के अंदर यहीं जवाब देगा।",
  askPrompt: "कृपया अपना सवाल नीचे लिखें।",
  ack: "धन्यवाद। हमारी टीम का कोई व्यक्ति 24 घंटे के अंदर यहीं जवाब देगा।",
  bookSoon: "बुकिंग जल्द शुरू होगी।",
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
  timesFor: (day) => `${day} के लिए खाली समय (भारतीय समय)। हर कॉल ${config.slots.callMinutes} मिनट की होती है।`,
  sessionTimesFor: (day) => `${day} के लिए खाली समय (भारतीय समय)। हर सेशन ${config.slots.sessionMinutes} मिनट का होता है।`,
  sectionAfternoon: "दोपहर",
  sectionEvening: "शाम",
  rowCall: `${config.slots.callMinutes} मिनट की कॉल`,
  rowSession: `${config.slots.sessionMinutes} मिनट का सेशन`,
  anotherDay: "दूसरा दिन",
  listButtonTimes: "समय चुनें",
  noSlots: "अभी कॉल का कोई खाली समय नहीं है। कृपया थोड़ी देर बाद फिर देखें।",
  slotTaken: "माफ़ कीजिए, यह समय अभी-अभी बुक हो गया। कृपया दूसरा समय चुनें।",
  alreadyHolding: "आपके लिए एक समय पहले से रोका गया है। ऊपर दिए भुगतान बटन का इस्तेमाल करें, या कुछ मिनट बाद फिर कोशिश करें।",
  callAlreadyBooked: (day, time) => `आपकी कॉल पहले से ${day} को ${time} बजे बुक है। शांता राव जी उसी समय आपको कॉल करेंगी।`,
  payBody: (day, time) =>
    `${day}, ${time} का समय आपके लिए ${config.holdMinutes} मिनट तक रोका गया है। बुकिंग पूरी करने के लिए नीचे ${intro} का भुगतान करें। कृपया दो बार भुगतान न करें।`,
  payLabel: `${intro} भुगतान करें`,
  payFailed: "माफ़ कीजिए, भुगतान लिंक नहीं बन पाया। कोई पैसा नहीं कटा है। कृपया फिर से कोशिश करें।",
  confirmed: (day, time, callLang, number) =>
    `हमें आपके ${intro} मिल गए हैं। शांता राव जी ${day} को ${time} बजे ${number} से आपको कॉल करेंगी। कॉल ${callLang === "hi" ? "हिंदी" : "अंग्रेज़ी"} में होगी। ` +
    "वह नंबर सिर्फ़ उनकी कॉल के लिए है, इसलिए मैसेज यहीं भेजें।",
  btnChooseTime: "समय चुनें",
  sessionOfferBody: `शांता राव जी से बात करने के लिए धन्यवाद। वे आपको पूरा सेशन (${sessionPrice}) देना चाहेंगी। समय चुनने के लिए नीचे टैप करें।`,
  noSessionSlots: "अभी सेशन का कोई खाली समय नहीं है। नए समय खुलते ही हम आपको मैसेज करेंगे।",
  sessionNotAvailable: "माफ़ कीजिए, इस मैसेज से सेशन बुक नहीं हो सकता। हमारी टीम इसे देखेगी।",
  sessionPayBody: (day, time) =>
    `${day}, ${time} का समय आपके सेशन के लिए ${config.holdMinutes} मिनट तक रोका गया है। बुकिंग पूरी करने के लिए नीचे ${sessionPrice} का भुगतान करें। कृपया दो बार भुगतान न करें।`,
  sessionPayLabel: `${sessionPrice} भुगतान करें`,
  sessionConfirmed: (day, time) =>
    `शांता राव जी के साथ आपका सेशन ${day} को ${time} बजे (भारतीय समय) तय हो गया है। ` +
    "यह दूर से होने वाला सेशन है: आप जहाँ हैं वहीं रहें, वे तय समय पर आपको कॉल करेंगी। " +
    "कृपया किसी शांत जगह पर फ़ोन साथ रखें। एक दिन पहले हम आपको याद दिलाएँगे।",
  notFitRefund: `शांता राव जी से बात करने के लिए धन्यवाद। उन्हें लगता है कि अभी सेशन आपके लिए सही नहीं है, इसलिए आपके ${intro} वापस कर दिए गए हैं।`,
  missedOffer: "माफ़ कीजिए, हमारी बात नहीं हो पाई। अपनी कॉल के लिए नया समय चुनें। आपको कोई और भुगतान नहीं करना है।",
  rescheduled: (day, time, number) =>
    `आपकी कॉल अब ${day} को ${time} बजे बुक है। शांता राव जी ${number} से कॉल करेंगी। आपको कोई और भुगतान नहीं करना है।`,
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
  faqBody: "एक विषय चुनें।",
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
      `दिशा दिरा में शांता राव जी के साथ ${serviceName("HEALING", "hi")} और ${serviceName("PROTECTION", "hi")} सेशन होते हैं। ` +
      "शुरुआत में आप उनसे बात करने के लिए एक छोटी कॉल बुक कर सकते हैं।",
    how_it_works:
      `1. कॉल का समय चुनें। 2. ${intro} का भुगतान करें। 3. शांता राव जी आपको ${config.slots.callMinutes} मिनट के लिए कॉल करेंगी। ` +
      "4. अगर आप दोनों को ठीक लगे, तो आप पूरा सेशन बुक कर सकते हैं।",
    price: `पहली कॉल ${intro} की है। पूरा सेशन ${sessionPrice} का है।`,
    timings: hoursText("hi"),
    refund:
      `अगर पहली कॉल के बाद शांता राव जी को लगे कि यह आपके लिए सही नहीं है, तो आपके ${intro} वापस कर दिए जाते हैं। ` +
      "अगर हमें कॉल रद्द करनी पड़े, तब भी पैसे वापस मिलते हैं।",
    privacy:
      "हम सिर्फ़ आपका नाम, WhatsApp नंबर, बुकिंग और भुगतान की जानकारी रखते हैं। चैट के मैसेज आख़िरी मैसेज के 30 दिन बाद मिटा दिए जाते हैं। " +
      "कृपया यहाँ सेहत से जुड़ी जानकारी या रिपोर्ट न भेजें।",
  },
  amma: ammaEn, // Amma's page copy stays English
};

export const allCopy: Record<Lang, Copy> = { en, hi };

export function copyFor(locale: string | null | undefined): Copy {
  return allCopy[langOf(locale)];
}
