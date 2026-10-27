// Payments (/app/payments), owner only (the see_money row): is the money right? Problems first (refunds that failed or are still
// waiting after 7 days, amounts that don't match, payments with no booking), each with its next step; then any month's money in,
// refunded and net, the sessions still owed on packages, a masked CSV export (audited) and every payment with its status in words.
// Approvals (refunds and money staff asked about) stay on Today; this screen links there. The one money action here is retrying a
// refund that failed, behind a confirm step, with the existing refund code.
import { Hono } from "hono";
import { html } from "hono/html";
import { can, memberCsrf, type Member } from "./auth";
import { refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleCopy, consoleLang } from "./console-copy";
import type { Env } from "./env";
import { razorpay } from "./pay/razorpay";
import { retryFailedRefund } from "./pay/refund";
import { iso } from "./slots";
import { agoText, ownerPage, rupeesText, whenText } from "./settings";
import { confirmStep, emptyState, firstName, last4, listDetail, listRow, paymentChip, rows, screenHead, section, statusChip, taskCard } from "./ui";

// ---------- words (English and Hindi, in the shape of src/console-copy.ts) ----------
const en = {
  title: "Payments",
  secProblems: "Needs a look",
  secMonth: (month: string) => `${month}`,
  secList: "Every payment this month",
  received: "Money in",
  refunded: "Refunded",
  net: "Net",
  owed: "Sessions owed on packages",
  owedValue: (n: number, amount: string) => `${n} (${amount})`,
  owedNote: "As of now, across every package still open.",
  prevMonth: "← Earlier month",
  nextMonth: "Later month →",
  export: "Download this month (CSV)",
  exportNote: "Phone numbers show only their last 4 digits. The download is recorded in the audit log.",
  noPayments: (month: string) => `No payments in ${month}.`,
  noProblems: "Nothing needs a look. Refunds and payments are where they should be.",
  openToday: "Open Today",
  openPerson: "Open the customer",
  checkRazorpay: "Check with Razorpay",
  // problem cards
  refundFailed: "Refund didn't go through",
  refundFailedNext: "Razorpay refused it. Check it with Razorpay, then retry the refund.",
  refundSlow: "Refund still on its way after 7 days",
  refundSlowNext: "Ask Razorpay where it is; the customer may be waiting.",
  mismatch: "Paid a different amount",
  mismatchWhy: (paid: string, asked: string) => `Paid ${paid}, the link asked for ${asked}.`,
  mismatchNext: "Check it with Razorpay. Refund or keep it from Today.",
  unclear: "Not sure if this was paid",
  unclearNext: "Razorpay hasn't confirmed it either way. Check with Razorpay.",
  noBooking: "Paid, with no booking to go with it",
  noBookingNext: "Offer them a new time or refund them, from Today.",
  retry: "Retry the refund…",
  retryEffect: (amount: string, who: string) => `Ask Razorpay again to refund ${amount} to ${who}. The money goes back to how they paid; banks take a few days.`,
  retryConfirm: (amount: string) => `Retry refund of ${amount}`,
  retried: "Refund sent to Razorpay again. Its answer shows here.",
  notRetried: "Nothing to retry: that refund has already moved on.",
  // what a payment was for
  forCall: "First call",
  forSession: "Session",
  forPackage: (n: number | null) => (n ? `Package of ${n}` : "Package"),
  noName: "Customer",
  // the payment's own page
  detailAmount: "Amount",
  detailFor: "For",
  detailStatus: "Status",
  detailWhen: "Started",
  detailUpdated: "Last change",
  detailCustomer: "Customer",
  detailRefund: "Refund",
  refundWords: { PENDING_APPROVAL: "Waiting for your approval on Today", PENDING: "On its way", REFUNDED: "Refunded", FAILED: "Didn't go through", DECLINED: "Declined: no refund" } as Record<string, string>,
  notFound: "That payment isn't here.",
  // CSV
  csvHead: ["Date (India time)", "For", "Amount (₹)", "Status", "Customer", "Phone"],
};

type Words = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : (typeof en)[K] };

