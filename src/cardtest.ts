// Ticket 49: the 14-day CARD test. A person who sends the word CARD (they start it; the bot never sends it unprompted) picks one theme for the
// day and gets three cards (Past, Present, Next step) with a short, calm line each and one question to think about. The same day, the same
// cards and theme. Pre-written text only (no AI), the 22 Major Arcana upright, nothing that predicts, diagnoses or sells; after the cards, on
// a person's 1st, 3rd and 5th day only, one soft line and the usual Book button. The words "Pranic Healing" and "healing" never appear here.
import type { D1Database } from "@cloudflare/workers-types";
import type { Copy, Lang } from "./copy";
import { menuOut } from "./menu";
import { normalize } from "./safety";
import type { Out } from "./send";
import { iso, istDay } from "./slots";

export type Theme = "WORK" | "RELATIONSHIPS" | "ENERGY";
export const THEMES: readonly Theme[] = ["WORK", "RELATIONSHIPS", "ENERGY"];
export const THEME_IDS: Record<string, Theme> = { card_work: "WORK", card_relationships: "RELATIONSHIPS", card_energy: "ENERGY" };
const THEME_ID = (t: Theme) => `card_${t.toLowerCase()}`;
export const isCardChoice = (id: string | null): id is string => id !== null && id in THEME_IDS;

// Only the bare word (or a short form of it): "credit card" or "my card was charged" is not this.
const CARD_WORDS = new Set(["card", "cards", "tarot", "tarot card", "tarot cards", "daily card", "daily cards", "my card", "my cards", "कार्ड", "कार्ड्स", "टैरो", "टैरो कार्ड"]);
export const isCardWord = (text: string): boolean => CARD_WORDS.has(normalize(text));

