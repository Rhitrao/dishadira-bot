// Ticket 58: a person's profile across the divination arts, worked out by code from what they tell us the first time (name as at birth, date
// of birth, and, if they know them, birth time with its UTC offset and birth place). Nothing here is sent anywhere or guessed by an AI.
//   Numerology  Pythagorean letter values (A=1 … I=9, J=1 …): Life Path, Expression (full name), Soul Urge (vowels), Personality (consonants),
//               master numbers 11, 22 and 33 kept; Personal Year, Month and Day; and the Indian Mulank (day of birth) and Bhagyank (whole date).
//   Western     the tropical Sun sign from the Sun's true longitude (J. Meeus, Astronomical Algorithms, ch. 25), not a table of dates.
//   Vedic       Jyotish with the Lahiri ayanamsa: Moon sign (rashi), birth star (nakshatra) and pada from the Moon's longitude (Meeus ch. 47,
//               the largest terms: well inside 0.1°), and the sidereal Sun sign. Without a birth time the Moon can change sign during the day, so
//               both possibilities are named.
//   Chinese     the animal and element of the year, the year turning at Li Chun (the Sun at 315°, about 4 February), as in BaZi.
//   Tarot       the birth cards by Mary K. Greer's method (month + day + year, digits added until 21 or less): a Personality card and a
//               Soul card (one card plays both when the result is a single digit; 19 adds a Hidden factor card, 10).
// The profile shapes how a reading is explained, never which cards appear: the draw stays the fair shuffle in reading.ts.
import { BY_ID, type Card, type Suit } from "./deck";
import type { Drawn } from "./reading";

export type Profile = { name: string; dob: string; birthTime: string | null; tzMinutes: number; birthPlace: string | null };

// ---------- numerology ----------
const digitSum = (n: number) => String(Math.abs(n)).split("").reduce((s, d) => s + Number(d), 0);
export function reduce(n: number, keepMasters = true): number {
  let x = n;
  while (x > 9 && !(keepMasters && (x === 11 || x === 22 || x === 33))) x = digitSum(x);
  return x;
}
const LETTER = (ch: string) => ((ch.charCodeAt(0) - 65) % 9) + 1; // A=1 … I=9, J=1 …, R=9, S=1 …, Z=8
const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const lettersOf = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "").split("").filter(Boolean);

export function numerology(p: Profile, todayYmd: string) {
  const [y, m, d] = p.dob.split("-").map(Number);
  const lifePath = reduce(reduce(m) + reduce(d) + reduce(digitSum(y)));
  const letters = lettersOf(p.name);
  const sum = (ls: string[]) => (ls.length ? reduce(ls.reduce((s, c) => s + LETTER(c), 0)) : null);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  const personalYear = reduce(reduce(m, false) + reduce(d, false) + reduce(ty, false), false);
  const personalMonth = reduce(personalYear + tm, false);
  const personalDay = reduce(personalMonth + reduce(td, false), false);
  return {
    lifePath,
    expression: sum(letters),
    soulUrge: sum(letters.filter((c) => VOWELS.has(c))),
    personality: sum(letters.filter((c) => !VOWELS.has(c))),
    mulank: reduce(d, false),
    bhagyank: reduce(lifePath, false),
    personalYear,
    personalMonth,
    personalDay,
  };
}

// ---------- astronomy ----------
const RAD = Math.PI / 180;
const norm = (deg: number) => ((deg % 360) + 360) % 360;
const centuries = (ms: number) => (ms / 86_400_000 + 2440587.5 - 2451545) / 36525;

export function sunLongitude(ms: number): number {
  const T = centuries(ms);
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  return norm(L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * RAD));
}

