// The ₹99 booking flow, all fixed messages (no AI):
//   menu_book -> age check (once per person) -> service -> who for -> day -> time -> one guarded step (block check, hold, intro, payment row, link).
// Every step's button id carries what was chosen so far, so the flow keeps no state of its own:
//   age_yes | age_no, svc_<SERVICE>, who_<SERVICE>_<WHO>, day_<SERVICE>_<WHO>_<ymd>, more_<SERVICE>_<WHO>, time_<SERVICE>_<WHO>_<startUtc>.
// The old list rows slot_<SERVICE>_<startUtc> (before who-for and day steps existed) are still understood; see below.
import type { D1Database } from "@cloudflare/workers-types";
import { prices } from "./business";
import { config } from "./config";
import { copyFor, langOf, type Copy, type ForWhom, type Lang } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { contactFor, razorpay } from "./pay/razorpay";
import { pausedOut } from "./menu";
import { customerPayLink, existingPayLink, untilLabel } from "./paylink";
import type { PaymentProvider } from "./pay/provider";
import { raiseAttention, sendMessage, type ListSection, type Out } from "./send";
import { clearStep, sendStep, type StepName } from "./steps";
import { availableSlots, dayLabelFor, formatIstLang, holdSlot, iso, istDay, istMinutes, nextWorkingDays, PRACTITIONER_SQL, spreadTimes, type Slot, type SlotKind } from "./slots";

export const SERVICES = config.services as readonly string[];
export const WHO: readonly ForWhom[] = ["SELF", "FAMILY", "PET"];
const nowIso = () => iso(Date.now());
const UTC = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z";
const YMD = "\\d{4}-\\d{2}-\\d{2}";

export type Conv = { id: number; wa_id: string; display_name: string | null; locale: string; age_ok_at: string | null };
export const loadConv = (db: D1Database, id: number) =>
  db.prepare("SELECT id, wa_id, display_name, locale, age_ok_at FROM conversations WHERE id = ?1").bind(id).first<Conv>();

// Free slots a customer could hold right now, per IST day: the first `window` working days that still have a free time.
// A full day (or today, late in the evening) is skipped and the next working day is looked at instead, up to config.booking.lookaheadDays.
async function freeByDay(db: D1Database, kind: SlotKind, window: number, nowMs: number): Promise<Map<string, Slot[]>> {
  const out = new Map<string, Slot[]>();
  for (const ymd of nextWorkingDays(nowMs, config.booking.lookaheadDays)) {
    if (out.size >= window) break;
    const free = await availableSlots(db, kind, ymd, nowMs + config.booking.leadMinutes * 60_000, nowMs);
    if (free.length) out.set(ymd, free);
  }
  return out;
}

// Day step: one list message with a row for each of the first config.booking.workingDays (6) days that still have a free time
// (full days and holidays are skipped). `idFor` makes each row's id; the ids are the same as the old day buttons', so a day button
// still sitting in an older chat keeps working. With no free day it sends the "no times" message (with Talk to a person and Help, ticket 31 I10) and an item instead, and returns false.
export async function sendDays(env: Env, conv: Conv, kind: SlotKind, idFor: (ymd: string) => string, key: string): Promise<boolean> {
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const days = [...(await freeByDay(env.DB, kind, config.booking.workingDays, Date.now())).entries()];
  if (!days.length) {
    await clearStep(env.DB, conv.id);
    await sendMessage(env, conv.id, pausedOut(cp, kind === "CALL" ? cp.noSlots : cp.noSessionSlots), `${key}:noslots`);
    await raiseAttention(env.DB, "NO_FREE_TIMES", `conv:${conv.id}`);
    return false;
  }
  const split = eveningMinutes();
  const rows = days.map(([ymd, free]) => {
    const afternoon = free.some((s) => istMinutes(s.startUtc) < split);
    const evening = free.some((s) => istMinutes(s.startUtc) >= split);
    return { id: idFor(ymd), title: dayLabelFor(ymd, lang), description: afternoon && evening ? cp.rowDayBoth : afternoon ? cp.rowDayAfternoon : cp.rowDayEvening };
  });
  await sendStep(env, conv.id, "day", { type: "list", body: cp.chooseDay, button: cp.listButtonDays, rows }, `${key}:days`);
  return true;
}
const eveningMinutes = () => Number(config.booking.eveningFrom.slice(0, 2)) * 60 + Number(config.booking.eveningFrom.slice(3));

