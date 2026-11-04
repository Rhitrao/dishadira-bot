// Ticket 38: the team sees a photo or file a customer sent, on demand, never stored (owner decision, 4 Nov 2026).
// - Intake (src/whatsapp.ts): for an incoming image, document, video, sticker or voice note / audio only Meta's media id and the type Meta
//   gave are kept on the message row (migration 0016). Never the bytes, never a link. They are wiped with the text (src/wipe.ts).
// - "View" (a POST with the page's form token and the Origin check, as every console change): audited VIEW_MEDIA (the chat and the kind,
//   never content), then GET Graph /{media-id} with WA_TOKEN for the short-lived link, fetch it with the same Authorization, and stream
//   the bytes straight to the browser with no-store. Nothing goes to D1, KV, R2, the AI or the export.
// - Who: the same rule as the chat's text (read_chat): the owner; a practitioner for their own customers, a safety chat included (ticket 41,
//   owner, 4 Nov 2026); staff only while they may read chat text (Settings → Privacy) and never on a chat that had a safety message.
// Meta's docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media (the link lasts 5 minutes; media ~30 days).
import { html } from "hono/html";
import { can, type Member, type Target } from "./auth";
import { chatTextHidden } from "./business";
import { config } from "./config";
import { consoleCopy } from "./console-copy";
import type { Env } from "./env";
import { CONSOLE_CSP, plainFrame } from "./ui";

// The incoming kinds whose file can be viewed. Location and contact cards have no file.
export const MEDIA_KINDS = ["image", "document", "video", "sticker", "audio"] as const;

// "image/jpeg" from "image/jpeg; codecs=…"; anything odd is no type at all.
export function cleanMime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.split(";")[0].trim().toLowerCase();
  return t.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(t) ? t : null;
}

// What intake keeps from a webhook message: Meta's id and type for the file, nothing else (no caption, no filename, no link).
export function mediaOf(m: { type: string } & Partial<Record<(typeof MEDIA_KINDS)[number], { id?: string; mime_type?: string } | undefined>>): { id: string; mime: string | null } | null {
  if (!(MEDIA_KINDS as readonly string[]).includes(m.type)) return null;
  const part = m[m.type as (typeof MEDIA_KINDS)[number]];
  const id = part?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return { id, mime: cleanMime(part?.mime_type) };
}

// ---- who may view ----
// A chat that ever had a crisis or emergency message (an item, the bot's audit row, or the safety message itself), as the export decides.
export async function hadSafety(db: Env["DB"], convId: number): Promise<boolean> {
  const t = `conv:${convId}`;
  const row = await db
    .prepare(
      `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM attention WHERE target = ?1 AND kind IN ('CRISIS', 'EMERGENCY'))
         OR EXISTS (SELECT 1 FROM audit_log WHERE target = ?1 AND action IN ('CRISIS', 'EMERGENCY'))
         OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?2 AND direction = 'OUT' AND (dedupe_key LIKE '%:crisis' OR dedupe_key LIKE '%:emergency'))`,
    )
    .bind(t, convId)
    .first();
  return row !== null;
}

// `target` is the person's (src/people.ts personFor): whose customer they are, for a practitioner. A chat that ever had a safety message asks
// read_chat for a safety message (owner: yes; practitioner: their own customer; staff: never), as the chat's text does.
export async function maySeeMedia(db: Env["DB"], m: Member, target: Target, convId: number): Promise<boolean> {
  if (can(m, "read_chat", target) !== "yes") return false;
  if (m.role === "OWNER") return true;
  if (await chatTextHidden(db, m.role)) return false;
  return !(await hadSafety(db, convId)) || can(m, "read_chat", { ...target, safety: true }) === "yes";
}

// The row a View button names: an incoming message of this chat that still has its media id (the wipe clears it).
export type MediaRow = { id: number; kind: string; mediaId: string; mime: string | null };
export const mediaRow = (db: Env["DB"], convId: number, msgId: number) =>
  Number.isInteger(msgId) && msgId > 0
    ? db
        .prepare("SELECT id, kind, media_id AS mediaId, media_mime AS mime FROM messages WHERE id = ?1 AND conversation_id = ?2 AND direction = 'IN' AND media_id IS NOT NULL AND wiped_at IS NULL")
        .bind(msgId, convId)
        .first<MediaRow>()
    : Promise.resolve(null);

// The View button inside a bubble: opens the file in a new tab (the form's own token; the console checks the Origin).
export const viewButton = (action: string, csrf: string, locale: string | null | undefined, cls = "btn") =>
  html`<form class="view" method="post" action="${action}" target="_blank" rel="noopener"><input type="hidden" name="csrf" value="${csrf}"><button class="${cls}" type="submit">${consoleCopy(locale).viewMedia}</button></form>`;

