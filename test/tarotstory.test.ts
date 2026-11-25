// Ticket 59: "What this means for you" and the voice. The rule-built words are plain (no tarot jargon) and answer the question; the
// assistant's words are written once, checked, kept, capped per day, and refused when they predict or frighten; the routes serve only the
// person's own readings; the voice comes from Workers AI when it is on, and is a 404 (the phone's voice) when it is off. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { audioBytes, plainStory, speakable, storyIsSafe, STORY } from "../src/tarot/story";
import { finishReading, newLoginLink, readingById, saveProfile, startReading } from "../src/tarot/store";
import { Wa } from "./wa";

vi.setConfig({ testTimeout: 60_000 });
const w = new Wa();
beforeEach(() => w.start());
afterEach(() => w.stop());

const ORIGIN = "https://bot.example.test";
const STORY_TEXT =
  "Your question is about feeling closer to your sister, and your cards say the door is open, but it needs a gentle first step from you.\n\nIn your own place, the cards show you are ready to listen. Between you, there is care that has been quiet for a while. In what helps, honesty and fairness are asking to be heard.\n\nTry sending her a small, warm message this week. Listen more than you explain. Share one happy memory.\n\nWhat would you like her to know about how much she matters to you?";
const aiReply = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", name: "write_explanation", input: { text } }], stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 250 } }), { status: 200 });

async function person(env: Record<string, unknown> = {}) {
  const id = (await w.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(w.newPhone()).run()).meta.last_row_id;
  await saveProfile(w.db, id, { name: "Asha Kumari", dob: "1990-05-15", birthTime: null, tzMinutes: 330, birthPlace: null });
  await startReading(w.db, id, { kind: "spread", spread: "love_bond", theme: "love", question: "How can I feel closer to my sister?", custom: true, pile: 0 });
  const done = await finishReading(w.db, id, "spread", [0, 1, 2, 3, 4]);
  const res = await app.request(await newLoginLink(w.db, id, ORIGIN), {}, { ...(w.env() as object), TAROT_GAME: "true", ...env } as never);
  return { id, readingId: done!.row.id, cookie: res.headers.get("Set-Cookie")!.split(";")[0] };
}
const get = (path: string, cookie: string, env: Record<string, unknown> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }, { ...(w.env() as object), TAROT_GAME: "true", ...env } as never);

describe("plain words", () => {
  it("answer the question in everyday language, card by card, without tarot jargon", async () => {
    const { id, readingId } = await person();
    const e = (await readingById(w.db, id, readingId))!;
    const text = plainStory({ ...e, cards: [{ id: "cups03", r: true }, ...e.cards.slice(1)] }, null, []);
    expect(text).toMatch(/^You asked: "How can I feel closer to my sister\?"/);
    expect(text).toMatch(/What you bring and feel: Three of Cups, upside down\./);
    expect(text).toMatch(/For you: /);
    expect(text).toMatch(/Something to sit with: .+\?$/);
    expect(text).not.toMatch(/Major Arcana|\bsuit\b|court card|reversed/i);
    expect(storyIsSafe(text)).toBe(true);
  });
  it("refuse words that predict, frighten or speak of spells", () => {
    expect(storyIsSafe(STORY_TEXT)).toBe(true);
    for (const bad of ["you will die", "there is black magic on you", "you are pregnant", "this is guaranteed", "I want to kill myself"]) expect(storyIsSafe(`${STORY_TEXT} ${bad}`), bad).toBe(false);
    expect(storyIsSafe("Too short.")).toBe(false);
  });
});

