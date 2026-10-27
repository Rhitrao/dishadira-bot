// Settings (/app/settings), owner only: how the business runs. Business name, accent and default language; the prices the bot quotes
// (the settings table, read by the bot through src/business.ts with config as the fallback); the bot's switches (moved from /admin, the
// same rule: the env flag in wrangler.toml is the master, a setting can only pause); who gets the daily summary and the crisis email;
// privacy; Razorpay's connection (status words only, never a key); the system's health; and the audit log (/app/settings/audit).
// Team (/app/settings/team) is src/team.ts. Every change is one batch with its audit row, and every POST asks can() and its own token.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, listMembers, memberCsrf, WORKSPACE_ID, type Member } from "./auth";
import { ACCENTS, accentCss, accentOf, chosenIds, DEFAULT_PRICES, isAccent, KEYS, loadPrices, PRICE_NAMES, pricePaise, readPrices, staffReadsChat, validPrice, type AccentName, type PriceName, type Prices } from "./business";
import { config } from "./config";
import { auditStmt, languageCsrf, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleLang } from "./console-copy";
import type { Env } from "./env";
import { HEARTBEAT_KEY, HEARTBEAT_STALE_MIN, MAIL_LAST_KEY } from "./mail";
import { iso, istDay } from "./slots";
import { getSetting, isSwitch, switchStates, type SwitchName } from "./switches";
import { clock, confirmStep, consoleFrame, dayName, emptyState, roleName, rows, screenHead, section, statusChip, type ChipTone, type TabId } from "./ui";
import { raiseAwayItems } from "./watch";

// ---------- words (English and Hindi, in the shape of src/console-copy.ts) ----------
const en = {
  saved: "Saved.",
  nothingChanged: "Nothing changed.",
  notSaved: "That didn't save. Check the boxes in red and try again.",
  // Business
  secBusiness: "Business",
  businessName: "Business name",
  businessNameHelp: "Shown at the top of the console and in the daily summary.",
  accent: "Accent colour",
  accentNames: { teal: "Teal", blue: "Blue", indigo: "Indigo", plum: "Plum" } as Record<AccentName, string>,
  defaultLanguage: "Language for new team members",
  timeZone: "Time zone",
  timeZoneIndia: "India time (Asia/Kolkata)",
  english: "English",
  hindi: "हिन्दी (Hindi)",
  saveBusiness: "Save business details",
  badName: "Give the business a name, up to 60 characters.",
  // Prices
  secPrices: "Services and prices",
  pricesWhy: "What the bot quotes and what the payment links ask for. New links use a new price at once; links already sent keep theirs.",
  priceIntro: (min: number) => `First call (${min} minutes)`,
  priceSingle: (min: number) => `Single session (${min} minutes)`,
  pricePack: (n: number) => `Package of ${n} sessions`,
  priceDefault: (amount: string) => `Default ${amount}`,
  perSession: (amount: string) => `${amount} a session`,
  rupeesOnly: "In whole rupees",
  savePrices: "Save prices",
  badPrice: "Whole rupees from ₹1 to ₹1,00,000.",
  badPack: (n: number) => `Whole rupees from ₹1 to ₹1,00,000 that divide into ${n} whole-rupee sessions.`,
  // Team
  secTeam: "Team",
  teamWhy: "Invite people, set their roles, remove members.",
  auditLink: "Audit log",
  auditWhy: "Who did what, and when.",
  // Bot
  secBot: "Bot",
  swBookings: "Taking bookings",
  swBookingsWhy: "When paused, nobody can start a booking (they're told booking opens soon). Booked calls, reminders and answers carry on.",
  swAway: "Practitioner away",
  swAwayWhy: "When away, new bookings pause and every call and session today and tomorrow goes on Today to move or refund.",
  swSends: "Messages to customers",
  swSendsWhy: "When paused, the bot sends nothing except the crisis and emergency safety messages. Messages from customers are still saved.",
  swAi: "The assistant",
  swAiWhy: "When paused, typed questions get a short fixed reply and a person is asked; nothing goes to the AI. Buttons and booking keep working.",
  aiLimit: (n: number, today: number) => `Daily limit: ${n} answers in all. Today so far: ${today}.`,
  on: "On",
  paused: "Paused",
  away: "Away",
  here: "Here",
  envOff: "Off for this copy of the bot. Only a deploy can turn it on, so there's nothing to change here.",
  pausedByAway: "Paused because the practitioner is away.",
  resume: "Turn back on",
  pause: "Pause…",
  pauseConfirm: (what: string) => `Pause: ${what}`,
  markAway: "Mark as away…",
  markAwayConfirm: "Mark the practitioner away",
  markBack: "The practitioner is back",
  switched: "Switch changed.",
  envIsMaster: "That's off for this copy of the bot, so it can't be turned on here.",
  // Emails
  secEmails: "Emails",
  digestWho: "Who gets the daily summary (9 pm)",
  safetyWho: "Safety contact: who is emailed at once about a crisis message",
  ownerNote: "The owner is emailed at the alert address set for the bot.",
  ownerDefault: "(the owner, by default)",
  saveEmails: "Save who gets emails",
  pickOne: "Choose at least one person for the daily summary.",
  // Payments
  secPayments: "Payments",
  rzpConnection: "Razorpay",
  rzpConnected: "Connected",
  rzpMissing: "Not connected: the payment keys aren't set for this copy of the bot.",
  rzpMode: "Mode",
  rzpTest: "Test mode: no real money moves",
  rzpLive: "Live mode: real payments",
  rzpUnknownMode: "Can't tell: check the key in Cloudflare",
  rzpMismatch: "The key's mode and the bot's payment mode don't match, so the bot won't make payment links.",
  rzpLastNotice: "Last notice from Razorpay",
  rzpInternational: "International cards",
  rzpInternationalWhy: "Turned on or off in Razorpay's own settings, not here.",
  never: "None yet",
  // Privacy
  secPrivacy: "Privacy",
  chatKept: (how: string) => `Chat text is deleted ${how} after the customer's last message. Who wrote and when stays.`,
  namesKept: (days: number) => `Names and numbers are removed ${days} days after the last booking. Payments and the audit log stay.`,
  staffRead: "Staff can read chat text",
  staffReadOn: "Staff read chats so they can reply. Safety messages are always hidden from them.",
  staffReadOff: "Staff see who wrote and when, not the text. Safety messages are always hidden from them.",
  staffHide: "Hide chat text from staff…",
  staffHideConfirm: "Hide chat text from staff",
  staffHideEffect: "Staff won't see what customers wrote, so they can't answer chats well. You can turn it back on.",
  staffShow: "Let staff read chat text",
  yes: "Yes",
  no: "No",
  // System
  secSystem: "System",
  botRan: "The bot's 2-minute check",
  botRanOk: (ago: string) => `Ran ${ago}`,
  botRanStale: (min: number) => `Hasn't run for ${min} minutes: reminders, payment checks and the chat deletion wait for it.`,
  lastIn: "Last message from a customer",
  lastOut: "Last message sent",
  notDelivered: "Messages not delivered (last 24 hours)",
  aiToday: "Assistant answers today",
  lastAlert: "Last alert email",
  alertFailed: "Didn't send: crisis and alert emails may not be reaching you.",
  payChecks: "Payments to check",
  openPayments: "Open Payments",
  ok: "Fine",
  check: "Check",
  problem: "Problem",
  // Audit log
  auditTitle: "Audit log",
  auditSub: "Who did what, and when. Kept for at least a year.",
  filterWho: "Person",
  filterWhat: "Action",
  everyone: "Everyone",
  everything: "Every action",
  beforeRoles: "Before roles",
  theBot: "The bot",
  system: "System",
  filter: "Show",
  older: "Older entries",
  noAudit: "Nothing here yet. Changes to bookings, money, settings and the team show here as they happen.",
  noMatch: "Nothing matches. Try everyone, or every action.",
  backToSettings: "Back to Settings",
  reasonLabel: (r: string) => `Reason: ${r}`,
};

