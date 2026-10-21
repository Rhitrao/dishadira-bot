// Day-before reminders (cron 13:00 UTC = 18:30 IST): everyone with a call or a confirmed session tomorrow (IST) gets one message.
// Free text inside the 24-hour window, the `reminder` template outside it. The dedupe key is per booking (intro or session + slot),
// so a second run, or a rescheduled call, never sends the same reminder twice. While SENDS is paused nothing is written at all,
// so no dedupe row blocks the reminder if Rohit resumes sends the same evening.
import { copyFor, langOf } from "./copy";
import type { Env } from "./env";
import { sendOrTemplate } from "./send";
import { formatIstLang, iso, istDay } from "./slots";
import { sendsOn } from "./switches";

const DAY = 86_400_000;
const dayStartUtc = (ymd: string) => iso(Date.parse(`${ymd}T00:00:00+05:30`));

type Row = { id: number; slotId: number; conv: number; locale: string; start: string };

export async function sendReminders(env: Env, nowMs = Date.now()): Promise<number> {
  if (!(await sendsOn(env))) return 0;
  const from = dayStartUtc(istDay(nowMs + DAY));
  const to = dayStartUtc(istDay(nowMs + 2 * DAY));
  const q = (table: "intros" | "sessions", states: string, kind: string) =>
    env.DB
      .prepare(
        `SELECT t.id AS id, s.id AS slotId, c.id AS conv, c.locale AS locale, s.start_utc AS start
         FROM ${table} t JOIN slots s ON s.id = t.slot_id JOIN conversations c ON c.id = t.conversation_id
         WHERE t.state IN ${states} AND s.kind = '${kind}' AND s.state = 'BOOKED' AND s.start_utc >= ?1 AND s.start_utc < ?2 ORDER BY s.start_utc`,
      )
      .bind(from, to)
      .all<Row>();
  const calls = (await q("intros", "('PAID','RESCHEDULED')", "CALL")).results;
  const sessions = (await q("sessions", "('CONFIRMED','CREDIT_BOOKED')", "SESSION")).results;
  let sent = 0;
  for (const [kind, rows] of [["call", calls], ["session", sessions]] as const) {
    for (const r of rows) {
      const lang = langOf(r.locale);
      const cp = copyFor(lang);
      const en = formatIstLang(r.start, "en");
      const hi = formatIstLang(r.start, "hi");
      const p = lang === "hi" ? hi : en;
      const res = await sendOrTemplate(
        env,
        r.conv,
        { type: "text", text: kind === "call" ? cp.reminderCall(p.day, p.time) : cp.reminderSession(p.day, p.time) },
        { type: "template", name: "reminder", params: [copyFor("en")[kind === "call" ? "wordCall" : "wordSession"], en.day, en.time], paramsHi: [copyFor("hi")[kind === "call" ? "wordCall" : "wordSession"], hi.day, hi.time] },
        `reminder:${kind}:${r.id}:${r.slotId}`,
      ).catch(() => "FAILED");
      if (res === "SENT") sent++;
    }
  }
  return sent;
}