// [coefficient (1e-6 degree), D, M, M', F]: Meeus table 47.A, the terms above 0.003°.
const MOON_TERMS: [number, number, number, number, number][] = [
  [6288774, 0, 0, 1, 0], [1274027, 2, 0, -1, 0], [658314, 2, 0, 0, 0], [213618, 0, 0, 2, 0], [-185116, 0, 1, 0, 0], [-114332, 0, 0, 0, 2],
  [58793, 2, 0, -2, 0], [57066, 2, -1, -1, 0], [53322, 2, 0, 1, 0], [45758, 2, -1, 0, 0], [-40923, 0, 1, -1, 0], [-34720, 1, 0, 0, 0],
  [-30383, 0, 1, 1, 0], [15327, 2, 0, 0, -2], [-12528, 0, 0, 1, 2], [10980, 0, 0, 1, -2], [10675, 4, 0, -1, 0], [10034, 0, 0, 3, 0],
  [8548, 4, 0, -2, 0], [-7888, 2, 1, -1, 0], [-6766, 2, 1, 0, 0], [-5163, 1, 0, -1, 0], [4987, 1, 1, 0, 0], [4036, 2, -1, 1, 0],
  [3994, 2, 0, 2, 0], [3861, 4, 0, 0, 0], [3665, 2, 0, -3, 0],
];
export function moonLongitude(ms: number): number {
  const T = centuries(ms);
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const E = 1 - 0.002516 * T;
  let sum = 0;
  for (const [c, d, m, mp, f] of MOON_TERMS) sum += c * Math.abs(m === 0 ? 1 : E) ** Math.abs(m) * Math.sin((d * D + m * M + mp * Mp + f * F) * RAD);
  sum += 3958 * Math.sin((119.75 + 131.849 * T) * RAD) + 1962 * Math.sin((Lp - F) * RAD) + 318 * Math.sin((53.09 + 479264.29 * T) * RAD);
  return norm(Lp + sum / 1e6);
}
// Lahiri (Chitrapaksha) ayanamsa: 23.853° at J2000, moving about 50.29" a year.
export const lahiri = (ms: number) => 23.853 + 0.0139689 * (centuries(ms) * 100);
export const sidereal = (tropical: number, ms: number) => norm(tropical - lahiri(ms));

export const SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"] as const;
export const RASHIS = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Tula", "Vrishchika", "Dhanu", "Makara", "Kumbha", "Meena"] as const;
export const NAKSHATRAS = [
  "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni",
  "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana",
  "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada", "Revati",
] as const;
const ELEMENTS = ["fire", "earth", "air", "water"] as const;
type Element = (typeof ELEMENTS)[number];
const signIndex = (lon: number) => Math.floor(norm(lon) / 30);
const nakIndex = (lon: number) => Math.floor(norm(lon) / (360 / 27));
export const signElement = (i: number): Element => ELEMENTS[i % 4];
const MODALITY = ["cardinal", "fixed", "mutable"];

const SIGN_TEXT = [
  "Aries: bold, direct and quick to begin. You learn by doing.",
  "Taurus: steady, patient and loyal. You build what lasts.",
  "Gemini: curious, quick and talkative. You think by connecting ideas.",
  "Cancer: caring, protective and deeply feeling. Home and family hold you.",
  "Leo: warm, generous and expressive. You shine when you lead with heart.",
  "Virgo: careful, helpful and precise. You show love through service.",
  "Libra: fair, graceful and relationship-minded. You seek balance.",
  "Scorpio: intense, loyal and perceptive. You go deep or not at all.",
  "Sagittarius: free-spirited, honest and searching. You grow through meaning.",
  "Capricorn: disciplined, responsible and ambitious. You climb steadily.",
  "Aquarius: independent, original and humane. You think ahead of your time.",
  "Pisces: gentle, intuitive and compassionate. You feel what others feel.",
];
const RASHI_TEXT = [
  "a quick, courageous mind that needs action to feel at ease",
  "a calm, steady mind that finds peace in comfort and beauty",
  "a lively, curious mind that needs conversation and variety",
  "a tender, caring mind deeply tied to home and mother",
  "a proud, warm mind that needs to feel seen and to give",
  "a careful, thoughtful mind that settles through order and service",
  "a gracious mind that seeks harmony and fairness with others",
  "a deep, private mind with strong feelings and great resilience",
  "an open, hopeful mind drawn to truth, teaching and travel",
  "a practical, patient mind that feels safe through duty and plans",
  "an independent mind that cares about people and ideas",
  "a gentle, dreamy mind, devotional and sensitive to others",
];
const NAK_TEXT = [
  "swift beginnings and the healer's touch", "endurance and the courage to carry life forward", "purifying fire and sharp clarity",
  "growth, beauty and fertile creativity", "a gentle, searching curiosity", "storm and renewal: feeling deeply, then clearing",
  "return and renewal: coming home to yourself", "nourishment and care for others", "insight and the power to see beneath the surface",
  "ancestry, dignity and leadership", "rest, pleasure and creative joy", "generosity, friendship and steady support",
  "skill of the hands and clever helpfulness", "creativity and the love of beautiful form", "independence and moving with the wind",
  "single-minded purpose and achievement", "friendship, devotion and loyalty", "seniority, protection and inner strength",
  "going to the root of things", "invincible enthusiasm and renewal", "lasting victory through patience",
  "listening, learning and connection", "rhythm, music and abundance", "healing and the hundred remedies",
  "fierce idealism and transformation", "depth, wisdom and calm", "safe journeys, kindness and completion",
];
const ANIMALS = ["Rat", "Ox", "Tiger", "Rabbit", "Dragon", "Snake", "Horse", "Goat", "Monkey", "Rooster", "Dog", "Pig"];
const ANIMAL_TEXT = [
  "quick-witted and resourceful", "dependable and hard-working", "brave and confident", "gentle, kind and elegant", "energetic and ambitious",
  "wise, calm and intuitive", "free-spirited and lively", "gentle, creative and compassionate", "clever and playful", "observant and hard-working",
  "loyal and honest", "warm-hearted and generous",
];
const CN_ELEMENTS = ["Wood", "Wood", "Fire", "Fire", "Earth", "Earth", "Metal", "Metal", "Water", "Water"];

