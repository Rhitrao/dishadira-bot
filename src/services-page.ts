// Settings → Services (/app/settings/services, ticket 48), owner only (business_settings, like the rest of Settings): the service
// catalogue (src/catalogue.ts). Each service: its name in English and Hindi, price, length (15, 30, 60 or 90 minutes), its own daily limit,
// and whether it can be booked. A service the owner adds starts off (active 0) and unoffered by the bot (public 0). Ticket 49: a service other
// than the seeded two also has its question after payment (English, Hindi) and the two health questions before booking, and, only while the
// NEW_SERVICES env flag is "true", "Offered by the bot" (otherwise Ticket 48's note stays). The two the bot offers today keep their length and stay on, because the
// bot's messages, its approved templates and the assistant's knowledge state them. Every POST: Origin (console.ts), its own token, one
// batch with its audit row (SERVICE_UPDATE / SERVICE_ADD; a price change of the first call or the single session is also PRICE_CHANGED
// under its old key, which is how a payment is checked against the price when its link was made, src/business.ts priceAt).
// Server-rendered, no script.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { can, memberCsrf, type Member } from "./auth";
import { KEYS, loadPrices, MAX_PRICE_PAISE } from "./business";
import { CALL_KEY, isLength, isPathway, isSeeded, LENGTHS, MAX_DAILY_CAP, newKey, newServicesOn, PATHWAYS, readCatalogue, seedRowStmt, type Pathway, type Service } from "./catalogue";
import { config } from "./config";
import { auditStmt, refused, type ConsoleCtx, type ConsoleVars } from "./console";
import { consoleLang } from "./console-copy";
import type { Env } from "./env";
import { ownerPage, rupeesText, whenText } from "./settings";
import { iso } from "./slots";
import { section, statusChip } from "./ui";

