// Ticket 27: chats read cleanly (Inbox thread and the person page), and every /app page is on the console's look. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHarness, OWNER, PRAC, STAFF } from "./console-env"; // first: it loads the Worker
import { recentMessages } from "../src/ai";
import { collapseWiped, describe as describeLine, type ChatRow } from "../src/chat";

const NOW = Date.parse("2026-10-28T08:00:00Z"); // Wed, 1:30 pm in Bengaluru
const h = new ConsoleHarness();
const decode = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
const text = async (path: string, as = OWNER) => decode(await (await h.get(path, as)).text());
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString().slice(0, 19) + "Z";

async function person(mode = "HUMAN") {
  return (await h.db.prepare("INSERT INTO conversations (wa_id, display_name, mode, human_since, last_user_at) VALUES ('919800001111', 'Kavya Test', ?1, ?2, ?2)").bind(mode, at(30)).run()).meta.last_row_id;
}
async function msg(conv: number, o: { dir: "IN" | "OUT"; kind: string; body: string | null; wiped?: boolean; minAgo: number; key?: string }) {
  await h.db
    .prepare("INSERT INTO messages (conversation_id, direction, kind, body, status, wiped_at, created_at, dedupe_key, wa_message_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(conv, o.dir, o.kind, o.body, o.dir === "IN" ? "RECEIVED" : "SENT", o.wiped ? at(1) : null, at(o.minAgo), o.dir === "OUT" ? (o.key ?? `k:${Math.random()}`) : null, o.dir === "IN" ? `wamid.${Math.random()}` : null)
    .run();
}
// Twelve old messages whose text the wipe removed, then a fresh exchange with a tap, a template, a photo and buttons.
async function seeded() {
  const conv = await person();
  for (let i = 0; i < 12; i++) await msg(conv, { dir: i % 2 ? "OUT" : "IN", kind: i % 2 ? "buttons" : "text", body: null, wiped: true, minAgo: 12000 - i });
  await msg(conv, { dir: "IN", kind: "text", body: "Hello again", minAgo: 60 });
  await msg(conv, { dir: "OUT", kind: "buttons", body: "What would you like to do?", minAgo: 59 });
  await msg(conv, { dir: "IN", kind: "interactive", body: "Book ₹99 call", minAgo: 58 });
  await msg(conv, { dir: "IN", kind: "interactive", body: null, minAgo: 57 }); // a tap from before labels were stored
  await msg(conv, { dir: "OUT", kind: "template", body: "template:call_booked", minAgo: 56 });
  await msg(conv, { dir: "IN", kind: "image", body: null, minAgo: 55 });
  await msg(conv, { dir: "OUT", kind: "text", body: null, minAgo: 54 }); // a reply skipped for a newer message: never shown
  return conv;
}
const bubbles = (html: string) => html.match(/<div class="bubble [^"]*">[\s\S]*?<\/div>/g) ?? [];

beforeEach(async () => {
  await h.start(NOW);
});
afterEach(async () => {
  await h.stop();
});

describe("a chat line in words", () => {
  const row = (o: Partial<ChatRow>): ChatRow => ({ dir: "IN", kind: "text", body: "hi", wipedAt: null, ...o });
  it("taps, media, templates and buttons are described; nothing is ever blank", () => {
    expect(describeLine(row({ kind: "interactive", body: "Book ₹99 call" }), "en")).toEqual({ text: "Tapped: Book ₹99 call", tap: true });
    expect(describeLine(row({ kind: "button", body: null }), "en").text).toBe("Tapped a button");
    expect(describeLine(row({ kind: "image", body: null }), "en").text).toBe("Sent a photo (not downloaded)");
    expect(describeLine(row({ kind: "reaction", body: null }), "en").text).toBe("Sent something the console can't show");
    expect(describeLine(row({ dir: "OUT", kind: "template", body: "template:reminder" }), "en").text).toBe("Approved WhatsApp message: reminder");
    expect(describeLine(row({ dir: "OUT", kind: "buttons", body: "Pick one" }), "en")).toEqual({ text: "Pick one", note: "Sent with reply buttons" });
    expect(describeLine(row({ kind: "interactive", body: "सेशन" }), "hi").text).toBe("चुना: सेशन");
  });
  it("runs of wiped messages collapse into one item each", () => {
    const w = row({ body: null, wipedAt: "2026-10-01T00:00:00Z" });
    const items = collapseWiped([w, w, w, row({}), w, row({ dir: "OUT", body: null })]);
    expect(items.map((x) => ("wiped" in x ? `w${x.wiped}${x.earlier ? "e" : ""}` : "l"))).toEqual(["w3e", "l", "w2"]);
  });
});

describe("the Inbox thread", () => {
  it("one quiet line for the wiped run, labels for taps, descriptions for the rest, and no empty bubble", async () => {
    const conv = await seeded();
    const page = await text(`/app/inbox/${conv}`);
    expect(page).toContain("12 earlier messages were deleted after 7 days, for privacy");
    expect(page).not.toContain("(message text removed)");
    expect(page).toContain("Tapped: Book ₹99 call");
    expect(page).toContain("Tapped a button");
    expect(page).toContain("Approved WhatsApp message: call booked");
    expect(page).toContain("Sent a photo (not downloaded)");
    expect(page).toContain("Sent with reply buttons");
    expect(bubbles(page)).toHaveLength(6); // the skipped reply is not shown
    for (const b of bubbles(page)) expect(b).not.toMatch(/<\/time><\/p><p><\/p>/);
  });

  it("the actions sit under the header, before the thread; the window state shows once in the detail", async () => {
    const conv = await seeded();
    const page = await text(`/app/inbox/${conv}`);
    const detail = page.slice(page.indexOf('class="ld-detail"'));
    expect(detail.indexOf("Assign to me")).toBeGreaterThan(-1);
    expect(detail.indexOf("Assign to me")).toBeLessThan(detail.indexOf('class="thread"'));
    expect(detail.indexOf('name="text"')).toBeLessThan(detail.indexOf('class="thread"'));
    expect(detail.indexOf("Hand back to the bot")).toBeLessThan(detail.indexOf('class="thread"'));
    // The window closed: said once in the header and once in the list row, never twice in one pane, and never in red.
    await h.db.prepare("UPDATE conversations SET last_user_at = ?2 WHERE id = ?1").bind(conv, at(60 * 30)).run();
    const closed = await text(`/app/inbox/${conv}`);
    const pane = closed.slice(closed.indexOf('class="ld-detail"'));
    const list = closed.slice(closed.indexOf('class="ld-list"'), closed.indexOf('class="ld-detail"'));
    const phrase = "WhatsApp only allows a follow-up message now";
    expect(pane.split(phrase)).toHaveLength(2);
    expect(list.split(phrase)).toHaveLength(2);
    expect(closed).not.toContain(`chip danger">${phrase}`);
  });

  it("shows the latest 20, with a link to the earlier ones", async () => {
    const conv = await person();
    for (let i = 0; i < 25; i++) await msg(conv, { dir: "IN", kind: "text", body: `Message number ${i}`, minAgo: 100 - i });
    const page = await text(`/app/inbox/${conv}`);
    expect(page).toContain("Message number 24");
    expect(page).toContain("Message number 5");
    expect(page).not.toContain("Message number 4<");
    expect(page).toContain(`href="/app/inbox/${conv}?all=1#chat"`);
    expect(page).toContain("Show earlier messages");
    const all = await text(`/app/inbox/${conv}?all=1`);
    expect(all).toContain("Message number 0");
    expect(all).not.toContain("Show earlier messages");
  });
});

describe("the person page chat", () => {
  it("the same treatment: one line for the wiped run and labelled taps", async () => {
    const conv = await seeded();
    const page = await text(`/app/people/${conv}`);
    expect(page).toContain("12 earlier messages were deleted after 7 days, for privacy");
    expect(page).toContain("Tapped: Book ₹99 call");
    expect(page).not.toContain("(text deleted)");
    for (const b of bubbles(page)) expect(b).not.toMatch(/<\/time><\/p><p><\/p>/);
  });
});

describe("taps stay out of the assistant's history", () => {
  it("a stored tap label is never sent to the AI", async () => {
    const conv = await person("BOT");
    await msg(conv, { dir: "IN", kind: "interactive", body: "Book ₹99 call", minAgo: 3 });
    await msg(conv, { dir: "IN", kind: "text", body: "what is healing?", minAgo: 2 });
    const last = (await h.db.prepare("SELECT MAX(id) AS id FROM messages").first<{ id: number }>())!.id;
    expect(await recentMessages(h.db, conv, last)).toEqual([{ role: "user", content: "what is healing?" }]);
  });
});

describe("every /app page on the console's look", () => {
  it("No access, a refusal, an old form and an unknown address all use the console frame and fonts", async () => {
    const stranger = decode(await (await h.get("/app", "nobody@example.test")).text());
    expect(stranger).toContain("No access");
    expect(stranger).toContain('font-family:"Jost"');
    expect(stranger).not.toContain('<nav class="tabs"');
    const refused = await h.get("/app/payments", STAFF);
    expect(refused.status).toBe(403);
    const r = decode(await refused.text());
    expect(r).toContain("Your role can't open this page.");
    expect(r).toContain('<nav class="rail"');
    const old = await h.post("/app/today/handback", { csrf: "stale", conv: "1" }, OWNER);
    expect(old.status).toBe(403);
    expect(decode(await old.text())).toContain("That form has expired");
    const missing = await h.get("/app/nowhere", PRAC);
    expect(missing.status).toBe(404);
    expect(decode(await missing.text())).toContain("There's nothing at this address.");
    const team = await text("/app/settings/team");
    expect(team).toContain('<nav class="rail"');
    expect(team).not.toContain("system-ui,-apple-system");
  });

  it("the seeded business name is never shown; the owner gets one quiet task until it is set", async () => {
    const owner = await text("/app");
    expect(owner).not.toContain("My business");
    expect(owner).toContain("Booking console");
    expect(owner).toContain("Add your business name in Settings");
    expect(owner).toContain('href="/app/settings#business"');
    expect(await text("/app", STAFF)).not.toContain("Add your business name");
    expect(await text("/app", PRAC)).not.toContain("Add your business name");
    await h.db.prepare("UPDATE workspaces SET name = 'Calm Practice' WHERE id = 1").run();
    const named = await text("/app");
    expect(named).toContain("Calm Practice");
    expect(named).not.toContain("Add your business name");
  });
});
