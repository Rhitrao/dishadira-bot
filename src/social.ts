// Ticket 32: free automatic replies to Instagram DMs (@disha_dira) and Facebook Messenger (the Page "Disha Dira Pranic Healing"), behind
// SOCIAL_REPLIES. Whatever someone writes, they are asked to follow us ("we share a short Pranic Healing tip every week"); once they
// follow, they get the WhatsApp link to book. No number is ever shown except inside the wa.me link. The WhatsApp webhook (/wa/webhook,
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
// Whether someone follows the Facebook Page cannot be read, so on Messenger "I've followed" sends the link.
// Stored: the platform id, language, step and times (migrations/0012_social.sql). Never message text, names or usernames; logs carry
// reason codes and Meta error codes only (test/logging.test.ts).
import type { Context } from "hono";
import { html } from "hono/html";
import { prices } from "./business";
import { config } from "./config";
import { copyFor, rupees, type Lang } from "./copy";
import type { Env } from "./env";
import { classifyWithoutAI, LINK } from "./gate";
import { detectSafety, hasPhrase, normalize } from "./safety";
import { recipients } from "./business";
import { sendEmailToEach } from "./mail";
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

// ---- the words (EN and HI). Hindi speaks as "we", so no gender shows (docs/KNOWLEDGE.md §1). It is the automated assistant, never a person.
// Facts only from docs/KNOWLEDGE.md and the prices in force (src/business.ts). ----
export type Topic = keyof typeof config.social.keywords;
// The questions offered as quick replies after the follow (Instagram: at most 13, titles up to 20 characters; Messenger the same).
export const QUESTIONS = ["book", "price", "what", "how"] as const satisfies readonly Topic[];
const QR = (t: Topic) => `SOCIAL_Q_${t.toUpperCase()}`;
const qrTopic = (payload: string): Topic | null => QUESTIONS.find((t) => QR(t) === payload) ?? null;

type Words = {
  ask: string;
  notYet: string;
  guide: string; // after the follow: the way to book
  questions: string; // Instagram: the quick replies' own message (Instagram puts quick replies on text only)
  after: (url: string) => string;
  deleted: string;
  lines: Record<Topic, string>;
  qrTitles: Record<(typeof QUESTIONS)[number], string>;
  btnVisit: Record<Platform, string>;
  btnFollowing: Record<Platform, string>;
  btnBook: string;
  prefill: string;
  typeFollowing: string;
  publicReply: string;
};

