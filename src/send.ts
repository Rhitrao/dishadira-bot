import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Env } from "./env";

export type Out =
  | { type: "text"; text: string }
  | { type: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | { type: "list"; body: string; button: string; rows: { id: string; title: string }[] }
  | { type: "cta"; body: string; label: string; url: string }
  | { type: "template"; name: keyof typeof config.templates; params: string[] };

export type SendResult =
  | "SENT" | "FAILED" | "UNKNOWN" | "SKIPPED" // row written
  | "BLOCKED" | "WINDOW_CLOSED" | "TEMPLATE_UNAPPROVED" | "DUPLICATE"; // nothing sent

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Open attention items are not repeated for the same kind + target.
export async function raiseAttention(db: D1Database, kind: string, target: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attention (kind, target) SELECT ?1, ?2
       WHERE NOT EXISTS (SELECT 1 FROM attention WHERE kind = ?1 AND target = ?2 AND resolved_at IS NULL)`,
    )
    .bind(kind, target)
    .run();
}

// Meta limits: 3 reply buttons, 20-char button titles, 10 list rows, 24-char row titles, 20-char CTA label.
export function buildPayload(out: Out, to: string): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (out.type) {
    case "text":
      return { ...base, type: "text", text: { body: out.text } };
    case "buttons":
      if (out.buttons.length < 1 || out.buttons.length > 3) throw new Error("buttons: 1 to 3");
      if (out.buttons.some((b) => b.title.length > 20)) throw new Error("button title over 20 chars");
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: out.body },
          action: { buttons: out.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "list":
      if (out.rows.length < 1 || out.rows.length > 10) throw new Error("list: 1 to 10 rows");
      if (out.rows.some((r) => r.title.length > 24)) throw new Error("row title over 24 chars");
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: out.body },
          action: { button: out.button, sections: [{ rows: out.rows.map((r) => ({ id: r.id, title: r.title })) }] },
        },
      };
    case "cta":
      if (out.label.length > 20) throw new Error("CTA label over 20 chars");
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: out.body },
          action: { name: "cta_url", parameters: { display_text: out.label, url: out.url } },
        },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: out.name,
          language: { code: config.templates[out.name].language },
          ...(out.params.length ? { components: [{ type: "body", parameters: out.params.map((text) => ({ type: "text", text })) }] } : {}),
        },
      };
  }
}

const summary = (out: Out) => (out.type === "template" ? `template:${out.name}` : out.type === "text" ? out.text : out.body);

// The single send path. dedupeKey makes a retry of the same intent a no-op (never a second message).
export async function sendMessage(env: Env, conversationId: number, out: Out, dedupeKey: string): Promise<SendResult> {
  const db = env.DB;
  const conv = await db
    .prepare("SELECT wa_id, mode, last_user_at FROM conversations WHERE id = ?1")
    .bind(conversationId)
    .first<{ wa_id: string; mode: string; last_user_at: string | null }>();
  if (!conv || conv.mode === "BLOCKED") return "BLOCKED";

  if (out.type === "template") {
    if (!config.templates[out.name]?.approved) {
      await raiseAttention(db, "TEMPLATE_UNAPPROVED", `${out.name}:conv:${conversationId}`);
      return "TEMPLATE_UNAPPROVED";
    }
  } else {
    const last = conv.last_user_at ? Date.parse(conv.last_user_at) : NaN;
    if (!(Date.now() - last < config.windowHours * 3600_000)) {
      await raiseAttention(db, "OUTSIDE_WINDOW", `conv:${conversationId}`);
      return "WINDOW_CLOSED";
    }
  }

  const payload = buildPayload(out, conv.wa_id); // throws on bad shape, before anything is stored

  const ins = await db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, dedupe_key, kind, body) VALUES (?1, 'OUT', ?2, ?3, ?4)")
    .bind(conversationId, dedupeKey, out.type, summary(out))
    .run();
  if (!ins.meta.changes) return "DUPLICATE";
  const id = ins.meta.last_row_id;

  const setStatus = (status: string, waId: string | null = null) =>
    db
      .prepare("UPDATE messages SET status = ?2, wa_message_id = COALESCE(?3, wa_message_id), updated_at = ?4 WHERE id = ?1")
      .bind(id, status, waId, nowIso())
      .run();

  if (env.SENDS !== "true") {
    await setStatus("SKIPPED");
    return "SKIPPED";
  }

  // Atomic claim: only one caller moves PENDING -> SENDING.
  const claim = await db
    .prepare("UPDATE messages SET status = 'SENDING', updated_at = ?2 WHERE id = ?1 AND status = 'PENDING'")
    .bind(id, nowIso())
    .run();
  if (!claim.meta.changes) return "DUPLICATE";

  try {
    const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${env.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
      await setStatus("SENT", data?.messages?.[0]?.id ?? null);
      return "SENT";
    }
    // 5xx may still have been accepted by Meta: record UNKNOWN, never resend blindly.
    const status = res.status >= 500 ? "UNKNOWN" : "FAILED";
    await setStatus(status);
    return status;
  } catch {
    await setStatus("UNKNOWN"); // timeout or network error: outcome not known
    return "UNKNOWN";
  }
}

// Free text inside the 24-hour window, the approved template outside it.
export async function sendOrTemplate(env: Env, conversationId: number, text: Out, template: Out, dedupeKey: string): Promise<SendResult> {
  const conv = await env.DB.prepare("SELECT last_user_at FROM conversations WHERE id = ?1").bind(conversationId).first<{ last_user_at: string | null }>();
  const inWindow = conv?.last_user_at && Date.now() - Date.parse(conv.last_user_at) < config.windowHours * 3600_000;
  return sendMessage(env, conversationId, inWindow ? text : template, dedupeKey);
}
