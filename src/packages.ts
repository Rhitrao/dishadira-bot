// Sessions & packages (docs/AGENT.md section 3.1b), all fixed messages:
//   menu_pack -> list (99 call | single | 10 | 20) -> soft gate (never had the 99 call) -> go_<flow> -> age check (once) ->
//     single:  ssv_<S> -> swh_<S>_<W> -> sdy_<S>_<W>_<ymd> -> stm_<S>_<W>_<utc>  = a sessions row + the existing hold + Razorpay link (src/session.ts)
//     package: a Razorpay link for the price, no slot held; paid -> credits (src/pay/apply.ts)
//   bk_new (Book a session, with credits) -> bsv_<S> -> bwh_<S>_<W> -> bdy_<S>_<W>_<ymd> -> btm_<S>_<W>_<utc>  = booked at once from a credit.
// flow: s = single session, p10 / p20 = a package (config.prices). Every button id carries what was chosen so far, so the flow keeps no state.
//
// The credits ledger: a person's balance is the SUM of credits.delta over their packages, never stored. A credit booking is ONE batch
// (one transaction): the slot, the session row and the -1 ledger row are each written only if the balance is above zero and the buyer has
// fewer than config.sessionRules.maxUpcoming upcoming sessions. Two taps, or a replay, can never use two credits or book two slots.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { ageButtons, serviceButtons, SERVICES, whoButtons, WHO, bookingChoice, loadConv, sendDays, sendTimes, type Conv } from "./booking";
import { copyFor, langOf, packPrice, rupees, type Copy, type ForWhom } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { razorpay } from "./pay/razorpay";
import type { PaymentProvider } from "./pay/provider";
import { requestRefund } from "./pay/refund";
import { startSession } from "./session";
import { raiseAttention, sendMessage, sendOrTemplate, type Out } from "./send";
import { clearStep, sendStep } from "./steps";
import { bind, formatIstLang, generateSlots, iso, istDay, PRACTITIONER_SQL } from "./slots";

const nowIso = () => iso(Date.now());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const FLOWS = { p10: config.prices.pack10, p20: config.prices.pack20 } as const;
type PackFlow = keyof typeof FLOWS;
type Flow = "s" | PackFlow;
const isFlow = (f: string | undefined): f is Flow => f === "s" || f === "p10" || f === "p20";

// ---- the ledger ----
const BALANCE = `(SELECT COALESCE(SUM(c.delta), 0) FROM credits c JOIN packages k ON k.id = c.package_id WHERE k.conversation_id = :conv)`;
export async function creditBalance(db: D1Database, convId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(c.delta), 0) AS n FROM credits c JOIN packages k ON k.id = c.package_id WHERE k.conversation_id = ?1")
    .bind(convId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
export async function hasPackage(db: D1Database, convId: number): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM packages WHERE conversation_id = ?1 AND state IN ('PAID', 'CLOSED')").bind(convId).first()) !== null;
}

