// The eval cases (docs/KNOWLEDGE.md section 7) and the helpers both runners use: the CI run with a fake assistant (test/agent-evals.test.ts) and the manual
// run against the real model (test/agent-evals/live.eval.ts). The cases are synthetic: nothing in them is a real person's message.
import cases from "./cases.json";
import type { Facts } from "../../src/ai";
import { todayInIndia } from "../../src/ai";
import type { Lang } from "../../src/copy";

export type FakeOutput = { label: string; language: string; script: string; reply: string; next: string };
export type CaseFacts = { hadIntroCall: boolean; creditsLeft: number; next: Facts["next"] };
export type EvalCase = {
  id: number;
  name: string;
  kind: "ai" | "code";
  input: string | null;
  lang: Lang;
  // ai cases
  labels?: string[]; // labels that count as right
  next?: string[]; // `next` values that count as right
  mustNotContain?: string[];
  mustContainAny?: string[];
  replyScript?: "latin" | "devanagari";
  safety?: boolean; // a safety case: the live run must get every one of these right
  facts?: CaseFacts; // the trusted facts for this case (none given: no booking, no package)
  history?: { role: "user" | "assistant"; content: string }[]; // earlier turns, oldest first
  step?: string; // a booking step that is open when the message arrives
  fake?: FakeOutput; // what the fake assistant answers in CI
  codeFirst?: string; // in a real chat the gate decides this first, so CI checks the gate instead; the live run still asks the model
  // code cases (decided by code, never by the assistant)
  gate?: string;
  alsoInput?: string[];
  setup?: string;
  media?: string;
};

export const ALL_CASES = cases as EvalCase[];
export const AI_CASES = ALL_CASES.filter((c) => c.kind === "ai");
export const CODE_CASES = ALL_CASES.filter((c) => c.kind === "code");

export function factsFor(c: EvalCase, now = Date.now()): Facts {
  const f = c.facts;
  return { today: todayInIndia(now), language: c.lang, noSell: false, hadIntroCall: f?.hadIntroCall ?? false, creditsLeft: f?.creditsLeft ?? 0, next: f?.next ?? null, openStep: c.step ?? null };
}

// Case-insensitive; the reply must not contain any of these, and (if given) must contain at least one of the others.
export const forbidden = (c: EvalCase, reply: string): string[] => (c.mustNotContain ?? []).filter((s) => reply.toLowerCase().includes(s.toLowerCase()));
export const missingRequired = (c: EvalCase, reply: string): boolean => !!c.mustContainAny?.length && !c.mustContainAny.some((s) => reply.toLowerCase().includes(s.toLowerCase()));
