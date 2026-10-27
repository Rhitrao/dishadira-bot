// Ticket 24: Payments (/app/payments), owner only. Problems first, each with its next step; a month's money in, refunded and net;
// sessions owed on packages; a masked CSV export (PRD check 9) that is audited; statuses in words; retrying a failed refund.
// All data is synthetic; Access and Razorpay are fakes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../src/index"; // the Worker first: src/console.ts mounts src/payments.ts, which uses the console's helpers
import { monthOf, monthRange, monthTotals, paymentsCsv, problems } from "../src/payments";
import { ConsoleHarness, OWNER, PRAC, STAFF, paidCustomer } from "./console-env";

const NOW = Date.parse("2026-10-27T08:00:00Z"); // Tue 27 Oct, 1:30 pm India time
const h = new ConsoleHarness();
beforeEach(() => h.start(NOW));
afterEach(() => h.stop());

const decode = (t: string) => t.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const page = async (path = "/app/payments", as = OWNER) => decode(await (await h.get(path, as)).text());
const words = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ");

// Four problems and two good payments, all synthetic numbers.
async function seed() {
  const failed = await paidCustomer(h.db, { waId: "919800001111", name: "Asha Failed", state: "REFUND_FAILED", at: "2026-10-10T05:00:00Z" });
  await h.db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state, created_at) VALUES (?1, 'NOT_FIT', 'system', 'FAILED', '2026-10-10T06:00:00Z')").bind(failed.pay).run();
  const slow = await paidCustomer(h.db, { waId: "919800002222", name: "Bina Slow", purpose: "SESSION", paise: 79900, state: "REFUND_PENDING", at: "2026-10-12T05:00:00Z" });
  await h.db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state, created_at) VALUES (?1, 'CANCELLED', 'system', 'PENDING', '2026-10-12T06:00:00Z')").bind(slow.pay).run();
  const wrong = await paidCustomer(h.db, { waId: "919800003333", name: "Chitra Wrong", state: "UNKNOWN", paid: 5000, at: "2026-10-14T05:00:00Z" });
  const late = await paidCustomer(h.db, { waId: "919800004444", name: "Dev Late", at: "2026-10-15T05:00:00Z" });
  await h.db.prepare("INSERT INTO attention (kind, target) VALUES ('LATE_PAYMENT_NO_SLOT', ?1)").bind(`intro:${late.target}`).run();
  const good = await paidCustomer(h.db, { waId: "919800005555", name: "Esha Good", at: "2026-10-20T05:00:00Z" });
  const pack = await paidCustomer(h.db, { waId: "919800006666", name: "Farah Pack", purpose: "PACKAGE", paise: 500000, size: 10, at: "2026-10-21T05:00:00Z" });
  await h.db.prepare("INSERT INTO credits (package_id, delta, reason, at, by) VALUES (?1, 10, 'PURCHASE', '2026-10-21T05:00:00Z', 'system'), (?1, -3, 'BOOK', '2026-10-22T05:00:00Z', 'system')").bind(pack.target).run();
  const lastMonth = await paidCustomer(h.db, { waId: "919800007777", name: "Gita Earlier", at: "2026-09-20T05:00:00Z" });
  const refunded = await paidCustomer(h.db, { waId: "919800008888", name: "Hari Refunded", state: "REFUNDED", at: "2026-10-03T05:00:00Z" });
  await h.db.prepare("INSERT INTO refunds (payment_id, reason, requested_by, state, created_at, updated_at) VALUES (?1, 'NOT_FIT', 'system', 'REFUNDED', '2026-10-03T06:00:00Z', '2026-10-04T06:00:00Z')").bind(refunded.pay).run();
  return { failed, slow, wrong, late, good, pack, lastMonth, refunded };
}

