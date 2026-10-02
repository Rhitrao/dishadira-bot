// The ₹99 booking flow: service -> call-slot list -> one guarded step (block check, hold, intro, payment row, link).
import { config } from "./config";
import { copyFor } from "./copy";
import type { Env } from "./env";
import { cashfree } from "./pay/cashfree";
import type { PaymentProvider } from "./pay/provider";
import { raiseAttention, sendMessage, type Out } from "./send";
import { availableSlots, formatIst, formatIstParts, holdSlot, iso, nextWorkingDays, type Slot } from "./slots";

const SERVICES = config.services as readonly string[];
const nowIso = () => iso(Date.now());

type Conv = { id: number; wa_id: string; display_name: string | null; locale: string };

// Handles menu_book, svc_<SERVICE> and slot_<SERVICE>_<startUtc>. Returns false for any other choice.
export async function bookingChoice(env: Env, choice: string | null, convId: number, msgId: string, provider: PaymentProvider = cashfree(env)): Promise<boolean> {
  if (!choice || !(choice === "menu_book" || choice.startsWith("svc_") || choice.startsWith("slot_"))) return false;
  const conv = await env.DB.prepare("SELECT id, wa_id, display_name, locale FROM conversations WHERE id = ?1").bind(convId).first<Conv>();
  if (!conv) return false;
  const cp = copyFor(conv.locale);
  const send = (out: Out, step: string) => sendMessage(env, conv.id, out, `${msgId}:${step}`);

  if (env.NEW_BOOKINGS !== "true") {
    await send({ type: "text", text: cp.bookSoon }, "book"); // switch is off: booking stays closed
    return true;
  }
  if (choice === "menu_book") {
    await send(
      {
        type: "buttons",
        body: cp.chooseService,
        buttons: [
          { id: "svc_PROTECTION", title: cp.btnProtection },
          { id: "svc_HEALING", title: cp.btnHealing },
        ],
      },
      "service",
    );
    return true;
  }
  if (choice.startsWith("svc_")) {
    const service = choice.slice(4);
    if (!SERVICES.includes(service)) return false;
    await sendSlotList(env, conv, service, msgId);
    return true;
  }
  const m = /^slot_([A-Z]+)_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(choice);
  if (!m || !SERVICES.includes(m[1])) return false;
  await startBooking(env, provider, conv, m[1], m[2], msgId);
  return true;
}

async function sendSlotList(env: Env, conv: Conv, service: string, msgId: string): Promise<void> {
  const cp = copyFor(conv.locale);
  const nowMs = Date.now();
  const free: Slot[] = [];
  for (const ymd of nextWorkingDays(nowMs, config.booking.workingDays)) {
    free.push(...(await availableSlots(env.DB, "CALL", ymd, nowMs + config.booking.leadMinutes * 60_000)));
  }
  const rows = free.slice(0, config.booking.maxListRows).map((s) => ({ id: `slot_${service}_${s.startUtc}`, title: formatIst(s.startUtc) }));
  if (!rows.length) {
    await sendMessage(env, conv.id, { type: "text", text: cp.noSlots }, `${msgId}:noslots`);
    return;
  }
  await sendMessage(env, conv.id, { type: "list", body: cp.slotListBody, button: cp.slotListButton, rows }, `${msgId}:slots`);
}

async function startBooking(env: Env, provider: PaymentProvider, conv: Conv, service: string, startUtc: string, msgId: string): Promise<void> {
  const db = env.DB;
  const cp = copyFor(conv.locale);
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
    const p = formatIstParts(open.startUtc);
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
      await sendSlotList(env, conv, service, `${msgId}:again`);
    }
    return;
  }
  const slot = await db.prepare("SELECT id FROM slots WHERE kind = 'CALL' AND start_utc = ?1 AND owner_id = ?2").bind(startUtc, conv.id).first<{ id: number }>();

  // 3. Intro (HELD) and payment (CREATING), then the link.
  const intro = await db.prepare("INSERT INTO intros (conversation_id, slot_id, service) VALUES (?1, ?2, ?3)").bind(conv.id, slot?.id ?? null, service).run();
  const introId = intro.meta.last_row_id;
  const linkId = `di-intro-${introId}`; // unique, tied to the intro; <= 50 chars, [A-Za-z0-9_-]
  const pay = await db
    .prepare("INSERT INTO payments (provider, purpose, target_id, provider_link_id, amount_paise) VALUES ('cashfree', 'INTRO', ?1, ?2, ?3)")
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
    await send({ type: "cta", body: cp.payBody, label: cp.payLabel, url: link.url }, "pay");
  } catch {
    // No link: free the hold. If a link did get created and is paid later, the late-payment rules apply.
    await db.prepare("UPDATE payments SET state = 'FAILED', updated_at = ?2 WHERE id = ?1 AND state = 'CREATING'").bind(payId, nowIso()).run();
    await db.prepare("UPDATE intros SET state = 'EXPIRED', updated_at = ?2 WHERE id = ?1").bind(introId, nowIso()).run();
    await db.prepare("UPDATE slots SET hold_until = ?2 WHERE id = ?1 AND state = 'HELD'").bind(slot?.id ?? 0, nowIso()).run();
    await raiseAttention(db, "LINK_CREATE_FAILED", `intro:${introId}`);
    await send({ type: "text", text: cp.payFailed }, "payfail");
  }
}
