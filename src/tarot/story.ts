// Ticket 59: "What this means for you": a finished reading explained in plain, warm words, answering the person's own question, and read
// aloud in a calm female voice.
// The words: with TAROT_AI "true" and the Anthropic key set, the assistant (config.ai.model) writes them once from the card library's own
// lines (src/tarot/deck.ts), the spread's positions and the question; they are checked and kept in tarot_readings.story, so the reading says
// the same thing every time. It may only explain the cards it is given: never predict health, death, pregnancy, exams, court or money, never
// speak of spells, never promise. If the assistant is off, over the day's cap, fails, or writes anything that trips those checks, the page
// shows plainStory(): the same explanation built by rules from the same library lines (not stored).
// The voice: with TAROT_VOICE "true" and the Workers AI binding, Deepgram Aura 2 on Workers AI reads the words (config below); the MP3 is
// cached at the edge for a day. Otherwise the page reads them with the phone's own voice.
import type { D1Database } from "@cloudflare/workers-types";
import { postToModel, toolInput, usageUsd } from "../ai";
import type { Env } from "../env";
import { detectSafety, botAudit } from "../safety";
import { dayStartUtc, istDay } from "../slots";
import { BY_ID } from "./deck";
import { personalLines, type Insights } from "./profile";
import { SPREADS, summarize, THEMES, type Drawn } from "./reading";
import type { JournalEntry } from "./store";

export const STORY = {
  maxChars: 1400,
  perDayTotal: 300, // assistant-written explanations across everyone, per IST day
  maxTokens: 900,
  voiceModel: "@cf/deepgram/aura-2-en",
  voice: "cora", // Aura 2: "smooth, melodic, caring"; others to try: "luna", "athena", "helena"
};

// Words the explanation must never contain, whoever wrote it: predictions of the things we do not read for, and fear.
const FORBIDDEN = /\b(you will die|death of|will die|cancer|pregnan\w*|miscarriage|divorce will|lottery|jackpot|guarantee\w*|definitely will|curse\w*|black magic|evil eye|jadu|jadoo)\b/i;
export const storyIsSafe = (text: string) => text.length >= 80 && text.length <= STORY.maxChars + 200 && !FORBIDDEN.test(text) && detectSafety(text) === null;

const upright = (d: Drawn) => (d.r ? "upside down" : "upright");

// The rule-built explanation: plain words from the same library, in the same order a reader would speak.
// (The "For you" lines are shown in their own box under it, so they are not repeated here.)
export function plainStory(e: JournalEntry, _ins: Insights | null, _past: Drawn[]): string {
  const s = SPREADS[e.spread];
  const parts: string[] = [];
  if (e.kind === "daily") parts.push("Here is your card for today, in simple words.");
  else parts.push(`You asked: "${e.question}". Here is what your cards are saying, in simple words.`);
  e.cards.forEach((d, i) => {
    const c = BY_ID.get(d.id)!;
    const lead = e.kind === "daily" ? `${c.name}${d.r ? ", upside down" : ""}.` : `${s.positions[i].frame}: ${c.name}${d.r ? ", upside down" : ""}.`;
    const theme = e.theme ? ` For you: ${c[e.theme].charAt(0).toLowerCase()}${c[e.theme].slice(1)}` : "";
    parts.push(`${lead} ${d.r ? c.reversed : c.meaning}${theme}`);
  });
  const sum = summarize(e.cards)[0];
  if (e.cards.length > 1 && sum) parts.push(`Taken together: ${sum.charAt(0).toLowerCase()}${sum.slice(1)}`);
  parts.push(`Something to sit with: ${BY_ID.get(e.cards[e.cards.length - 1].id)!.ask}`);
  return parts.join("\n\n");
}

const SYSTEM = `You are the gentle voice of Disha Dira Tarot, a reflection tool offered with Shantha Rao, an energy healer in Bengaluru.
Explain one finished tarot reading to a person who knows nothing about tarot, so that they truly understand what it says about THEIR question.
Rules:
- Use only the card meanings given below. Do not add other tarot lore, astrology, or anything you were not given.
- Speak to them as "you", warmly and simply: short sentences, everyday words, like a kind elder sister. No jargon: never say "Major Arcana", "suit", "court card", "reversed" or "spread". If a card is upside down, say "upside down" and what that means in plain words.
- Answer their question directly first, in one or two sentences. Then walk through each card in its place, one or two sentences each, saying how it touches their question. Then give two or three small, practical, kind suggestions. End with one gentle question for them to think about.
- This is reflection, never prediction. Never say what will happen. Never speak of health, illness, death, pregnancy, exams, court cases, money won or lost, or what another person secretly thinks or feels. Never mention spells, curses, black magic or the evil eye. Never promise anything. Never frighten.
- 120 to 220 words. Plain text only: no headings, no lists, no bullet points, no emoji. It will also be read aloud.`;

