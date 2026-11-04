import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env"; // first: it loads the Worker
import app from "../src/index";
import { csrf } from "../src/auth";
import { cleanMime, howShown, mediaOf } from "../src/media";
import { wipeChats } from "../src/wipe";

// Ticket 38: a customer's photo or file, viewed on demand and never stored. All data is synthetic (numbers 91920000000x, made-up names,
// made-up Meta ids); Access, Meta and the CDN are mocked, nothing real is called.
const NOW = Date.parse("2026-11-04T06:00:00Z");
const SECRET = "test-app-secret";
const MEDIA_ID = "990011223344"; // a made-up Meta media id
const CDN = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=990011223344&ext=1&hash=test";
const BYTES = new Uint8Array([1, 2, 3, 4]);
const h = new ConsoleHarness();
vi.setConfig({ testTimeout: 60_000 }); // each test signs in and seeds a fresh D1; CI is slower than a laptop

type Meta = { status?: number; throwName?: string; url?: string; mime?: string; size?: number; fileStatus?: number };
let meta: Meta = {};
let calls: { url: string; auth: string | undefined }[] = [];

beforeEach(async () => {
  await h.start(NOW);
  h.vars = { WA_APP_SECRET: SECRET, WA_TOKEN: "tok-test", WA_PHONE_ID: "1000" };
  meta = {};
  calls = [];
  const prev = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const auth = init?.headers?.Authorization;
      // GET /{media-id}: the short-lived link (a message send is a POST to /<phone id>/messages and goes to the harness).
      if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/[A-Za-z0-9_-]+(\?|$)/.test(u) && (init?.method ?? "GET") === "GET") {
        calls.push({ url: u, auth });
        if (meta.throwName) throw Object.assign(new Error("timed out"), { name: meta.throwName });
        if (meta.status) return new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: meta.status });
        return new Response(JSON.stringify({ url: meta.url ?? CDN, mime_type: meta.mime ?? "image/jpeg", file_size: meta.size ?? BYTES.length, id: MEDIA_ID, messaging_product: "whatsapp" }));
      }
      if (u.startsWith("https://lookaside.fbsbx.com/") || u.startsWith("https://evil.example.org/")) {
        calls.push({ url: u, auth });
        if (meta.fileStatus) return new Response("gone", { status: meta.fileStatus });
        return new Response(BYTES, { headers: { "Content-Type": meta.mime ?? "image/jpeg" } });
      }
      return prev(url, init as never);
    }),
  );
});
afterEach(() => h.stop());

// ---- synthetic people ----
async function person(wa: string, o: { mode?: string; name?: string } = {}) {
  const r = await h.db.prepare("INSERT INTO conversations (wa_id, display_name, last_user_at, mode, consent_at, greeted_at) VALUES (?1, ?2, ?3, ?4, ?3, ?3)").bind(wa, o.name ?? "Test Person", new Date(NOW - 3_600_000).toISOString(), o.mode ?? "BOT").run();
  await h.db.prepare("INSERT INTO person_state (conversation_id) VALUES (?1)").bind(r.meta.last_row_id).run();
  return r.meta.last_row_id;
}
let n = 0;
async function mediaMsg(conv: number, kind = "image", mime: string | null = "image/jpeg", id: string | null = MEDIA_ID) {
  const r = await h.db
    .prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, kind, body, status, created_at, media_id, media_mime) VALUES (?1, 'IN', ?2, ?3, NULL, 'RECEIVED', ?4, ?5, ?6)")
    .bind(conv, `wamid.media${++n}`, kind, new Date(NOW - 3_000_000).toISOString(), id, mime)
    .run();
  return r.meta.last_row_id;
}
async function ownCustomer(conv: number) {
  const prac = (await h.member(PRAC))!;
  await h.db.prepare("INSERT INTO intros (conversation_id, service, state, practitioner_id) VALUES (?1, 'HEALING', 'PAID', ?2)").bind(conv, prac.id).run();
}
const safetyItem = (conv: number) => h.db.prepare("INSERT INTO attention (kind, target, resolved_at) VALUES ('CRISIS', ?1, ?2)").bind(`conv:${conv}`, new Date(NOW - 60_000).toISOString()).run();
const view = async (conv: number, msg: number, as = OWNER, o: { token?: string; origin?: string | null } = {}) =>
  h.post(`/app/people/${conv}/media/${msg}`, { csrf: o.token ?? (await h.tokenFor(as, `people-media:${conv}`)) }, as, { origin: o.origin });