// ---------- words (English and Hindi; the Hindi is to be read by a native speaker) ----------
const en = {
  title: "Services",
  sub: "What customers can book: each service's name, length and price. The bot offers only the services marked “Offered by the bot”.",
  back: "Back to Settings",
  pathway: { ENTRY: "Entry", RELEASE: "Release", UNDERSTAND: "Understand", REWIRE: "Rewire" } as Record<Pathway, string>,
  offered: "Offered by the bot",
  notOffered: "Not offered yet",
  on: "Can be booked",
  off: "Off",
  minutes: (n: number) => `${n} min`,
  lPathway: "Pathway",
  lLength: "Length",
  lPrice: "Price",
  lCap: "Daily limit",
  lCallFirst: "Only after the first call",
  lChanged: "Last changed",
  capNone: "None of its own",
  yes: "Yes",
  no: "No",
  edit: "Edit",
  nameEn: "Name in English",
  nameHi: "Name in Hindi",
  price: "Price",
  rupeesOnly: "In whole rupees",
  length: "Length",
  cap: "Daily limit",
  capHelp: (max: number) => `How many a day at most. Leave empty for no limit of its own (whole number, 1 to ${max}).`,
  active: "Can be booked",
  callFirst: "Only for people who have had the first call",
  lengthLocked: "The bot's messages and its approved WhatsApp templates give this length, so it can't change here.",
  activeLocked: "Offered by the bot, so it stays on. To pause all booking for a while, use Settings → Bot → Taking bookings.",
  afterLaunch: "Offered by the bot after launch.",
  save: "Save changes",
  addTitle: "Add a service",
  addWhy: "A new service starts off, and the bot doesn't offer it. Offered by the bot after launch.",
  add: "Add service",
  sessionsCap: (n: number) => `Whatever the services, at most ${n} sessions of 60 or 90 minutes are booked on one day.`,
  packages: "Packages (10 and 20 sessions) are for the single session. Their prices are with the other prices in Settings.",
  packagesLink: "Prices in Settings",
  saved: "Saved.",
  added: "Service added. It is off, and not offered by the bot.",
  nothingChanged: "Nothing changed.",
  notSaved: "That didn't save. Check the boxes in red and try again.",
  badName: "1 to 60 characters.",
  badPrice: "Whole rupees from ₹1 to ₹1,00,000.",
  badLength: "Choose 15, 30, 60 or 90 minutes.",
  badCap: (max: number) => `Leave empty, or a whole number from 1 to ${max}.`,
  badPathway: "Choose a pathway.",
  // Ticket 49 (CONTRACT v18)
  offerToggle: "Offered by the bot",
  offerHelp: "The bot lists it under Book (when it can also be booked). Only while new services are switched on for this bot.",
  intakeEn: "Question after payment (English)",
  intakeHi: "Question after payment (Hindi)",
  intakeHelp: (max: number) => `One question the bot asks after payment, e.g. “What question would you like to bring to your reading?”. Leave empty for none (up to ${max} characters).`,
  badIntake: (max: number) => `Up to ${max} characters.`,
  screenToggle: "Two health questions before booking",
  screenHelp: "Before a time is held: “Under treatment for a mental-health condition right now?” and “Ever had seizures or epilepsy?”. Any “yes” recommends the ₹99 call first. Answers are never kept.",
  lIntake: "Question after payment",
  lScreen: "Health questions first",
  intakeNone: "None",
};
type Words = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : (typeof en)[K] };
const hi: Words = {
  title: "सेवाएँ",
  sub: "ग्राहक क्या बुक कर सकते हैं: हर सेवा का नाम, समय और दाम। बॉट सिर्फ़ वही सेवाएँ ऑफ़र करता है जिन पर “बॉट ऑफ़र करता है” लिखा है।",
  back: "सेटिंग्स पर वापस",
  pathway: { ENTRY: "शुरुआत", RELEASE: "रिलीज़", UNDERSTAND: "समझ", REWIRE: "रीवायर" },
  offered: "बॉट ऑफ़र करता है",
  notOffered: "अभी ऑफ़र नहीं",
  on: "बुक हो सकती है",
  off: "बंद",
  minutes: (n) => `${n} मिनट`,
  lPathway: "पाथवे",
  lLength: "समय",
  lPrice: "दाम",
  lCap: "रोज़ की सीमा",
  lCallFirst: "सिर्फ़ पहली कॉल के बाद",
  lChanged: "आख़िरी बदलाव",
  capNone: "अपनी कोई सीमा नहीं",
  yes: "हाँ",
  no: "नहीं",
  edit: "बदलें",
  nameEn: "अंग्रेज़ी में नाम",
  nameHi: "हिन्दी में नाम",
  price: "दाम",
  rupeesOnly: "पूरे रुपये में",
  length: "समय",
  cap: "रोज़ की सीमा",
  capHelp: (max) => `एक दिन में ज़्यादा से ज़्यादा कितनी। अपनी कोई सीमा न हो तो ख़ाली छोड़ें (पूरी संख्या, 1 से ${max})।`,
  active: "बुक हो सकती है",
  callFirst: "सिर्फ़ उनके लिए जिनकी पहली कॉल हो चुकी है",
  lengthLocked: "बॉट के संदेश और WhatsApp के मंज़ूर टेम्पलेट यही समय बताते हैं, इसलिए इसे यहाँ से नहीं बदला जा सकता।",
  activeLocked: "बॉट इसे ऑफ़र करता है, इसलिए यह चालू रहती है। कुछ समय के लिए सारी बुकिंग रोकनी हो तो सेटिंग्स → बॉट → बुकिंग चालू देखें।",
  afterLaunch: "लॉन्च के बाद बॉट इसे ऑफ़र करेगा।",
  save: "बदलाव सेव करें",
  addTitle: "नई सेवा जोड़ें",
  addWhy: "नई सेवा बंद से शुरू होती है, और बॉट इसे ऑफ़र नहीं करता। लॉन्च के बाद बॉट इसे ऑफ़र करेगा।",
  add: "सेवा जोड़ें",
  sessionsCap: (n) => `सेवाएँ कोई भी हों, एक दिन में 60 या 90 मिनट के ज़्यादा से ज़्यादा ${n} सेशन बुक होते हैं।`,
  packages: "पैकेज (10 और 20 सेशन) एक सेशन वाली सेवा के लिए हैं। उनके दाम सेटिंग्स में बाकी दामों के साथ हैं।",
  packagesLink: "सेटिंग्स में दाम",
  saved: "सेव हो गया।",
  added: "सेवा जुड़ गई। यह बंद है, और बॉट इसे ऑफ़र नहीं करता।",
  nothingChanged: "कुछ नहीं बदला।",
  notSaved: "यह सेव नहीं हुआ। लाल वाले खाने देखें और फिर से कोशिश करें।",
  badName: "1 से 60 अक्षर।",
  badPrice: "₹1 से ₹1,00,000 तक, पूरे रुपये में।",
  badLength: "15, 30, 60 या 90 मिनट चुनें।",
  badCap: (max) => `ख़ाली छोड़ें, या 1 से ${max} तक की पूरी संख्या।`,
  badPathway: "पाथवे चुनें।",
  offerToggle: "बॉट ऑफ़र करता है",
  offerHelp: "बॉट इसे \"बुक करें\" में दिखाता है (अगर यह बुक भी हो सकती है)। सिर्फ़ तब, जब इस बॉट के लिए नई सेवाएँ चालू हों।",
  intakeEn: "भुगतान के बाद का सवाल (अंग्रेज़ी)",
  intakeHi: "भुगतान के बाद का सवाल (हिन्दी)",
  intakeHelp: (max) => `भुगतान के बाद बॉट एक सवाल पूछता है, जैसे “आप अपनी रीडिंग में कौन सा सवाल लाना चाहेंगे?”। कोई सवाल न हो तो ख़ाली छोड़ें (${max} अक्षर तक)।`,
  badIntake: (max) => `${max} अक्षर तक।`,
  screenToggle: "बुकिंग से पहले सेहत के दो सवाल",
  screenHelp: "समय रोकने से पहले: “क्या अभी किसी मानसिक स्वास्थ्य की समस्या का इलाज चल रहा है?” और “क्या कभी दौरे या मिर्गी हुई है?”। किसी भी “हाँ” पर पहले ₹99 की कॉल की सलाह दी जाती है। जवाब कभी नहीं रखे जाते।",
  lIntake: "भुगतान के बाद का सवाल",
  lScreen: "पहले सेहत के सवाल",
  intakeNone: "कोई नहीं",
};
export const SERVICES_COPY: Record<"en" | "hi", Words> = { en, hi };
const W = (m: Member): Words => SERVICES_COPY[consoleLang(m.locale)];