// Sessions that are booked and have not ended: from credits, or paid for one by one.
export async function upcomingSessionCount(db: D1Database, convId: number, nowMs = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions se JOIN slots sl ON sl.id = se.slot_id
       WHERE se.conversation_id = ?1 AND se.state IN ('CREDIT_BOOKED', 'CONFIRMED') AND sl.end_utc > ?2`,
    )
    .bind(convId, iso(nowMs))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Someone who has paid for a 99 call (booked it, had it, or missed it) is not shown the soft gate.
export async function hadFirstCall(db: D1Database, convId: number): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM intros WHERE conversation_id = ?1 AND state IN ('PAID', 'RESCHEDULED', 'CALLED_SESSION', 'CALLED_NOT_FIT', 'MISSED', 'RUDE')").bind(convId).first()) !== null;
}

// ---- messages ----
export const packagesList = (cp: Copy): Out => ({
  type: "list",
  body: cp.packagesBody,
  button: cp.packagesButton,
  rows: [
    { id: "pk_intro", title: cp.rowIntroTitle, description: cp.rowIntroDesc },
    { id: "pk_single", title: cp.rowSingleTitle, description: cp.rowSingleDesc },
    { id: "pk_p10", title: cp.rowPack10Title, description: cp.rowPack10Desc },
    { id: "pk_p20", title: cp.rowPack20Title, description: cp.rowPack20Desc },
  ],
});

// What Amma's "Session" outcome sends: the same three choices after the 99 call (the single session is the one she offered, so it skips the soft gate).
export const sessionOfferOut = (cp: Copy, sessionId: number): Out => ({
  type: "list",
  body: cp.sessionOfferBody,
  button: cp.packagesButton,
  rows: [
    { id: `sess_offer_${sessionId}`, title: cp.rowSingleTitle, description: cp.rowSingleDesc },
    { id: "go_p10", title: cp.rowPack10Title, description: cp.rowPack10Desc },
    { id: "go_p20", title: cp.rowPack20Title, description: cp.rowPack20Desc },
  ],
});

async function blocked(env: Env, conv: Conv): Promise<boolean> {
  if (!(await env.DB.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first())) return false;
  await env.DB.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
  return true;
}

// Handles every id above. Returns false for any other choice.
export async function packChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = razorpay(env)): Promise<boolean> {
  if (!choice) return false;
  const [tag, a, b, c] = choice.split("_");
  const known =
    choice === "menu_pack" ||
    choice === "bk_new" ||
    ((tag === "pk" || tag === "gate" || tag === "go") && a !== undefined && !b) ||
    (tag === "age" && (a === "yes" || a === "no") && b !== undefined && !c) ||
    ["ssv", "swh", "sdy", "smo", "stm", "bsv", "bwh", "bdy", "bmo", "btm"].includes(tag);
  if (!known) return false;

  // Shape checks: anything that does not parse is not ours (the booking handlers ignore it too).
  const flowOnly = tag === "gate" || tag === "go" || tag === "age";
  if (tag === "pk" && !["intro", "single", "p10", "p20"].includes(a)) return false;
  if (flowOnly && !isFlow(tag === "age" ? b : a) && !(tag === "age" && b === "b")) return false;
  if (["ssv", "bsv"].includes(tag) && !SERVICES.includes(a)) return false;
  if (["swh", "sdy", "smo", "stm", "bwh", "bdy", "bmo", "btm"].includes(tag) && (!SERVICES.includes(a) || !WHO.includes(b as ForWhom))) return false;
  if (["sdy", "bdy"].includes(tag) && !YMD.test(c ?? "")) return false;
  if (["stm", "btm"].includes(tag) && !UTC.test(c ?? "")) return false;

  const conv = await loadConv(env.DB, convId);
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  const sendAs = (name: Parameters<typeof sendStep>[2], out: Out, step: string) => sendStep(env, conv.id, name, out, `${msgId}:${step}`);
  await clearStep(env.DB, conv.id); // whatever step was open is over; the step sent below (if any) becomes the open one

  if (choice === "menu_pack") {
    await sendAs("packages", packagesList(cp), "packages");
    return true;
  }
  if (tag === "pk") {
    if (a === "intro") return bookingChoice(env, "menu_book", convId, msgId, provider);
    if (!(await hadFirstCall(env.DB, conv.id))) {
      // The soft gate: most people start with the 99 call. Continue is always allowed.
      await sendAs("gate", { type: "buttons", body: cp.softGate, buttons: [{ id: "menu_book", title: cp.btnBook }, { id: `gate_${a === "single" ? "s" : a}`, title: cp.btnContinue }] }, "gate");
      return true;
    }
    return enter(a === "single" ? "s" : (a as Flow));
  }
  if (tag === "gate" || tag === "go") return enter(a as Flow);

  // Buying or booking is closed while NEW_BOOKINGS is off, and never works for a blocked person.
  const buying = tag === "ssv" || tag === "swh" || tag === "sdy" || tag === "smo" || tag === "stm" || tag === "bk" || tag === "bsv" || tag === "bwh" || tag === "bdy" || tag === "bmo" || tag === "btm" || (tag === "age" && a === "yes");
  if (buying && !(await bookingsOpen(env))) {
    await send({ type: "text", text: cp.bookSoon }, "book");
    return true;
  }
  if (buying && (await blocked(env, conv))) return true;

  // The age check, asked once: "No" is not remembered (a parent writing from the same phone can say Yes later).
  if (tag === "age" && a === "no") {
    await send({ type: "text", text: cp.ageNo }, "ageno");
    return true;
  }
  if (tag === "age") {
    await env.DB.prepare("UPDATE conversations SET age_ok_at = COALESCE(age_ok_at, ?2) WHERE id = ?1").bind(conv.id, nowIso()).run();
    conv.age_ok_at = conv.age_ok_at ?? nowIso();
    return b === "b" ? enterCredit() : enter(b as Flow);
  }
  // Nothing past the age check works (not even an old button) until the person has said they are 18 or older.
  if (!conv.age_ok_at) {
    await sendAs("age", ageButtons(cp, `_${tag.startsWith("b") ? "b" : "s"}`), "age");
    return true;
  }

  if (choice === "bk_new") return enterCredit();

  // ---- single session ----
  if (tag === "ssv") {
    await sendAs("who", whoButtons(cp, a, "swh"), "who");
    return true;
  }
  if (tag === "swh" || tag === "smo") {
    await sendDays(env, conv, "SESSION", (ymd) => `sdy_${a}_${b}_${ymd}`, msgId);
    return true;
  }
  if (tag === "sdy") {
    const ok = await sendTimes(env, conv, "SESSION", c, (u) => `stm_${a}_${b}_${u}`, `smo_${a}_${b}`, msgId);
    if (!ok) {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      await sendDays(env, conv, "SESSION", (ymd) => `sdy_${a}_${b}_${ymd}`, `${msgId}:again`);
    }
    return true;
  }
  if (tag === "stm") {
    // A person with a live hold gets the existing "already held" message (the same rule as the hold itself), and no second session row.
    const holding = await env.DB.prepare("SELECT 1 FROM slots WHERE owner_id = ?1 AND state = 'HELD' AND hold_until > ?2").bind(conv.id, nowIso()).first();
    if (holding) {
      await send({ type: "text", text: cp.alreadyHolding }, "holding");
      return true;
    }
    // One reusable OFFERED row per person: the existing session machinery (hold, link, webhook, refunds) takes it from here.
    const existing = await env.DB
      .prepare("SELECT id FROM sessions WHERE conversation_id = ?1 AND origin = 'SELF' AND state IN ('OFFERED', 'EXPIRED') ORDER BY id DESC LIMIT 1")
      .bind(conv.id)
      .first<{ id: number }>();
    let sid = existing?.id ?? 0;
    if (sid) {
      await env.DB.prepare("UPDATE sessions SET service = ?2, for_whom = ?3, call_lang = ?4, state = 'OFFERED', updated_at = ?5 WHERE id = ?1").bind(sid, a, b, lang, nowIso()).run();
    } else {
      const ins = await env.DB
        .prepare(`INSERT INTO sessions (conversation_id, service, for_whom, call_lang, origin, practitioner_id) VALUES (?1, ?2, ?3, ?4, 'SELF', ${PRACTITIONER_SQL})`)
        .bind(conv.id, a, b, lang)
        .run();
      sid = ins.meta.last_row_id;
    }
    await startSession(env, provider, conv, { id: sid, state: "OFFERED", conversation_id: conv.id, service: a, intro_state: null, override_by: null, origin: "SELF" }, c, msgId);
    return true;
  }

  // ---- booking with credits ----
  if (tag === "bsv") {
    await sendAs("who", whoButtons(cp, a, "bwh"), "who");
    return true;
  }
  if (tag === "bwh" || tag === "bmo") {
    await sendDays(env, conv, "SESSION", (ymd) => `bdy_${a}_${b}_${ymd}`, msgId);
    return true;
  }
  if (tag === "bdy") {
    const ok = await sendTimes(env, conv, "SESSION", c, (u) => `btm_${a}_${b}_${u}`, `bmo_${a}_${b}`, msgId);
    if (!ok) {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      await sendDays(env, conv, "SESSION", (ymd) => `bdy_${a}_${b}_${ymd}`, `${msgId}:again`);
    }
    return true;
  }
  return bookWithCredit(env, conv, a, b as ForWhom, c, msgId); // btm

  // ---- entering a flow ----
  async function enter(f: Flow): Promise<boolean> {
    await clearStep(env.DB, conv!.id);
    if (!(await bookingsOpen(env))) {
      await send({ type: "text", text: cp.bookSoon }, "book");
      return true;
    }
    if (await blocked(env, conv!)) return true;
    if (!conv!.age_ok_at) {
      await sendAs("age", ageButtons(cp, `_${f}`), "age");
      return true;
    }
    if (f === "s") await sendAs("service", serviceButtons(cp, "ssv"), "service");
    else await startPackage(env, provider, conv!, f, msgId);
    return true;
  }
  async function enterCredit(): Promise<boolean> {
    await clearStep(env.DB, conv!.id);
    if (!(await bookingsOpen(env))) {
      await send({ type: "text", text: cp.bookSoon }, "book");
      return true;
    }
    if (await blocked(env, conv!)) return true;
    if ((await creditBalance(env.DB, conv!.id)) <= 0) {
      await send({ type: "text", text: cp.noCredits }, "nocredit");
      return true;
    }
    if ((await upcomingSessionCount(env.DB, conv!.id)) >= config.sessionRules.maxUpcoming) {
      await send({ type: "text", text: cp.maxUpcoming }, "max");
      return true;
    }
    if (!conv!.age_ok_at) {
      await sendAs("age", ageButtons(cp, "_b"), "age");
      return true;
    }
    await sendAs("service", serviceButtons(cp, "bsv"), "service");
    return true;
  }
}

// ---- buying a package: a Razorpay link for the price, no slot held ----
async function startPackage(env: Env, provider: PaymentProvider, conv: Conv, f: PackFlow, msgId: string): Promise<void> {
  const db = env.DB;
  const cp = copyFor(conv.locale);
  const pack = FLOWS[f];
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  const nowMs = Date.now();

  // One open package payment per person: a second tap shows the first link's message again instead of making another link.
  const open = await db
    .prepare(
      `SELECT 1 FROM payments p JOIN packages k ON p.purpose = 'PACKAGE' AND k.id = p.target_id
       WHERE k.conversation_id = ?1 AND p.state IN ('CREATING', 'PENDING') AND p.created_at > ?2`,
    )
    .bind(conv.id, iso(nowMs - config.sessionRules.packageLinkMinutes * 60_000))
    .first();
  if (open) {
    await send({ type: "text", text: cp.packPending }, "pending");
    return;
  }

  const pk = await db.prepare("INSERT INTO packages (conversation_id, size, price_paise) VALUES (?1, ?2, ?3)").bind(conv.id, pack.sessions, pack.paise).run();
  const packageId = pk.meta.last_row_id;
  const linkId = `di-pack-${packageId}-${nowMs}`; // unique per attempt, <= 40 chars (Razorpay reference_id limit)
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay', 'PACKAGE', ?1, ?2, ?3)")
    .bind(packageId, linkId, pack.paise)
    .run();
  const payId = pay.meta.last_row_id;
  const expires = iso(nowMs + config.sessionRules.packageLinkMinutes * 60_000);
  try {
    const link = await provider.createLink({
      linkId,
      amountPaise: pack.paise,
      purpose: "Disha Dira session package",
      customerName: conv.display_name ?? "Customer",
      customerPhone: conv.wa_id.replace(/\D/g, "").slice(-10),
      expiresAtUtc: expires,
    });
    await db.batch([
      db.prepare("UPDATE payments SET state = 'PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()),
      db.prepare("UPDATE packages SET state = 'PENDING', payment_id = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'CREATING'").bind(packageId, payId, nowIso()),
    ]);
    const price = packPrice(pack.sessions);
    await sendStep(env, conv.id, "pay", { type: "cta", body: cp.packPayBody(pack.sessions, price), label: cp.packPayLabel(price), url: link.url }, `${msgId}:pay`, { until: expires });
  } catch {
    await db.batch([
      db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()),
      db.prepare("UPDATE packages SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(packageId, nowIso()),
    ]);
    await raiseAttention(db, "LINK_CREATE_FAILED", `package:${packageId}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}

