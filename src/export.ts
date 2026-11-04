// Ticket 37: the owner's chat export. One JSON file of the conversations active in the last N days (1 to 30), for the owner to read
// or to attach to a Claude chat for an analysis and an action plan (docs/ANALYSIS.md). Owner only (/admin, and /app for the owner).
// What is in it, and what never is:
//  - Each chat has a code ("C-0007", from the conversation id, the same number as /admin/conv/7) and the last 4 digits of the number.
//    Never the full number, never the WhatsApp name, never Meta's click id.
//  - Message text only while it still exists: the chat wipe (src/wipe.ts) removes it CHAT_RETENTION_MINUTES after the person's last
//    message, and this export never brings it back. Every text field is redacted first (redact() below): phone numbers, emails, UPI ids,
//    payment ids, digit runs of 6 or more, links other than our own, and the person's own name.
//  - A chat with a crisis or medical-emergency message (open or past) keeps its counts and outcome, never its text. So does a blocked
//    number. Counts, steps and outcomes come from our own tables (bookings, payments, refunds, follow-ups), not from the text.
import { asciiDigits } from "./aicheck";
import type { Env } from "./env";
import { iso, istDay } from "./slots";
import { retentionMinutes } from "./wipe";

export const EXPORT_LIMITS = { minDays: 1, maxDays: 30, defaultDays: 7, maxChats: 2000, maxMessages: 20000 } as const;

// "7" -> 7; missing -> the default; anything else (0, 31, "abc", "2.5") -> null.
export function exportDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return EXPORT_LIMITS.defaultDays;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= EXPORT_LIMITS.minDays && n <= EXPORT_LIMITS.maxDays ? n : null;
}

export const exportFileName = (nowMs: number) => `disha-dira-chats-${istDay(nowMs)}.json`;
export const chatCode = (convId: number) => `C-${String(convId).padStart(4, "0")}`;

