import type { Context } from "hono";
import { z } from "zod";
import { config } from "./config";
import { answerWithAI } from "./answer";
import { firstQuestion, recentMessages } from "./ai";
import { copyFor, LANGUAGE_BUTTONS, type Copy } from "./copy";
import type { Env } from "./env";
import { bookingChoice } from "./booking";
import { bookingsChoice } from "./mybookings";
import { creditBalance, packChoice, sessionOfferOut } from "./packages";
import { classifyWithoutAI, gate, isMenuWord, plainWord } from "./gate";
import { requestHuman } from "./handoff";
import { menuOut } from "./menu";
import { applyLabel, ensureState, noSellActive } from "./noise";
import { rescheduleChoice } from "./outcomes";
import { botAudit, runCrisis, runEmergency } from "./safety";
import { openOfferId, sessionChoice } from "./session";
import { raiseAttention, sendMessage, type Out, type SendResult } from "./send";
import { iso, istDay } from "./slots";
import { clearStep, noteReprompt, openStep, repromptHelpOut, repromptOut, sendStep } from "./steps";

// The tests (and the rest of the code) read these from here.
export { isMenuWord, plainWord };

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
  referral: z.object({ source_id: z.string().optional(), ctwa_clid: z.string().optional(), headline: z.string().optional() }).optional(),
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

// A send that went out, or may have (UNKNOWN), or is already on its way (DUPLICATE: the same key was sent before). SKIPPED and FAILED did not.
const wentOut = (r: SendResult | "BURST") => r === "SENT" || r === "UNKNOWN" || r === "DUPLICATE";

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