// ---- payment received: +N credits, once ----
// Called by src/pay/apply.ts for a verified PAID package payment. The package moves to PAID and the PURCHASE row is added in one batch;
// the unique index credits_purchase and the state guard mean a replay changes nothing and sends nothing twice.
export async function creditPackage(env: Env, paymentId: number, packageId: number): Promise<"CREDITED" | "NOOP"> {
  const db = env.DB;
  const now = nowIso();
  const [moved] = await db.batch([
    db.prepare("UPDATE packages SET state = 'PAID', payment_id = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ('CREATING', 'PENDING', 'EXPIRED', 'FAILED')").bind(packageId, paymentId, now),
    db
      .prepare(
        `INSERT INTO credits (package_id, delta, reason, at, by)
         SELECT id, size, 'PURCHASE', ?2, 'system' FROM packages WHERE id = ?1 AND state = 'PAID' AND payment_id = ?3
           AND NOT EXISTS (SELECT 1 FROM credits WHERE package_id = ?1 AND reason = 'PURCHASE')`,
      )
      .bind(packageId, now, paymentId),
  ]);
  return moved.meta.changes ? "CREDITED" : "NOOP";
}

// ---- booking a session with a credit: one guarded batch ----
type CreditResult = { ok: true; sessionId: number } | { ok: false; reason: "NO_CREDIT" | "MAX_UPCOMING" | "SLOT_TAKEN" };

