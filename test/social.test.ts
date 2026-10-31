// Ticket 32: Instagram DMs and Messenger. All ids and text are synthetic; Meta is a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { config } from "../src/config";
import { allCopy } from "../src/copy";
import { cleanSocial, detectLang, FOLLOWING, METADATA, socialWords } from "../src/social";
import { iso } from "../src/slots";
import { newDb } from "./db";

const SECRET = "test-app-secret";
const NOW = Date.parse("2026-10-30T06:00:00Z");
const HOUR = 3_600_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: D1Database;
let close: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;
let flags: { SOCIAL_REPLIES: string; SENDS: string };
let follows: boolean | "error" | "timeout";
let commentRecipient: string | null; // the messaging id Meta answers a private reply with
let refuseTemplateReply: boolean;
let n = 0;

let emails: { to: string; subject: string; text: string }[];
const env = () =>
  ({ DB: db, ...flags, DIGEST_TO: "owner@example.invalid", EMAIL: { send: async (m: { to: string; subject: string; text: string }) => void emails.push(m) }, WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: "wa-verify", WA_TOKEN: "tok", WA_PHONE_ID: "1000", META_VERIFY_TOKEN: "meta-verify", META_PAGE_TOKEN: "ptok", META_PAGE_ID: "PAGE1", META_IG_ID: "IG1" }) as never;

async function sign(raw: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function post(body: unknown, path = "/meta/webhook", secret = SECRET) {
  const raw = JSON.stringify(body);
  return app.request(path, { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw, secret) } }, env());
}

const ids = { instagram: "IG1", messenger: "PAGE1" } as const;
type P = keyof typeof ids;
const wrap = (p: P, items: object[]) => ({ object: p === "instagram" ? "instagram" : "page", entry: [{ id: ids[p], time: Date.now(), messaging: items }] });
const from = (user: string, p: P, extra: object) => ({ sender: { id: user }, recipient: { id: ids[p] }, timestamp: Date.now(), ...extra });
let mid = 0;
const dm = (p: P, user: string, text: string) => wrap(p, [from(user, p, { message: { mid: `m_in${++mid}`, text } })]);
const tap = (p: P, user: string) => wrap(p, [from(user, p, { postback: { mid: `m_pb${++mid}`, title: "I'm following", payload: FOLLOWING } })]);
const media = (p: P, user: string, type: string) => wrap(p, [from(user, p, { message: { mid: `m_a${++mid}`, attachments: [{ type, payload: { url: "https://cdn.example.invalid/x" } }] } })]);
const qrFollow = (user: string) => wrap("messenger", [from(user, "messenger", { message: { mid: `m_qf${++mid}`, text: "I've followed", quick_reply: { payload: FOLLOWING } } })]);
const qr = (p: P, user: string, topic: string, id: string) => wrap(p, [from(user, p, { message: { mid: `m_${id}`, text: "tapped title", quick_reply: { payload: `SOCIAL_Q_${topic.toUpperCase()}` } } })]);
const WA_BOOK = `https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=${encodeURIComponent("Hi, I'd like to book a ₹99 call")}`;
const WA_BOOK_HI = `https://wa.me/${config.businessNumber.replace(/\D/g, "")}?text=${encodeURIComponent("नमस्ते, मुझे ₹99 की कॉल बुक करनी है")}`;
const PAGE = config.social.facebookPageUrl;
// Messenger: plain text with the links written out (the Facebook app can't show button templates), quick replies for the taps.
const msgrAsk = (w = socialWords("en")) => `${w.ask}\n\n${w.pageLabel}: ${PAGE}`;
const msgrAskAgain = (w = socialWords("en"), link = WA_BOOK) => `${w.askAgain}\n\n${w.pageLabel}: ${PAGE}\n${w.btnBook}: ${link}`;
const withLink = (text: string, w = socialWords("en"), link = WA_BOOK) => `${text}\n\n${w.btnBook}: ${link}`;
const followQr = (title = "I've followed") => [{ content_type: "text", title, payload: FOLLOWING }];
const QR_EN = [
  { content_type: "text", title: "Book a ₹99 call", payload: "SOCIAL_Q_BOOK" },
  { content_type: "text", title: "Prices", payload: "SOCIAL_Q_PRICE" },
  { content_type: "text", title: "About Pranic Healing", payload: "SOCIAL_Q_WHAT" },
  { content_type: "text", title: "How the call works", payload: "SOCIAL_Q_HOW" },
];
const echo = (p: P, user: string, message: object) => wrap(p, [{ sender: { id: ids[p] }, recipient: { id: user }, timestamp: Date.now(), message: { mid: `m_echo${++mid}`, is_echo: true, ...message } }]);

const calls = () => fetchMock.mock.calls.map((c) => ({ url: String(c[0]), init: c[1] as { method?: string; body?: string; headers: Record<string, string> } }));
const sent = (): Json[] => calls().filter((c) => c.init.method === "POST" && !/\/(replies|comments)$/.test(c.url)).map((c) => JSON.parse(c.init.body!));
const publicReplies = () => calls().filter((c) => c.init.method === "POST" && /\/(replies|comments)$/.test(c.url)).map((c) => ({ url: c.url, body: JSON.parse(c.init.body!) }));
const social = config.social as { publicReply: boolean };
const profileCalls = () => calls().filter((c) => c.url.includes("fields=is_user_follow_business"));
const bodyOf = (m: Json): string => m.message.text ?? m.message.attachment.payload.text;
const buttonsOf = (m: Json): Json[] => m.message.attachment?.payload?.buttons ?? [];
const contact = (p: P, user: string) => db.prepare("SELECT * FROM social_contacts WHERE platform = ?1 AND user_id = ?2").bind(p, user).first<Json>();
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
const at = (ms: number) => vi.setSystemTime(ms);

