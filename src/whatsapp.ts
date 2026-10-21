import type { Context } from "hono";
import { z } from "zod";
import { config } from "./config";
import { copyFor, LANGUAGE_BUTTONS, type Copy } from "./copy";
import type { Env } from "./env";
import { bookingChoice } from "./booking";
import { rescheduleChoice } from "./outcomes";
import { openOfferId, sessionChoice } from "./session";
import { raiseAttention, sendMessage, type Out } from "./send";
import { iso, istDay } from "./slots";

type C = Context<{ Bindings: Env }>;

// Everything Meta sends is checked loosely at the edges and strictly per message, so one odd item never costs the batch.
const message = z.object({
  id: z.string().min(1),
  from: z.string().min(1).optional(), // omitted when the sender has a username and no phone number can be shared
  from_user_id: z.string().optional(), // BSUID (business-scoped user id); not used yet, see STATUS.md
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string() }).optional(),
      list_reply: z.object({ id: z.string() }).optional(),
    })
    .optional(),
  button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(), // template quick-reply tap
  referral: z.object({ source_id: z.string().optional() }).optional(),
});
const status = z.object({ id: z.string().min(1), status: z.string() });
const contact = z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).optional() });
const envelope = z.object({ entry: z.array(z.unknown()) });
const entrySchema = z.object({ changes: z.array(z.unknown()) });
const changeSchema = z.object({
  field: z.string().optional(),
  value: z.object({ contacts: z.array(z.unknown()).optional(), messages: z.array(z.unknown()).optional(), statuses: z.array(z.unknown()).optional() }),
});
type Msg = z.infer<typeof message>;

// Outbound statuses that count as "already sent". UNKNOWN may have been delivered, so it is never sent again.
const WENT_OUT = "('SENT', 'SENDING', 'UNKNOWN')";

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function verifyWebhook(c: C) {
  const ok =
    c.req.query("hub.mode") === "subscribe" &&
    !!c.env.WA_VERIFY_TOKEN &&
    c.req.query("hub.verify_token") === c.env.WA_VERIFY_TOKEN;
  return ok ? c.text(c.req.query("hub.challenge") ?? "") : c.text("forbidden", 403);
}

// subtle.verify compares in constant time.
async function validSignature(raw: string, header: string | undefined, secret: string): Promise<boolean> {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const sig = Uint8Array.from(header.slice(7).match(/../g)!, (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(raw));
}

export async function receiveWebhook(c: C) {
  const raw = await c.req.text(); // raw body first; nothing is parsed or stored before the signature check
  if (!(await validSignature(raw, c.req.header("X-Hub-Signature-256"), c.env.WA_APP_SECRET))) {
    return c.text("invalid signature", 401);
  }
  // From here on the answer is 200 unless a database error means "try again": a signed payload we don't use is not an error.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.log("wa webhook ignored: not json");
    return c.text("ignored");
  }
  const top = envelope.safeParse(json);
  if (!top.success) {
    console.log("wa webhook ignored: no entry");
    return c.text("ignored");
  }

  let failed = false;
  for (const e of top.data.entry) {
    const entry = entrySchema.safeParse(e);
    if (!entry.success) continue;
    for (const ch of entry.data.changes) {
      const field = (ch as { field?: unknown } | null)?.field;
      if (typeof field === "string" && field !== "messages") continue; // calls, security, account_update, template status ...: not ours
      const change = changeSchema.safeParse(ch);
      if (!change.success) {
        await skip(c.env, ch, "SCHEMA_INVALID");
        continue;
      }
      const { value } = change.data;
      const names = new Map<string, string | undefined>();
      for (const k of value.contacts ?? []) {
        const parsedContact = contact.safeParse(k);
        if (parsedContact.success && parsedContact.data.wa_id) names.set(parsedContact.data.wa_id, parsedContact.data.profile?.name);
      }
      for (const item of value.messages ?? []) {
        const m = message.safeParse(item);
        if (!m.success) {
          await skip(c.env, item, "SCHEMA_INVALID");
          continue;
        }
        const reason = skipReason(m.data);
        if (reason) {
          await skip(c.env, item, reason, m.data.id);
          continue;
        }
        failed = !(await once(c.env, m.data.id, { type: m.data.type }, () => handleMessage(c.env, m.data, m.data.from!, names.get(m.data.from!)))) || failed;
      }
      for (const item of value.statuses ?? []) {
        const s = status.safeParse(item);
        if (!s.success) {
          await skip(c.env, item, "SCHEMA_INVALID");
          continue;
        }
        failed = !(await once(c.env, `status:${s.data.id}:${s.data.status}`, { status: s.data.status }, () => handleStatus(c.env, s.data))) || failed;
      }
    }
  }
  // A retriable error makes Meta redeliver; outbound dedupe keys keep the retry from double-sending.
  return failed ? c.text("retry", 500) : c.text("ok");
}