type Words = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : (typeof en)[K] };

const hi: Words = {
  saved: "सेव हो गया।",
  nothingChanged: "कुछ नहीं बदला।",
  notSaved: "यह सेव नहीं हुआ। लाल वाले खाने देखें और फिर से कोशिश करें।",
  secBusiness: "बिज़नेस",
  businessName: "बिज़नेस का नाम",
  businessNameHelp: "कंसोल में सबसे ऊपर और रोज़ की रिपोर्ट में दिखता है।",
  accent: "मुख्य रंग",
  accentNames: { teal: "हरा-नीला", blue: "नीला", indigo: "गहरा नीला", plum: "बैंगनी" },
  defaultLanguage: "नए टीम सदस्यों की भाषा",
  timeZone: "समय क्षेत्र",
  timeZoneIndia: "भारतीय समय (Asia/Kolkata)",
  english: "English (अंग्रेज़ी)",
  hindi: "हिन्दी",
  saveBusiness: "बिज़नेस की जानकारी सेव करें",
  badName: "बिज़नेस का नाम लिखें, 60 अक्षरों तक।",
  secPrices: "सेवाएँ और दाम",
  pricesWhy: "बॉट यही दाम बताता है और पेमेंट लिंक यही माँगते हैं। नए लिंक में नया दाम तुरंत लगता है; भेजे जा चुके लिंक का दाम वही रहता है।",
  priceIntro: (min) => `पहली कॉल (${min} मिनट)`,
  priceSingle: (min) => `एक सेशन (${min} मिनट)`,
  pricePack: (n) => `${n} सेशन का पैकेज`,
  priceDefault: (amount) => `पहले से तय: ${amount}`,
  perSession: (amount) => `${amount} प्रति सेशन`,
  rupeesOnly: "पूरे रुपये में",
  savePrices: "दाम सेव करें",
  badPrice: "₹1 से ₹1,00,000 तक, पूरे रुपये में।",
  badPack: (n) => `₹1 से ₹1,00,000 तक, पूरे रुपये में, जो ${n} सेशन में पूरे रुपये में बँट सके।`,
  secTeam: "टीम",
  teamWhy: "लोगों को बुलाएँ, उनका रोल तय करें, सदस्य हटाएँ।",
  auditLink: "ऑडिट लॉग",
  auditWhy: "किसने क्या किया, और कब।",
  secBot: "बॉट",
  swBookings: "बुकिंग चालू",
  swBookingsWhy: "रुकने पर कोई नई बुकिंग शुरू नहीं कर सकता (उन्हें बताया जाता है कि बुकिंग जल्द खुलेगी)। बुक की हुई कॉल, रिमाइंडर और जवाब चलते रहते हैं।",
  swAway: "प्रैक्टिशनर छुट्टी पर",
  swAwayWhy: "छुट्टी पर होने पर नई बुकिंग रुकती है, और आज और कल की हर कॉल और सेशन 'आज' पर आ जाता है, ताकि समय बदला जाए या रिफ़ंड हो।",
  swSends: "ग्राहकों को संदेश",
  swSendsWhy: "रुकने पर बॉट सुरक्षा संदेशों के सिवा कुछ नहीं भेजता। ग्राहकों के संदेश फिर भी सेव होते हैं।",
  swAi: "असिस्टेंट",
  swAiWhy: "रुकने पर लिखे गए सवालों को एक छोटा तय जवाब मिलता है और किसी व्यक्ति को बताया जाता है; AI को कुछ नहीं जाता। बटन और बुकिंग चलते रहते हैं।",
  aiLimit: (n, today) => `रोज़ की सीमा: कुल ${n} जवाब। आज अब तक: ${today}।`,
  on: "चालू",
  paused: "रुका हुआ",
  away: "छुट्टी पर",
  here: "मौजूद",
  envOff: "बॉट की इस कॉपी में बंद है। इसे सिर्फ़ डिप्लॉय से चालू किया जा सकता है, यहाँ से नहीं।",
  pausedByAway: "प्रैक्टिशनर छुट्टी पर हैं, इसलिए रुका है।",
  resume: "फिर से चालू करें",
  pause: "रोकें…",
  pauseConfirm: (what) => `रोकें: ${what}`,
  markAway: "छुट्टी पर दिखाएँ…",
  markAwayConfirm: "प्रैक्टिशनर को छुट्टी पर दिखाएँ",
  markBack: "प्रैक्टिशनर वापस आ गए हैं",
  switched: "स्विच बदल गया।",
  envIsMaster: "यह बॉट की इस कॉपी में बंद है, इसलिए यहाँ से चालू नहीं हो सकता।",
  secEmails: "ईमेल",
  digestWho: "रोज़ की रिपोर्ट (रात 9 बजे) किसे जाए",
  safetyWho: "सुरक्षा संपर्क: संकट वाले संदेश पर तुरंत किसे ईमेल जाए",
  ownerNote: "मालिक को बॉट के लिए तय अलर्ट वाले पते पर ईमेल जाता है।",
  ownerDefault: "(पहले से मालिक)",
  saveEmails: "ईमेल पाने वाले सेव करें",
  pickOne: "रोज़ की रिपोर्ट के लिए कम से कम एक व्यक्ति चुनें।",
  secPayments: "पेमेंट",
  rzpConnection: "Razorpay",
  rzpConnected: "जुड़ा हुआ",
  rzpMissing: "नहीं जुड़ा: बॉट की इस कॉपी में पेमेंट की चाबियाँ नहीं लगी हैं।",
  rzpMode: "मोड",
  rzpTest: "टेस्ट मोड: असली पैसा नहीं जाता",
  rzpLive: "लाइव मोड: असली पेमेंट",
  rzpUnknownMode: "पता नहीं चल रहा: Cloudflare में चाबी जाँचें",
  rzpMismatch: "चाबी का मोड और बॉट का पेमेंट मोड मेल नहीं खाते, इसलिए बॉट पेमेंट लिंक नहीं बनाएगा।",
  rzpLastNotice: "Razorpay से आख़िरी सूचना",
  rzpInternational: "विदेशी कार्ड",
  rzpInternationalWhy: "Razorpay की अपनी सेटिंग में चालू या बंद होते हैं, यहाँ नहीं।",
  never: "अभी तक नहीं",
  secPrivacy: "प्राइवेसी",
  chatKept: (how) => `ग्राहक के आख़िरी संदेश के ${how} बाद चैट का टेक्स्ट मिटा दिया जाता है। किसने कब लिखा, वह रहता है।`,
  namesKept: (days) => `आख़िरी बुकिंग के ${days} दिन बाद नाम और नंबर हटा दिए जाते हैं। पेमेंट और ऑडिट लॉग रहते हैं।`,
  staffRead: "स्टाफ़ चैट का टेक्स्ट पढ़ सकता है",
  staffReadOn: "स्टाफ़ चैट पढ़ता है ताकि जवाब दे सके। सुरक्षा संदेश उनसे हमेशा छिपे रहते हैं।",
  staffReadOff: "स्टाफ़ देखता है कि किसने कब लिखा, टेक्स्ट नहीं। सुरक्षा संदेश उनसे हमेशा छिपे रहते हैं।",
  staffHide: "चैट का टेक्स्ट स्टाफ़ से छिपाएँ…",
  staffHideConfirm: "चैट का टेक्स्ट स्टाफ़ से छिपाएँ",
  staffHideEffect: "स्टाफ़ नहीं देख पाएगा कि ग्राहक ने क्या लिखा, तो वे ठीक से जवाब नहीं दे पाएँगे। आप इसे फिर चालू कर सकते हैं।",
  staffShow: "स्टाफ़ को चैट का टेक्स्ट पढ़ने दें",
  yes: "हाँ",
  no: "नहीं",
  secSystem: "सिस्टम",
  botRan: "बॉट की हर 2 मिनट की जाँच",
  botRanOk: (ago) => `${ago} चली`,
  botRanStale: (min) => `${min} मिनट से नहीं चली: रिमाइंडर, पेमेंट की जाँच और चैट मिटाना इसी पर रुके हैं।`,
  lastIn: "ग्राहक का आख़िरी संदेश",
  lastOut: "आख़िरी भेजा गया संदेश",
  notDelivered: "जो संदेश नहीं पहुँचे (पिछले 24 घंटे)",
  aiToday: "आज असिस्टेंट के जवाब",
  lastAlert: "आख़िरी अलर्ट ईमेल",
  alertFailed: "नहीं गया: संकट और अलर्ट के ईमेल शायद आप तक नहीं पहुँच रहे।",
  payChecks: "जाँचने वाले पेमेंट",
  openPayments: "पेमेंट खोलें",
  ok: "ठीक",
  check: "देखें",
  problem: "गड़बड़",
  auditTitle: "ऑडिट लॉग",
  auditSub: "किसने क्या किया, और कब। कम से कम एक साल तक रखा जाता है।",
  filterWho: "व्यक्ति",
  filterWhat: "काम",
  everyone: "सब लोग",
  everything: "हर काम",
  beforeRoles: "रोल से पहले",
  theBot: "बॉट",
  system: "सिस्टम",
  filter: "दिखाएँ",
  older: "पुरानी एंट्री",
  noAudit: "अभी यहाँ कुछ नहीं है। बुकिंग, पैसे, सेटिंग और टीम के बदलाव होते ही यहाँ दिखते हैं।",
  noMatch: "कुछ मेल नहीं खाता। सब लोग, या हर काम चुनकर देखें।",
  backToSettings: "सेटिंग्स पर वापस",
  reasonLabel: (r) => `कारण: ${r}`,
};

