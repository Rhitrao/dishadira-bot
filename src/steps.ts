// The open booking step. Every step message (language, age, service, who for, day, time, pay, and later the soft gate and My bookings) is sent
// through sendStep(), which keeps the message on the conversation (pending_step + pending_out). If the person then types instead of tapping,
// the step is sent again with the re-prompt line (docs/AGENT.md section 3.1c). Nothing here stores anything the person wrote.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import type { Copy } from "./copy";
import type { Env } from "./env";
import { sendMessage, type Out, type SendResult } from "./send";
import { iso } from "./slots";

export type StepName = "language" | "age" | "service" | "who" | "day" | "time" | "pay" | "gate" | "bookings";

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
export function repromptOut(cp: Copy, open: OpenStep): Out {
  const line = cp.reprompt(open.step === "day" || open.step === "time" ? cp.hintDays : "");
  const out = open.out;
  if (out.type === "template") return out;
  if (out.type === "text") return { ...out, text: `${line}\n\n${out.text}` };
  return { ...out, body: `${line}\n\n${out.body}` };
}

// From the third re-prompt in a row: a second message with the Talk to a person button (the step's own message is already full of buttons or rows).
export const repromptHelpOut = (cp: Copy): Out => ({ type: "buttons", body: cp.repromptHelp, buttons: [{ id: "menu_person", title: cp.btnPerson }] });

export const noteReprompt = (db: D1Database, convId: number) => db.prepare("UPDATE conversations SET pending_reprompts = pending_reprompts + 1 WHERE id = ?1 RETURNING pending_reprompts AS n").bind(convId).first<{ n: number }>();
