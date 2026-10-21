import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { langOf } from "./copy";
import type { Env } from "./env";
import { sendsEnvOn, sendsOn } from "./switches";

export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title: string; rows: ListRow[] };
export type TemplateName = keyof typeof config.templates;
export type Out =
  | { type: "text"; text: string }
  | { type: "buttons"; body: string; buttons: { id: string; title: string }[] }
  // `rows` is one section titled like the button; `sections` is for lists that need their own section titles.
  | { type: "list"; body: string; button: string; rows?: ListRow[]; sections?: ListSection[] }
  | { type: "cta"; body: string; label: string; url: string }
  // `params` are the English wording's values; `paramsHi` the Hindi wording's (a Hindi person who gets the English template gets `params`).
  | { type: "template"; name: TemplateName; params: string[]; paramsHi?: string[] };

export type SendResult =
  | "SENT" | "FAILED" | "UNKNOWN" | "SKIPPED" // row written
  | "BLOCKED" | "WINDOW_CLOSED" | "TEMPLATE_UNAPPROVED" | "OPTED_OUT" | "DUPLICATE"; // nothing sent

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

// The template a person gets: the Hindi one for Hindi chats once Meta has approved it, otherwise the English one.
export function templateVariant(out: Extract<Out, { type: "template" }>, locale: string) {
  const t = config.templates[out.name];
  if (langOf(locale) === "hi" && t.hi.approved) return { name: t.hi.name, language: t.hi.language, params: out.paramsHi ?? out.params, approved: true };
  return { name: out.name as string, language: t.language, params: out.params, approved: t.approved };
}

// Meta limits: 3 reply buttons, 20-char button titles, 10 list rows in all, 24-char row and section titles, 72-char row descriptions,
// 20-char list button and CTA label, 1024-char bodies. A list section needs a title (docs for v26 list it as required);
// without `sections` the button text doubles as the one section's title.
export function buildPayload(out: Out, to: string, locale = "en"): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  if (out.type !== "template" && out.type !== "text" && out.body.length > 1024) throw new Error("body over 1024 chars");
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
    case "list": {
      const sections = out.sections ?? [{ title: out.button, rows: out.rows ?? [] }];
      const rows = sections.flatMap((x) => x.rows);
      if (rows.length < 1 || rows.length > 10) throw new Error("list: 1 to 10 rows");
      if (sections.some((x) => x.rows.length === 0)) throw new Error("list: empty section");
      if (sections.some((x) => x.title.length < 1 || x.title.length > 24)) throw new Error("section title: 1 to 24 chars");
      if (rows.some((r) => r.title.length < 1 || r.title.length > 24)) throw new Error("row title over 24 chars");
      if (rows.some((r) => (r.description?.length ?? 0) > 72)) throw new Error("row description over 72 chars");
      if (out.button.length < 1 || out.button.length > 20) throw new Error("list button text: 1 to 20 chars");
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: out.body },
          action: {
            button: out.button,
            sections: sections.map((x) => ({
              title: x.title,
              rows: x.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
            })),
          },
        },
      };
    }
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
    case "template": {
      const v = templateVariant(out, locale);
      return {
        ...base,
        type: "template",
        template: {
          name: v.name,
          language: { code: v.language },
          ...(v.params.length ? { components: [{ type: "body", parameters: v.params.map((text) => ({ type: "text", text })) }] } : {}),
        },
      };
    }
  }
}

const summary = (out: Out) => (out.type === "template" ? `template:${out.name}` : out.type === "text" ? out.text : out.body);

// The single send path. dedupeKey makes a retry of the same intent a no-op (never a second message).
// `safety` is for the crisis and emergency messages only: they reach blocked people too, and go out while the SENDS switch is paused
// (never when the SENDS env flag is "false").
export async function sendMessage(env: Env, conversationId: number, out: Out, dedupeKey: string, opts: { safety?: boolean } = {}): Promise<SendResult> {
  const db = env.DB;
  const conv = await db
    .prepare("SELECT wa_id, mode, locale, last_user_at FROM conversations WHERE id = ?1")
    .bind(conversationId)
    .first<{ wa_id: string; mode: string; locale: string; last_user_at: string | null }>();
  if (!conv || (conv.mode === "BLOCKED" && !opts.safety)) return "BLOCKED";

  if (out.type === "template") {
    // Someone who wrote "stop" gets no template until they write again.
    const optedOut = await db.prepare("SELECT 1 FROM person_state WHERE conversation_id = ?1 AND opted_out_at IS NOT NULL").bind(conversationId).first();
    if (optedOut) return "OPTED_OUT";
    if (!templateVariant(out, conv.locale).approved) {
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

  const payload = buildPayload(out, conv.wa_id, conv.locale); // throws on bad shape, before anything is stored

  const ins = await db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, dedupe_key, kind, body) VALUES (?1, 'OUT', ?2, ?3, ?4)")
    .bind(conversationId, dedupeKey, out.type, summary(out))
    .run();
  let id = ins.meta.last_row_id;
  if (!ins.meta.changes) {
    // A row that never went out (SENDS was off, or Meta refused it) does not count as sent, so the same intent may try again.
    // SENT, SENDING, PENDING and UNKNOWN never do: the message may be on its way. One caller wins the UPDATE.
    const again = await db
      .prepare("UPDATE messages SET status = 'PENDING', updated_at = ?2 WHERE dedupe_key = ?1 AND direction = 'OUT' AND status IN ('SKIPPED', 'FAILED') RETURNING id")
      .bind(dedupeKey, nowIso())
      .first<{ id: number }>();
    if (!again) return "DUPLICATE";
    id = again.id;
  }

  const setStatus = (status: string, waId: string | null = null) =>
    db
      .prepare("UPDATE messages SET status = ?2, wa_message_id = COALESCE(?3, wa_message_id), updated_at = ?4 WHERE id = ?1")
      .bind(id, status, waId, nowIso())
      .run();

  if (!(opts.safety ? sendsEnvOn(env) : await sendsOn(env))) {
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
