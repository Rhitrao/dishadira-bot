// The ₹99 booking flow, all fixed messages (no AI):
//   menu_book -> age check (once per person) -> service -> who for -> day -> time -> one guarded step (block check, hold, intro, payment row, link).
// Every step's button id carries what was chosen so far, so the flow keeps no state of its own:
//   age_yes | age_no, svc_<SERVICE>, who_<SERVICE>_<WHO>, day_<SERVICE>_<WHO>_<ymd>, more_<SERVICE>_<WHO>, time_<SERVICE>_<WHO>_<startUtc>.
// The old list rows slot_<SERVICE>_<startUtc> (before who-for and day steps existed) are still understood; see below.
import type { D1Database } from "@cloudflare/workers-types";
import { config } from "./config";
import { copyFor, langOf, type Copy, type ForWhom, type Lang } from "./copy";
import type { Env } from "./env";
import { bookingsOpen } from "./switches";
import { razorpay } from "./pay/razorpay";
import type { PaymentProvider } from "./pay/provider";
import { raiseAttention, sendMessage, type ListSection, type Out } from "./send";
import { clearStep, sendStep, type StepName } from "./steps";
import { availableSlots, dayLabelFor, formatIstLang, holdSlot, iso, istDay, istMinutes, nextWorkingDays, spreadTimes, type Slot, type SlotKind } from "./slots";

const SERVICES = config.services as readonly string[];
const WHO: readonly ForWhom[] = ["SELF", "FAMILY", "PET"];
const nowIso = () => iso(Date.now());
const UTC = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z";
const YMD = "\\d{4}-\\d{2}-\\d{2}";

export type Conv = { id: number; wa_id: string; display_name: string | null; locale: string; age_ok_at: string | null };
export const loadConv = (db: D1Database, id: number) =>
  db.prepare("SELECT id, wa_id, display_name, locale, age_ok_at FROM conversations WHERE id = ?1").bind(id).first<Conv>();

// Free slots a customer could hold right now, per IST day, for the first `window` working days.
async function freeByDay(db: D1Database, kind: SlotKind, window: number, nowMs: number): Promise<Map<string, Slot[]>> {
  const out = new Map<string, Slot[]>();
  for (const ymd of nextWorkingDays(nowMs, window)) {
    const free = await availableSlots(db, kind, ymd, nowMs + config.booking.leadMinutes * 60_000, nowMs);
    if (free.length) out.set(ymd, free); // a full day is skipped
  }
  return out;
}

// Day step: up to 3 reply buttons for days that still have a free slot. `idFor` makes each button's id.
// With no free day it sends the "no times" text instead and returns false.
export async function sendDays(env: Env, conv: Conv, kind: SlotKind, idFor: (ymd: string) => string, key: string): Promise<boolean> {
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const days = [...(await freeByDay(env.DB, kind, kind === "CALL" ? config.booking.workingDays : 5, Date.now())).keys()].slice(0, config.booking.dayButtons);
  if (!days.length) {
    await clearStep(env.DB, conv.id);
    await sendMessage(env, conv.id, { type: "text", text: kind === "CALL" ? cp.noSlots : cp.noSessionSlots }, `${key}:noslots`);
    return false;
  }
  await sendStep(env, conv.id, "day", { type: "buttons", body: cp.chooseDay, buttons: days.map((ymd) => ({ id: idFor(ymd), title: dayLabelFor(ymd, lang) })) }, `${key}:days`);
  return true;
}

