// All Disha Dira specifics live here. Owner may change values; code elsewhere must not hard-code them.

export const config = {
  currency: "INR",
  timezone: "Asia/Kolkata",
  services: ["PROTECTION", "HEALING"],
  // All amounts are paise. Per-session package rates (₹500, ₹450) are always price ÷ sessions, never typed in.
  prices: {
    intro: 9900,
    single: 79900,
    pack10: { sessions: 10, paise: 500000 },
    pack20: { sessions: 20, paise: 900000 },
  },
  // Rules for booked sessions and packages (docs/AGENT.md section 3.1b). Hours are counted back from the start of the session.
  sessionRules: {
    changeBeforeHours: 3, // move or cancel at least this long before; a package session then goes back to the package
    singleRefundBeforeHours: 24, // a single session cancelled this early is refunded in full
    singleMoves: 1, // a single session can be moved this many times
    maxUpcoming: 2, // upcoming sessions per buyer
    packageLinkMinutes: 60, // a package payment link stays open this long (no slot is held)
    razorpayRefundDays: 180, // a payment older than this is refunded by hand (Razorpay cannot)
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
    stepOpenHours: 24, // a booking step stays "open" (a typed message re-sends it) this long; a payment step lasts as long as its hold
    repromptHelpAfter: 3, // after this many re-prompts in a row, "Talk to a person" is offered too
  },
  // What customers (and Amma) see for each internal service code. Change a label here and it changes everywhere.
  serviceNames: {
    PROTECTION: { en: "Energy cleansing", hi: "एनर्जी क्लींजिंग" },
    HEALING: { en: "Healing", hi: "हीलिंग" },
  },
  // A text that is only one of these (case-insensitive, ignoring spaces, punctuation and emoji) gets the menu.
  menuWords: ["hi", "hii", "hello", "hey", "namaste", "namaskar", "menu", "start", "नमस्ते", "नमस्कार", "हाय", "मेनू"],
  // Short typed words the gatekeeper (src/gate.ts) understands. All are matched after normalising (src/safety.ts): lower case,
  // no nukta, ँ read as ं, no punctuation or emoji, one space between words. Emoji-only entries are matched as emoji.
  words: {
    // The whole message must be one of these.
    optOut: ["stop", "unsubscribe", "बंद करो", "band karo"],
    ack: ["ok", "okay", "thanks", "thank you", "ty", "ji", "👍", "🙏", "धन्यवाद", "शुक्रिया", "ठीक है"],
    booking: ["book", "booking", "book call", "book a call", "बुक", "बुकिंग"],
    // A short message (at most handoffMaxWords words) containing one of these as a word asks for a person.
    handoff: ["human", "person", "insaan", "insan", "इंसान"],
    handoffMaxWords: 8,
  },
  // Budgets for AI replies, counted per India day. Reaching one sends the menu with "Talk to a person" instead (ticket 12 counts, ticket 14 spends).
  ai: {
    aiRepliesPerPersonPerDay: 12,
    aiRepliesPerPayingCustomerPerDay: 40,
    aiRepliesPerDayTotal: 300,
  },
  // Noise: strikes, quiet periods, blocks (docs/AGENT.md section 4).
  noise: {
    strikesToQuiet: 3,
    strikeClearDays: 7, // strikes clear this long after the last one (or on payment)
    quietDays: 7,
    repeatQuietDays: 30, // a second quiet period inside this many days becomes a block (NOISE_REPEAT)
    smalltalkFreePerDay: 2,
    payingCustomerDays: 30, // a payment or confirmed booking this recent makes someone a paying customer
    // Used by the rule-based classifier until the AI is on (ticket 14). A message with a link and one of spamWords is spam.
    spamWords: ["earn", "click", "offer", "कमाएं", "कमाएँ", "क्लिक", "ऑफर"],
    // Flirting: a strike and one line. Insults: a strike and no reply.
    flirtWords: ["i love you", "love you", "date me", "marry me", "kiss me", "sexy", "send pic", "send photo", "send me your photo", "your photo", "your pic", "pic bhejo", "photo bhejo", "फोटो भेजो", "आई लव यू"],
    abuseWords: ["idiot", "stupid", "moron", "dumb", "shut up", "bewakoof", "bevakoof", "kutta", "kutte", "ullu", "बेवकूफ", "कुत्ता", "उल्लू"],
    // A flirt/sexual message that matches sexualBlockWords, or an abusive one that matches abuseBlockWords, blocks at once. Otherwise only a second offence blocks.
    sexualBlockWords: ["sex", "nude", "nudes", "naked", "boobs", "porn", "xxx", "horny", "nangi", "सेक्स", "नंगी", "चुदाई"],
    abuseBlockWords: [
      "fuck", "fucking", "bastard", "bitch", "asshole", "motherfucker", "madarchod", "behenchod", "bhosdike", "chutiya", "chutiye", "gandu", "harami", "haramkhor", "randi",
      "मादरचोद", "बहनचोद", "भोसड़ीके", "चूतिया", "गांडू", "हरामी", "रंडी",
    ],
  },
  // Safety (docs/KNOWLEDGE.md section 9). Rohit extends these lists here. Matched as whole words or phrases after normalising.
  safety: {
    noSellDays: 7, // after a crisis message nothing is sold for this long
    crisis: [
      // English
      "kill myself", "want to die", "wanna die", "end my life", "end it all", "suicide", "suicidal", "no reason to live", "better off dead", "hurt myself", "self harm", "cut myself", "kill himself", "kill herself",
      // Roman Hinglish
      "marna chahta", "marna chahti", "mar jana chahta", "mar jaana chahta", "mar jana chahti", "mar jaana chahti", "mar jaunga", "mar jaungi", "jeena nahi chahta", "jeena nahi chahti", "zinda nahi rehna",
      "jaan de dunga", "jaan de dungi", "khudkushi", "aatmahatya", "suicide kar", "khatam kar lunga", "khatam kar lungi",
      // Devanagari
      "मरना चाहता", "मरना चाहती", "मर जाना", "मर जाऊंगा", "मर जाऊंगी", "आत्महत्या", "खुदकुशी", "जीना नहीं चाहता", "जीना नहीं चाहती", "जिंदा नहीं रहना", "जान दे दूं", "अपनी जान", "खत्म कर लूंगा", "खत्म कर लूंगी",
    ],
    emergency: [
      "can't breathe", "cannot breathe", "chest pain", "heart attack", "unconscious", "fainted", "bleeding a lot", "heavy bleeding", "poison", "overdose", "stroke",
      "saans nahi", "सांस नहीं", "सीने में दर्द", "बेहोश", "जहर",
    ],
  },
  // Chat text is wiped CHAT_RETENTION_MINUTES (env) after a person's last message; this is used only if the variable is missing or not a number.
  retention: { defaultMinutes: 10080, nameDaysAfterLastBooking: 90 },
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
    package_confirmed: { approved: false, language: "en", hi: { name: "package_confirmed_hi", approved: false, language: "hi" } },
    session_booked: { approved: false, language: "en", hi: { name: "session_booked_hi", approved: false, language: "hi" } },
  },
  languages: ["en", "hi"],
  faqIds: ["what_is_this", "how_it_works", "price", "timings", "refund", "privacy"],
} as const;

export type Config = typeof config;