export const SETTINGS_COPY: Record<"en" | "hi", Words> = { en, hi };
const W = (m: Member): Words => SETTINGS_COPY[consoleLang(m.locale)];

// What each audit action means, in words. An action not listed shows in plain lower case, never as a code.
const ACTION_WORDS: Record<string, { en: string; hi: string }> = {
  PRICE_CHANGED: { en: "Changed a price", hi: "दाम बदला" },
  SWITCH_CHANGED: { en: "Changed a bot switch", hi: "बॉट का स्विच बदला" },
  ADMIN_SWITCH: { en: "Changed a bot switch", hi: "बॉट का स्विच बदला" },
  BUSINESS_CHANGED: { en: "Changed the business details", hi: "बिज़नेस की जानकारी बदली" },
  EMAILS_CHANGED: { en: "Changed who gets emails", hi: "ईमेल पाने वाले बदले" },
  STAFF_CHAT_TEXT: { en: "Changed whether staff read chats", hi: "स्टाफ़ के चैट पढ़ने की सेटिंग बदली" },
  DATA_EXPORTED: { en: "Downloaded payments", hi: "पेमेंट डाउनलोड किए" },
  REFUND_RETRIED: { en: "Retried a refund", hi: "रिफ़ंड फिर से भेजा" },
  member_invited: { en: "Invited a member", hi: "सदस्य को बुलाया" },
  invite_accepted: { en: "Joined the team", hi: "टीम में शामिल हुए" },
  member_role_changed: { en: "Changed a role", hi: "रोल बदला" },
  member_removed: { en: "Removed a member", hi: "सदस्य हटाया" },
  ownership_transferred: { en: "Handed over ownership", hi: "मालिकाना हक़ सौंपा" },
  members_seeded: { en: "Set up the team", hi: "टीम बनाई" },
  MEMBER_LOCALE: { en: "Changed their language", hi: "अपनी भाषा बदली" },
  ADMIN_REFUND: { en: "Refunded", hi: "रिफ़ंड किया" },
  ADMIN_APPROVE_REFUND: { en: "Approved a refund", hi: "रिफ़ंड मंज़ूर किया" },
  ADMIN_KEEP_NO_REFUND: { en: "Declined a refund", hi: "रिफ़ंड मना किया" },
  ADMIN_BLOCK: { en: "Blocked a number", hi: "नंबर ब्लॉक किया" },
  ADMIN_UNBLOCK: { en: "Unblocked a number", hi: "नंबर अनब्लॉक किया" },
  ADMIN_REVEAL_NUMBER: { en: "Showed a full number", hi: "पूरा नंबर देखा" },
  ADMIN_REPLY: { en: "Replied to a chat", hi: "चैट में जवाब दिया" },
  ADMIN_RESOLVE: { en: "Closed an item", hi: "काम पूरा किया" },
  CRISIS: { en: "Sent the crisis message", hi: "संकट वाला संदेश भेजा" },
  EMERGENCY: { en: "Sent the emergency message", hi: "आपात संदेश भेजा" },
};
const actionText = (action: string, locale: string) =>
  ACTION_WORDS[action]?.[consoleLang(locale)] ?? action.replace(/^ADMIN_/, "").replaceAll("_", " ").toLowerCase().replace(/^./, (ch) => ch.toUpperCase());

