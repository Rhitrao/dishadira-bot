import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkReply } from "../src/aicheck";
import { factNumbers, NEXT_ACTIONS } from "../src/ai";
import { allCopy } from "../src/copy";
import { gate } from "../src/gate";
import { LABELS } from "../src/noise";
import { slotAt } from "./slotat";
import { AI_CASES, ALL_CASES, CODE_CASES, factsFor, forbidden, missingRequired, type EvalCase } from "./agent-evals/shared";
import { NOW, Wa } from "./wa";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The 145 scenarios of docs/KNOWLEDGE.md section 7, run through the real handler with a FAKE assistant that returns the canned answer in each case.
// This proves the wiring (gate, strikes, blocks, buttons, fallbacks, the output check, the fake-facts case), not the model: the model is judged by
// the manual workflow .github/workflows/eval.yml, which runs test/agent-evals/live.eval.ts against the real API.
const w = new Wa();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
beforeAll(() => w.start());
afterAll(() => w.stop());

describe("the case file", () => {
  it("has the 145 scenarios in order, each either decided by the assistant or by code", () => {
    expect(ALL_CASES.map((c) => c.id)).toEqual(Array.from({ length: 145 }, (_, i) => i + 1));
    expect(AI_CASES.length + CODE_CASES.length).toBe(145);
    expect(CODE_CASES.map((c) => c.id)).toEqual([14, 32, 42, 43, 44, 45, 57, 63, 64]);
    expect(AI_CASES.some((c) => c.safety)).toBe(true);
  });
  it.each(AI_CASES.map((c) => [c.id, c.name, c] as const))("case %i (%s): the fake answer is itself a good one", (_id, _name, c) => {
    expect(c.input, "input").toBeTruthy();
    expect(c.labels!.length, "labels").toBeGreaterThan(0);
    for (const l of c.labels!) expect(LABELS as readonly string[]).toContain(l);
    for (const n of c.next!) expect(NEXT_ACTIONS as readonly string[]).toContain(n);
    const f = c.fake!;
    expect(c.labels, "label").toContain(f.label);
    expect(c.next, "next").toContain(f.next);
    if (c.replyScript) expect(f.script).toBe(c.replyScript);
    expect(forbidden(c, f.reply), "mustNotContain").toEqual([]);
    expect(missingRequired(c, f.reply), "mustContainAny").toBe(false);
    if (f.reply) expect(checkReply(f.reply, factNumbers(factsFor(c))), f.reply).toEqual({ ok: true });
    else expect(["spam_or_promo", "abuse"]).toContain(f.label);
  });
});

describe("cases decided by code, never by the assistant", () => {
  const gateOf = async (c: EvalCase, text: string | null, mode = "BOT", fresh = false) => {
    const from = fresh ? w.newPhone() : await w.greeted(c.lang);
    if (fresh) await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(from).run();
    if (mode !== "BOT") await w.db.prepare("UPDATE conversations SET mode = ?2 WHERE wa_id = ?1").bind(from, mode).run();
    const conv = await w.conv(from);
    return gate(w.env(), conv, { type: text === null ? (c.media ?? "image") : "text", text, choice: null }, NOW);
  };
  it.each(CODE_CASES.map((c) => [c.id, c.name, c] as const))("case %i (%s)", async (_id, _name, c) => {
    const inputs = c.input === null ? [null] : [c.input, ...(c.alsoInput ?? [])];
    for (const text of inputs) expect(await gateOf(c, text, "BOT", c.setup === "first_message"), String(text)).toBe(c.gate);
    if (c.gate === "CRISIS" || c.gate === "EMERGENCY") {
      // Safety is first: even as a very first message, blocked, or in HUMAN mode.
      for (const text of inputs) {
        expect(await gateOf(c, text, "BOT", true)).toBe(c.gate);
        expect(await gateOf(c, text, "HUMAN")).toBe(c.gate);
        expect(await gateOf(c, text, "BLOCKED")).toBe(c.gate);
      }
    }
  });
  it("case 64: a first-message question is answered after the language tap, by the assistant, from the stored question", async () => {
    const c = ALL_CASES.find((x) => x.id === 64)!;
    const from = w.newPhone();
    await w.typed(from, c.input!);
    expect(w.last().interactive.body.text).toBe(allCopy.en.greeting);
    w.ai = { label: "relevant_question", language: "en", script: "latin", reply: "Many people find it calming, and we make no health promises.", next: "ask_more" };
    await w.tap(from, "lang_en");
    expect(w.aiCalls().at(-1).messages).toEqual([{ role: "user", content: c.input }]);
  });
});

// Real rows for the facts a case gives, so the handler builds the same trusted facts from our own tables.
async function giveFacts(from: string, c: EvalCase) {
  const f = c.facts;
  if (!f) return;
  const id = (await w.conv(from)).id as number;
  if (f.next) {
    const [s, e] = slotAt("2026-10-21", "CALL", 2); // Wed 21 Oct, 2:30 pm
    // Several cases use the same booked time: free it from the earlier case first (one row per kind and start).
    await w.db.prepare("DELETE FROM intros WHERE slot_id IN (SELECT id FROM slots WHERE kind = 'CALL' AND start_utc = ?1)").bind(s).run();
    await w.db.prepare("DELETE FROM slots WHERE kind = 'CALL' AND start_utc = ?1").bind(s).run();
    const slot = await w.db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('CALL',?1,?2,?3,'BOOKED')").bind(s, e, id).run();
    await w.db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state,call_lang) VALUES (?1,?2,'HEALING','PAID','en')").bind(id, slot.meta.last_row_id).run();
  } else if (f.hadIntroCall) {
    await w.db.prepare("INSERT INTO intros (conversation_id,service,state) VALUES (?1,'HEALING','CALLED_SESSION')").bind(id).run();
  }
  if (f.creditsLeft) {
    const pk = await w.db.prepare("INSERT INTO packages (conversation_id,size,price_paise,state) VALUES (?1,10,500000,'PAID')").bind(id).run();
    await w.db.prepare("INSERT INTO credits (package_id,delta,reason,at,by) VALUES (?1,?2,'PURCHASE','2026-10-01T00:00:00Z','system')").bind(pk.meta.last_row_id, f.creditsLeft).run();
  }
}

