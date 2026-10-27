// A typed question goes to the assistant (src/ai.ts) and comes back as ONE WhatsApp message (docs/AGENT.md section 6). Order: the label is applied first
// (strikes, quiet, blocks, the fixed crisis and emergency messages), then the reply is checked (src/aicheck.ts), then it is sent according to `next`.
// The assistant only chooses words and one action from a fixed list; code does everything else. No message text is logged or stored here.
import { checkReply, type RejectReason } from "./aicheck";
import { callAI, factNumbers, gatherFacts, type AiOutput, type ChatMessage, type Facts, type NextAction } from "./ai";
import { copyFor, type Copy } from "./copy";
import type { Env } from "./env";
import { requestHuman } from "./handoff";
import { menuOut } from "./menu";
import { applyLabel, recordAiReply, type Label, type NoiseConv } from "./noise";
import { botAudit } from "./safety";
import { raiseAttention, type Out, type SendResult } from "./send";
import { aiOn } from "./switches";
import { openStep, resetReprompts } from "./steps";

// What the caller does next:
//  off       the assistant is not used (flag off, language not chosen yet): carry on with the old path
//  reprompt  the assistant could not answer and a booking step is open: send the plain re-prompt
//  finished  everything that should be sent has been sent (or nothing should be)
//  text      a plain text answer went out with no buttons: a first-message answer is followed by the menu
export type Answered = "off" | "reprompt" | "finished" | "text";

export type AnswerCtx = {
  env: Env;
  conv: NoiseConv & { mode: string };
  text: string; // what the person wrote; only compared with the config word lists
  msgId: string; // base of the dedupe keys
  messages: ChatMessage[]; // the redacted chat so far, oldest first
  send: (out: Out, step: string) => Promise<SendResult | "BURST">;
  newerExists?: () => Promise<boolean>; // a newer message is waiting: its handler answers, so no call is made
};

// The fixed fallback for the label of a rejected reply (docs/KNOWLEDGE.md section 11).
export function fallbackFor(cp: Copy, label: Label): string {
  switch (label) {
    case "relevant_question": case "objection": case "booking_intent": return cp.fallbackQuestion;
    case "personal_concern": return cp.fallbackConcern;
    case "existing_booking": return cp.fallbackBooking;
    case "off_topic": case "astrology_or_prediction": case "prohibited_request": case "loop": case "smalltalk": return cp.fallbackOffTopic;
    default: return cp.aiFallback;
  }
}

// A booking step's own message with the assistant's reply on top, so the person gets one message. Null when it would not fit in one.
function stepWithReply(step: Out, reply: string): Out | null {
  if (step.type === "template") return null;
  const body = step.type === "text" ? step.text : step.body;
  const joined = `${reply}\n\n${body}`;
  if (joined.length > 1000) return null;
  return step.type === "text" ? { ...step, text: joined } : { ...step, body: joined };
}

export async function answerWithAI(ctx: AnswerCtx): Promise<Answered> {
  const { env, conv } = ctx;
  const db = env.DB;
  if (!conv.consent_at || !(await aiOn(env))) return "off"; // before the language tap the person has not seen the assistant's disclosure
  if (ctx.newerExists && (await ctx.newerExists())) return "finished";
  const cp = copyFor(conv.locale);
  const open = await openStep(db, conv.id);

  const facts: Facts = await gatherFacts(db, conv.id, conv.locale, Date.now(), open?.step ?? null);
  await recordAiReply(db, conv.id); // every call counts against the budgets, whatever comes back
  let result: Awaited<ReturnType<typeof callAI>>;
  try {
    result = await callAI(env.ANTHROPIC_API_KEY, ctx.messages, facts);
  } catch {
    result = { ok: false, code: "ERROR" };
  }

  // No usable answer: the fixed fallback and the menu (or, in the middle of a booking, the plain re-prompt). Never tried again.
  const cannot = async (code: string): Promise<Answered> => {
    await botAudit(db, "AI_FAILED", `conv:${conv.id}`, code);
    if (open) return "reprompt";
    await ctx.send(menuOut(cp, facts.noSell, facts.noSell ? cp.aiFallbackNoSell : cp.aiFallback, true), "ai");
    return "finished";
  };
  if (!result.ok) return cannot(result.code);

  const out: AiOutput = result.out;
  const label: Label = out.label;
  await botAudit(db, "AI_REPLY", `conv:${conv.id}`, label);

  // 1. What the label means. A strike, a block, a quiet week, the fixed crisis or emergency message: nothing more is said.
  const applied = await applyLabel(env, conv, label, ctx.text, { msgId: ctx.msgId, say: (o, step) => ctx.send(o, step) });
  if (applied.stop) return "finished";

  // 2. The reply. An empty one is right for spam and abuse (a paying customer is never filtered, so Rohit is told instead); anything else is a failure.
  const reply = out.reply.trim();
  let text = reply;
  let next: NextAction | "show_menu_person" = label === "human_request" ? "handoff" : out.next;
  let reason: RejectReason | "EMPTY" | null = null;
  if (!reply) {
    if (label === "spam_or_promo" || label === "abuse" || label === "flirt_or_sexual") {
      await raiseAttention(db, "FREE_TEXT", `conv:${conv.id}`);
      return "finished";
    }
    reason = "EMPTY";
  } else {
    const checked = checkReply(reply, factNumbers(facts));
    if (!checked.ok) reason = checked.reason;
  }
  if (reason) {
    await botAudit(db, "AI_REJECTED", `conv:${conv.id}`, reason);
    if (open && next !== "handoff") return "reprompt";
    text = fallbackFor(cp, label);
    if (label === "existing_booking") await raiseAttention(db, "FREE_TEXT", `conv:${conv.id}`); // "Our team will check this": so somebody must
    next = next === "handoff" ? "handoff" : "show_menu_person";
  }

  // 3. One message.
  if (next === "handoff") {
    const sent = await ctx.send({ type: "text", text }, "ai");
    if (sent !== "BURST") await requestHuman(env, conv.id);
    return "finished";
  }
  if (open) {
    const merged = stepWithReply(open.out, text);
    if (!merged) return "reprompt";
    // A question that got its answer is not a sign of being stuck: the "Talk to a person" offer counts only the turns
    // that could not be answered (the re-prompts in src/whatsapp.ts), so a good answer starts that count again.
    const sent = await ctx.send(merged, "ai");
    if (sent !== "BURST") await resetReprompts(db, conv.id);
    return "finished";
  }
  switch (next) {
    case "show_booking":
      if (facts.noSell) {
        await ctx.send({ type: "text", text }, "ai");
        return "text";
      }
      await ctx.send({ type: "buttons", body: text, buttons: [{ id: "menu_book", title: cp.btnSeeTimes }] }, "ai");
      return "finished";
    case "show_menu":
      await ctx.send(menuOut(cp, facts.noSell, text), "ai");
      return "finished";
    case "show_menu_person":
      await ctx.send(menuOut(cp, facts.noSell, text, true), "ai");
      return "finished";
    default:
      await ctx.send({ type: "text", text }, "ai");
      return "text";
  }
}