// Time step for one day: at most 9 times (the spread rule), then "Another day". Two sections, Afternoon and Evening, never an empty one.
// Returns false when the day has no free slot any more (the caller then sends the day step instead).
export async function sendTimes(env: Env, conv: Conv, kind: SlotKind, ymd: string, idFor: (startUtc: string) => string, moreId: string, key: string): Promise<boolean> {
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const free = await availableSlots(env.DB, kind, ymd, Date.now() + config.booking.leadMinutes * 60_000, Date.now());
  if (!free.length) return false;
  const picked = spreadTimes(free, config.booking.timeRows);
  const split = eveningMinutes();
  const row = (s: Slot) => ({ id: idFor(s.startUtc), title: formatIstLang(s.startUtc, lang).time, description: kind === "CALL" ? cp.rowCall : cp.rowSession });
  const sections: ListSection[] = [
    { title: cp.sectionAfternoon, rows: picked.filter((s) => istMinutes(s.startUtc) < split).map(row) },
    { title: cp.sectionEvening, rows: picked.filter((s) => istMinutes(s.startUtc) >= split).map(row) },
  ].filter((x) => x.rows.length > 0);
  sections[sections.length - 1].rows.push({ id: moreId, title: cp.anotherDay });
  const day = formatIstLang(picked[0].startUtc, lang).day;
  await sendStep(env, conv.id, "time", { type: "list", body: kind === "CALL" ? cp.timesFor(day) : cp.sessionTimesFor(day), button: cp.listButtonTimes, sections }, `${key}:times`);
  return true;
}

// The same three steps serve the ₹99 call (ids age_yes, svc_, who_) and the session flows in src/packages.ts, which pass their own id prefix.
export const ageButtons = (cp: Copy, suffix = ""): Out => ({
  type: "buttons",
  body: cp.ageCheck,
  buttons: [
    { id: `age_yes${suffix}`, title: cp.btnYes },
    { id: `age_no${suffix}`, title: cp.btnNo },
  ],
});
export const serviceButtons = (cp: Copy, prefix = "svc"): Out => ({
  type: "buttons",
  body: cp.chooseService,
  buttons: [
    { id: `${prefix}_HEALING`, title: cp.btnHealing },
    { id: `${prefix}_PROTECTION`, title: cp.btnCleansing },
  ],
});

export const whoButtons = (cp: Copy, service: string, prefix = "who"): Out => ({
  type: "buttons",
  body: cp.whoFor,
  buttons: [
    { id: `${prefix}_${service}_SELF`, title: cp.btnMe },
    { id: `${prefix}_${service}_FAMILY`, title: cp.btnFamily },
    { id: `${prefix}_${service}_PET`, title: cp.btnPet },
  ],
});