export function socialWords(lang: Lang): Words {
  const p = prices();
  const intro = rupees(p.intro);
  const mins = config.slots.callMinutes;
  if (lang === "hi")
    return {
      ask: "नमस्ते, दिशा दिरा में रुचि लेने के लिए धन्यवाद! हम हर हफ़्ते प्राणिक हीलिंग का एक छोटा टिप शेयर करते हैं। कृपया हमें फ़ॉलो करें, फिर नीचे टैप करें, और हमारा बुकिंग असिस्टेंट सेशन में आपकी मदद करेगा।",
      notYet: "लगता है फ़ॉलो अभी तक नहीं पहुँचा है। हमारी प्रोफ़ाइल पर Follow टैप करें, फिर नीचे टैप करें।",
      guide: `फ़ॉलो करने के लिए धन्यवाद! यह दिशा दिरा का ऑटोमैटिक बुकिंग असिस्टेंट है। नीचे टैप करके WhatsApp पर शांता राव जी के साथ ${intro} की ${mins} मिनट की कॉल बुक करें। समय आप चुनते हैं, और वे आपको कॉल करती हैं।`,
      questions: "कोई सवाल है? नीचे टैप करें।",
      after: (url) => `बुकिंग और सवालों के लिए हमें WhatsApp पर मैसेज करें:\n${url}\nहम वहीं जवाब देते हैं।`,
      deleted: "हो गया। इन जवाबों के लिए हमने आपके बारे में जो रखा था (आपका Instagram या Messenger id, भाषा और जवाब के चरण), वह मिटा दिया है। आपके मैसेज हम कभी नहीं रखते।",
      lines: {
        price: `शांता राव जी के साथ पहली ${mins} मिनट की कॉल ${intro} की है। एक सेशन ${rupees(p.single)} का है, या ${p.pack10.sessions} सेशन ${rupees(p.pack10.paise)} में और ${p.pack20.sessions} सेशन ${rupees(p.pack20.paise)} में।`,
        refund: `अगर पहली कॉल के बाद शांता राव जी को लगे कि सेशन आपके लिए सही नहीं है, तो ${intro} वापस कर दिए जाते हैं। कॉल छूट जाए तो एक बार मुफ़्त में नया समय चुन सकते हैं।`,
        how: `${mins} मिनट की कॉल में शांता राव जी आपके चुने हुए समय पर उस नंबर पर कॉल करती हैं जिससे आप WhatsApp पर बुक करते हैं। आप अपनी बात बताते हैं, और वे बताती हैं कि सेशन आपके लिए सही रहेगा या नहीं।`,
        book: `आप WhatsApp पर शांता राव जी के साथ ${intro} की ${mins} मिनट की कॉल बुक कर सकते हैं। समय आप चुनते हैं।`,
        where: "सभी कॉल और सेशन फ़ोन पर होते हैं, इसलिए आप कहीं से भी जुड़ सकते हैं, भारत में या विदेश में (जैसे दुबई)। समय भारत के समय से होता है।",
        what: "प्राणिक हीलिंग बिना छुए की जाने वाली एक सौम्य एनर्जी हीलिंग पद्धति है। यह डॉक्टर के इलाज के साथ चलती है, उसकी जगह नहीं लेती।",
      },
      qrTitles: { book: `${intro} कॉल बुक करें`, price: "फ़ीस", what: "प्राणिक हीलिंग", how: "कॉल कैसे होती है" },
      btnVisit: { instagram: "प्रोफ़ाइल देखें", messenger: "हमारा पेज खोलें" },
      btnFollowing: { instagram: "मैंने फ़ॉलो किया", messenger: "मैंने फ़ॉलो किया" },
      btnBook: "WhatsApp पर बुक करें",
      prefill: `नमस्ते, मुझे ${intro} की कॉल बुक करनी है`,
      typeFollowing: 'फ़ॉलो करने के बाद यहाँ "following" लिखकर भेजें।',
      publicReply: "आपको DM भेजा है 🙏",
    };
  return {
    ask: "Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap below and our booking assistant will help you with a session.",
    notYet: "It looks like the follow hasn't come through yet. Tap Follow on our profile, then tap below.",
    guide: `Thank you for following! This is Disha Dira's automated booking assistant. Tap below to book a ${intro} ${mins}-minute call with Shantha Rao on WhatsApp. You choose the time, and she calls you.`,
    questions: "Have a question? Tap one below.",
    after: (url) => `For bookings and questions, message us on WhatsApp:\n${url}\nWe reply there.`,
    deleted: "Done. We have deleted what we kept about you for these replies (your Instagram or Messenger id, language and reply steps). We never keep your messages.",
    lines: {
      price: `A first ${mins}-minute call with Shantha Rao is ${intro}. A session is ${rupees(p.single)}, or ${p.pack10.sessions} sessions for ${rupees(p.pack10.paise)} and ${p.pack20.sessions} for ${rupees(p.pack20.paise)}.`,
      refund: `If Shantha Rao feels a session isn't the right fit after your first call, the ${intro} is refunded. If you miss the call, you get one free chance to pick a new time.`,
      how: `On the ${mins}-minute call, Shantha Rao calls the number you book from on WhatsApp, at the time you pick. You share what is going on, and she explains whether a session would suit you.`,
      book: `You can book a ${intro} ${mins}-minute call with Shantha Rao on WhatsApp. You pick the time.`,
      where: "All calls and sessions are by phone, so you can join from anywhere, in India or abroad (such as Dubai). Times are in India time.",
      what: "Pranic Healing is a gentle, no-touch energy healing practice. It complements medical care and is not a substitute for it.",
    },
    qrTitles: { book: `Book a ${intro} call`, price: "Prices", what: "About Pranic Healing", how: "How the call works" },
    btnVisit: { instagram: "Visit profile", messenger: "Open our Page" },
    btnFollowing: { instagram: "I'm following", messenger: "I've followed" },
    btnBook: "Book on WhatsApp",
    prefill: `Hi, I'd like to book a ${intro} call`,
    typeFollowing: 'Once you follow, reply "following" here.',
    publicReply: "Sent you a DM 🙏",
  };
}