describe("cases decided by the assistant: the canned answer goes through the handler", () => {
  it.each(AI_CASES.map((c) => [c.id, c.name, c] as const))("case %i (%s)", async (_id, _name, c) => {
    const f = c.fake!;
    const from = await w.greeted(c.lang);
    if (c.codeFirst) {
      // In a real chat code decides first (the message has the word "person" in it), so the assistant is never asked.
      const conv = await w.conv(from);
      expect(await gate(w.env(), conv, { type: "text", text: c.input!, choice: null }, NOW)).toBe(c.codeFirst);
      return;
    }
    await giveFacts(from, c);
    const convId = (await w.conv(from)).id as number;
    for (const [i, turn] of (c.history ?? []).entries()) {
      // Earlier turns, an hour or more before the message under test (so none of them counts as a newer message).
      await w.db.prepare("INSERT INTO messages (conversation_id, direction, kind, body, status, created_at) VALUES (?1, ?2, 'text', ?3, ?4, ?5)")
        .bind(convId, turn.role === "user" ? "IN" : "OUT", turn.content, turn.role === "user" ? "RECEIVED" : "SENT", iso(NOW - 7_200_000 + i * 60_000)).run();
    }
    if (c.step === "day" || c.step === "who") {
      await w.ageOk(from);
      await w.tap(from, "menu_book");
      await w.tap(from, "svc_HEALING");
      if (c.step === "day") await w.tap(from, "who_HEALING_SELF");
    }
    w.fetchMock.mockClear();
    w.emails.length = 0;
    w.ai = f;
    await w.typed(from, c.input!);

    // The request: exactly one call, with the person's words (tags, links and numbers removed) and the facts from our own tables.
    expect(w.aiCalls()).toHaveLength(1);
    const req = w.aiCalls()[0];
    expect(req.messages.at(-1).role).toBe("user");
    expect(JSON.stringify(req)).not.toContain(from);
    if (c.id === 61) {
      expect(JSON.stringify(req.messages)).not.toContain("<booking_facts>");
      expect(req.system[1].text).toContain("Next booking: none");
    }
    if (c.facts?.next) expect(req.system[1].text).toContain("Next booking: call on Wed, 21 Oct at 2:30 pm (India time)");
    if (c.facts?.creditsLeft) expect(req.system[1].text).toContain(`Package sessions left: ${c.facts.creditsLeft}`);

    const out = w.sent();
    const texts = w.texts().filter(Boolean).join("\n");
    const st = await w.state(from);
    const conv = await w.conv(from);
    const strikeLabels = ["off_topic", "astrology_or_prediction", "prohibited_request", "loop"];

    // What the label does.
    if (f.label === "crisis") {
      expect(w.texts()).toEqual([allCopy[c.lang].crisis]);
      expect(conv.mode).toBe("HUMAN");
      expect(st.no_sell_until).toBe(iso(NOW + 7 * 86_400_000));
      return;
    }
    if (f.label === "abuse" || f.label === "spam_or_promo") {
      expect(out).toHaveLength(0);
      expect(st.strikes + (conv.mode === "BLOCKED" ? 1 : 0)).toBeGreaterThanOrEqual(1);
      if (c.id === 17) expect(conv.mode).toBe("BLOCKED"); // a word from the code list
      return;
    }
    if (f.label === "flirt_or_sexual") {
      expect(w.texts()).toEqual([allCopy[c.lang].flirtLine]);
      expect(st.strikes).toBe(1);
      return;
    }
    expect(st.strikes).toBe(strikeLabels.includes(f.label) ? 1 : 0);
    expect(conv.mode).toBe(f.next === "handoff" ? "HUMAN" : "BOT");

    // What is sent: one message with the assistant's words, shaped by `next`.
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(texts).toContain(f.reply);
    for (const bad of forbidden(c, texts)) throw new Error(`case ${c.id} sent "${bad}"`);
    const buttons = m.interactive?.action?.buttons?.map((b: { reply: { id: string } }) => b.reply.id);
    if (c.step === "day" || c.step === "who") {
      expect(req.system[1].text).toContain(`open_step: ${c.step}`);
      expect(m.interactive.body.text).toBe(`${f.reply}\n\n${allCopy[c.lang][c.step === "day" ? "chooseDay" : "whoFor"]}`);
      expect(buttons!.length).toBeGreaterThan(0);
      return;
    }
    switch (f.next) {
      case "show_booking":
        expect(buttons).toEqual(["menu_book"]);
        expect(m.interactive.action.buttons[0].reply.title).toBe(allCopy[c.lang].btnSeeTimes);
        break;
      case "show_menu":
        expect(buttons).toEqual(["menu_book", "menu_pack", "menu_how"]);
        break;
      case "handoff":
        expect(m.type).toBe("text");
        expect(await w.count(`SELECT COUNT(*) AS n FROM attention WHERE kind = 'HUMAN_REQUEST' AND target = 'conv:${convId}'`)).toBe(1);
        expect(w.emails.map((e) => e.subject)).toEqual(["A customer asked for a person"]);
        expect(w.emails[0].text).not.toContain(c.input!);
        break;
      default:
        expect(m.type).toBe("text");
    }
  });
});
