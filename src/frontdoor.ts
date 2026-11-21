// Ticket 52 (CONTRACT v20): the Karmic Coaching front door, behind the KARMIC_FRONT_DOOR env flag. All fixed messages, no AI.
//   after the language tap / Book (menu_book, "book") -> "What would you like help with?" (a list: five topics, then Sessions & packages and
//   Help) -> tp_<TOPIC> -> one warm line and the Karmic Clarity Call (₹99, 15 min) with [Book ₹99 call] (book_call, the call's own steps) [Help];
//   with NEW_SERVICES on too, a second message "Or book directly" listing the services of the topic's pathways (cat_<key>, src/offer.ts; the
//   single session, pk_single, is RELEASE). The topic tapped is kept on the conversation and copied onto the booking it leads to (bookings
//   started within config.frontDoor.topicHours), so the team sees "Came for: Relationships & family".
// With the flag "false" nothing here is reached: Book, the menu and every message are exactly as before, and an old topic button does nothing.
import type { D1Database } from "@cloudflare/workers-types";
import { catalogue, isOffered, newServicesOn, SESSION_KEY, type Service } from "./catalogue";
import { config } from "./config";
import { copyFor, langOf, rupees, type Copy, type Lang, type TopicKey } from "./copy";
import type { Env } from "./env";
import type { ListRow, Out } from "./send";
import { sendStep } from "./steps";
import { iso } from "./slots";

export const TOPICS: readonly TopicKey[] = config.frontDoor.topics;
export const isTopic = (v: unknown): v is TopicKey => typeof v === "string" && (TOPICS as readonly string[]).includes(v);
export const frontDoorOn = (env: { KARMIC_FRONT_DOOR?: string }) => env.KARMIC_FRONT_DOOR === "true";
const TOPIC_ID = /^tp_([A-Z_]+)$/;

// The list: the five topics, then Sessions & packages and Help (the menu's other two buttons), so nothing the menu offered is lost.
export const topicListOut = (cp: Copy): Out => ({
  type: "list",
  body: cp.topicBody,
  button: cp.topicButton,
  sections: [
    { title: cp.topicSection, rows: TOPICS.map((t) => ({ id: `tp_${t}`, title: cp.topicTitles[t], description: cp.topicDescs[t] })) },
    { title: cp.topicMoreSection, rows: [{ id: "menu_pack", title: cp.btnPackages }, { id: "menu_how", title: cp.btnHelp }] },
  ],
});

// What can be booked directly for a topic: only with NEW_SERVICES on, the single session (RELEASE) and the offered services of the topic's
// pathways, in the topic's pathway order and then the owner's, at most config.offer.listMax rows. "Not sure yet": nothing (the call only).
export function directRows(env: Env, cp: Copy, lang: Lang, topic: TopicKey): ListRow[] {
  if (!newServicesOn(env)) return [];
  const fit = (t: string) => ([...t].length <= 24 ? t : [...t].slice(0, 23).join("").trimEnd() + "…");
  const bookable = (s: Service) => (s.key === SESSION_KEY ? s.active && s.public : isOffered(env, s));
  const rows: ListRow[] = [];
  for (const p of config.frontDoor.pathways[topic] as readonly string[]) {
    for (const s of catalogue().filter((x) => x.pathway === p && bookable(x))) {
      rows.push(
        s.key === SESSION_KEY
          ? { id: "pk_single", title: cp.rowSingleTitle, description: cp.offerRowDesc(s.minutes, rupees(s.pricePaise), false) }
          : { id: `cat_${s.key}`, title: fit(lang === "hi" ? s.nameHi : s.nameEn), description: cp.offerRowDesc(s.minutes, rupees(s.pricePaise), s.needsCallFirst) },
      );
    }
  }
  return rows.slice(0, config.offer.listMax);
}

// "What would you like help with?" as the open step. `key` is the outbound dedupe key.
export const sendTopicList = (env: Env, convId: number, cp: Copy, key: string) => sendStep(env, convId, "topic", topicListOut(cp), key);

// Handles tp_<TOPIC>. false for any other choice, and for every choice while the flag is off.
export async function frontDoorChoice(env: Env, choice: string | null, convId: number, msgId: string): Promise<boolean> {
  const m = TOPIC_ID.exec(choice ?? "");
  if (!m || !isTopic(m[1]) || !frontDoorOn(env)) return false;
  const topic = m[1];
  const conv = await env.DB.prepare("SELECT id, locale FROM conversations WHERE id = ?1").bind(convId).first<{ id: number; locale: string }>();
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  await env.DB.prepare("UPDATE conversations SET topic_pick = ?2, topic_pick_at = ?3 WHERE id = ?1").bind(conv.id, topic, iso(Date.now())).run();
  const pitch: Out = {
    type: "buttons",
    body: `${cp.topicLines[topic]}\n\n${cp.clarityPitch}`,
    buttons: [{ id: "book_call", title: cp.btnBookCall }, { id: "menu_how", title: cp.btnHelp }],
  };
  await sendStep(env, conv.id, "clarity", pitch, `${msgId}:clarity`);
  const rows = directRows(env, cp, langOf(conv.locale), topic);
  if (rows.length) await sendStep(env, conv.id, "packages", { type: "list", body: cp.directBody, button: cp.directButton, rows }, `${msgId}:direct`);
  return true;
}

// The topic a booking started now is for: the one tapped within config.frontDoor.topicHours, or null.
export async function pickedTopic(db: D1Database, convId: number, nowMs = Date.now()): Promise<TopicKey | null> {
  const row = await db
    .prepare("SELECT topic_pick AS t FROM conversations WHERE id = ?1 AND topic_pick_at > ?2")
    .bind(convId, iso(nowMs - config.frontDoor.topicHours * 3_600_000))
    .first<{ t: string | null }>()
    .catch(() => null); // no column yet (before 0024): no topic
  return isTopic(row?.t) ? row.t : null;
}

// What the team sees on Today, the calendar's day view and the person page (owner, and the booking's practitioner).
export const TOPIC_LABELS: Record<Lang, Record<TopicKey, string>> = {
  en: {
    RELATIONSHIPS: "Relationships & family", HEAVY: "Feeling heavy or drained", DECISION: "A decision or direction",
    HABIT: "A habit or pattern to change", NOT_SURE: "Not sure yet",
  },
  hi: {
    RELATIONSHIPS: "रिश्ते और परिवार", HEAVY: "मन भारी या थका हुआ", DECISION: "कोई फ़ैसला या दिशा",
    HABIT: "कोई आदत या पैटर्न बदलना", NOT_SURE: "अभी पक्का नहीं",
  },
};
export const cameFor = (topic: string | null | undefined, lang: Lang): string | null =>
  isTopic(topic) ? (lang === "hi" ? `किसलिए आए: ${TOPIC_LABELS.hi[topic]}` : `Came for: ${TOPIC_LABELS.en[topic]}`) : null;