// New services belong to one of the three pathways; ENTRY is the first call alone.
const NEW_PATHWAYS = PATHWAYS.filter((p) => p !== "ENTRY");

// ---------- reading a form ----------
type Field = "nameEn" | "nameHi" | "price" | "minutes" | "cap" | "pathway" | "intakeEn" | "intakeHi";
type FormState = { key: string; values: Record<string, string>; bad: Field[] }; // key "new" is the add form
type Parsed = {
  nameEn: string; nameHi: string; pricePaise: number; minutes: number; dailyCap: number | null; active: boolean; pathway: Pathway | null; callFirst: boolean;
  public: boolean; intakeEn: string | null; intakeHi: string | null; screen: boolean; // ticket 49
};

const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "");
const cleanName = (v: string) => v.trim().replace(/\s+/g, " ");

// `svc` is the row being edited (undefined: a new one). A service the bot offers keeps its length and stays on, whatever the form says.
// `offerable`: NEW_SERVICES is "true", so "Offered by the bot" may change on a service that isn't one of the seeded two (ticket 49).
function parse(f: Record<string, unknown>, svc: Service | undefined, offerable = false): { values: Record<string, string>; bad: Field[]; next: Parsed } {
  const values: Record<string, string> = {};
  for (const k of ["name_en", "name_hi", "price", "minutes", "cap", "pathway", "intake_en", "intake_hi"]) values[k] = one(f[k]).trim();
  const bad: Field[] = [];
  const nameEn = cleanName(values.name_en);
  const nameHi = cleanName(values.name_hi);
  if (!nameEn || [...nameEn].length > 60) bad.push("nameEn");
  if (!nameHi || [...nameHi].length > 60) bad.push("nameHi");
  const rupees = values.price.replace(/[₹,\s]/g, "");
  const pricePaise = /^\d{1,7}$/.test(rupees) ? Number(rupees) * 100 : NaN;
  if (!(pricePaise >= 100 && pricePaise <= MAX_PRICE_PAISE)) bad.push("price");
  let minutes = Number(values.minutes);
  if (svc && isSeeded(svc.key)) {
    if (values.minutes && minutes !== svc.minutes) bad.push("minutes");
    minutes = svc.minutes;
  } else if (!isLength(minutes)) bad.push("minutes");
  const dailyCap = values.cap === "" ? null : /^\d{1,2}$/.test(values.cap) ? Number(values.cap) : NaN;
  if (dailyCap !== null && !(dailyCap >= 1 && dailyCap <= MAX_DAILY_CAP)) bad.push("cap");
  const pathway = svc ? null : isPathway(values.pathway) && values.pathway !== "ENTRY" ? values.pathway : null;
  if (!svc && !pathway) bad.push("pathway");
  const seeded = svc ? isSeeded(svc.key) : false;
  const active = seeded ? true : one(f.active) === "1";
  // Ticket 49: the seeded two stay offered; another service is offered only from its edit form while NEW_SERVICES is "true" (a new one
  // starts unoffered), otherwise it keeps what it had. The question after payment and the health questions belong to the other services.
  const pub = seeded ? true : svc && offerable ? one(f.public) === "1" : (svc?.public ?? false);
  const intake = (v: string) => (seeded ? null : v.replace(/\s+/g, " ").trim() || null);
  const intakeEn = intake(values.intake_en);
  const intakeHi = intake(values.intake_hi);
  if (intakeEn && [...intakeEn].length > config.offer.intakeQuestionMax) bad.push("intakeEn");
  if (intakeHi && [...intakeHi].length > config.offer.intakeQuestionMax) bad.push("intakeHi");
  const screen = seeded ? false : one(f.screen) === "1";
  return { values, bad, next: { nameEn, nameHi, pricePaise, minutes, dailyCap, active, pathway, callFirst: one(f.call_first) === "1", public: pub, intakeEn, intakeHi, screen } };
}