const page = async (path: string, as = OWNER) => (await h.get(path, as)).text();
const hasView = (html: string, conv: number, msg: number) => html.includes(`action="/app/people/${conv}/media/${msg}"`);
const metaCalls = () => calls.length;

async function signedPost(body: unknown) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const sig = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, h.env());
}
const inbound = (from: string, msg: object) =>
  signedPost({ entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: from, profile: { name: "Test Person" } }], messages: [{ id: `wamid.in${++n}`, from, timestamp: String(Math.floor(NOW / 1000)), ...msg }] } }] }] });

describe("intake: only Meta's id and type", () => {
  it("keeps the media id and type of an image, document, voice note, video and sticker; never a caption, filename or link; the bot's reply is unchanged", async () => {
    const from = "919200000001";
    await inbound(from, { type: "image", image: { id: "880000000001", mime_type: "image/jpeg", sha256: "abc", caption: "CAPTIONSECRET my report" } });
    await inbound(from, { type: "document", document: { id: "880000000002", mime_type: "application/pdf", filename: "FILENAMESECRET.pdf", caption: "see" } });
    await inbound(from, { type: "audio", audio: { id: "880000000003", mime_type: "audio/ogg; codecs=opus", voice: true } });
    await inbound(from, { type: "video", video: { id: "880000000004", mime_type: "video/mp4" } });
    await inbound(from, { type: "sticker", sticker: { id: "880000000005", mime_type: "image/webp", animated: false } });
    await inbound(from, { type: "location", location: { latitude: 12.9, longitude: 77.6, name: "LOCATIONSECRET" } });
    await inbound(from, { type: "image", image: { id: "../../me?x=1", mime_type: "image/jpeg" } }); // not a Meta id: not kept
    const rows = (await h.db.prepare("SELECT kind, body, media_id AS id, media_mime AS mime FROM messages WHERE direction = 'IN' ORDER BY CAST(substr(wa_message_id, 10) AS INTEGER)").all<{ kind: string; body: string | null; id: string | null; mime: string | null }>()).results;
    expect(rows.map((r) => [r.kind, r.id, r.mime, r.body])).toEqual([
      ["image", "880000000001", "image/jpeg", null],
      ["document", "880000000002", "application/pdf", null],
      ["audio", "880000000003", "audio/ogg", null],
      ["video", "880000000004", "video/mp4", null],
      ["sticker", "880000000005", "image/webp", null],
      ["location", null, null, null],
      ["image", null, null, null],
    ]);
    const everything = JSON.stringify((await h.db.prepare("SELECT * FROM messages").all()).results) + JSON.stringify((await h.db.prepare("SELECT * FROM events").all()).results);
    for (const secret of ["CAPTIONSECRET", "FILENAMESECRET", "LOCATIONSECRET", "lookaside", "https://"]) expect(everything).not.toContain(secret);
    expect(metaCalls()).toBe(0); // nothing is downloaded at intake
    // The reply to a photo from someone with no booking (ticket 41 wording): the notice and the menu, once that day.
    const sent = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith("/messages")).map((c) => JSON.parse(String((c[1] as { body: string }).body)));
    expect(sent.some((p) => /^Thank you — our team will take a look and reply here if needed\./.test(p.text?.body ?? ""))).toBe(true);
    expect(sent.some((p) => /Only typed messages/.test(p.text?.body ?? ""))).toBe(false);
  });

  it("mediaOf and cleanMime", () => {
    expect(mediaOf({ type: "image", image: { id: "123", mime_type: "IMAGE/PNG" } })).toEqual({ id: "123", mime: "image/png" });
    expect(mediaOf({ type: "location" })).toBeNull();
    expect(mediaOf({ type: "image", image: {} })).toBeNull();
    expect(cleanMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(cleanMime("text/html<script>")).toBeNull();
    expect(howShown("image/jpeg")).toBe("inline");
    expect(howShown("application/pdf")).toBe("inline");
    expect(howShown("image/svg+xml")).toBe("attachment");
    expect(howShown("audio/ogg")).toBe("player");
    expect(howShown("video/mp4")).toBe("player");
    expect(howShown("video/quicktime")).toBe("attachment");
    expect(howShown("text/html")).toBe("attachment");
  });
});

