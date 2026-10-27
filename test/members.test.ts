import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { ACTIONS, can, canAny, memberCsrf, PERMISSIONS, type Action, type Member, type Role } from "../src/auth";
import { TABS } from "../src/console";
import { holdSlot } from "../src/slots";
import { addPerson, applySql, migrations, newDb } from "./db";

// All data is synthetic. Access and email are mocked: nothing real is called.
const NOW = Date.parse("2026-10-05T10:00:00Z");
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const OWNER = "owner@example.test";
const PRAC = "practitioner@example.test";
const STAFF = "staff@example.test";
const OTHER = "stranger@example.test";
let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };
let emails: { to: string; subject: string; text: string }[];
let emailDown = false;
let tokens: Map<string, string>;

const env = (o: Record<string, unknown> = {}) =>
  ({
    DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ROHIT_EMAIL: OWNER, AMMA_EMAIL: PRAC, CONSOLE_V2: "true",
    EMAIL: { send: async (m: (typeof emails)[number]) => { if (emailDown) throw Object.assign(new Error("down"), { code: "E_DELIVERY_FAILED" }); emails.push(m); return {}; } },
    ...o,
  }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  emails = [];
  emailDown = false;
  tokens = new Map();
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

const sign = (email: string, aud = AUD) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}.cloudflareaccess.com`).setAudience(aud).setIssuedAt().setExpirationTime("30d").sign(priv);
const jwtFor = async (email: string) => {
  if (!tokens.has(email)) tokens.set(email, await sign(email));
  return tokens.get(email)!;
};
const get = async (path: string, as = OWNER, e = env()) => app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": await jwtFor(as) } }, e);
const post = async (path: string, form: Record<string, string>, as = OWNER, o: { origin?: string | null; e?: unknown } = {}) => {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await jwtFor(as), "Content-Type": "application/x-www-form-urlencoded" };
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  return app.request(ORIGIN + path, { method: "POST", headers, body: new URLSearchParams(form).toString() }, (o.e ?? env()) as never);
};
const memberRow = (email: string) =>
  db.prepare("SELECT id, workspace_id AS workspaceId, email, display_name AS displayName, role, locale, status FROM members WHERE email = ?1").bind(email).first<Member>();
// A form token exactly as the page would draw it for this member: what a hand-made POST would send.
const tokenFor = async (email: string, scope: string) => memberCsrf(await jwtFor(email), (await memberRow(email))!, scope);
const csrfFrom = (page: string, action: string) => new RegExp(`action="${action}">\\s*(?:<input type="hidden" name="member" value="\\d+">\\s*)?<input type="hidden" name="csrf" value="([0-9a-f]+)"`).exec(page)?.[1];
const roles = async () => (await db.prepare("SELECT email, role, status FROM members ORDER BY id").all<{ email: string; role: string; status: string }>()).results;
const audits = async (action: string) => (await db.prepare("SELECT actor, member_id AS memberId, workspace_id AS ws, target, detail FROM audit_log WHERE action = ?1").bind(action).all<{ actor: string; memberId: number | null; ws: number; target: string; detail: string }>()).results;

// Seed (first request) and add an active staff member directly.
async function withStaff() {
  await get("/app");
  await db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, ?1, 'STAFF', 'active')").bind(STAFF).run();
}
async function invite(email: string, role: Role = "STAFF") {
  const page = await (await get("/app/settings/team")).text();
  const csrf = csrfFrom(page, "/app/settings/team/invite")!;
  return post("/app/settings/team/invite", { csrf, email, role });
}
const linkIn = (text: string) => /\/app\/invite\/([A-Za-z0-9_-]+)/.exec(text)?.[1];
async function accept(tok: string, as: string) {
  const page = await (await get(`/app/invite/${tok}`, as)).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "x";
  return post(`/app/invite/${tok}`, { csrf }, as);
}

// ---- the PRD's permission table, written out again here as the PRD says it, and checked against can() ----
// own: own items only. window: own customers, 1 hour either side of the call. not-safety: yes except safety messages.
const PRD: Record<string, [Action, string, string, string]> = {
  "See Today": ["view_today", "yes", "own", "yes"],
  "See the calendar": ["view_calendar", "yes", "own", "yes"],
  "Set working hours and block time off": ["set_hours", "yes", "own", "no"],
  "Mark a call outcome, offer a session": ["mark_outcome", "yes", "own", "no"],
  "Reply to a handed-over chat": ["reply_chat", "yes", "no", "yes"],
  "See a customer's full phone number": ["reveal_phone", "yes", "window", "no"],
  "Read a customer's chat": ["read_chat", "yes", "own", "not-safety"],
  "Move or cancel a booking": ["move_booking", "yes", "own", "yes"],
  "Record money received outside Razorpay": ["record_payment", "yes", "no", "ask"],
  Refund: ["refund", "yes", "no", "ask"],
  "Block or unblock a number": ["block", "yes", "no", "ask"],
  "See payment totals and export": ["see_money", "yes", "no", "no"],
  "Prices, hours, bot switches, payment keys": ["business_settings", "yes", "no", "no"],
  "Invite, change roles, remove members": ["manage_team", "yes", "no", "no"],
  "Read the audit log": ["read_audit", "yes", "no", "no"],
  "People screen (least access: own customers)": ["view_people", "yes", "own", "yes"],
};
const ROLE_ORDER: Role[] = ["OWNER", "PRACTITIONER", "STAFF"];
const m = (role: Role, id = 7, status = "active"): Member => ({ id, workspaceId: 1, email: "x@example.test", displayName: null, role, locale: "en", status });

describe("can(): the permission table", () => {
  it("has exactly the PRD's rows, one decision per role", () => {
    expect(ACTIONS.sort()).toEqual(Object.values(PRD).map((r) => r[0]).sort());
    for (const a of ACTIONS) expect(Object.keys(PERMISSIONS[a]).sort()).toEqual([...ROLE_ORDER].sort());
  });

  for (const [row, [action, ...cells]] of Object.entries(PRD)) {
    ROLE_ORDER.forEach((role, i) => {
      const cell = cells[i];
      it(`${row} · ${role}: ${cell}`, () => {
        const me = m(role, 7);
        const mine = { practitionerId: 7 };
        const theirs = { practitionerId: 8 };
        const call = { callStartMs: NOW + 30 * 60_000, callEndMs: NOW + 45 * 60_000, nowMs: NOW };
        if (cell === "yes" || cell === "no" || cell === "ask") {
          for (const t of [undefined, mine, theirs, { safety: true }]) expect(can(me, action, t)).toBe(cell);
          expect(canAny(me, action)).toBe(cell !== "no");
        } else if (cell === "own") {
          expect(can(me, action)).toBe("no"); // no target: never a yes
          expect(can(me, action, mine)).toBe("yes");
          expect(can(me, action, theirs)).toBe("no");
          expect(can(me, action, { practitionerId: null })).toBe("no");
          expect(canAny(me, action)).toBe(true);
        } else if (cell === "window") {
          expect(can(me, action, { ...mine, ...call })).toBe("yes");
          expect(can(me, action, { ...theirs, ...call })).toBe("no");
          expect(can(me, action, { ...mine, ...call, nowMs: NOW + 30 * 60_000 - 61 * 60_000 })).toBe("no"); // more than 1 h before
          expect(can(me, action, { ...mine, ...call, nowMs: NOW + 30 * 60_000 - 60 * 60_000 })).toBe("yes"); // exactly 1 h before
          expect(can(me, action, { ...mine, ...call, nowMs: NOW + 45 * 60_000 + 60 * 60_000 })).toBe("yes"); // 1 h after the end
          expect(can(me, action, { ...mine, ...call, nowMs: NOW + 45 * 60_000 + 61 * 60_000 })).toBe("no");
          expect(can(me, action, mine)).toBe("no"); // no call time: no
        } else {
          expect(can(me, action, { safety: false })).toBe("yes");
          expect(can(me, action, { safety: true })).toBe("no");
          expect(can(me, action)).toBe("no");
        }
      });
    });
  }

  it("a removed or invited member, or nobody, can do nothing", () => {
    for (const role of ROLE_ORDER) {
      for (const a of ACTIONS) {
        expect(can(m(role, 7, "removed"), a, { practitionerId: 7 })).toBe("no");
        expect(can(m(role, 7, "invited"), a, { practitionerId: 7 })).toBe("no");
        expect(canAny(m(role, 7, "removed"), a)).toBe(false);
      }
    }
    expect(can(null, "view_today")).toBe("no");
    expect(can({ ...m("OWNER"), role: "ADMIN" as Role }, "view_today")).toBe("no");
  });
});

describe("/app: the gate", () => {
  it("is a plain 404 while CONSOLE_V2 is off, and /admin is unchanged", async () => {
    for (const v of [undefined, "false", "TRUE"]) {
      expect((await get("/app", OWNER, env({ CONSOLE_V2: v }))).status).toBe(404);
      expect((await get("/app/settings/team", OWNER, env({ CONSOLE_V2: v }))).status).toBe(404);
    }
    expect((await app.request(ORIGIN + "/admin", {}, env())).status).toBe(403);
  });

  it("refuses a missing, foreign or badly signed token with No access", async () => {
    expect((await app.request(ORIGIN + "/app", {}, env())).status).toBe(403);
    const wrongAud = await sign(OWNER, "other-aud");
    const res = await app.request(ORIGIN + "/app", { headers: { "Cf-Access-Jwt-Assertion": wrongAud } }, env());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("No access");
  });

  it("a verified email with no membership gets No access and nothing else", async () => {
    const res = await get("/app", OTHER);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("No access");
    expect(body).not.toContain("/app/settings");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect((await post("/app/settings/team/invite", { csrf: "x", email: "a@example.test", role: "STAFF" }, OTHER)).status).toBe(403);
  });

  it("refuses a POST without our Origin", async () => {
    await withStaff();
    const csrf = await tokenFor(OWNER, "team-invite");
    for (const origin of [null, "https://evil.example.test"]) {
      expect((await post("/app/settings/team/invite", { csrf, email: "new@example.test", role: "STAFF" }, OWNER, { origin })).status).toBe(403);
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM invites").first("n")).toBe(0);
  });
});

describe("one-time seed", () => {
  it("makes the owner and the practitioner from the two sign-in emails, once, and points old bookings to the practitioner", async () => {
    const conv = await addPerson(db, "910000000001");
    const slot = await db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', '2026-10-06T09:00:00Z', '2026-10-06T09:15:00Z', ?1, 'BOOKED')").bind(conv).run();
    expect(slot.meta.changes).toBe(1);
    await db.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', 'PAID')").bind(conv, slot.meta.last_row_id).run();
    await db.prepare("INSERT INTO sessions (conversation_id, service) VALUES (?1, 'HEALING')").bind(conv).run();
    expect(await db.prepare("SELECT practitioner_id FROM slots").first("practitioner_id")).toBeNull(); // no members yet

    expect((await get("/app")).status).toBe(200);
    expect((await get("/app", PRAC)).status).toBe(200);
    expect(await roles()).toEqual([
      { email: OWNER, role: "OWNER", status: "active" },
      { email: PRAC, role: "PRACTITIONER", status: "active" },
    ]);
    const pid = (await memberRow(PRAC))!.id;
    for (const t of ["slots", "intros", "sessions"]) expect(await db.prepare(`SELECT practitioner_id FROM ${t}`).first("practitioner_id"), t).toBe(pid);
    expect(await audits("members_seeded")).toHaveLength(1);

    // A new hold is on the practitioner's calendar too.
    expect(await holdSlot(db, { kind: "CALL", startUtc: "2026-10-07T09:00:00Z", ownerId: conv, nowMs: NOW })).toMatchObject({ ok: true });
    expect(await db.prepare("SELECT practitioner_id FROM slots WHERE start_utc = '2026-10-07T09:00:00Z'").first("practitioner_id")).toBe(pid);
  });

  it("never runs again once there are members, and needs the owner email", async () => {
    await get("/app", OWNER, env({ ROHIT_EMAIL: "" }));
    expect(await roles()).toEqual([]);
    await get("/app");
    await db.prepare("UPDATE members SET status = 'removed' WHERE role = 'PRACTITIONER'").run();
    await get("/app");
    expect((await roles()).length).toBe(2);
    expect(await audits("members_seeded")).toHaveLength(1);
  });

  it("records the first visit time", async () => {
    await get("/app");
    expect(await db.prepare("SELECT last_seen_at FROM members WHERE email = ?1").bind(OWNER).first("last_seen_at")).toBe("2026-10-05T10:00:00Z");
  });
});

describe("tabs and screens follow the role", () => {
  const expected: Record<string, string[]> = {
    [OWNER]: ["today", "inbox", "calendar", "people", "payments", "settings"],
    [PRAC]: ["today", "calendar", "people"],
    [STAFF]: ["today", "inbox", "calendar", "people"],
  };
  for (const who of [OWNER, PRAC, STAFF]) {
    it(`${who.split("@")[0]}: a tab is shown exactly when its page opens`, async () => {
      await withStaff();
      const home = await (await get("/app", who)).text();
      const shown = TABS.filter((t) => home.includes(`href="${t.href}"`)).map((t) => t.id);
      expect(shown).toEqual(expected[who]);
      for (const t of TABS) {
        const res = await get(t.href, who);
        expect(res.status, `${t.href}`).toBe(shown.includes(t.id) ? 200 : 403);
      }
      const team = await get("/app/settings/team", who);
      expect(team.status).toBe(who === OWNER ? 200 : 403);
      expect(home.includes("/app/settings/team")).toBe(false); // the team link sits on Settings, not Today
    });
  }

  it("each screen says who can see it, in words", async () => {
    await withStaff();
    expect(await (await get("/app/inbox")).text()).toContain("Visible to: Owner, Staff");
    expect(await (await get("/app/settings/team")).text()).toContain("Visible to: Owner");
    expect(await (await get("/app/settings")).text()).toContain('href="/app/settings/team"');
  });
});

describe("team: only the owner, for the page and every POST", () => {
  for (const who of [PRAC, STAFF]) {
    it(`${who.split("@")[0]} is refused every team change, even with a hand-made form`, async () => {
      await withStaff();
      const target = (await memberRow(who === STAFF ? PRAC : STAFF))!.id;
      const ownerId = (await memberRow(OWNER))!.id;
      const before = JSON.stringify(await roles());
      const cases: [string, Record<string, string>, string][] = [
        ["invite", { email: "new@example.test", role: "STAFF" }, "team-invite"],
        ["role", { member: String(target), role: "STAFF" }, `team-role:${target}`],
        ["remove", { member: String(target) }, `team-remove:${target}`],
        ["transfer", { member: String((await memberRow(who))!.id) }, `team-transfer:${(await memberRow(who))!.id}`],
        ["remove", { member: String(ownerId) }, `team-remove:${ownerId}`],
      ];
      for (const [path, form, scope] of cases) {
        const res = await post(`/app/settings/team/${path}`, { ...form, csrf: await tokenFor(who, scope) }, who);
        expect(res.status, path).toBe(403);
      }
      expect(JSON.stringify(await roles())).toBe(before);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM invites").first("n")).toBe(0);
    });
  }

  it("a token from another form, or another member, is refused", async () => {
    await withStaff();
    const staffId = (await memberRow(STAFF))!.id;
    const wrong = await tokenFor(OWNER, `team-remove:${staffId + 1}`);
    expect((await post("/app/settings/team/remove", { member: String(staffId), csrf: wrong })).status).toBe(403);
    expect((await post("/app/settings/team/remove", { member: String(staffId), csrf: "0".repeat(64) })).status).toBe(403);
    expect((await memberRow(STAFF))!.status).toBe("active");
  });
});

describe("invites", () => {
  it("sends a one-time link by email; the invitee has no access until they accept it; everything is audited", async () => {
    await get("/app");
    const res = await invite(STAFF, "STAFF");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app/settings/team?m=invited");
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe(STAFF);
    expect(emails[0].text).toContain("as Staff");
    const tok = linkIn(emails[0].text)!;
    expect(tok.length).toBeGreaterThan(40);
    expect(await db.prepare("SELECT token_hash FROM invites").first("token_hash")).not.toContain(tok); // only the hash is stored
    expect((await memberRow(STAFF))!.status).toBe("invited");
    expect(await (await get("/app/settings/team")).text()).toContain("Invite sent");

    expect((await get("/app", STAFF)).status).toBe(403); // invited is not a member yet
    const page = await get(`/app/invite/${tok}`, STAFF);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Accept the invite");
    expect((await memberRow(STAFF))!.status).toBe("invited"); // opening the link changes nothing
    const ok = await accept(tok, STAFF);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("/app?m=joined");
    expect((await memberRow(STAFF))!.status).toBe("active");
    expect((await get("/app", STAFF)).status).toBe(200);

    const ownerId = (await memberRow(OWNER))!.id;
    expect(await audits("member_invited")).toEqual([{ actor: OWNER, memberId: ownerId, ws: 1, target: `email:${STAFF}`, detail: "STAFF" }]);
    expect(await audits("invite_accepted")).toEqual([{ actor: STAFF, memberId: (await memberRow(STAFF))!.id, ws: 1, target: `member:${(await memberRow(STAFF))!.id}`, detail: "STAFF" }]);
  });

  it("works once: a second accept is refused", async () => {
    await get("/app");
    await invite(STAFF);
    const tok = linkIn(emails[0].text)!;
    expect((await accept(tok, STAFF)).status).toBe(303);
    const again = await accept(tok, STAFF);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("already been used");
    expect(await audits("invite_accepted")).toHaveLength(1);
  });

  it("expires after 7 days", async () => {
    await get("/app");
    await invite("late@example.test");
    const tok = linkIn(emails[0].text)!;
    vi.setSystemTime(NOW + 7 * 86_400_000 + 60_000);
    const res = await accept(tok, "late@example.test");
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("expired");
    expect((await memberRow("late@example.test"))!.status).toBe("invited");
    // A day before the end it still works.
    vi.setSystemTime(NOW);
    await invite("late@example.test");
    vi.setSystemTime(NOW + 6 * 86_400_000);
    expect((await accept(linkIn(emails[1].text)!, "late@example.test")).status).toBe(303);
  });

  it("only works for the email it was sent to, and a bad link says so", async () => {
    await get("/app");
    await invite(STAFF);
    const tok = linkIn(emails[0].text)!;
    const res = await accept(tok, OTHER);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("different email address");
    expect((await get("/app/invite/notarealtoken", STAFF)).status).toBe(404);
    expect((await memberRow(STAFF))!.status).toBe("invited");
  });

  it("a new invite replaces the old link; removing the person kills their link", async () => {
    await get("/app");
    await invite(STAFF);
    await invite(STAFF, "PRACTITIONER");
    const [first, second] = emails.map((e) => linkIn(e.text)!);
    expect((await accept(first, STAFF)).status).toBe(410);
    expect((await memberRow(STAFF))!.role).toBe("PRACTITIONER");
    await invite("third@example.test");
    const third = linkIn(emails[2].text)!;
    const id = (await memberRow("third@example.test"))!.id;
    expect((await post("/app/settings/team/remove", { member: String(id), csrf: await tokenFor(OWNER, `team-remove:${id}`) })).status).toBe(303);
    expect((await accept(third, "third@example.test")).status).toBe(410);
    expect((await accept(second, STAFF)).status).toBe(303);
  });

  it("an active member can't be invited again, and a bad address is refused", async () => {
    await withStaff();
    const res = await invite(STAFF);
    expect(res.headers.get("Location")).toBe("/app/settings/team?m=member");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM invites").first("n")).toBe(0);
    expect(await audits("member_invited")).toHaveLength(0);
    expect((await invite("not an email")).status).toBe(400);
    expect((await invite(OWNER)).headers.get("Location")).toBe("/app/settings/team?m=member");
    const page = await (await get("/app/settings/team")).text();
    expect((await post("/app/settings/team/invite", { csrf: csrfFrom(page, "/app/settings/team/invite")!, email: "x@example.test", role: "OWNER" })).status).toBe(400);
    expect((await memberRow(OWNER))!.role).toBe("OWNER");
  });

  it("if the email doesn't go, the owner sees the link once on the page", async () => {
    await get("/app");
    emailDown = true;
    const res = await invite(STAFF);
    expect(res.status).toBe(200);
    const tok = linkIn(await res.text())!;
    expect(tok).toBeTruthy();
    expect((await accept(tok, STAFF)).status).toBe(303);
  });

  it("a removed member can be invited back", async () => {
    await withStaff();
    const id = (await memberRow(STAFF))!.id;
    await post("/app/settings/team/remove", { member: String(id), csrf: await tokenFor(OWNER, `team-remove:${id}`) });
    await invite(STAFF, "PRACTITIONER");
    expect((await accept(linkIn(emails[0].text)!, STAFF)).status).toBe(303);
    expect(await memberRow(STAFF)).toMatchObject({ id, role: "PRACTITIONER", status: "active" });
  });
});

describe("change role and remove", () => {
  it("the owner changes a role, audited; the member's old forms stop working", async () => {
    await withStaff();
    const id = (await memberRow(STAFF))!.id;
    const staffTokenBefore = await tokenFor(STAFF, "any-form");
    const res = await post("/app/settings/team/role", { member: String(id), role: "PRACTITIONER", csrf: await tokenFor(OWNER, `team-role:${id}`) });
    expect(res.headers.get("Location")).toBe("/app/settings/team?m=role");
    expect((await memberRow(STAFF))!.role).toBe("PRACTITIONER");
    expect(await tokenFor(STAFF, "any-form")).not.toBe(staffTokenBefore); // tokens name the role
    expect(await audits("member_role_changed")).toEqual([{ actor: OWNER, memberId: (await memberRow(OWNER))!.id, ws: 1, target: `member:${id}`, detail: "STAFF -> PRACTITIONER" }]);
    const tabs = await (await get("/app", STAFF)).text();
    expect(tabs).not.toContain('href="/app/inbox"');
  });

  it("a member removed while signed in gets No access on the next page, and their open forms are refused", async () => {
    await withStaff();
    expect((await get("/app", STAFF)).status).toBe(200);
    const openForm = await tokenFor(STAFF, "team-invite");
    const id = (await memberRow(STAFF))!.id;
    const res = await post("/app/settings/team/remove", { member: String(id), csrf: await tokenFor(OWNER, `team-remove:${id}`) });
    expect(res.headers.get("Location")).toBe("/app/settings/team?m=removed");
    const next = await get("/app", STAFF);
    expect(next.status).toBe(403);
    expect(await next.text()).toContain("No access");
    const sent = await post("/app/settings/team/invite", { csrf: openForm, email: "x@example.test", role: "STAFF" }, STAFF);
    expect(sent.status).toBe(403);
    expect(await sent.text()).toContain("No access");
    expect(await audits("member_removed")).toHaveLength(1);
    expect(await (await get("/app/settings/team")).text()).not.toContain(STAFF);
  });

  it("an old owner's open team forms are refused after a hand-over", async () => {
    await withStaff();
    const staffId = (await memberRow(STAFF))!.id;
    const pracId = (await memberRow(PRAC))!.id;
    const page = await (await get("/app/settings/team")).text();
    const removeForm = new RegExp(`action="/app/settings/team/remove"><input type="hidden" name="member" value="${staffId}"><input type="hidden" name="csrf" value="([0-9a-f]+)"`).exec(page)![1];
    await post("/app/settings/team/transfer", { member: String(pracId), csrf: await tokenFor(OWNER, `team-transfer:${pracId}`) });
    expect((await post("/app/settings/team/remove", { member: String(staffId), csrf: removeForm })).status).toBe(403);
    expect((await memberRow(STAFF))!.status).toBe("active");
  });
});

describe("exactly one owner", () => {
  it("the database refuses a second owner", async () => {
    await get("/app");
    await expect(db.prepare("INSERT INTO members (workspace_id, email, role, status) VALUES (1, 'two@example.test', 'OWNER', 'active')").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE members SET role = 'OWNER' WHERE email = ?1").bind(PRAC).run()).rejects.toThrow();
  });

  it("the owner can't remove or demote themselves, and nobody can remove or demote the owner", async () => {
    await withStaff();
    const ownerId = (await memberRow(OWNER))!.id;
    const remove = await post("/app/settings/team/remove", { member: String(ownerId), csrf: await tokenFor(OWNER, `team-remove:${ownerId}`) });
    expect(remove.headers.get("Location")).toBe("/app/settings/team?m=self");
    const role = await post("/app/settings/team/role", { member: String(ownerId), role: "STAFF", csrf: await tokenFor(OWNER, `team-role:${ownerId}`) });
    expect(role.headers.get("Location")).toBe("/app/settings/team?m=self");
    expect((await memberRow(OWNER))!).toMatchObject({ role: "OWNER", status: "active" });
    // The owner's own card has no forms.
    const page = await (await get("/app/settings/team")).text();
    expect(page).not.toContain(`name="member" value="${ownerId}"`);
    expect(page).toContain(`name="member" value="${(await memberRow(STAFF))!.id}"`);
  });

  it("hands ownership over: one owner after, the old owner becomes Staff, audited", async () => {
    await withStaff();
    const ownerId = (await memberRow(OWNER))!.id;
    const staffId = (await memberRow(STAFF))!.id;
    const res = await post("/app/settings/team/transfer", { member: String(staffId), csrf: await tokenFor(OWNER, `team-transfer:${staffId}`) });
    expect(res.headers.get("Location")).toBe("/app?m=transferred");
    expect(await (await get("/app?m=transferred", OWNER)).text()).toContain("Ownership handed over");
    expect((await roles()).filter((r) => r.role === "OWNER")).toEqual([{ email: STAFF, role: "OWNER", status: "active" }]);
    expect((await memberRow(OWNER))!.role).toBe("STAFF");
    expect(await audits("ownership_transferred")).toEqual([{ actor: OWNER, memberId: ownerId, ws: 1, target: `member:${staffId}`, detail: `from member:${ownerId}` }]);
    expect((await get("/app/settings/team", OWNER)).status).toBe(403);
    expect((await get("/app/settings/team", STAFF)).status).toBe(200);
    // The same hand-over sent twice changes nothing more.
    await post("/app/settings/team/transfer", { member: String(staffId), csrf: await tokenFor(OWNER, `team-transfer:${staffId}`) });
    expect((await roles()).filter((r) => r.role === "OWNER")).toHaveLength(1);
  });

  it("can't hand over to someone who hasn't accepted yet, or who has left", async () => {
    await get("/app");
    await invite(STAFF);
    const id = (await memberRow(STAFF))!.id;
    const res = await post("/app/settings/team/transfer", { member: String(id), csrf: await tokenFor(OWNER, `team-transfer:${id}`) });
    expect(res.headers.get("Location")).toBe("/app/settings/team?m=gone");
    expect((await memberRow(OWNER))!.role).toBe("OWNER");
    expect(await audits("ownership_transferred")).toHaveLength(0);
    expect(await (await get("/app/settings/team")).text()).not.toContain("/app/settings/team/transfer\"><input type=\"hidden\" name=\"member\" value=\"" + id);
  });
});

describe("migration 0010", () => {
  it("keeps every row, adds workspace 1, and old audit rows have no member (before roles)", async () => {
    const old = await newDb(9);
    try {
      const o = old.db;
      await o.prepare("INSERT INTO conversations (wa_id) VALUES ('910000000002')").run();
      await o.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('CALL', '2026-10-05T08:30:00Z', '2026-10-05T08:45:00Z', 1, 'BOOKED')").run();
      await o.prepare("INSERT INTO intros (conversation_id, slot_id, service, state) VALUES (1, 1, 'HEALING', 'PAID')").run();
      await o.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES ('old@example.test', 'reveal', 'conv:1', '')").run();
      await applySql(o, migrations.membersSql);
      expect(await o.prepare("SELECT id, slug, time_zone, status FROM workspaces").all().then((r) => r.results)).toEqual([{ id: 1, slug: "main", time_zone: "Asia/Kolkata", status: "active" }]);
      expect(await o.prepare("SELECT state, practitioner_id FROM slots").first()).toEqual({ state: "BOOKED", practitioner_id: null });
      expect(await o.prepare("SELECT state, practitioner_id FROM intros").first()).toEqual({ state: "PAID", practitioner_id: null });
      expect(await o.prepare("SELECT actor, member_id, workspace_id, reason FROM audit_log").first()).toEqual({ actor: "old@example.test", member_id: null, workspace_id: null, reason: null });
      await expect(o.prepare("INSERT INTO members (workspace_id, email, role) VALUES (1, 'a@example.test', 'ADMIN')").run()).rejects.toThrow();
      await expect(o.prepare("INSERT INTO requests (workspace_id, kind, target, asked_by) VALUES (1, 'GIFT', 'x', 1)").run()).rejects.toThrow();
    } finally {
      await old.close();
    }
  });
});
