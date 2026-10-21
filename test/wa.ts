// A small WhatsApp test harness for the assistant tests: a local D1, signed webhook posts, fake Meta / Razorpay / Anthropic / email.
// Nothing real is called. All data is synthetic.
import { vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { type Lang } from "../src/copy";
import { AI_TOOL_NAME } from "../src/ai";
import { FakeRazorpay, rzpEnv } from "./razorpay";
import { newDb } from "./db";

export const SECRET = "test-app-secret";
// Mon 2026-10-05, 11:30 IST.
export const NOW = Date.parse("2026-10-05T06:00:00Z");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type Email = { to: string; from: string; subject: string; text: string };
export type AiReply = Response | Json | ((body: Json) => Response | Json);

export const aiResponse = (out: unknown, usage: Record<string, number> = { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, extra: object = {}) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", name: AI_TOOL_NAME, input: out }], stop_reason: "tool_use", usage, ...extra }), { status: 200 });

export class Wa {
  db!: D1Database;
  close: () => Promise<void> = async () => {};
  fetchMock!: ReturnType<typeof vi.fn>;
  fake = new FakeRazorpay();
  emails: Email[] = [];
  sends = "true";
  aiFlag = "true";
  key = "sk-ant-test-key";
  // What the fake Anthropic API answers; set per test.
  ai: AiReply = {};
  private n = 0;
  private phone = 919820000000;

  env = () =>
    ({
      DB: this.db, SENDS: this.sends, AI_REPLIES: this.aiFlag, ANTHROPIC_API_KEY: this.key, NEW_BOOKINGS: "true", WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "v", WA_TOKEN: "tok",
      WA_PHONE_ID: "1000", CHAT_RETENTION_MINUTES: "10", DIGEST_TO: "ops@example.invalid", PUBLIC_URL: "https://bot.example.test",
      EMAIL: { send: async (m: Email) => void this.emails.push(m) }, ...rzpEnv(),
    }) as never;
  sent = (): Json[] => this.fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("graph.facebook.com")).map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
  last = (): Json => this.sent().at(-1);
  texts = () => this.sent().map((p: Json) => p.text?.body ?? p.interactive?.body?.text);
  aiCalls = (): Json[] => this.fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("api.anthropic.com")).map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
  aiHeaders = (): Record<string, string>[] => this.fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("api.anthropic.com")).map((c: unknown[]) => (c[1] as { headers: Record<string, string> }).headers);
  count = async (sql: string) => (await this.db.prepare(sql).first<{ n: number }>())!.n;
  newPhone = () => String(++this.phone);
  conv = async (from: string) => (await this.db.prepare("SELECT * FROM conversations WHERE wa_id = ?1").bind(from).first<Json>())!;
  state = async (from: string) => (await this.db.prepare("SELECT * FROM person_state WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)").bind(from).first<Json>())!;
  setState = (from: string, sql: string, ...binds: unknown[]) =>
    this.db.prepare(`UPDATE person_state SET ${sql} WHERE conversation_id = (SELECT id FROM conversations WHERE wa_id = ?1)`).bind(from, ...binds).run();
  nextId = () => `wamid.T${++this.n}`;

  private wrap(from: string, extra: object) {
    return { entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: this.nextId(), from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] };
  }
  post = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const sig = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, this.env());
  };
  typed = (from: string, body: string, extra: object = {}) => this.post(this.wrap(from, { type: "text", text: { body }, ...extra }));
  tap = (from: string, id: string) => this.post(this.wrap(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } }));
  tapRow = (from: string, id: string) => this.post(this.wrap(from, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title: id } } }));
  media = (from: string, type: string) => this.post(this.wrap(from, { type, [type]: { id: "media-id-1" } }));
  // A greeted person who has chosen a language, so no booking step is open.
  greeted = async (lang: Lang = "en", from = this.newPhone()) => {
    await this.typed(from, "hi");
    await this.tap(from, `lang_${lang}`);
    this.fetchMock.mockClear();
    this.emails.length = 0;
    return from;
  };
  ageOk = (from: string) => this.db.prepare("UPDATE conversations SET age_ok_at = '2026-01-01T00:00:00Z' WHERE wa_id = ?1").bind(from).run();

  // Call this in beforeEach.
  start = async () => {
    ({ db: this.db, close: this.close } = await newDb());
    this.sends = "true";
    this.aiFlag = "true";
    this.key = "sk-ant-test-key";
    this.emails = [];
    this.fake = new FakeRazorpay();
    this.ai = { label: "relevant_question", language: "en", script: "latin", reply: "Pranic healing is a no-touch energy healing practice.", next: "ask_more" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    this.fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++this.n}` }] }), { status: 200 });
      if (u.includes("api.anthropic.com")) {
        const r = typeof this.ai === "function" ? this.ai(JSON.parse(init.body ?? "{}")) : this.ai;
        return r instanceof Response ? r : aiResponse(r);
      }
      return this.fake.handle(u, init) ?? new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", this.fetchMock);
  };
  stop = async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await this.close();
  };
}