// ---- redaction ----
const OWN_HOST = /^(?:[\w-]+\.)*disha-dira\.com$|^wa\.me$/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UPI = /[\w.-]{2,}@[a-z][a-z0-9]{1,}\b/gi; // after emails, so only handles with no dot after the @ are left ("name@okhdfcbank")
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\b(?:[\w-]+\.)+(?:com|in|net|org|io|me|co|xyz|info|link|app|ly|gl|page|site|online|shop|store)\b(?:\/[^\s<>"]*)?/gi;
const PAYMENT_ID = /\b(?:pay|order|plink|rfnd|inv|cust)_[A-Za-z0-9]{6,}\b/g;
const GROUPED_PHONE = /\+?\d[\d\s().-]{6,}\d/g;

const hostOf = (link: string) => link.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The words of a person's WhatsApp name (3 letters or more), to be removed wherever they appear in that chat.
export const nameWords = (name: string | null | undefined): string[] =>
  (name ?? "").split(/[^\p{L}\p{M}]+/u).filter((w) => [...w].length >= 3);

export function redact(text: string, names: readonly string[] = []): string {
  let t = text
    .replace(EMAIL, "[email]")
    .replace(UPI, "[upi]")
    .replace(LINK, (m) => (OWN_HOST.test(hostOf(m)) ? m.replace(/\/p\/[^\s/?#]+/i, "/p/[token]") : "[link]"))
    .replace(PAYMENT_ID, "[id]");
  t = asciiDigits(t)
    .replace(GROUPED_PHONE, (m) => (m.replace(/\D/g, "").length >= 8 ? "[phone]" : m))
    .replace(/\d{8,}/g, "[phone]")
    .replace(/\d{6,7}/g, "[number]");
  for (const w of names) t = t.replace(new RegExp(`(?<![\\p{L}\\p{M}])${escapeRe(w)}(?![\\p{L}\\p{M}])`, "giu"), "[name]");
  return t;
}

// ---- the file ----
// The booking steps, in the order a ₹99 call goes; "furthest_step" is the last one the chat reached (our own records, not the text).
export const STEPS = [
  "first_message", "greeted", "language_chosen", "age_question", "age_confirmed", "service_list", "who_for", "day_list", "time_list",
  "call_held", "pay_link_sent", "call_paid",
] as const;
type Step = (typeof STEPS)[number];
const STEP_KEYS: [string, Step][] = [[":age", "age_question"], [":service", "service_list"], [":who", "who_for"], [":days", "day_list"], [":times", "time_list"], [":pay", "pay_link_sent"], [":stillheld", "pay_link_sent"]];

const PAID = ["PAID", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED"];
const BOOKED_SESSION = ["CONFIRMED", "CREDIT_BOOKED", "COMPLETED", "NO_SHOW", "NOT_FIT", "CANCELLED"];
const MEDIA: Record<string, string> = { image: "[photo]", video: "[video]", audio: "[voice note or audio]", voice: "[voice note]", document: "[file]", sticker: "[sticker]", location: "[location]", contacts: "[contact card]", reaction: "[reaction]" };
const OUT_KIND: Record<string, string> = { text: "text", buttons: "button", cta: "button", list: "list", template: "template" };

const NOTES = [
  "One file of the conversations with activity in the last `days` days (WhatsApp). Times are India time (Asia/Kolkata).",
  "Message text is deleted automatically some days after a person's last message (`text_kept_for`), so older text is simply not here; counts, steps and outcomes come from booking and payment records and are complete.",
  "code: a stable code for the chat (C-0007 is the person page /admin/conv/7). last4: the last 4 digits of their WhatsApp number. No full numbers and no names are in this file.",
  "source.kind: ad = came from a Click-to-WhatsApp ad (ad_id, ad_headline); instagram / messenger = opened from our Instagram or Messenger reply; tag = no ad data but their first message carried a tag such as (BLR) from an ad's prefilled text; organic_or_unknown = none of these. source.tag is shown whenever a tag was seen.",
  "language: the language they chose (en or hi), or not_chosen. mode: BOT (the bot answers), HUMAN (with the team), BLOCKED.",
  "furthest_step: the last booking step reached, in this order: " + STEPS.join(" > ") + ". summary.reached_step counts chats that got at least that far.",
  "outcome: paid_intro (the ₹99 call paid), intro_status (the latest call's state: PAID, CALLED_SESSION, CALLED_NOT_FIT, MISSED, RESCHEDULED, RUDE, EXPIRED, CANCELLED_BY_US, HELD), sessions and packages bought, refunds, money paid in rupees.",
  "followups: automatic follow-ups (stage 1 about 60 minutes, stage 2 about 20 hours after their last real message).",
  "messages: from customer, bot or team; kind text, button (a tap, or our message with buttons), list, template or media. Phone numbers, emails, UPI ids, payment ids, other people's links and the person's name are replaced with [phone], [email], [upi], [id], [link], [number], [name].",
  "safety: true means the chat had a crisis or medical-emergency message; its text is withheld. Blocked numbers: counts only, no text.",
  "Do not share this file. Delete it after use.",
];

type ConvRow = {
  id: number; waId: string; name: string | null; locale: string; mode: string; createdAt: string; lastUserAt: string | null; lastMsgAt: string | null;
  adId: string | null; adHeadline: string | null; adClick: string | null; consentAt: string | null; greetedAt: string | null; ageOkAt: string | null;
  optedOutAt: string | null; social: string | null;
};
type MsgRow = { conv: number; dir: string; kind: string; body: string | null; at: string; key: string | null; status: string };

export type ExportMessage = { at: string; from: "customer" | "bot" | "team"; kind: string; text: string; status?: string };
export type ExportChat = {
  code: string; last4: string; first_seen: string; last_message_at: string | null;
  source: { kind: string; ad_id: string | null; ad_headline: string | null; tag: string | null };
  language: string; mode: string; blocked: boolean; stopped: boolean; handed_to_team: boolean; safety: boolean; furthest_step: Step;
  outcome: {
    paid_intro: boolean; intro_status: string | null; intro_calls: number; calls_missed: number; calls_cancelled_by_us: number;
    sessions_booked: number; sessions_completed: number; sessions_cancelled: number; sessions_no_show: number;
    packages_bought: number[]; paid_rupees: number; refunds: { for: string; reason: string; state: string }[];
  };
  followups: { stage: number; at: string; state: string }[];
  message_count: number; text_wiped_count: number;
  messages: ExportMessage[]; note?: string;
};

// India time, as an ISO string with its offset: "2026-11-03T14:05:00+05:30".
export const istIso = (utc: string) => new Date(Date.parse(utc) + 330 * 60_000).toISOString().slice(0, 19) + "+05:30";
const count = <K extends string>(o: Record<string, number>, k: K) => ((o[k] = (o[k] ?? 0) + 1), o);
const TAG = /\(([A-Z][A-Z0-9]{1,9})\)/;

// `cap` is the hard limit on chats and messages in one file (tests pass a small one).
export async function buildExport(env: Env, days: number, nowMs = Date.now(), cap: { maxChats: number; maxMessages: number } = EXPORT_LIMITS) {
  const db = env.DB;
  const since = iso(nowMs - days * 86_400_000);
  const WIN = `WITH win AS (SELECT c.id FROM conversations c WHERE c.created_at >= ?1 OR c.last_user_at >= ?1
    OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at >= ?1))`;
  const all = async <T>(sql: string) => (await db.prepare(sql).bind(since).all<T>()).results;

  const convs = await all<ConvRow>(`${WIN} SELECT c.id, c.wa_id AS waId, c.display_name AS name, c.locale, c.mode, c.created_at AS createdAt,
      c.last_user_at AS lastUserAt, (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS lastMsgAt,
      c.source_ad_id AS adId, c.ad_headline AS adHeadline, c.ad_click_id AS adClick, c.consent_at AS consentAt, c.greeted_at AS greetedAt,
      c.age_ok_at AS ageOkAt, ps.opted_out_at AS optedOutAt,
      (SELECT sc.platform FROM social_contacts sc WHERE sc.wa_conversation_id = c.id LIMIT 1) AS social
    FROM conversations c LEFT JOIN person_state ps ON ps.conversation_id = c.id WHERE c.id IN (SELECT id FROM win)
    ORDER BY COALESCE(lastMsgAt, c.last_user_at, c.created_at) DESC, c.id DESC LIMIT ${cap.maxChats + 1}`);
  let truncated = convs.length > cap.maxChats;
  const chosen = convs.slice(0, cap.maxChats);

  // Messages that still have something to show (not wiped; an outgoing reply that was never sent has no text and is left out).
  const msgCap = 60_000;
  const msgs = await all<MsgRow>(`${WIN} SELECT conversation_id AS conv, direction AS dir, kind, body, created_at AS at, dedupe_key AS key, status FROM messages
    WHERE conversation_id IN (SELECT id FROM win) AND wiped_at IS NULL AND NOT (direction = 'OUT' AND body IS NULL) ORDER BY conversation_id, id LIMIT ${msgCap}`);
  if (msgs.length >= msgCap) truncated = true;
  const counts = await all<{ conv: number; n: number; wiped: number }>(`${WIN} SELECT conversation_id AS conv, COUNT(*) AS n, SUM(wiped_at IS NOT NULL) AS wiped
    FROM messages WHERE conversation_id IN (SELECT id FROM win) AND NOT (direction = 'OUT' AND body IS NULL AND wiped_at IS NULL) GROUP BY conversation_id`);
  const stepKeys = await all<{ conv: number; key: string }>(`${WIN} SELECT conversation_id AS conv, dedupe_key AS key FROM messages
    WHERE conversation_id IN (SELECT id FROM win) AND direction = 'OUT' AND status NOT IN ('SKIPPED', 'FAILED')
      AND (${STEP_KEYS.map(([k]) => `dedupe_key LIKE '%${k}'`).join(" OR ")})`);
  const intros = await all<{ conv: number; state: string }>(`${WIN} SELECT conversation_id AS conv, state FROM intros WHERE conversation_id IN (SELECT id FROM win) ORDER BY id`);
  const sessions = await all<{ conv: number; state: string }>(`${WIN} SELECT conversation_id AS conv, state FROM sessions WHERE conversation_id IN (SELECT id FROM win)`);
  const packages = await all<{ conv: number; size: number }>(`${WIN} SELECT conversation_id AS conv, size FROM packages WHERE conversation_id IN (SELECT id FROM win) AND state IN ('PAID', 'CLOSED') ORDER BY id`);
  const pays = await all<{ conv: number; purpose: string; state: string; paise: number; reason: string | null; refundState: string | null }>(`${WIN}
    SELECT COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id) AS conv, p.purpose, p.state, COALESCE(p.paid_paise, p.amount_paise) AS paise,
      r.reason, r.state AS refundState
    FROM payments p
      LEFT JOIN intros i ON p.purpose = 'INTRO' AND i.id = p.target_id
      LEFT JOIN sessions s ON p.purpose = 'SESSION' AND s.id = p.target_id
      LEFT JOIN packages pk ON p.purpose = 'PACKAGE' AND pk.id = p.target_id
      LEFT JOIN refunds r ON r.payment_id = p.id
    WHERE COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id) IN (SELECT id FROM win) ORDER BY p.id`);
  const follows = await all<{ person: string; stage: number; state: string; at: string }>(`${WIN} SELECT person, stage, state, created_at AS at FROM followups
    WHERE channel = 'whatsapp' AND created_at >= ?1 AND person IN (SELECT CAST(id AS TEXT) FROM win) ORDER BY created_at`);
  // Which chats ever had a safety message, went to the team, or are on the block list: three small sets, read once.
  const targets = async (sql: string) => new Set((await db.prepare(sql).all<{ t: string }>()).results.map((r) => r.t));
  const safetySet = await targets(`SELECT target AS t FROM attention WHERE kind IN ('CRISIS', 'EMERGENCY')
    UNION SELECT target FROM audit_log WHERE action IN ('CRISIS', 'EMERGENCY')
    UNION SELECT 'conv:' || conversation_id FROM messages WHERE direction = 'OUT' AND (dedupe_key LIKE '%:crisis' OR dedupe_key LIKE '%:emergency')`);
  const teamSet = await targets(`SELECT target AS t FROM attention WHERE kind = 'HUMAN_REQUEST'
    UNION SELECT target FROM audit_log WHERE action IN ('ADMIN_TAKE_OVER', 'INBOX_TAKE_OVER')`);
  const blockSet = await targets("SELECT wa_id AS t FROM blocks WHERE wa_id IS NOT NULL");

  const group = <T extends { conv: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.conv, [...(m.get(r.conv) ?? []), r]);
    return m;
  };
  const byMsg = group(msgs), byIntro = group(intros), bySession = group(sessions), byPack = group(packages), byPay = group(pays), byStep = group(stepKeys);
  const byCount = new Map(counts.map((r) => [r.conv, r]));
  const byFollow = new Map<number, typeof follows>();
  for (const f of follows) byFollow.set(Number(f.person), [...(byFollow.get(Number(f.person)) ?? []), f]);

  const chats: ExportChat[] = [];
  let messagesOut = 0;
  for (const c of chosen) {
    const names = nameWords(c.name);
    const clean = (s: string | null) => (s === null ? null : redact(s, names));
    const ms = byMsg.get(c.id) ?? [];
    const firstText = ms.find((m) => m.dir === "IN" && m.kind === "text" && m.body)?.body ?? null;
    const tag = firstText ? (TAG.exec(firstText)?.[1] ?? null) : null;
    const kind = c.adId || c.adClick || c.adHeadline ? "ad" : c.social ? c.social : tag ? "tag" : "organic_or_unknown";

    const ins = byIntro.get(c.id) ?? [];
    const ses = bySession.get(c.id) ?? [];
    const pay = byPay.get(c.id) ?? [];
    const paid = pay.filter((p) => PAID.includes(p.state));
    const paidIntro = paid.some((p) => p.purpose === "INTRO");
    const reached = new Set<Step>();
    if (c.lastUserAt || ms.some((m) => m.dir === "IN") || (byCount.get(c.id)?.n ?? 0) > 0) reached.add("first_message");
    if (c.greetedAt) reached.add("greeted");
    if (c.consentAt) reached.add("language_chosen");
    if (c.ageOkAt) reached.add("age_confirmed");
    for (const r of byStep.get(c.id) ?? []) for (const [suffix, step] of STEP_KEYS) if (r.key.endsWith(suffix)) reached.add(step);
    if (ins.length) reached.add("call_held");
    if (pay.some((p) => p.purpose === "INTRO")) reached.add("pay_link_sent");
    if (paidIntro) reached.add("call_paid");
    const furthest = STEPS.reduce<Step>((best, s, i) => (reached.has(s) && i > STEPS.indexOf(best) ? s : best), "first_message");

    const blocked = c.mode === "BLOCKED" || blockSet.has(c.waId);
    const safety = safetySet.has(`conv:${c.id}`);
    const chat: ExportChat = {
      code: chatCode(c.id),
      last4: c.waId.slice(-4),
      first_seen: istIso(c.createdAt),
      last_message_at: c.lastMsgAt || c.lastUserAt ? istIso((c.lastMsgAt ?? "") > (c.lastUserAt ?? "") ? c.lastMsgAt! : c.lastUserAt!) : null,
      source: { kind, ad_id: c.adId, ad_headline: clean(c.adHeadline), tag },
      language: c.consentAt ? c.locale : "not_chosen",
      mode: c.mode,
      blocked,
      stopped: c.optedOutAt !== null,
      handed_to_team: c.mode === "HUMAN" || teamSet.has(`conv:${c.id}`),
      safety,
      furthest_step: furthest,
      outcome: {
        paid_intro: paidIntro,
        intro_status: ins.at(-1)?.state ?? null,
        intro_calls: ins.length,
        calls_missed: ins.filter((i) => i.state === "MISSED" || i.state === "RESCHEDULED").length,
        calls_cancelled_by_us: ins.filter((i) => i.state === "CANCELLED_BY_US").length,
        sessions_booked: ses.filter((s) => BOOKED_SESSION.includes(s.state)).length,
        sessions_completed: ses.filter((s) => s.state === "COMPLETED").length,
        sessions_cancelled: ses.filter((s) => s.state === "CANCELLED").length,
        sessions_no_show: ses.filter((s) => s.state === "NO_SHOW").length,
        packages_bought: (byPack.get(c.id) ?? []).map((p) => p.size),
        paid_rupees: paid.reduce((sum, p) => sum + p.paise, 0) / 100,
        refunds: pay.filter((p) => p.refundState).map((p) => ({ for: p.purpose, reason: p.reason ?? "", state: p.refundState! })),
      },
      followups: (byFollow.get(c.id) ?? []).map((f) => ({ stage: f.stage, at: istIso(f.at), state: f.state })),
      message_count: byCount.get(c.id)?.n ?? 0,
      text_wiped_count: byCount.get(c.id)?.wiped ?? 0,
      messages: [],
    };
    if (safety) chat.note = "text withheld (safety)";
    else if (blocked) chat.note = "text withheld (blocked)";
    else if (messagesOut + ms.length > cap.maxMessages) {
      chat.note = "text left out (file limit reached)";
      truncated = true;
    } else {
      chat.messages = ms.map((m) => messageOf(m, names));
      messagesOut += chat.messages.length;
    }
    chats.push(chat);
  }

  return {
    file: {
      generated_at: istIso(iso(nowMs)),
      days,
      timezone: "Asia/Kolkata",
      window: { from: istIso(since), to: istIso(iso(nowMs)) },
      text_kept_for: keptWords(retentionMinutes(env)),
      notes: NOTES,
      truncated,
      limits: { chats: cap.maxChats, messages: cap.maxMessages },
      summary: summaryOf(chats, since, chosen, messagesOut),
      social: await socialSummary(env, since),
      chats,
    },
    chats: chats.length,
    messages: messagesOut,
    truncated,
  };
}

const keptWords = (min: number) => (min >= 1440 && min % 1440 === 0 ? `${min / 1440} days` : `${min} minutes`);

function messageOf(m: MsgRow, names: readonly string[]): ExportMessage {
  const from: ExportMessage["from"] = m.dir === "IN" ? "customer" : m.key?.startsWith("admin-reply:") || m.key?.startsWith("app-reply:") ? "team" : "bot";
  let kind: string;
  let text: string;
  if (m.dir === "IN") {
    if (m.kind === "text") (kind = "text"), (text = m.body ?? "");
    else if (m.kind === "interactive" || m.kind === "button") (kind = "button"), (text = m.body ? `tapped: ${m.body}` : "tapped a button");
    else (kind = "media"), (text = MEDIA[m.kind] ?? (m.body ? m.body : `[${m.kind}]`));
  } else if (m.kind === "template" || m.body?.startsWith("template:")) {
    kind = "template";
    text = `template: ${(m.body ?? "").replace(/^template:/, "")}`;
  } else {
    kind = OUT_KIND[m.kind] ?? m.kind;
    text = m.body ?? "";
  }
  const out: ExportMessage = { at: istIso(m.at), from, kind, text: redact(text, names) };
  if (m.dir === "OUT" && m.status === "FAILED") out.status = "not delivered";
  if (m.dir === "OUT" && m.status === "SKIPPED") out.status = "not sent";
  return out;
}

function summaryOf(chats: ExportChat[], since: string, rows: ConvRow[], messages: number) {
  const started = rows.filter((r) => r.createdAt >= since).length;
  const bySource: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byTag: Record<string, { chats: number; paid_intro: number }> = {};
  const ads = new Map<string, { ad_id: string | null; ad_headline: string | null; chats: number; paid_intro: number }>();
  const intro: Record<string, number> = {};
  const refunds: Record<string, number> = {};
  const follow: Record<string, number> = {};
  const reached = Object.fromEntries(STEPS.map((s) => [s, 0])) as Record<Step, number>;
  let packsTotal = 0;
  const packs: Record<string, number> = {};
  for (const c of chats) {
    count(bySource, c.source.kind);
    count(byLanguage, c.language);
    if (c.source.tag) {
      const t = (byTag[c.source.tag] ??= { chats: 0, paid_intro: 0 });
      t.chats++;
      if (c.outcome.paid_intro) t.paid_intro++;
    }
    if (c.source.kind === "ad") {
      const k = `${c.source.ad_id ?? ""}|${c.source.ad_headline ?? ""}`;
      const a = ads.get(k) ?? { ad_id: c.source.ad_id, ad_headline: c.source.ad_headline, chats: 0, paid_intro: 0 };
      a.chats++;
      if (c.outcome.paid_intro) a.paid_intro++;
      ads.set(k, a);
    }
    const idx = STEPS.indexOf(c.furthest_step);
    STEPS.forEach((s, i) => {
      if (i <= idx) reached[s]++;
    });
    if (c.outcome.intro_status) count(intro, c.outcome.intro_status);
    for (const r of c.outcome.refunds) count(refunds, `${r.for} ${r.reason} ${r.state}`.replace(/\s+/g, " ").trim());
    for (const f of c.followups) if (["SENT", "SENDING", "UNKNOWN"].includes(f.state)) count(follow, `stage_${f.stage}`);
    for (const size of c.outcome.packages_bought) count(packs, String(size));
    packsTotal += c.outcome.packages_bought.length;
  }
  const n = (f: (c: ExportChat) => boolean) => chats.filter(f).length;
  return {
    chats_in_file: chats.length,
    chats_started: started,
    messages_in_file: messages,
    messages_text_wiped: chats.reduce((s, c) => s + c.text_wiped_count, 0),
    by_source: bySource,
    by_ad: [...ads.values()].sort((a, b) => b.chats - a.chats),
    by_tag: byTag,
    by_language: byLanguage,
    reached_step: reached,
    paid_intro_calls: n((c) => c.outcome.paid_intro),
    intro_status: intro,
    sessions_booked: chats.reduce((s, c) => s + c.outcome.sessions_booked, 0),
    sessions_completed: chats.reduce((s, c) => s + c.outcome.sessions_completed, 0),
    packages_bought: packsTotal,
    packages_by_size: packs,
    paid_rupees: chats.reduce((s, c) => s + c.outcome.paid_rupees, 0),
    refunds,
    handed_to_team: n((c) => c.handed_to_team),
    blocked: n((c) => c.blocked),
    stopped: n((c) => c.stopped),
    safety_flagged: n((c) => c.safety),
    followups_sent: follow,
  };
}

// Instagram and Messenger keep no message text (src/social.ts): counts only, for people who wrote or were first seen in the window.
async function socialSummary(env: Env, since: string) {
  const rows = (
    await env.DB.prepare(
      `SELECT platform, COUNT(*) AS people, SUM(wa_conversation_id IS NOT NULL) AS opened_whatsapp, SUM(followed_at IS NOT NULL) AS followed,
         SUM(said_booked_at IS NOT NULL OR EXISTS (SELECT 1 FROM payments p
           LEFT JOIN intros i ON p.purpose = 'INTRO' AND i.id = p.target_id LEFT JOIN sessions s ON p.purpose = 'SESSION' AND s.id = p.target_id
           LEFT JOIN packages pk ON p.purpose = 'PACKAGE' AND pk.id = p.target_id
           WHERE COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id) = sc.wa_conversation_id AND p.state IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'))) AS booked,
         SUM(stopped_at IS NOT NULL) AS stopped, SUM(blocked_at IS NOT NULL) AS blocked
       FROM social_contacts sc WHERE sc.created_at >= ?1 OR sc.last_in_at >= ?1 GROUP BY platform ORDER BY platform`,
    )
      .bind(since)
      .all<Record<string, number | string>>()
  ).results;
  const follow = (
    await env.DB.prepare(
      "SELECT channel, stage, COUNT(*) AS n FROM followups WHERE channel IN ('instagram', 'messenger') AND created_at >= ?1 AND state IN ('SENT', 'SENDING', 'UNKNOWN') GROUP BY channel, stage",
    )
      .bind(since)
      .all<{ channel: string; stage: number; n: number }>()
  ).results;
  const out: Record<string, Record<string, number | Record<string, number>>> = {};
  for (const p of ["instagram", "messenger"]) {
    const r = rows.find((x) => x.platform === p);
    out[p] = {
      people: Number(r?.people ?? 0), opened_whatsapp: Number(r?.opened_whatsapp ?? 0), followed: Number(r?.followed ?? 0), booked: Number(r?.booked ?? 0),
      stopped: Number(r?.stopped ?? 0), blocked: Number(r?.blocked ?? 0),
      followups_sent: Object.fromEntries(follow.filter((f) => f.channel === p).map((f) => [`stage_${f.stage}`, f.n])),
    };
  }
  return { note: "Instagram and Messenger keep no message text: counts only.", ...out };
}
