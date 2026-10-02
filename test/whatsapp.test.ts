import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { sendMessage } from "../src/send";
import { newDb } from "./db";

const SECRET = "test-app-secret";
const PHONE = "919999999999"; // synthetic
let db: D1Database;
let close: () => Promise<void>;
let sends: "true" | "false";
let fetchMock: ReturnType<typeof vi.fn>;
let n = 0;

const env = () => ({ DB: db, SENDS: sends, WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "verify-me", WA_TOKEN: "tok", WA_PHONE_ID: "1000" }) as never;

async function sign(raw: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw, secret) } }, env());
}

const wrap = (value: object) => ({ entry: [{ changes: [{ value }] }] });
const now = () => String(Math.floor(Date.now() / 1000));
function inbound(id: string, extra: object, from = PHONE) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name: "Test Person" } }],
    messages: [{ id, from, timestamp: now(), ...extra }],
  });
}
const text = (id: string, body = "hello") => inbound(id, { type: "text", text: { body } });
const button = (id: string, btn: string) => inbound(id, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: btn, title: btn } } });
const listPick = (id: string, row: string) => inbound(id, { type: "interactive", interactive: { type: "list_reply", list_reply: { id: row, title: row } } });

const sent = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

beforeEach(async () => {
  ({ db, close } = await newDb());
  sends = "true";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe("GET /wa/webhook verification", () => {
  it("echoes the challenge as plain text for the right token", async () => {
    const res = await app.request("/wa/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345", {}, env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });
  it("403s for a wrong token or mode", async () => {
    expect((await app.request("/wa/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1", {}, env())).status).toBe(403);
    expect((await app.request("/wa/webhook?hub.mode=other&hub.verify_token=verify-me&hub.challenge=1", {}, env())).status).toBe(403);
  });
});

describe("POST /wa/webhook", () => {
  it("bad or missing signature -> 401 and nothing stored or sent", async () => {
    const res = await post(text("wamid.A1"), "wrong-secret");
    expect(res.status).toBe(401);
    const raw = JSON.stringify(text("wamid.A2"));
    expect((await app.request("/wa/webhook", { method: "POST", body: raw }, env())).status).toBe(401);
    expect(await count("SELECT COUNT(*) n FROM events")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM conversations")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM messages")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a validly signed but malformed payload without storing", async () => {
    expect((await post({ entry: "nope" })).status).toBe(400);
    expect(await count("SELECT COUNT(*) n FROM events")).toBe(0);
  });

  it("first message -> greeting with language buttons, sent once; replay sends nothing new", async () => {
    expect((await post(text("wamid.B1"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sent()[0];
    expect(body.to).toBe(PHONE);
    expect(body.interactive.body.text).toContain("booking assistant");
    expect(body.interactive.body.text).toContain("Shantha Rao");
    expect(body.interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title)).toEqual(["English", "ಕನ್ನಡ"]);

    expect((await post(text("wamid.B1"))).status).toBe(200); // replay
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await count("SELECT COUNT(*) n FROM events")).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM messages WHERE direction = 'OUT'")).toBe(1);

    // a different first-ish message later does not greet again
    await post(button("wamid.B2", "lang_en"));
    expect(sent().filter((b) => b.interactive?.body.text.includes("booking assistant"))).toHaveLength(1);
  });

  it("handles every message in a batch", async () => {
    const other = "919999999998";
    const batch = wrap({
      messages: [
        { id: "wamid.C1", from: PHONE, timestamp: now(), type: "text", text: { body: "hi" } },
        { id: "wamid.C2", from: other, timestamp: now(), type: "text", text: { body: "hi" } },
      ],
    });
    await post(batch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await count("SELECT COUNT(*) n FROM conversations")).toBe(2);
  });

  it("stores name, last_user_at and the ad referral source id", async () => {
    await post(inbound("wamid.D1", { type: "text", text: { body: "hi" }, referral: { source_id: "AD_123" } }));
    const c = await db.prepare("SELECT display_name, source_ad_id, last_user_at FROM conversations WHERE wa_id = ?1").bind(PHONE).first<Record<string, string>>();
    expect(c).toMatchObject({ display_name: "Test Person", source_ad_id: "AD_123" });
    expect(c!.last_user_at).toBeTruthy();
  });

  it("button replies route: language -> menu, menu -> booking / list / ask, list row -> answer", async () => {
    await post(text("wamid.E0")); // greeting
    fetchMock.mockClear();

    await post(button("wamid.E1", "lang_en"));
    const menu = sent()[0].interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title);
    expect(menu).toEqual(["Book a ₹99 call", "How it works", "Ask a question"]);
    fetchMock.mockClear();

    await post(button("wamid.E2", "menu_book"));
    expect(sent()[0].text.body).toBe("Booking opens soon.");
    expect(await count("SELECT COUNT(*) n FROM attention")).toBe(0);
    fetchMock.mockClear();

    await post(button("wamid.E3", "menu_how"));
    const rows = sent()[0].interactive.action.sections[0].rows;
    expect(rows.map((r: { id: string }) => r.id)).toEqual(config.faqIds.map((id) => `faq_${id}`));
    expect(rows.length).toBeLessThanOrEqual(10);
    fetchMock.mockClear();

    await post(listPick("wamid.E4", "faq_price"));
    expect(sent()[0].text.body).toContain("₹99");
    expect(sent()[1].interactive.action.buttons).toHaveLength(3); // menu again
    expect(await count("SELECT COUNT(*) n FROM attention")).toBe(0);
  });

  it("free text -> one reply and one attention item; repeats within 24h get neither again", async () => {
    await post(text("wamid.F0"));
    await post(button("wamid.F1", "lang_en"));
    fetchMock.mockClear();

    await post(text("wamid.F2", "can you call me about my problem"));
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text.body).toBe("Thanks, a person will reply within 24 hours.");
    expect(await count("SELECT COUNT(*) n FROM attention WHERE kind = 'FREE_TEXT' AND resolved_at IS NULL")).toBe(1);

    await post(text("wamid.F3", "hello?"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await count("SELECT COUNT(*) n FROM attention")).toBe(1);
  });

  it("status webhooks update the outbound row and create nothing else", async () => {
    await post(text("wamid.G1"));
    const out = await db.prepare("SELECT wa_message_id FROM messages WHERE direction = 'OUT'").first<{ wa_message_id: string }>();
    const st = (status: string) => wrap({ statuses: [{ id: out!.wa_message_id, status, recipient_id: PHONE }] });

    await post(st("delivered"));
    expect((await db.prepare("SELECT status, delivery FROM messages WHERE wa_message_id = ?1").bind(out!.wa_message_id).first())).toEqual({ status: "SENT", delivery: "delivered" });
    await post(st("read"));
    await post(st("delivered")); // out of order: never downgrades
    expect((await db.prepare("SELECT delivery FROM messages WHERE wa_message_id = ?1").bind(out!.wa_message_id).first())).toEqual({ delivery: "read" });
    await post(st("failed"));
    expect((await db.prepare("SELECT status FROM messages WHERE wa_message_id = ?1").bind(out!.wa_message_id).first())).toEqual({ status: "FAILED" });

    expect(await count("SELECT COUNT(*) n FROM conversations")).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM intros")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM sessions")).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the greeting
  });

  it("blocked contact gets nothing (by blocks table)", async () => {
    await db.prepare("INSERT INTO blocks (wa_id, reason, by) VALUES (?1, 'test', 'test')").bind(PHONE).run();
    expect((await post(text("wamid.H1"))).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM messages WHERE direction = 'OUT'")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM attention")).toBe(0);
    expect((await db.prepare("SELECT mode FROM conversations WHERE wa_id = ?1").bind(PHONE).first())).toEqual({ mode: "BLOCKED" });
  });

  it("SENDS=false -> rows are SKIPPED and Meta is never called", async () => {
    sends = "false";
    await post(text("wamid.I1"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM messages WHERE direction = 'OUT' AND status = 'SKIPPED'")).toBe(1);
  });
});

describe("sendMessage", () => {
  async function person(lastUserAt: string | null) {
    const r = await db.prepare("INSERT INTO conversations (wa_id, last_user_at) VALUES (?1, ?2)").bind(PHONE, lastUserAt).run();
    return r.meta.last_row_id;
  }

  it("blocks free-form outside 24h and raises attention; allows it inside", async () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const id = await person(old);
    expect(await sendMessage(env(), id, { type: "text", text: "hi" }, "k1")).toBe("WINDOW_CLOSED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM messages")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM attention WHERE kind = 'OUTSIDE_WINDOW'")).toBe(1);

    await db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(id, new Date().toISOString()).run();
    expect(await sendMessage(env(), id, { type: "text", text: "hi" }, "k1")).toBe("SENT");
    expect(await sendMessage(env(), id, { type: "text", text: "hi" }, "k1")).toBe("DUPLICATE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unapproved template raises attention instead of sending, even outside the window", async () => {
    const id = await person(null);
    expect(await sendMessage(env(), id, { type: "template", name: "call_booked", params: ["x"] }, "t1")).toBe("TEMPLATE_UNAPPROVED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM attention WHERE kind = 'TEMPLATE_UNAPPROVED'")).toBe(1);
  });

  it("timeout -> UNKNOWN with no resend; 4xx -> FAILED", async () => {
    const id = await person(new Date().toISOString());
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await sendMessage(env(), id, { type: "text", text: "a" }, "u1")).toBe("UNKNOWN");
    expect(await sendMessage(env(), id, { type: "text", text: "a" }, "u1")).toBe("DUPLICATE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await sendMessage(env(), id, { type: "text", text: "b" }, "u2")).toBe("FAILED");
  });

  it("builds list, CTA and approved-template payloads within Meta limits", async () => {
    const { buildPayload } = await import("../src/send");
    expect(() => buildPayload({ type: "buttons", body: "x", buttons: [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: "t" })) }, PHONE)).toThrow();
    expect(() => buildPayload({ type: "list", body: "x", button: "b", rows: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: "t" })) }, PHONE)).toThrow();
    expect(() => buildPayload({ type: "cta", body: "x", label: "a label way over twenty", url: "https://example.com" }, PHONE)).toThrow();
    const cta = buildPayload({ type: "cta", body: "x", label: "Pay now", url: "https://example.com/p" }, PHONE) as { interactive: { type: string } };
    expect(cta.interactive.type).toBe("cta_url");
    const tpl = buildPayload({ type: "template", name: "reminder", params: ["a"] }, PHONE) as { template: { name: string } };
    expect(tpl.template.name).toBe("reminder");
  });
});