type Words = { name: string; line: string };
const THEME_EN: Record<Theme, { label: string; question: string }> = {
  WORK: { label: "Work", question: "What would make today's work feel lighter, even by a little?" },
  RELATIONSHIPS: { label: "Relationships", question: "What is one thing you want to say, or stop carrying, with someone close to you?" },
  ENERGY: { label: "Energy and calm", question: "Where in your day can you take five quiet minutes for yourself?" },
};
const THEME_HI: Record<Theme, { label: string; question: string }> = {
  WORK: { label: "काम", question: "आज काम को थोड़ा हल्का क्या बना सकता है?" },
  RELATIONSHIPS: { label: "रिश्ते", question: "किसी अपने से आप कौन सी एक बात कहना चाहते हैं, या कौन सा बोझ छोड़ना चाहते हैं?" },
  ENERGY: { label: "ऊर्जा और शांति", question: "दिन में कहाँ आप अपने लिए पाँच शांत मिनट निकाल सकते हैं?" },
};
const CARDS_EN: Words[] = [
  { name: "The Fool", line: "A fresh start. Try one small thing without knowing how it ends." },
  { name: "The Magician", line: "You already have more tools than you are using. Pick one." },
  { name: "The High Priestess", line: "Pause and listen. You may know more than you are admitting." },
  { name: "The Empress", line: "Care for yourself the way you care for others." },
  { name: "The Emperor", line: "Structure helps. Decide what is in and what is out today." },
  { name: "The Hierophant", line: "Lean on the advice and habits that have already worked for you." },
  { name: "The Lovers", line: "A choice that matches what you value, not what is expected." },
  { name: "The Chariot", line: "Steady effort beats rushing. Keep to one direction." },
  { name: "Strength", line: "Quiet patience is a form of strength. Be gentle and firm." },
  { name: "The Hermit", line: "Some quiet time alone will help you think clearly." },
  { name: "Wheel of Fortune", line: "Things move in cycles. This phase will shift." },
  { name: "Justice", line: "Be fair, to others and to yourself. Look at the facts." },
  { name: "The Hanged Man", line: "Try seeing it from a different side before you act." },
  { name: "Endings", line: "Something is finishing. Making room is part of moving on." },
  { name: "Temperance", line: "Aim for balance. Small, even steps." },
  { name: "Habits that Hold", line: "Notice a habit that keeps you stuck. Naming it is the first step." },
  { name: "Sudden Change", line: "Plans can shift. Stay flexible and rebuild step by step." },
  { name: "The Star", line: "Hope, in small doses. Rest, then carry on." },
  { name: "The Moon", line: "Things feel unclear. Try not to decide when tired or worried." },
  { name: "The Sun", line: "Something is going well. Notice it and enjoy it." },
  { name: "Judgement", line: "Look back honestly, forgive what you can, and begin again." },
  { name: "The World", line: "A chapter is complete. Take a moment to acknowledge it." },
];
const CARDS_HI: Words[] = [
  { name: "द फ़ूल", line: "एक नई शुरुआत। एक छोटी सी चीज़ आज़माइए, चाहे नतीजा पता न हो।" },
  { name: "द मैजिशियन", line: "आपके पास जितने साधन हैं, आप उनसे ज़्यादा इस्तेमाल कर सकते हैं। एक चुनिए।" },
  { name: "द हाई प्रीस्टेस", line: "रुकिए और सुनिए। शायद आप जितना मान रहे हैं, उससे ज़्यादा जानते हैं।" },
  { name: "द एम्प्रेस", line: "अपना ख़याल वैसे रखिए जैसे आप दूसरों का रखते हैं।" },
  { name: "द एम्परर", line: "व्यवस्था मदद करती है। तय कीजिए कि आज क्या अंदर है और क्या बाहर।" },
  { name: "द हायरोफ़ैंट", line: "उन सलाहों और आदतों पर भरोसा कीजिए जो पहले आपके काम आ चुकी हैं।" },
  { name: "द लवर्स", line: "ऐसा चुनाव जो आपके मूल्यों से मेल खाए, न कि दूसरों की उम्मीद से।" },
  { name: "द चैरियट", line: "जल्दबाज़ी से ज़्यादा काम आती है लगातार कोशिश। एक दिशा में बने रहिए।" },
  { name: "स्ट्रेंथ", line: "शांत धैर्य भी एक ताक़त है। नरम रहिए और दृढ़ भी।" },
  { name: "द हर्मिट", line: "थोड़ा अकेले, शांत समय सोचने में मदद करेगा।" },
  { name: "व्हील ऑफ़ फ़ॉर्च्यून", line: "चीज़ें चक्र में चलती हैं। यह दौर बदलेगा।" },
  { name: "जस्टिस", line: "दूसरों के साथ और अपने साथ भी निष्पक्ष रहिए। तथ्यों को देखिए।" },
  { name: "द हैंग्ड मैन", line: "कुछ करने से पहले उसे दूसरी तरफ़ से देखने की कोशिश कीजिए।" },
  { name: "अंत", line: "कुछ ख़त्म हो रहा है। जगह बनाना आगे बढ़ने का हिस्सा है।" },
  { name: "टेम्परेंस", line: "संतुलन की कोशिश कीजिए। छोटे, बराबर क़दम।" },
  { name: "जकड़ने वाली आदतें", line: "उस आदत को पहचानिए जो आपको अटकाए रखती है। नाम देना पहला क़दम है।" },
  { name: "अचानक बदलाव", line: "योजनाएँ बदल सकती हैं। लचीले रहिए और धीरे-धीरे फिर से बनाइए।" },
  { name: "द स्टार", line: "आशा, थोड़ी-थोड़ी मात्रा में। आराम कीजिए, फिर आगे बढ़िए।" },
  { name: "द मून", line: "सब कुछ धुंधला लगता है। थके या चिंतित हों तो फ़ैसला न लें।" },
  { name: "द सन", line: "कुछ अच्छा चल रहा है। उसे पहचानिए और उसका आनंद लीजिए।" },
  { name: "जजमेंट", line: "ईमानदारी से पीछे देखिए, जो माफ़ कर सकें माफ़ कीजिए, और फिर से शुरू कीजिए।" },
  { name: "द वर्ल्ड", line: "एक अध्याय पूरा हुआ। एक पल रुककर उसे स्वीकार कीजिए।" },
];
export const CARD_COUNT = CARDS_EN.length;

const TEXT = {
  en: {
    pick: "Three cards for a calm moment. Pick today's theme. You can choose one theme a day.",
    head: (theme: string) => `Your 3 cards for today: *${theme}*`,
    pos: ["Past", "Present", "Next step"],
    question: "Something to think about",
    footer: "A calm moment for reflection. Not a prediction or advice.",
    other: (theme: string) => `Today's theme is *${theme}*. Come back tomorrow for a new one.`,
    cta: "If you would like to talk it through with Shantha, a 15-minute phone call is ₹99.",
    paused: "Not today. If you like, tap Help, or Talk to a person.",
  },
  hi: {
    pick: "शांत पल के लिए तीन कार्ड। आज की थीम चुनिए। एक दिन में एक ही थीम चुनी जा सकती है।",
    head: (theme: string) => `आज के आपके 3 कार्ड: *${theme}*`,
    pos: ["बीता कल", "आज", "अगला क़दम"],
    question: "सोचने के लिए",
    footer: "यह सोच-विचार का एक शांत पल है। भविष्यवाणी या सलाह नहीं।",
    other: (theme: string) => `आज की थीम *${theme}* है। नई थीम के लिए कल आइए।`,
    cta: "अगर आप शांता जी से इस पर बात करना चाहें, तो 15 मिनट की फ़ोन कॉल ₹99 की है।",
    paused: "आज नहीं। चाहें तो मदद या किसी व्यक्ति से बात करें दबाइए।",
  },
} as const;

