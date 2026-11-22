// Ticket 50: the CARD test's numbers on Today (owner only) and in the 9 pm summary, while the test runs. Counts only; nothing when nobody
// has tried CARD in the last 14 days. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardTestLine } from "../src/cardtest";
import { digestText } from "../src/report";
import { ConsoleHarness, OWNER, PRAC } from "./console-env";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());

async function person(wa: string): Promise<number> {
  await h.db.prepare("INSERT INTO conversations (wa_id) VALUES (?1)").bind(wa).run();
  return (await h.db.prepare("SELECT id FROM conversations WHERE wa_id = ?1").bind(wa).first<{ id: number }>())!.id;
}
const draw = (id: number, day: string, at: string) =>
  h.db.prepare("INSERT INTO card_draws (conversation_id, day, theme, c1, c2, c3, created_at) VALUES (?1, ?2, 'WORK', 1, 2, 3, ?3)").bind(id, day, at).run();

describe("the line", () => {
  it("is null before anyone has tried CARD, and when the draws are older than 14 days", async () => {
    expect(await cardTestLine(h.db, "en", NOW)).toBeNull();
    const a = await person("919000000001");
    await draw(a, "2026-11-01", "2026-11-01T05:00:00Z");
    expect(await cardTestLine(h.db, "en", NOW)).toBeNull();
  });
  it("counts people, 3+ days and paid ₹99 calls from them, in English and Hindi", async () => {
    const a = await person("919000000001");
    const b = await person("919000000002");
    for (const d of ["20", "21", "22"]) await draw(a, `2026-11-${d}`, `2026-11-${d}T05:00:00Z`);
    await draw(b, "2026-11-22", "2026-11-22T05:00:00Z");
    await h.db.prepare("INSERT INTO intros (conversation_id, service, state, created_at) VALUES (?1, 'HEALING', 'PAID', '2026-11-22T06:00:00Z')").bind(a).run();
    expect(await cardTestLine(h.db, "en", NOW)).toBe("CARD test (last 14 days): 2 tried it, 1 on 3+ days, 1 paid ₹99 calls from them (all paid ₹99 calls: 1). Pass bar: 5.");
    expect(await cardTestLine(h.db, "hi", NOW)).toContain("2 लोगों ने आज़माया");
  });
});

describe("where it shows", () => {
  it("in the 9 pm summary only while the test has draws, and Today shows it to the owner only", async () => {
    expect(await digestText(h.env() as never, NOW)).not.toContain("CARD test");
    const a = await person("919000000001");
    await draw(a, "2026-11-23", "2026-11-23T05:00:00Z");
    expect(await digestText(h.env() as never, NOW)).toContain("CARD test (last 14 days): 1 tried it");
    const owner = await (await h.get("/app", OWNER)).text();
    expect(owner).toContain("CARD test (last 14 days)");
    const prac = await (await h.get("/app", PRAC)).text();
    expect(prac).not.toContain("CARD test");
  });
  it("shows no phone number or name", async () => {
    const a = await person("919000000001");
    await draw(a, "2026-11-23", "2026-11-23T05:00:00Z");
    expect(await cardTestLine(h.db, "en", NOW)).not.toMatch(/\d{6,}/);
  });
});
