// Applies Amma's outcomes once the undo window has passed, from the 2-minute cron. Each outcome is claimed with a conditional UPDATE
// on applied_at, so two cron runs apply it once. Every effect is also idempotent (unique refunds row, dedupe keys, guarded state
// changes), so a failed attempt is released and simply tried again.
import { prices } from "./business";
import { config } from "./config";
import { freeCallSlots } from "./booking";
import { copyFor, langOf, rupees } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { sessionOfferOut } from "./packages";
import { requestRefund } from "./pay/refund";
import type { PaymentProvider } from "./pay/provider";
import { raiseAttention, sendMessage, sendOrTemplate, type Out } from "./send";
import { formatIstLang, holdSlot, iso } from "./slots";

const nowIso = () => iso(Date.now());
type Due = { id: number; introId: number | null; sessionId: number | null; value: string };
type Intro = { id: number; state: string; rc: number; conv: number; service: string; slotId: number | null; locale: string };

export async function applyDueOutcomes(env: Env, provider: PaymentProvider, nowMs = Date.now()): Promise<number> {
  const db = env.DB;
  const now = iso(nowMs);
  const { results } = await db
    .prepare("SELECT id, intro_id AS introId, session_id AS sessionId, value FROM outcomes WHERE applied_at IS NULL AND undo_until <= ?1 ORDER BY id LIMIT 25")
    .bind(now)
    .all<Due>();
  let applied = 0;
  for (const o of results) {
    const claim = await db
      .prepare("UPDATE outcomes SET applied_at = ?2 WHERE id = ?1 AND applied_at IS NULL AND undo_until <= ?2")
      .bind(o.id, now)
      .run();
    if (!claim.meta.changes) continue; // another run got it
    try {
      await applyOne(env, provider, o);
      applied++;
    } catch {
      await db.prepare("UPDATE outcomes SET applied_at = NULL WHERE id = ?1 AND applied_at = ?2").bind(o.id, now).run(); // retry next run
      await raiseAttention(db, "OUTCOME_FAILED", targetOf(o));
    }
  }
  return applied;
}

const targetOf = (o: Due) => (o.introId !== null ? `intro:${o.introId}` : `session:${o.sessionId}`);
const audit = (env: Env, o: Due, detail: string) =>
  env.DB.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, 'system', 'OUTCOME_APPLIED', ?2, ?3)").bind(nowIso(), targetOf(o), `${o.value}: ${detail}`).run();

