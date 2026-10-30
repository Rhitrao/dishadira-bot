// The open booking step. Every step message (language, age, service, who for, day, time, pay, and later the soft gate and My bookings) is sent
// through sendStep(), which keeps the message on the conversation (pending_step + pending_out). If the person then types instead of tapping,
// the step is sent again with the re-prompt line (docs/AGENT.md section 3.1c). Nothing here stores anything the person wrote.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Copy } from "./copy";
import type { Env } from "./env";
import { hasPhrase, normalize } from "./safety";
import { sendMessage, type Out, type SendResult } from "./send";
import { iso } from "./slots";

export type StepName = "language" | "age" | "service" | "who" | "day" | "time" | "pay" | "gate" | "bookings" | "packages";

// Sends a step message and, if it went out, makes it the open step. `resend` is what to send again if it differs from the message itself
// (the language step resends the short language question, not the whole greeting). `until` is when the step stops being open (a payment step: the hold).
export async function sendStep(env: Env, convId: number, step: StepName, out: Out, key: string, opts: { until?: string; resend?: Out } = {}): Promise<SendResult> {
  const res = await sendMessage(env, convId, out, key);
  if (res === "SENT" || res === "UNKNOWN") {
    const until = opts.until ?? iso(Date.now() + config.booking.stepOpenHours * 3_600_000);
    await env.DB
      .prepare("UPDATE conversations SET pending_step = ?2, pending_out = ?3, pending_until = ?4, pending_reprompts = 0 WHERE id = ?1")
      .bind(convId, step, JSON.stringify(opts.resend ?? out), until)
      .run();
  }
  return res;
}

export const clearStep = (db: D1Database, convId: number) =>
  db.prepare("UPDATE conversations SET pending_step = NULL, pending_out = NULL, pending_until = NULL, pending_reprompts = 0 WHERE id = ?1 AND pending_step IS NOT NULL").bind(convId).run();

export type OpenStep = { step: StepName; out: Out; reprompts: number };

export async function openStep(db: D1Database, convId: number, nowMs = Date.now()): Promise<OpenStep | null> {
  const row = await db
    .prepare("SELECT pending_step AS step, pending_out AS out, pending_until AS until, pending_reprompts AS reprompts FROM conversations WHERE id = ?1")
    .bind(convId)
    .first<{ step: string | null; out: string | null; until: string | null; reprompts: number }>();
  if (!row?.step || !row.out || !row.until || Date.parse(row.until) <= nowMs) return null;
  try {
    return { step: row.step as StepName, out: JSON.parse(row.out) as Out, reprompts: row.reprompts };
  } catch {
    return null;
  }
}

// The step again: the re-prompt line (with the hours hint on the day and time steps) above the step's own question.
// `afterQuestion`: the person asked something the assistant could not answer, so the line thanks them and points to the call
// instead of a bare "Please choose from the options below."
export function repromptOut(cp: Copy, open: OpenStep, afterQuestion = false): Out {
  const line = afterQuestion ? cp.repromptQuestion : cp.reprompt(open.step === "day" || open.step === "time" ? cp.hintDays : "");
  const out = open.out;
  if (out.type === "template") return out;
  if (out.type === "text") return { ...out, text: `${line}\n\n${out.text}` };
  return { ...out, body: `${line}\n\n${out.body}` };
}

// From the third re-prompt in a row: a second message with the Talk to a person button (the step's own message is already full of buttons or rows).
export const repromptHelpOut = (cp: Copy): Out => ({ type: "buttons", body: cp.repromptHelp, buttons: [{ id: "menu_person", title: cp.btnPerson }] });

export const noteReprompt = (db: D1Database, convId: number) => db.prepare("UPDATE conversations SET pending_reprompts = pending_reprompts + 1 WHERE id = ?1 RETURNING pending_reprompts AS n").bind(convId).first<{ n: number }>();
export const resetReprompts = (db: D1Database, convId: number) => db.prepare("UPDATE conversations SET pending_reprompts = 0 WHERE id = ?1 AND pending_reprompts > 0").bind(convId).run();