const TOOL = {
  name: "write_explanation",
  description: "The plain-words explanation of the reading.",
  input_schema: { type: "object", properties: { text: { type: "string", description: "120 to 220 words, plain text, paragraphs separated by a blank line." } }, required: ["text"] },
};

function readingFacts(e: JournalEntry, ins: Insights | null, past: Drawn[]): string {
  const s = SPREADS[e.spread];
  const lines = [
    e.kind === "daily" ? "This is their card for the day (no question)." : `Their question: ${e.question}`,
    e.theme ? `Theme: ${THEMES[e.theme].label}` : "",
    `Layout: ${s.label}`,
    "",
    "The cards, in order:",
    ...e.cards.map((d, i) => {
      const c = BY_ID.get(d.id)!;
      return [
        `${i + 1}. Place: ${s.positions[i].name} (${s.positions[i].frame})`,
        `   Card: ${c.name}, ${upright(d)}`,
        `   Meaning: ${d.r ? c.reversed : c.meaning} Keywords: ${(d.r ? c.rev : c.up).join(", ")}.`,
        e.theme ? `   For this theme: ${c[e.theme]}` : "",
        `   A question it asks: ${c.ask}`,
      ].filter(Boolean).join("\n");
    }),
    "",
    "What the cards say together:",
    ...summarize(e.cards).map((l) => `- ${l}`),
    ...(ins ? ["", "About this person (you may weave in one of these, lightly):", ...personalLines(e.cards, ins, past).map((l) => `- ${l}`)] : []),
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

async function aiStoriesToday(db: D1Database, nowMs: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'TAROT_STORY' AND at >= ?1").bind(dayStartUtc(istDay(nowMs))).first<{ n: number }>();
  return r?.n ?? 0;
}

export const tarotAiOn = (env: Env) => env.TAROT_AI === "true";

// The kept explanation, or a new one from the assistant (kept), or null: the caller then shows plainStory().
export async function aiStory(env: Env, db: D1Database, convId: number, e: JournalEntry & { story?: string | null }, ins: Insights | null, past: Drawn[], nowMs = Date.now()): Promise<string | null> {
  if (e.story) return e.story;
  if (!tarotAiOn(env) || !env.ANTHROPIC_API_KEY) return null;
  if ((await aiStoriesToday(db, nowMs)) >= STORY.perDayTotal) return null;
  const r = await postToModel(
    env.ANTHROPIC_API_KEY,
    {
      system: SYSTEM,
      messages: [{ role: "user", content: readingFacts(e, ins, past) }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
    },
    STORY.maxTokens,
  );
  if (!r.ok) {
    await botAudit(db, "TAROT_STORY_FAILED", `conv:${convId}`, r.code);
    return null;
  }
  const text = (toolInput(r.body, TOOL.name) as { text?: unknown } | undefined)?.text;
  await botAudit(db, "TAROT_STORY", `conv:${convId}`, `in ${r.usage.input} out ${r.usage.output} usd ${usageUsd(r.usage).toFixed(6)}`);
  if (typeof text !== "string") return null;
  const clean = text.replace(/\r/g, "").replace(/[*#_`]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!storyIsSafe(clean)) {
    await botAudit(db, "TAROT_STORY_REJECTED", `conv:${convId}`, "failed the safety check");
    return null;
  }
  await db.prepare("UPDATE tarot_readings SET story = ?3 WHERE id = ?1 AND conversation_id = ?2").bind(e.id, convId, clean.slice(0, 2000)).run();
  return clean;
}

// ---------- the voice ----------
export type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
export const tarotVoiceOn = (env: Env) => env.TAROT_VOICE === "true" && !!env.AI;

// What Workers AI hands back for a text-to-speech model, as bytes: a stream, raw bytes, or { audio: base64 }.
export async function audioBytes(out: unknown): Promise<Uint8Array | null> {
  if (out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out instanceof Uint8Array) return out;
  const b64 = (out as { audio?: unknown } | null)?.audio;
  if (typeof b64 === "string") return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return null;
}

// Text as it should be spoken: no quotation marks read out, pauses at paragraph breaks.
export const speakable = (text: string) => text.replace(/["“”]/g, "").replace(/\n\n+/g, " … ").replace(/\s+/g, " ").trim().slice(0, 1900);

export async function voiceMp3(env: Env, text: string): Promise<Uint8Array | null> {
  if (!tarotVoiceOn(env)) return null;
  try {
    return await audioBytes(await (env.AI as AiBinding).run(STORY.voiceModel, { text: speakable(text), speaker: STORY.voice, encoding: "mp3" }));
  } catch {
    return null;
  }
}
