// Ticket 32: free automatic replies to Instagram DMs (@disha_dira) and Facebook Messenger (the Page "Disha Dira Pranic Healing"), behind
// SOCIAL_REPLIES. Whatever someone writes, they are asked to follow us ("we share a short Pranic Healing tip every week"); once they
// follow, they get the WhatsApp link to book (and if they write again without following, the link comes with the ask). No number is ever shown except inside the wa.me link. The WhatsApp webhook (/wa/webhook,
// src/whatsapp.ts) is a separate route and is not touched by any of this.
//
// Official Meta APIs only (Messenger Platform, and the Messenger API for Instagram through the Facebook Page). Read on 30 Oct 2026:
//  - Webhooks (verify GET with hub.challenge; X-Hub-Signature-256 = HMAC-SHA256 of the raw body with the app secret; 200 within 5 seconds;
//    retries, so dedupe): https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks.md
//  - Instagram webhooks (object "instagram", entry.id = the Instagram professional account id, entry.messaging[]: message with mid, text,
//    attachments incl. story_mention, is_echo, is_deleted, is_unsupported, quick_reply.payload; postback {mid, title, payload}; read;
//    reaction; echoes of our own sends come with the `messages` field):
//    https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks.md
//  - Messenger echoes (message.is_echo, app_id, and `metadata` echoed back from the Send API):
//    https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes.md
//  - Messenger postbacks (postback.mid, title, payload):
//    https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_postbacks.md
//  - Send API, both platforms: POST /{PAGE-ID}/messages with the Page access token, recipient.id = the person's scoped id; Instagram text
//    under 1,000 bytes: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message.md
//  - Button template (text up to 640 chars, 1 to 3 web_url / postback buttons; on Instagram not shown in the web version):
//    https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/template/button.md
//    https://developers.facebook.com/documentation/business-messaging/instagram-messaging/button-template.md
//  - Instagram user profile: GET /{IGSID}?fields=is_user_follow_business with the Page token (instagram_basic, instagram_manage_messages,
//    pages_manage_metadata, pages_read_engagement, pages_show_list; only after the person has messaged us):
//    https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile
//  - Private replies to comments (one message per comment, within 7 days; recipient {comment_id}; Instagram: instagram_manage_comments +
//    pages_messaging, Advanced Access, the Human Agent feature; Facebook: pages_messaging; the reply opens the chat only once they answer):
//    https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies.md
//    https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/private-replies.md
//  - Comment webhooks: Instagram field `comments` (entry.changes[].value: id or comment_id, from.id, parent_id, text, media.id),
//    https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md ; Page field `feed` (value.item "comment",
//    verb "add", comment_id, post_id, parent_id, from.id, message), https://developers.facebook.com/docs/graph-api/webhooks/reference/page/
//  - Quick replies (up to 13, titles up to 20 characters, sent with a text; the tap comes back as message.quick_reply.payload):
//    https://developers.facebook.com/docs/messenger-platform/reference/buttons/quick-replies ; Messenger private replies take "all
//    messaging types available for using the Send API": https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
//  - Referrals (m.me link or ad in an existing chat; "This action will reset the 24-hour standard messaging window"):
//    https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links.md
// Whether someone follows the Facebook Page cannot be read, so on Messenger "I've followed" sends the link. The Facebook app (not the
// Messenger app) can't show button templates, so Messenger gets text with the links written out and quick replies (see askMessage).
// Insults, threats and sexual messages are handled as on WhatsApp, with the same word lists (config.noise): no reply; a block word or a
// second offence blocks (no more automatic replies on that channel; safety messages and "delete my data" still work); a threat is an
// urgent item. Paying customers are never blocked (CONTRACT "Noise").
// Stored: the platform id, language, step, times and an offence count (migrations/0012_social.sql, 0013, 0014). Never message text, names
// or usernames (only a short hash of our own outgoing text, to know its echo); logs carry reason codes and Meta error codes only
// (test/logging.test.ts).
import type { Context } from "hono";
import { html } from "hono/html";
import { prices } from "./business";
import { config } from "./config";
import { copyFor, rupees, type Copy, type Lang } from "./copy";
import type { Env } from "./env";
import { classifyWithoutAI, isAckWord, isJobText, isMenuWord, isOptOut, isThreat, LINK } from "./gate";
import { matchTopic, topicText, type Topic as RouterTopic } from "./router";
import { detectSafety, hasPhrase, normalize, type Safety } from "./safety";
import { recipients } from "./business";
import { sendEmailToEach } from "./mail";
import { isPayingCustomer } from "./noise";
import { raiseAttention } from "./send";
import { iso } from "./slots";
import { sendsEnvOn, sendsOn } from "./switches";
import { validSignature } from "./whatsapp";

type C = Context<{ Bindings: Env }>;
export type Platform = "instagram" | "messenger";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const FOLLOWING = "SOCIAL_FOLLOWING"; // the postback of the "I'm following" button
export const METADATA = "dd-bot"; // sent with every Messenger message, so its echo is known to be ours
export const SAFETY_ITEM = "SOCIAL_SAFETY";
export const THREAT_ITEM = "SOCIAL_THREAT";

// ---- the words (EN and HI). Hindi speaks as "we", so no gender shows (docs/KNOWLEDGE.md §1). It is the automated assistant, never a person.
// Facts only from docs/KNOWLEDGE.md and the prices in force (src/business.ts). ----
// Social's own topics (config.social.keywords), then the WhatsApp router's (config.router.topics) that social has no line of its own for.
type Own = keyof typeof config.social.keywords;
const OWN = Object.keys(config.social.keywords) as Own[];
// Router topics that mean the same as one of ours get our line.
const SAME = { price: "price", refund: "refund", book: "book", what_is_this: "what" } as const satisfies Partial<Record<RouterTopic, Own>>;
type FromWhatsApp = Exclude<RouterTopic, keyof typeof SAME>;
const FROM_WHATSAPP = (Object.keys(config.router.topics) as RouterTopic[]).filter((t): t is FromWhatsApp => !(t in SAME));
// Tried before our own: an illness, "black magic", a payment problem, "when is my call" (as on WhatsApp, where they come first too).
const FIRST = ["medical", "black_magic", "payment_issue", "my_booking"] as const satisfies readonly FromWhatsApp[];
// Answered with [Message on WhatsApp] and the WhatsApp text "Hi" instead of the booking button: no booking push after an illness is named
// (docs/KNOWLEDGE.md §5, 59-62), and a booking or payment is looked at on WhatsApp.
const NO_BOOK = ["medical", "my_booking", "payment_issue"] as const satisfies readonly FromWhatsApp[];
export type Topic = Own | FromWhatsApp;
// The questions offered as quick replies after the follow (Instagram: at most 13, titles up to 20 characters; Messenger the same).
export const QUESTIONS = ["book", "price", "what", "how"] as const satisfies readonly Topic[];
const QR = (t: Topic) => `SOCIAL_Q_${t.toUpperCase()}`;
const qrTopic = (payload: string): Topic | null => QUESTIONS.find((t) => QR(t) === payload) ?? null;

type Words = {
  ask: string;
  askAgain: string; // they wrote again without following: the ask, and the way to book straight away
  notYet: string;
  guide: string; // after the follow: the way to book
  guideMember: string; // the same for someone who already follows us when they first write (Instagram checks)
  welcomeBack: string; // a follower who had the link and comes back (the link, then the questions)
  welcomeBooked: string; // someone who has booked (or says so) comes back: the way to WhatsApp, no ₹99 call
  thanksBooked: string; // "I booked already", "paid"
  paidProblem: string; // "I paid but got no confirmation"
  stopped: string; // "not interested", "stop"
  questions: string; // Instagram: the quick replies' own message (Instagram puts quick replies on text only)
  after: (url?: string) => string; // Messenger writes the link out; Instagram has the button only
  commentBook: string; // a comment from someone who already had the link
  pageLabel: string; // Messenger: "Our Page: <url>"
  deleted: string;
  lines: Record<Topic, string>;
  qrTitles: Record<(typeof QUESTIONS)[number], string>;
  btnVisit: string; // Instagram only
  btnFollowing: Record<Platform, string>;
  btnBook: string;
  btnChat: string; // [Message on WhatsApp]: the answers in NO_BOOK
  prefill: string;
  prefillBack: string; // the WhatsApp text for someone who has booked
  typeFollowing: string;
  publicReply: string;
};