beforeEach(async () => {
  ({ db, close } = await newDb());
  flags = { SOCIAL_REPLIES: "true", SENDS: "true" };
  follows = true;
  commentRecipient = "IGSID1";
  emails = [];
  refuseTemplateReply = false;
  social.publicReply = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  at(NOW);
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (String(url).includes("is_user_follow_business")) {
      if (follows === "timeout") throw new Error("timeout");
      if (follows === "error") return new Response(JSON.stringify({ error: { code: 230 } }), { status: 400 });
      return new Response(JSON.stringify({ is_user_follow_business: follows, id: "x" }), { status: 200 });
    }
    if (init?.method === "POST" && String(url).endsWith("/messages")) {
      const b = JSON.parse((init as { body: string }).body);
      if (b.recipient?.comment_id && b.message?.attachment && refuseTemplateReply) return new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 });
      return new Response(JSON.stringify({ recipient_id: b.recipient?.comment_id ? commentRecipient : b.recipient?.id, message_id: `m_out${++n}` }), { status: 200 });
    }
    if (init?.method === "POST" && String(url).includes("graph.facebook.com")) return new Response(JSON.stringify({ id: `reply${++n}`, messages: [{ id: `wamid.OUT${n}` }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close();
});

const en = () => socialWords("en");
const hi = () => socialWords("hi");

describe("GET /meta/webhook verification", () => {
  it("echoes the challenge for META_VERIFY_TOKEN, and 403s for a wrong token, the WhatsApp token or a wrong mode", async () => {
    const ok = await app.request("/meta/webhook?hub.mode=subscribe&hub.verify_token=meta-verify&hub.challenge=777", {}, env());
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    for (const q of ["hub.mode=subscribe&hub.verify_token=nope", "hub.mode=subscribe&hub.verify_token=wa-verify", "hub.mode=other&hub.verify_token=meta-verify"]) {
      expect((await app.request(`/meta/webhook?${q}&hub.challenge=1`, {}, env())).status, q).toBe(403);
    }
  });
});

describe("POST /meta/webhook", () => {
  it("a bad or missing signature is a 401 and nothing is stored or sent", async () => {
    expect((await post(dm("instagram", "U1", "hi"), "/meta/webhook", "wrong")).status).toBe(401);
    expect((await app.request("/meta/webhook", { method: "POST", body: JSON.stringify(dm("instagram", "U1", "hi")) }, env())).status).toBe(401);
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM social_seen")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with META_APP_SECRET set (a separate Meta app), only that secret signs; unset, WA_APP_SECRET does", async () => {
    const raw = JSON.stringify(dm("instagram", "U1", "hi"));
    const req = async (secret: string, extra: object) =>
      (await app.request("/meta/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": await sign(raw, secret) } }, { ...(env() as object), ...extra } as never)).status;
    expect(await req(SECRET, { META_APP_SECRET: "other-app-secret" })).toBe(401);
    expect(await req("other-app-secret", { META_APP_SECRET: "other-app-secret" })).toBe(200);
    expect(await req(SECRET, { META_APP_SECRET: "" })).toBe(200);
    // The WhatsApp webhook keeps WA_APP_SECRET only.
    expect((await app.request("/wa/webhook", { method: "POST", body: "{}", headers: { "X-Hub-Signature-256": await sign("{}", "other-app-secret") } }, { ...(env() as object), META_APP_SECRET: "other-app-secret" } as never)).status).toBe(401);
  });

  it("ignores reads, deliveries, reactions, story mentions, deleted messages, no sender, another account and odd bodies, with a 200", async () => {
    const items = [
      from("U1", "instagram", { read: { mid: "m_x" } }),
      from("U1", "instagram", { delivery: { mids: ["m_x"] } }),
      from("U1", "instagram", { reaction: { mid: "m_x", action: "react", reaction: "love" } }),
      from("U1", "instagram", { message: { mid: "m_s1", attachments: [{ type: "story_mention", payload: { url: "https://cdn.example.invalid/s" } }] } }),
      from("U1", "instagram", { message: { mid: "m_d1", is_deleted: true } }),
      { recipient: { id: "IG1" }, timestamp: 1, message: { mid: "m_n1", text: "hi" } },
      from("U1", "instagram", { message: { admin_text: "handoff" } }),
      from("U1", "instagram", { referral: { ref: "x", type: "OPEN_THREAD" } }),
    ];
    expect((await post(wrap("instagram", items))).status).toBe(200);
    expect((await post({ object: "instagram", entry: [{ id: "SOMEONE_ELSE", messaging: [from("U1", "instagram", { message: { mid: "m_o1", text: "hi" } })] }] })).status).toBe(200);
    expect((await post({ object: "whatsapp_business_account", entry: [] })).status).toBe(200);
    expect((await post("not an object")).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(0);
  });

  it("Instagram: any first DM gets the follow ask with [Visit profile] and [I'm following], sent with the Page token", async () => {
    expect((await post(dm("instagram", "U1", "hi"))).status).toBe(200);
    const [m] = sent();
    expect(calls()[0].url).toBe(`https://graph.facebook.com/${config.graphVersion}/PAGE1/messages`);
    expect(calls()[0].init.headers.Authorization).toBe("Bearer ptok");
    expect(m.recipient).toEqual({ id: "U1" });
    expect(m.messaging_type).toBeUndefined();
    expect(bodyOf(m)).toBe(en().ask);
    expect(bodyOf(m)).toBe("Namaste, and thank you for your interest in Disha Dira! We share a short Pranic Healing tip every week. Please follow us, then tap below and our booking assistant will help you with a session.");
    expect(buttonsOf(m)).toEqual([
      { type: "web_url", url: config.social.instagramUrl, title: "Visit profile" },
      { type: "postback", title: "I'm following", payload: FOLLOWING },
    ]);
    expect((await contact("instagram", "U1")).step).toBe("ASKED");
  });

  it("Messenger: the follow ask is plain text with the Page link and the quick reply [I've followed], a RESPONSE with our metadata", async () => {
    await post(dm("messenger", "P1", "hello there"));
    const [m] = sent();
    expect(m.messaging_type).toBe("RESPONSE");
    expect(m.message).toEqual({ text: msgrAsk(), quick_replies: followQr(), metadata: METADATA });
    expect(m.message.text).toBe(`${en().ask}\n\nOur Page: https://www.facebook.com/profile.php?id=61588921902210`);
    // Tapping the quick reply (message.quick_reply.payload) sends the way to book.
    await post(qrFollow("P1"));
    expect(sent().at(-1).message.text).toBe(withLink(en().guide));
  });

  it("every first message gets only the follow ask, keyword or not; the topic is kept as a code, and answered once they follow", async () => {
    const cases: [string, string | null][] = [
      ["How much does it cost?", "price"],
      ["Can I book an appointment", "book"],
      ["I live in Dubai, can I join?", "where"],
      ["what is pranic healing?", "what"],
      ["how does the call work", "how"],
      ["do you give a refund", "refund"],
      ["hello", null],
      ["Can it cure my diabetes? what is the price", null], // never a medical answer
    ];
    for (const [i, [text, topic]] of cases.entries()) {
      await post(dm("instagram", `K${i}`, text));
      expect(bodyOf(sent().at(-1)), text).toBe(en().ask);
      expect((await contact("instagram", `K${i}`)).topic, text).toBe(topic);
    }
    expect(sent()).toHaveLength(cases.length);
    // Once K0 follows: the price line first, then the way to book.
    await post(tap("instagram", "K0"));
    const [guide, questions] = sent().slice(-2);
    expect(bodyOf(guide)).toBe(`A first 15-minute call with Shantha Rao is ₹99. A session is ₹799, or 10 sessions for ₹5,000 and 20 for ₹9,000.\n\n${en().guide}`);
    expect(buttonsOf(guide)).toEqual([{ type: "web_url", url: WA_BOOK, title: "Book on WhatsApp" }]);
    expect(guide.message.quick_replies).toBeUndefined(); // Instagram: quick replies only on text
    expect(questions.message).toEqual({ text: en().questions, quick_replies: QR_EN });
    expect((await contact("instagram", "K0")).topic).toBeNull();
    // The medical one gets no answer line: only the way to book (where the WhatsApp bot's safety rules apply).
    await post(tap("instagram", "K7"));
    expect(bodyOf(sent().at(-2))).toBe(en().guide);
    expect(en().lines.what).toContain("complements medical care and is not a substitute");
    expect(en().guide).toContain("automated booking assistant");
  });

  it("Hindi: Devanagari or Roman Hindi gets the Hindi ask and buttons, and the Hindi answer after the follow", async () => {
    await post(dm("instagram", "H1", "इसकी फीस कितनी है?"));
    expect(bodyOf(sent()[0])).toBe(hi().ask);
    expect(buttonsOf(sent()[0]).map((b: Json) => b.title)).toEqual(["प्रोफ़ाइल देखें", "मैंने फ़ॉलो किया"]);
    await post(dm("messenger", "H2", "pranic healing kya hai"));
    expect(bodyOf(sent()[1])).toBe(msgrAsk(hi()));
    expect(sent()[1].message.quick_replies).toEqual(followQr("मैंने फ़ॉलो किया"));
    await post(tap("messenger", "H2"));
    expect(bodyOf(sent().at(-1))).toBe(withLink(`${hi().lines.what}\n\n${hi().guide}`, hi(), WA_BOOK_HI));
    expect(sent().at(-1).message.quick_replies.map((q: Json) => q.title)).toEqual(["₹99 कॉल बुक करें", "फ़ीस", "प्राणिक हीलिंग", "कॉल कैसे होती है"]);
    expect((await contact("messenger", "H2")).lang).toBe("hi");
    expect(detectLang("hello, I want to know more", "hi")).toBe("en");
    expect(detectLang("ok", "hi")).toBe("hi");
  });

  it("Instagram, following: the profile check says yes, so the way to book goes (guide, then the questions)", async () => {
    await post(dm("instagram", "U1", "hi"));
    await post(tap("instagram", "U1"));
    expect(profileCalls()).toHaveLength(1);
    expect(profileCalls()[0].url).toContain("/U1?fields=is_user_follow_business");
    const [guide, questions] = sent().slice(-2);
    expect(bodyOf(guide)).toBe(en().guide);
    expect(buttonsOf(guide)).toEqual([{ type: "web_url", url: WA_BOOK, title: "Book on WhatsApp" }]);
    expect(questions.message.quick_replies).toEqual(QR_EN);
    const row = await contact("instagram", "U1");
    expect(row.step).toBe("LINKED");
    expect(row.link_sent_at).toBe(iso(NOW));
  });

  it("Instagram, not following: 'not yet' with the two buttons; the second tap goes through anyway, without another check", async () => {
    follows = false;
    await post(dm("instagram", "U1", "hi"));
    await post(tap("instagram", "U1"));
    expect(bodyOf(sent().at(-1))).toBe(en().notYet);
    expect(buttonsOf(sent().at(-1)).map((b: Json) => b.type)).toEqual(["web_url", "postback"]);
    expect((await contact("instagram", "U1")).step).toBe("RECHECK");
    await post(tap("instagram", "U1"));
    expect(profileCalls()).toHaveLength(1);
    expect(bodyOf(sent().at(-2))).toBe(en().guide);
    expect((await contact("instagram", "U1")).step).toBe("LINKED");
  });

  it("Instagram: a failed or timed-out profile check sends the way to book (fail open)", async () => {
    for (const [i, f] of (["error", "timeout"] as const).entries()) {
      follows = f;
      await post(tap("instagram", `F${i}`));
      expect(bodyOf(sent().at(-2)), f).toBe(en().guide);
    }
  });

  it("Messenger: 'I've followed' sends the way to book straight away, in one message with the questions; Hindi gets Hindi", async () => {
    await post(dm("messenger", "P1", "namaste ji"));
    await post(tap("messenger", "P1"));
    expect(profileCalls()).toHaveLength(0);
    expect(sent()).toHaveLength(2);
    const m = sent().at(-1);
    expect(m.message.attachment).toBeUndefined();
    expect(bodyOf(m)).toBe(`${hi().guide}\n\nWhatsApp पर बुक करें: ${WA_BOOK_HI}`);
    expect(m.message.quick_replies).toHaveLength(4);
  });

  it("after the follow, each question tapped gets one line and [Book on WhatsApp], once a day per question", async () => {
    await post(tap("messenger", "P1"));
    const before = sent().length;
    for (const [i, t] of (["book", "price", "what", "how", "price"] as const).entries()) await post(qr("messenger", "P1", t, `qa${i}`));
    const answers = sent().slice(before);
    expect(answers.map(bodyOf)).toEqual([en().lines.book, en().lines.price, en().lines.what, en().lines.how].map((l) => withLink(l)));
    for (const a of answers) expect(a.message.quick_replies).toEqual(QR_EN);
    expect(en().lines.how).toContain("calls the number you book from on WhatsApp, at the time you pick");
    // Instagram: the answer is the line and the button (quick replies only go on text there).
    await post(tap("instagram", "U1"));
    await post(qr("instagram", "U1", "how", "qa9"));
    expect(bodyOf(sent().at(-1))).toBe(en().lines.how);
    expect(sent().at(-1).message.quick_replies).toBeUndefined();
  });

  it("after the follow: a typed question gets its line and the button; other messages get the WhatsApp pointer at most every 6 hours", async () => {
    await post(tap("messenger", "P1"));
    const before = sent().length;
    await post(dm("messenger", "P1", "thanks!"));
    expect(sent().at(-1).message).toEqual({ text: en().after(WA_BOOK), quick_replies: QR_EN, metadata: METADATA });
    expect(bodyOf(sent().at(-1))).toMatch(/^For bookings and questions, message us on WhatsApp:\nhttps:\/\/wa\.me\/\d+\?text=.*\nWe reply there\.$/);
    await post(dm("messenger", "P1", "ok"));
    expect(sent()).toHaveLength(before + 1); // inside 6 hours: nothing
    await post(dm("messenger", "P1", "Hello, can i book"));
    expect(bodyOf(sent().at(-1))).toBe(withLink(en().lines.book)); // a known topic is answered, past the daily cap
    await post(dm("messenger", "P1", "how much is it"));
    expect(bodyOf(sent().at(-1))).toBe(withLink(en().lines.price));
    await post(dm("messenger", "P1", "how much is it"));
    await post(tap("messenger", "P1"));
    expect(sent()).toHaveLength(before + 3); // the same topic once a day; a stray tap: nothing
    at(NOW + 7 * HOUR);
    await post(dm("messenger", "P1", "hello again"));
    expect(sent()).toHaveLength(before + 4);
    // Instagram: the pointer with the button; a voice note or photo after the link gets it too.
    await post(tap("instagram", "U1"));
    await post(media("instagram", "U1", "audio"));
    expect(bodyOf(sent().at(-1))).toBe(en().after(WA_BOOK));
    expect(buttonsOf(sent().at(-1))).toEqual([{ type: "web_url", url: WA_BOOK, title: "Book on WhatsApp" }]);
  });

  it("at most 3 automated messages per person in 24 hours; the messages after the follow still go", async () => {
    follows = false;
    for (const [i, t] of ["price?", "book a session", "where are you", "what is pranic healing"].entries()) {
      at(NOW + i * 11 * 60_000);
      await post(dm("instagram", "U1", t));
    }
    expect(sent()).toHaveLength(3); // the ask, then the ask with [Book on WhatsApp] twice; the fourth: they have the link, nothing
    expect((await contact("instagram", "U1")).autos_today).toBe(3);
    await post(tap("instagram", "U1")); // "not yet" answers a tap: past the limit
    expect(bodyOf(sent().at(-1))).toBe(en().notYet);
    await post(tap("instagram", "U1")); // the second tap goes through, past the limit
    expect(sent()).toHaveLength(6);
    expect(bodyOf(sent().at(-2))).toBe(`${en().lines.price}\n\n${en().guide}`);
    await post(dm("instagram", "U1", "thanks"));
    expect(sent()).toHaveLength(7); // the WhatsApp pointer after the follow goes past the limit, at most every 6 hours
    await post(dm("instagram", "U1", "thanks again"));
    expect(sent()).toHaveLength(7);
    at(NOW + 25 * HOUR);
    await post(dm("instagram", "U1", "thanks"));
    expect(sent()).toHaveLength(8);
  });

  it("writing again without following: the ask with [Book on WhatsApp] too; a question at once, small talk after 10 minutes", async () => {
    await post(dm("instagram", "U1", "hi"));
    await post(dm("instagram", "U1", "hello"));
    expect(sent()).toHaveLength(1); // small talk within 10 minutes: nothing
    await post(dm("instagram", "U1", "how much?"));
    expect(sent()).toHaveLength(2);
    expect(bodyOf(sent()[1])).toBe(en().askAgain);
    expect(bodyOf(sent()[1])).toBe("We share a short Pranic Healing tip every week, so please follow us and tap below. You can also book a ₹99 call with Shantha Rao on WhatsApp straight away.");
    expect(buttonsOf(sent()[1])).toEqual([
      { type: "web_url", url: config.social.instagramUrl, title: "Visit profile" },
      { type: "postback", title: "I'm following", payload: FOLLOWING },
      { type: "web_url", url: WA_BOOK, title: "Book on WhatsApp" },
    ]);
    await post(dm("instagram", "U1", "price??"));
    expect(sent()).toHaveLength(2); // within 10 minutes of that: nothing more
    expect((await contact("instagram", "U1")).topic).toBe("price"); // a later question still sets the topic
    expect((await contact("instagram", "U1")).step).toBe("ASKED"); // still asked to follow
    at(NOW + 11 * 60_000);
    await post(dm("instagram", "U1", "hi"));
    expect(sent()).toHaveLength(3);
    // Messenger: the same as text, with both links and [I've followed].
    await post(dm("messenger", "P1", "hello"));
    await post(dm("messenger", "P1", "can I book a call?"));
    expect(sent().at(-1).message).toEqual({ text: msgrAskAgain(), quick_replies: followQr(), metadata: METADATA });
  });

  it("past the daily limit, a question before the follow still gets the WhatsApp link if it hasn't gone in 6 hours", async () => {
    await db.prepare("INSERT INTO social_contacts (platform, user_id, step, last_in_at, last_auto_at, autos_since, autos_today) VALUES ('instagram', 'U1', 'ASKED', ?1, ?1, ?1, 3)").bind(iso(NOW - HOUR)).run();
    await post(dm("instagram", "U1", "how do I book?"));
    expect(bodyOf(sent().at(-1))).toBe(en().askAgain);
    at(NOW + 20 * 60_000);
    await post(dm("instagram", "U1", "hello??"));
    expect(sent()).toHaveLength(1);
    at(NOW + 7 * HOUR);
    await post(dm("instagram", "U1", "hello??"));
    expect(sent()).toHaveLength(2);
  });

  it("typed instead of tapped: following, done, ok, yes, haan, follow kiya, I followed you... count as the tap; 'not yet' doesn't", async () => {
    const yes = ["followed", "Done ✅", "ok", "Yes", "haan", "follow kiya", "I followed you", "follow kar diya", "हो गया", "फ़ॉलो कर लिया", "ji haan done"];
    for (const [i, t] of yes.entries()) {
      await post(dm("messenger", `Y${i}`, "hello"));
      await post(dm("messenger", `Y${i}`, t));
      expect((await contact("messenger", `Y${i}`)).step, t).toBe("LINKED");
    }
    // Hinglish or Hindi gets the Hindi guide.
    expect((await contact("messenger", "Y7")).lang).toBe("hi");
    expect(bodyOf(sent().at(-1))).toContain(hi().guide);
    const no = ["not yet", "no", "how do I follow?", "nahi kiya", "hello", "ok but I won't follow, check www.example.invalid"];
    for (const [i, t] of no.entries()) {
      await post(dm("messenger", `N${i}`, "hello"));
      await post(dm("messenger", `N${i}`, t));
      expect((await contact("messenger", `N${i}`)).step, t).toBe("ASKED");
    }
  });

  it("photos, voice notes, stickers, shared posts and story replies are messages; story mentions, reactions and unsends are not", async () => {
    for (const [i, type] of ["image", "audio", "ig_reel", "share"].entries()) {
      await post(media("instagram", `A${i}`, type));
      expect(bodyOf(sent().at(-1)), type).toBe(en().ask);
    }
    await post(wrap("instagram", [from("A9", "instagram", { message: { mid: "m_sr1", text: "how much?", reply_to: { story: { url: "https://cdn.example.invalid/s", id: "1" } } } })]));
    expect(bodyOf(sent().at(-1))).toBe(en().ask);
    expect((await contact("instagram", "A9")).topic).toBe("price");
    await post(wrap("messenger", [from("A8", "messenger", { message: { mid: "m_st1", sticker_id: 369239263222822, attachments: [{ type: "image", payload: { sticker_id: 369239263222822 } }] } })]));
    expect(bodyOf(sent().at(-1))).toBe(msgrAsk());
    expect(sent()).toHaveLength(6);
  });

  it("Messenger: an m.me link or ad in an existing chat (messaging_referrals) gets the follow ask once; opt-ins, handovers, Instagram referrals: nothing", async () => {
    const ref = (user: string) => wrap("messenger", [from(user, "messenger", { referral: { ref: "ad1", source: "SHORTLINK", type: "OPEN_THREAD" } })]);
    await post(ref("R1"));
    expect(sent().at(-1).message.text).toBe(msgrAsk());
    at(NOW + 60_000);
    await post(ref("R1"));
    expect(sent()).toHaveLength(1);
    await post(wrap("messenger", [from("R2", "messenger", { optin: { ref: "x" } }), from("R2", "messenger", { pass_thread_control: { new_owner_app_id: "1" } })]));
    await post(wrap("instagram", [from("R3", "instagram", { referral: { ref: "x", source: "IGME", type: "OPEN_THREAD" } })]));
    expect(sent()).toHaveLength(1);
  });

  it("a message that arrives more than 24 hours late (a delayed retry) gets nothing: a reply would be outside the messaging window", async () => {
    await post(wrap("instagram", [{ ...from("U1", "instagram", { message: { mid: "m_late", text: "hi" } }), timestamp: NOW - 25 * HOUR }]));
    await post(wrap("messenger", [{ ...from("P1", "messenger", { postback: { mid: "m_late2", payload: FOLLOWING } }), timestamp: Math.floor((NOW - 25 * HOUR) / 1000) }]));
    expect(fetchMock).not.toHaveBeenCalled();
    await post(wrap("instagram", [{ ...from("U1", "instagram", { message: { mid: "m_ok", text: "hi" } }), timestamp: NOW - 23 * HOUR }]));
    expect(sent()).toHaveLength(1);
  });

  it("spam links and promotions get the first follow ask at most, then nothing", async () => {
    await post(dm("instagram", "S1", "Grow your business! Get more leads at www.example.invalid"));
    expect(sent()).toHaveLength(1);
    expect(bodyOf(sent()[0])).toBe(en().ask);
    at(NOW + 20 * 60_000);
    await post(dm("instagram", "S1", "check https://spam.example.invalid now"));
    await post(dm("instagram", "S1", "Buy instagram followers cheap"));
    expect(sent()).toHaveLength(1);
    // Paid promotions, crypto, job seekers: the same.
    for (const [i, t] of ["I do paid promotion for pages", "Earn daily with USDT trading", "Any vacancy? I am looking for a job"].entries()) {
      await post(dm("instagram", `J${i}`, t));
      at(NOW + (30 + i) * 60_000);
      await post(dm("instagram", `J${i}`, t + " please reply?"));
    }
    expect(sent()).toHaveLength(4);
  });

  it("human takeover: a message the team wrote by hand pauses the automation for that person for 24 hours", async () => {
    await post(dm("instagram", "U1", "hi"));
    at(NOW + 5 * 60_000);
    await post(echo("instagram", "U1", { text: "Hello, this is the team" }));
    expect(Date.parse((await contact("instagram", "U1")).paused_until)).toBe(NOW + 5 * 60_000 + 24 * HOUR);
    at(NOW + 30 * 60_000);
    await post(dm("instagram", "U1", "how much?"));
    await post(tap("instagram", "U1"));
    expect(sent()).toHaveLength(1);
    at(NOW + 5 * 60_000 + 25 * HOUR);
    await post(dm("instagram", "U1", "how much?"));
    expect(sent()).toHaveLength(2);
  });

  it("our own echoes never pause: Messenger by metadata, Instagram by the stored message id or right after our send", async () => {
    await post(dm("messenger", "P1", "hi"));
    at(NOW + 5 * 60_000);
    await post(echo("messenger", "P1", { app_id: 1234, metadata: METADATA, text: "x" }));
    expect((await contact("messenger", "P1")).paused_until).toBeNull();
    await post(echo("messenger", "P1", { app_id: 263902037430900, text: "typed in the Page inbox" }));
    expect((await contact("messenger", "P1")).paused_until).not.toBeNull();

    at(NOW);
    await post(dm("instagram", "U1", "hi"));
    await post(echo("instagram", "U1", { text: "x" })); // arrives within the minute
    at(NOW + 5 * 60_000);
    const ours = wrap("instagram", [{ sender: { id: "IG1" }, recipient: { id: "U1" }, timestamp: 1, message: { mid: "m_out" + n, is_echo: true } }]);
    await post(ours);
    expect((await contact("instagram", "U1")).paused_until).toBeNull();
  });

  it("SOCIAL_REPLIES not \"true\": 200, and nothing stored or sent", async () => {
    for (const v of ["false", "", "TRUE"]) {
      flags.SOCIAL_REPLIES = v;
      expect((await post(dm("instagram", "U1", "hi"))).status).toBe(200);
      expect((await post(tap("messenger", "P1"))).status).toBe(200);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM social_seen")).toBe(0);
    // The verify GET still works with the switch off.
    expect(await (await app.request("/meta/webhook?hub.mode=subscribe&hub.verify_token=meta-verify&hub.challenge=5", {}, env())).text()).toBe("5");
  });

  it("SENDS off (env) or paused in /admin: nothing goes out", async () => {
    flags.SENDS = "false";
    await post(dm("instagram", "U1", "hi"));
    flags.SENDS = "true";
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('SENDS', 'false', '2026-10-30T00:00:00Z')").run();
    await post(dm("instagram", "U2", "hi"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no message text, name or username is stored", async () => {
    const TEXT = "my private sentence about my family";
    await post(wrap("instagram", [from("U1", "instagram", { message: { mid: "m_p1", text: TEXT } })]));
    await post(tap("instagram", "U1"));
    await post(echo("instagram", "U1", { text: "Typed by the team " + TEXT }));
    const dump = JSON.stringify([
      ...(await db.prepare("SELECT * FROM social_contacts").all()).results,
      ...(await db.prepare("SELECT * FROM social_seen").all()).results,
      ...(await db.prepare("SELECT * FROM events").all()).results,
      ...(await db.prepare("SELECT * FROM messages").all()).results,
    ]);
    expect(dump).not.toContain("private sentence");
    expect(dump).not.toContain("Typed by the team");
    const cols = Object.keys((await contact("instagram", "U1"))!);
    expect(cols.filter((c) => /text|body|name|message/.test(c))).toEqual([]);
  });

  it("a webhook retry (same message id) is answered once", async () => {
    const body = dm("instagram", "U1", "how much?");
    await post(body);
    await post(body);
    const t = tap("instagram", "U1");
    await post(t);
    await post(t);
    expect(sent()).toHaveLength(3); // the ask, then the guide and the questions
    expect(profileCalls()).toHaveLength(1);
  });

  it("a failed send is logged by code only and doesn't move the step on", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 10, message: "secret detail U1" } }), { status: 400 }));
    await post(dm("instagram", "U1", "my secret words"));
    expect(lines).toContain("social send failed 10");
    expect(lines.join("\n")).not.toMatch(/secret|U1/);
    expect((await contact("instagram", "U1")).step).toBe("NEW");
    vi.restoreAllMocks();
  });

  it("after 30 days without a message the flow starts again", async () => {
    await post(tap("messenger", "P1"));
    expect((await contact("messenger", "P1")).step).toBe("LINKED");
    at(NOW + 31 * 24 * HOUR);
    await post(dm("messenger", "P1", "hi"));
    expect(bodyOf(sent().at(-1))).toBe(msgrAsk());
    expect((await contact("messenger", "P1")).step).toBe("ASKED");
  });

  it("'delete my data' deletes their row at once and says so", async () => {
    await post(dm("instagram", "U1", "hi"));
    await post(dm("instagram", "U1", "Please delete my data"));
    expect(await contact("instagram", "U1")).toBeNull();
    expect(bodyOf(sent().at(-1))).toBe(en().deleted);
  });

  it("a crisis message gets the WhatsApp bot's Tele-MANAS message (no follow ask), no selling for a week, an item and an email", async () => {
    await post(dm("instagram", "U1", "I want to die"));
    expect(sent()).toHaveLength(1);
    expect(bodyOf(sent()[0])).toBe(allCopy.en.crisis.replaceAll("*", ""));
    expect(bodyOf(sent()[0])).toContain("14416");
    expect(Date.parse((await contact("instagram", "U1")).paused_until)).toBe(NOW + config.safety.noSellDays * 24 * HOUR);
    const item = await db.prepare("SELECT kind, target FROM attention").first<Json>();
    expect(item.kind).toBe("SOCIAL_SAFETY");
    expect(item.target).toMatch(/^instagram:[0-9a-f]{12}$/);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: "owner@example.invalid", subject: "Urgent: crisis message on Instagram" });
    expect(emails[0].text).not.toMatch(/want to die|U1/);
    at(NOW + 2 * 24 * HOUR);
    await post(dm("instagram", "U1", "hi"));
    expect(sent()).toHaveLength(1);
    // A second crisis message still gets the safety message, but no second item or email.
    await post(dm("instagram", "U1", "I want to die"));
    expect(sent()).toHaveLength(2);
    expect(emails).toHaveLength(1);
    // Even while SENDS is paused in /admin (never when the env flag is off).
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('SENDS', 'false', '2026-10-30T00:00:00Z')").run();
    await post(dm("messenger", "P9", "मरना चाहता हूँ"));
    expect(bodyOf(sent().at(-1))).toBe(allCopy.hi.crisis.replaceAll("*", ""));
  });

  it("an emergency gets the 112 / 108 message and a day's pause, no email", async () => {
    await post(dm("messenger", "P1", "my father is having a stroke"));
    expect(bodyOf(sent()[0])).toBe(allCopy.en.emergency.replaceAll("*", ""));
    expect(Date.parse((await contact("messenger", "P1")).paused_until)).toBe(NOW + 24 * HOUR);
    expect(emails).toHaveLength(0);
  });

  it("a crisis comment gets the helpline message as its private reply (no follow ask), no selling for a week, the item and the email", async () => {
    await post({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "comments", value: { from: { id: "AUTH1" }, id: "cx1", text: "I want to end my life", media: { id: "M1" } } }] }] });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].recipient).toEqual({ comment_id: "cx1" });
    expect(bodyOf(sent()[0])).toBe(allCopy.en.crisis.replaceAll("*", ""));
    expect(Date.parse((await contact("instagram", "IGSID1")).paused_until)).toBe(NOW + config.safety.noSellDays * 24 * HOUR);
    expect((await db.prepare("SELECT kind FROM attention").first<Json>()).kind).toBe("SOCIAL_SAFETY");
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("Urgent: crisis message on Instagram");
    await post(dm("instagram", "IGSID1", "how much?"));
    expect(sent()).toHaveLength(1);
    // With SENDS off in env nothing goes, but the team is still told.
    flags.SENDS = "false";
    await post({ object: "page", entry: [{ id: "PAGE1", changes: [{ field: "feed", value: { from: { id: "AUTH2" }, item: "comment", verb: "add", comment_id: "fx1", post_id: "PO1", message: "I want to die" } }] }] });
    expect(sent()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) n FROM attention")).toBe(2);
  });

  it("the clean-up deletes old message ids after a week and a person's row 90 days after their last message", async () => {
    await post(dm("instagram", "U1", "hi"));
    await cleanSocial(env(), NOW + 6 * 24 * HOUR);
    expect(await count("SELECT COUNT(*) n FROM social_seen")).toBe(2); // in: and out:
    await cleanSocial(env(), NOW + 8 * 24 * HOUR);
    expect(await count("SELECT COUNT(*) n FROM social_seen")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(1);
    await cleanSocial(env(), NOW + 91 * 24 * HOUR);
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(0);
  });

  it("every button title is at most 20 characters and every text fits Meta's limits, in both languages", () => {
    for (const w of [en(), hi()]) {
      for (const t of [w.btnVisit, ...Object.values(w.btnFollowing), w.btnBook, ...Object.values(w.qrTitles)]) expect(t.length, t).toBeLessThanOrEqual(20);
      for (const line of Object.values(w.lines)) expect(`${line}\n\n${w.guide}`.length).toBeLessThanOrEqual(640);
      for (const t of [w.ask, w.askAgain, w.notYet, w.questions, w.commentBook]) expect(t.length).toBeLessThanOrEqual(640);
      // Messenger text (2,000 characters) with the longest link written out.
      const link = `https://wa.me/1?text=${encodeURIComponent(w.prefill)}`;
      for (const line of Object.values(w.lines)) expect(`${line}\n\n${w.guide}\n\n${w.btnBook}: ${link}`.length).toBeLessThanOrEqual(2000);
      expect(`${w.askAgain}\n\n${w.pageLabel}: ${PAGE}\n${w.btnBook}: ${link}`.length).toBeLessThanOrEqual(2000);
      expect(new TextEncoder().encode(w.after("https://wa.me/1?text=" + "x".repeat(120))).length).toBeLessThan(1000);
      // No phone number anywhere except inside the wa.me link.
      for (const t of [w.ask, w.askAgain, w.notYet, w.guide, w.questions, w.deleted, w.commentBook, ...Object.values(w.lines)]) expect(t).not.toMatch(/\d{6,}|\+91/);
    }
  });
});