const waDigits = () => config.businessNumber.replace(/\D/g, "");
export const bookLink = (w: Words) => `https://wa.me/${waDigits()}?text=${encodeURIComponent(w.prefill)}`;
const profileUrl = (env: Env, platform: Platform) =>
  platform === "instagram" ? config.social.instagramUrl : config.social.facebookPageUrl || `https://www.facebook.com/${env.META_PAGE_ID}`;

// ---- reading the message ----
export function detectLang(text: string, current: Lang): Lang {
  if (/[ऀ-ॿ]/.test(text) || hasPhrase(text, config.social.hinglish)) return "hi";
  return normalize(text).split(" ").filter((w) => /\p{L}/u.test(w)).length >= 2 ? "en" : current;
}

// What the message asks about, answered in one line once they follow. Never a medical answer: a message naming an illness has no topic.
export function topicOf(text: string): Topic | null {
  if (hasPhrase(text, config.router.topics.medical)) return null;
  for (const k of Object.keys(config.social.keywords) as Topic[]) if (hasPhrase(text, config.social.keywords[k])) return k;
  return null;
}

// Links, promotions, scams, abuse: nothing beyond the first follow ask.
const isJunk = (text: string) => LINK.test(text) || classifyWithoutAI(text) !== "TO_CLASSIFIER";

const DELETE_WORDS = ["delete my data", "delete my instagram data", "delete my messenger data", "delete my facebook data", "remove my data", "erase my data",
  "mera data delete karo", "mera data delete kar do", "मेरा डेटा डिलीट करें", "मेरा डेटा डिलीट करो", "मेरा डेटा हटाएं", "मेरा डेटा हटा दें"];

type Event =
  | { kind: "comment"; platform: Platform; mid: string; author: string; post: string; text: string | null }
  | { kind: "dm"; platform: Platform; user: string; mid: string; text: string | null }
  | { kind: "tap"; platform: Platform; user: string; mid: string; payload: string }
  | { kind: "echo"; platform: Platform; user: string; mid: string; metadata: string | null };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

