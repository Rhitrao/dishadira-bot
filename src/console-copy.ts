// Every word the console (/app) shows, in English and Hindi, chosen by the member's `locale` ("hi" = Hindi, anything else = English).
// No names here: the business name and people's names come from settings and data. No internal codes either ("HUMAN", "SENDS"):
// each line says what it means for a customer. Amounts and times are passed in already formatted.
// The Hindi is plain spoken Hindi with the English words people use anyway (कॉल, सेशन, पेमेंट); a native speaker reviews it before Phase 2.

export type ConsoleLang = "en" | "hi";
export const consoleLang = (locale: string | null | undefined): ConsoleLang => (locale === "hi" ? "hi" : "en");

const en = {
  // The page frame
  navLabel: "Console",
  skipToContent: "Skip to the main part",
  tabToday: "Today",
  tabInbox: "Inbox",
  tabCalendar: "Calendar",
  tabPeople: "People",
  tabPayments: "Payments",
  tabSettings: "Settings",
  tabMore: "More",
  // The language switch shows the other language in its own script.
  otherLanguage: "हिन्दी",
  switchLanguage: "Show the console in Hindi",
  searchLabel: "Search people",
  searchPlaceholder: "Name or last 4 digits",
  searchButton: "Search",
  backToList: "Back to the list",
  pickOne: "Pick one from the list to see it here.",
  waitingCount: (n: number) => (n === 1 ? "1 waiting" : `${n} waiting`),

  // Screen titles: each is the question the screen answers.
  qToday: "What needs me now?",
  qInbox: "Who is waiting for a reply?",
  qCalendar: "When am I booked or free?",
  qPeople: "Who is this customer?",
  qPayments: "Is the money right?",
  qSettings: "How does the business run?",
  visibleTo: (roles: string) => `Visible to: ${roles}`,
  roleOWNER: "Owner",
  rolePRACTITIONER: "Practitioner",
  roleSTAFF: "Staff",

  // Today
  secSafety: "Safety",
  secWaiting: "Waiting for a reply",
  secApprovals: "Approvals",
  secUpNext: "Up next",
  secLater: "Later",
  secLooseEnds: "Loose ends",
  safetySent: "The safety message was sent",
  askedForPerson: (ago: string) => `Asked for a person, ${ago}`,
  replyBy: (time: string) => `Reply by ${time}`,
  windowClosed: "WhatsApp only allows a follow-up message now",
  tomorrowCalls: (n: number) => (n === 1 ? "Tomorrow: 1 call" : `Tomorrow: ${n} calls`),
  noCallsToday: (next: string) => `No calls today. Next: ${next}.`,
  noCallsBooked: "No calls booked yet.",
  openCalendar: "Open the calendar",
  howDidItGo: "How did it go?",
  outcomeSession: "Book a session for them",
  outcomeNotFit: (amount: string) => `Not a fit (${amount} refunded)`,
  outcomeMissed: "Didn't pick up (offer a new time)",
  savedUndoUntil: (time: string) => `Saved. Undo until ${time}`,
  tooLateToUndo: "Too late to undo",
  alreadyMarked: (outcome: string, who: string, time: string) => `Already marked: ${outcome}, by ${who} at ${time}`,
  byYou: "you",
  reportBehaviour: "Report behaviour",

  // Who a booking is for, and the language of the call
  forSELF: "For themselves",
  forFAMILY: "For family",
  forPET: "For a pet",
  callIn: (lang: string) => `Call in ${lang}`,
  langEnglish: "English",
  langHindi: "Hindi",

  // Buttons
  call: "Call",
  open: "Open",
  openChat: "Open chat",
  reply: "Reply",
  handBack: "Hand back to the bot",
  approve: "Approve",
  decline: "Decline",
  undo: "Undo",
  tryAgain: "Try again",

  // Status words: a booking, then a payment
  bookingHeld: "Held",
  bookingConfirmed: "Confirmed",
  bookingDone: "Done",
  bookingMissed: "Missed",
  bookingCancelled: "Cancelled",
  payPaid: "Paid",
  payWaiting: "Waiting",
  payFailed: "Failed",
  payRefunding: "Refund on its way",
  payRefunded: "Refunded",
  payCheck: "Check with Razorpay",

  // Who sent a message in a chat
  fromCustomer: "Customer",
  fromBot: "Bot",
  fromAssistant: "Assistant",
  fromSafety: "Safety message",
  safetyHidden: "A safety message. An owner is needed.",

  // Banners: only for things that affect everyone, each with its fix
  bannerPaused: "Bookings are paused",
  fixPaused: "Turn bookings on",
  bannerPayments: "Payments are failing",
  fixPayments: "See the payments",
  bannerBot: "The bot hasn't run for 15 minutes",
  fixBot: "See what's wrong",

  // Failures and refusals
  noAccess: "No access",
  noAccessBody: "This email isn't a member here. Ask the owner to invite you.",
  notSaved: "That didn't save. Nothing changed. Please try again.",
  razorpayDown: "Razorpay didn't respond. Nothing was charged or refunded. Try again in a minute.",
  notDelivered: "Message not delivered",

  // Times
  today: "today",
  tomorrow: "tomorrow",
};

export type ConsoleCopy = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : string };

