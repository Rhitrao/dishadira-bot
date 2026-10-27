import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index"; // first: src/console.ts and src/people.ts import each other
import { memberCsrf, type Member } from "../src/auth";
import { searchClause } from "../src/people";
import { PEOPLE_COPY } from "../src/people-copy";
import { newDb } from "./db";

// Ticket 23: People and the person page. All data is synthetic (numbers start 91000…); Access is mocked and nothing real is called.
const NOW = Date.parse("2026-10-05T10:00:00Z"); // a Monday, 3:30 pm in Bengaluru
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const OWNER = "owner@example.test";
const PRAC = "practitioner@example.test";
const STAFF = "staff@example.test";
const PRAC2 = "second@example.test";
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let tokens: Map<string, string>;
let failBatch = false;

// failBatch makes every batch throw, as a database write that fails would.
const dbProxy = () =>
  new Proxy(db, {
    get(t, k) {
      if (k === "batch" && failBatch) return async () => { throw new Error("D1 down"); };
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
const env = (o: Record<string, unknown> = {}) =>
  ({ DB: dbProxy(), ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: "true", CHAT_RETENTION_MINUTES: "10080", ...o }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  tokens = new Map();
  failBatch = false;
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/cdn-cgi/access/certs") ? new Response(JSON.stringify(jwks)) : new Response("{}", { status: 404 }))));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

const sign = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(AUD).setIssuedAt().setExpirationTime("30d").sign(priv);
const jwtFor = async (email: string) => {
  if (!tokens.has(email)) tokens.set(email, await sign(email));
  return tokens.get(email)!;
};
// Pages come back with their HTML entities for quotes turned back into characters, so tests can match the plain words.
const decode = (s: string) => s.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const wrap = (res: Response) => ({ status: res.status, headers: res.headers, text: async () => decode(await res.text()) });
const get = async (path: string, as = OWNER, e = env()) => wrap(await app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as) } }, e));
const post = async (path: string, form: Record<string, string>, as = OWNER, e = env()) =>
  wrap(
    await app.request(
      ORIGIN + path,
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as), "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN }, body: new URLSearchParams(form).toString() },
      e,
    ),
  );
// What a person can read on the page: without the hex form tokens (which may contain any digits).
const readable = (body: string) => body.replace(/value="[0-9a-f]{64}"/g, "");
const memberRow = (email: string) =>
  db.prepare("SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status FROM members WHERE email = ?1").bind(email).first<Member>();
// The token exactly as the page draws it for this member: what a hand-made POST would send.
const tokenFor = async (email: string, scope: string) => memberCsrf(await jwtFor(email), (await memberRow(email))!, scope);
const csrfIn = (page: string, action: string) => new RegExp(`action="${action}"><input type="hidden" name="csrf" value="([0-9a-f]+)"`).exec(page)?.[1];
const audits = async (action: string) =>
  (await db.prepare("SELECT actor, member_id AS memberId, target, detail, reason FROM audit_log WHERE action = ?1 ORDER BY id").bind(action).all<{ actor: string; memberId: number; target: string; detail: string; reason: string | null }>()).results;
const idOf = async (email: string) => (await memberRow(email))!.id;
const one = <T>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();

// ---- synthetic people ----
// The seed (first /app request) makes the owner (1) and the practitioner (2); then staff and a second practitioner.
async function team() {
  await get("/app");
  await db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, ?1, 'STAFF', 'active'), (1, ?2, 'PRACTITIONER', 'active')").bind(STAFF, PRAC2).run();
}
async function person(waId: string, name: string | null, o: { mode?: string; lastUserAt?: string | null; locale?: string; adHeadline?: string; createdAt?: string } = {}) {
  const r = await db
    .prepare("INSERT INTO conversations (wa_id, display_name, mode, last_user_at, locale, ad_headline, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(waId, name, o.mode ?? "BOT", o.lastUserAt === undefined ? iso(NOW - 2 * HOUR) : o.lastUserAt, o.locale ?? "en", o.adHeadline ?? null, o.createdAt ?? "2026-09-20T05:00:00Z")
    .run();
  return r.meta.last_row_id;
}
// A booked ₹99 call (state PAID) with this practitioner, starting at startMs.
async function call(convId: number, pracEmail: string, startMs: number, state = "PAID") {
  const pid = await idOf(pracEmail);
  const s = await db
    .prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'BOOKED', ?4)")
    .bind(iso(startMs), iso(startMs + 15 * MIN), convId, pid)
    .run();
  const i = await db
    .prepare("INSERT INTO intros (conversation_id, slot_id, service, state, for_whom, call_lang, practitioner_id) VALUES (?1, ?2, 'HEALING', ?3, 'FAMILY', 'hi', ?4)")
    .bind(convId, s.meta.last_row_id, state, pid)
    .run();
  return i.meta.last_row_id;
}
// A call held for this person with a Razorpay link sent and not paid yet.
async function heldWithLink(convId: number, startMs: number, link = "plink_test_1") {
  const pid = await idOf(PRAC);
  const s = await db
    .prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until, practitioner_id) VALUES ('CALL', ?1, ?2, ?3, 'HELD', ?4, ?5)")
    .bind(iso(startMs), iso(startMs + 15 * MIN), convId, iso(NOW + 15 * MIN), pid)
    .run();
  const i = await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state, practitioner_id) VALUES (?1, ?2, 'PROTECTION', 'HELD', ?3)").bind(convId, s.meta.last_row_id, pid).run();
  const p = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, ?2, 9900, 'PENDING')")
    .bind(i.meta.last_row_id, link)
    .run();
  return { introId: i.meta.last_row_id, paymentId: p.meta.last_row_id, slotId: s.meta.last_row_id };
}
async function message(convId: number, dir: "IN" | "OUT", body: string | null, o: { key?: string; waMsg?: string; at?: string; status?: string } = {}) {
  await db
    .prepare("INSERT INTO messages (conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at) VALUES (?1, ?2, ?3, ?4, 'text', ?5, ?6, ?7)")
    .bind(convId, dir, o.waMsg ?? null, o.key ?? null, body, o.status ?? (dir === "IN" ? "SENT" : "SENT"), o.at ?? iso(NOW - 2 * HOUR))
    .run();
}
const state = (convId: number, sql: string, ...b: unknown[]) =>
  db.prepare(`INSERT OR IGNORE INTO person_state (conversation_id) VALUES (?1)`).bind(convId).run().then(() => db.prepare(sql).bind(convId, ...b).run());