// One item of entry.messaging, as an event we act on, or the reason we leave it alone.
export function readEvent(platform: Platform, ownId: string, raw: unknown): Event | { ignore: string } {
  const item = obj(raw);
  if (!item) return { ignore: "SCHEMA_INVALID" };
  const sender = str(obj(item.sender)?.id);
  const recipient = str(obj(item.recipient)?.id);
  const m = obj(item.message);
  if (m) {
    const mid = str(m.mid);
    if (m.is_echo === true) {
      if (!recipient || !mid) return { ignore: "NO_SENDER" };
      return { kind: "echo", platform, user: recipient, mid, metadata: str(m.metadata) };
    }
    if (!sender) return { ignore: "NO_SENDER" };
    if (sender === ownId) return { ignore: "OWN_MESSAGE" };
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
    const mid = str(pb.mid) ?? `pb:${sender}:${str(item.timestamp) ?? ""}:${str(pb.payload) ?? ""}`;
    return { kind: "tap", platform, user: sender, mid, payload: str(pb.payload) ?? "" };
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
  nudge_at: string | null;
  paused_until: string | null;
  commenter_id: string | null;
  topic: Topic | null;
};

async function loadContact(env: Env, platform: Platform, user: string): Promise<Contact> {
  const row = await env.DB.prepare("SELECT * FROM social_contacts WHERE platform = ?1 AND user_id = ?2").bind(platform, user).first<Contact>();
  return (
    row ?? {
      platform, user_id: user, lang: "en", step: "NEW", asks: 0, link_sent_at: null, last_in_at: null, last_auto_at: null, autos_since: null, autos_today: 0,
      nudge_at: null, paused_until: null, commenter_id: null, topic: null,
    }
  );
}

async function saveContact(env: Env, r: Contact, nowMs: number): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO social_contacts (platform, user_id, lang, step, asks, link_sent_at, last_in_at, last_auto_at, autos_since, autos_today, nudge_at, paused_until, commenter_id, topic, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT (platform, user_id) DO UPDATE SET lang = ?3, step = ?4, asks = ?5, link_sent_at = ?6, last_in_at = ?7, last_auto_at = ?8,
         autos_since = ?9, autos_today = ?10, nudge_at = ?11, paused_until = ?12, commenter_id = ?13, topic = ?14, updated_at = ?15`,
    )
    .bind(r.platform, r.user_id, r.lang, r.step, r.asks, r.link_sent_at, r.last_in_at, r.last_auto_at, r.autos_since, r.autos_today, r.nudge_at, r.paused_until, r.commenter_id, r.topic, iso(nowMs))
    .run();
}

const ago = (at: string | null, nowMs: number) => (at ? nowMs - Date.parse(at) : Infinity);
const seenOnce = async (env: Env, key: string, nowMs: number) =>
  (await env.DB.prepare("INSERT OR IGNORE INTO social_seen (key, at) VALUES (?1, ?2)").bind(key, iso(nowMs)).run()).meta.changes > 0;

// ---- the flow ----
// 1. Any first message or comment gets only the follow ask (its topic is remembered as a code). 2. Once they follow (Instagram: checked,
// the second tap goes through anyway; Messenger: on the tap), one line on that topic, then the way to book on WhatsApp with quick
// replies for the common questions. 3. After that, the questions are answered when tapped, and a message gets one pointer to WhatsApp a day.
async function handle(env: Env, ev: Event, nowMs: number): Promise<void> {
  if (ev.kind === "comment") return handleComment(env, ev, nowMs);
  const now = iso(nowMs);
  const r = await loadContact(env, ev.platform, ev.user);

  // Someone from the team wrote by hand in the Instagram or Page inbox (not our own message): keep out of that chat for a day.
  if (ev.kind === "echo") {
    if (ev.metadata === METADATA) return;
    if (await env.DB.prepare("SELECT 1 FROM social_seen WHERE key = ?1").bind(`out:${ev.mid}`).first()) return;
    if (ago(r.last_auto_at, nowMs) < config.social.ownEchoSeconds * 1000) return; // our send, whose id is not stored yet
    r.paused_until = iso(nowMs + config.social.pauseHours * HOUR);
    await saveContact(env, r, nowMs);
    return;
  }

  // After a month of silence the flow starts again.
  if (ago(r.last_in_at, nowMs) > config.social.restartAfterDays * DAY) Object.assign(r, { step: "NEW", asks: 0, link_sent_at: null, nudge_at: null, topic: null });
  r.last_in_at = now;
  const text = ev.kind === "dm" ? ev.text : null;
  if (text) r.lang = detectLang(text, r.lang);
  const w = socialWords(r.lang);

  if (text && hasPhrase(text, DELETE_WORDS)) return forget(env, r, w);

  // Safety first, as on WhatsApp (CONTRACT "Safety", src/safety.ts): the same fixed message, no follow ask and no selling, and the owner is told.
  const safety = text ? detectSafety(text) : null;
  if (safety) return safetyReply(env, r, safety, nowMs);

  if (r.paused_until && Date.parse(r.paused_until) > nowMs) return void (await saveContact(env, r, nowMs));
  if (ago(r.autos_since, nowMs) >= DAY) Object.assign(r, { autos_since: now, autos_today: 0 });
  if (text && r.step !== "LINKED") r.topic ??= topicOf(text);

  const question = ev.kind === "tap" ? qrTopic(ev.payload) : null;
  // A typed "following" at the follow ask counts as the tap (a private reply may have gone out as plain text).
  const typedFollow = !!text && (r.step === "ASKED" || r.step === "RECHECK") && normalize(text).split(" ").length <= 5 && hasPhrase(text, config.social.followedWords);
  const tapped = (ev.kind === "tap" && ev.payload === FOLLOWING) || typedFollow;
  if (r.step === "LINKED") {
    if (question) await answerQuestion(env, r, w, question, nowMs);
    // Otherwise one short pointer to WhatsApp a day, and nothing more.
    else if (ago(r.nudge_at, nowMs) >= config.social.nudgeEveryHours * HOUR && (await send(env, r, { text: w.after(bookLink(w)) }, nowMs))) r.nudge_at = now;
  } else if (tapped) {
    await followTap(env, r, w, nowMs);
  } else if (text && isJunk(text)) {
    if (r.step === "NEW" && (await send(env, r, askMessage(env, r.platform, w), nowMs))) r.step = "ASKED";
  } else {
    const repeat = r.step !== "NEW" && ago(r.last_auto_at, nowMs) < config.social.repeatAskMinutes * 60_000;
    if (!repeat && (await send(env, r, askMessage(env, r.platform, w), nowMs)) && r.step === "NEW") r.step = "ASKED";
  }
  await saveContact(env, r, nowMs);
}

// "delete my data": their row and every key with their id, at once, and a short reply to say so.
async function forget(env: Env, r: Contact, w: Words): Promise<void> {
  const ids = [r.user_id, r.commenter_id ?? r.user_id];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM social_contacts WHERE platform = ?1 AND (user_id = ?2 OR commenter_id = ?2)").bind(r.platform, r.user_id),
    ...ids.map((id) => env.DB.prepare("DELETE FROM social_seen WHERE key LIKE ?1 OR key LIKE ?2").bind(`qa:${r.platform}:${id}:%`, `c:${r.platform}:${id}:%`)),
  ]);
  if (await sendsOn(env)) await graphSend(env, r.platform, { id: r.user_id }, { text: w.deleted });
}

// The crisis message (Tele-MANAS, 112) or the emergency message, as the WhatsApp bot sends them; no selling for a week after a crisis
// message (config.safety.noSellDays), a day after an emergency; one SOCIAL_SAFETY item, and for a crisis an email to the safety contact.
async function safetyReply(env: Env, r: Contact, safety: "CRISIS" | "EMERGENCY", nowMs: number): Promise<void> {
  const cp = copyFor(r.lang);
  await send(env, r, { text: (safety === "CRISIS" ? cp.crisis : cp.emergency).replaceAll("*", "") }, nowMs, { safety: true });
  r.paused_until = iso(nowMs + (safety === "CRISIS" ? config.safety.noSellDays * DAY : config.social.pauseHours * HOUR));
  await saveContact(env, r, nowMs);
  const where = r.platform === "instagram" ? "Instagram" : "Facebook Messenger";
  const fresh = await raiseAttention(env.DB, SAFETY_ITEM, `${r.platform}:${await shortHash(r.user_id)}`);
  if (fresh && safety === "CRISIS") {
    await sendEmailToEach(env, await recipients(env, "safety"), `Urgent: crisis message on ${where}`,
      `A crisis message arrived on ${where}. The bot sent the helpline message (Tele-MANAS 14416, 112) and keeps no message text. Open the ${where === "Instagram" ? "Instagram" : "Page"} inbox now and write to them yourself.`);
  }
}

// A comment on our post or reel gets one private reply: the follow ask, which starts the same flow. One per commenter per post; nobody who
// had the link in the last 30 days; not while the team has the chat; within the same daily limit. The comment text is only read for its
// language and topic, never stored.
async function handleComment(env: Env, ev: Extract<Event, { kind: "comment" }>, nowMs: number): Promise<void> {
  const now = iso(nowMs);
  const postKey = `c:${ev.platform}:${ev.author}:${ev.post}`;
  if (!(await seenOnce(env, postKey, nowMs))) return;
  const known = await env.DB
    .prepare("SELECT * FROM social_contacts WHERE platform = ?1 AND (user_id = ?2 OR commenter_id = ?2) ORDER BY last_in_at DESC LIMIT 1")
    .bind(ev.platform, ev.author)
    .first<Contact>();
  let r = known ?? (await loadContact(env, ev.platform, ev.author));
  if (ago(r.link_sent_at, nowMs) < config.social.restartAfterDays * DAY) return;
  if (r.paused_until && Date.parse(r.paused_until) > nowMs) return;
  if (ev.text && detectSafety(ev.text)) return; // never a sales message under a crisis comment; the team sees the comment itself
  if (ago(r.autos_since, nowMs) >= DAY) Object.assign(r, { autos_since: now, autos_today: 0 });
  if (r.autos_today >= config.social.maxAutosPerDay || !(await sendsOn(env))) return;
  if (ev.text) r.lang = detectLang(ev.text, r.lang);
  const topic = ev.text ? topicOf(ev.text) : null;
  const w = socialWords(r.lang);
  const to = { comment_id: ev.mid };
  let out = await graphSend(env, ev.platform, to, askMessage(env, ev.platform, w));
  // If the buttons are refused in an Instagram private reply, the same ask as text, with the profile link and "reply following" (a typed
  // "following" counts as the tap). Messenger takes every message type in a private reply.
  if (!out && ev.platform === "instagram") out = await graphSend(env, ev.platform, to, { text: `${w.ask}\n\n${profileUrl(env, ev.platform)}\n${w.typeFollowing}` });
  if (!out) {
    await env.DB.prepare("DELETE FROM social_seen WHERE key = ?1").bind(postKey).run(); // a later comment may try again
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
  r.topic ??= topic;
  Object.assign(r, { last_in_at: now, last_auto_at: now, autos_since: r.autos_since ?? now, autos_today: r.autos_today + 1, step: r.step === "NEW" ? "ASKED" : r.step });
  await saveContact(env, r, nowMs);
  if (config.social.publicReply) await publicReply(env, ev.platform, ev.mid, w.publicReply);
}

async function followTap(env: Env, r: Contact, w: Words, nowMs: number): Promise<void> {
  r.asks += 1;
  // Messenger can't tell us whether someone follows the Page. On Instagram the second tap goes through anyway (the owner's choice, so a
  // real follower is never stuck while Instagram catches up), and so does any answer other than a clear "no" (fail open).
  if (r.platform === "instagram" && r.asks < 2 && (await followsUs(env, r.user_id)) === false) {
    if (await send(env, r, buttons(w.notYet, [visitButton(env, r.platform, w), followingButton(r.platform, w)]), nowMs)) r.step = "RECHECK";
    return;
  }
  // The topic line, then the way to book with the questions. It always goes once, even past the daily limit, so nobody who followed is
  // left without it. Instagram puts quick replies on text only, so there the questions are a second, short message.
  const text = r.topic ? `${w.lines[r.topic]}\n\n${w.guide}` : w.guide;
  const guide = buttons(text, [bookButton(w)]);
  let ok: boolean;
  if (r.platform === "messenger") ok = await send(env, r, withQuestions(guide, w), nowMs, { always: true });
  else if ((ok = await send(env, r, guide, nowMs, { always: true }))) await send(env, r, withQuestions({ text: w.questions }, w), nowMs, { always: true });
  if (ok) Object.assign(r, { step: "LINKED", link_sent_at: iso(nowMs), nudge_at: null, topic: null });
}

// A tapped question after the follow: one line and [Book on WhatsApp]; each question at most once a day per person.
async function answerQuestion(env: Env, r: Contact, w: Words, topic: Topic, nowMs: number): Promise<void> {
  if (!(await seenOnce(env, `qa:${r.platform}:${r.user_id}:${topic}:${iso(nowMs).slice(0, 10)}`, nowMs))) return;
  const answer = buttons(w.lines[topic], [bookButton(w)]);
  await send(env, r, r.platform === "messenger" ? withQuestions(answer, w) : answer, nowMs, { always: true });
}

// ---- messages ----
type Button = { type: "web_url"; url: string; title: string } | { type: "postback"; title: string; payload: string };
type QuickReply = { content_type: "text"; title: string; payload: string };
type Message = ({ text: string } | { attachment: { type: "template"; payload: { template_type: "button"; text: string; buttons: Button[] } } }) & { quick_replies?: QuickReply[] };

const buttons = (text: string, list: Button[]): Message => ({ attachment: { type: "template", payload: { template_type: "button", text, buttons: list } } });
const visitButton = (env: Env, p: Platform, w: Words): Button => ({ type: "web_url", url: profileUrl(env, p), title: w.btnVisit[p] });
const followingButton = (p: Platform, w: Words): Button => ({ type: "postback", title: w.btnFollowing[p], payload: FOLLOWING });
const bookButton = (w: Words): Button => ({ type: "web_url", url: bookLink(w), title: w.btnBook });
const askMessage = (env: Env, p: Platform, w: Words): Message => buttons(w.ask, [visitButton(env, p, w), followingButton(p, w)]);
const withQuestions = (m: Message, w: Words): Message => ({ ...m, quick_replies: QUESTIONS.map((t) => ({ content_type: "text", title: w.qrTitles[t], payload: QR(t) })) });

// An automated message to this person: only while sends are on, at most config.social.maxAutosPerDay a day (safety messages and the
// messages after the follow excepted). The count and the time are saved before the call, so the echo of this message is known to be ours.
async function send(env: Env, r: Contact, message: Message, nowMs: number, o: { safety?: boolean; always?: boolean } = {}): Promise<boolean> {
  if (!(o.safety ? sendsEnvOn(env) : await sendsOn(env))) return false;
  if (!o.safety && !o.always && r.autos_today >= config.social.maxAutosPerDay) return false;
  r.last_auto_at = iso(nowMs);
  r.autos_since ??= r.last_auto_at;
  r.autos_today += 1;
  await saveContact(env, r, nowMs);
  const out = await graphSend(env, r.platform, { id: r.user_id }, message);
  if (out?.mid) await seenOnce(env, `out:${out.mid}`, nowMs);
  return out !== null;
}

const graph = (path: string) => `https://graph.facebook.com/${config.graphVersion}/${path}`;
const errorCode = async (res: Response) => String(((await res.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code ?? res.status);

// The Send API (both platforms, the Page token), to a person ({id}) or as the private reply to a comment ({comment_id}). Returns Meta's
// message id and the person's messaging id, or null. Failures are logged by code only.
type Recipient = { id: string } | { comment_id: string };
type Sent = { mid: string | null; recipient: string | null };
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
  return null;
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

// ---- clean-up, on the 2-minute cron: dedupe ids after a week, comment keys and a person's row 90 days after their last activity ----
export async function cleanSocial(env: Env, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM social_seen WHERE at < ?1 AND key NOT LIKE 'c:%'").bind(iso(nowMs - config.social.keepSeenDays * DAY)).run();
  await env.DB.prepare("DELETE FROM social_seen WHERE at < ?1").bind(iso(nowMs - config.social.forgetAfterDays * DAY)).run();
  await env.DB.prepare("DELETE FROM social_contacts WHERE COALESCE(last_in_at, created_at) < ?1").bind(iso(nowMs - config.social.forgetAfterDays * DAY)).run();
}

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
<ul><li>The id that Instagram or Facebook gives us for you (not your name or username).</li><li>Your language (English or Hindi) and which reply you have had.</li><li>The times of your last message and of our replies.</li></ul>
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