// A whole number from 0 to max-1 from the platform's secure random, without modulo bias.
export function secureInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}
export function pickThree(rng: (max: number) => number = secureInt): [number, number, number] {
  const out: number[] = [];
  while (out.length < 3) {
    const n = rng(CARD_COUNT);
    if (!out.includes(n)) out.push(n);
  }
  return out as [number, number, number];
}

export function drawText(lang: Lang, theme: Theme, cards: readonly number[]): string {
  const t = TEXT[lang];
  const names = lang === "hi" ? CARDS_HI : CARDS_EN;
  const th = (lang === "hi" ? THEME_HI : THEME_EN)[theme];
  const lines = cards.map((c, i) => `*${t.pos[i]}:* ${names[c].name}. ${names[c].line}`);
  return `${t.head(th.label)}\n\n${lines.join("\n\n")}\n\n${t.question}: ${th.question}\n\n_${t.footer}_`;
}

type Row = { theme: Theme; c1: number; c2: number; c3: number };

// What to send for a CARD message or a theme tap. `theme` is null for the word CARD. Safe to call twice: one draw per person per IST day.
export async function cardReply(db: D1Database, convId: number, lang: Lang, theme: Theme | null, noSell: boolean, cp: Copy, nowMs = Date.now(), rng: (max: number) => number = secureInt): Promise<Out> {
  const t = TEXT[lang];
  const labels = lang === "hi" ? THEME_HI : THEME_EN;
  // After a crisis message nothing is offered for 7 days; no cards either, only Help and Talk to a person.
  if (noSell) return menuOut(cp, true, t.paused);
  const day = istDay(nowMs);
  const today = await db.prepare("SELECT theme, c1, c2, c3 FROM card_draws WHERE conversation_id = ?1 AND day = ?2").bind(convId, day).first<Row>();
  if (today) {
    if (theme && theme !== today.theme) return { type: "text", text: t.other(labels[today.theme].label) };
    return { type: "text", text: drawText(lang, today.theme, [today.c1, today.c2, today.c3]) };
  }
  if (!theme) {
    return { type: "buttons", body: t.pick, buttons: THEMES.map((th) => ({ id: THEME_ID(th), title: labels[th].label })) };
  }
  const [a, b, c] = pickThree(rng);
  await db.prepare("INSERT OR IGNORE INTO card_draws (conversation_id, day, theme, c1, c2, c3, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(convId, day, theme, a, b, c, iso(nowMs)).run();
  // A second tap in the same moment may have won: whatever is stored is the draw.
  const row = await db.prepare("SELECT theme, c1, c2, c3 FROM card_draws WHERE conversation_id = ?1 AND day = ?2").bind(convId, day).first<Row>();
  if (!row) return { type: "text", text: t.paused };
  if (row.theme !== theme) return { type: "text", text: t.other(labels[row.theme].label) };
  const body = drawText(lang, row.theme, [row.c1, row.c2, row.c3]);
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM card_draws WHERE conversation_id = ?1").bind(convId).first<{ n: number }>())?.n ?? 0;
  // One soft line, on a person's 1st, 3rd and 5th day of using it; never every time.
  if (n === 1 || n === 3 || n === 5) return { type: "buttons", body: `${body}\n\n${t.cta}`, buttons: [{ id: "menu_book", title: cp.btnBook }] };
  return { type: "text", text: body };
}

export type CardStats = { people: number; repeat3: number; paidCalls: number; paidCallsAll: number };
// The test's numbers since `sinceIso` (never a name or number): people who tried CARD, people who used it on 3+ days, paid ₹99 calls from those
// people, and all paid ₹99 calls in the same time for the baseline. A call counts when its state moved on from HELD (paid and after).
export async function cardStats(db: D1Database, sinceIso: string): Promise<CardStats> {
  const paid = "state IN ('PAID', 'CALLED_SESSION', 'CALLED_NOT_FIT', 'MISSED', 'RESCHEDULED')";
  const one = async (sql: string) => (await db.prepare(sql).bind(sinceIso).first<{ n: number }>())?.n ?? 0;
  return {
    people: await one("SELECT COUNT(DISTINCT conversation_id) AS n FROM card_draws WHERE created_at >= ?1"),
    repeat3: await one("SELECT COUNT(*) AS n FROM (SELECT conversation_id FROM card_draws WHERE created_at >= ?1 GROUP BY conversation_id HAVING COUNT(*) >= 3)"),
    paidCalls: await one(`SELECT COUNT(DISTINCT i.conversation_id) AS n FROM intros i WHERE i.${paid} AND i.created_at >= ?1 AND i.conversation_id IN (SELECT conversation_id FROM card_draws WHERE created_at >= ?1)`),
    paidCallsAll: await one(`SELECT COUNT(*) AS n FROM intros i WHERE i.${paid} AND i.created_at >= ?1`),
  };
}