// Handles every booking id above, plus the legacy slot_<SERVICE>_<startUtc>. Returns false for any other choice.
export async function bookingChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = razorpay(env)): Promise<boolean> {
  if (!choice) return false;
  const svc = /^svc_([A-Z]+)$/.exec(choice);
  const who = new RegExp(`^who_([A-Z]+)_([A-Z]+)$`).exec(choice);
  const day = new RegExp(`^day_([A-Z]+)_([A-Z]+)_(${YMD})$`).exec(choice);
  const more = /^more_([A-Z]+)_([A-Z]+)$/.exec(choice);
  const time = new RegExp(`^time_([A-Z]+)_([A-Z]+)_(${UTC})$`).exec(choice);
  const legacy = new RegExp(`^slot_([A-Z]+)_(${UTC})$`).exec(choice);
  const named = svc ?? who ?? day ?? more ?? time ?? legacy;
  const isEntry = choice === "menu_book" || choice === "age_yes" || choice === "age_no";
  if (!isEntry && !named) return false;
  if (named && (!SERVICES.includes(named[1]) || (!svc && !legacy && !WHO.includes(named[2] as ForWhom)))) return false;

  const conv = await loadConv(env.DB, convId);
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);
  const sendAs = (name: StepName, out: Out, step: string) => sendStep(env, conv.id, name, out, `${msgId}:${step}`);
  await clearStep(env.DB, conv.id); // whatever step was open is over; the step sent below (if any) becomes the open one

  // Checked at the tap, not at the end of the flow: someone who already has a call is told so and nothing else happens (AGENT.md 3.1a).
  if (choice === "menu_book") {
    const upcoming = await upcomingCall(env.DB, conv.id);
    if (upcoming) {
      const p = formatIstLang(upcoming, langOf(conv.locale));
      await send(
        {
          type: "buttons",
          body: cp.alreadyBookedStart(p.day, p.time),
          buttons: [
            { id: "book_keep", title: cp.btnKeep },
            { id: "menu_person", title: cp.btnPerson },
          ],
        },
        "booked",
      );
      return true;
    }
  }

  if (!(await bookingsOpen(env))) {
    await send(pausedOut(cp), "book"); // switch is off: booking stays closed
    return true;
  }

  // The age check: asked once. A "No" is not remembered, so a parent or guardian writing from the same phone can answer Yes later.
  if (choice === "age_no") {
    await send({ type: "text", text: cp.ageNo }, "ageno");
    return true;
  }
  if (choice === "age_yes") {
    await env.DB.prepare("UPDATE conversations SET age_ok_at = COALESCE(age_ok_at, ?2) WHERE id = ?1").bind(conv.id, nowIso()).run();
    await sendAs("service", serviceButtons(cp), "service");
    return true;
  }
  if (!conv.age_ok_at) {
    // Nothing past this point (not even an old button still sitting in the chat) works until the person has said they are 18 or older.
    await sendAs("age", ageButtons(cp), "age");
    return true;
  }

  if (choice === "menu_book") {
    await sendAs("service", serviceButtons(cp), "service");
    return true;
  }
  if (svc) {
    await sendAs("who", whoButtons(cp, svc[1]), "who");
    return true;
  }
  if (legacy) {
    // A time-list row from before the day and who-for steps existed: the person already picked this exact time, so it is held as before.
    // (The age check above has already been passed, or asked.) Who the call is for was never said, so it stays empty.
    await startBooking(env, provider, conv, legacy[1], null, legacy[2], msgId);
    return true;
  }
  if (who || more) {
    const [, service, forWhom] = (who ?? more)!;
    await sendDays(env, conv, "CALL", (ymd) => `day_${service}_${forWhom}_${ymd}`, msgId);
    return true;
  }
  if (day) {
    await showTimes(env, conv, day[1], day[2] as ForWhom, day[3], msgId);
    return true;
  }
  const [, service, forWhom, startUtc] = time!;
  await startBooking(env, provider, conv, service, forWhom as ForWhom, startUtc, msgId);
  return true;
}

