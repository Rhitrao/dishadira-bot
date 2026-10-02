import type { Context } from "hono";
import { z } from "zod";
import { config } from "./config";
import { copyFor, LANGUAGE_BUTTONS } from "./copy";
import type { Env } from "./env";
import { bookingChoice } from "./booking";
import { rescheduleChoice } from "./outcomes";
import { sessionChoice } from "./session";
import { raiseAttention, sendMessage, type Out } from "./send";

type C = Context<{ Bindings: Env }>;

const message = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string() }).optional(),
      list_reply: z.object({ id: z.string() }).optional(),
    })
    .optional(),
  referral: z.object({ source_id: z.string().optional() }).optional(),
});
const status = z.object({ id: z.string().min(1), status: z.string() });
const payload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
            messages: z.array(message).optional(),
            statuses: z.array(status).optional(),
          }),
        }),
      ),
    }),
  ),
});
type Msg = z.infer<typeof message>;

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
  let parsed;
  try {
    parsed = payload.safeParse(JSON.parse(raw));
  } catch {
    return c.text("bad json", 400);
  }
  if (!parsed.success) return c.text("bad payload", 400);

  let failed = false;
  for (const entry of parsed.data.entry) {
    for (const { value } of entry.changes) {
      const names = new Map((value.contacts ?? []).map((k) => [k.wa_id, k.profile?.name]));
      for (const m of value.messages ?? []) {
        failed = !(await once(c.env, m.id, { type: m.type }, () => handleMessage(c.env, m, names.get(m.from)))) || failed;
      }
      for (const s of value.statuses ?? []) {
        failed = !(await once(c.env, `status:${s.id}:${s.status}`, { status: s.status }, () => handleStatus(c.env, s))) || failed;
      }
    }
  }
  // A retriable error makes Meta redeliver; outbound dedupe keys keep the retry from double-sending.
  return failed ? c.text("retry", 500) : c.text("ok");
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

async function handleMessage(env: Env, m: Msg, name: string | undefined): Promise<void> {
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
    .bind(m.from, name ?? null, at, m.referral?.source_id ?? null)
    .run();
  await db
    .prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1 AND mode != 'BLOCKED' AND EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)")
    .bind(m.from)
    .run();
  const conv = await db.prepare("SELECT id, mode, locale FROM conversations WHERE wa_id = ?1").bind(m.from).first<{ id: number; mode: string; locale: string }>();
  if (!conv) throw new Error("conversation missing");

  const choice = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null;
  const text = m.type === "text" ? (m.text?.body ?? "") : null;
  await db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, wa_message_id, kind, body, status, created_at) VALUES (?1, 'IN', ?2, ?3, ?4, 'RECEIVED', ?5)")
    .bind(conv.id, m.id, m.type, text, at)
    .run();

  if (conv.mode !== "BOT") return; // BLOCKED and HUMAN conversations get no bot replies

  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${m.id}:${step}`);
  const menu = (c2: typeof cp, step: string) =>
    send(
      {
        type: "buttons",
        body: c2.menuBody,
        buttons: [
          { id: "menu_book", title: c2.btnBook },
          { id: "menu_how", title: c2.btnHow },
          { id: "menu_ask", title: c2.btnAsk },
        ],
      },
      step,
    );

  // First contact: greeting + language choice, once per person ever (the key is per conversation).
  const greeted = await db.prepare("SELECT 1 FROM messages WHERE dedupe_key = ?1").bind(`greet:${conv.id}`).first();
  if (!greeted) {
    await sendMessage(
      env,
      conv.id,
      {
        type: "buttons",
        body: cp.greeting,
        buttons: [
          { id: "lang_en", title: LANGUAGE_BUTTONS.en },
          { id: "lang_kn", title: LANGUAGE_BUTTONS.kn },
        ],
      },
      `greet:${conv.id}`,
    );
    return;
  }

  if (choice === "lang_en" || choice === "lang_kn") {
    const locale = choice === "lang_kn" ? "kn" : "en";
    await db.prepare("UPDATE conversations SET locale = ?2, consent_at = COALESCE(consent_at, ?3) WHERE id = ?1").bind(conv.id, locale, nowIso()).run();
    await menu(copyFor(locale), "menu");
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
        rows: config.faqIds.map((id) => ({ id: `faq_${id}`, title: cp.faqTitles[id] })),
      },
      "faq",
    );
    return;
  }
  if (choice === "menu_ask") {
    await send({ type: "text", text: cp.askPrompt }, "ask");
    return;
  }
  const faq = config.faqIds.find((id) => `faq_${id}` === choice);
  if (faq) {
    await send({ type: "text", text: cp.faqAnswers[faq] }, "answer");
    await menu(cp, "menu");
    return;
  }

  // Anything else is free text: stays BOT, raises attention, one acknowledgement per 24h.
  await raiseAttention(db, "FREE_TEXT", `conv:${conv.id}`);
  const since = new Date(Date.now() - config.windowHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const recent = await db
    .prepare("SELECT 1 FROM messages WHERE conversation_id = ?1 AND direction = 'OUT' AND dedupe_key LIKE '%:ack' AND created_at > ?2")
    .bind(conv.id, since)
    .first();
  if (!recent) await send({ type: "text", text: cp.ack }, "ack");
}
