// Ticket 57: the draw and the reading. The deck is shuffled on the server with a Fisher–Yates shuffle fed by the Worker's secure random
// numbers; each card lands reversed with a 1 in 2 chance. The person cuts the deck and picks cards from a fan of the top 22: the fan IS the
// shuffled deck in order, so the card picked is the card drawn. A reading's summary comes from fixed rules (no AI), so the same cards always
// read the same way and every sentence can be traced to a rule.
import { BY_ID, type Card, DECK, isCourt, type Suit } from "./deck";

export type Drawn = { id: string; r: boolean }; // r: reversed
export type ThemeId = "love" | "work" | "self";
export type SpreadId = "daily" | "ppf";

export const FAN = 22; // face-down cards shown to pick from
export const CUT_PILES = 3;

export const THEMES: Record<ThemeId, { label: string; blurb: string; questions: string[] }> = {
  love: {
    label: "Love and relationships",
    blurb: "Partners, family, friends: the people close to you",
    questions: [
      "What do I need to see about this relationship?",
      "How can I bring more warmth into my closest bond?",
      "What is keeping me from feeling loved?",
      "What do I need to say, or stop carrying, with someone close to me?",
      "How can I be a better friend to the people I care about?",
      "What am I learning about love right now?",
    ],
  },
  work: {
    label: "Career and work",
    blurb: "Your job, your craft, your next step",
    questions: [
      "What should I focus on at work this month?",
      "What is holding back my progress?",
      "How can I make my work feel more meaningful?",
      "What do I need to know before a big work decision?",
      "Where am I spending energy that is not paying back?",
      "What strength of mine is underused at work?",
    ],
  },
  self: {
    label: "Self and inner calm",
    blurb: "Your feelings, energy and inner life",
    questions: [
      "What am I carrying that I can put down?",
      "What helps me feel steady and whole?",
      "What is my lesson right now?",
      "Where am I being too hard on myself?",
      "What does my heart need today?",
      "What would bring me more peace this week?",
    ],
  },
};

export const SPREADS: Record<SpreadId, { label: string; positions: { name: string; frame: string }[] }> = {
  daily: { label: "Today's card", positions: [{ name: "Today", frame: "A message to carry through today" }] },
  ppf: {
    label: "Past, present, future",
    positions: [
      { name: "Past", frame: "Where you have been: what shaped this" },
      { name: "Present", frame: "Where you stand now" },
      { name: "Future", frame: "Where it is heading if you keep on as you are" },
    ],
  },
};

export const isTheme = (t: unknown): t is ThemeId => typeof t === "string" && t in THEMES;
export const isSpread = (s: unknown): s is SpreadId => typeof s === "string" && s in SPREADS;

// A uniform integer in [0, n) from secure random bytes, without modulo bias (rejection sampling).
export function secureBelow(n: number, rand: (buf: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    const x = rand(buf)[0];
    if (x < limit) return x % n;
  }
}

