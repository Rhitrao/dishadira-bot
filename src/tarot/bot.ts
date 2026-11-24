// Ticket 57: the chat side of the tarot game. With TAROT_GAME "true", a person who sends the bare word TAROT (or a short form of it) gets
// one message with an "Open your cards" button. The button's link logs them in once, within 15 minutes (src/tarot/store.ts). It is a reply
// to their own message, so it is a free service message inside the 24-hour window, never sent unprompted. CARD stays the CARD test.
import type { D1Database } from "@cloudflare/workers-types";
import type { Lang } from "../copy";
import type { Env } from "../env";
import { normalize } from "../safety";
import type { Out } from "../send";
import { newLoginLink } from "./store";

const TAROT_WORDS = new Set(["tarot", "tarot game", "tarot card", "tarot cards", "open my cards", "open your cards", "टैरो", "टैरो कार्ड", "टैरो गेम"]);
export const isTarotWord = (text: string): boolean => TAROT_WORDS.has(normalize(text));
export const tarotGameOn = (env: Env) => env.TAROT_GAME === "true";

const BODY: Record<Lang, string> = {
  en: "Your daily tarot is ready: one calm reading a day, with Shantha Rao.\n\nThe button opens your private page. The link works once, for 15 minutes; send TAROT again any time for a new one.\n\nA reflection tool for calm moments. Not advice or prediction.",
  hi: "आपका रोज़ का टैरो तैयार है: हर दिन एक शांत रीडिंग, शांता राव जी के साथ।\n\nबटन आपका निजी पेज खोलता है। लिंक एक बार, 15 मिनट तक चलता है; नया लिंक पाने के लिए कभी भी फिर से TAROT भेजिए।\n\nशांत पलों के लिए एक चिंतन का साधन। यह सलाह या भविष्यवाणी नहीं है।",
};
const LABEL: Record<Lang, string> = { en: "Open your cards", hi: "अपने कार्ड खोलें" };

// The button message, or null when the Worker has no public address to link to (PUBLIC_URL unset): the word then goes the usual way.
export async function tarotOut(env: Env, db: D1Database, convId: number, lang: Lang, nowMs = Date.now()): Promise<Out | null> {
  const base = (env.PUBLIC_URL ?? "").trim();
  if (!/^https:\/\//.test(base)) return null;
  return { type: "cta", body: BODY[lang], label: LABEL[lang], url: await newLoginLink(db, convId, base, nowMs) };
}
