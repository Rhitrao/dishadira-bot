import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import app from "../src/index";
import { bookingChoice } from "../src/booking";
import { applyDueOutcomes } from "../src/outcomes";
import { razorpay } from "../src/pay/razorpay";
import { generateSlots } from "../src/slots";
import { addPerson, newDb } from "./db";

// All data is synthetic. Mon 2026-10-05, 15:30 IST (calls at 14:00-15:15 have started). Real Access is never called: the JWKS fetch is mocked.
const NOW = Date.parse("2026-10-05T10:00:00Z");
const ORIGIN = "https://bot.example.test";
const AUD = "test-aud";
const TEAM = "testteam";
const AMMA = "amma@example.test";
const ROHIT = "rohit@example.test";
let db: D1Database;
let close: () => Promise<void>;
let priv: CryptoKey;
let jwks: { keys: unknown[] };

const env = () =>
  ({ DB: db, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, AMMA_EMAIL: AMMA, ROHIT_EMAIL: ROHIT, NEW_BOOKINGS: "true", SENDS: "false" }) as never;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});
beforeEach(async () => {
  session = undefined;
  ({ db, close } = await newDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (u: string) => (String(u).includes("/cdn-cgi/access/certs") ? new Response(JSON.stringify(jwks)) : new Response("{}", { status: 404 }))));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await close?.();
});

const token = (o: { email?: string; aud?: string; iss?: string; key?: CryptoKey } = {}) =>
  new SignJWT({ email: o.email ?? AMMA })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? `https://${TEAM}.cloudflareaccess.com`)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(o.key ?? priv);
// One token per test, like a real Access session (the CSRF token is tied to it).
let session: string | undefined;
const asAmma = async (): Promise<Record<string, string>> => ({ "Cf-Access-Jwt-Assertion": (session ??= await token()) });
const get = async (path: string, headers?: Record<string, string>) => app.request(ORIGIN + path, { headers: headers ?? (await asAmma()) }, env());
const post = async (path: string, form: Record<string, string>, o: { origin?: string | null } = {}) => {
  const headers = { ...(await asAmma()), "Content-Type": "application/x-www-form-urlencoded" } as Record<string, string>;
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  return app.request(ORIGIN + path, { method: "POST", headers, body: new URLSearchParams(form).toString() }, env());
};
const hidden = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)![1];

// A booked, paid call (or a confirmed session) for a synthetic person.
let wa = 919000000000;
async function booking(ymd: string, i: number, name: string, o: { kind?: "CALL" | "SESSION"; state?: string; service?: string } = {}) {
  const kind = o.kind ?? "CALL";
  const conv = await addPerson(db, String(++wa));
  await db.prepare("UPDATE conversations SET display_name = ?2 WHERE id = ?1").bind(conv, name).run();
  const s = generateSlots(ymd, kind)[i];
  const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES (?1,?2,?3,?4,'BOOKED')").bind(kind, s.startUtc, s.endUtc, conv).run();
  const service = o.service ?? "PROTECTION";
  if (kind === "SESSION") await db.prepare("INSERT INTO sessions (conversation_id,slot_id,service,state) VALUES (?1,?2,?3,'CONFIRMED')").bind(conv, slot.meta.last_row_id, service).run();
  else await db.prepare("INSERT INTO intros (conversation_id,slot_id,service,state) VALUES (?1,?2,?3,?4)").bind(conv, slot.meta.last_row_id, service, o.state ?? "PAID").run();
  const introId = kind === "CALL" ? (await db.prepare("SELECT max(id) AS n FROM intros").first<{ n: number }>())!.n : 0;
  return { conv, introId };
}
const outcomeCount = async () => (await db.prepare("SELECT count(*) AS n FROM outcomes").first<{ n: number }>())!.n;

// Taps an outcome on the page and confirms with Yes.
async function confirm(introId: number, v = "NOT_FIT") {
  const page = await (await get(`/amma/confirm?intro=${introId}&v=${v}`)).text();
  return post("/amma/outcome", { intro: String(introId), v, csrf: hidden(page, "csrf") });
}