// ---------- the page frame for the owner's screens (Payments uses it too) ----------
// Form fields and small layouts the shared stylesheet doesn't have yet; inline, as the CSP allows inline styles.
const EXTRA_CSS = `<style>
.fld{display:block;margin:0 0 16px}.fld>span{display:block;font-weight:500;margin:0 0 4px}.fld .help{display:block;color:var(--muted);font-size:16px;margin:4px 0 0}
.fld input[type=text],.fld select{width:100%;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px}
.fld.bad input,.fld.bad select{border:2px solid var(--danger)}.fld .err{display:block;color:var(--danger);font-size:16px;margin:4px 0 0}
.money{display:flex;align-items:center;gap:8px}.money b{font-size:20px}.money input{max-width:12em}
.pick{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;border:0}.pick legend{font-weight:500;margin:0 0 8px;padding:0}
.pick label{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer}
.pick input{width:22px;height:22px;margin:0;accent-color:var(--accent)}
.sw{display:inline-block;width:20px;height:20px;border-radius:50%;border:1px solid var(--line)}
.kv{display:grid;grid-template-columns:minmax(0,1fr);gap:4px 16px;margin:0}.kv dt{color:var(--muted);font-size:16px;margin:12px 0 0}.kv dt:first-child{margin-top:0}.kv dd{margin:0;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 12px}.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px}
.stat .k{color:var(--muted);font-size:16px;margin:0}.stat .v{font-size:24px;font-weight:600;margin:4px 0 0;overflow-wrap:anywhere}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:0 0 16px}.filters .fld{flex:1 1 200px;margin:0}
.log .row{align-items:flex-start;flex-wrap:wrap}.log .row>div{min-width:0;flex:1 1 260px}.log time{color:var(--muted);white-space:nowrap}
.note{color:var(--muted);font-size:16px}
@media (min-width:900px){.kv{grid-template-columns:minmax(180px,1fr) minmax(0,2fr)}.kv dt{margin:0}.stats{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>`;

export async function businessName(env: Env): Promise<string> {
  return (await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(WORKSPACE_ID).first<{ name: string }>())?.name ?? "";
}

export async function ownerPage(c: ConsoleCtx, o: { active: TabId; title: string; body: unknown; flash?: string | null; status?: 200 | 400; back: string }) {
  const m = c.get("member");
  const [name, accent] = await Promise.all([businessName(c.env), accentOf(c.env.DB)]);
  const res = await c.html(
    consoleFrame({
      role: m.role, locale: m.locale, active: o.active, title: o.title, business: name, member: m.displayName || m.email, flash: o.flash ?? null,
      language: { csrf: await languageCsrf(c.get("jwt"), m), back: o.back },
      body: html`${raw(accentCss(accent))}${raw(EXTRA_CSS)}${o.body}`,
    }),
    o.status ?? 200,
  );
  return res;
}

// "4 min ago" / "4 मिनट पहले", short and in the member's language.
export function agoText(utc: string | null | undefined, locale: string, nowMs = Date.now()): string {
  if (!utc) return "";
  const hi = consoleLang(locale) === "hi";
  const m = Math.max(0, Math.round((nowMs - Date.parse(utc)) / 60_000));
  if (m < 1) return hi ? "अभी" : "just now";
  if (m < 60) return hi ? `${m} मिनट पहले` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return hi ? `${h} घंटे पहले` : `${h} h ago`;
  const d = Math.round(h / 24);
  return hi ? `${d} दिन पहले` : `${d} days ago`;
}
export const whenText = (utc: string | null | undefined, locale: string) => (utc ? `${dayName(utc, locale)}, ${clock(utc, locale)}` : "");

export const rupeesText = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

// ---------- the routes ----------
export const settings = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

// Only the owner reaches anything here (GET or POST): Settings is business_settings, the audit log read_audit.
settings.use("*", async (c, next) => {
  const action = c.req.path.startsWith("/app/settings/audit") ? "read_audit" : "business_settings";
  if (can(c.get("member"), action) !== "yes") return refused(c);
  await next();
});