describe("wiped with the text", () => {
  it("the retention wipe clears the media id and type; the bubble then joins the 'deleted for privacy' line and View is gone", async () => {
    const c = await person("919200000002");
    const msg = await mediaMsg(c);
    await h.db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(c, new Date(NOW - 8 * 86_400_000).toISOString()).run();
    expect(await wipeChats(h.env(), NOW)).toBeGreaterThan(0);
    const row = await h.db.prepare("SELECT media_id AS id, media_mime AS mime, wiped_at AS w FROM messages WHERE id = ?1").bind(msg).first<{ id: string | null; mime: string | null; w: string | null }>();
    expect(row).toEqual({ id: null, mime: null, w: expect.any(String) });
    const html = await page(`/app/people/${c}`);
    expect(hasView(html, c, msg)).toBe(false);
    expect(html).toContain("deleted after 7 days, for privacy");
    const res = await view(c, msg);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("This file is no longer available from WhatsApp.");
    expect(metaCalls()).toBe(0);
  });

  it("a chat still inside retention keeps it", async () => {
    const c = await person("919200000003");
    const msg = await mediaMsg(c);
    await wipeChats(h.env(), NOW);
    expect((await h.db.prepare("SELECT media_id AS id FROM messages WHERE id = ?1").bind(msg).first<{ id: string }>())!.id).toBe(MEDIA_ID);
  });

  it("People → Remove their data clears it at once", async () => {
    const c = await person("919200000004");
    const msg = await mediaMsg(c);
    const res = await h.post(`/app/people/${c}/remove-data`, { csrf: await h.tokenFor(OWNER, `people-remove:${c}`), reason: "asked by the customer" });
    expect(res.status).toBe(303);
    expect(await h.count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1 AND media_id IS NULL AND media_mime IS NULL AND wiped_at IS NOT NULL", msg)).toBe(1);
    expect((await view(c, msg)).status).toBe(410);
  });
});

describe("View: the file, streamed, never kept", () => {
  it("owner: the button on the person page and the Inbox; the POST is audited, then the bytes come with no-store, nosniff, inline and a script-free CSP", async () => {
    const c = await person("919200000005", { mode: "HUMAN" });
    const msg = await mediaMsg(c);
    const html = await page(`/app/people/${c}`);
    expect(hasView(html, c, msg)).toBe(true);
    expect(html).toContain(">Photo<");
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain(MEDIA_ID); // the id never reaches the page
    expect(hasView(await page(`/app/inbox/${c}`), c, msg)).toBe(true);

    const res = await view(c, msg);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline/);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src|unsafe-eval/);
    // Meta: the id with our phone number id and the token, then the short-lived link with the same Authorization.
    expect(calls.map((x) => x.url)).toEqual([`https://graph.facebook.com/v26.0/${MEDIA_ID}?phone_number_id=1000`, CDN]);
    expect(calls.every((x) => x.auth === "Bearer tok-test")).toBe(true);
    const audits = await h.audits("VIEW_MEDIA");
    expect(audits).toEqual([{ actor: OWNER, memberId: (await h.member(OWNER))!.id, target: `conv:${c}`, detail: "image" }]);
    expect(JSON.stringify(audits)).not.toContain(MEDIA_ID);
    // Nothing of the file is stored anywhere.
    expect(await h.count("SELECT COUNT(*) AS n FROM settings WHERE value LIKE '%lookaside%' OR key LIKE '%media%'")).toBe(0);
  });

  it("a PDF opens inline; a zip, an SVG or anything else downloads as an attachment", async () => {
    const c = await person("919200000006");
    const pdf = await mediaMsg(c, "document", "application/pdf");
    meta.mime = "application/pdf";
    let res = await view(c, pdf);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="whatsapp-document.pdf"');
    for (const mime of ["application/zip", "image/svg+xml", "text/html"]) {
      const m = await mediaMsg(c, "document", mime);
      meta.mime = mime;
      res = await view(c, m);
      expect(res.status, mime).toBe(200);
      expect(res.headers.get("Content-Type"), mime).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition"), mime).toMatch(/^attachment; filename="whatsapp-document\.[a-z]+"$/);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    }
  });

  it("a voice note or an MP4 opens in a player page with the file inside it: no script, no-store", async () => {
    const c = await person("919200000007");
    const voice = await mediaMsg(c, "audio", "audio/ogg");
    meta.mime = "audio/ogg";
    let res = await view(c, voice);
    let body = await res.text();
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(body).toContain('<audio controls src="data:audio/ogg;base64,AQIDBA=="></audio>');
    expect(body).not.toContain("<script");
    expect(res.headers.get("Content-Security-Policy")).toContain("media-src data:");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    const video = await mediaMsg(c, "video", "video/mp4");
    meta.mime = "video/mp4";
    res = await view(c, video);
    body = await res.text();
    expect(body).toContain('<video controls src="data:video/mp4;base64,AQIDBA==">');
    expect((await h.audits("VIEW_MEDIA")).map((a) => a.detail)).toEqual(["audio", "video"]);
  });

  it("gone from WhatsApp (404 or 400 from Graph, or the link used up), a timeout, another error: one kind line, nothing else", async () => {
    const c = await person("919200000008");
    const msg = await mediaMsg(c);
    for (const status of [404, 400]) {
      meta = { status };
      const res = await view(c, msg);
      expect(res.status).toBe(410);
      expect(await res.text()).toContain("This file is no longer available from WhatsApp.");
      expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    }
    meta = { fileStatus: 404 };
    expect((await view(c, msg)).status).toBe(410);
    meta = { throwName: "TimeoutError" };
    let res = await view(c, msg);
    expect(res.status).toBe(504);
    expect(await res.text()).toContain("answer in time. Please try again in a minute.");
    meta = { status: 500 };
    res = await view(c, msg);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("be opened from WhatsApp just now");
    // A link that isn't Meta's never gets our token.
    meta = { url: "https://evil.example.org/x" };
    expect((await view(c, msg)).status).toBe(502);
    expect(calls.some((x) => x.url.startsWith("https://evil.example.org/"))).toBe(false);
    // Each try is audited (the view was asked for), with the kind only.
    expect((await h.audits("VIEW_MEDIA")).length).toBe(6);
  });

  it("the Hindi console says it in Hindi", async () => {
    const c = await person("919200000009");
    const msg = await mediaMsg(c);
    await h.db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(OWNER).run();
    expect(await page(`/app/people/${c}`)).toContain(">देखें<");
    meta = { status: 404 };
    expect(await (await view(c, msg)).text()).toContain("यह फ़ाइल अब WhatsApp पर उपलब्ध नहीं है।");
  });
});