// ---------- the page ----------
const PAGE_CSS = `<style>.svc .chips{margin:4px 0 0}.svc h3{margin:0}.svc .kv{margin-top:12px}.svc details{margin-top:12px}
.svc details>summary{list-style:none;display:inline-flex}.svc details>summary::-webkit-details-marker{display:none}.svc details[open]>summary{margin-bottom:12px}
.svc-form .fld input[type=checkbox]{width:22px;height:22px;margin:0 8px 0 0;accent-color:var(--accent);vertical-align:middle}
.svc-form textarea{display:block;width:100%;min-height:72px;font:inherit;font-size:var(--fs-in);color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:12px;resize:vertical}
.svc-form .check{display:flex;align-items:center;min-height:var(--tap);margin:0 0 16px;font-weight:500}
@media (min-width:900px){.svc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px}}</style>`;

export const servicesPage = new Hono<{ Bindings: Env; Variables: ConsoleVars }>();

// The owner alone, for every GET and POST (the same row as the rest of Settings).
servicesPage.use("*", async (c, next) => {
  if (can(c.get("member"), "business_settings") !== "yes") return refused(c);
  await next();
});

const token = (c: ConsoleCtx, scope: string) => memberCsrf(c.get("jwt"), c.get("member"), `services-${scope}`);