// "Not right fit" on a buyer's very first session (no 99 call before it): the whole purchase is refunded, once per person (the same refund rules as the 99 call).
// For a package the unused credits and the other upcoming sessions go too, and the package is closed.
async function applySessionNotFit(env: Env, provider: PaymentProvider, o: Due): Promise<void> {
  const db = env.DB;
  const ses = await db
    .prepare("SELECT se.id, se.state, se.conversation_id AS conv, se.origin, se.package_id AS pkg, c.locale FROM sessions se JOIN conversations c ON c.id = se.conversation_id WHERE se.id = ?1")
    .bind(o.sessionId)
    .first<{ id: number; state: string; conv: number; origin: string; pkg: number | null; locale: string }>();
  if (!ses || !["CONFIRMED", "CREDIT_BOOKED"].includes(ses.state)) {
    await raiseAttention(db, "OUTCOME_STALE", targetOf(o));
    await audit(env, o, `skipped, session is ${ses?.state ?? "missing"}`);
    return;
  }
  const paid = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
  const pay =
    ses.origin === "CREDIT" && ses.pkg
      ? await db.prepare(`SELECT p.id, p.amount_paise AS amount FROM packages k JOIN payments p ON p.id = k.payment_id WHERE k.id = ?1 AND p.state IN ${paid}`).bind(ses.pkg).first<{ id: number; amount: number }>()
      : await db.prepare(`SELECT id, amount_paise AS amount FROM payments WHERE purpose = 'SESSION' AND target_id = ?1 AND state IN ${paid} ORDER BY id LIMIT 1`).bind(ses.id).first<{ id: number; amount: number }>();
  await db.prepare("UPDATE sessions SET state = 'NOT_FIT', updated_at = ?2 WHERE id = ?1 AND state IN ('CONFIRMED','CREDIT_BOOKED')").bind(ses.id, nowIso()).run();
  if (!pay) {
    await raiseAttention(db, "NOT_FIT_NO_PAYMENT", targetOf(o));
    await audit(env, o, "session NOT_FIT, no paid payment to refund");
    return;
  }
  const why = await requestRefund(env, provider, pay.id, "NOT_FIT", "amma");
  if (why === "PERSON_LIMIT" || why === "DAILY_LIMIT") {
    await raiseAttention(db, "NOT_FIT_REFUND_REFUSED", `payment:${pay.id}`);
    await audit(env, o, `session NOT_FIT, refund refused (${why})`);
    return;
  }
  if (ses.origin === "CREDIT" && ses.pkg) {
    // The package is refunded in full: its other upcoming sessions are cancelled and what is left on the ledger goes to zero.
    const now = nowIso();
    await db.batch([
      db.prepare("UPDATE slots SET state = 'HELD', hold_until = ?2 WHERE state = 'BOOKED' AND id IN (SELECT slot_id FROM sessions WHERE package_id = ?1 AND state = 'CREDIT_BOOKED' AND id != ?3)").bind(ses.pkg, now, ses.id),
      db.prepare("UPDATE sessions SET state = 'CANCELLED', updated_at = ?2 WHERE package_id = ?1 AND state = 'CREDIT_BOOKED' AND id != ?3").bind(ses.pkg, now, ses.id),
      db
        .prepare(
          `INSERT INTO credits (package_id, delta, reason, at, by)
           SELECT ?1, -SUM(delta), 'REFUND', ?2, 'system' FROM credits WHERE package_id = ?1 HAVING SUM(delta) > 0`,
        )
        .bind(ses.pkg, now),
      db.prepare("UPDATE packages SET state = 'CLOSED', updated_at = ?2 WHERE id = ?1 AND state = 'PAID'").bind(ses.pkg, now),
    ]);
  }
  const refund = await db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(pay.id).first<{ state: string }>();
  if (refund?.state !== "FAILED") {
    const amount = rupees(pay.amount);
    await sendOrTemplate(
      env,
      ses.conv,
      { type: "text", text: copyFor(ses.locale).notFitRefundSession(amount) },
      { type: "template", name: "payment_update", params: [amount] },
      `outcome:${o.id}:refund`,
    );
  }
  await audit(env, o, `session NOT_FIT, refund ${why} for payment ${pay.id}`);
}