describe("who may view", () => {
  it("staff: yes while they may read chat text; no once the owner hides it (no button, POST refused, nothing fetched or audited)", async () => {
    const c = await person("919200000010", { mode: "HUMAN" });
    const msg = await mediaMsg(c);
    expect(hasView(await page(`/app/people/${c}`, STAFF), c, msg)).toBe(true);
    expect(hasView(await page(`/app/inbox/${c}`, STAFF), c, msg)).toBe(true);
    expect((await view(c, msg, STAFF)).status).toBe(200);
    await h.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('privacy.staff_read_chat', 'false', ?1)").bind(new Date(NOW).toISOString()).run();
    calls = [];
    expect(hasView(await page(`/app/people/${c}`, STAFF), c, msg)).toBe(false);
    expect(hasView(await page(`/app/inbox/${c}`, STAFF), c, msg)).toBe(false);
    expect((await view(c, msg, STAFF)).status).toBe(403);
    expect(metaCalls()).toBe(0);
    expect((await h.audits("VIEW_MEDIA")).length).toBe(1);
    // The owner is not affected by that setting.
    expect((await view(c, msg)).status).toBe(200);
  });

  it("a chat that had a safety message (ticket 41): the owner and the practitioner for their own customer; staff never", async () => {
    const c = await person("919200000011", { mode: "HUMAN" });
    const msg = await mediaMsg(c);
    await ownCustomer(c);
    await safetyItem(c); // resolved: it still counts
    expect(hasView(await page(`/app/people/${c}`, STAFF), c, msg)).toBe(false);
    expect(hasView(await page(`/app/inbox/${c}`, STAFF), c, msg)).toBe(false);
    expect((await view(c, msg, STAFF)).status).toBe(403);
    expect(metaCalls()).toBe(0);
    expect(hasView(await page(`/app/people/${c}`, PRAC), c, msg)).toBe(true);
    expect((await view(c, msg, PRAC)).status).toBe(200);
    expect(hasView(await page(`/app/people/${c}`), c, msg)).toBe(true);
    expect((await view(c, msg)).status).toBe(200);
    // Another practitioner's customer's safety chat: no.
    const other = await person("919200000018");
    const m3 = await mediaMsg(other);
    await safetyItem(other);
    expect((await view(other, m3, PRAC)).status).toBe(403);
    // The bot's own safety message, without an item, counts too.
    const d = await person("919200000012");
    const m2 = await mediaMsg(d);
    await h.db.prepare("INSERT INTO messages (conversation_id, direction, dedupe_key, kind, body, status) VALUES (?1, 'OUT', 'wamid.x:emergency', 'text', 'fixed text', 'SENT')").bind(d).run();
    expect((await view(d, m2, STAFF)).status).toBe(403);
    expect((await view(d, m2)).status).toBe(200);
  }, 60_000);

  it("the practitioner: their own customer yes, anyone else's no", async () => {
    const mine = await person("919200000013");
    const theirs = await person("919200000014");
    const a = await mediaMsg(mine);
    const b = await mediaMsg(theirs);
    await ownCustomer(mine);
    expect(hasView(await page(`/app/people/${mine}`, PRAC), mine, a)).toBe(true);
    expect((await view(mine, a, PRAC)).status).toBe(200);
    expect((await view(theirs, b, PRAC)).status).toBe(403);
    expect((await h.audits("VIEW_MEDIA")).map((x) => x.target)).toEqual([`conv:${mine}`]);
  });

  it("the form token and the Origin: a wrong or another chat's token, no Origin or a foreign one change nothing", async () => {
    const c = await person("919200000015");
    const d = await person("919200000016");
    const msg = await mediaMsg(c);
    expect((await view(c, msg, OWNER, { token: "nope" })).status).toBe(403);
    expect((await view(c, msg, OWNER, { token: await h.tokenFor(OWNER, `people-media:${d}`) })).status).toBe(403);
    expect((await view(c, msg, OWNER, { token: await h.tokenFor(STAFF, `people-media:${c}`) })).status).toBe(403); // another member's
    expect((await view(c, msg, OWNER, { origin: null })).status).toBe(403);
    expect((await view(c, msg, OWNER, { origin: "https://evil.example.org" })).status).toBe(403);
    // Another chat's message through this chat's address: not found, not fetched.
    const other = await mediaMsg(d);
    expect((await view(c, other)).status).toBe(410);
    expect(metaCalls()).toBe(0);
    expect((await h.audits("VIEW_MEDIA")).length).toBe(0);
    // A GET does nothing.
    expect((await h.get(`/app/people/${c}/media/${msg}`)).status).toBe(404);
    expect(metaCalls()).toBe(0);
  });
});

