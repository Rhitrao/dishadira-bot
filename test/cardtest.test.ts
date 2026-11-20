// Ticket 49: the 14-day CARD test. The bare word CARD gives the theme buttons; a theme gives three different cards; the same day returns
// the same draw and a second theme is refused; the soft Book line only on a person's 1st, 3rd and 5th day; nothing after a crisis message;
// crisis and blocks win; the first message CARD (the ad) is answered after the language tap; no banned word anywhere; the wipe and the stats.
// All data is synthetic. Meta is mocked: nothing is sent anywhere.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CARD_COUNT, cardStats, drawText, isCardWord, pickThree, secureInt } from "../src/cardtest";
import { config } from "../src/config";
import { hasPhrase } from "../src/safety";
import { wipeChats, wipePersonStmts } from "../src/wipe";
import { Wa } from "./wa";

const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());
const DAY = 86_400_000;
const nextDay = () => {
  // fake clock only moves the Date; one IST day later
  const d = new Date(Date.now() + DAY);
  return d;
};
const advance = async () => {
  const { vi } = await import("vitest");
  vi.setSystemTime(nextDay());
};
const draws = (from: string) => w.db.prepare("SELECT * FROM card_draws WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1) ORDER BY day").bind(from).all<Record<string, number | string>>().then((r) => r.results);

describe("the word", () => {
  it("is the bare word only", () => {
    for (const t of ["CARD", " card ", "Cards", "tarot", "Tarot card", "कार्ड", "टैरो"]) expect(isCardWord(t), t).toBe(true);
    for (const t of ["credit card", "my card was charged", "card payment failed", "book a call", "", "cardio"]) expect(isCardWord(t), t).toBe(false);
  });
});

describe("the draw", () => {
  it("is three different cards from the 22, over many draws", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const [a, b, c] = pickThree();
      expect(new Set([a, b, c]).size).toBe(3);
      for (const x of [a, b, c]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(CARD_COUNT);
        seen.add(x);
      }
    }
    expect(seen.size).toBe(CARD_COUNT);
    for (let i = 0; i < 200; i++) expect(secureInt(22)).toBeLessThan(22);
  });
  it("never repeats a card even from a stuck random source", () => {
    let k = 0;
    expect(pickThree(() => [5, 5, 5, 9, 9, 12][k++ % 6])).toEqual([5, 9, 12]);
  });
});

describe("in the chat", () => {
  it("CARD gives the three theme buttons, a theme gives the cards, and the same day gives the same cards", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "CARD");
    const pick = w.last();
    expect(pick.interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(["card_work", "card_relationships", "card_energy"]);
    for (const b of pick.interactive.action.buttons) expect(b.reply.title.length).toBeLessThanOrEqual(20);
    await w.tap(from, "card_work");
    const first = w.texts().at(-1) as string;
    expect(first).toContain("*Work*");
    expect(first).toContain("Past:");
    expect(first).toContain("Next step:");
    expect(first).toContain("Not a prediction or advice");
    expect(await draws(from)).toHaveLength(1);
    await w.typed(from, "card");
    expect(w.texts().at(-1)).toContain("Your 3 cards for today");
    await w.tap(from, "card_work");
    expect(w.texts().at(-1)).toBe(first.replace(/\n\nIf you would like.*$/s, ""));
    expect(await draws(from)).toHaveLength(1);
  });
  it("a different theme the same day is refused with the day's theme", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "CARD");
    await w.tap(from, "card_energy");
    await w.tap(from, "card_work");
    expect(w.texts().at(-1)).toBe("Today's theme is *Energy and calm*. Come back tomorrow for a new one.");
    expect((await draws(from))[0].theme).toBe("ENERGY");
  });
  it("the soft Book line is on a person's 1st, 3rd and 5th day only", async () => {
    const from = await w.greeted("en");
    const withCta: boolean[] = [];
    for (let d = 1; d <= 6; d++) {
      await w.typed(from, "tarot");
      await w.tap(from, "card_relationships");
      const o = w.last();
      withCta.push(o.type === "interactive" && String(o.interactive.body.text).includes("₹99") && o.interactive.action.buttons[0].reply.id === "menu_book");
      await advance();
    }
    expect(withCta).toEqual([true, false, true, false, true, false]);
  });
  it("Hindi gets Hindi cards and buttons", async () => {
    const from = await w.greeted("hi");
    await w.typed(from, "कार्ड");
    expect(w.last().interactive.action.buttons[0].reply.title).toBe("काम");
    await w.tap(from, "card_work");
    expect(w.texts().at(-1)).toContain("आज के आपके 3 कार्ड");
  });
  it("CARD as the very first message is answered after the language tap", async () => {
    const from = w.newPhone();
    await w.typed(from, "CARD");
    await w.tap(from, "lang_en");
    expect(w.last().interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(["card_work", "card_relationships", "card_energy"]);
  });
  it("nothing is drawn for 7 days after a crisis message: Help and Talk to a person only", async () => {
    const from = await w.greeted("en");
    await w.setState(from, "no_sell_until = ?2", new Date(Date.now() + DAY).toISOString().slice(0, 19) + "Z");
    await w.typed(from, "CARD");
    expect(w.texts().at(-1)).toContain("Not today");
    expect(await draws(from)).toHaveLength(0);
  });
  it("a crisis message with CARD in it gets the safety reply, not cards", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "I want to end my life. card");
    expect(await draws(from)).toHaveLength(0);
    expect(w.texts().join("\n")).toMatch(/14416|112/);
  });
  it("a blocked chat gets nothing", async () => {
    const from = await w.greeted("en");
    await w.db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1").bind(from).run();
    await w.db.prepare("INSERT INTO blocks (wa_id, reason, created_by) VALUES (?1, 'test', 'test')").bind(from).run().catch(() => {});
    w.fetchMock.mockClear();
    await w.typed(from, "CARD");
    expect(w.sent()).toHaveLength(0);
    expect(await draws(from)).toHaveLength(0);
  });
  it("never calls the assistant", async () => {
    const from = await w.greeted("en");
    await w.typed(from, "CARD");
    await w.tap(from, "card_work");
    expect(w.aiCalls()).toHaveLength(0);
  });
});