async function applyOne(env: Env, provider: PaymentProvider, o: Due): Promise<void> {
  const db = env.DB;
  if (o.introId === null) return applySessionNotFit(env, provider, o);
  const intro = await db
    .prepare(
      `SELECT i.id, i.state, i.reschedule_count AS rc, i.conversation_id AS conv, i.service, i.slot_id AS slotId, c.locale
       FROM intros i JOIN conversations c ON c.id = i.conversation_id WHERE i.id = ?1`,
    )
    .bind(o.introId)
    .first<Intro>();
  if (!intro || !["PAID", "RESCHEDULED"].includes(intro.state)) {
    await raiseAttention(db, "OUTCOME_STALE", `intro:${o.introId}`);
    await audit(env, o, `skipped, intro is ${intro?.state ?? "missing"}`);
    return;
  }
  const cp = copyFor(intro.locale);
  const key = (step: string) => `outcome:${o.id}:${step}`;
  const setState = (state: string) =>
    db.prepare("UPDATE intros SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ('PAID','RESCHEDULED')").bind(intro.id, state, nowIso()).run();

  if (o.value === "SESSION") {
    await setState("CALLED_SESSION");
    await db
      .prepare("INSERT INTO sessions (conversation_id, intro_id, service, practitioner_id) SELECT ?1, ?2, ?3, i.practitioner_id FROM intros i WHERE i.id = ?2 AND NOT EXISTS (SELECT 1 FROM sessions WHERE intro_id = ?2)")
      .bind(intro.conv, intro.id, intro.service)
      .run();
    const ses = await db.prepare("SELECT id FROM sessions WHERE intro_id = ?1").bind(intro.id).first<{ id: number }>();
    await sendOrTemplate(
      env,
      intro.conv,
      sessionOfferOut(cp, ses!.id), // the options: single, 10 or 20
      { type: "template", name: "session_offer", params: [] },
      key("offer"),
    );
    await audit(env, o, `intro CALLED_SESSION, session ${ses!.id} offered`);
    return;
  }

  if (o.value === "NOT_FIT") {
    await setState("CALLED_NOT_FIT");
    const pay = await db
      .prepare("SELECT id FROM payments WHERE purpose = 'INTRO' AND target_id = ?1 AND state IN ('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED') ORDER BY id LIMIT 1")
      .bind(intro.id)
      .first<{ id: number }>();
    if (!pay) {
      await raiseAttention(db, "NOT_FIT_NO_PAYMENT", `intro:${intro.id}`);
      await audit(env, o, "intro CALLED_NOT_FIT, no paid payment to refund");
      return;
    }
    const why = await requestRefund(env, provider, pay.id, "NOT_FIT", "amma");
    if (why === "PERSON_LIMIT" || why === "DAILY_LIMIT") {
      // No refund and nothing sent: Rohit decides.
      await raiseAttention(db, "NOT_FIT_REFUND_REFUSED", `payment:${pay.id}`);
      await audit(env, o, `intro CALLED_NOT_FIT, refund refused (${why})`);
      return;
    }
    const refund = await db.prepare("SELECT state FROM refunds WHERE payment_id = ?1").bind(pay.id).first<{ state: string }>();
    if (refund?.state !== "FAILED") {
      await sendOrTemplate(
        env,
        intro.conv,
        { type: "text", text: cp.notFitRefund },
        { type: "template", name: "payment_update", params: [rupees(prices().intro)] },
        key("refund"),
      );
    }
    await audit(env, o, `intro CALLED_NOT_FIT, refund ${why} for payment ${pay.id}`);
    return;
  }

  if (o.value === "MISSED") {
    await setState("MISSED");
    if (intro.rc >= 1) {
      // Second miss on a rescheduled call: closed, no refund.
      await sendMessage(env, intro.conv, { type: "text", text: cp.missedFinal }, key("final"));
      await raiseAttention(db, "MISSED_TWICE", `intro:${intro.id}`);
      await audit(env, o, "intro MISSED again, closed with no refund");
      return;
    }
    const rows = (await freeCallSlots(env, Date.now()))
      .slice(0, config.booking.maxListRows)
      .map((s) => {
        const p = formatIstLang(s.startUtc, langOf(intro.locale));
        return { id: `resched_${intro.id}_${s.startUtc}`, title: p.time, description: p.day }; // the day is too long to share a 24-character title in Hindi
      });
    if (!rows.length) {
      await raiseAttention(db, "NO_CALL_SLOTS_FOR_RESCHEDULE", `intro:${intro.id}`);
    } else {
      await sendMessage(env, intro.conv, { type: "list", body: cp.missedOffer, button: cp.listButtonTimes, rows }, key("resched"));
    }
    await audit(env, o, `intro MISSED, reschedule offered (${rows.length} slots)`);
    return;
  }

  // RUDE: block now (no more bot replies, nothing sent), refund waits for Rohit.
  await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(intro.conv).run();
  await db
    .prepare("INSERT INTO blocks (wa_id, reason, by, created_at) SELECT wa_id, 'RUDE', 'amma', ?2 FROM conversations WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.wa_id = conversations.wa_id)")
    .bind(intro.conv, nowIso())
    .run();
  await setState("RUDE");
  const pay = await db.prepare("SELECT id FROM payments WHERE purpose = 'INTRO' AND target_id = ?1 AND state = 'PAID' ORDER BY id LIMIT 1").bind(intro.id).first<{ id: number }>();
  if (pay) await requestRefund(env, provider, pay.id, "RUDE", "amma"); // row PENDING_APPROVAL, nothing sent to the provider
  await raiseAttention(db, "RUDE_REFUND_APPROVAL", pay ? `payment:${pay.id}` : `intro:${intro.id}`);
  await audit(env, o, "conversation BLOCKED, refund waits for approval");
}

