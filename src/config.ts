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
  booking: { leadMinutes: 60, workingDays: 3, maxListRows: 10 },
  cashfree: {
    apiVersion: "2025-01-01",
    sandboxBase: "https://sandbox.cashfree.com/pg",
    liveBase: "https://api.cashfree.com/pg",
    minLinkExpiryMinutes: 15, // assumed provider minimum; holdMinutes must stay >= this
    pollAfterMinutes: 2,
  },
  graphVersion: "v23.0",
  windowHours: 24,
  // Template registry. Flip approved to true only after Meta approves the template (owner decision).
  templates: {
    call_booked: { approved: false, language: "en" },
    session_offer: { approved: false, language: "en" },
    session_confirmed: { approved: false, language: "en" },
    reminder: { approved: false, language: "en" },
    payment_update: { approved: false, language: "en" },
  },
  languages: ["en", "kn"],
  faqIds: ["what_is_this", "how_it_works", "price", "timings", "refund", "privacy"],
} as const;

export type Config = typeof config;