async function page(c: ConsoleCtx, o: { flash?: string | null; status?: 200 | 400; form?: FormState } = {}) {
  const m = c.get("member");
  const w = W(m);
  const offerable = newServicesOn(c.env); // ticket 49: "Offered by the bot" can change only while NEW_SERVICES is "true"
  const lang = consoleLang(m.locale);
  const list = await readCatalogue(c.env.DB);
  const form = o.form;
  const fld = (state: FormState | undefined, name: Field, label: string, input: unknown, help: string, err: string) => {
    const bad = state?.bad.includes(name);
    return html`<label class="fld${bad ? " bad" : ""}"><span>${label}</span>${input}<span class="${bad ? "err" : "help"}">${bad ? err : help}</span></label>`;
  };
  const text = (name: string, value: string, extra = "") => html`<input type="text" name="${name}" value="${value}" maxlength="60" required autocomplete="off"${raw(extra)}>`;
  const money = (value: string) => html`<span class="money"><b aria-hidden="true">₹</b><input type="text" name="price" inputmode="numeric" pattern="[0-9,₹ ]*" required value="${value}" autocomplete="off"></span>`;
  const lengthSelect = (value: number) =>
    html`<select name="minutes">${LENGTHS.map((n) => html`<option value="${n}"${n === value ? raw(" selected") : ""}>${w.minutes(n)}</option>`)}</select>`;
  const capInput = (value: string) => html`<input type="text" name="cap" inputmode="numeric" pattern="[0-9]*" value="${value}" autocomplete="off">`;
  const check = (name: string, label: string, on: boolean) => html`<label class="check"><input type="checkbox" name="${name}" value="1"${on ? raw(" checked") : ""}>${label}</label>`;
  const max = config.offer.intakeQuestionMax;
  const area = (name: string, value: string, extra = "") => html`<textarea name="${name}" rows="2" maxlength="${max}"${raw(extra)}>${value}</textarea>`;
  // Ticket 49: the question after payment (English, Hindi) and the two health questions, for a service other than the seeded two.
  const extraFields = (state: FormState | undefined, v: (k: string, d: string) => string, svc: Service | undefined) => html`<div class="svc-grid">${fld(
    state, "intakeEn", w.intakeEn, area("intake_en", v("intake_en", svc?.intakeEn ?? "")), w.intakeHelp(max), w.badIntake(max),
  )}${fld(state, "intakeHi", w.intakeHi, area("intake_hi", v("intake_hi", svc?.intakeHi ?? ""), ' lang="hi"'), w.intakeHelp(max), w.badIntake(max))}</div>
${check("screen", w.screenToggle, state ? state.values.screen === "1" : (svc?.screen ?? false))}<p class="note">${w.screenHelp}</p>`;

  const cards = await Promise.all(
    list.map(async (s) => {
      const state = form?.key === s.key ? form : undefined;
      const v = (k: string, dflt: string) => state?.values[k] ?? dflt;
      const seeded = isSeeded(s.key);
      // A service other than the seeded two counts as offered only while NEW_SERVICES is "true" (src/catalogue.ts isOffered).
      const offered = seeded || (s.public && offerable);
      const chips = html`<div class="chips">${statusChip(w.pathway[s.pathway], "plain")}${offered ? statusChip(w.offered, "done") : statusChip(w.notOffered, "plain")}${
        s.active ? (seeded ? "" : statusChip(w.on, "accent")) : statusChip(w.off, "attention")
      }</div>`;
      const facts = html`<dl class="kv"><dt>${w.lLength}</dt><dd>${w.minutes(s.minutes)}</dd><dt>${w.lPrice}</dt><dd>${rupeesText(s.pricePaise)}</dd>
<dt>${w.lCap}</dt><dd>${s.dailyCap ?? w.capNone}</dd><dt>${w.lCallFirst}</dt><dd>${s.needsCallFirst ? w.yes : w.no}</dd>${
        seeded ? "" : html`<dt>${w.lIntake}</dt><dd>${(lang === "hi" ? s.intakeHi ?? s.intakeEn : s.intakeEn ?? s.intakeHi) ?? w.intakeNone}</dd><dt>${w.lScreen}</dt><dd>${s.screen ? w.yes : w.no}</dd>`
      }${s.updatedBy !== null && s.updatedAt ? html`<dt>${w.lChanged}</dt><dd>${whenText(s.updatedAt, lang)}</dd>` : ""}</dl>`;
      const lengthField = seeded
        ? html`<div class="fld"><span>${w.length}</span><p>${w.minutes(s.minutes)}</p><span class="help">${w.lengthLocked}</span></div>`
        : fld(state, "minutes", w.length, lengthSelect(Number(v("minutes", String(s.minutes)))), "", w.badLength);
      const activeField = seeded
        ? html`<p class="note">${w.activeLocked}</p>`
        : html`${check("active", w.active, state ? state.values.active === "1" : s.active)}${
            offerable
              ? html`${check("public", w.offerToggle, state ? state.values.public === "1" : s.public)}<p class="note">${w.offerHelp}</p>`
              : html`<p class="note">${w.afterLaunch}</p>`
          }${extraFields(state, v, s)}`;
      const edit = html`<details${state ? raw(" open") : ""}><summary class="btn">${w.edit}</summary>
<form class="svc-form" method="post" action="/app/settings/services/edit"><input type="hidden" name="csrf" value="${await token(c, `edit:${s.key}`)}"><input type="hidden" name="key" value="${s.key}">
<div class="svc-grid">${fld(state, "nameEn", w.nameEn, text("name_en", v("name_en", s.nameEn)), "", w.badName)}${fld(state, "nameHi", w.nameHi, text("name_hi", v("name_hi", s.nameHi), ' lang="hi"'), "", w.badName)}
${fld(state, "price", w.price, money(v("price", String(s.pricePaise / 100))), w.rupeesOnly, w.badPrice)}${lengthField}
${fld(state, "cap", w.cap, capInput(v("cap", s.dailyCap === null ? "" : String(s.dailyCap))), w.capHelp(MAX_DAILY_CAP), w.badCap(MAX_DAILY_CAP))}</div>
${activeField}<div class="acts"><button class="btn primary" type="submit">${w.save}</button></div></form></details>`;
      return html`<article class="card svc" id="svc-${s.key}"><h3>${lang === "hi" ? s.nameHi : s.nameEn}</h3>${chips}${facts}${edit}</article>`;
    }),
  );

  const nf = form?.key === "new" ? form : undefined;
  const nv = (k: string, dflt = "") => nf?.values[k] ?? dflt;
  const add = html`<div class="card svc" id="add"><p class="why">${w.addWhy}</p><form class="svc-form" method="post" action="/app/settings/services/add"><input type="hidden" name="csrf" value="${await token(c, "add")}">
<div class="svc-grid">${fld(nf, "nameEn", w.nameEn, text("name_en", nv("name_en")), "", w.badName)}${fld(nf, "nameHi", w.nameHi, text("name_hi", nv("name_hi"), ' lang="hi"'), "", w.badName)}
${fld(nf, "pathway", w.lPathway, html`<select name="pathway">${NEW_PATHWAYS.map((p) => html`<option value="${p}"${p === nv("pathway") ? raw(" selected") : ""}>${w.pathway[p]}</option>`)}</select>`, "", w.badPathway)}
${fld(nf, "minutes", w.length, lengthSelect(Number(nv("minutes", "60"))), "", w.badLength)}
${fld(nf, "price", w.price, money(nv("price")), w.rupeesOnly, w.badPrice)}${fld(nf, "cap", w.cap, capInput(nv("cap")), w.capHelp(MAX_DAILY_CAP), w.badCap(MAX_DAILY_CAP))}</div>
${check("call_first", w.callFirst, nf?.values.call_first === "1")}${extraFields(nf, nv, undefined)}<div class="acts"><button class="btn primary" type="submit">${w.add}</button></div></form></div>`;

  const body = html`${raw(PAGE_CSS)}<a class="crumb" href="/app/settings">← ${w.back}</a><header class="screen"><h1>${w.title}</h1></header>
<p class="muted lead">${w.sub}</p><p class="note">${w.sessionsCap(config.slots.maxSessionsPerDay)}</p>
${section(w.title, cards, list.length)}${section(w.addTitle, add)}
<p class="note">${w.packages} <a class="tap" href="/app/settings#prices">${w.packagesLink}</a></p>`;
  return ownerPage(c, { active: "settings", title: w.title, body, flash: o.flash, status: o.status, back: "/app/settings/services" });
}

