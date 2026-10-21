// All Disha Dira specifics live here. Owner may change values; code elsewhere must not hard-code them.

export const config = {
  currency: "INR",
  timezone: "Asia/Kolkata",
  services: ["PROTECTION", "HEALING"],
  prices: {
    introPaise: 9900,
    sessionPaise: 70000,
  },
  hours: {
    // 0 = Sunday ... 6 = Saturday
    days: [1, 2, 3, 4, 5],
    start: "14:00",
    end: "19:00",
  },
  slots: {
    callMinutes: 15,
    sessionMinutes: 60,
    maxSessionsPerDay: 5,
  },
  holdMinutes: 20,
  undoMinutes: 10,
  limits: {
    notFitRefundsPerDay: 5,
    ammaTapReminderHours: 3,
  },
  // Placeholder until the Airtel number exists; the owner sets the real one here, never in git history.
  businessNumber: "+91 00000 00000",
  booking: {
    leadMinutes: 60,
    workingDays: 3,
    maxListRows: 10,
    dayButtons: 3, // reply buttons on the day step (WhatsApp allows 3)
    timeRows: 9, // times on the time step; the "Another day" row makes it 10
    eveningFrom: "16:00", // the time list has an Afternoon section before this and an Evening section from it
  },
  // What customers (and Amma) see for each internal service code. Change a label here and it changes everywhere.
  serviceNames: {
    PROTECTION: { en: "Energy cleansing", hi: "एनर्जी क्लींजिंग" },
    HEALING: { en: "Healing", hi: "हीलिंग" },
  },
  // A text that is only one of these (case-insensitive, ignoring spaces, punctuation and emoji) gets the menu.
  menuWords: ["hi", "hii", "hello", "hey", "namaste", "namaskar", "menu", "start", "नमस्ते", "नमस्कार", "हाय", "मेनू"],
  razorpay: {
    baseUrl: "https://api.razorpay.com/v1", // test and live are the same host: the key (rzp_test_ / rzp_live_) decides
    minLinkExpiryMinutes: 15, // Razorpay: expire_by must be at least 15 minutes ahead; holdMinutes must stay >= this
    pollAfterMinutes: 2,
  },
  // Sender for Rohit's emails: an address on the Disha Dira domain (public website domain), verified in Cloudflare Email Service by Rohit.
  mail: { from: "bot@disha-dira.com" },
  graphVersion: "v26.0",
  windowHours: 24,
  // Template registry. Flip approved to true only after Meta approves the template (owner decision).
  // `hi` is the Hindi version of the same template, with its own name and its own approved flag: a Hindi customer gets it
  // only when it is approved, and otherwise the English template (if that one is approved).
  templates: {
    call_booked: { approved: false, language: "en", hi: { name: "call_booked_hi", approved: false, language: "hi" } },
    session_offer: { approved: false, language: "en", hi: { name: "session_offer_hi", approved: false, language: "hi" } },
    session_confirmed: { approved: false, language: "en", hi: { name: "session_confirmed_hi", approved: false, language: "hi" } },
    reminder: { approved: false, language: "en", hi: { name: "reminder_hi", approved: false, language: "hi" } },
    payment_update: { approved: false, language: "en", hi: { name: "payment_update_hi", approved: false, language: "hi" } },
  },
  languages: ["en", "hi"],
  faqIds: ["what_is_this", "how_it_works", "price", "timings", "refund", "privacy"],
} as const;

export type Config = typeof config;