export const LIFE_PATH_TEXT: Record<number, string> = {
  1: "the leader: independent, original and driven to begin new things",
  2: "the peacemaker: sensitive, cooperative and gifted at bringing people together",
  3: "the communicator: expressive, creative and joyful",
  4: "the builder: practical, loyal and steady; you make things last",
  5: "the free spirit: adventurous, adaptable and hungry for experience",
  6: "the nurturer: caring, responsible and devoted to home and community",
  7: "the seeker: thoughtful, spiritual and drawn to deeper truths",
  8: "the achiever: ambitious, capable and at ease with power and money",
  9: "the humanitarian: compassionate, wise and generous of heart",
  11: "the intuitive (a master number): inspired, sensitive and here to light the way for others",
  22: "the master builder: able to turn large visions into real, lasting work",
  33: "the master teacher: a healer's heart, called to serve with love",
};
const NUMBER_WORD: Record<number, string> = {
  1: "initiative and fresh starts", 2: "partnership, patience and listening", 3: "expression, joy and creativity", 4: "work, order and foundations",
  5: "change, freedom and movement", 6: "love, family and responsibility", 7: "reflection, rest and inner wisdom", 8: "effort, money and personal power",
  9: "endings, release and compassion", 11: "intuition and inspiration", 22: "building something lasting", 33: "service and healing",
};
export const PERSONAL_YEAR_TEXT: Record<number, string> = {
  1: "a year of new beginnings: plant seeds and start fresh", 2: "a year of patience and partnership: let things grow slowly",
  3: "a year of expression: create, share and connect", 4: "a year of building: steady work lays foundations",
  5: "a year of change: expect movement and say yes to growth", 6: "a year of home and heart: family and responsibility come first",
  7: "a year of reflection: study, rest and look inward", 8: "a year of harvest and power: effort brings results",
  9: "a year of completion: finish, forgive and let go before a new cycle",
};
export const PERSONAL_DAY_TEXT: Record<number, string> = {
  1: "a day to begin something", 2: "a day for patience, listening and cooperation", 3: "a day to express yourself and enjoy people",
  4: "a day for steady, practical work", 5: "a day of movement and surprises; stay flexible", 6: "a day for family, home and care",
  7: "a quiet day for reflection and rest", 8: "a day to take charge and handle practical matters", 9: "a day to finish things and let go",
};

// ---------- the whole profile ----------
const utcMs = (dob: string, hhmm: string, tzMinutes: number) => {
  const [y, m, d] = dob.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - tzMinutes * 60_000;
};

// One sign (or nakshatra) if it is the same all through the window, else the two it moves between.
function placed(lonAt: (ms: number) => number, from: number, to: number, index: (lon: number) => number): number[] {
  const a = index(lonAt(from));
  const b = index(lonAt(to));
  return a === b ? [a] : [a, b];
}

export function birthCards(dob: string): number[] {
  const [y, m, d] = dob.split("-").map(Number);
  let x = digitSum(m + d + y);
  while (x > 22) x = digitSum(x);
  if (x === 22) return [0, 4]; // the Fool, and 2 + 2: the Emperor
  const cards = [x];
  let k = x;
  while (k >= 10) {
    k = digitSum(k);
    cards.push(k);
  }
  return cards;
}

const GOLDEN_DAWN_MAJOR = [4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 17, 18]; // Aries → the Emperor … Pisces → the Moon