const FLASH = ["saved", "added", "nothingChanged"] as const;
servicesPage.get("/", (c) => {
  const code = c.req.query("m") as (typeof FLASH)[number] | undefined;
  return page(c, { flash: code && FLASH.includes(code) ? W(c.get("member"))[code] : null });
});

const done = (c: ConsoleCtx, code: (typeof FLASH)[number], anchor: string) => c.redirect(`/app/settings/services?m=${code}#${anchor}`, 303);

// ---- Edit one service ----
servicesPage.post("/edit", async (c) => {
  const f = (await c.req.parseBody()) as Record<string, unknown>;
  const key = one(f.key);
  const svc = (await readCatalogue(c.env.DB)).find((s) => s.key === key);
  if (!svc) return c.text("Bad request", 400);
  if (one(f.csrf) !== (await token(c, `edit:${key}`))) return c.text("Forbidden", 403);
  const { values, bad, next } = parse(f, svc, newServicesOn(c.env));
  if (bad.length) return page(c, { flash: W(c.get("member")).notSaved, status: 400, form: { key, values: { ...values, active: one(f.active), public: one(f.public), screen: one(f.screen) }, bad } });

  const changed: string[] = [];
  if (next.nameEn !== svc.nameEn) changed.push("name_en");
  if (next.nameHi !== svc.nameHi) changed.push("name_hi");
  if (next.pricePaise !== svc.pricePaise) changed.push(`price ${svc.pricePaise} -> ${next.pricePaise}`);
  if (next.minutes !== svc.minutes) changed.push(`minutes ${svc.minutes} -> ${next.minutes}`);
  if (next.dailyCap !== svc.dailyCap) changed.push(`daily_cap ${svc.dailyCap ?? "none"} -> ${next.dailyCap ?? "none"}`);
  if (next.active !== svc.active) changed.push(`active ${next.active ? "on" : "off"}`);
  if (next.public !== svc.public) changed.push(`public ${next.public ? "on" : "off"}`); // ticket 49; the words below are never in the audit
  if (next.intakeEn !== svc.intakeEn) changed.push("intake_en");
  if (next.intakeHi !== svc.intakeHi) changed.push("intake_hi");
  if (next.screen !== svc.screen) changed.push(`screen ${next.screen ? "on" : "off"}`);
  if (!changed.length) return done(c, "nothingChanged", `svc-${key}`);

  const db = c.env.DB;
  const m = c.get("member");
  const stmts = [
    ...(isSeeded(key) ? [seedRowStmt(db, key)] : []),
    db
      .prepare(
        `UPDATE services SET name_en = ?2, name_hi = ?3, price_paise = ?4, minutes = ?5, daily_cap = ?6, active = ?7, updated_at = ?8, updated_by = ?9,
           public = ?10, intake_en = ?11, intake_hi = ?12, screen = ?13 WHERE key = ?1`,
      )
      .bind(key, next.nameEn, next.nameHi, next.pricePaise, next.minutes, next.dailyCap, next.active ? 1 : 0, iso(Date.now()), m.id, next.public ? 1 : 0, next.intakeEn, next.intakeHi, next.screen ? 1 : 0),
    auditStmt(c, "SERVICE_UPDATE", `service:${key}`, changed.join("; ")),
  ];
  if (isSeeded(key) && next.pricePaise !== svc.pricePaise)
    stmts.push(auditStmt(c, "PRICE_CHANGED", key === CALL_KEY ? KEYS.intro : KEYS.single, `${svc.pricePaise} -> ${next.pricePaise}`));
  await db.batch(stmts);
  await loadPrices(c.env); // this request's isolate quotes the new prices and lengths at once
  return done(c, "saved", `svc-${key}`);
});