// A full shuffled deck: Fisher–Yates over the 78 ids, then a fair coin for each card's reversal.
export function shuffledDeck(below: (n: number) => number = (n) => secureBelow(n), reversals = true): Drawn[] {
  const ids = DECK.map((c) => c.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.map((id) => ({ id, r: reversals ? below(2) === 1 : false }));
}

// The cut: the deck is split into three piles and the chosen pile goes on top, as a reader would do on a table.
export function cutDeck(deck: Drawn[], pile: number): Drawn[] {
  const size = Math.ceil(deck.length / CUT_PILES);
  const p = Math.max(0, Math.min(CUT_PILES - 1, Math.floor(pile)));
  const start = p * size;
  return [...deck.slice(start, start + size), ...deck.slice(0, start), ...deck.slice(start + size)];
}

// Picks are fan positions (0…FAN-1), distinct, one per spread position. Returns null when they are not.
export function pickCards(deck: Drawn[], picks: unknown, count: number): Drawn[] | null {
  if (!Array.isArray(picks) || picks.length !== count) return null;
  if (!picks.every((p) => Number.isInteger(p) && p >= 0 && p < FAN)) return null;
  if (new Set(picks).size !== picks.length) return null;
  return picks.map((p: number) => deck[p]);
}

const ELEMENT: Record<Suit, "fire" | "water" | "air" | "earth"> = { wands: "fire", cups: "water", swords: "air", pentacles: "earth" };
const SUIT_LINE: Record<Suit, string> = {
  wands: "Wands lead this reading: drive, ambition and the will to act are at the centre.",
  cups: "Cups lead this reading: feelings and relationships are at the centre.",
  swords: "Swords lead this reading: thoughts, words and decisions are at the centre, and perhaps some conflict.",
  pentacles: "Pentacles lead this reading: practical matters such as work, money, home and the body are at the centre.",
};
const RANK_LINE: Record<number, string> = {
  1: "Repeated Aces: new beginnings are gathering.",
  2: "Repeated Twos: balance, partnership and a choice between two things.",
  3: "Repeated Threes: growth and working with others.",
  4: "Repeated Fours: stability, rest or holding on.",
  5: "Repeated Fives: change and friction that can lead to growth.",
  6: "Repeated Sixes: harmony, giving and receiving.",
  7: "Repeated Sevens: a time to reflect and assess.",
  8: "Repeated Eights: movement and steady mastery.",
  9: "Repeated Nines: you are near the end of something.",
  10: "Repeated Tens: a cycle completing.",
  11: "Repeated Pages: messages, learning and fresh curiosity.",
  12: "Repeated Knights: movement, action and things speeding up.",
  13: "Repeated Queens: care, nurture and inner wisdom.",
  14: "Repeated Kings: leadership and taking charge.",
};

const card = (d: Drawn): Card => {
  const c = BY_ID.get(d.id);
  if (!c) throw new Error(`unknown card ${d.id}`);
  return c;
};

// The reading's summary: a few lines from fixed rules, most telling first. A one-card draw gets its own short line.
export function summarize(drawn: Drawn[]): string[] {
  const cards = drawn.map(card);
  if (cards.length === 1) {
    const c = cards[0];
    return [drawn[0].r ? `${c.name}, reversed, asks you to look at what is blocked: ${c.rev[0]}.` : `${c.name} brings ${c.up[0]} into your day.`];
  }
  const lines: string[] = [];
  const majors = cards.filter((c) => c.suit === null).length;
  if (majors >= Math.ceil(cards.length * 0.6)) lines.push("Mostly Major Arcana: this touches big life themes, not just daily details. Take it seriously and slowly.");
  else if (majors === 0) lines.push("No Major Arcana: this is about everyday choices that are in your hands.");
  const suits = new Map<Suit, number>();
  for (const c of cards) if (c.suit) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  const top = [...suits.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) lines.push(SUIT_LINE[top[0]]);
  const ranks = new Map<number, number>();
  for (const c of cards) if (c.suit) ranks.set(c.rank, (ranks.get(c.rank) ?? 0) + 1);
  for (const [rank, n] of ranks) if (n >= 2 && RANK_LINE[rank]) lines.push(RANK_LINE[rank]);
  const reversed = drawn.filter((d) => d.r).length;
  if (reversed > cards.length / 2) lines.push("Most cards are reversed: energy is turned inward or blocked. Look at what is holding you back before pushing forward.");
  if (cards.some(isCourt)) lines.push("A court card appears: a person, or a side of you, plays a part here.");
  for (let i = 0; i + 1 < cards.length; i++) {
    const a = cards[i].suit, b = cards[i + 1].suit;
    if (!a || !b || a === b) continue;
    const pair = [ELEMENT[a], ELEMENT[b]].sort().join("+");
    if (pair === "fire+water" || pair === "air+earth") {
      lines.push(`${cards[i].name} and ${cards[i + 1].name} pull against each other: ${pair === "fire+water" ? "drive and feeling" : "ideas and practical limits"} need to be balanced.`);
      break;
    }
    if (pair === "air+fire" || pair === "earth+water") {
      lines.push(`${cards[i].name} and ${cards[i + 1].name} support each other: ${pair === "air+fire" ? "ideas feed action" : "feeling and practical care work together"}.`);
      break;
    }
  }
  if (lines.length === 0) lines.push("Read the cards in order: where you have been, where you stand, and where things are heading.");
  return lines.slice(0, 4);
}

// What the page shows for one drawn card in one position.
export function cardView(d: Drawn, theme: ThemeId | null) {
  const c = card(d);
  return {
    id: c.id,
    name: c.name,
    reversed: d.r,
    keywords: d.r ? c.rev : c.up,
    meaning: d.r ? c.reversed : c.meaning,
    theme: theme ? c[theme] : null,
    ask: c.ask,
    major: c.suit === null,
  };
}