describe("access", () => {
  it("no JWT -> 403", async () => {
    expect((await app.request(ORIGIN + "/amma", {}, env())).status).toBe(403);
  });
  it("wrong audience, wrong issuer, wrong key, wrong email -> 403", async () => {
    const other = (await generateKeyPair("RS256")).privateKey;
    for (const t of [await token({ aud: "other" }), await token({ iss: "https://evil.example" }), await token({ key: other }), await token({ email: "x@example.test" })]) {
      expect((await get("/amma", { "Cf-Access-Jwt-Assertion": t })).status).toBe(403);
    }
  });
  it("empty placeholders fail closed", async () => {
    const res = await app.request(ORIGIN + "/amma", { headers: await asAmma() }, { ...(env() as object), AMMA_EMAIL: "", ROHIT_EMAIL: "" } as never);
    expect(res.status).toBe(403);
  });
  it("Amma and Rohit get 200, uncached", async () => {
    for (const email of [AMMA, ROHIT]) {
      const res = await get("/amma", { "Cf-Access-Jwt-Assertion": await token({ email }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("page", () => {
  it("shows today's and tomorrow's bookings only, with first name, service, kind and tel link", async () => {
    await booking("2026-10-05", 0, "Priya Sharma", { service: "HEALING" });
    await booking("2026-10-06", 1, "Anita Rao", { kind: "SESSION" });
    await booking("2026-10-07", 0, "Dayafter Person");
    await booking("2026-10-05", 2, "Unpaid Person", { state: "HELD" });
    const res = await get("/amma");
    const page = await res.text();
    expect(page).toContain("Priya");
    expect(page).toContain("Anita");
    expect(page).toContain("Healing");
    expect(page).toContain("Call ₹99");
    expect(page).toContain("Session ₹799 · single");
    expect(page).toContain('href="tel:+919000000001"');
    expect(page).not.toContain("Sharma");
    expect(page).not.toContain("Dayafter");
    expect(page).not.toContain("Unpaid");
    expect(page.indexOf("Today")).toBeLessThan(page.indexOf("Priya"));
    expect(page.indexOf("Priya")).toBeLessThan(page.indexOf("Tomorrow"));
    expect(page.indexOf("Tomorrow")).toBeLessThan(page.indexOf("Anita"));
    expect(page).toContain('name="viewport"');
    expect(page).toMatch(/font:[^;]*20px/);
    expect(page).toMatch(/min-height:56px/);
    expect(page).not.toContain("<script");
  });
  it("shows the call language and who it is for next to each name; the service has the customer-facing name", async () => {
    const hindi = await booking("2026-10-05", 0, "Priya");
    await db.prepare("UPDATE conversations SET locale = 'hi' WHERE id = ?1").bind(hindi.conv).run();
    await db.prepare("UPDATE intros SET call_lang = 'hi', for_whom = 'FAMILY' WHERE id = ?1").bind(hindi.introId).run();
    const english = await booking("2026-10-05", 2, "Anita");
    await db.prepare("UPDATE intros SET call_lang = 'en', for_whom = 'PET' WHERE id = ?1").bind(english.introId).run();
    const legacy = await booking("2026-10-05", 4, "Meera"); // booked before the new steps: no who-for, language from the chat
    await db.prepare("UPDATE conversations SET locale = 'hi' WHERE id = ?1").bind(legacy.conv).run();
    const page = await (await get("/amma")).text();
    expect(page).toContain("· Priya · Hindi · family<");
    expect(page).toContain("· Anita · English · pet<");
    expect(page).toContain("· Meera · Hindi<");
    expect(page).toContain("Energy cleansing"); // PROTECTION as customers know it
    expect(page).not.toContain("Protection");
    expect(page).not.toMatch(/[\u0900-\u097F]/); // Amma's page stays English
  });
  it("a confirmed session shows the language and who-for of the call before it", async () => {
    const { conv, introId } = await booking("2026-10-05", 0, "Priya");
    await db.prepare("UPDATE intros SET call_lang = 'hi', for_whom = 'SELF' WHERE id = ?1").bind(introId).run();
    const s = generateSlots("2026-10-05", "SESSION")[3];
    const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
    await db.prepare("INSERT INTO sessions (conversation_id,intro_id,slot_id,service,state) VALUES (?1,?2,?3,'HEALING','CONFIRMED')").bind(conv, introId, slot.meta.last_row_id).run();
    const page = await (await get("/amma")).text();
    expect(page.match(/Priya · Hindi · self/g)).toHaveLength(2); // the call and the session
  });
  it("never shows chat text or health details", async () => {
    const { conv } = await booking("2026-10-05", 0, "Priya");
    await db.prepare("INSERT INTO messages (conversation_id,direction,kind,body,status) VALUES (?1,'IN','text','my knee hurts, diagnosis cancer','RECEIVED')").bind(conv).run();
    const page = await (await get("/amma")).text();
    expect(page).not.toMatch(/knee|diagnosis|cancer|hurts/);
  });
  it("escapes names", async () => {
    await booking("2026-10-05", 0, "<script>alert(1)</script>");
    const page = await (await get("/amma")).text();
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;");
  });
});

describe("page layout", () => {
  it("has the date header, a Refresh button and empty-day messages", async () => {
    const page = await (await get("/amma")).text();
    expect(page).toContain("Today · Mon 5 Oct");
    expect(page).toContain("Tomorrow · Tue 6 Oct");
    expect(page).toMatch(/<a class="btn go refresh" href="\/amma">Refresh<\/a>/);
    expect(page).toContain("No calls today");
    expect(page).toContain("No calls tomorrow");
    await booking("2026-10-05", 0, "Priya");
    const busy = await (await get("/amma")).text();
    expect(busy).not.toContain("No calls today");
    expect(busy).toContain("No calls tomorrow");
  });
  it("before the start time only the Call button shows; tomorrow never has outcome buttons", async () => {
    const { introId } = await booking("2026-10-05", 8, "Later"); // 16:00 IST, not started
    await booking("2026-10-06", 0, "Tomorrow");
    const page = await (await get("/amma")).text();
    expect(page).toContain("Later");
    expect(page).toContain("Tomorrow");
    expect(page).not.toMatch(/How did it go|Not right fit|Missed|Report rude|\/amma\/confirm/);
    expect((await get(`/amma/confirm?intro=${introId}&v=MISSED`)).status).toBe(409);
    expect(await outcomeCount()).toBe(0);
  });
  it("after the start time: 'How did it go?' above the three buttons, Report rude separate, red and smaller", async () => {
    await booking("2026-10-05", 0, "Priya");
    const page = await (await get("/amma")).text();
    const at = (x: string) => page.indexOf(x, page.indexOf('class="row"'));
    expect(at("How did it go?")).toBeGreaterThan(0);
    expect(at("How did it go?")).toBeLessThan(at(">Session<"));
    expect(at(">Session<")).toBeLessThan(at(">Not right fit<"));
    expect(at(">Not right fit<")).toBeLessThan(at(">Missed<"));
    expect(at(">Missed<")).toBeLessThan(at("Report rude"));
    expect(page).toMatch(/\.rude\{margin-top:40px\}\.rude a\.btn\{[^}]*font-size:18px[^}]*color:#b00000/);
    expect(page).toMatch(/<div class="rude"><a [^>]*>Report rude<\/a><\/div>/);
  });
  it("an outcome POST for a call that has not started is refused", async () => {
    const { introId } = await booking("2026-10-05", 8, "Later");
    const res = await post("/amma/outcome", { intro: String(introId), v: "MISSED", csrf: "x" });
    expect(res.status).toBe(403); // no valid token can exist: the confirm screen is refused
    expect(await outcomeCount()).toBe(0);
  });
});

describe("audit", () => {
  const audits = async () => (await db.prepare("SELECT actor, action, target, detail FROM audit_log ORDER BY id").all()).results;
  it("records who tapped each outcome and each undo", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const saved = await (await confirm(introId, "MISSED")).text();
    expect(await audits()).toEqual([{ actor: AMMA, action: "AMMA_OUTCOME", target: `intro:${introId}`, detail: "MISSED" }]);
    await post("/amma/undo", { outcome: hidden(saved, "outcome"), csrf: hidden(saved, "csrf") });
    expect(await audits()).toHaveLength(2);
    expect((await audits())[1]).toEqual({ actor: AMMA, action: "AMMA_UNDO", target: `intro:${introId}`, detail: "MISSED" });
  });
  it("a refused undo or a refused second outcome is not logged as a change", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const saved = await (await confirm(introId)).text();
    await confirm(introId, "SESSION"); // refused
    vi.setSystemTime(NOW + 11 * 60_000);
    await post("/amma/undo", { outcome: hidden(saved, "outcome"), csrf: hidden(saved, "csrf") }); // too late
    expect(await audits()).toHaveLength(1);
  });
});

describe("outcomes", () => {
  it("a tap only opens a confirm screen; nothing is saved until Yes", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const res = await get(`/amma/confirm?intro=${introId}&v=NOT_FIT`);
    expect(await res.text()).toContain("Confirm: Not right fit for Priya, 2:00pm?");
    expect(await outcomeCount()).toBe(0);
    const page = await (await get("/amma")).text();
    expect(page).toContain("Not right fit");
    expect(page).toContain("Missed");
    expect(page).toContain("Report rude");
  });
  it("Yes records the outcome with a 10-minute undo and applies no effects", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const res = await confirm(introId);
    expect(await res.text()).toContain("Saved. Undo (10 min)");
    const o = (await db.prepare("SELECT * FROM outcomes").first<{ value: string; tapped_at: string; undo_until: string; applied_at: string | null }>())!;
    expect(o.value).toBe("NOT_FIT");
    expect(Date.parse(o.undo_until) - Date.parse(o.tapped_at)).toBe(10 * 60_000);
    expect(o.applied_at).toBeNull();
    expect((await db.prepare("SELECT state FROM intros WHERE id = ?1").bind(introId).first<{ state: string }>())!.state).toBe("PAID");
    expect((await db.prepare("SELECT count(*) AS n FROM refunds").first<{ n: number }>())!.n).toBe(0);
  });
  it("undo works within 10 minutes", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const saved = await (await confirm(introId)).text();
    vi.setSystemTime(NOW + 9 * 60_000);
    const res = await post("/amma/undo", { outcome: hidden(saved, "outcome"), csrf: hidden(saved, "csrf") });
    expect(res.status).toBe(200);
    expect(await outcomeCount()).toBe(0);
  });
  it("undo is refused after 10 minutes", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const saved = await (await confirm(introId)).text();
    vi.setSystemTime(NOW + 10 * 60_000 + 1000);
    const res = await post("/amma/undo", { outcome: hidden(saved, "outcome"), csrf: hidden(saved, "csrf") });
    expect(res.status).toBe(409);
    expect(await outcomeCount()).toBe(1);
  });
  it("a second outcome on the same call is refused politely", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    expect((await confirm(introId, "MISSED")).status).toBe(200);
    const again = await confirm(introId, "SESSION");
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already has an answer");
    expect(await outcomeCount()).toBe(1);
  });
  it("Report rude goes through the same confirm", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    expect((await confirm(introId, "RUDE")).status).toBe(200);
    expect((await db.prepare("SELECT value FROM outcomes").first<{ value: string }>())!.value).toBe("RUDE");
  });
});