describe("problems first, each with its next step", () => {
  it("failed refund, refund waiting over 7 days, a different amount, paid with no booking; worst first; one per payment", async () => {
    const s = await seed();
    const list = await problems(h.env(), NOW);
    expect(list.map((p) => [p.kind, p.pay.id])).toEqual([
      ["refundFailed", s.failed.pay],
      ["refundSlow", s.slow.pay],
      ["mismatch", s.wrong.pay],
      ["noBooking", s.late.pay],
    ]);
    const html = await page();
    const head = html.indexOf("Needs a look");
    for (const t of ["Refund didn't go through", "Refund still on its way after 7 days", "Paid a different amount", "Paid, with no booking to go with it"]) expect(html.indexOf(t)).toBeGreaterThan(head);
    expect(html.indexOf("Paid, with no booking to go with it")).toBeLessThan(html.indexOf("Every payment this month"));
    expect(html).toContain("Paid ₹50, the link asked for ₹99.");
    expect(html).toContain('action="/app/payments/' + s.failed.pay + '/retry-refund"');
    expect(html).toContain(`https://dashboard.razorpay.com/app/payments/pay_TEST${s.failed.conv}`);
    expect(html).toContain('href="/app"'); // approvals and late payments are settled on Today
  });
  it("a refund waiting under 7 days is not a problem yet; a resolved late payment is not either", async () => {
    const s = await seed();
    await h.db.prepare("UPDATE refunds SET created_at = ?2 WHERE payment_id = ?1").bind(s.slow.pay, new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 19) + "Z").run();
    await h.db.prepare("UPDATE attention SET resolved_at = '2026-10-26T00:00:00Z'").run();
    expect((await problems(h.env(), NOW)).map((p) => p.kind)).toEqual(["refundFailed", "mismatch"]);
  });
  it("nothing to look at: an empty state that says so", async () => {
    expect(await page()).toContain("Nothing needs a look.");
  });
});

describe("the month: money in, refunded, net and sessions owed", () => {
  it("counts this month's paid payments, refunds confirmed this month, and unused package sessions at their rate", async () => {
    await seed();
    const t = await monthTotals(h.env(), "2026-10");
    // In: failed 99 + slow 799 + late 99 + good 99 + pack 5000 + refunded 99 (all paid in October); the UNKNOWN one is not counted.
    expect(t.received).toBe(9900 + 79900 + 9900 + 9900 + 500000 + 9900);
    expect(t.refunded).toBe(9900);
    expect(t.net).toBe(t.received - 9900);
    expect(t.owedSessions).toBe(7);
    expect(t.owedPaise).toBe(7 * 50000);
    const html = await page();
    expect(html).toContain("October 2026");
    const stats = /<div class="stats">([\s\S]*?)<\/div><p class="note">/.exec(html)?.[1] ?? "";
    expect(stats, stats).toContain("₹6,195"); // money in
    expect(html).toContain("7 (₹3,500)");
    expect(html).not.toContain("Later month");
  });
  it("any month: earlier months by link; the list shows only that month's payments, statuses in words", async () => {
    await seed();
    let html = await page("/app/payments?month=2026-09");
    expect(html).toContain("September 2026");
    expect(html).toContain("Gita");
    expect(html).not.toContain("Esha");
    expect(html).toContain('href="/app/payments?month=2026-10"');
    html = await page();
    expect(html).toContain('href="/app/payments?month=2026-09"');
    const w = words(html);
    expect(w).toContain("Refund on its way");
    expect(w).toContain("Check with Razorpay");
    expect(w).not.toMatch(/\b(REFUND_FAILED|REFUND_PENDING|UNKNOWN|PAID|INTRO|SESSION|PACKAGE)\b/);
    expect(html).not.toMatch(/9198000\d{5}/); // never a whole number
    expect(html).toContain("…5555");
  });
  it("a month in the future shows this month; month boundaries are India time", async () => {
    expect(monthOf(Date.parse("2026-10-31T19:00:00Z"))).toBe("2026-11"); // 12:30 am on 1 Nov in India
    expect(monthRange("2026-10")).toEqual(["2026-09-30T18:30:00Z", "2026-10-31T18:30:00Z"]);
    expect(await page("/app/payments?month=2027-05")).toContain("October 2026");
  });
});

describe("one payment's page", () => {
  it("opens beside the list, with the customer's link and the refund in words", async () => {
    const s = await seed();
    const html = await page(`/app/payments/${s.slow.pay}?month=2026-10`);
    expect(html).toContain('class="ld open"');
    expect(html).toContain(`href="/app/people/${s.slow.conv}"`);
    expect(html).toContain("On its way · ₹799");
    expect(await page("/app/payments/99999")).toContain("That payment isn't here.");
  });
});