export function socialWords(lang: Lang): Words {
  const p = prices();
  const intro = rupees(p.intro);
  const mins = config.slots.callMinutes;
  const booking = `This is Disha Dira's automated booking assistant. Tap below to book a ${intro} ${mins}-minute call with Shantha Rao on WhatsApp. You choose the time, and she calls you.`;
  const bookingHi = `यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। नीचे टैप करके WhatsApp पर शांता राव जी के साथ ${intro} की ${mins} मिनट की कॉल बुक करें। समय आप चुनते हैं, और वे आपको कॉल करती हैं।`;
  if (lang === "hi")
    return {
      ask: "नमस्ते, दिशा दिरा में रुचि लेने के लिए धन्यवाद! हम हर हफ़्ते प्राणिक हीलिंग का एक छोटा टिप शेयर करते हैं। कृपया हमें फ़ॉलो करें, फिर नीचे टैप करें, और हमारा बुकिंग असिस्टेंट सेशन में आपकी मदद करेगा।",
      askAgain: `हम हर हफ़्ते प्राणिक हीलिंग का एक छोटा टिप शेयर करते हैं, इसलिए कृपया हमें फ़ॉलो करें और नीचे टैप करें। आप चाहें तो अभी सीधे WhatsApp पर शांता राव जी के साथ ${intro} की कॉल भी बुक कर सकते हैं।`,
      notYet: "लगता है फ़ॉलो अभी तक नहीं पहुँचा है। हमारी प्रोफ़ाइल पर Follow टैप करें, फिर नीचे टैप करें।",
      guide: `फ़ॉलो करने के लिए धन्यवाद! ${bookingHi}`,
      guideMember: `हमारे समुदाय का हिस्सा होने के लिए धन्यवाद! ${bookingHi}`,
      welcomeBack: `फिर से स्वागत है! शांता राव जी के साथ अपनी ${intro} की ${mins} मिनट की कॉल यहाँ बुक करें:`,
      welcomeBooked: `फिर से स्वागत है! अपनी बुकिंग, नए सेशन (${rupees(p.single)}) या पैकेज के लिए हमें WhatsApp पर मैसेज करें, हम वहीं जवाब देते हैं:`,
      thanksBooked: "धन्यवाद! WhatsApp पर मिलते हैं। 🙏",
      paidProblem: 'अगर आपने पेमेंट कर दिया है पर कन्फ़र्मेशन नहीं आया, तो कृपया दोबारा पेमेंट न करें। हमें WhatsApp पर मैसेज करें और "किसी से बात करें" टैप करें, हमारी टीम देख लेगी:',
      stopped: "ठीक है, हम यहाँ आपको अब कोई ऑटोमैटिक मैसेज नहीं भेजेंगे। बाद में बुक करना हो, तो कभी भी WhatsApp पर मैसेज करें।",
      questions: "कोई सवाल है? नीचे टैप करें।",
      after: (url) => (url ? `बुकिंग और सवालों के लिए हमें WhatsApp पर मैसेज करें:\n${url}\nहम वहीं जवाब देते हैं।` : "बुकिंग और सवालों के लिए नीचे टैप करके हमें WhatsApp पर मैसेज करें। हम वहीं जवाब देते हैं।"),
      commentBook: `कमेंट के लिए धन्यवाद! शांता राव जी के साथ ${intro} की ${mins} मिनट की कॉल बुक करने के लिए नीचे टैप करके हमें WhatsApp पर मैसेज करें।`,
      pageLabel: "हमारा पेज",
      deleted: "हो गया। इन जवाबों के लिए हमने आपके बारे में जो रखा था (आपका Instagram या Messenger id, भाषा, जवाब के चरण और बुकिंग रेफ़रेंस), वह मिटा दिया है। आपके मैसेज हम कभी नहीं रखते।",
      lines: {
        price: `शांता राव जी के साथ पहली ${mins} मिनट की कॉल ${intro} की है। एक सेशन ${rupees(p.single)} का है, या ${p.pack10.sessions} सेशन ${rupees(p.pack10.paise)} में और ${p.pack20.sessions} सेशन ${rupees(p.pack20.paise)} में।`,
        refund: `अगर पहली कॉल के बाद शांता राव जी को लगे कि सेशन आपके लिए सही नहीं है, तो ${intro} वापस कर दिए जाते हैं। कॉल छूट जाए तो एक बार मुफ़्त में नया समय चुन सकते हैं।`,
        how: `${mins} मिनट की कॉल में शांता राव जी आपके चुने हुए समय पर उस नंबर पर कॉल करती हैं जिससे आप WhatsApp पर बुक करते हैं। आप अपनी बात बताते हैं, और वे बताती हैं कि सेशन आपके लिए सही रहेगा या नहीं।`,
        book: `आप WhatsApp पर शांता राव जी के साथ ${intro} की ${mins} मिनट की कॉल बुक कर सकते हैं। समय आप चुनते हैं।`,
        where: "सभी कॉल और सेशन फ़ोन पर होते हैं, इसलिए आप कहीं से भी जुड़ सकते हैं, भारत में या विदेश में (जैसे दुबई)। समय भारत के समय से होता है।",
        what: "प्राणिक हीलिंग बिना छुए की जाने वाली एक सौम्य एनर्जी हीलिंग पद्धति है। यह डॉक्टर के इलाज के साथ चलती है, उसकी जगह नहीं लेती।",
        call: `हम यहाँ कॉल नहीं लेते और नंबर नहीं देते। शांता राव जी से बात करने का सबसे आसान तरीका ${intro} की ${mins} मिनट की कॉल है: आप WhatsApp पर समय चुनें, और वे आपको कॉल करेंगी।`,
        ...whatsAppLines("hi"),
      },
      qrTitles: { book: `${intro} कॉल बुक करें`, price: "फ़ीस", what: "प्राणिक हीलिंग", how: "कॉल कैसे होती है" },
      btnVisit: "प्रोफ़ाइल देखें",
      btnFollowing: { instagram: "मैंने फ़ॉलो किया", messenger: "मैंने फ़ॉलो किया" },
      btnBook: "WhatsApp पर बुक करें",
      btnChat: "WhatsApp पर लिखें",
      prefill: `नमस्ते, मुझे ${intro} की कॉल बुक करनी है`,
      prefillBack: "नमस्ते",
      typeFollowing: 'फ़ॉलो करने के बाद यहाँ "following" लिखकर भेजें।',
      publicReply: "आपको DM भेजा है 🙏",
    };
  return {
    ask: "Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap below and our booking assistant will help you with a session.",
    askAgain: `We share a short Pranic Healing tip every week, so please follow us and tap below. You can also book a ${intro} call with Shantha Rao on WhatsApp straight away.`,
    notYet: "It looks like the follow hasn't come through yet. Tap Follow on our profile, then tap below.",
    guide: `Thank you for following! ${booking}`,
    guideMember: `Thanks for being part of our community! ${booking}`,
    welcomeBack: `Welcome back! You can book your ${intro} ${mins}-minute call with Shantha Rao here:`,
    welcomeBooked: `Welcome back! For your booking, a new session (${rupees(p.single)}) or a package, message us on WhatsApp. We reply there:`,
    thanksBooked: "Thank you! We'll see you on WhatsApp. 🙏",
    paidProblem: 'If you paid but no confirmation came, please don\'t pay again. Message us on WhatsApp and tap "Talk to a person", and our team will check it:',
    stopped: "Okay, we won't send you any more automatic messages here. If you'd like to book later, message us on WhatsApp anytime.",
    questions: "Have a question? Tap one below.",
    after: (url) => (url ? `For bookings and questions, message us on WhatsApp:\n${url}\nWe reply there.` : "For bookings and questions, tap below to message us on WhatsApp. We reply there."),
    commentBook: `Thank you for your comment! To book a ${intro} ${mins}-minute call with Shantha Rao, tap below and message us on WhatsApp.`,
    pageLabel: "Our Page",
    deleted: "Done. We have deleted what we kept about you for these replies (your Instagram or Messenger id, language, reply steps and booking reference). We never keep your messages.",
    lines: {
      price: `A first ${mins}-minute call with Shantha Rao is ${intro}. A session is ${rupees(p.single)}, or ${p.pack10.sessions} sessions for ${rupees(p.pack10.paise)} and ${p.pack20.sessions} for ${rupees(p.pack20.paise)}.`,
      refund: `If Shantha Rao feels a session isn't the right fit after your first call, the ${intro} is refunded. If you miss the call, you get one free chance to pick a new time.`,
      how: `On the ${mins}-minute call, Shantha Rao calls the number you book from on WhatsApp, at the time you pick. You share what is going on, and she explains whether a session would suit you.`,
      book: `You can book a ${intro} ${mins}-minute call with Shantha Rao on WhatsApp. You pick the time.`,
      where: "All calls and sessions are by phone, so you can join from anywhere, in India or abroad (such as Dubai). Times are in India time.",
      what: "Pranic Healing is a gentle, no-touch energy healing practice. It complements medical care and is not a substitute for it.",
      call: `We don't take calls here or share a number. The quickest way to talk to Shantha Rao is the ${intro} ${mins}-minute call: you choose a time on WhatsApp, and she calls you.`,
      ...whatsAppLines("en"),
    },
    qrTitles: { book: `Book a ${intro} call`, price: "Prices", what: "About Pranic Healing", how: "How the call works" },
    btnVisit: "Visit profile",
    btnFollowing: { instagram: "I'm following", messenger: "I've followed" },
    btnBook: "Book on WhatsApp",
    btnChat: "Message on WhatsApp",
    prefill: `Hi, I'd like to book a ${intro} call`,
    prefillBack: "Hi",
    typeFollowing: 'Once you follow, reply "following" here.',
    publicReply: "Sent you a DM 🙏",
  };
}

