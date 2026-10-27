// A small harness for the /app console tests (Payments and Settings): a local D1, signed Access tokens for synthetic members, and
// GET/POST helpers that send what a browser would. Access, email and Razorpay are fakes: nothing real is called. All data is synthetic.
import { vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { memberCsrf, type Member } from "../src/auth";
import { newDb } from "./db";
import { FakeRazorpay, rzpEnv } from "./razorpay";

export const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
export const OWNER = "owner@example.test";
export const PRAC = "practitioner@example.test";
export const STAFF = "staff@example.test";
export const ALERTS = "alerts@example.test"; // DIGEST_TO: the owner's alert address

export class ConsoleHarness {
  db!: D1Database;
  close: () => Promise<void> = async () => {};
  emails: { to: string; subject: string; text: string }[] = [];
  fake = new FakeRazorpay();
  vars: Record<string, unknown> = {};
  private priv!: CryptoKey;
  private jwks!: { keys: unknown[] };
  private tokens = new Map<string, string>();

  env = (o: Record<string, unknown> = {}) =>
    ({
      DB: this.db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: "true", DIGEST_TO: ALERTS,
      NEW_BOOKINGS: "true", SENDS: "true", AI_REPLIES: "true", CHAT_RETENTION_MINUTES: "10080", PUBLIC_URL: ORIGIN,
      EMAIL: { send: async (m: { to: string; subject: string; text: string }) => void this.emails.push(m) },
      ...rzpEnv(), ...this.vars, ...o,
    }) as never;

  start = async (nowMs: number) => {
    // One key pair per test file: the Worker caches the Access keys it has fetched.
    if (!this.priv) {
      const kp = await generateKeyPair("RS256");
      this.priv = kp.privateKey;
      this.jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
    }
    this.tokens = new Map();
    this.emails = [];
    this.vars = {};
    this.fake = new FakeRazorpay();
    ({ db: this.db, close: this.close } = await newDb());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify(this.jwks));
        if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }));
        return this.fake.handle(u, init) ?? new Response("{}", { status: 404 });
      }),
    );
    // The first request seeds the owner and the practitioner; then an active staff member.
    await this.get("/app");
    await this.db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, ?1, 'STAFF', 'active')").bind(STAFF).run();
  };
  stop = async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await this.close();
  };

  jwtFor = async (email: string) => {
    if (!this.tokens.has(email))
      this.tokens.set(email, await new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(AUD).setIssuedAt().setExpirationTime("30d").sign(this.priv));
    return this.tokens.get(email)!;
  };
  get = async (path: string, as = OWNER) => app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await this.jwtFor(as) } }, this.env());
  post = async (path: string, form: Record<string, string | string[]>, as = OWNER, o: { origin?: string | null } = {}) => {
    const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await this.jwtFor(as), "Content-Type": "application/x-www-form-urlencoded" };
    if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return app.request(ORIGIN + path, { method: "POST", headers, body: body.toString() }, this.env());
  };
  member = (email: string) =>
    this.db.prepare("SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status FROM members WHERE email = ?1").bind(email).first<Member>();
  // A form token exactly as the page draws it for this member: what a hand-made POST would send.
  tokenFor = async (email: string, scope: string) => memberCsrf(await this.jwtFor(email), (await this.member(email))!, scope);
  count = async (sql: string, ...binds: unknown[]) => (await this.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
  audits = async (action: string) =>
    (await this.db.prepare("SELECT actor, member_id AS memberId, target, detail FROM audit_log WHERE action = ?1 ORDER BY id").bind(action).all<{ actor: string; memberId: number | null; target: string; detail: string }>()).results;
  setting = async (key: string) => (await this.db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>())?.value ?? null;
}

// A customer with a payment, for the Payments tests. Returns the ids.
export async function paidCustomer(db: D1Database, o: { waId: string; name: string; purpose?: "INTRO" | "SESSION" | "PACKAGE"; paise?: number; state?: string; at?: string; paid?: number | null; size?: number; ppid?: string | null }) {
  const conv = (await db.prepare("INSERT INTO conversations (wa_id, display_name) VALUES (?1, ?2)").bind(o.waId, o.name).run()).meta.last_row_id;
  const purpose = o.purpose ?? "INTRO";
  let target: number;
  if (purpose === "PACKAGE") {
    target = (await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, ?2, ?3, 'PAID')").bind(conv, o.size ?? 10, o.paise ?? 500000).run()).meta.last_row_id;
  } else if (purpose === "SESSION") {
    target = (await db.prepare("INSERT INTO sessions (conversation_id, service, state, origin) VALUES (?1, 'HEALING', 'CONFIRMED', 'SELF')").bind(conv).run()).meta.last_row_id;
  } else {
    target = (await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1, 'HEALING', 'PAID')").bind(conv).run()).meta.last_row_id;
  }
  const pay = (
    await db
      .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, provider_payment_id, amount_paise, paid_paise, state, created_at) VALUES ('razorpay', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(purpose, target, `di-test-${conv}`, o.ppid === undefined ? `pay_TEST${conv}` : o.ppid, o.paise ?? 9900, o.paid ?? null, o.state ?? "PAID", o.at ?? "2026-10-05T05:00:00Z")
      .run()
  ).meta.last_row_id;
  if (purpose === "PACKAGE") await db.prepare("UPDATE packages SET payment_id = ?2 WHERE id = ?1").bind(target, pay).run();
  return { conv, target, pay };
}
