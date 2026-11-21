// Ticket 51: the package tracker on People: "Has a package" shows each person's sessions left and last session; "Package, not booked" lists
// people with sessions left, nothing booked ahead and nothing for 14 days. Rights are People's own. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHarness, OWNER, PRAC } from "./console-env";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const DAY = 86_400_000;
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 19) + "Z";
let slotN = 0;

// A person with a paid package of `size` bought `bought` days ago and a session per entry of `sessionDays` (days ago; negative: ahead).
async function pack(name: string, wa: string, size: number, bought: number, sessionDays: number[]) {
  await h.db.prepare("INSERT INTO conversations (wa_id, display_name, last_user_at) VALUES (?1, ?2, ?3)").bind(wa, name, at(1)).run();
  const cid = (await h.db.prepare("SELECT id FROM conversations WHERE wa_id = ?1").bind(wa).first<{ id: number }>())!.id;
  await h.db.prepare("INSERT INTO packages (conversation_id, size, price_paise, state, created_at) VALUES (?1, ?2, ?3, 'PAID', ?4)").bind(cid, size, size * 50000, at(bought)).run();
  const pid = (await h.db.prepare("SELECT id FROM packages WHERE conversation_id = ?1").bind(cid).first<{ id: number }>())!.id;
  await h.db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, ?2, 'PURCHASE', ?3, 'test')").bind(pid, size, at(bought)).run();
  for (const d of sessionDays) {
    const start = new Date(NOW - d * DAY + ++slotN * 60_000).toISOString().slice(0, 19) + "Z";
    const end = new Date(Date.parse(start) + 3_600_000).toISOString().slice(0, 19) + "Z";
    await h.db.prepare("INSERT INTO slots (kind, start_utc, end_utc, owner_id, state) VALUES ('SESSION', ?1, ?2, ?3, 'BOOKED')").bind(start, end, cid).run();
    const sid = (await h.db.prepare("SELECT id FROM slots WHERE kind = 'SESSION' AND start_utc = ?1").bind(start).first<{ id: number }>())!.id;
    await h.db.prepare("INSERT INTO sessions (conversation_id, slot_id, service, state) VALUES (?1, ?2, 'HEALING', ?3)").bind(cid, sid, d >= 0 ? "COMPLETED" : "CONFIRMED").run();
    const sess = (await h.db.prepare("SELECT id FROM sessions WHERE slot_id = ?1").bind(sid).first<{ id: number }>())!.id;
    await h.db.prepare("INSERT INTO credits (package_id, delta, reason, session_id, at, by) VALUES (?1, -1, 'BOOK', ?2, ?3, 'test')").bind(pid, sess, at(Math.max(d, 0))).run();
  }
}

async function seed() {
  await pack("Anita Idle", "919000000001", 10, 20, [19, 18]); // 8 left, last 18 days ago: idle
  await pack("Bala Active", "919000000002", 10, 20, [10, 3]); // last 3 days ago: not idle
  await pack("Chitra Never", "919000000003", 10, 20, []); // bought 20 days ago, nothing: idle
  await pack("Deepak Ahead", "919000000004", 10, 20, [19, -1]); // a session tomorrow: not idle
  await pack("Esha New", "919000000005", 10, 3, []); // bought 3 days ago: not idle
  await pack("Farid Done", "919000000006", 2, 30, [29, 28]); // none left: not idle
}
const page = async (f: string, as = OWNER) => (await h.get(`/app/people?f=${f}`, as)).text();

describe("the package tracker", () => {
  it("'Has a package' shows sessions left and the last session", async () => {
    await seed();
    const t = await page("package");
    expect(t).toContain("8 of 10 left");
    expect(t).toContain("last session");
    expect(t).toContain("no session booked yet");
    expect(t).toContain("Anita");
    expect(t).toContain("Farid");
  });
  it("'Package, not booked' lists only people with sessions left, none ahead and 14+ days of nothing", async () => {
    await seed();
    const t = await page("packageIdle");
    expect(t).toContain("Anita");
    expect(t).toContain("Chitra");
    for (const n of ["Bala", "Deepak", "Esha", "Farid"]) expect(t, n).not.toContain(n);
  });
  it("is empty with a plain line when nobody is idle", async () => {
    await pack("Bala", "919000000002", 10, 20, [3]);
    expect(await page("packageIdle")).not.toContain("Bala");
  });
  it("a practitioner sees only her own customers (none here: no booking with her)", async () => {
    await seed();
    const t = await page("package", PRAC);
    expect(t).not.toContain("Anita");
  });
  it("other filters show no package words", async () => {
    await seed();
    expect(await page("all")).not.toContain("of 10 left");
  });
});