// resched_<introId>_<startUtc>: free, no payment. Same guarded hold, then BOOKED directly. Returns false for any other choice.
export async function rescheduleChoice(env: Env, choice: string | null, convId: number, msgId: string): Promise<boolean> {
  const m = /^resched_(\d+)_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(choice ?? "");
  if (!m) return false;
  const db = env.DB;
  const conv = await db.prepare("SELECT id, wa_id, locale FROM conversations WHERE id = ?1").bind(convId).first<{ id: number; wa_id: string; locale: string }>();
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  if (!(await bookingsOpen(env))) {
    await send({ type: "text", text: cp.bookSoon }, "book");
    return true;
  }
  if (await db.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first()) {
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
    return true;
  }
  const introId = Number(m[1]);
  const intro = await db
    .prepare("SELECT state, reschedule_count AS rc, slot_id AS slotId FROM intros WHERE id = ?1 AND conversation_id = ?2")
    .bind(introId, conv.id)
    .first<{ state: string; rc: number; slotId: number | null }>();
  if (!intro || intro.state !== "MISSED" || intro.rc !== 0) {
    await send({ type: "text", text: cp.rescheduleNotAvailable }, "na");
    return true;
  }
  const hold = await holdSlot(db, { kind: "CALL", startUtc: m[2], ownerId: conv.id, nowMs: Date.now() });
  if (!hold.ok) {
    await send({ type: "text", text: hold.reason === "ALREADY_HOLDING" ? cp.alreadyHolding : cp.slotTaken }, "taken");
    return true;
  }
  const slot = await db.prepare("SELECT id FROM slots WHERE kind = 'CALL' AND start_utc = ?1 AND owner_id = ?2").bind(m[2], conv.id).first<{ id: number }>();
  const now = nowIso();
  // One transaction: intro -> RESCHEDULED (only the first tap wins), new slot BOOKED, old slot freed.
  const [moved] = await db.batch([
    db.prepare("UPDATE intros SET state = 'RESCHEDULED', slot_id = ?2, reschedule_count = 1, updated_at = ?3 WHERE id = ?1 AND state = 'MISSED' AND reschedule_count = 0").bind(introId, slot?.id ?? 0, now),
    db.prepare("UPDATE slots SET state = 'BOOKED', hold_until = NULL WHERE id = ?1 AND owner_id = ?2 AND state = 'HELD' AND EXISTS (SELECT 1 FROM intros WHERE id = ?3 AND slot_id = ?1 AND state = 'RESCHEDULED')").bind(slot?.id ?? 0, conv.id, introId),
    db.prepare("UPDATE slots SET state = 'HELD', hold_until = ?2 WHERE id = ?1 AND id != ?3 AND state = 'BOOKED' AND EXISTS (SELECT 1 FROM intros WHERE id = ?4 AND slot_id = ?3 AND state = 'RESCHEDULED')").bind(intro.slotId ?? 0, now, slot?.id ?? 0, introId),
  ]);
  if (!moved.meta.changes) {
    await db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(slot?.id ?? 0, now).run(); // lost a double tap
    await send({ type: "text", text: cp.rescheduleNotAvailable }, "na");
    return true;
  }
  await db.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?1, 'system', 'RESCHEDULED', ?2, ?3)").bind(now, `intro:${introId}`, m[2]).run();
  const p = formatIstLang(m[2], langOf(conv.locale));
  await send({ type: "text", text: cp.rescheduled(p.day, p.time, config.businessNumber) }, "done");
  return true;
}