const A_NUM = "910000004821"; // the practitioner's customer
const B_NUM = "910000007733"; // the second practitioner's customer
const C_NUM = "910000001956"; // no booking, waiting for a person
async function three() {
  await team();
  const a = await person(A_NUM, "Asha Devi");
  const b = await person(B_NUM, "Bina Rao");
  const cc = await person(C_NUM, "Chetan", { mode: "HUMAN" });
  await call(a, PRAC, NOW + 26 * HOUR);
  await call(b, PRAC2, NOW + 27 * HOUR);
  return { a, b, c: cc };
}

// Every run of 5 or more digits taken from a number: none of them may appear on a staff member's page.
const longPieces = (num: string) => {
  const out: string[] = [];
  for (let n = 5; n <= num.length; n++) for (let i = 0; i + n <= num.length; i++) out.push(num.slice(i, i + n));
  return out;
};

describe("People: the list", () => {
  it("lists everyone for the owner and staff, last 4 digits only, with the Visible to line", async () => {
    await three();
    for (const who of [OWNER, STAFF]) {
      const res = await get("/app/people", who);
      expect(res.status).toBe(200);
      const body = await res.text();
      for (const n of ["Asha …4821", "Bina …7733", "Chetan …1956"]) expect(body).toContain(n);
      expect(body).toContain("Visible to: Owner, Practitioner, Staff");
      expect(body).toContain("Waiting for a reply"); // Chetan's chip, in words
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("a practitioner sees only customers booked with them", async () => {
    const { a, b, c } = await three();
    const body = await (await get("/app/people", PRAC)).text();
    expect(body).toContain("Asha …4821");
    expect(body).not.toContain("Bina");
    expect(body).not.toContain("Chetan");
    expect(body).toContain(`/app/people/${a}`);
    expect(body).not.toContain(`/app/people/${b}"`);
    expect(body).not.toContain(`/app/people/${c}"`);
    // A hold that expired is not a booking: nobody booked with them.
    const d = await person("910000005500", "Dev");
    await call(d, PRAC, NOW + 30 * HOUR, "EXPIRED");
    expect(await (await get("/app/people", PRAC)).text()).not.toContain("Dev …5500");
    // The second practitioner sees only Bina.
    const second = await (await get("/app/people", PRAC2)).text();
    expect(second).toContain("Bina");
    expect(second).not.toContain("Asha");
  });

  it("filters: Waiting, Upcoming, Has a package, Blocked", async () => {
    const { a } = await three();
    const e = await person("910000002020", "Esha", { mode: "BLOCKED" });
    const k = await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(e).run();
    await db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, 10, 'PURCHASE', ?2, 'system')").bind(k.meta.last_row_id, iso(NOW - 86_400_000)).run();
    const names = async (f: string, who = OWNER) => {
      const body = await (await get(`/app/people?f=${f}`, who)).text();
      return ["Asha", "Bina", "Chetan", "Esha"].filter((n) => body.includes(`${n} …`));
    };
    expect(await names("waiting")).toEqual(["Chetan"]);
    expect(await names("upcoming")).toEqual(["Asha", "Bina"]);
    expect(await names("package")).toEqual(["Esha"]);
    expect(await names("blocked")).toEqual(["Esha"]);
    expect(await names("upcoming", PRAC)).toEqual(["Asha"]);
    expect(await names("nonsense")).toEqual(["Asha", "Bina", "Chetan", "Esha"]);
    expect((await (await get(`/app/people?f=upcoming`)).text())).toContain(`href="/app/people/${a}?f=upcoming"`);
  });

  it("search by name or by the last 4 digits; a longer number only ever matches on its last 4", async () => {
    await three();
    const names = async (q: string, who = OWNER) => {
      const body = await (await get(`/app/people?q=${encodeURIComponent(q)}`, who)).text();
      return ["Asha", "Bina", "Chetan"].filter((n) => body.includes(`${n} …`));
    };
    expect(await names("asha")).toEqual(["Asha"]);
    expect(await names("4821")).toEqual(["Asha"]);
    expect(await names("+91 0000 04821")).toEqual(["Asha"]);
    // Probing the middle of a number finds nothing: "00000" is cut to its last 4 ("0000"), which no number ends with.
    expect(await names("00000")).toEqual([]);
    expect(await names("9100")).toEqual([]);
    expect(await names("%")).toEqual([]); // LIKE wildcards are plain text
    expect(await names("4821", PRAC2)).toEqual([]); // still scoped
    expect(searchClause("12345678")).toEqual({ sql: "c.wa_id LIKE ?1", value: "%5678" });
    expect((await (await get("/app/people?q=zz")).text())).toContain("Nobody matches that search.");
  });

  it("an empty list says what will appear and links on", async () => {
    await team();
    expect(await (await get("/app/people")).text()).toContain("People appear once they message the business on WhatsApp.");
    expect(await (await get("/app/people", PRAC)).text()).toContain("Your customers appear once they book a call or session with you.");
  });
});

describe("the person page", () => {
  it("shows the header, next booking, package ledger, payments and chat, top to bottom, and records the opening", async () => {
    const { a } = await three();
    await db.prepare("UPDATE conversations SET ad_headline = 'Calm in 15 minutes', locale = 'hi' WHERE id = ?1").bind(a).run();
    const k = (await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, 10, 500000, 'PAID')").bind(a).run()).meta.last_row_id;
    const ses = await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('SESSION', '2026-09-28T09:00:00Z', '2026-09-28T10:00:00Z', ?1, 'BOOKED')").bind(a).run();
    const sid = (await db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, package_id) VALUES (?1, ?2, 'HEALING', 'COMPLETED', 'CREDIT', ?3)").bind(a, ses.meta.last_row_id, k).run()).meta.last_row_id;
    await db
      .prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (?1, 10, 'PURCHASE', NULL, '2026-09-25T05:00:00Z', 'system'), (?1, -1, 'BOOK', ?2, '2026-09-26T05:00:00Z', 'system'), (?1, -1, 'BOOK', NULL, '2026-09-27T05:00:00Z', 'system'), (?1, 1, 'CANCEL_RETURN', NULL, '2026-09-27T06:00:00Z', 'system'), (?1, -3, 'BOOK', NULL, '2026-09-29T05:00:00Z', 'system')")
      .bind(k, sid)
      .run();
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, amount_paise, state, provider_link_id) VALUES ('razorpay', 'PACKAGE', ?1, 500000, 'PAID', 'plink_pk')").bind(k).run();
    await message(a, "IN", "Is the call on the phone?");
    await message(a, "OUT", "Yes, by phone.", { key: "m1:ai" });
    const res = await get(`/app/people/${a}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const order = ["Asha Devi", "…4821", "Speaks Hindi", "First message Sun, 20 Sep", 'Came from the ad "Calm in 15 minutes"', "Next booking", "Package", "6 of 10 left", "Payments", "Chat", "Safety", "More"];
    let at = -1;
    for (const s of order) {
      const i = body.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(body).toContain("Bought 10 sessions");
    expect(body).toContain("Used for the session on Mon, 28 Sep, 2:30 pm");
    expect(body).toContain("Returned: a session was cancelled in time");
    expect(body).toContain("10-session package");
    expect(body).toContain("₹5,000");
    expect(body).toContain("Paid");
    expect(body).toContain("Call in Hindi"); // the next booking: the call language
    expect(body).toContain("For family");
    expect(body).toContain("Text deleted on Mon, 12 Oct"); // last message 2 hours ago + 7 days
    expect(body).toContain("Is the call on the phone?");
    expect(body).not.toContain(A_NUM);
    const opened = await audits("PERSON_OPENED");
    expect(opened).toEqual([{ actor: OWNER, memberId: 1, target: `conv:${a}`, detail: "", reason: null }]);
  });

  it("a missing person is a plain 404; a practitioner opening someone else's customer is refused and not recorded", async () => {
    const { b } = await three();
    expect((await get("/app/people/9999")).status).toBe(404);
    expect((await get("/app/people/abc")).status).toBe(404);
    const res = await get(`/app/people/${b}`, PRAC);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Bina");
    expect(await audits("PERSON_OPENED")).toEqual([]);
  });

  it("a practitioner sees their own customer and reads their chat (read-only, CONTRACT v6), but no money", async () => {
    const { a } = await three();
    await message(a, "IN", "my private worry");
    const { paymentId } = await heldWithLink(a, NOW + 50 * HOUR);
    const body = await (await get(`/app/people/${a}`, PRAC)).text();
    expect(body).toContain("Asha Devi");
    expect(body).toContain("my private worry");
    expect(body).not.toContain("Practitioners speak to customers on calls");
    expect(body).not.toMatch(/<textarea|\/reply"/); // nothing to reply with
    expect(body).not.toContain("Payments</span>");
    expect(body).not.toContain('chip attention">Waiting<'); // the unpaid link's status
    expect(body).not.toContain("/money");
    expect(paymentId).toBeGreaterThan(0);
    expect(body).not.toContain("Remove their data");
    expect(body).not.toContain("/block");
  });

  it("the page renders in Hindi for a Hindi member", async () => {
    const { a } = await three();
    await db.prepare("UPDATE members SET locale = 'hi' WHERE email = ?1").bind(STAFF).run();
    const body = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(body).toContain('lang="hi"');
    expect(body).toContain(PEOPLE_COPY.hi.secNext);
    expect(body).toContain(PEOPLE_COPY.hi.safetyNormal);
  });
});

describe("check 9: staff never see more than the last 4 digits", () => {
  it("on the list, the person page, search results and after every action they can take", async () => {
    const { a, c } = await three();
    await heldWithLink(a, NOW + 50 * HOUR);
    const pages = [await get("/app/people", STAFF), await get(`/app/people/${a}`, STAFF), await get(`/app/people/${c}`, STAFF), await get(`/app/people?q=${A_NUM}`, STAFF)];
    for (const res of pages) {
      const body = readable(await res.text());
      for (const num of [A_NUM, B_NUM, C_NUM]) for (const piece of longPieces(num)) expect(body.includes(piece), `${piece} near ${body.slice(body.indexOf(piece) - 80, body.indexOf(piece) + 20)}`).toBe(false);
    }
    expect(await (await get(`/app/people?q=${A_NUM}`, STAFF)).text()).toContain('name="q" value="4821"'); // the search box keeps only the last 4
    // No reveal for staff: no button, and a hand-made POST is refused and recorded nowhere.
    const page = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(page).not.toContain("/reveal");
    expect(page).not.toContain("tel:");
    const res = await post(`/app/people/${a}/reveal`, { csrf: await tokenFor(STAFF, `people-reveal:${a}`), reason: "need to call them" }, STAFF);
    expect(res.status).toBe(403);
    const refused = readable(await res.text());
    for (const piece of longPieces(A_NUM)) expect(refused).not.toContain(piece);
    expect(await audits("PERSON_REVEAL_NUMBER")).toEqual([]);
  });
});

describe("show the full number", () => {
  it("needs a reason; with one, it is logged first and shown on that response only", async () => {
    const { a } = await three();
    const page = await (await get(`/app/people/${a}`)).text();
    const csrf = csrfIn(page, `/app/people/${a}/reveal`)!;
    expect(csrf).toBeTruthy();
    expect(page).not.toContain(A_NUM);
    for (const reason of ["", "  ", "ok"]) {
      const res = await post(`/app/people/${a}/reveal`, { csrf, reason });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Write a one-line reason first.");
      expect(body).not.toContain(A_NUM);
    }
    expect(await audits("PERSON_REVEAL_NUMBER")).toEqual([]);
    const res = await post(`/app/people/${a}/reveal`, { csrf, reason: "Call back about the time" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="tel:+${A_NUM}"`);
    expect(body).toContain("Showing the number was recorded.");
    expect(await audits("PERSON_REVEAL_NUMBER")).toEqual([{ actor: OWNER, memberId: 1, target: `conv:${a}`, detail: "", reason: "Call back about the time" }]);
    expect(await (await get(`/app/people/${a}`)).text()).not.toContain(A_NUM); // the next page load is masked again
  });

  it("a practitioner may only within an hour of their own call, as can() says; the button and the POST agree", async () => {
    await team();
    const a = await person(A_NUM, "Asha");
    await call(a, PRAC, NOW + 3 * HOUR);
    const scope = `people-reveal:${a}`;
    let page = await (await get(`/app/people/${a}`, PRAC)).text();
    expect(page).not.toContain("/reveal");
    expect((await post(`/app/people/${a}/reveal`, { csrf: await tokenFor(PRAC, scope), reason: "calling now" }, PRAC)).status).toBe(403);
    vi.setSystemTime(NOW + 2 * HOUR + 5 * MIN); // 55 minutes before the call
    page = await (await get(`/app/people/${a}`, PRAC)).text();
    const csrf = csrfIn(page, `/app/people/${a}/reveal`);
    expect(csrf).toBeTruthy();
    const res = await post(`/app/people/${a}/reveal`, { csrf: csrf!, reason: "calling now" }, PRAC);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`tel:+${A_NUM}`);
    vi.setSystemTime(NOW + 4 * HOUR + 20 * MIN); // over an hour after it ended
    expect((await post(`/app/people/${a}/reveal`, { csrf: csrf!, reason: "calling now" }, PRAC)).status).toBe(403);
    expect((await audits("PERSON_REVEAL_NUMBER")).length).toBe(1);
  });
});