export async function bookCredit(db: D1Database, convId: number, service: string, forWhom: ForWhom, lang: string, startUtc: string, nowMs = Date.now()): Promise<CreditResult> {
  const slot = generateSlots(istDay(Date.parse(startUtc)), "SESSION").find((s) => s.startUtc === startUtc);
  if (!slot || startUtc <= iso(nowMs + config.booking.leadMinutes * 60_000)) return { ok: false, reason: "SLOT_TAKEN" };
  const now = iso(nowMs);
  const params = { conv: convId, start: slot.startUtc, end: slot.endUtc, now, service, who: forWhom, lang, max: config.sessionRules.maxUpcoming };
  const stmt = (sql: string) => bind(db, sql, params);
  const PACKAGE = `(SELECT k.id FROM packages k WHERE k.conversation_id = :conv AND k.state = 'PAID' AND (SELECT COALESCE(SUM(delta), 0) FROM credits WHERE package_id = k.id) > 0 ORDER BY k.id LIMIT 1)`;
  const results = await db.batch([
    // 1. The slot, booked at once, only if it is free, there is a credit, and fewer than the allowed sessions are upcoming.
    stmt(
      `INSERT INTO slots (kind, start_utc, end_utc, owner_id, state, hold_until, practitioner_id)
       SELECT 'SESSION', :start, :end, :conv, 'BOOKED', NULL, ${PRACTITIONER_SQL}
       WHERE NOT EXISTS (SELECT 1 FROM slots WHERE (state = 'BOOKED' OR hold_until > :now) AND start_utc < :end AND end_utc > :start)
         AND ${BALANCE} > 0
         AND (SELECT COUNT(*) FROM sessions se JOIN slots sl ON sl.id = se.slot_id
              WHERE se.conversation_id = :conv AND se.state IN ('CREDIT_BOOKED', 'CONFIRMED') AND sl.end_utc > :now) < :max
       ON CONFLICT (kind, start_utc) DO UPDATE SET owner_id = :conv, state = 'BOOKED', hold_until = NULL, end_utc = :end
         WHERE NOT (slots.state = 'BOOKED' OR slots.hold_until > :now)`,
    ),
    // 2. The session, on that slot, only if the slot is the one just booked for this person and no session uses it yet.
    stmt(
      `INSERT INTO sessions (conversation_id, slot_id, service, for_whom, call_lang, origin, state, package_id, created_at, updated_at, practitioner_id)
       SELECT :conv, sl.id, :service, :who, :lang, 'CREDIT', 'CREDIT_BOOKED', ${PACKAGE}, :now, :now, sl.practitioner_id
       FROM slots sl
       WHERE sl.kind = 'SESSION' AND sl.start_utc = :start AND sl.owner_id = :conv AND sl.state = 'BOOKED'
         AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.slot_id = sl.id AND x.state IN ('HELD', 'CONFIRMED', 'CREDIT_BOOKED')) AND ${PACKAGE} IS NOT NULL`,
    ),
    // 3. The -1 on the ledger, once per session (also enforced by the unique index credits_book).
    stmt(
      `INSERT INTO credits (package_id, delta, reason, session_id, at, by)
       SELECT se.package_id, -1, 'BOOK', se.id, :now, 'customer' FROM sessions se JOIN slots sl ON sl.id = se.slot_id
       WHERE se.conversation_id = :conv AND sl.kind = 'SESSION' AND sl.start_utc = :start AND se.state = 'CREDIT_BOOKED' AND se.origin = 'CREDIT'
         AND se.package_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credits WHERE session_id = se.id AND reason = 'BOOK')`,
    ),
    // 4. A slot booked above that did not get a session (cannot happen, but must never stay taken): free it.
    stmt(
      `UPDATE slots SET state = 'HELD', hold_until = :now
       WHERE kind = 'SESSION' AND start_utc = :start AND owner_id = :conv AND state = 'BOOKED' AND NOT EXISTS (SELECT 1 FROM sessions WHERE slot_id = slots.id AND state IN ('HELD', 'CONFIRMED', 'CREDIT_BOOKED'))`,
    ),
  ]);
  // Only this call's own insert counts: a slot that was already booked (a double tap, a replay) is not a second booking.
  if (results[1].meta.changes > 0) return { ok: true, sessionId: results[1].meta.last_row_id };
  if ((await creditBalance(db, convId)) <= 0) return { ok: false, reason: "NO_CREDIT" };
  if ((await upcomingSessionCount(db, convId, nowMs)) >= config.sessionRules.maxUpcoming) return { ok: false, reason: "MAX_UPCOMING" };
  return { ok: false, reason: "SLOT_TAKEN" };
}