const FLASH = ["saved", "nothingChanged", "switched", "envIsMaster"] as const;
type Flash = (typeof FLASH)[number];
const back = (c: ConsoleCtx, code: Flash, anchor = "") => c.redirect(`/app/settings?m=${code}${anchor ? `#${anchor}` : ""}`, 303);
const formOf = async (c: ConsoleCtx) => (await c.req.parseBody({ all: true })) as Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const token = (c: ConsoleCtx, scope: string) => memberCsrf(c.get("jwt"), c.get("member"), `settings-${scope}`);
const okToken = async (c: ConsoleCtx, f: Record<string, unknown>, scope: string) => one(f.csrf as string) === (await token(c, scope));
const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

// How long chat text is kept, in words.
function keptFor(env: Env, locale: string): string {
  const hiL = consoleLang(locale) === "hi";
  const m = Number(env.CHAT_RETENTION_MINUTES);
  const mins = Number.isFinite(m) && m > 0 ? m : config.retention.defaultMinutes;
  if (mins >= 1440) return hiL ? `${Math.round(mins / 1440)} दिन` : `${Math.round(mins / 1440)} days`;
  return hiL ? `${mins} मिनट` : `${mins} minutes`;
}

// The form values on a failed save, so the page comes back with them still filled in.
type PriceForm = { values: Partial<Record<PriceName, string>>; bad: PriceName[] };
type BusinessForm = { name: string; bad: boolean };

async function settingsPage(c: ConsoleCtx, o: { flash?: string | null; status?: 200 | 400; prices?: PriceForm; business?: BusinessForm; emailsBad?: boolean } = {}) {
  const m = c.get("member");
  const w = W(m);
  const lang = m.locale;
  const env = c.env;
  const now = Date.now();
  const [name, accent, P, sw, members, digestIds, safetyIds, staffRead, defaultLocale] = await Promise.all([
    businessName(env), accentOf(env.DB), readPrices(env.DB), switchStates(env), listMembers(env), chosenIds(env.DB, "digest"), chosenIds(env.DB, "safety"),
    staffReadsChat(env.DB), getSetting(env.DB, KEYS.locale),
  ]);
  const active = members.filter((x) => x.status === "active");
  const owner = active.find((x) => x.role === "OWNER");
  const who = (x: Member) => `${x.displayName || x.email} · ${roleName(x.role, lang)}`;

  // Business
  const bForm = o.business;
  const business = html`<div class="card" id="business"><form method="post" action="/app/settings/business">${hidden("csrf", await token(c, "business"))}
<label class="fld${bForm?.bad ? " bad" : ""}"><span>${w.businessName}</span><input type="text" name="name" maxlength="60" required value="${bForm?.name ?? name}" autocomplete="organization">
${bForm?.bad ? html`<span class="err">${w.badName}</span>` : html`<span class="help">${w.businessNameHelp}</span>`}</label>
<fieldset class="pick"><legend>${w.accent}</legend>${(Object.keys(ACCENTS) as AccentName[]).map(
    (a) => html`<label><input type="radio" name="accent" value="${a}"${a === accent ? raw(" checked") : ""}><span class="sw" style="background:${ACCENTS[a].light}" aria-hidden="true"></span>${w.accentNames[a]}</label>`,
  )}</fieldset>
<label class="fld"><span>${w.defaultLanguage}</span><select name="locale"><option value="en"${defaultLocale !== "hi" ? raw(" selected") : ""}>${w.english}</option><option value="hi"${defaultLocale === "hi" ? raw(" selected") : ""}>${w.hindi}</option></select></label>
<dl class="kv"><dt>${w.timeZone}</dt><dd>${w.timeZoneIndia}</dd></dl>
<div class="acts"><button class="btn primary" type="submit">${w.saveBusiness}</button></div></form></div>`;

  // Prices
  const pf = o.prices;
  const label = (n: PriceName) =>
    n === "intro" ? w.priceIntro(config.slots.callMinutes) : n === "single" ? w.priceSingle(config.slots.sessionMinutes) : w.pricePack(DEFAULT_PRICES[n].sessions);
  const priceField = (n: PriceName) => {
    const bad = pf?.bad.includes(n);
    const value = pf?.values[n] ?? String(pricePaise(P, n) / 100);
    const pack = n === "pack10" || n === "pack20" ? P[n] : null;
    const help = [w.priceDefault(rupeesText(pricePaise(DEFAULT_PRICES, n))), pack ? w.perSession(rupeesText(pack.paise / pack.sessions)) : ""].filter(Boolean).join(" · ");
    return html`<label class="fld${bad ? " bad" : ""}"><span>${label(n)}</span><span class="money"><b aria-hidden="true">₹</b><input type="text" name="${n}" inputmode="numeric" pattern="[0-9,]*" required value="${value}" aria-describedby="help-${n}"></span>
<span class="${bad ? "err" : "help"}" id="help-${n}">${bad ? (pack ? w.badPack(pack.sessions) : w.badPrice) : help}</span></label>`;
  };
  const pricesCard = html`<div class="card" id="prices"><p class="why">${w.pricesWhy}</p><form method="post" action="/app/settings/prices">${hidden("csrf", await token(c, "prices"))}
<p class="note">${w.rupeesOnly}</p>${PRICE_NAMES.map(priceField)}<div class="acts"><button class="btn primary" type="submit">${w.savePrices}</button></div></form></div>`;

  // Team and audit log
  const team = rows(html`<a class="row" href="/app/settings/team"><div><p class="t">${w.secTeam}</p><p class="s">${w.teamWhy}</p></div><span aria-hidden="true">›</span></a>
<a class="row" href="/app/settings/audit"><div><p class="t">${w.auditLink}</p><p class="s">${w.auditWhy}</p></div><span aria-hidden="true">›</span></a>`);

  // Bot switches
  const aiToday = (await env.DB.prepare("SELECT COALESCE(SUM(ai_count), 0) AS n FROM person_state WHERE ai_day = ?1").bind(istDay(now)).first<{ n: number }>())?.n ?? 0;
  const SW: Record<SwitchName, { title: string; why: string }> = {
    NEW_BOOKINGS: { title: w.swBookings, why: w.swBookingsWhy },
    AMMA_AWAY: { title: w.swAway, why: w.swAwayWhy },
    SENDS: { title: w.swSends, why: w.swSendsWhy },
    AI_REPLIES: { title: w.swAi, why: w.swAiWhy },
  };
  const away = sw.find((s) => s.name === "AMMA_AWAY")!.on;
  const switchCards = await Promise.all(
    sw.map(async (s) => {
      const t = SW[s.name];
      const post = async (v: "on" | "off") => ({ action: "/app/settings/switch", csrf: await token(c, `switch:${s.name}:${v}`), fields: { name: s.name, v } });
      let chip: unknown;
      let act: unknown = "";
      let note = "";
      if (s.name === "AMMA_AWAY") {
        chip = s.on ? statusChip(w.away, "attention") : statusChip(w.here, "done");
        act = s.on
          ? html`<form method="post" action="/app/settings/switch">${hidden("csrf", (await post("off")).csrf)}${hidden("name", s.name)}${hidden("v", "off")}<button class="btn primary" type="submit">${w.markBack}</button></form>`
          : confirmStep({ label: w.markAway, effect: t.why, confirm: w.markAwayConfirm, post: await post("on") });
      } else {
        chip = s.on ? statusChip(w.on, "done") : statusChip(w.paused, s.name === "SENDS" ? "danger" : "attention");
        if (!s.envOn) note = w.envOff;
        else if (s.name === "NEW_BOOKINGS" && away && s.paused) note = w.pausedByAway;
        if (s.envOn)
          act = s.paused
            ? html`<form method="post" action="/app/settings/switch">${hidden("csrf", (await post("on")).csrf)}${hidden("name", s.name)}${hidden("v", "on")}<button class="btn primary" type="submit">${w.resume}</button></form>`
            : confirmStep({ label: w.pause, effect: t.why, confirm: w.pauseConfirm(t.title), post: await post("off") });
      }
      const limit = s.name === "AI_REPLIES" ? html`<p class="why">${w.aiLimit(config.ai.aiRepliesPerDayTotal, aiToday)}</p>` : "";
      return html`<article class="card" id="sw-${s.name.toLowerCase()}"><h3>${t.title}</h3>${chip}<p class="why">${t.why}</p>${limit}${note ? html`<p class="why"><b>${note}</b></p>` : ""}${act ? html`<div class="acts">${act}</div>` : ""}</article>`;
    }),
  );

  // Emails
  const digestSet = new Set(digestIds?.length ? digestIds : owner ? [owner.id] : []);
  const safetyId = safetyIds?.find((id) => active.some((x) => x.id === id)) ?? owner?.id;
  const emails = html`<div class="card" id="emails"><form method="post" action="/app/settings/emails">${hidden("csrf", await token(c, "emails"))}
<fieldset class="pick${o.emailsBad ? " bad" : ""}"><legend>${w.digestWho}</legend>${active.map(
    (x) => html`<label><input type="checkbox" name="digest" value="${x.id}"${digestSet.has(x.id) ? raw(" checked") : ""}>${who(x)}</label>`,
  )}</fieldset>${o.emailsBad ? html`<p class="err" style="color:var(--danger)">${w.pickOne}</p>` : ""}
<label class="fld"><span>${w.safetyWho}</span><select name="safety">${active.map(
    (x) => html`<option value="${x.id}"${x.id === safetyId ? raw(" selected") : ""}>${who(x)}${x.role === "OWNER" ? ` ${w.ownerDefault}` : ""}</option>`,
  )}</select></label>
<p class="note">${w.ownerNote}</p><div class="acts"><button class="btn primary" type="submit">${w.saveEmails}</button></div></form></div>`;

  // Payments (Razorpay): status in words, never a key
  const keyId = env.RAZORPAY_KEY_ID ?? "";
  const connected = Boolean(keyId && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET);
  const keyMode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : null;
  const botMode = env.PAYMENT_MODE === "live" ? "live" : "test";
  const lastRzp = (await env.DB.prepare("SELECT MAX(received_at) AS at FROM events WHERE provider = 'razorpay'").first<{ at: string | null }>())?.at ?? null;
  const rzp = html`<div class="card" id="razorpay"><h3>${w.rzpConnection}</h3>${connected ? statusChip(w.rzpConnected, "done") : statusChip(w.rzpMissing, "danger")}
<dl class="kv" style="margin-top:16px"><dt>${w.rzpMode}</dt><dd>${keyMode === "live" ? w.rzpLive : keyMode === "test" ? w.rzpTest : w.rzpUnknownMode}${
    keyMode && keyMode !== botMode ? html`<br>${statusChip(w.rzpMismatch, "danger")}` : ""
  }</dd>
<dt>${w.rzpLastNotice}</dt><dd>${lastRzp ? `${whenText(lastRzp, lang)} (${agoText(lastRzp, lang, now)})` : w.never}</dd>
<dt>${w.rzpInternational}</dt><dd>${w.rzpInternationalWhy}</dd></dl></div>`;

  // Privacy
  const privacy = html`<div class="card" id="privacy"><p>${w.chatKept(keptFor(env, lang))}</p><p>${w.namesKept(config.retention.nameDaysAfterLastBooking)}</p>
<h3 style="margin-top:16px">${w.staffRead}</h3>${staffRead ? statusChip(w.yes, "done") : statusChip(w.no, "plain")}<p class="why">${staffRead ? w.staffReadOn : w.staffReadOff}</p>
<div class="acts">${
    staffRead
      ? confirmStep({ label: w.staffHide, effect: w.staffHideEffect, confirm: w.staffHideConfirm, post: { action: "/app/settings/privacy", csrf: await token(c, "privacy:off"), fields: { v: "off" } } })
      : html`<form method="post" action="/app/settings/privacy">${hidden("csrf", await token(c, "privacy:on"))}${hidden("v", "on")}<button class="btn primary" type="submit">${w.staffShow}</button></form>`
  }</div></div>`;

  const system = await systemCard(c, now);
  const body = html`${screenHead("settings", lang)}
${section(w.secBusiness, business)}${section(w.secPrices, pricesCard)}${section(w.secTeam, team)}${section(w.secBot, switchCards)}
${section(w.secEmails, emails)}${section(w.secPayments, rzp)}${section(w.secPrivacy, privacy)}${section(w.secSystem, system)}`;
  return ownerPage(c, { active: "settings", title: SETTINGS_TITLE[consoleLang(lang)], body, flash: o.flash, status: o.status, back: "/app/settings" });
}
const SETTINGS_TITLE = { en: "Settings", hi: "सेटिंग्स" };

// Today's health checks, moved here from /admin, in words: the 2-minute check, the last messages, the assistant, the alert email, money.
async function systemCard(c: ConsoleCtx, now: number) {
  const env = c.env;
  const m = c.get("member");
  const w = W(m);
  const lang = m.locale;
  const [beat, lastIn, lastOut, failed, ai, mail, pays] = await Promise.all([
    getSetting(env.DB, HEARTBEAT_KEY),
    env.DB.prepare("SELECT MAX(created_at) AS at FROM messages WHERE direction = 'IN'").first<{ at: string | null }>(),
    env.DB.prepare("SELECT MAX(created_at) AS at FROM messages WHERE direction = 'OUT' AND status = 'SENT'").first<{ at: string | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'OUT' AND status IN ('FAILED', 'UNKNOWN') AND created_at >= ?1").bind(iso(now - 86_400_000)).first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(ai_count), 0) AS n FROM person_state WHERE ai_day = ?1").bind(istDay(now)).first<{ n: number }>(),
    getSetting(env.DB, MAIL_LAST_KEY),
    env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE state IN ('UNKNOWN', 'REFUND_FAILED')").first<{ n: number }>(),
  ]);
  const stale = !beat || now - Date.parse(beat) > HEARTBEAT_STALE_MIN * 60_000;
  const [mailState, mailAt] = mail?.split("|") ?? [null, null];
  const line = (label: string, value: unknown, tone: ChipTone, word: string) => html`<dt>${label}</dt><dd>${statusChip(word, tone)} ${value}</dd>`;
  const at = (v: string | null | undefined) => (v ? `${whenText(v, lang)} (${agoText(v, lang, now)})` : w.never);
  const aiHigh = (ai?.n ?? 0) >= config.ai.aiRepliesPerDayTotal * 0.8;
  return html`<div class="card" id="system"><dl class="kv">
${line(w.botRan, stale ? w.botRanStale(HEARTBEAT_STALE_MIN) : w.botRanOk(agoText(beat, lang, now)), stale ? "danger" : "done", stale ? w.problem : w.ok)}
${line(w.lastIn, at(lastIn?.at), "plain", "·")}
${line(w.lastOut, at(lastOut?.at), "plain", "·")}
${line(w.notDelivered, String(failed?.n ?? 0), failed?.n ? "attention" : "done", failed?.n ? w.check : w.ok)}
${line(w.aiToday, `${ai?.n ?? 0} / ${config.ai.aiRepliesPerDayTotal}`, aiHigh ? "attention" : "done", aiHigh ? w.check : w.ok)}
${line(w.lastAlert, mailState === "FAILED" ? html`${at(mailAt)}<br>${w.alertFailed}` : at(mailAt), mailState === "FAILED" ? "danger" : "done", mailState === "FAILED" ? w.problem : w.ok)}
${line(w.payChecks, html`${pays?.n ?? 0}${pays?.n ? html` · <a href="/app/payments">${w.openPayments}</a>` : ""}`, pays?.n ? "danger" : "done", pays?.n ? w.problem : w.ok)}
</dl></div>`;
}

settings.get("/", (c) => {
  const code = c.req.query("m") as Flash | undefined;
  const w = W(c.get("member"));
  return settingsPage(c, { flash: code && FLASH.includes(code) ? w[code] : null });
});

// ---- Business: name, accent, default language ----
settings.post("/business", async (c) => {
  const f = await formOf(c);
  if (!(await okToken(c, f, "business"))) return c.text("Forbidden", 403);
  const name = one(f.name).trim().replace(/\s+/g, " ");
  const accent = one(f.accent);
  const locale = one(f.locale);
  if (!isAccent(accent) || (locale !== "en" && locale !== "hi")) return c.text("Bad request", 400);
  if (!name || name.length > 60) return settingsPage(c, { flash: W(c.get("member")).notSaved, status: 400, business: { name, bad: true } });
  const db = c.env.DB;
  const at = iso(Date.now());
  const upsert = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE settings.value != ?2").bind(key, value, at);
  const res = await db.batch([
    db.prepare("UPDATE workspaces SET name = ?2 WHERE id = ?1 AND name != ?2").bind(WORKSPACE_ID, name),
    auditStmt(c, "BUSINESS_CHANGED", "workspace:1", "name"),
    upsert(KEYS.accent, accent),
    auditStmt(c, "BUSINESS_CHANGED", KEYS.accent, accent),
    upsert(KEYS.locale, locale),
    auditStmt(c, "BUSINESS_CHANGED", KEYS.locale, locale),
  ]);
  return back(c, res.some((r, i) => i % 2 === 0 && r.meta.changes) ? "saved" : "nothingChanged", "business");
});

// ---- Prices: whole rupees; each change is audited as "old -> new" in paise, which is also how a payment is checked later ----
settings.post("/prices", async (c) => {
  const f = await formOf(c);
  if (!(await okToken(c, f, "prices"))) return c.text("Forbidden", 403);
  const values: Partial<Record<PriceName, string>> = {};
  const bad: PriceName[] = [];
  const next: Partial<Record<PriceName, number>> = {};
  for (const n of PRICE_NAMES) {
    const raw = one(f[n]).trim();
    values[n] = raw;
    const clean = raw.replace(/[₹,\s]/g, "");
    const paise = /^\d{1,7}$/.test(clean) ? Number(clean) * 100 : NaN;
    if (validPrice(n, paise)) next[n] = paise;
    else bad.push(n);
  }
  if (bad.length) return settingsPage(c, { flash: W(c.get("member")).notSaved, status: 400, prices: { values, bad } });
  const db = c.env.DB;
  const now: Prices = await readPrices(db);
  const at = iso(Date.now());
  const stmts = PRICE_NAMES.filter((n) => next[n] !== pricePaise(now, n)).flatMap((n) => [
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3").bind(KEYS[n], String(next[n]), at),
    auditStmt(c, "PRICE_CHANGED", KEYS[n], `${pricePaise(now, n)} -> ${next[n]}`),
  ]);
  if (!stmts.length) return back(c, "nothingChanged", "prices");
  await db.batch(stmts);
  await loadPrices(c.env); // this request's isolate quotes the new prices at once
  return back(c, "saved", "prices");
});

// ---- The bot switches: the same rule as /admin. A setting can only pause what the env flag allows; it never turns one on. ----
settings.post("/switch", async (c) => {
  const f = await formOf(c);
  const name = one(f.name);
  const v = one(f.v);
  if (!isSwitch(name) || (v !== "on" && v !== "off")) return c.text("Bad request", 400);
  if (!(await okToken(c, f, `switch:${name}:${v}`))) return c.text("Forbidden", 403);
  const sw = (await switchStates(c.env)).find((s) => s.name === name)!;
  if (name !== "AMMA_AWAY" && v === "on" && !sw.envOn) return back(c, "envIsMaster", `sw-${name.toLowerCase()}`);
  const value = name === "AMMA_AWAY" ? (v === "on" ? "true" : "false") : v === "off" ? "false" : "true";
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE settings.value != ?2").bind(name, value, iso(Date.now())),
    auditStmt(c, "SWITCH_CHANGED", name, v),
  ]);
  if (name === "AMMA_AWAY" && v === "on") await raiseAwayItems(c.env);
  return back(c, "switched", `sw-${name.toLowerCase()}`);
});