describe("the WhatsApp webhook is untouched", () => {
  it("/wa/webhook still verifies with its own token and answers a WhatsApp message; Instagram traffic never reaches it", async () => {
    expect(await (await app.request("/wa/webhook?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=9", {}, env())).text()).toBe("9");
    expect((await app.request("/wa/webhook?hub.mode=subscribe&hub.verify_token=meta-verify&hub.challenge=9", {}, env())).status).toBe(403);
    const wa = { entry: [{ changes: [{ value: { contacts: [{ wa_id: "919999999999", profile: { name: "Test" } }], messages: [{ id: "wamid.S1", from: "919999999999", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hi" } }] } }] }] };
    expect((await post(wa, "/wa/webhook")).status).toBe(200);
    expect(await count("SELECT COUNT(*) n FROM conversations")).toBe(1);
    expect(sent().at(-1).messaging_product).toBe("whatsapp");
    expect(await count("SELECT COUNT(*) n FROM social_contacts")).toBe(0);
    // An Instagram payload sent to /meta/webhook writes nothing WhatsApp-side.
    await post(dm("instagram", "U1", "hi"));
    expect(await count("SELECT COUNT(*) n FROM conversations")).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM events WHERE event_key LIKE 'm_%'")).toBe(0);
  });
});

describe("GET /data-deletion", () => {
  it("is a public page that says what is kept and how to delete it, with no script", async () => {
    const res = await app.request("/data-deletion", {}, env());
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(config.social.contactEmail);
    expect(page).toContain(`https://wa.me/${config.businessNumber.replace(/\D/g, "")}`);
    expect(page).toContain("We do not keep the text of your messages");
    expect(page).toContain("delete my data");
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toContain(config.businessNumber);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });
});

describe("comments: a private reply starts the same flow", () => {
  let cid = 0;
  const igComment = (author: string, media: string, text = "Beautiful 🙏", extra: object = {}) =>
    ({ object: "instagram", entry: [{ id: "IG1", time: Date.now(), changes: [{ field: "comments", value: { from: { id: author, username: "some_user" }, id: `c${++cid}`, text, media: { id: media, media_product_type: "REELS" }, ...extra } }] }] });
  const fbComment = (author: string, post: string, message = "Nice post", extra: object = {}) =>
    ({ object: "page", entry: [{ id: "PAGE1", time: Date.now(), changes: [{ field: "feed", value: { from: { id: author, name: "Some Name" }, item: "comment", verb: "add", comment_id: `fc${++cid}`, post_id: post, parent_id: post, message, created_time: 1, ...extra } }] }] });

  it("Instagram: a comment gets one private reply (recipient comment_id) with the follow ask; the row is kept under their messaging id", async () => {
    expect((await post(igComment("AUTH1", "MEDIA1", "Lovely! What is this?"))).status).toBe(200);
    const [m] = sent();
    expect(m.recipient).toEqual({ comment_id: `c${cid}` });
    expect(m.messaging_type).toBeUndefined();
    expect(bodyOf(m)).toBe(en().ask);
    expect(buttonsOf(m).map((b: Json) => b.payload ?? b.url)).toEqual([config.social.instagramUrl, FOLLOWING]);
    const row = await contact("instagram", "IGSID1");
    expect(row).toMatchObject({ step: "ASKED", commenter_id: "AUTH1", autos_today: 1 });
    // ... and the flow goes on from their tap.
    await post(tap("instagram", "IGSID1"));
    expect(bodyOf(sent().at(-2))).toBe(`${en().lines.what}\n\n${en().guide}`); // the comment's topic, answered after the follow
    // No comment text, username or name is kept.
    const dump = JSON.stringify([...(await db.prepare("SELECT * FROM social_contacts").all()).results, ...(await db.prepare("SELECT * FROM social_seen").all()).results]);
    for (const t of ["Lovely", "some_user", "Some Name"]) expect(dump).not.toContain(t);
  });

  it("one private reply per commenter per post; a retry of the same comment is answered once", async () => {
    const first = igComment("AUTH1", "MEDIA1");
    await post(first);
    await post(first);
    await post(igComment("AUTH1", "MEDIA1", "again"));
    expect(sent()).toHaveLength(1);
    at(NOW + 30 * 60_000);
    commentRecipient = "IGSID1";
  emails = [];
    await post(igComment("AUTH1", "MEDIA2"));
    expect(sent()).toHaveLength(2);
    await post(igComment("AUTH2", "MEDIA1"));
    expect(sent()).toHaveLength(3);
  });

  it("skips our own comments and replies, live comments, and Page feed items that are not new comments", async () => {
    await post(igComment("IG1", "MEDIA1", "Thank you!", { parent_id: "c1" }));
    await post({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "live_comments", value: { from: { id: "AUTH9" }, id: "lc1", media: { id: "LIVE" } } }] }] });
    await post(fbComment("PAGE1", "POST1", "Thanks for asking"));
    await post(fbComment("AUTH3", "POST1", "edited", { verb: "edited" }));
    await post(fbComment("AUTH3", "POST1", "", { item: "reaction" }));
    await post(fbComment("AUTH3", "POST1", "x", { item: "post" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("someone who had the link in the last 30 days gets only [Book on WhatsApp] for a comment on another post, at most once a week", async () => {
    await post(igComment("AUTH1", "MEDIA1"));
    await post(tap("instagram", "IGSID1"));
    expect((await contact("instagram", "IGSID1")).step).toBe("LINKED");
    const before = sent().length;
    at(NOW + 2 * 24 * HOUR);
    await post(igComment("AUTH1", "MEDIA2"));
    expect(sent()).toHaveLength(before + 1);
    const m = sent().at(-1);
    expect(m.recipient).toEqual({ comment_id: `c${cid}` });
    expect(bodyOf(m)).toBe(en().commentBook);
    expect(bodyOf(m)).toBe("Thank you for your comment! To book a ₹99 15-minute call with Shantha Rao, tap below and message us on WhatsApp.");
    expect(buttonsOf(m)).toEqual([{ type: "web_url", url: WA_BOOK, title: "Book on WhatsApp" }]);
    expect((await contact("instagram", "IGSID1")).step).toBe("LINKED");
    at(NOW + 5 * 24 * HOUR);
    await post(igComment("AUTH1", "MEDIA3"));
    await post(igComment("AUTH1", "MEDIA2")); // the same post again: never
    expect(sent()).toHaveLength(before + 1);
    at(NOW + 10 * 24 * HOUR);
    await post(igComment("AUTH1", "MEDIA4"));
    expect(sent()).toHaveLength(before + 2);
    // After 30 days, the follow ask again.
    at(NOW + 31 * 24 * HOUR);
    await post(igComment("AUTH1", "MEDIA5"));
    expect(bodyOf(sent().at(-1))).toBe(en().ask);
    // Facebook: the link written out, no buttons.
    commentRecipient = "PSID1";
    await post(fbComment("AUTH2", "POST1"));
    await post(tap("messenger", "PSID1"));
    at(NOW + 33 * 24 * HOUR);
    await post(fbComment("AUTH2", "POST2", "Great post"));
    expect(sent().at(-1).message).toEqual({ text: withLink(en().commentBook), metadata: METADATA });
  });

  it("the daily limit, a paused chat and SOCIAL_REPLIES off all stop the private reply", async () => {
    await db.prepare("INSERT INTO social_contacts (platform, user_id, commenter_id, autos_since, autos_today) VALUES ('instagram', 'IGSID1', 'AUTH1', ?1, 3)").bind(iso(NOW)).run();
    await post(igComment("AUTH1", "MEDIA1"));
    await db.prepare("INSERT INTO social_contacts (platform, user_id, paused_until) VALUES ('messenger', 'AUTH2', ?1)").bind(iso(NOW + HOUR)).run();
    await post(fbComment("AUTH2", "POST1"));
    flags.SOCIAL_REPLIES = "false";
    await post(igComment("AUTH3", "MEDIA1"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Facebook: a Page comment gets the private reply (with our metadata); their tap on Messenger gets the link", async () => {
    commentRecipient = "PSID1";
    await post(fbComment("AUTH1", "POST1", "Kitna charge hai?"));
    const [m] = sent();
    expect(m.recipient).toEqual({ comment_id: `fc${cid}` });
    expect(m.message).toEqual({ text: msgrAsk(hi()), quick_replies: followQr("मैंने फ़ॉलो किया"), metadata: METADATA });
    expect((await contact("messenger", "PSID1"))).toMatchObject({ commenter_id: "AUTH1", lang: "hi", step: "ASKED" });
    await post(tap("messenger", "PSID1"));
    expect(bodyOf(sent().at(-1))).toBe(withLink(`${hi().lines.price}\n\n${hi().guide}`, hi(), WA_BOOK_HI));
  });

  it("Facebook: if the quick reply is refused in a private reply, the same text goes without it, saying to reply \"following\"", async () => {
    commentRecipient = "PSID1";
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 }));
    await post(fbComment("AUTH1", "POST1", "Nice"));
    expect(sent().at(-1).message).toEqual({ text: `${msgrAsk()}\n\n${en().typeFollowing}`, metadata: METADATA });
    await post(dm("messenger", "PSID1", "following"));
    expect(bodyOf(sent().at(-1))).toBe(withLink(en().guide));
  });

  it("Instagram: if the buttons are refused in a private reply, the ask goes as text, and a typed 'following' counts as the tap", async () => {
    refuseTemplateReply = true;
    await post(igComment("AUTH1", "MEDIA1"));
    const m = sent().at(-1);
    expect(m.message.text).toBe(`${en().ask}\n\n${config.social.instagramUrl}\n${en().typeFollowing}`);
    await post(dm("instagram", "IGSID1", "Following!"));
    expect(profileCalls()).toHaveLength(1);
    expect(bodyOf(sent().at(-2))).toBe(en().guide);
  });

  it("the public answer under the comment is off by default; when on, it goes after the private reply, in their language", async () => {
    await post(igComment("AUTH1", "MEDIA1"));
    expect(publicReplies()).toHaveLength(0);
    social.publicReply = true;
    await post(igComment("AUTH2", "MEDIA1", "बहुत अच्छा"));
    await post(fbComment("AUTH3", "POST1", "Nice"));
    expect(publicReplies()).toEqual([
      { url: `https://graph.facebook.com/${config.graphVersion}/c${cid - 1}/replies`, body: { message: "आपको DM भेजा है 🙏" } },
      { url: `https://graph.facebook.com/${config.graphVersion}/fc${cid}/comments`, body: { message: "Sent you a DM 🙏" } },
    ]);
  });
});