// Messages the bot cannot act on. Identity by BSUID is a design question (STATUS.md), so no phone number means skip.
function skipReason(m: Msg): string | null {
  if (m.type === "system") return "SYSTEM_MESSAGE"; // number or user id changed: a notice, not a person talking
  if (!m.from || !/^\d{8,15}$/.test(m.from)) return "NO_PHONE"; // missing, or a BSUID where a phone number used to be
  return null;
}

// One events row per skipped item, with a reason code. The key is the message id, or a hash of the item when it has none;
// the item itself is never stored, so the row holds no phone number, name or text.
async function skip(env: Env, item: unknown, reason: string, id?: string): Promise<void> {
  let key = id;
  if (!key) {
    const maybe = (item as { id?: unknown } | null)?.id;
    key = typeof maybe === "string" && maybe ? maybe : await sha256(JSON.stringify(item) ?? "null");
  }
  console.log("wa webhook skipped", reason);
  await env.DB
    .prepare("INSERT OR IGNORE INTO events (provider, event_key, payload, status, error, processed_at) VALUES ('whatsapp', ?1, ?2, 'PROCESSED', ?3, ?4)")
    .bind(`skip:${key}`, JSON.stringify({ reason }), reason, nowIso())
    .run();
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Event receipt is not processing: a replay of a PROCESSED event does nothing, a FAILED one is retried.
async function once(env: Env, key: string, body: unknown, fn: () => Promise<void>): Promise<boolean> {
  const db = env.DB;
  const ins = await db
    .prepare("INSERT OR IGNORE INTO events (provider, event_key, payload) VALUES ('whatsapp', ?1, ?2)")
    .bind(key, JSON.stringify(body))
    .run();
  if (!ins.meta.changes) {
    const row = await db.prepare("SELECT status FROM events WHERE provider = 'whatsapp' AND event_key = ?1").bind(key).first<{ status: string }>();
    if (row?.status === "PROCESSED") return true;
  }
  try {
    await fn();
    await db.prepare("UPDATE events SET status = 'PROCESSED', error = NULL, processed_at = ?2 WHERE provider = 'whatsapp' AND event_key = ?1").bind(key, nowIso()).run();
    return true;
  } catch (e) {
    await db.prepare("UPDATE events SET status = 'FAILED', error = ?2 WHERE provider = 'whatsapp' AND event_key = ?1").bind(key, String(e).slice(0, 200)).run();
    return false;
  }
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

async function handleStatus(env: Env, s: { id: string; status: string }): Promise<void> {
  const db = env.DB;
  const row = await db.prepare("SELECT id, delivery FROM messages WHERE direction = 'OUT' AND wa_message_id = ?1").bind(s.id).first<{ id: number; delivery: string | null }>();
  if (!row) return;
  if (s.status === "failed") {
    await db.prepare("UPDATE messages SET status = 'FAILED', delivery = 'failed', updated_at = ?2 WHERE id = ?1").bind(row.id, nowIso()).run();
  } else if (RANK[s.status] && (RANK[row.delivery ?? ""] ?? 0) < RANK[s.status]) {
    await db.prepare("UPDATE messages SET delivery = ?2, updated_at = ?3 WHERE id = ?1").bind(row.id, s.status, nowIso()).run();
  }
}

// A text that is only a greeting or menu word: lower-cased, with spaces, punctuation and emoji ignored ("Hello 🙏!" -> "hello").
export function plainWord(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u200d\ufe0f]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const MENU_WORDS = new Set(config.menuWords.map(plainWord));
export const isMenuWord = (text: string) => MENU_WORDS.has(plainWord(text));

// Messages that are not text and not a button tap. They are never downloaded.
const MEDIA_TYPES = new Set(["audio", "image", "video", "sticker", "document", "location", "contacts"]);

// A hold that has not lapsed, a payment link still open, or a booking (upcoming, or finished in the last 30 days).
// A photo or voice note from such a person may be a payment screenshot, so a human should look.
async function hasBookingContext(db: Env["DB"], convId: number, nowMs = Date.now()): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM conversations c WHERE c.id = ?1 AND (
         EXISTS (SELECT 1 FROM slots WHERE owner_id = ?1 AND ((state = 'HELD' AND hold_until > ?2) OR (state = 'BOOKED' AND end_utc > ?3)))
         OR EXISTS (SELECT 1 FROM payments p WHERE p.state IN ('CREATING', 'PENDING') AND p.created_at > ?4 AND (
              (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = ?1))
              OR (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = ?1)))))`,
    )
    .bind(convId, iso(nowMs), iso(nowMs - 30 * 86_400_000), iso(nowMs - 86_400_000))
    .first();
  return row !== null;
}

const menuOut = (cp: Copy): Out => ({
  type: "buttons",
  body: cp.menuBody,
  buttons: [
    { id: "menu_book", title: cp.btnBook },
    { id: "menu_how", title: cp.btnHow },
    { id: "menu_person", title: cp.btnPerson },
  ],
});

async function handleMessage(env: Env, m: Msg, from: string, name: string | undefined): Promise<void> {
  const db = env.DB;
  const secs = Number(m.timestamp);
  const at = (Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  await db
    .prepare(
      `INSERT INTO conversations (wa_id, display_name, last_user_at, source_ad_id) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (wa_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, display_name),
         source_ad_id = COALESCE(source_ad_id, excluded.source_ad_id),
         last_user_at = CASE WHEN last_user_at IS NULL OR last_user_at < excluded.last_user_at THEN excluded.last_user_at ELSE last_user_at END`,
    )
    .bind(from, name ?? null, at, m.referral?.source_id ?? null)
    .run();
  await db
    .prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1 AND mode != 'BLOCKED' AND EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)")
    .bind(from)
    .run();
  const conv = await db
    .prepare("SELECT id, mode, locale, first_question_msg AS firstQuestion FROM conversations WHERE wa_id = ?1")
    .bind(from)
    .first<{ id: number; mode: string; locale: string; firstQuestion: string | null }>();
  if (!conv) throw new Error("conversation missing");

  const choice = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null;
  const text = m.type === "text" ? (m.text?.body ?? "") : null;
  await db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, wa_message_id, kind, body, status, created_at) VALUES (?1, 'IN', ?2, ?3, ?4, 'RECEIVED', ?5)")
    .bind(conv.id, m.id, m.type, text, at)
    .run();

  if (conv.mode === "BLOCKED") return; // blocked people get no bot replies

  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${m.id}:${step}`);
  const menu = (c2: Copy, step: string) => send(menuOut(c2), step);

  // First contact: one bilingual greeting + the two language buttons, once per person ever (the key is per conversation).
  // Only a message that really went out counts: a SKIPPED row (SENDS was off) or a FAILED one is not a greeting.
  // If this first message was a real question (not a menu word), its id is kept and it is answered after the language tap.
  const greeted = await db.prepare(`SELECT 1 FROM messages WHERE dedupe_key = ?1 AND status IN ${WENT_OUT}`).bind(`greet:${conv.id}`).first();
  if (!greeted) {
    if (text !== null && plainWord(text) !== "" && !isMenuWord(text)) {
      await db.prepare("UPDATE conversations SET first_question_msg = COALESCE(first_question_msg, ?2) WHERE id = ?1").bind(conv.id, m.id).run();
    }
    await sendMessage(
      env,
      conv.id,
      {
        type: "buttons",
        body: cp.greeting,
        buttons: [
          { id: "lang_en", title: LANGUAGE_BUTTONS.en },
          { id: "lang_hi", title: LANGUAGE_BUTTONS.hi },
        ],
      },
      `greet:${conv.id}`,
    );
    return;
  }

  // HUMAN: button taps (booking, menu, FAQ, language) still work; typed text waits for Rohit in /admin and gets no bot reply.
  const isTap = choice !== null || m.type === "button";
  if (conv.mode !== "BOT" && !isTap) {
    if (MEDIA_TYPES.has(m.type) && (await hasBookingContext(db, conv.id))) await raiseAttention(db, "MEDIA_FROM_CUSTOMER", `conv:${conv.id}`);
    return;
  }

  // lang_kn: a language button from before Hindi replaced the third language; those chats continue in English.
  if (choice === "lang_en" || choice === "lang_hi" || choice === "lang_kn") {
    const locale = choice === "lang_hi" ? "hi" : "en";
    await db.prepare("UPDATE conversations SET locale = ?2, consent_at = COALESCE(consent_at, ?3), first_question_msg = NULL WHERE id = ?1").bind(conv.id, locale, nowIso()).run();
    const cp2 = copyFor(locale);
    if (conv.firstQuestion) {
      // Until the AI exists (ticket 13) a first-message question gets what any typed question gets: one acknowledgement and an item for Rohit.
      await raiseAttention(db, "FREE_TEXT", `conv:${conv.id}`);
      await sendMessage(env, conv.id, { type: "text", text: cp2.ack }, `${conv.firstQuestion}:ack`);
    }
    await menu(cp2, "menu");
    return;
  }
  if (await bookingChoice(env, choice, conv.id, m.id)) return;
  if (await sessionChoice(env, choice, conv.id, m.id)) return;
  if (await rescheduleChoice(env, choice, conv.id, m.id)) return;
  if (choice === "menu_how") {
    await send(
      {
        type: "list",
        body: cp.faqBody,
        button: cp.faqButton,
        rows: [...config.faqIds.map((id) => ({ id: `faq_${id}`, title: cp.faqTitles[id] })), { id: "menu_lang", title: cp.changeLanguageRow }],
      },
      "faq",
    );
    return;
  }
  if (choice === "menu_lang") {
    await send(
      {
        type: "buttons",
        body: cp.chooseLanguage,
        buttons: [
          { id: "lang_en", title: LANGUAGE_BUTTONS.en },
          { id: "lang_hi", title: LANGUAGE_BUTTONS.hi },
        ],
      },
      "lang",
    );
    return;
  }
  if (choice === "menu_person") {
    await db.prepare("UPDATE conversations SET mode = 'HUMAN' WHERE id = ?1 AND mode = 'BOT'").bind(conv.id).run();
    await raiseAttention(db, "HUMAN_REQUEST", `conv:${conv.id}`); // at most one open item per person
    await send({ type: "text", text: cp.handoffAck }, "handoff");
    return;
  }
  if (choice === "menu_ask") {
    // The old "Ask a question" button, still sitting in older chats.
    await send({ type: "text", text: cp.askPrompt }, "ask");
    return;
  }
  const faq = config.faqIds.find((id) => `faq_${id}` === choice);
  if (faq) {
    await send({ type: "text", text: cp.faqAnswers[faq] }, "answer");
    await menu(cp, "menu");
    return;
  }

  // Not text: voice note, image, video, sticker, document, location, contact. Never downloaded.
  if (MEDIA_TYPES.has(m.type)) {
    if (await hasBookingContext(db, conv.id)) {
      await raiseAttention(db, "MEDIA_FROM_CUSTOMER", `conv:${conv.id}`);
      await send({ type: "text", text: cp.mediaNoticeCustomer }, "media");
      return;
    }
    // Everyone else: the first one each (India) day gets the notice and the menu; later ones get nothing.
    const first = await sendMessage(env, conv.id, { type: "text", text: cp.mediaNotice }, `media:${conv.id}:${istDay(Date.now())}`);
    if (first !== "DUPLICATE") await menu(cp, "menu");
    return;
  }

  // Any text, or a template quick-reply tap, from someone with an open session offer gets the session days.
  if (m.type === "text" || m.type === "button") {
    const sid = await openOfferId(db, conv.id);
    if (sid && (await sessionChoice(env, `sess_offer_${sid}`, conv.id, m.id))) return;
  }

  // A text that is only a greeting or menu word gets the menu: no attention item, no ack.
  if (text !== null && isMenuWord(text)) {
    await menu(cp, "menu");
    return;
  }

  // Anything else is free text: stays BOT, raises attention, one acknowledgement per 24h.
  await raiseAttention(db, "FREE_TEXT", `conv:${conv.id}`);
  const since = new Date(Date.now() - config.windowHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const recent = await db
    .prepare(`SELECT 1 FROM messages WHERE conversation_id = ?1 AND direction = 'OUT' AND dedupe_key LIKE '%:ack' AND status IN ${WENT_OUT} AND created_at > ?2`)
    .bind(conv.id, since)
    .first();
  if (!recent) await send({ type: "text", text: cp.ack }, "ack");
}