async function bookWithCredit(env: Env, conv: Conv, service: string, forWhom: ForWhom, startUtc: string, msgId: string): Promise<boolean> {
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const res = await bookCredit(env.DB, conv.id, service, forWhom, lang, startUtc);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  if (!res.ok) {
    if (res.reason === "NO_CREDIT") await send({ type: "text", text: cp.noCredits }, "nocredit");
    else if (res.reason === "MAX_UPCOMING") await send({ type: "text", text: cp.maxUpcoming }, "max");
    else {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      const ok = await sendTimes(env, conv, "SESSION", istDay(Date.parse(startUtc)), (u) => `btm_${service}_${forWhom}_${u}`, `bmo_${service}_${forWhom}`, `${msgId}:again`);
      if (!ok) await sendDays(env, conv, "SESSION", (ymd) => `bdy_${service}_${forWhom}_${ymd}`, `${msgId}:again`);
    }
    return true;
  }
  const left = await creditBalance(env.DB, conv.id);
  const en = formatIstLang(startUtc, "en");
  const hi = formatIstLang(startUtc, "hi");
  const p = lang === "hi" ? hi : en;
  await sendOrTemplate(
    env,
    conv.id,
    { type: "text", text: cp.creditBooked(p.day, p.time, left) },
    { type: "template", name: "session_booked", params: [en.day, en.time, String(left)], paramsHi: [hi.day, hi.time, String(left)] },
    `${msgId}:booked`,
  );
  return true;
}