const hi: Words = {
  title: "पेमेंट",
  secProblems: "देखने लायक",
  secMonth: (month) => `${month}`,
  secList: "इस महीने के सारे पेमेंट",
  received: "आया पैसा",
  refunded: "रिफ़ंड",
  net: "कुल बचा",
  owed: "पैकेज के बाकी सेशन",
  owedValue: (n, amount) => `${n} (${amount})`,
  owedNote: "अभी तक, हर खुले पैकेज को मिलाकर।",
  prevMonth: "← पिछला महीना",
  nextMonth: "अगला महीना →",
  export: "यह महीना डाउनलोड करें (CSV)",
  exportNote: "फ़ोन नंबर के सिर्फ़ आख़िरी 4 अंक दिखते हैं। डाउनलोड ऑडिट लॉग में दर्ज होता है।",
  noPayments: (month) => `${month} में कोई पेमेंट नहीं।`,
  noProblems: "कुछ देखने लायक नहीं। रिफ़ंड और पेमेंट ठीक हैं।",
  openToday: "'आज' खोलें",
  openPerson: "ग्राहक खोलें",
  checkRazorpay: "Razorpay पर जाँचें",
  refundFailed: "रिफ़ंड नहीं हुआ",
  refundFailedNext: "Razorpay ने मना कर दिया। Razorpay पर जाँचें, फिर रिफ़ंड दोबारा भेजें।",
  refundSlow: "7 दिन बाद भी रिफ़ंड रास्ते में है",
  refundSlowNext: "Razorpay से पूछें कि यह कहाँ है; ग्राहक इंतज़ार कर रहे होंगे।",
  mismatch: "अलग रक़म आई",
  mismatchWhy: (paid, asked) => `${paid} आए, लिंक में ${asked} माँगे थे।`,
  mismatchNext: "Razorpay पर जाँचें। 'आज' से रिफ़ंड करें या रखें।",
  unclear: "पता नहीं कि पेमेंट हुआ या नहीं",
  unclearNext: "Razorpay ने अभी कुछ पक्का नहीं बताया। Razorpay पर जाँचें।",
  noBooking: "पेमेंट हुआ, पर बुकिंग नहीं",
  noBookingNext: "'आज' से उन्हें नया समय दें या रिफ़ंड करें।",
  retry: "रिफ़ंड दोबारा भेजें…",
  retryEffect: (amount, who) => `Razorpay से फिर कहें कि ${who} को ${amount} लौटाए। पैसा उसी तरीके में लौटता है जिससे दिया था; बैंक कुछ दिन लेते हैं।`,
  retryConfirm: (amount) => `${amount} का रिफ़ंड दोबारा भेजें`,
  retried: "रिफ़ंड फिर से Razorpay को भेजा। उसका जवाब यहाँ दिखेगा।",
  notRetried: "दोबारा भेजने को कुछ नहीं: वह रिफ़ंड आगे बढ़ चुका है।",
  forCall: "पहली कॉल",
  forSession: "सेशन",
  forPackage: (n) => (n ? `${n} सेशन का पैकेज` : "पैकेज"),
  noName: "ग्राहक",
  detailAmount: "रक़म",
  detailFor: "किसलिए",
  detailStatus: "स्थिति",
  detailWhen: "शुरू हुआ",
  detailUpdated: "आख़िरी बदलाव",
  detailCustomer: "ग्राहक",
  detailRefund: "रिफ़ंड",
  refundWords: { PENDING_APPROVAL: "'आज' पर आपकी मंज़ूरी का इंतज़ार", PENDING: "रास्ते में", REFUNDED: "रिफ़ंड हो गया", FAILED: "नहीं हुआ", DECLINED: "मना किया: रिफ़ंड नहीं" },
  notFound: "यह पेमेंट यहाँ नहीं है।",
  csvHead: ["तारीख़ (भारतीय समय)", "किसलिए", "रक़म (₹)", "स्थिति", "ग्राहक", "फ़ोन"],
};

export const PAYMENTS_COPY: Record<"en" | "hi", Words> = { en, hi };
const W = (m: Member): Words => PAYMENTS_COPY[consoleLang(m.locale)];

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  hi: ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
};