describe("the safety panel, in plain words", () => {
  const panel = (body: string) => /<h2 class="sec"><span>Safety<\/span>[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";

  it("nothing to watch", async () => {
    const { a } = await three();
    const p = panel(await (await get(`/app/people/${a}`)).text());
    expect(p).toContain("Nothing to watch. The bot answers them as usual.");
    expect(p).not.toContain("<form");
  });

  it("after a crisis message: no booking options until a date, with Allow bookings again for the owner only", async () => {
    const { a } = await three();
    await state(a, "UPDATE person_state SET no_sell_until = ?2 WHERE conversation_id = ?1", "2026-10-12T04:00:00Z");
    const owner = panel(await (await get(`/app/people/${a}`)).text());
    expect(owner).toContain("Not shown booking options until Mon, 12 Oct, after a crisis message.");
    expect(owner).toContain("Allow bookings again");
    const staff = panel(await (await get(`/app/people/${a}`, STAFF)).text());
    expect(staff).toContain("Not shown booking options until Mon, 12 Oct, after a safety message. An owner is needed.");
    expect(staff).not.toContain("crisis");
    expect(staff).not.toContain("Allow bookings again");
    // The owner's button works and is recorded; staff's hand-made POST is refused.
    expect((await post(`/app/people/${a}/allow-bookings`, { csrf: await tokenFor(STAFF, `people-allow:${a}`) }, STAFF)).status).toBe(403);
    const csrf = csrfIn(await (await get(`/app/people/${a}`)).text(), `/app/people/${a}/allow-bookings`)!;
    const res = await post(`/app/people/${a}/allow-bookings`, { csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/people/${a}?m=nosell`);
    expect(await one<{ v: string | null }>("SELECT no_sell_until AS v FROM person_state WHERE conversation_id = ?1", a)).toEqual({ v: null });
    expect((await audits("PERSON_ALLOW_BOOKINGS")).length).toBe(1);
    expect((await post(`/app/people/${a}/allow-bookings`, { csrf })).headers.get("Location")).toBe(`/app/people/${a}?m=gone`);
    expect((await audits("PERSON_ALLOW_BOOKINGS")).length).toBe(1); // nothing changed, nothing recorded
    expect(await (await get(`/app/people/${a}?m=nosell`)).text()).toContain("Booking options are shown to them again.");
  });

  it("a quiet period, and warnings before it, with the owner's button to let the bot answer again", async () => {
    const { a } = await three();
    await state(a, "UPDATE person_state SET strikes = 2, last_strike_at = ?2 WHERE conversation_id = ?1", iso(NOW - 86_400_000));
    let p = panel(await (await get(`/app/people/${a}`)).text());
    expect(p).toContain("2 of 3 warnings for messages the bot couldn't help with, the last on Sun, 4 Oct. At 3, the bot stops answering their typed messages for a week.");
    await state(a, "UPDATE person_state SET strikes = 0, quiet_until = ?2 WHERE conversation_id = ?1", "2026-10-09T10:00:00Z");
    p = panel(await (await get(`/app/people/${a}`)).text());
    expect(p).toContain("The bot isn't answering their typed messages until Fri, 9 Oct, after messages it couldn't help with. Booking buttons still work.");
    expect(p).not.toContain("warnings for");
    const csrf = csrfIn(await (await get(`/app/people/${a}`)).text(), `/app/people/${a}/clear-warnings`)!;
    expect((await post(`/app/people/${a}/clear-warnings`, { csrf: await tokenFor(STAFF, `people-clear:${a}`) }, STAFF)).status).toBe(403);
    expect((await post(`/app/people/${a}/clear-warnings`, { csrf })).headers.get("Location")).toBe(`/app/people/${a}?m=cleared`);
    expect(panel(await (await get(`/app/people/${a}`)).text())).toContain("Nothing to watch.");
    expect((await audits("PERSON_CLEAR_WARNINGS")).length).toBe(1);
  });

  it("old warnings (over a week) are not shown", async () => {
    const { a } = await three();
    await state(a, "UPDATE person_state SET strikes = 2, last_strike_at = ?2 WHERE conversation_id = ?1", iso(NOW - 8 * 86_400_000));
    expect(panel(await (await get(`/app/people/${a}`)).text())).toContain("Nothing to watch.");
  });

  it("blocked, and opted out", async () => {
    const { a } = await three();
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(a).run();
    await db.prepare("INSERT INTO blocks (wa_id, reason, by, created_at) VALUES (?1, 'RUDE', 'practitioner', '2026-10-01T06:00:00Z')").bind(A_NUM).run();
    await state(a, "UPDATE person_state SET opted_out_at = ?2 WHERE conversation_id = ?1", "2026-10-02T06:00:00Z");
    const p = panel(await (await get(`/app/people/${a}`)).text());
    expect(p).toContain("Blocked since Thu, 1 Oct. The bot doesn't answer them, and they can't book.");
    expect(p).toContain("Asked not to get messages, since Fri, 2 Oct.");
    expect(p).not.toContain("Nothing to watch");
    expect(p).not.toMatch(/RUDE|BLOCKED|no-sell|strikes/);
  });
});

describe("staff and safety messages", () => {
  it("staff see neither the customer's crisis message nor the safety reply; the owner sees both", async () => {
    const { a } = await three();
    await message(a, "IN", "synthetic crisis words", { waMsg: "wamid.T1" });
    await message(a, "OUT", "synthetic helpline text", { key: "wamid.T1:crisis" });
    await message(a, "IN", "an ordinary question", { waMsg: "wamid.T2" });
    const staff = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(staff).not.toContain("synthetic crisis words");
    expect(staff).not.toContain("synthetic helpline text");
    expect(staff.split("A safety message. An owner is needed.").length - 1).toBe(2);
    expect(staff).toContain("an ordinary question");
    const owner = await (await get(`/app/people/${a}`)).text();
    expect(owner).toContain("synthetic crisis words");
    expect(owner).toContain("synthetic helpline text");
  });

  it("wiped text says so, and a chat with every text gone says who wrote and when stays", async () => {
    const { a } = await three();
    await db.prepare("INSERT INTO messages (conversation_id, direction, kind, body, status, wiped_at) VALUES (?1, 'IN', 'text', NULL, 'SENT', ?2)").bind(a, iso(NOW - HOUR)).run();
    const body = await (await get(`/app/people/${a}`)).text();
    expect(body).toContain("(text deleted)");
    expect(body).toContain("The message text has been deleted. Who wrote, and when, stays.");
  });
});

describe("block, unblock and asking the owner", () => {
  it("the owner blocks with one confirm; staff ask the owner instead; a practitioner can't", async () => {
    const { a } = await three();
    const staffPage = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(staffPage).toContain("Ask the owner to block…");
    const sc = csrfIn(staffPage, `/app/people/${a}/block`)!;
    expect((await post(`/app/people/${a}/block`, { csrf: sc, reason: "" }, STAFF)).status).toBe(400);
    expect((await post(`/app/people/${a}/block`, { csrf: sc, reason: "Rude on the phone" }, STAFF)).headers.get("Location")).toBe(`/app/people/${a}?m=asked`);
    expect((await post(`/app/people/${a}/block`, { csrf: sc, reason: "again" }, STAFF)).headers.get("Location")).toBe(`/app/people/${a}?m=already`);
    expect(await one("SELECT kind, target, asked_by AS by, reason, decided_at AS d FROM requests")).toEqual({ kind: "BLOCK", target: `conv:${a}`, by: await idOf(STAFF), reason: "Rude on the phone", d: null });
    expect(await one<{ mode: string }>("SELECT mode FROM conversations WHERE id = ?1", a)).toEqual({ mode: "BOT" }); // nothing changed yet
    expect((await audits("REQUEST_BLOCK")).length).toBe(1);
    // Practitioner: no button, POST refused.
    expect(await (await get(`/app/people/${a}`, PRAC)).text()).not.toContain("/block");
    expect((await post(`/app/people/${a}/block`, { csrf: await tokenFor(PRAC, `people-block:${a}`), reason: "x y z" }, PRAC)).status).toBe(403);
    // Owner: blocks at once, recorded with the reason.
    const oc = csrfIn(await (await get(`/app/people/${a}`)).text(), `/app/people/${a}/block`)!;
    expect((await post(`/app/people/${a}/block`, { csrf: oc, reason: "Abusive" })).headers.get("Location")).toBe(`/app/people/${a}?m=blocked`);
    expect(await one("SELECT mode FROM conversations WHERE id = ?1", a)).toEqual({ mode: "BLOCKED" });
    expect(await one("SELECT reason, by FROM blocks WHERE wa_id = ?1", A_NUM)).toEqual({ reason: "ADMIN", by: OWNER });
    expect((await audits("PERSON_BLOCK"))[0]).toMatchObject({ memberId: 1, target: `conv:${a}`, reason: "Abusive" });
    // Unblock: owner only.
    const page = await (await get(`/app/people/${a}`)).text();
    const uc = csrfIn(page, `/app/people/${a}/unblock`)!;
    expect((await post(`/app/people/${a}/unblock`, { csrf: await tokenFor(STAFF, `people-unblock:${a}`) }, STAFF)).status).toBe(403);
    expect(await (await get(`/app/people/${a}`, STAFF)).text()).not.toContain("/unblock");
    expect((await post(`/app/people/${a}/unblock`, { csrf: uc })).headers.get("Location")).toBe(`/app/people/${a}?m=unblocked`);
    expect(await one("SELECT mode FROM conversations WHERE id = ?1", a)).toEqual({ mode: "BOT" });
    expect(await one("SELECT COUNT(*) AS n FROM blocks")).toEqual({ n: 0 });
    expect((await audits("PERSON_UNBLOCK")).length).toBe(1);
  });
});

describe("remove their data", () => {
  it("owner only, with a reason: name and message text go; bookings, payments, blocks and the log stay", async () => {
    const { a } = await three();
    await message(a, "IN", "please delete me");
    await message(a, "OUT", "Sure.", { key: "k1" });
    const { paymentId } = await heldWithLink(a, NOW + 50 * HOUR);
    const page = await (await get(`/app/people/${a}`)).text();
    const csrf = csrfIn(page, `/app/people/${a}/remove-data`)!;
    expect(page).toContain("Deletes their name and the text of every message now.");
    expect((await post(`/app/people/${a}/remove-data`, { csrf, reason: "" })).status).toBe(400);
    expect(await one("SELECT display_name AS n FROM conversations WHERE id = ?1", a)).toEqual({ n: "Asha Devi" });
    for (const who of [STAFF, PRAC]) {
      expect(await (await get(`/app/people/${a}`, who)).text()).not.toContain("remove-data");
      expect((await post(`/app/people/${a}/remove-data`, { csrf: await tokenFor(who, `people-remove:${a}`), reason: "they asked" }, who)).status).toBe(403);
    }
    const res = await post(`/app/people/${a}/remove-data`, { csrf, reason: "They asked by phone" });
    expect(res.headers.get("Location")).toBe(`/app/people/${a}?m=removed`);
    expect(await one("SELECT display_name AS n, wa_id AS w FROM conversations WHERE id = ?1", a)).toEqual({ n: null, w: A_NUM });
    expect(await one("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND body IS NOT NULL", a)).toEqual({ n: 0 });
    expect(await one("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND wiped_at IS NOT NULL", a)).toEqual({ n: 2 });
    expect(await one("SELECT COUNT(*) AS n FROM payments WHERE id = ?1", paymentId)).toEqual({ n: 1 });
    expect(await one("SELECT COUNT(*) AS n FROM intros WHERE conversation_id = ?1", a)).toEqual({ n: 2 });
    expect(await audits("PERSON_DATA_REMOVED")).toEqual([{ actor: OWNER, memberId: 1, target: `conv:${a}`, detail: "name and message text", reason: "They asked by phone" }]);
    const after = await (await get(`/app/people/${a}`)).text();
    expect(after).toContain("No name …4821");
    expect(after).not.toContain("please delete me");
  });

  it("a write that fails says \"That didn't save\", keeps the form filled in, and changes nothing", async () => {
    const { a } = await three();
    const csrf = csrfIn(await (await get(`/app/people/${a}`)).text(), `/app/people/${a}/remove-data`)!;
    failBatch = true;
    const res = await post(`/app/people/${a}/remove-data`, { csrf, reason: "They asked by phone" });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("That didn't save. Nothing changed. Please try again.");
    expect(body).toContain('value="They asked by phone"');
    failBatch = false;
    expect(await one("SELECT display_name AS n FROM conversations WHERE id = ?1", a)).toEqual({ n: "Asha Devi" });
    expect(await audits("PERSON_DATA_REMOVED")).toEqual([]);
  });
});

describe("record money received outside Razorpay", () => {
  it("staff: a request for the owner, nothing changes; practitioner: refused", async () => {
    const { a } = await three();
    const { paymentId } = await heldWithLink(a, NOW + 50 * HOUR);
    const page = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(page).toContain("Record money received outside Razorpay…");
    expect(page).toContain("Asks the owner to mark ₹99 for the ₹99 call as received.");
    const csrf = csrfIn(page, `/app/people/${a}/money`)!;
    expect(csrf).toBe(await tokenFor(STAFF, `people-money:${a}:${paymentId}`));
    expect((await post(`/app/people/${a}/money`, { csrf, payment: String(paymentId), method: "upi", reason: "" }, STAFF)).status).toBe(400);
    const res = await post(`/app/people/${a}/money`, { csrf, payment: String(paymentId), method: "upi", reason: "Paid to the business UPI at 3 pm" }, STAFF);
    expect(res.headers.get("Location")).toBe(`/app/people/${a}?m=asked`);
    expect(await one("SELECT kind, target, amount_paise AS amount, asked_by AS by, reason FROM requests")).toEqual({
      kind: "MARK_PAID", target: `payment:${paymentId}`, amount: 9900, by: await idOf(STAFF), reason: "UPI: Paid to the business UPI at 3 pm",
    });
    expect(await one("SELECT state FROM payments WHERE id = ?1", paymentId)).toEqual({ state: "PENDING" });
    expect((await audits("REQUEST_MARK_PAID"))[0]).toMatchObject({ memberId: await idOf(STAFF), detail: "₹99" });
    // While the request waits, the form is gone and the row says so.
    const after = await (await get(`/app/people/${a}`, STAFF)).text();
    expect(after).toContain("Waiting for the owner to approve");
    expect(after).not.toContain(`action="/app/people/${a}/money"`);
    // A token for another payment id doesn't fit this form.
    expect((await post(`/app/people/${a}/money`, { csrf, payment: String(paymentId + 1), method: "cash", reason: "abc" }, STAFF)).status).toBe(403);
    expect((await post(`/app/people/${a}/money`, { csrf: await tokenFor(PRAC, `people-money:${a}:${paymentId}`), payment: String(paymentId), reason: "abc" }, PRAC)).status).toBe(403);
  });

  it("owner: applied at once, as a paid link would be: payment paid, call booked, recorded with the reason", async () => {
    const { a } = await three();
    const { paymentId, introId, slotId } = await heldWithLink(a, NOW + 50 * HOUR);
    const page = await (await get(`/app/people/${a}`)).text();
    expect(page).toContain("Marks ₹99 for the ₹99 call as received.");
    const csrf = csrfIn(page, `/app/people/${a}/money`)!;
    const res = await post(`/app/people/${a}/money`, { csrf, payment: String(paymentId), method: "cash", reason: "Cash at the clinic" });
    expect(res.headers.get("Location")).toBe(`/app/people/${a}?m=money`);
    expect(await one("SELECT state FROM payments WHERE id = ?1", paymentId)).toEqual({ state: "PAID" });
    expect(await one("SELECT state FROM intros WHERE id = ?1", introId)).toEqual({ state: "PAID" });
    expect(await one("SELECT state FROM slots WHERE id = ?1", slotId)).toEqual({ state: "BOOKED" });
    expect((await audits("PERSON_MONEY_RECEIVED"))[0]).toMatchObject({ memberId: 1, target: `payment:${paymentId}`, detail: "₹99 cash: BOOKED", reason: "Cash at the clinic" });
    expect(await one("SELECT COUNT(*) AS n FROM requests")).toEqual({ n: 0 });
    // Again: nothing changes (already paid), and no second audit row.
    expect((await post(`/app/people/${a}/money`, { csrf, payment: String(paymentId), method: "cash", reason: "Cash at the clinic" })).headers.get("Location")).toBe(`/app/people/${a}?m=moneyGone`);
    expect((await audits("PERSON_MONEY_RECEIVED")).length).toBe(1);
  });

  it("is not offered for a paid payment, or when the booking is already paid another way", async () => {
    const { a } = await three();
    const { introId } = await heldWithLink(a, NOW + 50 * HOUR);
    await db.prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise, state) VALUES ('razorpay', 'INTRO', ?1, 'plink_paid', 9900, 'PAID')").bind(introId).run();
    const page = await (await get(`/app/people/${a}`)).text();
    expect(page).not.toContain(`action="/app/people/${a}/money"`);
  });
});

describe("every POST refuses a role that can't do it, even sent by hand", () => {
  // [route, scope, roles refused]. The owner can do all of them; the reveal for a practitioner is covered above (only near a call).
  const ROUTES: [string, string, string[]][] = [
    ["reveal", "people-reveal", [STAFF, PRAC]],
    ["allow-bookings", "people-allow", [STAFF, PRAC]],
    ["clear-warnings", "people-clear", [STAFF, PRAC]],
    ["block", "people-block", [PRAC]],
    ["unblock", "people-unblock", [STAFF, PRAC]],
    ["remove-data", "people-remove", [STAFF, PRAC]],
    ["money", "people-money", [PRAC]],
  ];
  for (const [route, scope, refused] of ROUTES) {
    it(`/${route}`, async () => {
      const { a, b } = await three();
      await state(a, "UPDATE person_state SET no_sell_until = ?2, strikes = 2, last_strike_at = ?3 WHERE conversation_id = ?1", "2026-10-12T04:00:00Z", iso(NOW - HOUR));
      const { paymentId } = await heldWithLink(a, NOW + 50 * HOUR);
      const before = JSON.stringify(await db.prepare("SELECT (SELECT COUNT(*) FROM requests) AS r, (SELECT COUNT(*) FROM blocks) AS b, (SELECT no_sell_until FROM person_state WHERE conversation_id = ?1) AS ns, (SELECT strikes FROM person_state WHERE conversation_id = ?1) AS st, (SELECT display_name FROM conversations WHERE id = ?1) AS n, (SELECT state FROM payments WHERE id = ?2) AS p").bind(a, paymentId).first());
      const form = (who: string) => async (target: number) => ({
        csrf: await tokenFor(who, `${scope}:${target}${route === "money" ? `:${paymentId}` : ""}`), reason: "a reason here", payment: String(paymentId), method: "cash",
      });
      for (const who of refused) {
        const page = await (await get(`/app/people/${a}`, who)).text();
        expect(page.includes(`action="/app/people/${a}/${route}"`), `${who} sees no button`).toBe(false);
        const res = await post(`/app/people/${a}/${route}`, await form(who)(a), who);
        expect(res.status, who).toBe(403);
      }
      // A practitioner, on someone else's customer: refused even for what they could do on their own.
      expect((await post(`/app/people/${b}/${route}`, await form(PRAC)(b), PRAC)).status).toBe(403);
      // A wrong token, and a token for another person, are refused for the owner too.
      expect((await post(`/app/people/${a}/${route}`, { ...(await form(OWNER)(a)), csrf: "0".repeat(64) })).status).toBe(403);
      expect((await post(`/app/people/${a}/${route}`, await form(OWNER)(b))).status).toBe(403);
      const after = JSON.stringify(await db.prepare("SELECT (SELECT COUNT(*) FROM requests) AS r, (SELECT COUNT(*) FROM blocks) AS b, (SELECT no_sell_until FROM person_state WHERE conversation_id = ?1) AS ns, (SELECT strikes FROM person_state WHERE conversation_id = ?1) AS st, (SELECT display_name FROM conversations WHERE id = ?1) AS n, (SELECT state FROM payments WHERE id = ?2) AS p").bind(a, paymentId).first());
      expect(after).toBe(before);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'PERSON_%' AND action != 'PERSON_OPENED' OR action LIKE 'REQUEST_%'").first("n")).toBe(0);
    });
  }

  it("a POST without the console's Origin is refused before anything", async () => {
    const { a } = await three();
    const csrf = await tokenFor(OWNER, `people-remove:${a}`);
    const res = await app.request(
      `${ORIGIN}/app/people/${a}/remove-data`,
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await jwtFor(OWNER), "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, body: new URLSearchParams({ csrf, reason: "abc def" }).toString() },
      env(),
    );
    expect(res.status).toBe(403);
    expect(await one("SELECT display_name AS n FROM conversations WHERE id = ?1", a)).toEqual({ n: "Asha Devi" });
  });

  it("with CONSOLE_V2 off, People is a plain 404", async () => {
    await three();
    expect((await get("/app/people", OWNER, env({ CONSOLE_V2: "false" }))).status).toBe(404);
  });
});