// The WhatsApp bot's fixed answers (src/router.ts topicText, built from docs/KNOWLEDGE.md and the Help copy) for the router topics we have
// no line of our own for: the same words, at the prices in force, so the two never disagree. Adapted for here: no *bold*, and its buttons
// ("Talk to a person", "Help", "My bookings") are on WhatsApp. "How it works" is the four steps only (our own "how" line is the call).
function whatsAppLines(lang: Lang): Record<FromWhatsApp, string> {
  const cp = copyFor(lang);
  const q = (s: string) => `"${s}"`;
  const onWhatsApp = (t: string) =>
    t.replaceAll("*", "").replace(lang === "hi" ? `${q(cp.btnPerson)} दबाएँ` : `tap ${q(cp.btnPerson)}`,
      lang === "hi" ? `हमें WhatsApp पर मैसेज करें और वहाँ ${q(cp.btnPerson)} दबाएँ` : `message us on WhatsApp and tap ${q(cp.btnPerson)} there`);
  const myBooking = lang === "hi"
    ? `अपनी बुकिंग देखने के लिए हमें WhatsApp पर मैसेज करें और वहाँ ${q(cp.btnHelp)}, फिर ${q(cp.rowMyBookings)} दबाएँ।`
    : `To see your booking, message us on WhatsApp and tap ${q(cp.btnHelp)}, then ${q(cp.rowMyBookings)} there.`;
  const text = (t: FromWhatsApp): string => (t === "my_booking" ? myBooking : t === "how_it_works" ? cp.faqAnswers.how_it_works : topicText(cp, t) ?? "");
  return Object.fromEntries(FROM_WHATSAPP.map((t) => [t, onWhatsApp(text(t))])) as Record<FromWhatsApp, string>;
}

const waDigits = () => config.businessNumber.replace(/\D/g, "");
// The WhatsApp link, with our prefilled text and their reference code ("(ref: IGK7Q2M)"): the WhatsApp bot takes the code out and links
// the two chats, so a booking that started here can be counted (REF_PATTERN, src/whatsapp.ts). No name or text goes with it.
export const bookLink = (w: Words, ref: string, back = false) =>
  `https://wa.me/${waDigits()}?text=${encodeURIComponent(`${back ? w.prefillBack : w.prefill} (ref: ${ref})`)}`;
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const newRef = (p: Platform) =>
  (p === "instagram" ? "IG" : "FB") + [...crypto.getRandomValues(new Uint8Array(5))].map((b) => REF_CHARS[b % REF_CHARS.length]).join("");
const REF_FORMAT = new RegExp(`^(?:IG|FB)[${REF_CHARS}]{5}$`); // exactly what newRef makes
const profileUrl = (env: Env, platform: Platform) =>
  platform === "instagram" ? config.social.instagramUrl : config.social.facebookPageUrl || `https://www.facebook.com/${env.META_PAGE_ID}`;

// ---- reading the message ----
export function detectLang(text: string, current: Lang): Lang {
  if (/[ऀ-ॿ]/.test(text) || hasPhrase(text, config.social.hinglish)) return "hi";
  return normalize(text).split(" ").filter((w) => /\p{L}/u.test(w)).length >= 2 ? "en" : current;
}

// What the message asks about (a code), answered in one line. An illness, "black magic", a payment problem or "when is my call" first, as
// on WhatsApp (an illness gets WhatsApp's careful medical answer, never a cure claim); then our own topics; then the rest of the WhatsApp
// router's ("is this real?", timings, in person, "why should I do pranic healing?"...). A greeting or "ok" alone has none, as on WhatsApp.
export function topicOf(text: string): Topic | null {
  if (isMenuWord(text) || isAckWord(text)) return null;
  for (const t of FIRST) if (hasPhrase(text, config.router.topics[t])) return t;
  for (const k of OWN) if (hasPhrase(text, config.social.keywords[k])) return k;
  const t = matchTopic(text);
  return t === null ? null : t in SAME ? SAME[t as keyof typeof SAME] : (t as FromWhatsApp);
}

// Links, promotions, scams, job seekers: nothing beyond the first follow ask (and the link only if they tap or type "following").
// A phone number is not junk: people send theirs to be called back, and the reply points them to WhatsApp (nothing is stored).
const isJunk = (text: string) =>
  LINK.test(text) || classifyWithoutAI(text) !== "TO_CLASSIFIER" || isJobText(text) || hasPhrase(text, config.social.junkWords);

const isStop = (text: string) => isOptOut(text) || hasPhrase(text, config.social.stopWords);
// "I booked already", "paid", or our own WhatsApp number or link sent back to us: they are on WhatsApp already. Short messages only, and
// not a question ("is it paid?").
const words = (text: string) => normalize(text).split(" ").filter(Boolean).length;
const saysBooked = (text: string) =>
  (words(text) <= 10 && !/[?？]/.test(text) && hasPhrase(text, config.social.bookedWords)) || text.replace(/\D/g, "").includes(waDigits().slice(-10)) || /wa\.me\//i.test(text);

// A question (not small talk): it gets an answer before the 10-minute pause on a repeated follow ask is over.
const isQuestion = (text: string) => /[?？]/.test(text) || topicOf(text) !== null || hasPhrase(text, config.router.topics.medical);

const DELETE_WORDS = ["delete my data", "delete my instagram data", "delete my messenger data", "delete my facebook data", "remove my data", "erase my data",
  "mera data delete karo", "mera data delete kar do", "मेरा डेटा डिलीट करें", "मेरा डेटा डिलीट करो", "मेरा डेटा हटाएं", "मेरा डेटा हटा दें"];

type Event =
  | { kind: "comment"; platform: Platform; mid: string; author: string; post: string; text: string | null }
  | { kind: "dm"; platform: Platform; user: string; mid: string; text: string | null }
  | { kind: "tap"; platform: Platform; user: string; mid: string; payload: string }
  // texts: what the echo shows (its text, a template's text); machine: something nobody types in the inbox (buttons, quick replies, nothing at all)
  | { kind: "echo"; platform: Platform; user: string; mid: string; metadata: string | null; texts: string[]; machine: boolean };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

// One item of entry.messaging, as an event we act on, or the reason we leave it alone. Shapes handled: a message (text, attachments
// only: photo, voice note, sticker, shared post or reel; an Instagram story reply is a message with reply_to.story), a quick-reply tap
// (message.quick_reply.payload, both platforms), a button tap (postback, both platforms; "Get started" too), and on Messenger a referral
// (m.me link or ad in an existing chat, messaging_referrals: it reopens the 24-hour window, so it counts as a message without text).
// Ignored: story mentions, unsends, reactions, reads, deliveries, opt-ins, handovers, Instagram referrals, and anything that arrives
// more than 24 hours late (a reply then would be outside Meta's messaging window).
export function readEvent(platform: Platform, ownId: string, raw: unknown, nowMs = Date.now()): Event | { ignore: string } {
  const item = obj(raw);
  if (!item) return { ignore: "SCHEMA_INVALID" };
  const sender = str(obj(item.sender)?.id);
  const recipient = str(obj(item.recipient)?.id);
  const ts = typeof item.timestamp === "number" ? (item.timestamp < 1e12 ? item.timestamp * 1000 : item.timestamp) : null;
  const late = ts !== null && nowMs - ts > config.windowHours * HOUR;
  const m = obj(item.message);
  if (m) {
    const mid = str(m.mid);
    if (m.is_echo === true) {
      if (!recipient || !mid) return { ignore: "NO_SENDER" };
      // Read defensively: Meta does not say what an Instagram echo of a button template carries.
      const atts = (Array.isArray(m.attachments) ? m.attachments : []).map(obj);
      const payloads = atts.map((a) => obj(a?.payload));
      const texts = [m.text, ...payloads.map((p) => p?.text)].filter((t): t is string => typeof t === "string" && t.trim() !== "");
      const machine = atts.some((a) => a?.type === "template") || payloads.some((p) => !!p?.template_type || Array.isArray(p?.buttons)) ||
        (Array.isArray(m.quick_replies) && m.quick_replies.length > 0) || (!texts.length && !atts.length);
      return { kind: "echo", platform, user: recipient, mid, metadata: str(m.metadata), texts, machine };
    }
    if (!sender) return { ignore: "NO_SENDER" };
    if (sender === ownId) return { ignore: "OWN_MESSAGE" };
    if (late) return { ignore: "OUTSIDE_WINDOW" };
    if (m.is_deleted === true) return { ignore: "DELETED" };
    if (!mid) return { ignore: "NO_ID" }; // e.g. an admin_text handoff notice
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.some((a) => obj(a)?.type === "story_mention")) return { ignore: "STORY_MENTION" };
    const qr = str(obj(m.quick_reply)?.payload);
    if (qr) return { kind: "tap", platform, user: sender, mid, payload: qr };
    return { kind: "dm", platform, user: sender, mid, text: typeof m.text === "string" ? m.text : null };
  }
  const pb = obj(item.postback);
  if (pb) {
    if (!sender) return { ignore: "NO_SENDER" };
    if (late) return { ignore: "OUTSIDE_WINDOW" };
    const mid = str(pb.mid) ?? `pb:${sender}:${str(item.timestamp) ?? ""}:${str(pb.payload) ?? ""}`;
    return { kind: "tap", platform, user: sender, mid, payload: str(pb.payload) ?? "" };
  }
  if (obj(item.referral)) {
    if (platform !== "messenger") return { ignore: "REFERRAL" };
    if (!sender || sender === ownId) return { ignore: "NO_SENDER" };
    if (late) return { ignore: "OUTSIDE_WINDOW" };
    return { kind: "dm", platform, user: sender, mid: `ref:${sender}:${ts ?? ""}`, text: null };
  }
  if (item.read) return { ignore: "READ" };
  if (item.delivery) return { ignore: "DELIVERY" };
  if (item.reaction) return { ignore: "REACTION" };
  return { ignore: "OTHER" };
}