describe("the assistant's words", () => {
  it("are written once from the card library, kept, and served again without a second call", async () => {
    w.ai = aiReply(STORY_TEXT);
    const { cookie, readingId } = await person({ TAROT_AI: "true" });
    const r = await get(`/tarot/api/story/${readingId}`, cookie, { TAROT_AI: "true" });
    expect(await r.json()).toEqual({ text: STORY_TEXT, by: "ai", voice: false });
    const call = w.aiCalls()[0];
    expect(call.system).toMatch(/never prediction/);
    expect(call.messages[0].content).toMatch(/Their question: How can I feel closer to my sister\?/);
    expect(call.messages[0].content).toMatch(/Place: You \(What you bring and feel\)/);
    expect(await w.count("SELECT COUNT(*) AS n FROM tarot_readings WHERE story IS NOT NULL")).toBe(1);
    w.ai = aiReply("should not be asked");
    expect(((await (await get(`/tarot/api/story/${readingId}`, cookie, { TAROT_AI: "true" })).json()) as { text: string }).text).toBe(STORY_TEXT);
    expect(w.aiCalls().length).toBe(1);
  });
  it("fall back to the plain words when they fail the check, when the assistant is off, or past the day's cap", async () => {
    w.ai = aiReply(`${STORY_TEXT} You will die young.`);
    const a = await person({ TAROT_AI: "true" });
    const bad = (await (await get(`/tarot/api/story/${a.readingId}`, a.cookie, { TAROT_AI: "true" })).json()) as { by: string; text: string };
    expect(bad.by).toBe("rules");
    expect(bad.text).toMatch(/^You asked/);
    expect(await w.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'TAROT_STORY_REJECTED'")).toBe(1);
    const b = await person();
    expect(((await (await get(`/tarot/api/story/${b.readingId}`, b.cookie)).json()) as { by: string }).by).toBe("rules");
    for (let i = 0; i < STORY.perDayTotal; i++) await w.db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, 'bot', 'TAROT_STORY', 'x', '')").bind(new Date().toISOString()).run();
    w.ai = aiReply(STORY_TEXT);
    const calls = w.aiCalls().length;
    expect(((await (await get(`/tarot/api/story/${b.readingId}`, b.cookie, { TAROT_AI: "true" })).json()) as { by: string }).by).toBe("rules");
    expect(w.aiCalls().length).toBe(calls);
  });
  it("are only ever for the person's own reading", async () => {
    const a = await person();
    const b = await person();
    expect((await get(`/tarot/api/story/${b.readingId}`, a.cookie)).status).toBe(404);
    expect((await get(`/tarot/api/voice/${b.readingId}`, a.cookie, { TAROT_VOICE: "true", AI: { run: async () => new Uint8Array([1]) } })).status).toBe(404);
  });
});

describe("the voice", () => {
  it("is an MP3 from Workers AI in a calm female voice when on, a 404 when off, a 503 when it fails", async () => {
    const { cookie, readingId } = await person();
    expect((await get(`/tarot/api/voice/${readingId}`, cookie)).status).toBe(404);
    const run = vi.fn(async () => new Uint8Array([0x49, 0x44, 0x33]));
    const on = await get(`/tarot/api/voice/${readingId}`, cookie, { TAROT_VOICE: "true", AI: { run } });
    expect(on.status).toBe(200);
    expect(on.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await on.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(run).toHaveBeenCalledWith("@cf/deepgram/aura-2-en", expect.objectContaining({ speaker: "cora", encoding: "mp3", text: expect.stringMatching(/^You asked: How can I feel closer/) }));
    const failing = await get(`/tarot/api/voice/${readingId}`, cookie, { TAROT_VOICE: "true", AI: { run: async () => { throw new Error("4006"); } } });
    expect(failing.status).toBe(503);
    expect(((await (await get(`/tarot/api/story/${readingId}`, cookie, { TAROT_VOICE: "true", AI: { run } })).json()) as { voice: boolean }).voice).toBe(true);
  });
  it("reads any shape Workers AI returns, and speaks without quotation marks", async () => {
    expect(await audioBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(await audioBytes(new Uint8Array([3]).buffer)).toEqual(new Uint8Array([3]));
    expect(await audioBytes({ audio: btoa("ab") })).toEqual(new Uint8Array([97, 98]));
    expect(await audioBytes(new Response(new Uint8Array([7])).body)).toEqual(new Uint8Array([7]));
    expect(await audioBytes({})).toBeNull();
    expect(speakable('You asked: "Why?"\n\nBreathe.')).toBe("You asked: Why? … Breathe.");
  });
});