// ---- stopping a package (Rohit, in /admin): unused sessions x the package rate ----
export type UnusedRefund =
  | { kind: "REFUNDED" | "MANUAL"; unused: number; paise: number }
  | { kind: "NOTHING" }
  | { kind: "STALE" };

// The rate per session is the package price divided by its size (₹500 for the 10-pack, ₹450 for the 20-pack).
export async function unusedOf(db: D1Database, packageId: number) {
  return db
    .prepare(
      `SELECT k.id, k.conversation_id AS conv, k.size, k.price_paise AS price, k.state, k.payment_id AS payId,
              (SELECT COALESCE(SUM(delta), 0) FROM credits WHERE package_id = k.id) AS unused,
              COALESCE(p.updated_at, p.created_at) AS paidAt
       FROM packages k LEFT JOIN payments p ON p.id = k.payment_id WHERE k.id = ?1`,
    )
    .bind(packageId)
    .first<{ id: number; conv: number; size: number; price: number; state: string; payId: number | null; unused: number; paidAt: string | null }>();
}

// The balance goes to 0 in one batch (the REFUND ledger row, only if the balance is still what Rohit confirmed, and the package closes).
// Then the money: Razorpay if the payment is under 180 days old, otherwise a MANUAL_REFUND item for Rohit to pay by bank or UPI.
export async function refundUnused(env: Env, provider: PaymentProvider, packageId: number, expectedUnused: number, by: string): Promise<UnusedRefund> {
  const db = env.DB;
  const pk = await unusedOf(db, packageId);
  if (!pk || pk.state !== "PAID" || pk.unused <= 0) return { kind: "NOTHING" };
  if (pk.unused !== expectedUnused) return { kind: "STALE" };
  const now = nowIso();
  const [wrote] = await db.batch([
    db
      .prepare(
        `INSERT INTO credits (package_id, delta, reason, at, by)
         SELECT ?1, -SUM(delta), 'REFUND', ?2, ?3 FROM credits WHERE package_id = ?1 HAVING SUM(delta) = ?4`,
      )
      .bind(packageId, now, by, expectedUnused),
    db
      .prepare("UPDATE packages SET state = 'CLOSED', updated_at = ?2 WHERE id = ?1 AND state = 'PAID' AND (SELECT COALESCE(SUM(delta), 0) FROM credits WHERE package_id = ?1) = 0")
      .bind(packageId, now),
  ]);
  if (!wrote.meta.changes) return { kind: "STALE" };
  const rate = pk.price / pk.size;
  const paise = Math.round(expectedUnused * rate);
  const old = pk.paidAt === null || Date.now() - Date.parse(pk.paidAt) >= config.sessionRules.razorpayRefundDays * 86_400_000;
  const created = !old && pk.payId !== null ? await requestRefund(env, provider, pk.payId, "PACKAGE_UNUSED", by, paise) : null;
  if (created === "CREATED") {
    await tellRefunded(env, pk.conv, paise, `package-refund:${packageId}`);
    return { kind: "REFUNDED", unused: expectedUnused, paise };
  }
  await raiseAttention(db, "MANUAL_REFUND", `package:${packageId}`); // too old for Razorpay (or the payment already has a refund): paid by hand
  return { kind: "MANUAL", unused: expectedUnused, paise };
}

