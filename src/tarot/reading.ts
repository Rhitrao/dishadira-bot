// Ticket 57: the draw and the reading. The deck is shuffled on the server with a Fisher–Yates shuffle fed by the Worker's secure random
// numbers; each card lands reversed with a 1 in 2 chance. The person cuts the deck and picks cards from a fan of the top 22: the fan IS the
// shuffled deck in order, so the card picked is the card drawn. A reading's summary comes from fixed rules (no AI), so the same cards always
// read the same way and every sentence can be traced to a rule.
import { BY_ID, type Card, DECK, isCourt, type Suit } from "./deck";

export type Drawn = { id: string; r: boolean }; // r: reversed
export type ThemeId = "love" | "work" | "self";

export const FAN = 22; // face-down cards shown to pick from
export const CUT_PILES = 3;

// Ticket 58: each spread's positions with where they sit on the table (x, y in card widths and heights; cross: laid across the card under it).
type Position = { name: string; frame: string; x: number; y: number; cross?: true };
type Spread = { label: string; blurb: string; positions: Position[] };
const row = (items: [string, string][]): Position[] => items.map(([name, frame], i) => ({ name, frame, x: i, y: 0 }));

export const SPREADS = {
  daily: { label: "Today's card", blurb: "One card to carry through the day", positions: [{ name: "Today", frame: "A message to carry through today", x: 0, y: 0 }] },
  ppf: {
    label: "Past, present, future", blurb: "Three cards: how you got here, where you are, where it is heading",
    positions: row([["Past", "Where you have been: what shaped this"], ["Present", "Where you stand now"], ["Future", "Where it is heading if you keep on as you are"]]),
  },
  sao: {
    label: "Situation, action, outcome", blurb: "Three cards for a practical question",
    positions: row([["Situation", "What is really going on"], ["Action", "What you can do"], ["Outcome", "Where that action leads"]]),
  },
  love_bond: {
    label: "Two hearts", blurb: "Five cards for a relationship: you, them, and what is between you",
    positions: [
      { name: "You", frame: "What you bring and feel", x: 0, y: 0 }, { name: "The bond", frame: "What lives between you", x: 1, y: 0 },
      { name: "Them", frame: "What they bring and feel, as far as you can see it", x: 2, y: 0 },
      { name: "What helps", frame: "What strengthens the bond", x: 0.5, y: 1 }, { name: "What blocks", frame: "What stands in the way", x: 1.5, y: 1 },
    ],
  },
  love_open: {
    label: "Opening to love", blurb: "Four cards for finding or deepening love",
    positions: [
      { name: "What I bring", frame: "The love you have to give", x: 0, y: 0 }, { name: "What I seek", frame: "What your heart is looking for", x: 1, y: 0 },
      { name: "What holds me back", frame: "The fear or habit in the way", x: 2, y: 0 }, { name: "Next step", frame: "One step towards love", x: 1, y: 1 },
    ],
  },
  // Ticket 61: the two love readings people ask for most, framed as what the cards suggest, never as a certainty about another person or a
  // prediction of events.
  love_heart: {
    label: "Their heart", blurb: "Four cards on how things may feel from their side, as the cards suggest it",
    positions: [
      { name: "Their feelings", frame: "The feelings the cards suggest around them now: a possibility, not a certainty", x: 0, y: 0 },
      { name: "Their intention", frame: "What they may be hoping for with you, as the cards suggest it", x: 1, y: 0 },
      { name: "Their message", frame: "What their side of the bond may be asking you to hear", x: 2, y: 0 },
      { name: "Your heart", frame: "What you can do with this, from your side", x: 1, y: 1 },
    ],
  },
  love_months: {
    label: "The next three months", blurb: "Five cards: where you two stand, the energy of each coming month, and your part in it",
    positions: [
      { name: "Between you now", frame: "Where the two of you stand today", x: 0, y: 0 },
      { name: "Month one", frame: "The energy to work with in the first month", x: 1, y: 0 },
      { name: "Month two", frame: "The energy to work with in the second month", x: 2, y: 0 },
      { name: "Month three", frame: "The energy to work with in the third month", x: 3, y: 0 },
      { name: "Your part", frame: "What you can bring that shapes what comes", x: 1.5, y: 1 },
    ],
  },
  love_heal: {
    label: "Healing a hurt", blurb: "Three cards for a painful time with someone",
    positions: row([["The hurt", "What is hurting"], ["The lesson", "What it is teaching you"], ["The way forward", "How to move on gently"]]),
  },
  work_path: {
    label: "Career path", blurb: "Five cards from where you are to where it leads",
    positions: [
      { name: "Where I am", frame: "Your work life now", x: 0, y: 1 }, { name: "My strengths", frame: "What you can lean on", x: 1, y: 0 },
      { name: "The hurdle", frame: "What stands in the way", x: 2, y: 1 }, { name: "Next step", frame: "The step in front of you", x: 3, y: 0 },
      { name: "Where it leads", frame: "Where this path is heading", x: 4, y: 1 },
    ],
  },
  work_cross: {
    label: "Crossroads", blurb: "Five cards for a choice between two paths",
    positions: [
      { name: "What A asks", frame: "What path A will ask of you", x: 0, y: 0 }, { name: "What B asks", frame: "What path B will ask of you", x: 2, y: 0 },
      { name: "Path A", frame: "The first choice", x: 0, y: 1 }, { name: "Path B", frame: "The second choice", x: 2, y: 1 },
      { name: "You now", frame: "Where you stand as you choose", x: 1, y: 2 },
    ],
  },
  self_mbs: {
    label: "Mind, body, spirit", blurb: "Three cards for how you are, inside and out",
    positions: [
      { name: "Spirit", frame: "Your inner self", x: 1, y: 0 }, { name: "Mind", frame: "Your thoughts and feelings", x: 0, y: 1 },
      { name: "Body", frame: "Your energy and body", x: 2, y: 1 },
    ],
  },
  self_heal: {
    label: "Inner healing", blurb: "Four cards to release and renew",
    positions: [
      { name: "What I carry", frame: "What weighs on you", x: 0, y: 0 }, { name: "What it teaches", frame: "The lesson inside it", x: 1, y: 0 },
      { name: "What to release", frame: "What you can put down", x: 0, y: 1 }, { name: "What to welcome", frame: "What can come in its place", x: 1, y: 1 },
    ],
  },
  celtic: {
    label: "Celtic Cross", blurb: "The classic ten-card reading, for a big question",
    positions: [
      { name: "The heart of it", frame: "The present situation", x: 1, y: 1 }, { name: "The challenge", frame: "What crosses you", x: 1, y: 1, cross: true },
      { name: "The root", frame: "What lies beneath", x: 1, y: 2 }, { name: "The recent past", frame: "What is passing", x: 0, y: 1 },
      { name: "What you aim for", frame: "Your hope or goal", x: 1, y: 0 }, { name: "Near future", frame: "What is coming next", x: 2, y: 1 },
      { name: "You", frame: "How you meet this", x: 3.3, y: 3 }, { name: "Around you", frame: "People and surroundings", x: 3.3, y: 2 },
      { name: "Hopes and fears", frame: "What you hope, and fear", x: 3.3, y: 1 }, { name: "Where it leads", frame: "Where it is heading if you keep on as you are", x: 3.3, y: 0 },
    ],
  },
} satisfies Record<string, Spread>;
export type SpreadId = keyof typeof SPREADS;