// ---- Who gets the daily summary and the crisis email: active members only ----
settings.post("/emails", async (c) => {
  const f = await formOf(c);
  if (!(await okToken(c, f, "emails"))) return c.text("Forbidden", 403);
  const active = (await listMembers(c.env)).filter((m) => m.status === "active");
  const ids = new Set(active.map((m) => m.id));
  const digest = [...new Set((Array.isArray(f.digest) ? f.digest : f.digest ? [f.digest] : []).map(Number))].filter((id) => ids.has(id)).sort((a, b) => a - b);
  const safety = Number(one(f.safety));
  if (!ids.has(safety)) return c.text("Bad request", 400);
  if (!digest.length) return settingsPage(c, { flash: W(c.get("member")).notSaved, status: 400, emailsBad: true });
  const db = c.env.DB;
  const at = iso(Date.now());
  const upsert = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE settings.value != ?2").bind(key, value, at);
  const res = await db.batch([
    upsert(KEYS.digest, digest.join(",")),
    auditStmt(c, "EMAILS_CHANGED", KEYS.digest, digest.map((id) => `member:${id}`).join(",")),
    upsert(KEYS.safety, String(safety)),
    auditStmt(c, "EMAILS_CHANGED", KEYS.safety, `member:${safety}`),
  ]);
  return back(c, res[0].meta.changes || res[2].meta.changes ? "saved" : "nothingChanged", "emails");
});

