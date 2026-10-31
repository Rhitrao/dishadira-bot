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
    days: [1, 2, 3, 4, 5, 6], // Monday to Saturday (owner, 29 Oct 2026)
    start: "14:00",
    end: "19:00",
  },
  slots: {
    callMinutes: 15,
    sessionMinutes: 60,
    maxSessionsPerDay: 5,
  },
  // Days off the owner or practitioner marks on /amma, /admin or /app Calendar (src/holidays.ts): no new bookings on them.
  holidays: { maxDaysAhead: 60 },
  holdMinutes: 20,
  undoMinutes: 10,
  limits: {
    notFitRefundsPerDay: 5,
    ammaTapReminderHours: 3,
  },
  // Placeholder until the Airtel number exists; the owner sets the real one here, never in git history.
  businessNumber: "+91 63661 99009",
  whatsapp: {
    buttonBodyMax: 1024, // WhatsApp: the body of a reply-button message
  },
  booking: {
    leadMinutes: 60,
    workingDays: 6, // days offered on the day step (one list message): the first 6 working days that still have a free time
    lookaheadDays: 21, // how many working days ahead to look for them (full days and holidays are skipped)
    maxListRows: 10,
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
  menuWords: ["hi", "hii", "hello", "hey", "namaste", "namaskar", "menu", "start", "नमस्ते", "नमस्कार", "हाय", "मेनू",
    // ticket 31: polite greetings people really send
    "namaste ji", "namaskar ji", "hello ji", "hi ji", "hello sir", "hi sir", "hello mam", "hello madam", "good morning", "good afternoon", "good evening", "ram ram", "नमस्ते जी"],
  // Short typed words the gatekeeper (src/gate.ts) understands. All are matched after normalising (src/safety.ts): lower case,
  // no nukta, ँ read as ं, no punctuation or emoji, one space between words. Emoji-only entries are matched as emoji.
  words: {
    // The whole message must be one of these.
    optOut: ["stop", "unsubscribe", "बंद करो", "band karo"],
    ack: ["ok", "okay", "thanks", "thank you", "ty", "ji", "👍", "🙏", "धन्यवाद", "शुक्रिया", "ठीक है",
      // ticket 31: closings that used to get the 24-hour promise
      "ok thank you", "ok thanks", "okay thanks", "okay thank you", "thank you so much", "thank you ji", "thank you so much ji", "thanks ji", "thanks a lot",
      "thank u", "thanku", "thankyou", "ok ji", "okay ji", "theek hai", "thik hai", "dhanyavad", "dhanyawad", "shukriya", "धन्यवाद जी", "ठीक है जी"],
    booking: ["book", "booking", "book call", "book a call", "बुक", "बुकिंग"], // a sentence with "book" in it is the router's (config.router.topics.book)
    // "Reply HELP" (the payment reminder, ticket 29): the whole message asks for a person, like "Talk to a person".
    help: ["help", "help me", "need help", "please help", "madad", "मदद", "मदद करें", "मदद चाहिए"],
    // A short message (at most handoffMaxWords words) containing one of these as a word asks for a person.
    handoff: ["human", "person", "insaan", "insan", "इंसान"],
    handoffMaxWords: 8,
    // "Call me", "number please": a short message (at most callRequestMaxWords words) with one of these as a word or phrase gets the
    // "we don't take calls on this number" line and the menu (src/gate.ts CALL_REQUEST). No number is ever given.
    callRequest: [
      "call me", "call me back", "call back", "callback", "can i call", "can we call", "may i call", "i want to call", "i will call", "want to call", "call you",
      "video call", "voice call", "whatsapp call", "phone call me", "phone me",
      "phone number", "contact number", "mobile number", "your number", "number please", "number pls", "send number", "give number", "give me number",
      "call karo", "call kar do", "call kijiye", "call karna hai", "phone karo", "number do", "number dijiye", "number bhejo",
      "मुझे कॉल करो", "मुझे कॉल करें", "मुझे कॉल कीजिए", "कॉल करो", "कॉल कीजिए", "कॉल कर सकते", "कॉल कर सकती", "वीडियो कॉल", "फोन करो", "फोन नंबर", "नंबर दो", "नंबर दीजिए", "नंबर भेजो", "अपना नंबर",
    ],
    callRequestMaxWords: 12,
    // ... unless it also has one of these: it is about a call she makes ("she didn't call me", "can she call me now?"), so the assistant answers.
    callRequestNot: ["she", "shantha", "amma", "didn't", "didnt", "did not", "not", "never", "missed", "nahi", "nahin", "nhi", "नहीं", "वो", "वे", "शांता"],
  },
  // The assistant (src/ai.ts, src/aicheck.ts). Budgets are counted per India day; reaching one sends the menu with "Talk to a person" instead.
  ai: {
    aiRepliesPerPersonPerDay: 12,
    aiRepliesPerPayingCustomerPerDay: 40,
    aiRepliesPerDayTotal: 300,
    // Claude Haiku 5.5. Model id and prices checked against Anthropic's model list on 2026-10-21 (prices: US$ per million tokens, prompts up to 100K tokens).
    model: "claude-haiku-5-5",
    apiUrl: "https://api.anthropic.com/v1/messages",
    apiVersion: "2023-06-01",
    maxTokens: 800, // a 600-character Hindi reply plus the tool's JSON can pass 400 tokens; output is cheap
    timeoutMs: 8000,
    historyMessages: 10, // the last N messages of the chat go to the model, oldest first
    maxReplyChars: 600,
    usdPerMillion: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    // The output check (docs/KNOWLEDGE.md section 8). Matched as whole words or phrases after normalising (src/safety.ts), so "secure", "benefits" and "spiritual" pass.
    bannedWords: [
      // English and Roman
      "black magic", "evil eye", "nazar", "kala jadu", "jadu", "tona", "totka", "curse", "cursed", "possessed", "ghost", "spirit", "bhoot", "vashikaran", "miracle", "miraculous", "magic",
      "cure", "cured", "cures", "guarantee", "guaranteed", "100%", "sau pratishat", "will definitely", "for sure", "permanent", "permanently", "chamatkar", "pakka",
      "theek ho jayega", "theek ho jaogi", "theek ho jaoge",
      // Fear words (KNOWLEDGE.md v3): customers use them; the assistant never repeats them
      "negative energy", "negative energies", "blockage", "blockages", "नकारात्मक ऊर्जा",
      // Devanagari
      "काला जादू", "जादू", "जादू-टोना", "टोना", "टोटका", "बुरी नज़र", "भूत", "वशीकरण", "चमत्कार", "गारंटी", "पक्का", "100 प्रतिशत", "ठीक हो जाएगा", "ठीक हो जाएगी", "ठीक हो जाएँगे", "ठीक कर देंगी",
      // Illness names, even when the customer used them
      "cancer", "tumour", "tumor", "diabetes", "thyroid", "depression", "pcod", "pcos", "infertility", "kidney", "heart disease", "asthma", "arthritis", "paralysis", "epilepsy", "seizure", "seizures", "hiv", "migraine", "bp", "blood pressure",
      "कैंसर", "डायबिटीज़", "शुगर की बीमारी", "थायराइड", "डिप्रेशन", "बांझपन", "लकवा", "मिर्गी",
    ],
    // A reply that talks about the assistant's own set-up is replaced.
    metaWords: ["system prompt", "instructions", "anthropic"],
    // Numbers a reply may contain besides the prices, per-session rates, package sizes, durations, hours and hold minutes built from the rest of this file,
    // and the numbers in the person's own booking facts: 2 (upcoming sessions) and 3 (hours' notice) are in sessionRules; the rest are here.
    allowedNumbers: [
      18, // the age check
      24, // hours (the reply window, 24 hours' notice for a refund, 24x7)
      30, // days
      120, // "practised in over 120 countries"
      1980, // "developed in the 1980s"
      7, // chat messages are deleted 7 days after the last one; also the 7 pm closing time
      6, // refunds for payments older than 6 months are arranged by the team
      112, 108, 181, 1098, 14416, // safety numbers (KNOWLEDGE.md §8, §15): emergency, ambulance, women's helpline, child helpline, Tele-MANAS
    ],
  },
  // Talking to a person (docs/AGENT.md section 3.2 step 6).
  handoff: {
    mailEveryHours: 6, // Rohit is emailed about a person's request for a human at most this often
    autoReturnHours: 24, // a HUMAN chat goes back to the bot this long after the handoff if Rohit has not replied from /admin
  },
  // The console's Inbox (src/inbox.ts, ticket 22).
  inbox: {
    claimMinutes: 30, // "Assign to me" lapses this long after the claim, or after the same member's last reply
    mailAfterWorkingMinutes: 120, // a handed-over chat with no team reply for this many minutes inside config.hours: one email to the team
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
    spamWords: ["earn", "click", "offer", "कमाएं", "कमाएँ", "क्लिक", "ऑफर", "crypto", "bitcoin", "investment", "followers", "promotion", "seo"],
    // Flirting: a strike and one line. Insults: a strike and no reply.
    flirtWords: ["i love you", "love u", "date me", "marry me", "kiss me", "sexy", "send pic", "send photo", "send me your photo", "your photo", "your pic", "pic bhejo", "photo bhejo", "फोटो भेजो", "आई लव यू"],
    // Phrases aimed at the bot or a person, not single words: "I feel stupid" or "my kutta (dog)" must never be a strike.
    abuseWords: [
      "you idiot", "you are an idiot", "you are idiot", "idiot bot", "you stupid", "you are stupid", "stupid bot", "you moron", "you dumb", "dumb bot",
      "shut up", "tum bewakoof", "tu bewakoof", "bewakoof bot", "ullu ke pathe", "kutte ki aulad", "kutta kahin ka", "kamine",
      "तुम बेवकूफ", "तू बेवकूफ", "उल्लू के पट्ठे", "कुत्ते की औलाद", "कमीने",
    ],
    // A flirt/sexual message that matches sexualBlockWords, or an abusive one that matches abuseBlockWords, blocks at once. Otherwise only a second offence blocks.
    // No "sex" here: people describe real marriage or intimacy concerns (KNOWLEDGE §5 and §7 case 62), and those must never be blocked.
    sexualBlockWords: ["nude", "nudes", "naked", "boobs", "porn", "xxx", "horny", "nangi", "send nudes", "नंगी", "चुदाई"],
    abuseBlockWords: [
      "fuck", "fucking", "bastard", "bitch", "asshole", "motherfucker", "madarchod", "behenchod", "bhosdike", "chutiya", "chutiye", "gandu", "harami", "haramkhor", "randi",
      "मादरचोद", "बहनचोद", "भोसड़ीके", "चूतिया", "गांडू", "हरामी", "रंडी",
    ],
    // Ticket 31 (with the assistant off). Promotions and scams that need no link: spam (a strike, no reply, no item).
    promoWords: [
      "digital marketing", "seo services", "seo service", "web design", "website design", "website development", "app development", "grow your business",
      "increase your sales", "get more leads", "lead generation", "social media marketing", "instagram followers", "cryptocurrency", "crypto", "bitcoin", "forex",
      "trading tips", "investment plan", "double your money", "earn money", "earn from home", "work from home", "part time job", "you have won", "you won",
      "lottery", "jackpot", "kbc", "claim your prize", "loan offer", "personal loan", "promote your", "marketing agency", "our agency", "advertise with",
    ],
    // Threats: a strike as abuse (no reply), and an urgent item for the owner.
    threatWords: [
      "kill you", "i will kill", "will kill you", "finish you", "i will find you", "find you", "where you live", "i know where", "burn your",
      "maar dunga", "maar dalunga", "maar daalunga", "jaan se maar", "dekh lunga", "dekh lenge", "chhodunga nahi", "chodunga nahi",
      "जान से मार", "मार दूंगा", "मार डालूंगा", "देख लूंगा", "छोड़ूंगा नहीं",
    ],
    // Influencing or harming another person (AGENT.md §4 prohibited_request): a strike and one firm, kind line.
    prohibitedWords: [
      "vashikaran", "vasikaran", "वशीकरण", "love back", "get my love back", "get him back", "get her back", "bring back my", "wapas lana", "wapas laana",
      "pyar wapas", "control my husband", "control my wife", "control my boss", "control him", "control her", "make him marry", "make her marry",
      "take revenge", "revenge", "badla lena", "बदला", "harm them", "punish them",
    ],
    // Job seekers, learners and partnerships: one line pointing to "Talk to a person", once a day; no strike, no item.
    jobWords: [
      "any vacancy", "job vacancy", "vacancy", "looking for a job", "looking for job", "need a job", "need job", "job opportunity", "job opening",
      "are you hiring", "hiring", "my resume", "my cv", "internship", "naukri chahiye", "job chahiye", "नौकरी चाहिए", "work with you", "join your team",
      "collaboration", "collab", "partnership", "franchise", "sponsorship", "do you teach", "teach me", "learn pranic", "courses",
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
    // Present-tense, urgent phrases only (ticket 31): "had a stroke last year" or "my office is poison" are not emergencies.
    emergency: [
      "can't breathe", "cannot breathe", "chest pain", "heart attack", "bleeding a lot", "heavy bleeding", "overdose",
      "having a stroke", "is having a stroke", "had a stroke just now", "stroke right now", "took poison", "drank poison", "ate poison", "has taken poison", "swallowed poison",
      "is unconscious", "is not waking up", "fainted just now", "just fainted", "has fainted",
      "saans nahi", "सांस नहीं", "सीने में दर्द", "zeher kha liya", "zehar kha liya", "jahar kha liya", "जहर खा लिया", "ज़हर खा लिया", "behosh ho gaya", "behosh ho gayi", "बेहोश हो गया", "बेहोश हो गई", "बेहोश हो गए",
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
  // Meta approval as seen in WhatsApp Manager (30 Oct 2026). Four Hindi templates were re-created as *_hind because the first copies were
  // filed under language English; a name stays blocked for 30 days after deletion. Flip a flag only once Meta shows the template Active.
  templates: {
    call_booked: { approved: true, language: "en", hi: { name: "call_booked_hi", approved: true, language: "hi" } },
    session_offer: { approved: true, language: "en", hi: { name: "session_offer_hi", approved: true, language: "hi" } },
    session_confirmed: { approved: true, language: "en", hi: { name: "session_confirmed_hind", approved: true, language: "hi" } },
    reminder: { approved: true, language: "en", hi: { name: "reminder_hind", approved: true, language: "hi" } },
    payment_update: { approved: true, language: "en", hi: { name: "payment_update_hi", approved: true, language: "hi" } },
    package_confirmed: { approved: true, language: "en", hi: { name: "package_confirmed_hind", approved: true, language: "hi" } },
    session_booked: { approved: true, language: "en", hi: { name: "session_booked_hi", approved: true, language: "hi" } },
    // The Inbox's follow-up once the 24-hour window has closed (ticket 22; not yet in the CONTRACT's template list, see STATUS "Blocked").
    follow_up: { approved: true, language: "en", hi: { name: "follow_up_hind", approved: true, language: "hi" } },
  },
  languages: ["en", "hi"],
  faqIds: ["what_is_this", "how_it_works", "price", "timings", "refund", "privacy"],
  // The fixed-answer router (ticket 31, src/router.ts): with the assistant off, a typed message containing one of these words or phrases
  // (after normalising, whole words only) gets that topic's fixed answer. Topics are tried in this order; the first match wins.
  router: {
    answerEveryMinutes: 10, // the same topic is answered again only after this long (a loop gets silence)
    noMatchEveryMinutes: 30, // "I'm the booking assistant and can't answer typed questions" at most this often
    lineEveryHours: 24, // the job-seeker line at most this often
    menuRepeatMinutes: 10, // a greeting within this long of an untapped menu gets nothing more (it counts as small talk)
    // Typed answers to an open step (ticket 31, I8), besides the button's own words and its number. Matched in a short message only.
    stepWords: {
      yes: ["yes", "yes i am", "yeah", "yep", "ok", "okay", "haan", "han", "haa", "ha", "ji", "ji haan", "हाँ", "हां", "जी", "जी हाँ"],
      no: ["no", "nope", "nahi", "nahin", "na", "नहीं", "ना"],
      en: ["english", "eng", "angrezi", "अंग्रेज़ी", "इंग्लिश"],
      hi: ["hindi", "हिंदी", "हिन्दी", "hindi mein", "hindi me"],
      self: ["me", "myself", "for me", "self", "mere liye", "mujhe", "मेरे लिए", "खुद"],
      family: ["family", "mother", "mom", "mummy", "maa", "father", "dad", "papa", "husband", "wife", "son", "daughter", "brother", "sister", "parents", "परिवार", "माँ", "मम्मी", "पापा", "पति", "पत्नी", "बेटा", "बेटी"],
      pet: ["pet", "dog", "cat", "puppy", "kutta", "billi", "पालतू", "कुत्ता", "बिल्ली"],
      healing: ["healing", "heal", "हीलिंग"],
      cleansing: ["cleansing", "energy cleansing", "cleanse", "protection", "क्लींजिंग"],
      today: ["today", "aaj", "आज"],
      tomorrow: ["tomorrow", "tmrw", "kal", "कल"],
      weekdays: [
        ["sunday", "sun", "ravivar", "itvaar", "रविवार", "रवि"], ["monday", "mon", "somvar", "सोमवार", "सोम"], ["tuesday", "tue", "tues", "mangalvar", "मंगलवार", "मंगल"],
        ["wednesday", "wed", "budhvar", "बुधवार", "बुध"], ["thursday", "thu", "thurs", "guruvar", "गुरुवार", "गुरु"], ["friday", "fri", "shukravar", "शुक्रवार", "शुक्र"],
        ["saturday", "sat", "shanivar", "शनिवार", "शनि"],
      ],
      maxWords: 5,
    },
    topics: {
      medical: [
        "cancer", "tumour", "tumor", "diabetes", "sugar", "thyroid", "depression", "anxiety", "bp", "blood pressure", "stroke", "paralysis", "heart", "kidney", "liver",
        "asthma", "arthritis", "migraine", "pcod", "pcos", "infertility", "pregnant", "pregnancy", "surgery", "operation", "hospital", "doctor", "medicine", "medicines",
        "medication", "tablets", "illness", "disease", "disorder", "sick", "pain", "cure", "treatment", "treat", "bimari", "bimaari", "beemari", "ilaj", "ilaaj", "dawai", "dawa",
        "बीमारी", "बीमार", "इलाज", "दवा", "दवाई", "डॉक्टर", "कैंसर", "शुगर", "दर्द", "अस्पताल",
      ],
      black_magic: [
        "black magic", "kala jadu", "kaala jaadu", "jadu tona", "jaadu", "jadu", "tona", "totka", "nazar", "evil eye", "buri nazar", "curse", "cursed", "possessed",
        "bhoot", "ghost", "negative energy", "काला जादू", "जादू", "टोना", "टोटका", "नज़र", "बुरी नज़र", "भूत",
      ],
      payment_issue: [
        "payment failed", "payment fail", "money deducted", "amount deducted", "deducted", "debited", "paid but", "i paid", "i have paid", "already paid", "payment done",
        "no confirmation", "not confirmed", "pay kiya", "paise kat", "paisa kat", "paise kat gaye", "भुगतान कर दिया", "पैसे कट",
      ],
      refund: ["refund", "refunds", "money back", "paisa wapas", "paise wapas", "return my money", "cancel", "cancellation", "रिफंड", "पैसे वापस", "रद्द"],
      my_booking: [
        "my call", "my booking", "my bookings", "my appointment", "my session", "when is my", "booking status", "is my call", "meri call", "meri booking", "mera appointment",
        "call kab hai", "मेरी कॉल", "मेरी बुकिंग",
      ],
      abroad: [
        "dubai", "uae", "abroad", "outside india", "another country", "other country", "usa", "america", "uk", "london", "canada", "australia", "singapore", "time zone",
        "timezone", "time difference", "international", "foreign", "overseas", "videsh", "विदेश", "paypal",
      ],
      in_person: [
        "in person", "visit", "come to you", "come there", "meet her", "meet you", "meet in person", "clinic", "centre", "center", "address", "where are you", "bengaluru",
        "bangalore", "milne", "mil sakte", "aa sakte", "मिल सकते", "आ सकते",
      ],
      trust: [
        "scam", "scammer", "fraud", "frauds", "fake", "is this real", "is it real", "real or", "genuine", "trust", "legit", "legitimate", "certified", "qualified",
        "qualification", "safe to pay", "is it safe", "dhokha", "dhoka", "farzi", "asli", "नकली", "धोखा", "असली", "भरोसा",
      ],
      price: [
        "price", "prices", "pricing", "cost", "costs", "fee", "fees", "charge", "charges", "how much", "kitna", "kitne", "kitni", "paisa", "paise", "rate", "rates",
        "rupees", "discount", "free trial", "free session", "फ़ीस", "कीमत", "कितना", "कितने", "कितनी", "शुल्क", "दाम",
      ],
      how_it_works: [
        "how does it work", "how it works", "how does this work", "how does the call work", "how is the call", "what happens", "process", "over the phone",
        "on the phone", "by phone", "phone pe", "phone par", "kaise hota", "kaise kaam", "kaise karte", "kaise hoga", "कैसे होता", "कैसे काम", "कैसे होगा",
      ],
      timings: [
        "timing", "timings", "what time", "which time", "available", "availability", "saturday", "sunday", "weekend", "morning", "evening", "night", "kab", "samay",
        "waqt", "समय", "टाइम", "कब", "शनिवार", "रविवार",
      ],
      what_is_this: [
        "what is pranic", "what is this", "what is it", "what do you do", "pranic", "prana", "kya hai", "kya hota hai", "details", "detail", "info", "information",
        "tell me more", "प्राणिक", "क्या है",
      ],
      book: [
        "book", "booking", "book karna", "book karni", "book kar", "appointment", "schedule", "want to book", "i want to book", "call book", "बुक", "बुकिंग",
      ],
    },
  },
  // Automatic replies to Instagram DMs and Facebook Messenger (ticket 32, src/social.ts), behind SOCIAL_REPLIES. Public addresses only.
  social: {
    instagramUrl: "https://www.instagram.com/disha_dira/", // the "Visit profile" button on Instagram
    facebookPageUrl: "https://www.facebook.com/profile.php?id=61588921902210", // "Our Page: <link>" in the Messenger follow ask (the Page's public address); empty: https://www.facebook.com/<META_PAGE_ID>
    contactEmail: "dishadirahealing@gmail.com", // the contact address on the website's privacy page, for the data deletion page
    maxAutosPerDay: 3, // automated messages to one person in 24 hours, at most (the WhatsApp link itself always goes, once)
    nudgeEveryHours: 6, // the WhatsApp link again (after the follow, or with the second ask before it) past the daily limit at most this often
    welcomeBackHours: 24, // after the link, someone who writes again after this long gets "Welcome back!" with the link and questions
    burstSeconds: 60, // typed messages: at most one unprompted reply (ask, ask again, pointer, welcome back) per person in this long
    commentLinkEveryDays: 7, // someone who had the link comments on another post: a private reply with only [Book on WhatsApp], at most this often
    restartAfterDays: 30, // no message from them for this long: the flow starts again
    pauseHours: 24, // a person from the team wrote by hand (or a safety message went): no automation in that chat for this long
    repeatAskMinutes: 10, // the same follow ask is not sent again within this long (unless a question got an answer line)
    ownEchoSeconds: 60, // an Instagram echo this soon after our own send is ours (its id may not be stored yet)
    graphTimeoutMs: 2500, // per Graph call; Meta answers in well under a second, and wants the webhook's 200 within 5 seconds
    keepSeenDays: 7, // message ids kept for dedupe (a "one private reply per commenter per post" key: forgetAfterDays)
    publicReply: false, // also answer a comment in public ("Sent you a DM 🙏") after its private reply; the owner may turn it on
    forgetAfterDays: 90, // a person's row is deleted this long after their last message
    // Roman Hindi words that make a message Hindi (Devanagari always does). Whole words, after normalising.
    hinglish: [
      "kya", "hai", "hain", "kitna", "kitne", "kitni", "kaise", "kahan", "kaha", "kab", "aap", "aapka", "aapki", "mujhe", "mera", "meri", "mere", "karna", "karni",
      "chahiye", "batao", "bataiye", "bataye", "haan", "nahi", "nahin", "hoga", "hota", "mein", "liye", "kripya", "dhanyavad", "shukriya", "ji", "bhai", "didi",
      "kiya", "diya", "liya", "gaya", "kar", "karo", "kijiye", "hoon", "hun", "acha", "accha", "achha", "theek", "thik", "namaskar", "sakte", "sakti", "sakta",
      "chahta", "chahti", "milega",
    ],
    // Typed instead of tapping "I'm following" (a message of up to 6 words, at the follow ask, with none of notFollowedWords): counts as
    // the tap. On Instagram the follow is still checked; on Messenger it is trusted, as the tap is.
    followedWords: ["following", "followed", "follow done", "i'm following", "im following", "i am following", "i followed", "i have followed", "already following",
      "already followed", "i follow you", "done", "ok", "okay", "yes", "yeah", "yep", "sure",
      "haan", "han", "haa", "ha", "ji haan", "follow kiya", "follow kar liya", "follow kar diya", "follow ho gaya", "kar diya", "kar liya", "ho gaya",
      "फ़ॉलो किया", "फॉलो किया", "फ़ॉलो कर लिया", "फॉलो कर लिया", "फ़ॉलो कर दिया", "फॉलो कर दिया", "हाँ", "जी हाँ", "कर दिया", "कर लिया", "हो गया"],
    notFollowedWords: ["no", "not", "not yet", "nope", "haven't", "havent", "didn't", "didnt", "don't", "dont", "can't", "cant", "unable", "how do i follow",
      "how to follow", "how can i follow", "where to follow", "nahi", "nahin", "nhi", "nai", "kaise follow", "follow kaise", "नहीं", "नही", "कैसे फ़ॉलो",
      "फ़ॉलो कैसे", "कैसे फॉलो", "फॉलो कैसे"],
    // "Not interested", "stop": one polite line, then no automated message until the flow restarts (config.words.optOut too, alone).
    stopWords: ["not interested", "no interest", "no thanks", "no thank you", "stop messaging", "stop sending", "dont message", "don't message me",
      "unsubscribe", "interested nahi", "interest nahi", "nahi chahiye", "mat bhejo", "message mat karo", "रुचि नहीं", "नहीं चाहिए", "मैसेज मत करो", "मत भेजो"],
    // "I booked already", "paid": thank them, no more selling. With paidProblemWords: point them to "Talk to a person" on WhatsApp.
    bookedWords: ["booked", "i booked", "i have booked", "already booked", "booking done", "booked already", "i paid", "i have paid", "already paid",
      "paid already", "payment done", "payment kar diya", "pay kar diya", "book kar liya", "booking ho gayi", "booking kar li", "बुक कर लिया", "बुकिंग हो गई",
      "पेमेंट कर दिया", "पेमेंट हो गया"],
    paidProblemWords: ["no confirmation", "not confirmed", "not received", "didn't get", "did not get", "didnt get", "no message", "deducted", "money cut",
      "payment failed", "confirmation nahi", "nahi aaya", "nahi mila", "कन्फ़र्मेशन नहीं", "नहीं आया", "नहीं मिला", "कट गए"],
    // Besides links, config.noise promotions and scams, and job seekers: these make a social message junk (one follow ask at most, no link).
    junkWords: ["promotion", "promotions", "paid promotion", "promote", "shoutout", "shout out", "influencer", "brand deal", "collab", "collaboration",
      "usdt", "binance", "nft", "airdrop", "trading", "investment", "forex", "buy followers", "more followers", "real followers", "increase followers", "buy likes", "dm for promo"],
    // The topic of their first message (a code, never the text), answered in one line once they follow. Tried in this order; the first
    // match wins. A message that names an illness (config.router.topics.medical) gets no topic: no medical answer, only the way to book.
    keywords: {
      price: ["price", "prices", "pricing", "cost", "costs", "fee", "fees", "charge", "charges", "how much", "rate", "rates", "kitna", "kitne", "kitni", "paise", "kitne ka",
        "कितना", "कितने", "कितनी", "फ़ीस", "फीस", "कीमत", "दाम", "शुल्क"],
      refund: ["refund", "refunds", "money back", "paisa wapas", "paise wapas", "रिफंड", "रिफ़ंड", "पैसे वापस"],
      how: ["how does the call work", "how the call works", "how is the call", "what happens on the call", "what happens in the call", "call kaise", "कॉल कैसे"],
      // Her number, or a call now: the same answer as on WhatsApp (no number; book the call and she calls you).
      call: ["call me", "can i call", "call you", "call her", "your number", "her number", "phone number", "contact number", "mobile number", "whatsapp number",
        "number please", "number do", "number dijiye", "number bhejo", "talk to her", "speak to her", "speak to shantha", "talk to shantha", "नंबर", "कॉल करूं",
        "बात करनी"],
      book: ["book", "booking", "appointment", "session", "sessions", "slot", "slots", "consult", "consultation", "बुक", "बुकिंग", "अपॉइंटमेंट", "सेशन"],
      where: ["where", "address", "location", "located", "in person", "visit", "kahan", "kaha", "dubai", "uae", "abroad", "outside india", "another country", "usa", "uk",
        "canada", "australia", "singapore", "online", "by phone", "on phone", "phone pe", "phone par", "कहाँ", "कहां", "पता", "विदेश", "दुबई"],
      what: ["what is pranic", "what is pranic healing", "what is this", "how does it work", "how it works", "how does pranic", "pranic healing kya", "kya hai",
        "kaise kaam", "क्या है", "कैसे काम", "प्राणिक हीलिंग क्या"],
    },
  },
} as const;

export type Config = typeof config;