// One item of entry.changes: a new comment on our Instagram media (field "comments") or our Page's posts (field "feed").
export function readChange(platform: Platform, ownId: string, raw: unknown): Event | { ignore: string } {
  const ch = obj(raw);
  const v = obj(ch?.value);
  if (!ch || !v) return { ignore: "SCHEMA_INVALID" };
  let id: string | null, post: string | null, text: unknown;
  if (platform === "instagram") {
    if (ch.field !== "comments") return { ignore: "OTHER_FIELD" }; // live_comments, mentions, ...
    id = str(v.id) ?? str(v.comment_id);
    post = str(obj(v.media)?.id);
    text = v.text;
  } else {
    if (ch.field !== "feed") return { ignore: "OTHER_FIELD" };
    if (v.item !== "comment" || v.verb !== "add") return { ignore: "NOT_NEW_COMMENT" }; // posts, likes, edits, deletions, ...
    id = str(v.comment_id);
    post = str(v.post_id);
    text = v.message;
  }
  const author = str(obj(v.from)?.id);
  if (!author) return { ignore: "NO_SENDER" };
  if (author === ownId) return { ignore: "OWN_COMMENT" }; // our own comments and our replies under theirs
  if (!id || !post) return { ignore: "NO_ID" };
  return { kind: "comment", platform, mid: id, author, post, text: typeof text === "string" ? text : null };
}

// ---- the webhook ----
export function verifyMetaWebhook(c: C) {
  const ok = c.req.query("hub.mode") === "subscribe" && !!c.env.META_VERIFY_TOKEN && c.req.query("hub.verify_token") === c.env.META_VERIFY_TOKEN;
  return ok ? c.text(c.req.query("hub.challenge") ?? "") : c.text("forbidden", 403);
}

const ignored = (reason: string) => console.log("social webhook ignored", reason);

export async function receiveMetaWebhook(c: C) {
  const raw = await c.req.text(); // nothing is parsed or stored before the signature check
  // Signed with the secret of the Meta app the Page is connected to: its own (META_APP_SECRET) if it is a separate app, else WhatsApp's.
  if (!(await validSignature(raw, c.req.header("X-Hub-Signature-256"), c.env.META_APP_SECRET || c.env.WA_APP_SECRET))) return c.text("invalid signature", 401);
  let body: Obj | null;
  try {
    body = obj(JSON.parse(raw));
  } catch {
    body = null;
  }
  const platform: Platform | null = body?.object === "instagram" ? "instagram" : body?.object === "page" ? "messenger" : null;
  if (!body || !platform || !Array.isArray(body.entry)) {
    ignored("NOT_MESSAGING");
    return c.text("ok");
  }
  // The switch: off, the webhook answers 200 and nothing is stored or sent.
  if (c.env.SOCIAL_REPLIES !== "true") {
    ignored("OFF");
    return c.text("ok");
  }
  const ownId = platform === "instagram" ? c.env.META_IG_ID : c.env.META_PAGE_ID;
  let failed = false;
  for (const e of body.entry) {
    const entry = obj(e);
    if (!ownId || str(entry?.id) !== ownId) {
      ignored(ownId ? "OTHER_ACCOUNT" : "NOT_SET_UP");
      continue;
    }
    const items = [
      ...(Array.isArray(entry!.messaging) ? entry!.messaging : []).map((m) => readEvent(platform, ownId, m)),
      ...(Array.isArray(entry!.changes) ? entry!.changes : []).map((ch) => readChange(platform, ownId, ch)),
    ];
    for (const ev of items) {
      if ("ignore" in ev) {
        ignored(ev.ignore);
        continue;
      }
      failed = !(await once(c.env, ev)) || failed;
    }
  }
  // A database error asks Meta to send it again; the message id stops the retry from answering twice.
  return failed ? c.text("retry", 500) : c.text("ok");
}

// Each message id is handled once. If handling fails, the id is let go so Meta's retry can try again.
async function once(env: Env, ev: Event): Promise<boolean> {
  const key = `in:${ev.mid}`;
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO social_seen (key, at) VALUES (?1, ?2)").bind(key, iso(Date.now())).run();
  if (!ins.meta.changes) return true;
  try {
    await handle(env, ev, Date.now());
    return true;
  } catch {
    await env.DB.prepare("DELETE FROM social_seen WHERE key = ?1").bind(key).run().catch(() => undefined);
    return false;
  }
}

// ---- the person's row ----
type Contact = {
  platform: Platform;
  user_id: string;
  lang: Lang;
  step: "NEW" | "ASKED" | "RECHECK" | "LINKED";
  asks: number;
  link_sent_at: string | null;
  last_in_at: string | null;
  last_auto_at: string | null;
  autos_since: string | null;
  autos_today: number;
  nudge_at: string | null; // the last WhatsApp link sent outside the guide: the pointer after the follow, or the second ask before it
  paused_until: string | null;
  commenter_id: string | null;
  topic: Topic | null;
  followed_at: string | null; // migrations/0013_social_more.sql
  ref_code: string | null;
  wa_conversation_id: number | null;
  stopped_at: string | null;
  said_booked_at: string | null;
  offences: number; // migrations/0014_social_noise.sql
  blocked_at: string | null;
};

async function loadContact(env: Env, platform: Platform, user: string): Promise<Contact> {
  const row = await env.DB.prepare("SELECT * FROM social_contacts WHERE platform = ?1 AND user_id = ?2").bind(platform, user).first<Contact>();
  return (
    row ?? {
      platform, user_id: user, lang: "en", step: "NEW", asks: 0, link_sent_at: null, last_in_at: null, last_auto_at: null, autos_since: null, autos_today: 0,
      nudge_at: null, paused_until: null, commenter_id: null, topic: null, followed_at: null, ref_code: null, wa_conversation_id: null, stopped_at: null,
      said_booked_at: null, offences: 0, blocked_at: null,
    }
  );
}

