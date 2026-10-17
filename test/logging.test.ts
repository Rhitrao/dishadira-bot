/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import app from "../src/index";
import { sendEmail } from "../src/mail";
import { newDb } from "./db";

// Logs carry route, status, event type and error codes only: no phone number, wa_id, name, message text, e-mail or payment id.
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const SECRET = "test-app-secret";
const PHONE = "919876543210"; // synthetic
const NAME = "Zed Quillfeather"; // synthetic
const TEXT = "my secret sentence about healing";
const MAIL = "someone@example.invalid";
const PAYMENT_ID = "pay_FAKE1234567890";
const BSUID = "IN.FAKEBSUID0123456789";

let db: D1Database;
let close: () => Promise<void>;
let lines: string[];

const capture = () => {
  lines = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")));
  }
};

async function post(body: unknown, e: object) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const sig = "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return app.request("/wa/webhook", { method: "POST", body: raw, headers: { "X-Hub-Signature-256": sig } }, e as never);
}

beforeEach(async () => {
  ({ db, close } = await newDb());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OUT1" }] }), { status: 200 })));
  capture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await close();
});

const noPii = () => {
  expect(lines.length).toBeGreaterThan(0); // the scenario really logged something
  for (const line of lines) {
    expect(line, line).not.toMatch(/\d{10,}/);
    for (const secret of [PHONE, NAME, TEXT, MAIL, PAYMENT_ID, BSUID]) expect(line).not.toContain(secret);
  }
};

describe("logging", () => {
  it("webhook paths that skip or ignore log reason codes only", async () => {
    const env = { DB: db, SENDS: "true", WA_APP_SECRET: SECRET, WA_TOKEN: "t", WA_PHONE_ID: "1000" };
    const now = String(Math.floor(Date.now() / 1000));
    await post("not an object", env);
    await post({ entry: [{ changes: [{ field: "calls", value: { calls: [{ from: PHONE }] } }] }] }, env);
    await post(
      { entry: [{ changes: [{ field: "messages", value: {
        contacts: [{ wa_id: PHONE, profile: { name: NAME }, user_id: BSUID }],
        messages: [
          { id: "wamid.L1", from_user_id: BSUID, timestamp: now, type: "text", text: { body: TEXT } }, // no phone
          { id: "wamid.L2", from: PHONE, timestamp: now, type: "text", text: { body: 42 } }, // schema
          { id: "wamid.L3", from: PHONE, timestamp: now, type: "system", system: { body: NAME } },
        ],
      } }] }] },
      env,
    );
    noPii();
  });

  it("an unhandled error logs the route, not the error text", async () => {
    // No DB binding: the handler throws with a message that mentions the data.
    const env = { SENDS: "true", WA_APP_SECRET: SECRET, DB: { prepare: () => { throw new Error(`boom ${PHONE} ${NAME} ${TEXT}`); } } };
    const res = await post({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.L9", from: PHONE, timestamp: "1", type: "text", text: { body: TEXT } }] } }] }] }, env);
    expect(res.status).toBe(500);
    noPii();
  });

  it("email failures log the error code, not the address", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error(`cannot deliver to ${MAIL}`), { code: "E_DELIVERY" });
    });
    expect(await sendEmail({ EMAIL: { send }, DIGEST_TO: MAIL } as never, "subject", `payment ${PAYMENT_ID}`)).toBe("FAILED");
    expect(await sendEmail({} as never, "subject", "body")).toBe("SKIPPED");
    noPii();
  });

  it("the detector itself catches a phone number", () => {
    expect("sent to 919876543210").toMatch(/\d{10,}/);
  });

  it("every console call in src is one of the audited ones", () => {
    const calls = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => `${file.replace("../", "")}: ${m[0]}`),
    );
    expect(calls.sort()).toEqual(
      [
        'src/index.ts: console.error("unhandled error", c.req.method, c.req.routePath);',
        'src/mail.ts: console.log("email failed", (e as { code?: string }).code ?? "error");',
        'src/mail.ts: console.log("email skipped: not configured");',
        'src/whatsapp.ts: console.log("wa webhook ignored: no entry");',
        'src/whatsapp.ts: console.log("wa webhook ignored: not json");',
        'src/whatsapp.ts: console.log("wa webhook skipped", reason);',
      ].sort(),
    );
  });
});