describe("the CSV export: masked, owner only, audited", () => {
  const exportCsv = async (as = OWNER, month = "2026-10") => h.post("/app/payments/export", { month, csrf: await h.tokenFor(as, "payments-export") }, as);
  it("last 4 digits and first names only; no provider ids; a formula never runs; the download is in the audit log", async () => {
    await seed();
    await h.db.prepare("UPDATE conversations SET display_name = '=HYPERLINK(1)' WHERE wa_id = '919800005555'").run();
    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="payments-2026-10.csv"');
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // a byte-order mark, so spreadsheets read ₹ and Hindi
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Date (India time),For,Amount (₹),Status,Customer,Phone");
    expect(lines).toHaveLength(1 + 7); // the seven October payments
    expect(csv).not.toMatch(/9198000\d{5}|98000\d{5}/);
    expect(csv).not.toMatch(/pay_|di-test|Asha Failed|Bina Slow/); // no provider ids, no surnames
    expect(csv).toContain("…1111");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("2026-10-10 10:30,First call,99,Check with Razorpay,Asha,…1111");
    const audit = await h.audits("DATA_EXPORTED");
    expect(audit).toHaveLength(1);
    expect(audit[0].target).toBe("payments:2026-10");
    expect(audit[0].memberId).toBe((await h.member(OWNER))!.id);
  });
  it("staff and the practitioner are refused, and nothing is recorded", async () => {
    await seed();
    for (const who of [STAFF, PRAC]) expect((await exportCsv(who)).status).toBe(403);
    expect(await h.audits("DATA_EXPORTED")).toEqual([]);
  });
  it("a bad month or a bad token is refused", async () => {
    expect((await h.post("/app/payments/export", { month: "2026-13", csrf: await h.tokenFor(OWNER, "payments-export") })).status).toBe(400);
    expect((await h.post("/app/payments/export", { month: "2026-10", csrf: "nope" })).status).toBe(403);
  });
  it("the Hindi CSV has Hindi headings and words, still masked", async () => {
    const s = await seed();
    const rows = await h.db.prepare("SELECT p.id, p.purpose, p.amount_paise AS amount, p.amount_paise AS asked, NULL AS paid, p.state, p.created_at AS at, c.display_name AS name, c.wa_id AS waId, NULL AS size FROM payments p JOIN intros i ON i.id = p.target_id AND p.purpose = 'INTRO' JOIN conversations c ON c.id = i.conversation_id WHERE p.id = ?1").bind(s.good.pay).all();
    const csv = paymentsCsv(rows.results as never, "hi");
    expect(csv).toContain("तारीख़ (भारतीय समय)");
    expect(csv).toContain("पहली कॉल,99,पेमेंट हो गया,Esha,…5555");
  });
});

describe("retrying a refund that failed", () => {
  it("behind a confirm step; the existing refund code runs once; audited; a second POST changes nothing", async () => {
    const s = await seed();
    const html = await page();
    expect(html).toContain("Retry the refund…");
    expect(html).toMatch(/<details class="confirm"><summary>Retry the refund…<\/summary>/);
    const csrf = await h.tokenFor(OWNER, `payments-retry:${s.failed.pay}`);
    const res = await h.post(`/app/payments/${s.failed.pay}/retry-refund`, { csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/app/payments/${s.failed.pay}?m=retried`);
    expect((await h.db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(s.failed.pay).first<{ state: string }>())!.state).not.toBe("FAILED");
    expect(await h.audits("REFUND_RETRIED")).toHaveLength(1);
    const again = await h.post(`/app/payments/${s.failed.pay}/retry-refund`, { csrf });
    expect(again.headers.get("Location")).toContain("m=none");
    expect(await h.audits("REFUND_RETRIED")).toHaveLength(1);
  });
  it("a token for another payment is refused", async () => {
    const s = await seed();
    const res = await h.post(`/app/payments/${s.failed.pay}/retry-refund`, { csrf: await h.tokenFor(OWNER, `payments-retry:${s.good.pay}`) });
    expect(res.status).toBe(403);
    expect((await h.db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(s.failed.pay).first<{ state: string }>())!.state).toBe("FAILED");
  });
});