// A hold that has not lapsed, a payment link still open, or a booking (upcoming, or finished in the last 30 days).
// A photo or voice note from such a person may be a payment screenshot, so a human should look.
async function hasBookingContext(db: Env["DB"], convId: number, nowMs = Date.now()): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM conversations c WHERE c.id = ?1 AND (
         EXISTS (SELECT 1 FROM slots WHERE owner_id = ?1 AND ((state = 'HELD' AND hold_until > ?2) OR (state = 'BOOKED' AND end_utc > ?3)))
         OR EXISTS (SELECT 1 FROM payments p WHERE p.state IN ('CREATING', 'PENDING') AND p.created_at > ?4 AND (
              (p.purpose = 'INTRO' AND p.target_id IN (SELECT id FROM intros WHERE conversation_id = ?1))
              OR (p.purpose = 'SESSION' AND p.target_id IN (SELECT id FROM sessions WHERE conversation_id = ?1))
              OR (p.purpose = 'PACKAGE' AND p.target_id IN (SELECT id FROM packages WHERE conversation_id = ?1)))))`,
    )
    .bind(convId, iso(nowMs), iso(nowMs - 30 * 86_400_000), iso(nowMs - 86_400_000))
    .first();
  return row !== null;
}


type Conv = {
  id: number; wa_id: string; mode: string; locale: string; consent_at: string | null; greeted_at: string | null; last_ack_at: string | null; firstQuestion: string | null;
};

async function handleMessage(env: Env, m: Msg, from: string, name: string | undefined): Promise<void> {
  const db = env.DB;
  const secs = Number(m.timestamp);
  const at = (Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  await db
    .prepare(
      `INSERT INTO conversations (wa_id, display_name, last_user_at, source_ad_id, ad_click_id, ad_headline) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (wa_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, display_name),
         source_ad_id = COALESCE(source_ad_id, excluded.source_ad_id),
         ad_click_id = COALESCE(ad_click_id, excluded.ad_click_id),
         ad_headline = COALESCE(ad_headline, excluded.ad_headline),
         last_user_at = CASE WHEN last_user_at IS NULL OR last_user_at < excluded.last_user_at THEN excluded.last_user_at ELSE last_user_at END`,
    )
    .bind(from, name ?? null, at, m.referral?.source_id ?? null, m.referral?.ctwa_clid?.slice(0, 200) ?? null, m.referral?.headline?.slice(0, 120) ?? null)
    .run();
  await db
    .prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE wa_id = ?1 AND mode != 'BLOCKED' AND EXISTS (SELECT 1 FROM blocks WHERE wa_id = ?1)")
    .bind(from)
    .run();
  const conv = await db
    .prepare("SELECT id, wa_id, mode, locale, consent_at, greeted_at, last_ack_at, first_question_msg AS firstQuestion FROM conversations WHERE wa_id = ?1")
    .bind(from)
    .first<Conv>();
  if (!conv) throw new Error("conversation missing");
  await ensureState(db, conv.id);

  const choice = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null;
  const text = m.type === "text" ? (m.text?.body ?? "") : null;
  await db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, wa_message_id, kind, body, status, created_at) VALUES (?1, 'IN', ?2, ?3, ?4, 'RECEIVED', ?5)")
    .bind(conv.id, m.id, m.type, text, at)
    .run();
  const mine = await db.prepare("SELECT id FROM messages WHERE wa_message_id = ?1").bind(m.id).first<{ id: number }>();

  const decision = await gate(env, conv, { type: m.type, text, choice });
  if (decision !== "OPT_OUT") await db.prepare("UPDATE person_state SET opted_out_at = NULL WHERE conversation_id = ?1 AND opted_out_at IS NOT NULL").bind(conv.id).run(); // any later message ends an opt-out

  const cp = copyFor(conv.locale);
  const typed = m.type === "text";

  // Burst: if the person has already written something newer, this reply is not sent (the newer message's handler answers). Safety replies never come here.
  const burst = async (step: string, kind: string): Promise<boolean> => {
    if (!typed) return false;
    const newer = await db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ?1 AND direction = 'IN' AND (created_at > ?2 OR (created_at = ?2 AND id > ?3)) LIMIT 1")
      .bind(conv.id, at, mine?.id ?? 0)
      .first();
    if (!newer) return false;
    await db
      .prepare("INSERT OR IGNORE INTO messages (conversation_id, direction, dedupe_key, kind, body, status, skip_reason) VALUES (?1, 'OUT', ?2, ?3, NULL, 'SKIPPED', 'NEWER_MESSAGE')")
      .bind(conv.id, `${m.id}:${step}:newer`, kind)
      .run();
    return true;
  };
  const reply = async (out: Out, step: string): Promise<SendResult | "BURST"> => ((await burst(step, out.type)) ? "BURST" : sendMessage(env, conv.id, out, `${m.id}:${step}`));
  const menu = async (c2: Copy, step: string) => reply(menuOut(c2, await noSellActive(db, conv.id)), step);
  // Someone with an open session offer who writes (or taps its template button) is shown the options again: single session, 10 or 20.
  const openOffer = async (): Promise<boolean> => {
    const sid = await openOfferId(db, conv.id);
    if (sid === null) return false;
    await reply(sessionOfferOut(cp, sid), "offer");
    return true;
  };

  switch (decision) {
    case "IGNORE":
      return;
    case "CRISIS":
      await runCrisis(env, conv, m.id, text);
      return;
    case "EMERGENCY":
      await runEmergency(env, conv, m.id, text);
      return;

    case "GREETING": {
      // One bilingual greeting + the two language buttons, once per person ever. If this first message was a real question (not a menu word),
      // its id is kept and it is answered after the language tap.
      if (text !== null && plainWord(text) !== "" && !isMenuWord(text)) {
        await db.prepare("UPDATE conversations SET first_question_msg = COALESCE(first_question_msg, ?2) WHERE id = ?1").bind(conv.id, m.id).run();
      }
      if (await burst("greet", "buttons")) return;
      const buttons = [
        { id: "lang_en", title: LANGUAGE_BUTTONS.en },
        { id: "lang_hi", title: LANGUAGE_BUTTONS.hi },
      ];
      const res = await sendStep(env, conv.id, "language", { type: "buttons", body: cp.greeting, buttons }, `greet:${conv.id}`, { resend: { type: "buttons", body: cp.chooseLanguage, buttons } });
      // Only a greeting that really went out counts: a SKIPPED one (SENDS was off) or a FAILED one is not a greeting.
      if (wentOut(res)) await db.prepare("UPDATE conversations SET greeted_at = COALESCE(greeted_at, ?2) WHERE id = ?1").bind(conv.id, nowIso()).run();
      return;
    }

    case "OPT_OUT": {
      const claim = await db.prepare("UPDATE person_state SET opted_out_at = ?2 WHERE conversation_id = ?1 AND opted_out_at IS NULL").bind(conv.id, nowIso()).run();
      if (claim.meta.changes) {
        await botAudit(db, "OPT_OUT", `conv:${conv.id}`);
        await reply({ type: "text", text: cp.optOutConfirm }, "optout");
      }
      return;
    }

    case "HANDOFF":
      await requestHuman(env, conv.id); // HUMAN mode, one open item, one email to Rohit (at most one per person per 6 hours)
      await reply({ type: "text", text: cp.handoffAck }, "handoff");
      return;

    case "HUMAN_WAIT":
      // Typed text waits for Rohit in /admin. A photo or file from someone with a booking may be a payment screenshot: he should know.
      if (text === null && (await hasBookingContext(db, conv.id))) await raiseAttention(db, "MEDIA_FROM_CUSTOMER", `conv:${conv.id}`);
      return;

    case "MEDIA": {
      // Voice note, image, video, sticker, document, location, contact. Never downloaded.
      if (await hasBookingContext(db, conv.id)) {
        await raiseAttention(db, "MEDIA_FROM_CUSTOMER", `conv:${conv.id}`);
        await reply({ type: "text", text: cp.mediaNoticeCustomer }, "media");
        return;
      }
      // Everyone else: the first one each (India) day gets the notice and the menu; later ones get nothing.
      const today = istDay(Date.now());
      const st = await db.prepare("SELECT media_notice_day AS day FROM person_state WHERE conversation_id = ?1").bind(conv.id).first<{ day: string | null }>();
      if (st?.day === today) return;
      const first = await sendMessage(env, conv.id, { type: "text", text: cp.mediaNotice }, `media:${conv.id}:${today}`);
      if (first === "SENT" || first === "UNKNOWN") await db.prepare("UPDATE person_state SET media_notice_day = ?2 WHERE conversation_id = ?1").bind(conv.id, today).run();
      if (first !== "DUPLICATE") await menu(cp, "menu");
      return;
    }

    case "ACK_WORD":
      return; // "ok", "thanks": no reply, no strike

    case "MENU":
      if (await openOffer()) return;
      await clearStep(db, conv.id);
      await menu(cp, "menu");
      return;

    case "BOOKING_WORD":
      await db.prepare("UPDATE person_state SET book_tap_at = ?2 WHERE conversation_id = ?1").bind(conv.id, nowIso()).run();
      if (await openOffer()) return;
      await bookingChoice(env, "menu_book", conv.id, m.id); // the same as tapping Book; in a quiet period it does not end the quiet period
      return;

    case "BUDGET_FALLBACK":
    case "TO_CLASSIFIER":
      await classified(decision);
      return;

    case "TAP":
      await tapped();
      return;
  }

  // ---- typed text that reached the classifier: the assistant when AI_REPLIES is on, otherwise the rule-based one ----
  async function classified(decision: "BUDGET_FALLBACK" | "TO_CLASSIFIER"): Promise<void> {
    // The assistant (when AI_REPLIES is on) labels and answers the question. Otherwise, or when it cannot answer in the middle of a booking, the old path below.
    let viaAI = false;
    if (decision === "TO_CLASSIFIER" && text !== null) {
      const answered = await answerWithAI({
        env, conv: conv!, text, msgId: m.id, messages: await recentMessages(db, conv!.id, mine?.id ?? 0),
        send: (out, step) => reply(out, step), newerExists: () => burst("ai", "text"),
      });
      if (answered !== "off" && answered !== "reprompt") return;
      viaAI = answered === "reprompt";
    }
    const label = viaAI ? "TO_CLASSIFIER" : classifyWithoutAI(text ?? "");
    if (label !== "TO_CLASSIFIER") {
      const res = await applyLabel(env, conv!, label, text ?? "", { msgId: m.id, say: (out, step) => reply(out, step) });
      if (res.stop) return; // a strike, a block or a quiet week: nothing more is said
    }
    // A booking step is open: send it again, with the hint. A re-prompt is not a strike.
    const open = await openStep(db, conv!.id);
    if (open) {
      const res = await reply(repromptOut(cp, open), "reprompt");
      if (res !== "BURST") {
        const n = await noteReprompt(db, conv!.id);
        if ((n?.n ?? 0) >= config.booking.repromptHelpAfter) await reply(repromptHelpOut(cp), "reprompt-help");
      }
      return;
    }
    if (await openOffer()) return;
    if (decision === "BUDGET_FALLBACK") {
      await botAudit(db, "BUDGET_FALLBACK", `conv:${conv!.id}`);
      const noSell = await noSellActive(db, conv!.id);
      await reply(menuOut(cp, noSell, noSell ? cp.aiFallbackNoSell : cp.aiFallback, true), "fallback");
      return;
    }
    // Anything else is free text: stays BOT, raises attention, one acknowledgement per 24h.
    await raiseAttention(db, "FREE_TEXT", `conv:${conv!.id}`);
    const recent = conv!.last_ack_at !== null && Date.now() - Date.parse(conv!.last_ack_at) < config.windowHours * 3_600_000;
    if (!recent) {
      const res = await reply({ type: "text", text: cp.ack }, "ack");
      if (res !== "BURST" && wentOut(res)) await db.prepare("UPDATE conversations SET last_ack_at = ?2 WHERE id = ?1").bind(conv!.id, nowIso()).run();
    }
  }

  // ---- a button or list tap, or a template quick reply ----
  async function tapped(): Promise<void> {
    await clearStep(db, conv!.id); // a tap moves on; the step sent next (if any) becomes the open one
    // lang_kn: a language button from before Hindi replaced the third language; those chats continue in English.
    if (choice === "lang_en" || choice === "lang_hi" || choice === "lang_kn") {
      const locale = choice === "lang_hi" ? "hi" : "en";
      await db.prepare("UPDATE conversations SET locale = ?2, consent_at = COALESCE(consent_at, ?3), first_question_msg = NULL WHERE id = ?1").bind(conv!.id, locale, nowIso()).run();
      const cp2 = copyFor(locale);
      if (conv!.firstQuestion) {
        // The question the person asked before choosing a language: the assistant answers it (its text may already be wiped, and then it cannot).
        // Without the assistant it gets what any typed question gets: one acknowledgement and an item for Rohit.
        const asked = await firstQuestion(db, conv!.firstQuestion);
        const key = conv!.firstQuestion;
        const answered = asked
          ? await answerWithAI({
              env, conv: { ...conv!, locale, consent_at: nowIso(), mode: conv!.mode }, text: asked.text, msgId: key, messages: asked.messages,
              send: (out, step) => sendMessage(env, conv!.id, out, `${key}:${step}`),
            })
          : "off";
        if (answered === "finished") return; // the answer carried its own buttons, or nothing more is to be said
        if (answered === "off" || answered === "reprompt") {
          await raiseAttention(db, "FREE_TEXT", `conv:${conv!.id}`);
          const res = await sendMessage(env, conv!.id, { type: "text", text: cp2.ack }, `${key}:ack`);
          if (wentOut(res)) await db.prepare("UPDATE conversations SET last_ack_at = ?2 WHERE id = ?1").bind(conv!.id, nowIso()).run();
        }
      }
      await menu(cp2, "menu");
      return;
    }
    if (choice === "menu_book" || /^(pk|go|gate)_/.test(choice ?? "")) await db.prepare("UPDATE person_state SET book_tap_at = ?2 WHERE conversation_id = ?1").bind(conv!.id, nowIso()).run(); // a buying tap (warm leads in the digest)
    if (await bookingChoice(env, choice, conv!.id, m.id)) return;
    if (await sessionChoice(env, choice, conv!.id, m.id)) return;
    if (await packChoice(env, choice, conv!.id, m.id)) return;
    if (await bookingsChoice(env, choice, conv!.id, m.id)) return;
    if (await rescheduleChoice(env, choice, conv!.id, m.id)) return;
    if (choice === "menu_how") {
      // Help: the 6 answers, then My bookings, Talk to a person and Change language (9 rows).
      await reply(
        {
          type: "list",
          body: cp.helpListBody,
          button: cp.faqButton,
          rows: [
            ...config.faqIds.map((id) => ({ id: `faq_${id}`, title: cp.faqTitles[id] })),
            { id: "menu_bookings", title: cp.rowMyBookings },
            { id: "menu_person", title: cp.btnPerson },
            { id: "menu_lang", title: cp.changeLanguageRow },
          ],
        },
        "faq",
      );
      return;
    }
    if (choice === "menu_lang") {
      await reply(
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
    if (choice === "menu_ask") {
      // The old "Ask a question" button, still sitting in older chats.
      await reply({ type: "text", text: cp.askPrompt }, "ask");
      return;
    }
    const faq = config.faqIds.find((id) => `faq_${id}` === choice);
    if (faq) {
      await reply({ type: "text", text: cp.faqAnswers[faq] }, "answer");
      await menu(cp, "menu");
      return;
    }
    if (choice === "book_keep") return; // "Keep it" under the already-booked message: nothing to do
    if (choice === null) {
      // A template quick-reply tap: the options if an offer is open; "Book a session" (package_confirmed) for someone with sessions left;
      // otherwise it is treated like free text.
      if (await openOffer()) return;
      if (m.type === "button" && (await creditBalance(db, conv!.id)) > 0 && (await packChoice(env, "bk_new", conv!.id, m.id))) return;
      await classified("TO_CLASSIFIER");
    }
    // Any other id (an old or unknown button): nothing.
  }
}