// ---------- months, in India time ----------
const IST_MS = 330 * 60_000;
export const monthOf = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 7); // "2026-10"
const isMonth = (v: string | undefined): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const shift = (ym: string, by: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
export const monthRange = (ym: string) => [iso(Date.parse(`${ym}-01T00:00:00+05:30`)), iso(Date.parse(`${shift(ym, 1)}-01T00:00:00+05:30`))] as const;
const monthName = (ym: string, locale: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[consoleLang(locale)][m - 1]} ${y}`;
};

// ---------- the data ----------
const PAID_LIKE = "('PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED')";
export type PayRow = {
  id: number; purpose: string; amount: number; asked: number; paid: number | null; state: string; at: string; updatedAt: string | null;
  providerPaymentId: string | null; size: number | null; convId: number | null; name: string | null; waId: string | null;
  refundState: string | null; refundAt: string | null; refundPaise: number | null;
};
const PAY_SQL = `SELECT p.id, p.purpose, COALESCE(p.paid_paise, p.amount_paise) AS amount, p.amount_paise AS asked, p.paid_paise AS paid, p.state,
  p.created_at AS at, p.updated_at AS updatedAt, p.provider_payment_id AS providerPaymentId, pk.size,
  COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id) AS convId, c.display_name AS name, c.wa_id AS waId,
  r.state AS refundState, r.created_at AS refundAt, COALESCE(r.amount_paise, p.paid_paise, p.amount_paise) AS refundPaise
  FROM payments p
  LEFT JOIN intros i ON p.purpose = 'INTRO' AND i.id = p.target_id
  LEFT JOIN sessions s ON p.purpose = 'SESSION' AND s.id = p.target_id
  LEFT JOIN packages pk ON p.purpose = 'PACKAGE' AND pk.id = p.target_id
  LEFT JOIN conversations c ON c.id = COALESCE(i.conversation_id, s.conversation_id, pk.conversation_id)
  LEFT JOIN refunds r ON r.payment_id = p.id`;

// Open items that mean "paid, but there's no booking for it" (the bot raised them; Today is where they're settled).
const NO_BOOKING_KINDS = ["LATE_PAYMENT_NO_SLOT", "DUPLICATE_PAYMENT", "PAID_NO_PACKAGE", "PAID_PACKAGE_NOT_BOOKABLE", "PAID_NO_INTRO", "PAID_INTRO_NOT_BOOKABLE", "PAID_NO_SESSION", "PAID_SESSION_NOT_BOOKABLE", "UNSUPPORTED_PAYMENT"];
export const STUCK_REFUND_DAYS = 7;

export type Problem = { kind: "refundFailed" | "refundSlow" | "mismatch" | "unclear" | "noBooking"; pay: PayRow };

// Every problem, worst first, one per payment.
export async function problems(env: Env, nowMs = Date.now()): Promise<Problem[]> {
  const q = (where: string, ...binds: unknown[]) => env.DB.prepare(`${PAY_SQL} WHERE ${where} ORDER BY p.id`).bind(...binds).all<PayRow>().then((r) => r.results);
  const kinds = NO_BOOKING_KINDS.map((k) => `'${k}'`).join(",");
  const [failed, slow, unknown, noBooking] = await Promise.all([
    q("r.state = 'FAILED'"),
    q("r.state = 'PENDING' AND r.created_at < ?1", iso(nowMs - STUCK_REFUND_DAYS * 86_400_000)),
    q("p.state = 'UNKNOWN'"),
    q(`p.state IN ${PAID_LIKE} AND (r.state IS NULL OR r.state IN ('PENDING_APPROVAL', 'DECLINED')) AND EXISTS (SELECT 1 FROM attention a WHERE a.resolved_at IS NULL AND a.kind IN (${kinds}) AND (
        a.target = 'payment:' || p.id
        OR (p.purpose = 'INTRO' AND a.target = 'intro:' || p.target_id)
        OR (p.purpose = 'SESSION' AND a.target = 'session:' || p.target_id)
        OR (p.purpose = 'PACKAGE' AND a.target = 'package:' || p.target_id)))`),
  ]);
  const seen = new Set<number>();
  const out: Problem[] = [];
  const add = (kind: Problem["kind"], list: PayRow[]) => {
    for (const pay of list) if (!seen.has(pay.id)) seen.add(pay.id), out.push({ kind, pay });
  };
  add("refundFailed", failed);
  add("refundSlow", slow);
  add("mismatch", unknown.filter((p) => p.paid != null && p.paid !== p.asked));
  add("unclear", unknown);
  add("noBooking", noBooking);
  return out;
}

export type MonthTotals = { received: number; refunded: number; net: number; owedSessions: number; owedPaise: number };

// Money in: payments made in the month that were paid (whatever happened after). Refunded: refunds confirmed in the month.
// Owed: package sessions not yet used, across every paid package, valued at that package's own rate.
export async function monthTotals(env: Env, ym: string): Promise<MonthTotals> {
  const [a, b] = monthRange(ym);
  const received = (await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(paid_paise, amount_paise)), 0) AS n FROM payments WHERE state IN ${PAID_LIKE} AND created_at >= ?1 AND created_at < ?2`).bind(a, b).first<{ n: number }>())!.n;
  const refunded = (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(COALESCE(r.amount_paise, p.paid_paise, p.amount_paise)), 0) AS n FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.state = 'REFUNDED' AND COALESCE(r.updated_at, r.created_at) >= ?1 AND COALESCE(r.updated_at, r.created_at) < ?2",
    ).bind(a, b).first<{ n: number }>()
  )!.n;
  const owed = (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(left_n), 0) AS n, COALESCE(SUM(left_n * price_paise / size), 0) AS paise FROM (SELECT k.size, k.price_paise, (SELECT COALESCE(SUM(delta), 0) FROM credits WHERE package_id = k.id) AS left_n FROM packages k WHERE k.state = 'PAID')",
    ).first<{ n: number; paise: number }>()
  )!;
  return { received, refunded, net: received - refunded, owedSessions: owed.n, owedPaise: owed.paise };
}