const hi: ConsoleCopy = {
  navLabel: "कंसोल",
  skipToContent: "सीधे मुख्य हिस्से पर जाएँ",
  tabToday: "आज",
  tabInbox: "इनबॉक्स",
  tabCalendar: "कैलेंडर",
  tabPeople: "लोग",
  tabPayments: "पेमेंट",
  tabSettings: "सेटिंग्स",
  tabMore: "और",
  otherLanguage: "English",
  switchLanguage: "कंसोल अंग्रेज़ी में दिखाएँ",
  searchLabel: "लोगों को खोजें",
  searchPlaceholder: "नाम या आख़िरी 4 अंक",
  searchButton: "खोजें",
  backToList: "सूची पर वापस",
  pickOne: "यहाँ देखने के लिए सूची में से कोई चुनें।",
  waitingCount: (n) => `${n} इंतज़ार में`,

  qToday: "अभी मुझे क्या करना है?",
  qInbox: "किसे जवाब का इंतज़ार है?",
  qCalendar: "मैं कब व्यस्त हूँ, कब खाली?",
  qPeople: "यह ग्राहक कौन है?",
  qPayments: "क्या पैसों का हिसाब सही है?",
  qSettings: "काम कैसे चलता है?",
  visibleTo: (roles) => `कौन देख सकता है: ${roles}`,
  roleOWNER: "मालिक",
  rolePRACTITIONER: "प्रैक्टिशनर",
  roleSTAFF: "स्टाफ़",

  secSafety: "सुरक्षा",
  secWaiting: "जवाब का इंतज़ार",
  secApprovals: "मंज़ूरी",
  secUpNext: "आगे क्या है",
  secLater: "बाद में",
  secLooseEnds: "बचे हुए काम",
  safetySent: "सुरक्षा संदेश भेज दिया गया है",
  askedForPerson: (ago) => `किसी व्यक्ति से बात करना चाहते हैं, ${ago}`,
  replyBy: (time) => `${time} तक जवाब दें`,
  windowClosed: "अब WhatsApp पर सिर्फ़ फ़ॉलो-अप संदेश भेजा जा सकता है",
  tomorrowCalls: (n) => `कल: ${n} कॉल`,
  noCallsToday: (next) => `आज कोई कॉल नहीं। अगली: ${next}।`,
  noCallsBooked: "अभी कोई कॉल बुक नहीं है।",
  openCalendar: "कैलेंडर खोलें",
  howDidItGo: "कॉल कैसी रही?",
  outcomeSession: "इनका सेशन बुक करें",
  outcomeNotFit: (amount) => `सही नहीं (${amount} वापस)`,
  outcomeMissed: "फ़ोन नहीं उठाया (नया समय भेजें)",
  savedUndoUntil: (time) => `सेव हो गया। ${time} तक वापस ले सकते हैं`,
  tooLateToUndo: "अब वापस नहीं ले सकते",
  alreadyMarked: (outcome, who, time) => `पहले ही दर्ज है: ${outcome}, ${who} ने ${time} पर`,
  byYou: "आप",
  reportBehaviour: "बुरे बर्ताव की शिकायत करें",

  forSELF: "ख़ुद के लिए",
  forFAMILY: "परिवार के लिए",
  forPET: "पालतू जानवर के लिए",
  callIn: (lang) => `${lang} में बात`,
  langEnglish: "अंग्रेज़ी",
  langHindi: "हिन्दी",

  call: "कॉल करें",
  open: "खोलें",
  openChat: "चैट खोलें",
  reply: "जवाब दें",
  handBack: "बॉट को वापस दें",
  approve: "मंज़ूर करें",
  decline: "मना करें",
  undo: "वापस लें",
  tryAgain: "फिर से कोशिश करें",

  bookingHeld: "होल्ड पर",
  bookingConfirmed: "पक्का",
  bookingDone: "हो गया",
  bookingMissed: "छूट गया",
  bookingCancelled: "रद्द",
  payPaid: "पेमेंट हो गया",
  payWaiting: "इंतज़ार में",
  payFailed: "नहीं हुआ",
  payRefunding: "रिफ़ंड आ रहा है",
  payRefunded: "रिफ़ंड हो गया",
  payCheck: "Razorpay पर जाँचें",

  fromCustomer: "ग्राहक",
  fromBot: "बॉट",
  fromAssistant: "असिस्टेंट",
  fromSafety: "सुरक्षा संदेश",
  safetyHidden: "सुरक्षा संदेश। मालिक की ज़रूरत है।",

  bannerPaused: "बुकिंग रुकी हुई है",
  fixPaused: "बुकिंग चालू करें",
  bannerPayments: "पेमेंट नहीं हो रहे हैं",
  fixPayments: "पेमेंट देखें",
  bannerBot: "बॉट 15 मिनट से नहीं चला है",
  fixBot: "देखें क्या गड़बड़ है",

  noAccess: "पहुँच नहीं है",
  noAccessBody: "यह ईमेल यहाँ की टीम में नहीं है। मालिक से निमंत्रण माँगें।",
  notSaved: "यह सेव नहीं हुआ। कुछ नहीं बदला। फिर से कोशिश करें।",
  razorpayDown: "Razorpay से जवाब नहीं आया। न कोई पैसा कटा, न लौटा। एक मिनट बाद फिर कोशिश करें।",
  notDelivered: "संदेश नहीं पहुँचा",

  today: "आज",
  tomorrow: "कल",
};

export const CONSOLE_COPY: Record<ConsoleLang, ConsoleCopy> = { en, hi };

export const consoleCopy = (locale: string | null | undefined): ConsoleCopy => CONSOLE_COPY[consoleLang(locale)];