// ---- fetching from Meta ----
type Why = "gone" | "slow" | "failed";
export type Fetched = { ok: true; res: Response; mime: string; size: number | null } | { ok: false; why: Why };
// Meta answers 404 (or 400, "does not exist") for a media id it no longer has (about 30 days after it was sent), and the link 404s once used up.
const GONE = new Set([400, 404, 410]);
// The short-lived link must be Meta's own: our token goes with it.
const META_HOSTS = [".fbsbx.com", ".fbcdn.net", ".facebook.com", ".whatsapp.net"];
function metaUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && META_HOSTS.some((h) => u.hostname.endsWith(h)) ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchMedia(env: Env, mediaId: string, storedMime: string | null): Promise<Fetched> {
  const headers = { Authorization: `Bearer ${env.WA_TOKEN}` };
  const fail = (why: Why): Fetched => {
    console.log("media: not shown", why); // a code only, never the id
    return { ok: false, why };
  };
  try {
    const q = env.WA_PHONE_ID ? `?phone_number_id=${encodeURIComponent(env.WA_PHONE_ID)}` : "";
    const meta = await fetch(`https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(mediaId)}${q}`, { headers, signal: AbortSignal.timeout(config.media.graphTimeoutMs) });
    if (GONE.has(meta.status)) return fail("gone");
    if (!meta.ok) return fail("failed");
    const info = (await meta.json().catch(() => null)) as { url?: unknown; mime_type?: unknown; file_size?: unknown } | null;
    const url = metaUrl(info?.url);
    if (!url) return fail("failed");
    const file = await fetch(url, { headers, signal: AbortSignal.timeout(config.media.downloadTimeoutMs) });
    if (GONE.has(file.status)) return fail("gone");
    if (!file.ok || !file.body) return fail("failed");
    const size = Number(info?.file_size ?? file.headers.get("Content-Length"));
    return { ok: true, res: file, mime: cleanMime(info?.mime_type) ?? storedMime ?? "application/octet-stream", size: Number.isFinite(size) && size > 0 ? size : null };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return fail(name === "TimeoutError" || name === "AbortError" ? "slow" : "failed");
  }
}

// ---- what the browser gets ----
// No scripts in any of it: the file's own document may show an image, a PDF or a player, nothing else.
export const MEDIA_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
const PLAYER_CSP = "default-src 'none'; media-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
const PRIVATE = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

// Shown inline: images (not SVG, which can carry script), PDFs, MP4 video, audio (voice notes). Everything else downloads.
export type Shown = "inline" | "player" | "attachment";
export function howShown(mime: string): Shown {
  if (mime === "application/pdf" || (mime.startsWith("image/") && mime !== "image/svg+xml")) return "inline";
  if (mime === "video/mp4" || mime.startsWith("audio/")) return "player";
  return "attachment";
}
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "video/mp4": "mp4", "audio/ogg": "ogg",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "text/plain": "txt", "application/msword": "doc", "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "application/vnd.ms-powerpoint": "ppt",
};
// Our own name for the file (never the customer's filename, which we don't keep).
const fileName = (kind: string, mime: string) => `whatsapp-${kind}.${EXT[mime] ?? "bin"}`;

const B64_CHUNK = 3 * 32 * 1024; // a multiple of 3, so each piece's base64 joins to the whole
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function mediaResponse(f: Extract<Fetched, { ok: true }>, kind: string): Promise<Response> {
  const how = howShown(f.mime);
  const name = fileName(kind, f.mime);
  if (how === "inline") {
    return new Response(f.res.body, {
      headers: { ...PRIVATE, "Content-Type": f.mime, "Content-Disposition": `inline; filename="${name}"`, "Content-Security-Policy": MEDIA_CSP },
    });
  }
  if (how === "attachment" || (f.size !== null && f.size > config.media.playerMaxBytes)) {
    return new Response(f.res.body, {
      headers: { ...PRIVATE, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Content-Security-Policy": MEDIA_CSP },
    });
  }
  // A voice note or a video. Opened from a POST, a browser's own player asks for the file again with a GET, which would find nothing; so
  // the player comes on a tiny page with the file inside it (a data: link), still no script, still not stored anywhere.
  const bytes = new Uint8Array(await f.res.arrayBuffer());
  const tag = f.mime.startsWith("audio/") ? "audio" : "video";
  const enc = new TextEncoder();
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${name}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111}${tag}{max-width:100%;max-height:100vh}audio{width:min(90vw,480px)}</style></head>
<body><${tag} controls src="data:${f.mime};base64,`;
  const tail = `"></${tag}></body></html>`;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(enc.encode(head));
      for (let i = 0; i < bytes.length; i += B64_CHUNK) ctl.enqueue(enc.encode(base64(bytes.subarray(i, i + B64_CHUNK))));
      ctl.enqueue(enc.encode(tail));
      ctl.close();
    },
  });
  return new Response(body, { headers: { ...PRIVATE, "Content-Type": "text/html; charset=utf-8", "Content-Disposition": "inline", "Content-Security-Policy": PLAYER_CSP } });
}

// One kind line when the file can't be shown: gone from WhatsApp (410), WhatsApp too slow (504), or another failure (502).
export async function mediaProblem(why: Why, locale: string | null | undefined): Promise<Response> {
  const cc = consoleCopy(locale);
  const line = why === "gone" ? cc.mediaGone : why === "slow" ? cc.mediaSlow : cc.mediaFailed;
  const page = await plainFrame({ locale, title: cc.mediaTitle, body: html`<header class="screen"><h1>${cc.mediaTitle}</h1></header><div class="empty" role="status"><p>${line}</p></div>` });
  return new Response(String(page), {
    status: why === "gone" ? 410 : why === "slow" ? 504 : 502,
    headers: { ...PRIVATE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CONSOLE_CSP },
  });
}

// The whole View, once the caller has checked who may (rights, form token, Origin): the row, the audit row, then the file.
// `audit` writes VIEW_MEDIA for conv:<id> with the kind only. A row the wipe has emptied (or never had an id) is "no longer available".
export async function viewMedia(env: Env, convId: number, msgId: number, locale: string | null | undefined, audit: (kind: string) => Promise<unknown>): Promise<Response> {
  const row = await mediaRow(env.DB, convId, msgId);
  if (!row) return mediaProblem("gone", locale);
  await audit(row.kind);
  const f = await fetchMedia(env, row.mediaId, row.mime);
  return f.ok ? mediaResponse(f, row.kind) : mediaProblem(f.why, locale);
}