export function insights(p: Profile, nowMs = Date.now(), todayYmd: string) {
  const num = numerology(p, todayYmd);
  const known = p.birthTime !== null;
  const from = utcMs(p.dob, known ? p.birthTime! : "00:00", p.tzMinutes);
  const to = known ? from : utcMs(p.dob, "23:59", p.tzMinutes);
  const sun = placed(sunLongitude, from, to, signIndex);
  const moonR = placed((ms) => sidereal(moonLongitude(ms), ms), from, to, signIndex);
  const nak = placed((ms) => sidereal(moonLongitude(ms), ms), from, to, nakIndex);
  const sunR = placed((ms) => sidereal(sunLongitude(ms), ms), from, to, signIndex);
  const moonLon = sidereal(moonLongitude(from), from);
  const pada = Math.floor((moonLon % (360 / 27)) / (360 / 108)) + 1;
  const [y] = p.dob.split("-").map(Number);
  const noon = utcMs(p.dob, "12:00", p.tzMinutes);
  const beforeLiChun = Number(p.dob.slice(5, 7)) <= 2 && sunLongitude(noon) >= 270 && sunLongitude(noon) < 315;
  const cy = beforeLiChun ? y - 1 : y;
  const animal = (((cy - 4) % 12) + 12) % 12;
  const stem = (((cy - 4) % 10) + 10) % 10;
  const cards = birthCards(p.dob);
  const first = p.name.trim().split(/\s+/)[0] ?? "";
  const nowMoon = sidereal(moonLongitude(nowMs), nowMs);
  const orList = (names: readonly string[], idx: number[]) => idx.map((i) => names[i]).join(" or ");
  return {
    firstName: first,
    sunSign: sun[0],
    sunSignCertain: sun.length === 1,
    moonRashi: moonR,
    numbers: num,
    birthCards: cards,
    signMajor: GOLDEN_DAWN_MAJOR[sun[0]],
    element: signElement(sun[0]),
    today: [
      `Today is a Personal Day ${num.personalDay} for you: ${PERSONAL_DAY_TEXT[num.personalDay]}.`,
      `${todayYmd.slice(0, 4)} is your Personal Year ${num.personalYear}: ${PERSONAL_YEAR_TEXT[num.personalYear]}.`,
      `The Moon today is in ${NAKSHATRAS[nakIndex(nowMoon)]} (${RASHIS[signIndex(nowMoon)]}): a day coloured by ${NAK_TEXT[nakIndex(nowMoon)]}.`,
      ...(moonR.includes(signIndex(nowMoon)) ? ["The Moon is passing through your own Moon sign: feelings sit closer to the surface today. Be gentle with yourself."] : []),
    ],
    arts: [
      {
        art: "Numerology",
        method: "Pythagorean, with the Indian Mulank and Bhagyank",
        items: [
          { label: "Life Path", value: String(num.lifePath), text: `You walk the path of ${LIFE_PATH_TEXT[num.lifePath]}.` },
          ...(num.expression !== null ? [{ label: "Expression (your name)", value: String(num.expression), text: `Your name carries ${NUMBER_WORD[num.expression]}.` }] : []),
          ...(num.soulUrge !== null ? [{ label: "Soul Urge", value: String(num.soulUrge), text: `Inside, you long for ${NUMBER_WORD[num.soulUrge]}.` }] : []),
          ...(num.personality !== null ? [{ label: "Personality", value: String(num.personality), text: `Others first meet your ${NUMBER_WORD[num.personality]}.` }] : []),
          { label: "Mulank and Bhagyank", value: `${num.mulank} · ${num.bhagyank}`, text: `Mulank ${num.mulank} (your day of birth) shows ${NUMBER_WORD[num.mulank]}; Bhagyank ${num.bhagyank} (your whole date) points to ${NUMBER_WORD[num.bhagyank]}.` },
          { label: "Personal Year", value: String(num.personalYear), text: `This is ${PERSONAL_YEAR_TEXT[num.personalYear]}.` },
        ],
        note: num.expression === null ? "Write your name in English letters to see your name numbers." : null,
      },
      {
        art: "Western astrology",
        method: "Tropical zodiac, the Sun's true position at your birth",
        items: [
          {
            label: "Sun sign",
            value: orList(SIGNS, sun),
            text: `${SIGN_TEXT[sun[0]]} A ${MODALITY[sun[0] % 3]} ${signElement(sun[0])} sign.${sun.length > 1 ? " You were born on the day the Sun changed sign; your birth time settles it." : ""}`,
          },
        ],
        note: null,
      },
      {
        art: "Vedic astrology (Jyotish)",
        method: "Sidereal zodiac, Lahiri ayanamsa",
        items: [
          { label: "Moon sign (Rashi)", value: orList(RASHIS, moonR), text: `In Jyotish the Moon is the mind: ${RASHI_TEXT[moonR[0]]}.` },
          {
            label: "Birth star (Nakshatra)",
            value: orList(NAKSHATRAS, nak) + (known ? `, pada ${pada}` : ""),
            text: `${NAKSHATRAS[nak[0]]} is the star of ${NAK_TEXT[nak[0]]}.`,
          },
          { label: "Sun sign (sidereal)", value: orList(RASHIS, sunR), text: "Your Sun in the Vedic zodiac, which sits about 24° behind the Western one." },
        ],
        note: known ? null : "Add your birth time for an exact Moon sign and birth star: the Moon moves about 13° a day.",
      },
      {
        art: "Chinese astrology",
        method: "The year turns at Li Chun, about 4 February",
        items: [{ label: "Year", value: `${CN_ELEMENTS[stem]} ${ANIMALS[animal]}`, text: `The ${ANIMALS[animal]} is ${ANIMAL_TEXT[animal]}; ${CN_ELEMENTS[stem]} colours it.` }],
        note: null,
      },
      {
        art: "Tarot birth cards",
        method: "Mary K. Greer's method: month + day + year",
        items: cards.map((c, i) => {
          const card = BY_ID.get(`m${String(c).padStart(2, "0")}`) as Card;
          const label = cards.length === 1 ? "Personality and Soul card" : i === 0 ? "Personality card" : i === cards.length - 1 ? "Soul card" : "Hidden factor card";
          return { label, value: card.name, text: card.meaning, card: card.id };
        }),
        note: null,
      },
    ],
    signCertain: { sun: sun.length === 1, moon: moonR.length === 1, nakshatra: nak.length === 1 },
  };
}
export type Insights = ReturnType<typeof insights>;