// ---- typed answers to an open step (ticket 31, I8) ----
// "yes", "haan", "ok", "1", the button's own words, "English" / "hindi", "tomorrow", "4 pm" / "4 baje": understood as the tap they mean,
// when exactly one option fits. Only buttons and list rows (the pay step's link button has nothing to choose). The word lists are
// config.router.stepWords; a message longer than stepWords.maxWords is never read as a tap (it is a question).
const W = config.router.stepWords;
const IST_MS = 330 * 60_000;
const ID_GROUPS: [RegExp, readonly string[]][] = [
  [/^age_yes/, W.yes], [/^age_no/, W.no], [/^lang_en$/, W.en], [/^lang_hi$/, W.hi],
  [/_SELF$/, W.self], [/_FAMILY$/, W.family], [/_PET$/, W.pet], [/_HEALING$/, W.healing], [/_PROTECTION$/, W.cleansing],
];

function dayWords(ymd: string, nowMs: number): string[] {
  const [y, m, d] = ymd.split("-").map(Number);
  const out: string[] = [...W.weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]];
  const today = new Date(nowMs + IST_MS).toISOString().slice(0, 10);
  const tomorrow = new Date(nowMs + IST_MS + 86_400_000).toISOString().slice(0, 10);
  if (ymd === today) out.push(...W.today);
  if (ymd === tomorrow) out.push(...W.tomorrow);
  return out;
}

// Clock times a short message names: "4", "4 pm", "4:30", "4.30 baje", "शाम 4". A bare hour may be morning or afternoon.
function timesIn(text: string): { h: number[]; m: number }[] {
  const out: { h: number[]; m: number }[] = [];
  for (const x of text.toLowerCase().matchAll(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|a\.m\.|pm|p\.m\.)?/g)) {
    const h = Number(x[1]);
    const m = Number(x[2] ?? 0);
    if (h < 1 || h > 23 || m > 59) continue;
    const pm = x[3]?.startsWith("p");
    const am = x[3]?.startsWith("a");
    out.push({ h: h > 12 ? [h] : pm ? [(h % 12) + 12] : am ? [h % 12] : [h % 12, (h % 12) + 12], m });
  }
  return out;
}

export function typedChoice(open: OpenStep, text: string, nowMs = Date.now()): string | null {
  const out = open.out;
  const opts = out.type === "buttons" ? out.buttons : out.type === "list" ? (out.sections?.flatMap((s) => s.rows) ?? out.rows ?? []) : [];
  const t = normalize(text);
  if (!opts.length || !t || t.split(" ").length > W.maxWords) return null;
  const one = (ids: string[]) => (ids.length === 1 ? ids[0] : null);
  // 1. The option's own words ("Healing", "Family member", "Another day").
  const own = one(opts.filter((o) => normalize(o.title) === t).map((o) => o.id));
  if (own) return own;
  // 2. A time on the time step ("4 pm", "4 baje"): the row with that clock time.
  const times = timesIn(text);
  const timeRows = opts.map((o) => ({ id: o.id, utc: /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(o.id)?.[1] })).filter((o) => o.utc);
  if (timeRows.length && times.length === 1) {
    const hit = one(
      timeRows
        .filter((o) => {
          const d = new Date(Date.parse(o.utc!) + IST_MS);
          return times[0].h.includes(d.getUTCHours()) && times[0].m === d.getUTCMinutes();
        })
        .map((o) => o.id),
    );
    if (hit) return hit;
  }
  // 3. A number: the n-th option ("1" for the first button).
  if (/^\d{1,2}$/.test(t)) return opts[Number(t) - 1]?.id ?? null;
  // 4. Words that mean an option: yes / no, the language, who it is for, the service, a day.
  const means = opts.filter((o) => {
    const group = ID_GROUPS.find(([re]) => re.test(o.id))?.[1];
    if (group && hasPhrase(text, group)) return true;
    const ymd = /_(\d{4}-\d{2}-\d{2})$/.exec(o.id)?.[1];
    return ymd !== undefined && hasPhrase(text, dayWords(ymd, nowMs));
  });
  return one(means.map((o) => o.id));
}

// The open step again with a line above it (an answer from src/router.ts), or null when it would not fit WhatsApp's 1024 characters.
export function stepWithLine(open: OpenStep, line: string): Out | null {
  const out = open.out;
  if (out.type === "template" || out.type === "text") return null;
  const body = `${line}\n\n${out.body}`;
  return body.length <= config.whatsapp.buttonBodyMax ? { ...out, body } : null;
}