// ---- Add a service: off, and not offered by the bot ----
servicesPage.post("/add", async (c) => {
  const f = (await c.req.parseBody()) as Record<string, unknown>;
  if (one(f.csrf) !== (await token(c, "add"))) return c.text("Forbidden", 403);
  const { values, bad, next } = parse(f, undefined);
  if (bad.length) return page(c, { flash: W(c.get("member")).notSaved, status: 400, form: { key: "new", values: { ...values, call_first: one(f.call_first), screen: one(f.screen) }, bad } });
  const list = await readCatalogue(c.env.DB);
  const key = newKey(next.nameEn, list.map((s) => s.key));
  const sort = Math.max(0, ...list.map((s) => s.sort)) + 10;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, daily_cap, active, public, sort, updated_at, updated_by,
         intake_en, intake_hi, screen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      key, next.nameEn, next.nameHi, next.pathway, next.minutes, next.pricePaise, next.callFirst ? 1 : 0, next.dailyCap, sort, iso(Date.now()), c.get("member").id,
      next.intakeEn, next.intakeHi, next.screen ? 1 : 0,
    ),
    auditStmt(c, "SERVICE_ADD", `service:${key}`, `${next.pathway} · ${next.minutes} min · ${next.pricePaise}${next.dailyCap ? ` · cap ${next.dailyCap}` : ""}${next.screen ? " · screen" : ""}`),
  ]);
  await loadPrices(c.env);
  return done(c, "added", `svc-${key}`);
});