const forText = (r: PayRow, w: Words) => (r.purpose === "INTRO" ? w.forCall : r.purpose === "PACKAGE" ? w.forPackage(r.size) : w.forSession);
const whoText = (r: PayRow, w: Words) => `${firstName(r.name, w.noName)}${r.waId ? ` ${last4(r.waId)}` : ""}`;
// Razorpay's own page for the payment (only an id we stored; nothing about the account).
const razorpayHref = (r: PayRow) => (r.providerPaymentId && /^pay_[A-Za-z0-9]+$/.test(r.providerPaymentId) ? `https://dashboard.razorpay.com/app/payments/${r.providerPaymentId}` : null);

// ---------- the routes ----------
export const payments = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

payments.use("*", async (c, next) => {
  if (can(c.get("member"), "see_money") !== "yes") return refused(c);
  await next();
});

// An audit row for something that has already happened (a download, a refund the refund code has just moved on).
const audit = (c: ConsoleCtx, action: string, target: string, detail: string) =>
  c.env.DB.prepare("INSERT INTO audit_log (actor, action, target, detail, workspace_id, member_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(c.get("email"), action, target, detail, c.get("member").workspaceId, c.get("member").id)
    .run();
const token = (c: ConsoleCtx, scope: string) => memberCsrf(c.get("jwt"), c.get("member"), `payments-${scope}`);

async function problemCard(c: ConsoleCtx, p: Problem) {
  const w = W(c.get("member"));
  const lang = c.get("member").locale;
  const r = p.pay;
  const why = `${forText(r, w)} · ${rupeesText(r.amount)} · ${whoText(r, w)} · ${whenText(r.at, lang)}`;
  const rzp = razorpayHref(r);
  const person = r.convId ? { label: w.openPerson, href: `/app/people/${r.convId}` } : undefined;
  if (p.kind === "refundFailed") {
    const retry = confirmStep({
      label: w.retry,
      effect: w.retryEffect(rupeesText(r.refundPaise ?? r.amount), whoText(r, w)),
      confirm: w.retryConfirm(rupeesText(r.refundPaise ?? r.amount)),
      post: { action: `/app/payments/${r.id}/retry-refund`, csrf: await token(c, `retry:${r.id}`) },
    });
    return html`<article class="card danger" id="pay-${r.id}"><h3>${w.refundFailed}</h3><p class="why">${why}</p><p class="why">${w.refundFailedNext}</p>${statusChip(w.refundWords.FAILED, "danger")}
<div class="acts">${retry}${rzp ? html`<a class="link" href="${rzp}" rel="noreferrer">${w.checkRazorpay}</a>` : person ? html`<a class="link" href="${person.href}">${person.label}</a>` : ""}</div></article>`;
  }
  const words = {
    refundSlow: [w.refundSlow, w.refundSlowNext, "attention"],
    mismatch: [w.mismatch, `${w.mismatchWhy(rupeesText(r.paid ?? 0), rupeesText(r.asked))} ${w.mismatchNext}`, "danger"],
    unclear: [w.unclear, w.unclearNext, "danger"],
    noBooking: [w.noBooking, w.noBookingNext, "attention"],
  }[p.kind] as [string, string, "danger" | "attention"];
  const primary = p.kind === "noBooking" || p.kind === "mismatch" ? { label: w.openToday, href: "/app" } : rzp ? { label: w.checkRazorpay, href: rzp } : { label: w.openToday, href: "/app" };
  const secondary = primary.href === "/app" && rzp ? { label: w.checkRazorpay, href: rzp } : person;
  return taskCard({ title: words[0], why: `${why}. ${words[1]}`, tone: words[2], chip: paymentChip(r.state, lang), primary, secondary });
}

async function paymentsPage(c: ConsoleCtx, o: { ym: string; openId?: number; flash?: string | null }) {
  const m = c.get("member");
  const w = W(m);
  const lang = m.locale;
  const now = Date.now();
  const current = monthOf(now);
  const ym = o.ym > current ? current : o.ym;
  const [a, b] = monthRange(ym);
  const [probs, totals, list] = await Promise.all([
    problems(c.env, now),
    monthTotals(c.env, ym),
    c.env.DB.prepare(`${PAY_SQL} WHERE p.created_at >= ?1 AND p.created_at < ?2 AND p.state != 'CREATING' ORDER BY p.id DESC LIMIT 500`).bind(a, b).all<PayRow>().then((r) => r.results),
  ]);
  const name = monthName(ym, lang);
  const stat = (k: string, v: string) => html`<div class="stat"><p class="k">${k}</p><p class="v">${v}</p></div>`;
  const nav = html`<div class="acts"><a class="btn quiet" href="/app/payments?month=${shift(ym, -1)}">${w.prevMonth}</a>${
    ym < current ? html`<a class="btn quiet" href="/app/payments?month=${shift(ym, 1)}">${w.nextMonth}</a>` : ""
  }</div>`;
  const exportForm = html`<form method="post" action="/app/payments/export"><input type="hidden" name="csrf" value="${await token(c, "export")}"><input type="hidden" name="month" value="${ym}"><button class="btn" type="submit">${w.export}</button></form>`;
  const numbers = html`<div class="stats">${stat(w.received, rupeesText(totals.received))}${stat(w.refunded, rupeesText(totals.refunded))}${stat(w.net, rupeesText(totals.net))}${stat(
    w.owed,
    w.owedValue(totals.owedSessions, rupeesText(totals.owedPaise)),
  )}</div><p class="note">${w.owedNote}</p>${nav}<div class="acts">${exportForm}</div><p class="note">${w.exportNote}</p>`;
  const listHtml = list.length
    ? rows(list.map((r) => listRow({ href: `/app/payments/${r.id}?month=${ym}`, title: `${forText(r, w)} · ${rupeesText(r.amount)}`, sub: `${whoText(r, w)} · ${whenText(r.at, lang)}`, end: paymentChip(r.state, lang), on: r.id === o.openId })))
    : emptyState(w.noPayments(name), ym === current ? undefined : { label: monthName(current, lang), href: "/app/payments" });
  let detail: unknown;
  if (o.openId !== undefined) {
    const r = await c.env.DB.prepare(`${PAY_SQL} WHERE p.id = ?1`).bind(o.openId).first<PayRow>();
    detail = r ? await detailCard(c, r) : emptyState(w.notFound, { label: w.title, href: "/app/payments" });
  }
  const problemsHtml = probs.length ? await Promise.all(probs.map((p) => problemCard(c, p))) : emptyState(w.noProblems);
  const body = html`${screenHead("payments", lang)}${section(w.secProblems, problemsHtml, probs.length)}${section(w.secMonth(name), numbers)}
${section(w.secList, listDetail({ list: listHtml, detail, backHref: `/app/payments?month=${ym}`, locale: lang }), list.length)}`;
  return ownerPage(c, { active: "payments", title: w.title, body, flash: o.flash, back: `/app/payments${ym !== current ? `?month=${ym}` : ""}` });
}

async function detailCard(c: ConsoleCtx, r: PayRow) {
  const m = c.get("member");
  const w = W(m);
  const lang = m.locale;
  const rzp = razorpayHref(r);
  const kv = (k: string, v: unknown) => html`<dt>${k}</dt><dd>${v}</dd>`;
  return html`<div class="card" id="pay-${r.id}"><h3>${forText(r, w)} · ${rupeesText(r.amount)}</h3>${paymentChip(r.state, lang)}
<dl class="kv" style="margin-top:16px">${kv(w.detailFor, forText(r, w))}${kv(w.detailAmount, r.paid != null && r.paid !== r.asked ? w.mismatchWhy(rupeesText(r.paid), rupeesText(r.asked)) : rupeesText(r.amount))}
${kv(w.detailCustomer, r.convId ? html`<a href="/app/people/${r.convId}">${whoText(r, w)}</a>` : whoText(r, w))}
${kv(w.detailWhen, whenText(r.at, lang))}${r.updatedAt ? kv(w.detailUpdated, `${whenText(r.updatedAt, lang)} (${agoText(r.updatedAt, lang)})`) : ""}
${r.refundState ? kv(w.detailRefund, `${w.refundWords[r.refundState] ?? ""} · ${rupeesText(r.refundPaise ?? r.amount)}`) : ""}</dl>
<div class="acts">${
    r.refundState === "FAILED"
      ? confirmStep({
          label: w.retry,
          effect: w.retryEffect(rupeesText(r.refundPaise ?? r.amount), whoText(r, w)),
          confirm: w.retryConfirm(rupeesText(r.refundPaise ?? r.amount)),
          post: { action: `/app/payments/${r.id}/retry-refund`, csrf: await token(c, `retry:${r.id}`) },
        })
      : ""
  }${rzp ? html`<a class="link" href="${rzp}" rel="noreferrer">${w.checkRazorpay}</a>` : ""}</div></div>`;
}

const monthParam = (c: ConsoleCtx) => {
  const q = c.req.query("month");
  return isMonth(q) ? q : monthOf(Date.now());
};
const FLASH = { retried: "retried", none: "notRetried" } as const;
const flashOf = (c: ConsoleCtx) => {
  const k = FLASH[c.req.query("m") as keyof typeof FLASH];
  return k ? W(c.get("member"))[k] : null;
};

payments.get("/", (c) => paymentsPage(c, { ym: monthParam(c), flash: flashOf(c) }));
payments.get("/:id{[0-9]+}", (c) => paymentsPage(c, { ym: monthParam(c), openId: Number(c.req.param("id")), flash: flashOf(c) }));

// ---- the masked CSV: last 4 digits only, first names only, no provider ids; the download is audited ----
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // a spreadsheet never runs a cell as a formula
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function paymentsCsv(list: PayRow[], locale: string): string {
  const w = PAYMENTS_COPY[consoleLang(locale)];
  const cc = consoleCopy(locale);
  const words: Record<string, string> = {
    CREATING: cc.payWaiting, PENDING: cc.payWaiting, PAID: cc.payPaid, FAILED: cc.payFailed, UNKNOWN: cc.payCheck,
    REFUND_PENDING: cc.payRefunding, REFUNDED: cc.payRefunded, REFUND_FAILED: cc.payCheck,
  };
  const statusWord = (s: string) => words[s] ?? "";
  const ist = (utc: string) => new Date(Date.parse(utc) + IST_MS).toISOString().slice(0, 16).replace("T", " ");
  const lines = [w.csvHead, ...list.map((r) => [ist(r.at), forText(r, w), String(r.amount / 100), statusWord(r.state), firstName(r.name, w.noName), last4(r.waId)])];
  return "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

payments.post("/export", async (c) => {
  const f = (await c.req.parseBody()) as Record<string, string | undefined>;
  if (f.csrf !== (await token(c, "export"))) return c.text("Forbidden", 403);
  if (!isMonth(f.month)) return c.text("Bad request", 400);
  const [a, b] = monthRange(f.month);
  const list = (await c.env.DB.prepare(`${PAY_SQL} WHERE p.created_at >= ?1 AND p.created_at < ?2 AND p.state != 'CREATING' ORDER BY p.id`).bind(a, b).all<PayRow>()).results;
  // The audit row first: if it can't be written, nothing is downloaded.
  await audit(c, "DATA_EXPORTED", `payments:${f.month}`, `${list.length} rows, masked`);
  return new Response(paymentsCsv(list, c.get("member").locale), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="payments-${f.month}.csv"` },
  });
});

// ---- retry a refund that failed (the existing refund code), owner only, behind a confirm step ----
payments.post("/:id{[0-9]+}/retry-refund", async (c) => {
  const id = Number(c.req.param("id"));
  const f = (await c.req.parseBody()) as Record<string, string | undefined>;
  if (f.csrf !== (await token(c, `retry:${id}`))) return c.text("Forbidden", 403);
  if (can(c.get("member"), "refund") !== "yes") return refused(c);
  const did = await retryFailedRefund(c.env, razorpay(c.env), id);
  if (did) await audit(c, "REFUND_RETRIED", `payment:${id}`, "");
  return c.redirect(`/app/payments/${id}?m=${did ? "retried" : "none"}`, 303);
});