// The start of a call the person has paid for (PAID or RESCHEDULED) that has not ended yet, or null.
async function upcomingCall(db: D1Database, convId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT s.start_utc AS startUtc FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.conversation_id = ?1 AND i.state IN ('PAID', 'RESCHEDULED') AND s.end_utc > ?2 ORDER BY s.start_utc LIMIT 1`,
    )
    .bind(convId, nowIso())
    .first<{ startUtc: string }>();
  return row?.startUtc ?? null;
}

// The ₹99 call this person is holding right now (HELD, hold not expired), with its payment, or null.
type Held = { introId: number; slotId: number; startUtc: string; holdUntil: string; payId: number | null; payState: string | null };
async function liveHeldCall(db: D1Database, convId: number): Promise<Held | null> {
  return db
    .prepare(
      `SELECT i.id AS introId, s.id AS slotId, s.start_utc AS startUtc, s.hold_until AS holdUntil, p.id AS payId, p.state AS payState
       FROM intros i JOIN slots s ON s.id = i.slot_id
       LEFT JOIN payments p ON p.id = (SELECT MAX(id) FROM payments WHERE purpose = 'INTRO' AND target_id = i.id)
       WHERE i.conversation_id = ?1 AND i.state = 'HELD' AND s.state = 'HELD' AND s.owner_id = ?1 AND s.hold_until > ?2 LIMIT 1`,
    )
    .bind(convId, nowIso())
    .first<Held>();
}

// A different time picked while a hold is unpaid: the old hold goes (its payment FAILED, so our /p/ link says expired and the cron stops
// asking about it; the intro EXPIRED; the slot freed). If the old Razorpay link is still paid, the late-payment and duplicate rules apply.
async function releaseHeld(db: D1Database, h: Held): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE purpose = 'INTRO' AND target_id = ?1 AND state IN ('CREATING', 'PENDING')").bind(h.introId, now),
    db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1 AND state = 'HELD'").bind(h.introId, now),
    db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(h.slotId, now),
  ]);
}

// The times of one day; if the day filled up meanwhile, say so and show the days again.
async function showTimes(env: Env, conv: Conv, service: string, forWhom: ForWhom, ymd: string, msgId: string): Promise<void> {
  const ok = await sendTimes(env, conv, "CALL", ymd, (u) => `time_${service}_${forWhom}_${u}`, `more_${service}_${forWhom}`, msgId);
  if (ok) return;
  await sendMessage(env, conv.id, { type: "text", text: copyFor(conv.locale).slotTaken }, `${msgId}:taken`);
  await sendDays(env, conv, "CALL", (d) => `day_${service}_${forWhom}_${d}`, `${msgId}:again`);
}

// Next free call slots over the booking window (used for the reschedule offer after a missed call).
export async function freeCallSlots(env: Env, nowMs: number): Promise<Slot[]> {
  return [...(await freeByDay(env.DB, "CALL", config.booking.workingDays, nowMs)).values()].flat();
}

async function startBooking(env: Env, provider: PaymentProvider, conv: Conv, service: string, forWhom: ForWhom | null, startUtc: string, msgId: string): Promise<void> {
  const db = env.DB;
  const cp = copyFor(conv.locale);
  const lang: Lang = langOf(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  // 1. Blocklist, before anything is held or created.
  const blocked = await db.prepare("SELECT 1 FROM blocks WHERE wa_id = ?1").bind(conv.wa_id).first();
  if (blocked) {
    await db.prepare("UPDATE conversations SET mode = 'BLOCKED' WHERE id = ?1").bind(conv.id).run();
    return;
  }

  // 1b. One open intro per person: a paid call that has not ended yet (the same rule as the check at the Book tap and My bookings).
  // A past call that is still waiting for an outcome tap does not block: it is the practitioner's AMMA_NO_TAP item (src/watch.ts).
  const upcoming = await upcomingCall(db, conv.id);
  if (upcoming) {
    const p = formatIstLang(upcoming, lang);
    await send({ type: "text", text: cp.callAlreadyBooked(p.day, p.time) }, "booked");
    return;
  }
  // 1c. An unpaid hold is not a booking (ticket 31, B2). The same time again: the pay step again, with the same link. Another time: the old hold goes.
  const held = await liveHeldCall(db, conv.id);
  if (held && held.startUtc === startUtc) {
    const link = held.payId !== null && held.payState === "PENDING" ? await existingPayLink(env, held.payId) : null;
    if (!link) {
      await send({ type: "text", text: cp.alreadyHolding }, "holding");
      return;
    }
    const p = formatIstLang(startUtc, lang);
    await sendStep(env, conv.id, "pay", { type: "cta", body: cp.stillHeld(p.day, p.time, untilLabel(held.holdUntil, conv.locale), link), label: cp.payLabel, url: link }, `${msgId}:stillheld`, { until: held.holdUntil });
    return;
  }
  if (held) await releaseHeld(db, held);

  // 2. Hold the slot (one atomic write).
  const nowMs = Date.now();
  const hold = await holdSlot(db, { kind: "CALL", startUtc, ownerId: conv.id, nowMs });
  if (!hold.ok) {
    if (hold.reason === "ALREADY_HOLDING") await send({ type: "text", text: cp.alreadyHolding }, "holding");
    else if (hold.reason === "TOO_SOON") {
      // An old list row whose time has passed (or starts within the booking lead): say so, then the times again (B1).
      await send({ type: "text", text: cp.timePassed }, "toosoon");
      const ymd = istDay(Date.parse(startUtc));
      if (!forWhom) await sendStep(env, conv.id, "who", whoButtons(cp, service), `${msgId}:who`);
      else if (!(await sendTimes(env, conv, "CALL", ymd, (u) => `time_${service}_${forWhom}_${u}`, `more_${service}_${forWhom}`, `${msgId}:again`)))
        await sendDays(env, conv, "CALL", (d) => `day_${service}_${forWhom}_${d}`, `${msgId}:again`);
    } else {
      await send({ type: "text", text: cp.slotTaken }, "taken");
      // A legacy row has no "who for" yet, so the flow goes on from that step; otherwise the same day's times again.
      if (forWhom) await showTimes(env, conv, service, forWhom, istDay(Date.parse(startUtc)), `${msgId}:again`);
      else await sendStep(env, conv.id, "who", whoButtons(cp, service), `${msgId}:who`);
    }
    return;
  }
  const slot = await db.prepare("SELECT id FROM slots WHERE kind = 'CALL' AND start_utc = ?1 AND owner_id = ?2").bind(startUtc, conv.id).first<{ id: number }>();

  // 3. Intro (HELD) and payment (CREATING), then the link. The call is in the language of this chat.
  const intro = await db
    .prepare(`INSERT INTO intros (conversation_id, slot_id, service, for_whom, call_lang, practitioner_id) VALUES (?1, ?2, ?3, ?4, ?5, ${PRACTITIONER_SQL})`)
    .bind(conv.id, slot?.id ?? null, service, forWhom, lang)
    .run();
  const introId = intro.meta.last_row_id;
  const linkId = `di-intro-${introId}`; // unique, tied to the intro; <= 40 chars (Razorpay reference_id limit)
  const amount = prices().intro; // the price in force (src/business.ts), read once for the row and the link
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay', 'INTRO', ?1, ?2, ?3)")
    .bind(introId, linkId, amount)
    .run();
  const payId = pay.meta.last_row_id;

  try {
    // Expiry = the hold, which is no earlier than the provider minimum (checked in config.test.ts).
    const link = await provider.createLink({
      linkId,
      amountPaise: amount,
      purpose: "Disha Dira call booking",
      customerName: conv.display_name ?? "Customer",
      customerPhone: contactFor(conv.wa_id),
      expiresAtUtc: hold.holdUntil,
    });
    await db.prepare("UPDATE payments SET state = 'PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    const p = formatIstLang(startUtc, lang);
    const url = await customerPayLink(env, payId, link.url, hold.holdUntil); // our /p/ link, never Razorpay's own (src/paylink.ts)
    await sendStep(env, conv.id, "pay", { type: "cta", body: cp.payBody(p.day, p.time, untilLabel(hold.holdUntil, conv.locale), url), label: cp.payLabel, url }, `${msgId}:pay`, { until: hold.holdUntil });
  } catch {
    // No link: free the hold. If a link did get created and is paid later, the late-payment rules apply.
    await db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1").bind(introId, nowIso()).run();
    await db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(slot?.id ?? 0, nowIso()).run();
    await raiseAttention(db, "LINK_CREATE_FAILED", `intro:${introId}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}