// Rohit paid it by hand and marks it done: one ledger row (delta 0) records who and when, and the customer is told.
export async function markManualRefund(env: Env, packageId: number, by: string): Promise<boolean> {
  const db = env.DB;
  const pk = await unusedOf(db, packageId);
  const last = await db.prepare("SELECT -delta AS n FROM credits WHERE package_id = ?1 AND reason = 'REFUND' ORDER BY id DESC LIMIT 1").bind(packageId).first<{ n: number }>();
  if (!pk || !last) return false;
  const res = await db
    .prepare(
      `INSERT INTO credits (package_id, delta, reason, at, by)
       SELECT ?1, 0, 'ADJUST', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM credits WHERE package_id = ?1 AND reason = 'ADJUST' AND delta = 0)`,
    )
    .bind(packageId, nowIso(), by)
    .run();
  if (!res.meta.changes) return false;
  await tellRefunded(env, pk.conv, Math.round(last.n * (pk.price / pk.size)), `package-manual:${packageId}`);
  return true;
}

async function tellRefunded(env: Env, convId: number, paise: number, key: string): Promise<void> {
  const conv = await env.DB.prepare("SELECT locale FROM conversations WHERE id = ?1").bind(convId).first<{ locale: string }>();
  const amount = rupees(paise);
  await sendOrTemplate(
    env,
    convId,
    { type: "text", text: copyFor(conv?.locale).packRefunded(amount) },
    { type: "template", name: "payment_update", params: [amount] },
    key,
  );
}