export const THEMES: Record<ThemeId, { label: string; blurb: string; spreads: SpreadId[]; questions: string[] }> = {
  love: {
    label: "Love and relationships",
    blurb: "Partners, family, friends: the people close to you",
    spreads: ["love_heart", "love_months", "ppf", "love_bond", "love_open", "love_heal", "celtic"],
    questions: [
      "What might my partner be feeling about me right now?",
      "What might my partner's intention be with me?",
      "What message might my partner's heart hold for me?",
      "What energy surrounds us over the next one to three months?",
      "Where is this relationship heading if we keep on as we are?",
      "What do I need to see about this relationship?",
      "What is keeping me from feeling loved?",
      "How can I bring more warmth into my closest bond?",
    ],
  },
  work: {
    label: "Career and work",
    blurb: "Your job, your craft, your next step",
    spreads: ["ppf", "sao", "work_path", "work_cross", "celtic"],
    questions: [
      "What energy surrounds my career over the next three months?",
      "What should I focus on at work this month?",
      "How do the people at work see me right now?",
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
    spreads: ["ppf", "self_mbs", "self_heal", "sao", "celtic"],
    questions: [
      "What is my soul asking of me right now?",
      "What am I carrying that I can put down?",
      "What do I need to forgive myself for?",
      "What helps me feel steady and whole?",
      "What is my lesson right now?",
      "Where am I being too hard on myself?",
      "What does my heart need today?",
      "What would bring me more peace this week?",
    ],
  },
};

export const isTheme = (t: unknown): t is ThemeId => typeof t === "string" && Object.hasOwn(THEMES, t);
export const isSpread = (s: unknown): s is SpreadId => typeof s === "string" && Object.hasOwn(SPREADS, s);
export const spreadFits = (theme: ThemeId, s: SpreadId) => THEMES[theme].spreads.includes(s);

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
  wands: "Most of your cards are about energy and action: this is about what you want to do and how much drive you have.",
  cups: "Most of your cards are about feelings and relationships: this is really about the heart.",
  swords: "Most of your cards are about thoughts and words: what you are thinking, saying and deciding, and maybe some tension.",
  pentacles: "Most of your cards are about practical life: work, money, home and health. Small practical steps matter here.",
};
const RANK_LINE: Record<number, string> = {
  1: "The number one comes up more than once: something new is starting.",
  2: "The number two comes up more than once: this is about balance, a partnership, or choosing between two things.",
  3: "The number three comes up more than once: things are growing, often with the help of others.",
  4: "The number four comes up more than once: you need steadiness, rest, or to stop holding on so tightly.",
  5: "The number five comes up more than once: there is some upheaval, and it can help you grow.",
  6: "The number six comes up more than once: this is about harmony, giving and receiving.",
  7: "The number seven comes up more than once: it is a time to pause and think things over.",
  8: "The number eight comes up more than once: things are moving, and steady effort pays off.",
  9: "The number nine comes up more than once: you are close to the end of something.",
  10: "The number ten comes up more than once: one chapter is finishing.",
  11: "More than one young 'page' card: news, learning or a fresh start is in the air.",
  12: "More than one 'knight' card: things are speeding up and asking for action.",
  13: "More than one 'queen' card: care, kindness and quiet wisdom are needed.",
  14: "More than one 'king' card: someone needs to take charge, perhaps you.",
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
    return [drawn[0].r ? `${c.name} came out upside down. That usually means something is held back: watch for ${c.rev[0]} today.` : `${c.name} brings ${c.up[0]} into your day.`];
  }
  const lines: string[] = [];
  const majors = cards.filter((c) => c.suit === null).length;
  if (majors >= Math.ceil(cards.length * 0.6)) lines.push("Many of your cards are the deck's big 'life lesson' cards: this is about something important in your life, so take it slowly.");
  else if (majors === 0) lines.push("All your cards are everyday cards: this is about choices that are in your own hands.");
  const suits = new Map<Suit, number>();
  for (const c of cards) if (c.suit) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  const top = [...suits.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) lines.push(SUIT_LINE[top[0]]);
  const ranks = new Map<number, number>();
  for (const c of cards) if (c.suit) ranks.set(c.rank, (ranks.get(c.rank) ?? 0) + 1);
  for (const [rank, n] of ranks) if (n >= 2 && RANK_LINE[rank]) lines.push(RANK_LINE[rank]);
  const reversed = drawn.filter((d) => d.r).length;
  if (reversed > cards.length / 2) lines.push("Most cards came out upside down: something feels stuck or held back inside. Look at what is holding you back before you push forward.");
  if (cards.some(isCourt)) lines.push("One of the 'people' cards came up: someone in your life, or a side of you, plays a part in this.");
  for (let i = 0; i + 1 < cards.length; i++) {
    const a = cards[i].suit, b = cards[i + 1].suit;
    if (!a || !b || a === b) continue;
    const pair = [ELEMENT[a], ELEMENT[b]].sort().join("+");
    if (pair === "fire+water" || pair === "air+earth") {
      lines.push(`${cards[i].name} and ${cards[i + 1].name} pull in different directions: ${pair === "fire+water" ? "what you want to do and how you feel" : "your ideas and what is practical"} need to be brought into balance.`);
      break;
    }
    if (pair === "air+fire" || pair === "earth+water") {
      lines.push(`${cards[i].name} and ${cards[i + 1].name} help each other: ${pair === "air+fire" ? "good ideas will turn into action" : "your feelings and practical care work well together"}.`);
      break;
    }
  }
  if (lines.length === 0) lines.push("Read the cards one by one, in order: each place tells part of the story.");
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