// ---- Privacy: whether staff read chat text (safety messages are hidden from staff whatever this says) ----
settings.post("/privacy", async (c) => {
  const f = await formOf(c);
  const v = one(f.v);
  if (v !== "on" && v !== "off") return c.text("Bad request", 400);
  if (!(await okToken(c, f, `privacy:${v}`))) return c.text("Forbidden", 403);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE settings.value != ?2").bind(KEYS.staffReadChat, v === "on" ? "true" : "false", iso(Date.now())),
    auditStmt(c, "STAFF_CHAT_TEXT", KEYS.staffReadChat, v),
  ]);
  return back(c, "saved", "privacy");
});

// ---- The audit log: newest first, 50 at a time, filtered by person and action ----
type AuditRow = { id: number; at: string; actor: string; action: string; target: string | null; detail: string | null; memberId: number | null; reason: string | null; name: string | null; email: string | null };
export const AUDIT_PAGE = 50;

settings.get("/audit", async (c) => {
  const m = c.get("member");
  const w = W(m);
  const lang = m.locale;
  const who = c.req.query("who") ?? ""; // "" | member id | "before" | "bot" | "system"
  const what = (c.req.query("what") ?? "").slice(0, 64);
  const before = Number(c.req.query("before"));
  const where: string[] = ["(a.workspace_id = ?1 OR a.workspace_id IS NULL)"];
  const binds: unknown[] = [WORKSPACE_ID];
  const bind = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (/^\d+$/.test(who)) where.push(`a.member_id = ${bind(Number(who))}`);
  else if (who === "bot") where.push("a.member_id IS NULL AND a.actor = 'bot'");
  else if (who === "system") where.push("a.member_id IS NULL AND a.actor = 'system'");
  else if (who === "before") where.push("a.member_id IS NULL AND a.actor NOT IN ('bot', 'system')");
  if (what) where.push(`a.action = ${bind(what)}`);
  if (Number.isInteger(before) && before > 0) where.push(`a.id < ${bind(before)}`);
  const { results } = await c.env.DB
    .prepare(
      `SELECT a.id, a.at, a.actor, a.action, a.target, a.detail, a.member_id AS memberId, a.reason, mb.display_name AS name, mb.email
       FROM audit_log a LEFT JOIN members mb ON mb.id = a.member_id WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ${AUDIT_PAGE + 1}`,
    )
    .bind(...binds)
    .all<AuditRow>();
  const page = results.slice(0, AUDIT_PAGE);
  const more = results.length > AUDIT_PAGE;
  const actions = (await c.env.DB.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all<{ action: string }>()).results.map((r) => r.action);
  const members = await c.env.DB.prepare("SELECT id, display_name AS name, email FROM members WHERE workspace_id = ?1 ORDER BY id").bind(WORKSPACE_ID).all<{ id: number; name: string | null; email: string }>();
  const by = (r: AuditRow) =>
    r.memberId != null ? r.name || r.email || "" : r.actor === "bot" ? w.theBot : r.actor === "system" ? w.system : `${w.beforeRoles} · ${r.actor}`;
  const sel = (v: string, cur: string) => (v === cur ? raw(" selected") : "");
  const filters = html`<form class="filters" method="get" action="/app/settings/audit" role="search">
<label class="fld"><span>${w.filterWho}</span><select name="who"><option value="">${w.everyone}</option>${members.results.map((x) => html`<option value="${x.id}"${sel(String(x.id), who)}>${x.name || x.email}</option>`)}
<option value="before"${sel("before", who)}>${w.beforeRoles}</option><option value="bot"${sel("bot", who)}>${w.theBot}</option><option value="system"${sel("system", who)}>${w.system}</option></select></label>
<label class="fld"><span>${w.filterWhat}</span><select name="what"><option value="">${w.everything}</option>${actions.map((a) => html`<option value="${a}"${sel(a, what)}>${actionText(a, lang)}</option>`)}</select></label>
<button class="btn" type="submit">${w.filter}</button></form>`;
  const list = page.length
    ? html`<div class="rows log">${page.map(
        (r) => html`<div class="row"><div><p class="t">${actionText(r.action, lang)}</p><p class="s">${by(r)}${r.target ? ` · ${r.target}` : ""}${r.detail ? ` · ${r.detail}` : ""}</p>${
          r.reason ? html`<p class="s">${w.reasonLabel(r.reason)}</p>` : ""
        }</div><time datetime="${r.at}">${whenText(r.at, lang)}</time></div>`,
      )}</div>`
    : emptyState(who || what ? w.noMatch : w.noAudit, who || what ? { label: w.everyone, href: "/app/settings/audit" } : { label: w.backToSettings, href: "/app/settings" });
  const q = new URLSearchParams({ ...(who ? { who } : {}), ...(what ? { what } : {}), before: String(page.at(-1)?.id ?? 0) });
  const body = html`${screenHead("settings", lang)}<p><a href="/app/settings">← ${w.backToSettings}</a></p>
${section(w.auditTitle, html`<p class="note">${w.auditSub}</p>${filters}${list}${more ? html`<div class="acts"><a class="btn" href="/app/settings/audit?${q.toString()}">${w.older}</a></div>` : ""}`)}`;
  return ownerPage(c, { active: "settings", title: w.auditTitle, body, back: "/app/settings/audit" });
});