describe("safety", () => {
  it("missing or wrong CSRF token -> 403, nothing saved", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    expect((await post("/amma/outcome", { intro: String(introId), v: "MISSED" })).status).toBe(403);
    expect((await post("/amma/outcome", { intro: String(introId), v: "MISSED", csrf: "nope" })).status).toBe(403);
    // a token made for another outcome value does not work
    const page = await (await get(`/amma/confirm?intro=${introId}&v=SESSION`)).text();
    expect((await post("/amma/outcome", { intro: String(introId), v: "MISSED", csrf: hidden(page, "csrf") })).status).toBe(403);
    expect(await outcomeCount()).toBe(0);
  });
  it("missing or foreign Origin -> 403", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    const page = await (await get(`/amma/confirm?intro=${introId}&v=MISSED`)).text();
    const form = { intro: String(introId), v: "MISSED", csrf: hidden(page, "csrf") };
    expect((await post("/amma/outcome", form, { origin: null })).status).toBe(403);
    expect((await post("/amma/outcome", form, { origin: "https://evil.example" })).status).toBe(403);
    expect(await outcomeCount()).toBe(0);
  });
  it("changes are POST-only", async () => {
    const { introId } = await booking("2026-10-05", 0, "Priya");
    expect((await get(`/amma/outcome?intro=${introId}&v=MISSED`)).status).toBe(404);
    expect(await outcomeCount()).toBe(0);
  });
});