async function saveContact(env: Env, r: Contact, nowMs: number): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO social_contacts (platform, user_id, lang, step, asks, link_sent_at, last_in_at, last_auto_at, autos_since, autos_today, nudge_at, paused_until,
         commenter_id, topic, updated_at, followed_at, ref_code, stopped_at, said_booked_at, offences, blocked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
       ON CONFLICT (platform, user_id) DO UPDATE SET lang = ?3, step = ?4, asks = ?5, link_sent_at = ?6, last_in_at = ?7, last_auto_at = ?8,
         autos_since = ?9, autos_today = ?10, nudge_at = ?11, paused_until = ?12, commenter_id = ?13, topic = ?14, updated_at = ?15, followed_at = ?16,
         ref_code = ?17, stopped_at = ?18, said_booked_at = ?19, offences = ?20, blocked_at = ?21`,
    )
    .bind(r.platform, r.user_id, r.lang, r.step, r.asks, r.link_sent_at, r.last_in_at, r.last_auto_at, r.autos_since, r.autos_today, r.nudge_at, r.paused_until,
      r.commenter_id, r.topic, iso(nowMs), r.followed_at, r.ref_code, r.stopped_at, r.said_booked_at, r.offences, r.blocked_at)
    .run();
}

const ago = (at: string | null, nowMs: number) => (at ? nowMs - Date.parse(at) : Infinity);
const seenOnce = async (env: Env, key: string, nowMs: number) =>
  (await env.DB.prepare("INSERT OR IGNORE INTO social_seen (key, at) VALUES (?1, ?2)").bind(key, iso(nowMs)).run()).meta.changes > 0;

// ---- the flow ----
// 1. Any first message or comment gets only the follow ask (its topic is remembered as a code); someone we know follows us (Instagram:
// checked; Messenger: tapped before) skips it. 2. Once they follow (Instagram: checked, the second tap goes through anyway; Messenger: on
// the tap), one line on that topic, then the way to book on WhatsApp with quick replies for the common questions. Writing again before
// following gets the ask with the WhatsApp link too. 3. After that, questions are answered (tapped or typed), and any other message gets
// one pointer to WhatsApp every 6 hours ("Welcome back!" with the questions after a day away). Someone who has booked (their WhatsApp
// chat has a payment, or they say so) gets no follow ask and no ₹99 call: only the way back to WhatsApp. Every send answers their own
// message or tap, at once: nothing is scheduled, so nothing can go outside Meta's 24-hour window.
async function handle(env: Env, ev: Event, nowMs: number): Promise<void> {
  if (ev.kind === "comment") return handleComment(env, ev, nowMs);
  const now = iso(nowMs);
  const r = await loadContact(env, ev.platform, ev.user);

  // Someone from the team wrote by hand in the Instagram or Page inbox (not our own message): keep out of that chat for a day.
  if (ev.kind === "echo") {
    // Ours: Messenger's metadata; buttons or quick replies (nobody types those in the inbox); the text of something we sent them (its
    // hash is kept: a send that timed out has no id, and its echo can come minutes later, ticket 34).
    if (ev.metadata === METADATA || ev.machine) return;
    // Not the team: someone who has never written to us that we know of (right after "delete my data", whose own reply echoes back with
    // no row left, or before their first message is saved), or the Business Suite instant reply (config.social.inboxAutoReplies).
    if (!r.last_in_at) return;
    if (ev.texts.some((t) => config.social.inboxAutoReplies.some((a) => normalize(t).startsWith(normalize(a))))) return;
    if (await env.DB.prepare("SELECT 1 FROM social_seen WHERE key = ?1").bind(`out:${ev.mid}`).first()) return;
    for (const t of ev.texts) if (await env.DB.prepare("SELECT 1 FROM social_seen WHERE key = ?1").bind(await ownTextKey(r, t)).first()) return;
    if (ago(r.last_auto_at, nowMs) < config.social.ownEchoSeconds * 1000) return; // our send, whose id is not stored yet
    r.paused_until = iso(nowMs + config.social.pauseHours * HOUR);
    await saveContact(env, r, nowMs);
    return;
  }

  // After a month of silence the flow starts again (a known follower is not asked to follow again, and a "stop" ends).
  const away = ago(r.last_in_at, nowMs);
  if (away > config.social.restartAfterDays * DAY) Object.assign(r, { step: "NEW", asks: 0, nudge_at: null, topic: null, stopped_at: null });
  r.last_in_at = now;
  const text = ev.kind === "dm" ? ev.text : null;
  if (text) r.lang = detectLang(text, r.lang);
  const w = socialWords(r.lang);

  if (text && hasPhrase(text, DELETE_WORDS)) return forget(env, r, w);

  // Safety first, as on WhatsApp (CONTRACT "Safety", src/safety.ts): the same fixed message, no follow ask and no selling, and the owner is told.
  const safety = text ? detectSafety(text) : null;
  if (safety) return safetyReply(env, r, safety, nowMs);
  // Blocked: nothing more on this channel, a tap included. Insults, threats and sexual messages get no reply (and are counted).
  if (r.blocked_at) return void (await saveContact(env, r, nowMs));
  if (text && (await offended(env, r, text, nowMs))) return;

  if (r.paused_until && Date.parse(r.paused_until) > nowMs) return void (await saveContact(env, r, nowMs));
  if (ago(r.autos_since, nowMs) >= DAY) Object.assign(r, { autos_since: now, autos_today: 0 });
  // "Stop" holds until a tap (a deliberate choice) or the 30-day restart.
  if (r.stopped_at && ev.kind !== "tap") return void (await saveContact(env, r, nowMs));
  r.stopped_at = null;
  if (text && isStop(text)) {
    if (await send(env, r, { text: w.stopped }, nowMs, { always: true })) r.stopped_at = now;
    return void (await saveContact(env, r, nowMs));
  }
  // "I booked", "paid" (or our WhatsApp number sent back): thanks, and no more selling. Paid with no confirmation: "Talk to a person".
  if (text && (saysBooked(text) || paidTrouble(text))) {
    const msg = paidTrouble(text) ? linkMessage(env, r, w, w.paidProblem, true) : { text: w.thanksBooked };
    if (await send(env, r, msg, nowMs, { always: true })) r.said_booked_at = now;
    return void (await saveContact(env, r, nowMs));
  }

  const question = ev.kind === "tap" ? qrTopic(ev.payload) : null; // a quick reply, or an ice breaker before the first message
  if (r.step !== "LINKED") r.topic ??= text ? topicOf(text) : question;
  const junk = !!text && isJunk(text);
  // A typed "following", "done", "ok", "haan", "follow kar diya"... at the follow ask counts as the tap ("not yet", "how do I follow" don't).
  const typedFollow = !!text && !junk && (r.step === "ASKED" || r.step === "RECHECK") && words(text) <= 6 &&
    hasPhrase(text, config.social.followedWords) && !hasPhrase(text, config.social.notFollowedWords);
  const tapped = (ev.kind === "tap" && ev.payload === FOLLOWING) || typedFollow;
  const sixHours = (at: string | null) => ago(at, nowMs) >= config.social.nudgeEveryHours * HOUR;
  // Replies nobody tapped for (the ask, the ask again, the pointer, welcome back): one per person a minute, so ten messages in a minute
  // get one reply and two that arrive together don't both get the ask. A message past that changes nothing.
  const firstThisMinute = () => seenOnce(env, `b:${r.platform}:${r.user_id}:${Math.floor(nowMs / (config.social.burstSeconds * 1000))}`, nowMs);
  const asked = question ?? (text && !junk ? topicOf(text) : null);

  if (await hasBooked(env, r)) {
    // Booked: a question gets its line; anything else the way back to WhatsApp ("Welcome back!"), every 6 hours. No follow ask, no ₹99 call.
    const answered = asked ? await answerQuestion(env, r, w, asked, nowMs) : false;
    if (!answered && ev.kind === "dm" && !junk && sixHours(r.nudge_at)) {
      if (!(await firstThisMinute())) return;
      if (await send(env, r, linkMessage(env, r, w, w.welcomeBooked, true), nowMs, { always: true })) r.nudge_at = now;
    }
  } else if (r.step === "LINKED") {
    // A tapped question, or a typed one on a known topic ("can I book?", "how much?"), gets its line and [Book on WhatsApp] (each topic
    // once a day). Any other message (a photo or voice note too) gets one pointer to WhatsApp, with the link, at most every 6 hours;
    // after a day away, "Welcome back!" with the link and the questions.
    const answered = asked ? await answerQuestion(env, r, w, asked, nowMs) : false;
    if (!answered && ev.kind === "dm" && !junk && sixHours(r.nudge_at)) {
      if (!(await firstThisMinute())) return;
      const back = away >= config.social.welcomeBackHours * HOUR;
      if (back ? await sendBooking(env, r, w, w.welcomeBack, nowMs) : await send(env, r, pointerMessage(env, r, w), nowMs, { always: true })) r.nudge_at = now;
    }
  } else if (tapped) {
    await followTap(env, r, w, nowMs);
  } else if (r.step === "NEW") {
    // The first message of a round. Someone we know follows us gets the way to book straight away ("Welcome back!" if they had it
    // before); everyone else the follow ask. Spam never skips the ask.
    if (!(await firstThisMinute())) return;
    if (!junk && (await knownFollower(env, r, nowMs))) await sendBooking(env, r, w, r.link_sent_at ? w.welcomeBack : w.guideMember, nowMs);
    else if (await send(env, r, askMessage(env, r, w), nowMs)) r.step = "ASKED";
  } else if ((ev.kind === "dm" && !junk) || question) {
    // They wrote again without following: the ask again (after one line on their question, if it has a topic), now with [Book on
    // WhatsApp] too, so the follow is asked for but never stands between a person and booking. A question gets it at once (the first
    // time), anything else 10 minutes after our last message. Past the daily limit it still goes if the WhatsApp link hasn't gone to them
    // in the last 6 hours.
    const soon = ago(r.last_auto_at, nowMs) < config.social.repeatAskMinutes * 60_000;
    if (!soon || ((!!question || (!!text && isQuestion(text))) && !r.nudge_at)) {
      if (!(await firstThisMinute())) return;
      if (await send(env, r, askMessage(env, r, w, true, asked ? w.lines[asked] : ""), nowMs, { always: sixHours(r.nudge_at) })) r.nudge_at = now;
    }
  }
  await saveContact(env, r, nowMs);
}

// "I paid" with "no confirmation", "money deducted"...
const paidTrouble = (text: string) => hasPhrase(text, ["paid", "payment", "pay", "पेमेंट", ...config.social.bookedWords]) && hasPhrase(text, config.social.paidProblemWords);

// Insults, threats and sexual messages (classifyWithoutAI, the WhatsApp lists in config.noise): true, and nothing is sent. As on WhatsApp
// (src/noise.ts applyLabel), a block word (either list) or a second offence blocks, and a threat is an urgent item (src/whatsapp.ts THREAT).
// Someone with a paid booking on WhatsApp is never blocked (CONTRACT "Noise": paying customers are never filtered).
async function offended(env: Env, r: Contact, text: string, nowMs: number): Promise<boolean> {
  const label = classifyWithoutAI(text);
  if (label !== "abuse" && label !== "flirt_or_sexual") return false;
  if (isThreat(text)) await raiseAttention(env.DB, THREAT_ITEM, `${r.platform}:${await shortHash(r.user_id)}`);
  if (!(r.wa_conversation_id && (await isPayingCustomer(env.DB, r.wa_conversation_id, nowMs)))) {
    r.offences += 1;
    if (r.offences >= 2 || hasPhrase(text, [...config.noise.abuseBlockWords, ...config.noise.sexualBlockWords])) r.blocked_at = iso(nowMs);
  }
  await saveContact(env, r, nowMs);
  return true;
}

// Booked: they said so, or the WhatsApp chat their code opened has a paid ₹99 call, session or package (refunded later counts too).
async function hasBooked(env: Env, r: Contact): Promise<boolean> {
  if (r.said_booked_at) return true;
  if (!r.wa_conversation_id) return false;
  const row = await env.DB.prepare(`SELECT ${paidIn("?1")} AS paid`).bind(r.wa_conversation_id).first<{ paid: number }>();
  return !!row?.paid;
}
// SQL: the WhatsApp chat `conv` has a payment that went through (the ₹99 call, a session or a package).
const paidIn = (conv: string) => `EXISTS (SELECT 1 FROM payments p WHERE p.state IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED') AND (
  (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = ${conv})) OR
  (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = ${conv})) OR
  (p.purpose = 'PACKAGE' AND p.target_id IN (SELECT id FROM packages WHERE conversation_id = ${conv}))))`;

// Do we know they follow us? Instagram: we ask (only a clear yes counts; on no answer they get the ask). Messenger can't be asked, so
// only a tap on "I've followed" before counts.
async function knownFollower(env: Env, r: Contact, nowMs: number): Promise<boolean> {
  if (r.platform === "messenger") return !!r.followed_at;
  if (!(await sendsOn(env)) || (await followsUs(env, r.user_id)) !== true) return false; // nothing reaches Meta while sends are off
  r.followed_at = iso(nowMs);
  return true;
}

// "delete my data": their row (a block too) and every key with their id, at once, and a short reply to say so.
async function forget(env: Env, r: Contact, w: Words): Promise<void> {
  const ids = [r.user_id, r.commenter_id ?? r.user_id];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM social_contacts WHERE platform = ?1 AND (user_id = ?2 OR commenter_id = ?2)").bind(r.platform, r.user_id),
    ...ids.flatMap((id) => ["qa", "c", "b", "ot"].map((k) => env.DB.prepare("DELETE FROM social_seen WHERE key LIKE ?1").bind(`${k}:${r.platform}:${id}:%`))),
  ]);
  if (!(await sendsOn(env))) return;
  const out = await graphSend(env, r.platform, { id: r.user_id }, { text: w.deleted });
  if (out?.mid) await seenOnce(env, `out:${out.mid}`, Date.now());
}

// The crisis message (Tele-MANAS, 112) or the emergency message, as the WhatsApp bot sends them; no selling for a week after a crisis
// message (config.safety.noSellDays), a day after an emergency; one SOCIAL_SAFETY item, and for a crisis an email to the safety contact.
async function safetyReply(env: Env, r: Contact, safety: Safety, nowMs: number): Promise<void> {
  await send(env, r, safetyMessage(r.lang, safety), nowMs, { safety: true });
  r.paused_until = iso(nowMs + (safety === "CRISIS" ? config.safety.noSellDays * DAY : config.social.pauseHours * HOUR));
  await saveContact(env, r, nowMs);
  await alertTeam(env, r.platform, r.user_id, safety);
}

const safetyMessage = (lang: Lang, safety: Safety): Message => ({ text: (safety === "CRISIS" ? copyFor(lang).crisis : copyFor(lang).emergency).replaceAll("*", "") });

async function alertTeam(env: Env, platform: Platform, user: string, safety: Safety): Promise<void> {
  const where = platform === "instagram" ? "Instagram" : "Facebook Messenger";
  const fresh = await raiseAttention(env.DB, SAFETY_ITEM, `${platform}:${await shortHash(user)}`);
  if (fresh && safety === "CRISIS") {
    await sendEmailToEach(env, await recipients(env, "safety"), `Urgent: crisis message on ${where}`,
      `A crisis message arrived on ${where}. The bot sent the helpline message (Tele-MANAS 14416, 112) and keeps no message text. Open the ${where === "Instagram" ? "Instagram" : "Page"} inbox now and write to them yourself.`);
  }
}

// A comment on our post or reel gets one private reply (one per commenter per post; not while the team has the chat; within the daily
// limit): the follow ask, which starts the same flow. Someone who had the link in the last 30 days, or is a known follower, gets only
// [Book on WhatsApp] instead ("Welcome back!" for someone who has booked), at most once a week. Nothing after "stop", and nothing for an
// insulting, threatening or sexual comment (counted as for a DM) or to someone blocked. A crisis or emergency comment gets the helpline message privately (never a sales message) and the team is told,
// as for a DM. The comment text is only read for its language, topic and safety, never stored.
async function handleComment(env: Env, ev: Extract<Event, { kind: "comment" }>, nowMs: number): Promise<void> {
  const now = iso(nowMs);
  const known = await env.DB
    .prepare("SELECT * FROM social_contacts WHERE platform = ?1 AND (user_id = ?2 OR commenter_id = ?2) ORDER BY last_in_at DESC LIMIT 1")
    .bind(ev.platform, ev.author)
    .first<Contact>();
  let r = known ?? (await loadContact(env, ev.platform, ev.author));
  if (ev.text) r.lang = detectLang(ev.text, r.lang);
  const w = socialWords(r.lang);
  const to = { comment_id: ev.mid };
  const safety = ev.text ? detectSafety(ev.text) : null;
  const booked = await hasBooked(env, r);
  const linked = booked || !!r.followed_at || ago(r.link_sent_at, nowMs) < config.social.restartAfterDays * DAY;
  const linkKey = `c:${ev.platform}:${r.user_id}:wa`;
  let message: Message;
  if (safety) {
    message = safetyMessage(r.lang, safety);
  } else {
    if (r.blocked_at || (ev.text && (await offended(env, r, ev.text, nowMs)))) return;
    // One private reply per commenter per post. A key left with no row for them (they sent "delete my data", which can't know their
    // comment id when it differs from their messaging id, or an earlier version kept the key without a row) doesn't count.
    const postKey = `c:${ev.platform}:${ev.author}:${ev.post}`;
    if (!(await seenOnce(env, postKey, nowMs))) {
      if (known) return;
      await env.DB.prepare("UPDATE social_seen SET at = ?2 WHERE key = ?1").bind(postKey, now).run();
    }
    if (r.paused_until && Date.parse(r.paused_until) > nowMs) return;
    if (r.stopped_at && ago(r.last_in_at, nowMs) <= config.social.restartAfterDays * DAY) return;
    if (linked) {
      const last = await env.DB.prepare("SELECT at FROM social_seen WHERE key = ?1").bind(linkKey).first<{ at: string }>();
      if (ago(last?.at ?? null, nowMs) < config.social.commentLinkEveryDays * DAY) return;
    }
    if (ago(r.autos_since, nowMs) >= DAY) Object.assign(r, { autos_since: now, autos_today: 0 });
    if (r.autos_today >= config.social.maxAutosPerDay) return;
    message = !linked ? askMessage(env, r, w) : linkMessage(env, r, w, booked ? w.welcomeBooked : w.commentBook, booked);
  }
  if (!(safety ? sendsEnvOn(env) : await sendsOn(env))) return safety ? alertTeam(env, ev.platform, r.user_id, safety) : undefined;
  // If a private reply refuses the message (buttons or quick replies), the same words as plain text with the links written out.
  const out = (await graphSend(env, ev.platform, to, message)) ?? (await graphSend(env, ev.platform, to, plainText(w, message)));
  if (!out) {
    if (!safety) await env.DB.prepare("DELETE FROM social_seen WHERE key = ?1").bind(`c:${ev.platform}:${ev.author}:${ev.post}`).run(); // a later comment may try again
    else await alertTeam(env, ev.platform, r.user_id, safety);
    return;
  }
  if (out.mid) await seenOnce(env, `out:${out.mid}`, nowMs);
  // Meta answers with their messaging id: the row is kept under it, so their next message or tap finds it.
  if (!known && out.recipient && out.recipient !== ev.author) {
    const lang = r.lang;
    r = await loadContact(env, ev.platform, out.recipient); // they may have written to us before, under that id
    r.lang = lang;
    if (ago(r.autos_since, nowMs) >= DAY) Object.assign(r, { autos_since: now, autos_today: 0 });
  }
  if (r.user_id !== ev.author) r.commenter_id = ev.author;
  Object.assign(r, { last_in_at: now, last_auto_at: now, autos_since: r.autos_since ?? now, autos_today: r.autos_today + 1 });
  if (safety) {
    r.paused_until = iso(nowMs + (safety === "CRISIS" ? config.safety.noSellDays * DAY : config.social.pauseHours * HOUR));
    await saveContact(env, r, nowMs);
    return alertTeam(env, ev.platform, r.user_id, safety);
  }
  if (linked) {
    await env.DB.prepare("INSERT OR REPLACE INTO social_seen (key, at) VALUES (?1, ?2)").bind(linkKey, now).run();
  } else {
    r.topic ??= ev.text ? topicOf(ev.text) : null;
    if (r.step === "NEW") r.step = "ASKED";
  }
  await saveContact(env, r, nowMs);
  if (config.social.publicReply) await publicReply(env, ev.platform, ev.mid, w.publicReply);
}

async function followTap(env: Env, r: Contact, w: Words, nowMs: number): Promise<void> {
  r.asks += 1;
  // Messenger can't tell us whether someone follows the Page. On Instagram the second tap goes through anyway (the owner's choice, so a
  // real follower is never stuck while Instagram catches up), and so does any answer other than a clear "no" (fail open). Only a
  // confirmed follow (Instagram's yes, Messenger's tap) is remembered, so they aren't asked again when they come back.
  if (r.platform === "instagram") {
    const follows = r.asks < 2 ? await followsUs(env, r.user_id) : null;
    // "Not yet" answers a tap, so it goes past the daily limit too (once: the next tap goes through).
    if (follows === false) {
      if (await send(env, r, buttons(w.notYet, [visitButton(w), followingButton(r.platform, w)]), nowMs, { always: true })) r.step = "RECHECK";
      return;
    }
    if (follows) r.followed_at = iso(nowMs);
  } else r.followed_at = iso(nowMs);
  await sendBooking(env, r, w, w.guide, nowMs);
}

// The topic line (if their first message had one), the opening, then the way to book with the questions. It always goes, even past the
// daily limit, so nobody who followed is left without it. Instagram puts quick replies on text only, so there the questions are a second,
// short message.
async function sendBooking(env: Env, r: Contact, w: Words, opening: string, nowMs: number): Promise<boolean> {
  const text = r.topic ? `${w.lines[r.topic]}\n\n${opening}` : opening;
  let ok: boolean;
  if (r.platform === "messenger") ok = await send(env, r, bookMessage(env, r, w, text), nowMs, { always: true });
  else if ((ok = await send(env, r, bookMessage(env, r, w, text), nowMs, { always: true }))) await send(env, r, withQuestions({ text: w.questions }, w), nowMs, { always: true });
  if (ok) Object.assign(r, { step: "LINKED", link_sent_at: iso(nowMs), nudge_at: null, topic: null });
  return ok;
}

// A question after the follow (tapped, or typed on a known topic): its line and the way to WhatsApp; each topic at most once a day per person.
async function answerQuestion(env: Env, r: Contact, w: Words, topic: Topic, nowMs: number): Promise<boolean> {
  if (!(await seenOnce(env, `qa:${r.platform}:${r.user_id}:${topic}:${iso(nowMs).slice(0, 10)}`, nowMs))) return false;
  return send(env, r, answerMessage(env, r, w, topic), nowMs, { always: true });
}

// ---- messages ----
type Button = { type: "web_url"; url: string; title: string } | { type: "postback"; title: string; payload: string };
type QuickReply = { content_type: "text"; title: string; payload: string };
type Message = ({ text: string } | { attachment: { type: "template"; payload: { template_type: "button"; text: string; buttons: Button[] } } }) & { quick_replies?: QuickReply[] };

// Instagram shows button templates. The Facebook app does not (it shows "This post is unavailable… Open in Messenger"), so Messenger
// gets plain text with the links written out (Messenger and the Facebook app both make them clickable) and quick replies for the taps.
const buttons = (text: string, list: Button[]): Message => ({ attachment: { type: "template", payload: { template_type: "button", text, buttons: list } } });
const visitButton = (w: Words): Button => ({ type: "web_url", url: config.social.instagramUrl, title: w.btnVisit });
const followingButton = (p: Platform, w: Words): Button => ({ type: "postback", title: w.btnFollowing[p], payload: FOLLOWING });
const refOf = (r: Contact) => (r.ref_code ??= newRef(r.platform));
// Instagram's button keeps the wa.me link itself: the button hides the address anyway, and nothing stands between the tap and WhatsApp.
const bookButton = (r: Contact, w: Words, back = false, title = w.btnBook): Button => ({ type: "web_url", url: bookLink(w, refOf(r), back), title });
// Messenger writes links out, so it gets the short ones (shortBase, below): "Book on WhatsApp: https://bot.disha-dira.com/b/FBGJCGT".
const bookLine = (env: Env, r: Contact, w: Words, back = false, title = w.btnBook) => `${title}: ${writtenBookLink(env, r, w, back)}`;
function writtenBookLink(env: Env, r: Contact, w: Words, back = false): string {
  const base = shortBase(env);
  return base ? `${base}/b/${refOf(r)}${r.lang === "hi" ? "/hi" : ""}${back ? "/back" : ""}` : bookLink(w, refOf(r), back);
}
const writtenPageLink = (env: Env) => (shortBase(env) ? `${shortBase(env)}/fb` : profileUrl(env, "messenger"));
const withQuestions = (m: Message, w: Words): Message => ({ ...m, quick_replies: QUESTIONS.map((t) => ({ content_type: "text", title: w.qrTitles[t], payload: QR(t) })) });

// The follow ask; `again` (they wrote again without following): one line on their question if it had a topic, the shorter ask, and the
// way to book straight away.
function askMessage(env: Env, r: Contact, w: Words, again = false, line = ""): Message {
  const text = again ? `${line ? `${line}\n\n` : ""}${w.askAgain}` : w.ask;
  if (r.platform === "instagram") return buttons(text, [visitButton(w), followingButton(r.platform, w), ...(again ? [bookButton(r, w)] : [])]);
  const links = `${w.pageLabel}: ${writtenPageLink(env)}${again ? `\n${bookLine(env, r, w)}` : ""}`;
  return { text: `${text}\n\n${links}`, quick_replies: [{ content_type: "text", title: w.btnFollowing.messenger, payload: FOLLOWING }] };
}
// A text with [Book on WhatsApp]: Instagram the button; Messenger the link on its own line and the questions as quick replies.
const bookMessage = (env: Env, r: Contact, w: Words, text: string): Message =>
  r.platform === "instagram" ? buttons(text, [bookButton(r, w)]) : withQuestions({ text: `${text}\n\n${bookLine(env, r, w)}` }, w);
// A text with the WhatsApp link only (no questions: "Welcome back" after a booking, "paid but no confirmation", a comment's reply).
// `back`: the WhatsApp text is "Hi" instead of "I'd like to book a ₹99 call".
const linkMessage = (env: Env, r: Contact, w: Words, text: string, back = false, title = w.btnBook): Message =>
  r.platform === "instagram" ? buttons(text, [bookButton(r, w, back, title)]) : { text: `${text}\n\n${bookLine(env, r, w, back, title)}` };
// After the link: "message us on WhatsApp". Messenger writes the (short) link in the text; Instagram has only the button.
const pointerMessage = (env: Env, r: Contact, w: Words): Message =>
  r.platform === "instagram" ? buttons(w.after(), [bookButton(r, w)]) : withQuestions({ text: w.after(writtenBookLink(env, r, w)) }, w);
// A question's answer: the line and [Book on WhatsApp] (Messenger: and the questions); NO_BOOK topics: [Message on WhatsApp] with "Hi".
const answerMessage = (env: Env, r: Contact, w: Words, topic: Topic): Message =>
  (NO_BOOK as readonly Topic[]).includes(topic) ? linkMessage(env, r, w, w.lines[topic], true, w.btnChat) : bookMessage(env, r, w, w.lines[topic]);
// The same message as plain text, if a private reply refuses it (a typed "following" counts as the tap).
function plainText(w: Words, m: Message): Message {
  const list = "attachment" in m ? m.attachment.payload.buttons : [];
  const follow = list.some((b) => b.type === "postback") || !!m.quick_replies?.some((q) => q.payload === FOLLOWING);
  const tail = [...list.flatMap((b) => (b.type === "web_url" ? [b.url] : [])), ...(follow ? [w.typeFollowing] : [])].join("\n");
  const text = "text" in m ? m.text : m.attachment.payload.text;
  return { text: tail ? `${text}\n\n${tail}` : text };
}

// An automated message to this person: only while sends are on, at most config.social.maxAutosPerDay a day (safety messages and the
// messages after the follow excepted). The count, the time and a hash of the text are saved before the call, so the echo of this message
// is known to be ours. True when Meta took it, or may have (a timeout): the flow moves on and nothing is sent twice.
async function send(env: Env, r: Contact, message: Message, nowMs: number, o: { safety?: boolean; always?: boolean } = {}): Promise<boolean> {
  if (!(o.safety ? sendsEnvOn(env) : await sendsOn(env))) return false;
  if (!o.safety && !o.always && r.autos_today >= config.social.maxAutosPerDay) return false;
  r.last_auto_at = iso(nowMs);
  r.autos_since ??= r.last_auto_at;
  r.autos_today += 1;
  await saveContact(env, r, nowMs);
  const shown = "text" in message ? message.text : message.attachment.payload.text;
  await env.DB.prepare("INSERT OR REPLACE INTO social_seen (key, at) VALUES (?1, ?2)").bind(await ownTextKey(r, shown), iso(nowMs)).run();
  const out = await graphSend(env, r.platform, { id: r.user_id }, message);
  if (out?.mid) await seenOnce(env, `out:${out.mid}`, nowMs);
  return out !== null;
}

// Our own outgoing text, for this person, as a short hash (never their text): its echo is ours even without a message id.
const ownTextKey = async (r: Contact, text: string) => `ot:${r.platform}:${r.user_id}:${await shortHash(normalize(text))}`;

const graph = (path: string) => `https://graph.facebook.com/${config.graphVersion}/${path}`;
const errorCode = async (res: Response) => String(((await res.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code ?? res.status);

// The Send API (both platforms, the Page token), to a person ({id}) or as the private reply to a comment ({comment_id}). Returns Meta's
// message id and the person's messaging id; null for an error answer (not sent). No answer in time (or a broken connection) is UNKNOWN,
// not FAILED: Meta often delivers it anyway (Rohit's live test, 1 Nov), so it counts as sent and is never resent blindly (CONTRACT
// "Outbound sends"). Failures are logged by code only.
type Recipient = { id: string } | { comment_id: string };
type Sent = { mid: string | null; recipient: string | null; unknown?: true };
export async function graphSend(env: Env, platform: Platform, recipient: Recipient, message: Message): Promise<Sent | null> {
  const body =
    platform === "instagram" ? { recipient, message }
    : "id" in recipient ? { recipient, messaging_type: "RESPONSE", message: { ...message, metadata: METADATA } }
    : { recipient, message: { ...message, metadata: METADATA } };
  let reason: string;
  try {
    const res = await fetch(graph(`${env.META_PAGE_ID}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_PAGE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.social.graphTimeoutMs),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { message_id?: unknown; recipient_id?: unknown } | null;
      return { mid: str(data?.message_id), recipient: str(data?.recipient_id) };
    }
    reason = await errorCode(res);
  } catch {
    reason = "timeout";
  }
  console.log("social send failed", reason);
  return reason === "timeout" ? { mid: null, recipient: null, unknown: true } : null;
}

// Instagram only: true or false from the user profile API, or null when it can't say (then the caller sends the link).
export async function followsUs(env: Env, igsid: string): Promise<boolean | null> {
  let reason: string;
  try {
    const res = await fetch(graph(`${encodeURIComponent(igsid)}?fields=is_user_follow_business`), {
      headers: { Authorization: `Bearer ${env.META_PAGE_TOKEN}` },
      signal: AbortSignal.timeout(config.social.graphTimeoutMs),
    });
    if (res.ok) {
      const v = ((await res.json().catch(() => null)) as { is_user_follow_business?: unknown } | null)?.is_user_follow_business;
      if (typeof v === "boolean") return v;
      reason = "no_field";
    } else reason = await errorCode(res);
  } catch {
    reason = "timeout";
  }
  console.log("social profile check failed", reason);
  return null;
}

// The optional public answer under the comment (config.social.publicReply, off by default). Instagram: POST /{comment-id}/replies
// (instagram_manage_comments); Facebook: POST /{comment-id}/comments (pages_manage_engagement).
async function publicReply(env: Env, platform: Platform, commentId: string, message: string): Promise<void> {
  let reason: string;
  try {
    const res = await fetch(graph(`${encodeURIComponent(commentId)}/${platform === "instagram" ? "replies" : "comments"}`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_PAGE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(config.social.graphTimeoutMs),
    });
    if (res.ok) return;
    reason = await errorCode(res);
  } catch {
    reason = "timeout";
  }
  console.log("social public reply failed", reason);
}

async function shortHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the 9pm digest: people who wrote on Instagram or Messenger in the last 7 days, how many opened WhatsApp with their code, how many booked ----
export async function socialLines(env: Env, nowMs = Date.now()): Promise<string[]> {
  const rows = await env.DB
    .prepare(
      `SELECT platform, COUNT(*) AS n, COUNT(wa_conversation_id) AS wa,
         SUM(CASE WHEN said_booked_at IS NOT NULL OR ${paidIn("c.wa_conversation_id")} THEN 1 ELSE 0 END) AS booked
       FROM social_contacts c WHERE COALESCE(last_in_at, created_at) >= ?1 GROUP BY platform ORDER BY platform`,
    )
    .bind(iso(nowMs - 7 * DAY))
    .all<{ platform: Platform; n: number; wa: number; booked: number }>();
  if (!rows.results.length) return ["- Nobody wrote."];
  return rows.results.map((r) => `- ${r.platform === "instagram" ? "Instagram" : "Messenger"}: ${r.n} people, ${r.wa} opened WhatsApp, ${r.booked} booked`);
}

// ---- clean-up, on the 2-minute cron: dedupe ids after a week, comment keys and a person's row 90 days after their last activity ----
export async function cleanSocial(env: Env, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM social_seen WHERE at < ?1 AND key NOT LIKE 'c:%'").bind(iso(nowMs - config.social.keepSeenDays * DAY)).run();
  await env.DB.prepare("DELETE FROM social_seen WHERE at < ?1").bind(iso(nowMs - config.social.forgetAfterDays * DAY)).run();
  await env.DB.prepare("DELETE FROM social_contacts WHERE COALESCE(last_in_at, created_at) < ?1").bind(iso(nowMs - config.social.forgetAfterDays * DAY)).run();
}

// ---- short links (ticket 33), public like /p/ (outside /admin, /amma and /app, so Cloudflare Access never stands in front of them) ----
// Messenger writes links out, and the wa.me link with its prefilled text is several lines of %20. So it writes <PUBLIC_URL>/b/<ref> and
// <PUBLIC_URL>/fb instead, and these send the person on with a 302. Nothing is stored or logged; the code is only checked against the
// format newRef makes. /b/<ref>[/hi][/back]: the same wa.me link and prefilled text as before ("/hi": the Hindi text; "/back": "Hi",
// for someone who has booked), with the ref, so the WhatsApp bot still links the chats. Anything else: plain wa.me (never a 404, never
// the input echoed back).
export function shortBase(env: Pick<Env, "PUBLIC_URL">): string | null {
  const base = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  return /^https:\/\/[^/]+$/.test(base) ? base : null;
}

const redirect = (c: C, url: string) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(url, 302);
};

export function bookRedirect(c: C) {
  const m = /^\/b\/([^/]*)(\/hi)?(\/back)?\/?$/.exec(c.req.path);
  if (!m || !REF_FORMAT.test(m[1])) return redirect(c, `https://wa.me/${waDigits()}`);
  return redirect(c, bookLink(socialWords(m[2] ? "hi" : "en"), m[1], !!m[3]));
}
export const pageRedirect = (c: C) => redirect(c, profileUrl(c.env, "messenger"));
export const profileRedirect = (c: C) => redirect(c, config.social.instagramUrl);

// ---- GET /data-deletion: Meta App Review's "data deletion instructions" URL. Public, English, no scripts. ----
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export function dataDeletionPage(c: C) {
  const email = config.social.contactEmail;
  const wa = `https://wa.me/${waDigits()}`;
  return c.html(
    html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Delete your data · Disha Dira Pranic Healing</title><style>
:root{--bg:#FBFAF7;--card:#FFFFFF;--ink:#14302F;--muted:#5B6B69;--line:#E2DED3;--accent:#1B6F73;--accent-ink:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--bg:#121615;--card:#1A201F;--ink:#E8EEEC;--muted:#9FB0AD;--line:#2C3533;--accent:#5CC2BE;--accent-ink:#0E1A19}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:32px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 20px}
h1{font-size:24px;line-height:1.3;margin:0 0 12px}h2{font-size:19px;margin:20px 0 8px}p,li{margin:0 0 12px}a{color:var(--accent)}
.btn{display:flex;align-items:center;justify-content:center;min-height:52px;padding:12px 20px;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;margin-top:8px}
</style></head><body><main><div class="card">
<h1>Delete your data</h1>
<p>Disha Dira Pranic Healing answers Instagram and Facebook Messenger messages, and comments on our posts, automatically, to send you the link to book on WhatsApp.</p>
<h2>What we keep</h2>
<ul><li>The id that Instagram or Facebook gives us for you (not your name or username).</li><li>Your language (English or Hindi) and which reply you have had.</li><li>The times of your last message and of our replies, whether you follow us (as Instagram tells us, or as you told us), and whether you asked us to stop.</li>
<li>How many insulting, threatening or sexual messages you sent (a count, never the words), and whether automatic replies to you have stopped because of them.</li>
<li>A short reference code that goes in the WhatsApp message we prepare for you (for example "(ref: IGK7Q2M)"). If you send it, we link it to your WhatsApp chat with us, only to count bookings that started on Instagram or Facebook.</li></ul>
<p>We do not keep the text of your messages or comments. Message ids are kept for ${config.social.keepSeenDays} days, and the ids of posts you commented on for ${config.social.forgetAfterDays} days, only so nothing is answered twice. Everything is deleted ${config.social.forgetAfterDays} days after your last message.</p>
<h2>How to delete it now</h2>
<ul><li>Send <b>delete my data</b> to us in the same Instagram or Messenger chat. It is deleted at once, and you get a short reply to say so.</li>
<li>Or email <a href="mailto:${email}">${email}</a>, or message us on WhatsApp, and say which account (Instagram or Facebook) you wrote from. We delete it within 7 working days and tell you when it is done.</li></ul>
<p>Our full privacy policy: <a href="https://disha-dira.com/privacy.html">disha-dira.com/privacy.html</a></p>
<a class="btn" href="${wa}">Message us on WhatsApp</a>
</div></main></body></html>`,
    200,
    { "Content-Security-Policy": PAGE_CSP, "Cache-Control": "public, max-age=3600", "Referrer-Policy": "no-referrer" },
  );
}