describe("the words", () => {
  it("no banned word, name or promise in any card text, English or Hindi", () => {
    for (const lang of ["en", "hi"] as const) {
      for (const theme of ["WORK", "RELATIONSHIPS", "ENERGY"] as const) {
        for (let i = 0; i < CARD_COUNT; i += 3) {
          const text = drawText(lang, theme, [i, (i + 1) % CARD_COUNT, (i + 2) % CARD_COUNT]);
          expect(hasPhrase(text, config.ai.bannedWords), `${lang} ${i}`).toBe(false);
          expect(text).not.toMatch(/pranic|healing|heal|cure|diagnos|you will|fate|evil|curse|negative/i);
        }
      }
    }
  });
});

describe("keeping and the numbers", () => {
  it("draws go with the person's data and 90 days after the draw", async () => {
    const a = await w.greeted("en");
    const b = await w.greeted("en");
    for (const p of [a, b]) {
      await w.typed(p, "card");
      await w.tap(p, "card_work");
    }
    const cid = (await w.conv(a)).id as number;
    await w.db.batch(wipePersonStmts(w.db, cid, "2026-10-05T00:00:00Z"));
    expect(await draws(a)).toHaveLength(0);
    expect(await draws(b)).toHaveLength(1);
    await w.db.prepare("UPDATE card_draws SET created_at = '2026-06-01T00:00:00Z'").run();
    await wipeChats(w.env());
    expect(await w.count("SELECT COUNT(*) AS n FROM card_draws")).toBe(0);
  });
  it("counts people, repeaters and paid calls from them, against all paid calls, with no names", async () => {
    const a = await w.greeted("en");
    const b = await w.greeted("en");
    const ca = (await w.conv(a)).id as number;
    const cb = (await w.conv(b)).id as number;
    for (let d = 0; d < 3; d++) {
      await w.typed(a, "card");
      await w.tap(a, "card_work");
      await advance();
    }
    await w.typed(b, "card");
    await w.tap(b, "card_energy");
    await w.db.prepare("INSERT INTO intros (conversation_id, service, state, created_at) VALUES (?1, 'HEALING', 'PAID', '2026-10-06T00:00:00Z'), (?2, 'HEALING', 'HELD', '2026-10-06T00:00:00Z')").bind(ca, cb).run();
    const noCardPerson = await w.greeted("en");
    const cc = (await w.conv(noCardPerson)).id as number;
    await w.db.prepare("INSERT INTO intros (conversation_id, service, state, created_at) VALUES (?1, 'HEALING', 'PAID', '2026-10-06T00:00:00Z')").bind(cc).run();
    expect(await cardStats(w.db, "2026-10-01T00:00:00Z")).toEqual({ people: 2, repeat3: 1, paidCalls: 1, paidCallsAll: 2 });
  });
});