describe("one open intro per person", () => {
  const run = async (conv: number, i: number) => {
    await db.prepare("UPDATE conversations SET last_user_at = '2026-10-05T10:00:00Z' WHERE id = ?1").bind(conv).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await bookingChoice({ ...(env() as object), SENDS: "true", WA_TOKEN: "t", WA_PHONE_ID: "1" } as never, `slot_PROTECTION_${generateSlots("2026-10-05", "CALL")[i].startUtc}`, conv, `m${i}${conv}`);
  };
  it("a person with a PAID intro cannot book another; they are told when it is", async () => {
    const { conv } = await booking("2026-10-05", 3, "Priya");
    await run(conv, 6);
    expect((await db.prepare("SELECT count(*) AS n FROM intros").first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT count(*) AS n FROM payments").first<{ n: number }>())!.n).toBe(0);
    const m = await db.prepare("SELECT body FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1").first<{ body: string }>();
    expect(m?.body ?? "").toContain("already booked for Mon, 5 Oct at 2:45 pm");
  });
  it("a person with a live HELD intro is told the same, and no new hold is made", async () => {
    const { conv } = await booking("2026-10-05", 3, "Priya", { state: "HELD" });
    await db.prepare("UPDATE slots SET state = 'HELD', hold_until = ?1").bind(new Date(NOW + 600_000).toISOString().slice(0, 19) + "Z").run();
    await run(conv, 6);
    expect((await db.prepare("SELECT count(*) AS n FROM slots").first<{ n: number }>())!.n).toBe(1);
    const m = await db.prepare("SELECT body FROM messages WHERE direction = 'OUT' ORDER BY id DESC LIMIT 1").first<{ body: string }>();
    expect(m?.body ?? "").toContain("already booked");
  });
});

describe("after the outcome is applied", () => {
  it('the row shows "Done: <outcome>" and no buttons', async () => {
    const a = await booking("2026-10-05", 0, "Test Person");
    expect((await confirm(a.introId, "SESSION")).status).toBe(200);
    expect(await (await get("/amma")).text()).toContain("Undo");
    vi.setSystemTime(NOW + 11 * 60_000);
    await applyDueOutcomes(env(), razorpay(env()));
    const page = await (await get("/amma")).text();
    expect(page).toContain("Done: Session");
    expect(page).not.toContain("Undo");
    expect(page).not.toContain("/amma/confirm");
  });
});

// ---- sessions bought from the menu (ticket 13): single or package, and "Not right fit" on a buyer's very first session ----
describe("sessions bought from the menu", () => {
  async function bought(ymd: string, i: number, name: string, o: { origin: "SELF" | "CREDIT"; size?: number; booked?: number; intro?: boolean }) {
    const conv = await addPerson(db, String(++wa));
    await db.prepare("UPDATE conversations SET display_name = ?2 WHERE id = ?1").bind(conv, name).run();
    const s = generateSlots(ymd, "SESSION")[i];
    const slot = await db.prepare("INSERT INTO slots (kind,start_utc,end_utc,owner_id,state) VALUES ('SESSION',?1,?2,?3,'BOOKED')").bind(s.startUtc, s.endUtc, conv).run();
    let pkg: number | null = null;
    if (o.origin === "CREDIT") {
      pkg = (await db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state) VALUES (?1, ?2, 500000, 'PAID')").bind(conv, o.size ?? 10).run()).meta.last_row_id;
      // earlier sessions of the same package, then this one: "package 3/10" when two came before
      for (let k = 0; k < (o.booked ?? 0); k++) {
        const e = await db.prepare("INSERT INTO sessions (conversation_id, service, state, origin, package_id) VALUES (?1,'HEALING','COMPLETED','CREDIT',?2)").bind(conv, pkg).run();
        await db.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (?1,-1,'BOOK',?2,'x','c')").bind(pkg, e.meta.last_row_id).run();
      }
    }
    if (o.intro) await db.prepare("INSERT INTO intros (conversation_id, service, state) VALUES (?1,'HEALING','CALLED_SESSION')").bind(conv).run();
    const ses = await db
      .prepare("INSERT INTO sessions (conversation_id, slot_id, service, state, origin, package_id, for_whom, call_lang) VALUES (?1,?2,'HEALING',?3,?4,?5,'FAMILY','hi')")
      .bind(conv, slot.meta.last_row_id, o.origin === "CREDIT" ? "CREDIT_BOOKED" : "CONFIRMED", o.origin, pkg)
      .run();
    if (pkg) await db.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (?1,-1,'BOOK',?2,'x','c')").bind(pkg, ses.meta.last_row_id).run();
    return { conv, sid: ses.meta.last_row_id as number };
  }
  const confirmSession = async (sid: number, v = "NOT_FIT") => {
    const page = await (await get(`/amma/confirm?session=${sid}&v=${v}`)).text();
    return post("/amma/outcome", { session: String(sid), v, csrf: hidden(page, "csrf") });
  };

  it("a package session shows 'package 3/10'; a single shows 'single'; the call language and who it is for come from the session", async () => {
    await bought("2026-10-05", 4, "Pack Person", { origin: "CREDIT", size: 10, booked: 2, intro: true });
    await bought("2026-10-05", 3, "Single Person", { origin: "SELF" });
    const page = await (await get("/amma")).text();
    expect(page).toContain("Session · package 3/10");
    expect(page).toContain("Session ₹799 · single");
    expect(page).toContain("Hindi · family");
  });

  it("a buyer's very first session (no 99 call before it) can be answered 'Not right fit' once it has started; nothing else is offered", async () => {
    const { sid } = await bought("2026-10-05", 0, "First Buyer", { origin: "SELF" }); // 14:00 IST, started
    const page = await (await get("/amma")).text();
    expect(page).toContain(`/amma/confirm?session=${sid}&amp;v=NOT_FIT`);
    expect(page).not.toContain("v=SESSION");
    expect(page).not.toContain("v=RUDE");
    const res = await confirmSession(sid);
    expect(res.status).toBe(200);
    expect(await db.prepare("SELECT value, session_id AS sid, intro_id AS iid FROM outcomes").first()).toEqual({ value: "NOT_FIT", sid, iid: null });
    expect(await db.prepare("SELECT target, detail FROM audit_log WHERE action = 'AMMA_OUTCOME'").first()).toEqual({ target: `session:${sid}`, detail: "NOT_FIT" });
    expect((await confirmSession(sid)).status).toBe(409); // one answer
    const after = await (await get("/amma")).text();
    expect(after).toContain("Saved: Not right fit");
    expect(after).toContain("Undo");
  });

  it("the undo window works for a session too: undone, never applied", async () => {
    const { sid } = await bought("2026-10-05", 0, "First Buyer", { origin: "SELF" });
    await confirmSession(sid);
    const oid = (await db.prepare("SELECT id FROM outcomes").first<{ id: number }>())!.id;
    const page = await (await get("/amma")).text();
    const res = await post("/amma/undo", { outcome: String(oid), csrf: hidden(page, "csrf") });
    expect(res.status).toBe(200);
    expect(await outcomeCount()).toBe(0);
    expect(await db.prepare("SELECT action, target FROM audit_log WHERE action = 'AMMA_UNDO'").first()).toEqual({ action: "AMMA_UNDO", target: `session:${sid}` });
  });

  it("no answer is offered for a session after a 99 call, one that has not started, or one Amma offered; a forged or missing token is refused", async () => {
    const afterCall = await bought("2026-10-05", 0, "Had A Call", { origin: "CREDIT", intro: true });
    const future = await bought("2026-10-06", 0, "Future Buyer", { origin: "SELF" });
    await booking("2026-10-05", 1, "Offered Person", { kind: "SESSION" }); // origin AMMA: offered by Amma after a call
    const page = await (await get("/amma")).text();
    expect(page).not.toContain("v=NOT_FIT");
    expect((await get(`/amma/confirm?session=${afterCall.sid}&v=NOT_FIT`)).status).toBe(404); // not a first session
    expect((await get(`/amma/confirm?session=${future.sid}&v=NOT_FIT`)).status).toBe(409); // not started yet
    const first = await bought("2026-10-05", 2, "Real First", { origin: "SELF" });
    expect((await post("/amma/outcome", { session: String(first.sid), v: "NOT_FIT", csrf: "nope" })).status).toBe(403);
    expect((await post("/amma/outcome", { session: String(first.sid), v: "SESSION", csrf: "nope" })).status).toBe(403);
    expect((await app.request(ORIGIN + "/amma/outcome", { method: "POST", body: "session=1" }, env())).status).toBe(403);
    expect(await outcomeCount()).toBe(0);
  });
});