// Time step for one day: at most 9 times (the spread rule), then "Another day". Two sections, Afternoon and Evening, never an empty one.
// Returns false when the day has no free slot any more (the caller then sends the day step instead).
export async function sendTimes(env: Env, conv: Conv, kind: SlotKind, ymd: string, idFor: (startUtc: string) => string, moreId: string, key: string): Promise<boolean> {
  const cp = copyFor(conv.locale);
  const lang = langOf(conv.locale);
  const free = await availableSlots(env.DB, kind, ymd, Date.now() + config.booking.leadMinutes * 60_000, Date.now());
  if (!free.length) return false;
  const picked = spreadTimes(free, config.booking.timeRows);
  const split = Number(config.booking.eveningFrom.slice(0, 2)) * 60 + Number(config.booking.eveningFrom.slice(3));
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

const ageButtons = (cp: Copy): Out => ({
  type: "buttons",
  body: cp.ageCheck,
  buttons: [
    { id: "age_yes", title: cp.btnYes },
    { id: "age_no", title: cp.btnNo },
  ],
});
const serviceButtons = (cp: Copy): Out => ({
  type: "buttons",
  body: cp.chooseService,
  buttons: [
    { id: "svc_HEALING", title: cp.btnHealing },
    { id: "svc_PROTECTION", title: cp.btnCleansing },
  ],
});

const whoButtons = (cp: Copy, service: string): Out => ({
  type: "buttons",
  body: cp.whoFor,
  buttons: [
    { id: `who_${service}_SELF`, title: cp.btnMe },
    { id: `who_${service}_FAMILY`, title: cp.btnFamily },
    { id: `who_${service}_PET`, title: cp.btnPet },
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
    await send({ type: "text", text: cp.bookSoon }, "book"); // switch is off: booking stays closed
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

  // 1b. One open intro per person: PAID (call not done yet) or HELD with a live hold.
  const open = await db
    .prepare(
      `SELECT s.start_utc AS startUtc FROM intros i JOIN slots s ON s.id = i.slot_id
       WHERE i.conversation_id = ?1 AND (i.state = 'PAID' OR (i.state = 'HELD' AND s.hold_until > ?2)) LIMIT 1`,
    )
    .bind(conv.id, nowIso())
    .first<{ startUtc: string }>();
  if (open) {
    const p = formatIstLang(open.startUtc, lang);
    await send({ type: "text", text: cp.callAlreadyBooked(p.day, p.time) }, "booked");
    return;
  }

  // 2. Hold the slot (one atomic write).
  const nowMs = Date.now();
  const hold = await holdSlot(db, { kind: "CALL", startUtc, ownerId: conv.id, nowMs });
  if (!hold.ok) {
    if (hold.reason === "ALREADY_HOLDING") await send({ type: "text", text: cp.alreadyHolding }, "holding");
    else {
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
    .prepare("INSERT INTO intros (conversation_id, slot_id, service, for_whom, call_lang) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(conv.id, slot?.id ?? null, service, forWhom, lang)
    .run();
  const introId = intro.meta.last_row_id;
  const linkId = `di-intro-${introId}`; // unique, tied to the intro; <= 40 chars (Razorpay reference_id limit)
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('razorpay', 'INTRO', ?1, ?2, ?3)")
    .bind(introId, linkId, config.prices.introPaise)
    .run();
  const payId = pay.meta.last_row_id;

  try {
    // Expiry = the hold, which is no earlier than the provider minimum (checked in config.test.ts).
    const link = await provider.createLink({
      linkId,
      amountPaise: config.prices.introPaise,
      purpose: "Disha Dira call booking",
      customerName: conv.display_name ?? "Customer",
      customerPhone: conv.wa_id.replace(/\D/g, "").slice(-10),
      expiresAtUtc: hold.holdUntil,
    });
    await db.prepare("UPDATE payments SET state = 'PENDING', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    const p = formatIstLang(startUtc, lang);
    await sendStep(env, conv.id, "pay", { type: "cta", body: cp.payBody(p.day, p.time), label: cp.payLabel, url: link.url }, `${msgId}:pay`, { until: hold.holdUntil });
  } catch {
    // No link: free the hold. If a link did get created and is paid later, the late-payment rules apply.
    await db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1").bind(introId, nowIso()).run();
    await db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(slot?.id ?? 0, nowIso()).run();
    await raiseAttention(db, "LINK_CREATE_FAILED", `intro:${introId}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}