describe("/admin (the owner's old console, while CONSOLE_V2 is off)", () => {
  it("shows View on the person page; the POST checks the token and the Origin, is audited, and streams the file", async () => {
    h.vars = { ...h.vars, CONSOLE_V2: "false" };
    const c = await person("919200000017");
    const msg = await mediaMsg(c);
    const html = await page(`/admin/conv/${c}`);
    expect(html).toContain(`action="/admin/conv/${c}/media/${msg}"`);
    expect(html).not.toContain(MEDIA_ID);
    const jwt = await h.jwtFor(OWNER);
    const token = await csrf(jwt, `media:${c}`);
    expect((await h.post(`/admin/conv/${c}/media/${msg}`, { csrf: "nope" })).status).toBe(403);
    expect((await h.post(`/admin/conv/${c}/media/${msg}`, { csrf: token }, OWNER, { origin: null })).status).toBe(403);
    expect((await h.post(`/admin/conv/${c}/media/${msg}`, { csrf: token }, STAFF)).status).toBe(403); // /admin is the owner's alone
    expect(metaCalls()).toBe(0);
    const res = await h.post(`/admin/conv/${c}/media/${msg}`, { csrf: token });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect((await h.audits("VIEW_MEDIA")).map((a) => [a.actor, a.target, a.detail])).toEqual([[OWNER, `conv:${c}`, "image"]]);
    meta = { status: 404 };
    expect(await (await h.post(`/admin/conv/${c}/media/${msg}`, { csrf: token })).text()).toContain("This file is no longer available from WhatsApp.");
  });
});

describe("never in the export", () => {
  it("the export names a photo only, never its id, type or a link", async () => {
    const c = await person("919200000018");
    await mediaMsg(c);
    await mediaMsg(c, "document", "application/pdf");
    const res = await h.get("/app/people/export?days=7");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[photo]");
    expect(body).toContain("[file]");
    for (const s of [MEDIA_ID, "image/jpeg", "application/pdf", "lookaside"]) expect(body).not.toContain(s);
    expect(metaCalls()).toBe(0);
  });
});