// ---------- personal lines for a reading ----------
const SUIT_ELEMENT: Record<Suit, Element> = { wands: "fire", cups: "water", swords: "air", pentacles: "earth" };
const cardNumber = (c: Card): number | null => (c.suit === null ? (c.rank === 0 ? null : reduce(c.rank, false)) : c.rank <= 10 ? reduce(c.rank, false) : null);

// What the person's profile and recent readings add to this reading. History: cards drawn in the last 30 days before this reading.
export function personalLines(drawn: Drawn[], ins: Insights | null, history: Drawn[]): string[] {
  const out: string[] = [];
  const cards = drawn.map((d) => BY_ID.get(d.id) as Card);
  if (ins) {
    const birth = cards.find((c) => c.suit === null && ins.birthCards.includes(c.rank));
    if (birth) out.push(`${birth.name} is one of your birth cards: this reading speaks to who you are at your core.`);
    const sign = cards.find((c) => c.suit === null && c.rank === ins.signMajor);
    if (sign) out.push(`${sign.name} is the card of your Sun sign, ${SIGNS[ins.sunSign]}: pay it special attention.`);
    const day = cards.find((c) => cardNumber(c) === ins.numbers.personalDay);
    if (day) out.push(`${day.name} carries your Personal Day number, ${ins.numbers.personalDay}: it is the card most in tune with today.`);
    const suits = cards.filter((c) => c.suit).map((c) => SUIT_ELEMENT[c.suit!]);
    const same = suits.filter((e) => e === ins.element).length;
    if (same >= 2 || (same === 1 && cards.length === 1)) out.push(`The ${ins.element} cards here match your ${ins.element} Sun sign: this comes naturally to you.`);
    else if (suits.length >= 2 && same === 0) out.push(`None of these cards share your ${ins.element} element: the reading asks you to work in a way that does not come naturally, and that is where growth is.`);
  }
  const seen = new Map<string, number>();
  for (const h of history) seen.set(h.id, (seen.get(h.id) ?? 0) + 1);
  const repeat = cards.find((c) => (seen.get(c.id) ?? 0) >= 1);
  if (repeat) out.push(`${repeat.name} has come to you ${(seen.get(repeat.id) ?? 0) + 1} times this month. A card that keeps returning has something to say.`);
  if (out.length === 0 && ins) out.push(`Read this on your Personal Day ${ins.numbers.personalDay}, ${PERSONAL_DAY_TEXT[ins.numbers.personalDay]}: let that colour how you take the cards.`);
  return out.slice(0, 3);
}
