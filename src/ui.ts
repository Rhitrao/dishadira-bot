// The console's design system: a calm ledger. Warm paper, dark ink, one accent colour, generous space and large type (docs/CONSOLE-PRD.md,
// "Design system"). Server-rendered HTML only, no scripts. The /app console uses consoleFrame() and the components below, with CONSOLE_CSP
// (today's strict CSP plus `font-src 'self'` for the self-hosted fonts in src/fonts.ts). All its words come from src/console-copy.ts.
// The old /admin pages keep their own shell further down (page(), CONSOLE_CSS), recoloured to the same palette, until ticket 25.
// Colour is never the only signal: every status has a word. Times are always the business's time (Bengaluru).
import { html, raw } from "hono/html";
import { consoleCopy, consoleLang, type ConsoleCopy } from "./console-copy";
import { FONT_FACES } from "./fonts";
import { formatIstLang, formatIstParts, istDay } from "./slots";

// ---------- Tokens ----------
// One source for the stylesheet and for the contrast test (test/ui.test.ts checks every pair in CONTRAST_PAIRS is at least 4.5:1).
export const TOKENS = {
  light: {
    paper: "#FBFAF7", surface: "#FFFFFF", sunk: "#F3F1EA", line: "#E2DED3",
    ink: "#14302F", muted: "#5B6B69",
    accent: "#1B6F73", "on-accent": "#FFFFFF", "accent-tint": "#E6F0EF",
    attention: "#A15C00", "attention-tint": "#FCF4E6",
    danger: "#B3261E", "on-danger": "#FFFFFF", "danger-tint": "#FBEAE8",
    done: "#2E7D4F", "done-tint": "#EEF6F0",
  },
  dark: {
    paper: "#121615", surface: "#1A201F", sunk: "#202826", line: "#2C3533",
    ink: "#E8EEEC", muted: "#9FB0AD",
    accent: "#5CC2BE", "on-accent": "#0E1A19", "accent-tint": "#16302F",
    attention: "#F0B35A", "attention-tint": "#2E2414",
    danger: "#FF8A80", "on-danger": "#121615", "danger-tint": "#33191A",
    done: "#7FD3A0", "done-tint": "#15291E",
  },
} as const;
export type TokenName = keyof (typeof TOKENS)["light"];

// Every text colour (first) on every background (second) the stylesheet puts it on.
export const CONTRAST_PAIRS: [TokenName, TokenName][] = [
  ["ink", "paper"], ["ink", "surface"], ["ink", "sunk"], ["ink", "accent-tint"], ["ink", "attention-tint"], ["ink", "danger-tint"], ["ink", "done-tint"],
  ["muted", "paper"], ["muted", "surface"], ["muted", "sunk"], ["muted", "accent-tint"], ["muted", "danger-tint"], ["muted", "attention-tint"],
  ["accent", "paper"], ["accent", "surface"], ["accent", "accent-tint"], ["on-accent", "accent"],
  ["attention", "surface"], ["attention", "attention-tint"],
  ["danger", "surface"], ["danger", "paper"], ["danger", "danger-tint"], ["on-danger", "danger"],
  ["done", "surface"], ["done", "done-tint"],
  ["paper", "ink"],
];

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(";");

// ---------- Roles and tabs ----------
export type ConsoleRole = "OWNER" | "PRACTITIONER" | "STAFF";
export const CONSOLE_ROLES: ConsoleRole[] = ["OWNER", "PRACTITIONER", "STAFF"];
export type TabId = "today" | "inbox" | "calendar" | "people" | "payments" | "settings";

const ICON: Record<TabId | "more", string> = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  inbox: '<path d="M3 13l2.4-7.2A2.5 2.5 0 0 1 7.8 4h8.4a2.5 2.5 0 0 1 2.4 1.8L21 13v4.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  people: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
  payments: '<path d="M7 4.5h10M7 9h10M7 4.5h3.5a4.5 4.5 0 0 1 0 9H7l8 6.5"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};
const icon = (id: TabId | "more") =>
  raw(`<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[id]}</svg>`);

export const SCREENS: Record<TabId, { href: string; label: keyof ConsoleCopy; question: keyof ConsoleCopy }> = {
  today: { href: "/app", label: "tabToday", question: "qToday" },
  inbox: { href: "/app/inbox", label: "tabInbox", question: "qInbox" },
  calendar: { href: "/app/calendar", label: "tabCalendar", question: "qCalendar" },
  people: { href: "/app/people", label: "tabPeople", question: "qPeople" },
  payments: { href: "/app/payments", label: "tabPayments", question: "qPayments" },
  settings: { href: "/app/settings", label: "tabSettings", question: "qSettings" },
};

// Which screens each role has (the PRD's permission table): a practitioner has three tabs, staff four, the owner all six.
// Practitioners speak on calls, so they have no Inbox; nobody but the owner sees money or settings.
const ROLE_TABS: Record<ConsoleRole, TabId[]> = {
  OWNER: ["today", "inbox", "calendar", "people", "payments", "settings"],
  PRACTITIONER: ["today", "calendar", "people"],
  STAFF: ["today", "inbox", "calendar", "people"],
};
export const tabsFor = (role: ConsoleRole): TabId[] => ROLE_TABS[role];
export const rolesFor = (tab: TabId): ConsoleRole[] => CONSOLE_ROLES.filter((r) => ROLE_TABS[r].includes(tab));
// On a phone the bottom bar holds these four (when the role has them); the rest go under More.
const PHONE_TABS: TabId[] = ["today", "inbox", "calendar", "people"];

const text = (c: ConsoleCopy, key: keyof ConsoleCopy) => c[key] as string;
export const roleName = (role: ConsoleRole, locale?: string | null) => text(consoleCopy(locale), `role${role}`);

// ---------- Small formatters ----------
// "…4821": the last 4 digits, never the whole number.
export const last4 = (waId: string | null | undefined) => (waId ? `…${waId.replace(/\D/g, "").slice(-4)}` : "");
// First name only, for rows and cards.
export const firstName = (name: string | null | undefined, fallback = "") => name?.trim().split(/\s+/)[0] || fallback;
// Bengaluru time in the member's language: clock "4:15 pm" / "शाम 4:15"; day "Thu, 29 Oct" / "गुरु, 29 अक्टूबर".
export const clock = (utc: string, locale?: string | null) => formatIstLang(utc, consoleLang(locale)).time;
export const dayName = (utc: string, locale?: string | null) => formatIstLang(utc, consoleLang(locale)).day;

// ---------- The stylesheet ----------
export const APP_CSS = `
:root{${vars(TOKENS.light)};--r:16px;--r-sm:12px}
@media (prefers-color-scheme:dark){:root{${vars(TOKENS.dark)}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light dark}
body{margin:0;background:var(--paper);color:var(--ink);font:400 19px/1.45 Jost,"Noto Sans Devanagari",system-ui,sans-serif;font-variant-numeric:tabular-nums lining-nums}
[lang=hi] body{line-height:1.6}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
p{margin:8px 0}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px;top:8px}
.skip:focus{left:16px;z-index:30;background:var(--surface);color:var(--ink);padding:12px 16px;border-radius:var(--r-sm)}
.muted{color:var(--muted)}
.num{font-size:20px;font-weight:600}
.main{padding:8px 16px calc(104px + env(safe-area-inset-bottom));min-width:0}
.content{max-width:1200px;margin:0 auto}
.topline{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px}
.brand{font-weight:600;font-size:19px;letter-spacing:.02em;margin:0}
.brand::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--accent);margin-right:10px;vertical-align:1px}
.screen{margin:8px 0 24px}
.screen h1{font-size:26px;line-height:1.25;font-weight:500;font-style:italic;letter-spacing:-.005em;margin:0}
[lang=hi] .screen h1{font-style:normal}
.screen .visible{color:var(--muted);font-size:16px;margin:4px 0 0}
h2.sec{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
[lang=hi] h2.sec{letter-spacing:0}
h2.sec .n{color:var(--ink);letter-spacing:0;font-weight:600}
.screen+section>h2.sec,.screen+.ld h2.sec{margin-top:8px}
form{margin:0}
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;min-width:48px;padding:10px 20px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--surface);color:var(--ink);font-family:inherit;font-size:18px;font-weight:500;line-height:1.25;text-align:center;text-decoration:none;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.danger{background:var(--danger);border-color:var(--danger);color:var(--on-danger)}
.btn.quiet{background:transparent;border-color:transparent;color:var(--accent);padding:10px 12px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;align-items:center}
.acts>.btn,.acts>form,.acts>details{flex:1 1 100%}
.acts>form>.btn,.acts>details>summary{width:100%}
.acts>.link{display:inline-flex;align-items:center;min-height:48px;padding:0 4px;font-weight:500}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin:0 0 12px}
.card.danger{border-left:4px solid var(--danger)}
.card.attention{border-left:4px solid var(--attention)}
.card h3{font-size:20px;line-height:1.3;font-weight:600;margin:0}
.card .why{color:var(--muted);margin:4px 0 0}
.card .chip{margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:1px 12px;font-size:16px;font-weight:500;line-height:1.5;background:var(--sunk);color:var(--muted);white-space:nowrap}
.chip::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.chip.accent{background:var(--accent-tint);color:var(--accent)}
.chip.attention{background:var(--attention-tint);color:var(--attention)}
.chip.danger{background:var(--danger-tint);color:var(--danger)}
.chip.done{background:var(--done-tint);color:var(--done)}
.ledger{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:0 20px;margin:0 0 12px}
.appt{display:grid;grid-template-columns:5.2em minmax(0,1fr);gap:12px 16px;padding:16px 0;border-top:1px solid var(--line)}
.appt:first-child{border-top:0}
.appt .time{font-size:20px;font-weight:600;line-height:1.3;padding-right:12px;border-right:1px solid var(--line);white-space:nowrap}
.appt .who{font-size:20px;font-weight:600;line-height:1.3;margin:0}
.appt .who .d{color:var(--muted);font-weight:400}
.appt .meta{color:var(--muted);margin:2px 0 0}
.appt .side{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.appt .side .btn{flex:1 1 auto}
.appt .extra{grid-column:1/-1}
.appt .extra:empty{display:none}
.rows{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin:0 0 12px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;padding:12px 20px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none}
.row:first-child{border-top:0}
.row .t{font-weight:600;margin:0}
.row .s{color:var(--muted);margin:0}
.row.on{background:var(--accent-tint);box-shadow:inset 4px 0 0 var(--accent)}
.thread{display:flex;flex-direction:column;gap:12px;margin:0 0 12px}
.bubble{max-width:min(85%,560px);border-radius:var(--r);padding:12px 16px;background:var(--surface);border:1px solid var(--line);overflow-wrap:anywhere}
.bubble p{margin:0}
.bubble .by{font-size:16px;font-weight:500;color:var(--muted);margin:0 0 4px}
.bubble .kind{font-size:16px;color:var(--muted);margin:8px 0 0}
.bubble.customer{align-self:flex-start;border-bottom-left-radius:4px}
.bubble.bot,.bubble.assistant{align-self:flex-end;background:var(--sunk);border-color:var(--sunk);border-bottom-right-radius:4px}
.bubble.team{align-self:flex-end;background:var(--accent-tint);border-color:var(--accent-tint);border-bottom-right-radius:4px}
.bubble.safety{align-self:flex-end;background:var(--danger-tint);border-color:var(--danger);border-bottom-right-radius:4px}
details.confirm>summary{list-style:none;display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 20px;border-radius:var(--r-sm);border:1px solid var(--danger);background:var(--surface);color:var(--danger);font-size:18px;font-weight:500;line-height:1.25;cursor:pointer;text-align:center}
details.confirm>summary::-webkit-details-marker{display:none}
details.confirm .panel{margin-top:8px;background:var(--danger-tint);border-radius:var(--r-sm);padding:16px}
details.confirm .effect{margin:0 0 12px}
details.confirm .panel .btn{width:100%}
.empty{border:1px dashed var(--muted);border-radius:var(--r);padding:20px;margin:0 0 12px;color:var(--muted)}
.empty p{margin:0}
.empty a{display:inline-flex;align-items:center;min-height:48px;font-weight:500}
.banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 16px;border-radius:var(--r);margin:0 0 12px;background:var(--attention-tint);border:1px solid var(--attention)}
.banner.danger{background:var(--danger-tint);border-color:var(--danger)}
.banner p{margin:0;font-weight:600}
.banner .btn{flex:0 0 auto}
.flash{background:var(--ink);color:var(--paper);border-radius:var(--r-sm);padding:12px 16px;margin:0 0 16px;font-weight:500}
.ld-back{display:inline-flex;align-items:center;min-height:48px;font-weight:500;margin:0 0 8px}
.ld.open .ld-list,.ld:not(.open) .ld-detail{display:none}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;border-radius:999px;background:var(--danger);color:var(--on-danger);font-size:16px;font-weight:600;line-height:1}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;justify-content:space-around;gap:4px;background:var(--surface);border-top:1px solid var(--line);padding:4px 8px calc(4px + env(safe-area-inset-bottom))}
.tabbar>a,.tabbar>details{flex:1 1 0;max-width:120px;min-width:0}
.tabbar a.tab,.tabbar summary{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:60px;padding:4px 2px;border-radius:var(--r-sm);color:var(--muted);text-decoration:none;font-size:16px;font-weight:500;line-height:1.2;position:relative;list-style:none;cursor:pointer}
.tabbar summary::-webkit-details-marker{display:none}
.tabbar .ic{display:inline-flex;align-items:center;justify-content:center;width:56px;height:30px;border-radius:999px}
.tabbar .on{color:var(--accent)}
.tabbar .on .ic{background:var(--accent-tint)}
.tabbar .badge{position:absolute;top:2px;left:calc(50% + 8px)}
.tabbar details{position:relative}
.tabbar .sheet{position:absolute;right:0;bottom:calc(100% + 12px);width:240px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:8px;box-shadow:0 12px 32px rgba(20,48,47,.16)}
.tabbar .sheet a{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 12px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none;font-weight:500}
.tabbar .sheet a.on{background:var(--accent-tint);color:var(--accent)}
.rail{display:none}
.rail ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.rail a.tab{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 12px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none;font-weight:500}
.rail a.tab svg{color:var(--muted)}
.rail a.tab.on{background:var(--accent-tint);color:var(--accent)}
.rail a.tab.on svg{color:var(--accent)}
.rail a.tab .badge{margin-left:auto}
.find{display:flex;gap:8px}
.rail .find{flex-direction:column}
.find input{flex:1;min-width:0;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 12px}
.find input::placeholder{color:var(--muted);opacity:1}
.me{color:var(--muted);font-size:16px;margin:0;padding:0 12px}
.me b{display:block;color:var(--ink);font-weight:500}
@media (min-width:900px){
.tabbar,.topline{display:none}
.shell{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh}
.rail{display:flex;flex-direction:column;gap:20px;position:sticky;top:0;height:100vh;overflow-y:auto;padding:24px 16px;border-right:1px solid var(--line)}
.rail .brand{padding:8px 12px 0;font-size:20px}
.rail .foot{margin-top:auto;display:flex;flex-direction:column;gap:8px}
.rail .foot .btn{justify-content:flex-start}
.main{padding:40px 48px 64px}
.screen{margin-top:0}
.acts>.btn,.acts>form,.acts>details{flex:0 0 auto}
.acts>details[open]{flex:1 1 100%}
.appt{grid-template-columns:5.2em minmax(0,1fr) auto;align-items:center}
.appt .side{grid-column:auto;justify-content:flex-end}
.appt .side .btn{flex:0 0 auto}
.ld{display:grid;grid-template-columns:minmax(300px,2fr) minmax(0,3fr);gap:24px;align-items:start}
.ld.open .ld-list,.ld:not(.open) .ld-detail{display:block}
.ld-detail{position:sticky;top:24px}
.ld-back{display:none}
}
`;

// The strict CSP of today's pages plus the self-hosted fonts. Every /app response uses this.
export const CONSOLE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'";

// ---------- Components ----------
export type ChipTone = "plain" | "accent" | "attention" | "danger" | "done";

// A word plus a colour: the word always carries the meaning.
export const statusChip = (word: string, tone: ChipTone = "plain") => html`<span class="chip ${tone}">${word}</span>`;

// Fixed lists per object: a booking (intro call or session) is Held, Confirmed, Done, Missed or Cancelled.
const BOOKING_STATUS: Record<string, [keyof ConsoleCopy, ChipTone]> = {
  HELD: ["bookingHeld", "attention"],
  PAID: ["bookingConfirmed", "done"], RESCHEDULED: ["bookingConfirmed", "done"], CONFIRMED: ["bookingConfirmed", "done"], CREDIT_BOOKED: ["bookingConfirmed", "done"],
  CALLED_SESSION: ["bookingDone", "plain"], CALLED_NOT_FIT: ["bookingDone", "plain"], RUDE: ["bookingDone", "plain"], COMPLETED: ["bookingDone", "plain"], NOT_FIT: ["bookingDone", "plain"],
  MISSED: ["bookingMissed", "attention"], NO_SHOW: ["bookingMissed", "attention"],
  EXPIRED: ["bookingCancelled", "plain"], CANCELLED: ["bookingCancelled", "plain"], CANCELLED_BY_US: ["bookingCancelled", "plain"],
};
// A payment is Paid, Waiting, Failed, Refund on its way, Refunded, or Check with Razorpay.
const PAYMENT_STATUS: Record<string, [keyof ConsoleCopy, ChipTone]> = {
  CREATING: ["payWaiting", "attention"], PENDING: ["payWaiting", "attention"],
  PAID: ["payPaid", "done"], FAILED: ["payFailed", "danger"], UNKNOWN: ["payCheck", "danger"],
  REFUND_PENDING: ["payRefunding", "attention"], REFUNDED: ["payRefunded", "plain"], REFUND_FAILED: ["payCheck", "danger"],
};
const statusFrom = (map: Record<string, [keyof ConsoleCopy, ChipTone]>, state: string, locale?: string | null) => {
  const s = map[state];
  return s ? statusChip(text(consoleCopy(locale), s[0]), s[1]) : ""; // an unknown state shows nothing rather than a code
};
export const bookingChip = (state: string, locale?: string | null) => statusFrom(BOOKING_STATUS, state, locale);
export const paymentChip = (state: string, locale?: string | null) => statusFrom(PAYMENT_STATUS, state, locale);

// A button is a link, or a POST form with its CSRF token (field `csrf`, as in today's pages). Never a GET that changes anything.
export type Action =
  | { label: string; href: string; kind?: "primary" | "secondary" | "danger" | "quiet" }
  | { label: string; post: { action: string; csrf: string; fields?: Record<string, string> }; kind?: "primary" | "secondary" | "danger" | "quiet" };
export function button(a: Action) {
  const cls = `btn ${a.kind ?? "secondary"}`;
  if ("href" in a) return html`<a class="${cls}" href="${a.href}">${a.label}</a>`;
  const fields = Object.entries(a.post.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  return html`<form method="post" action="${a.post.action}"><input type="hidden" name="csrf" value="${a.post.csrf}">${fields}<button class="${cls}" type="submit">${a.label}</button></form>`;
}

// Task card: what to do, why and how long it has waited, one primary button, at most one secondary link.
export function taskCard(o: { title: string; why: string; tone?: "danger" | "attention" | "plain"; chip?: unknown; primary: Action; secondary?: { label: string; href: string } }) {
  return html`<article class="card ${o.tone ?? "plain"}"><h3>${o.title}</h3><p class="why">${o.why}</p>${o.chip ?? ""}
<div class="acts">${button({ ...o.primary, kind: o.primary.kind ?? "primary" })}${o.secondary ? html`<a class="link" href="${o.secondary.href}">${o.secondary.label}</a>` : ""}</div></article>`;
}

// Appointment row: time, first name and last 4 digits, the service, who it's for and the call language, the status in words,
// and a Call or Open action. `extra` (the outcome buttons, "Saved. Undo until …") goes under the row. Rows sit inside ledger().
export function appointmentRow(o: { time: string; name: string; waId?: string | null; service: string; details?: string[]; status?: unknown; action?: Action; extra?: unknown }) {
  const meta = [o.service, ...(o.details ?? [])].filter(Boolean).join(" · ");
  return html`<div class="appt"><div class="time">${o.time}</div><div><p class="who">${o.name}${o.waId ? html` <span class="d">${last4(o.waId)}</span>` : ""}</p><p class="meta">${meta}</p></div>
<div class="side">${o.status ?? ""}${o.action ? button(o.action) : ""}</div><div class="extra">${o.extra ?? ""}</div></div>`;
}
export const ledger = (rows: unknown) => html`<div class="ledger">${rows}</div>`;

// Who a booking is for, and the call language, in the member's words.
export const forWhomText = (forWhom: "SELF" | "FAMILY" | "PET" | null | undefined, locale?: string | null) =>
  forWhom ? text(consoleCopy(locale), `for${forWhom}`) : "";
export const callLangText = (lang: string | null | undefined, locale?: string | null) => {
  const c = consoleCopy(locale);
  return lang ? c.callIn(lang === "hi" ? c.langHindi : c.langEnglish) : "";
};

// A row in a list that opens an item (Inbox, People, Payments). `on` marks the item open in the detail pane.
export const listRow = (o: { href: string; title: string; sub?: string; end?: unknown; on?: boolean }) =>
  html`<a class="row${o.on ? " on" : ""}" href="${o.href}"${o.on ? raw(' aria-current="true"') : ""}><div><p class="t">${o.title}</p>${o.sub ? html`<p class="s">${o.sub}</p>` : ""}</div>${o.end ?? ""}</a>`;
export const rows = (items: unknown) => html`<div class="rows">${items}</div>`;

// Conversation bubble: every message labelled. Assistant answers show the question type in small text.
// Staff never see a safety message's text: pass hideSafety and the bubble says only that an owner is needed.
export type From = "customer" | "bot" | "assistant" | "team" | "safety";
export function bubble(o: { from: From; text: string; time: string; teamName?: string; kind?: string; hideSafety?: boolean; locale?: string | null }) {
  const c = consoleCopy(o.locale);
  const who = { customer: c.fromCustomer, bot: c.fromBot, assistant: c.fromAssistant, team: o.teamName || c.roleSTAFF, safety: c.fromSafety }[o.from];
  const body = o.from === "safety" && o.hideSafety ? c.safetyHidden : o.text;
  return html`<div class="bubble ${o.from}"><p class="by">${who} · <time>${o.time}</time></p><p>${body}</p>${o.kind ? html`<p class="kind">${o.kind}</p>` : ""}</div>`;
}
export const thread = (bubbles: unknown) => html`<div class="thread">${bubbles}</div>`;

// Confirm step for anything that can't be undone in one tap: a `details` panel that opens in place, the effect in one sentence and a red
// confirm button. No script needed.
export function confirmStep(o: { label: string; effect: string; confirm: string; post: { action: string; csrf: string; fields?: Record<string, string> } }) {
  return html`<details class="confirm"><summary>${o.label}</summary><div class="panel"><p class="effect">${o.effect}</p>${button({ label: o.confirm, post: o.post, kind: "danger" })}</div></details>`;
}

// Empty state: what will appear here, and the next useful link. No dead ends.
export const emptyState = (sentence: string, next?: { label: string; href: string }) =>
  html`<div class="empty"><p>${sentence}</p>${next ? html`<a href="${next.href}">${next.label}</a>` : ""}</div>`;

// Banner: only for things that affect everyone ("Bookings are paused"), always with the button that fixes it.
export const banner = (o: { text: string; fix: { label: string; href: string }; tone?: "attention" | "danger" }) =>
  html`<div class="banner ${o.tone ?? "attention"}" role="status"><p>${o.text}</p>${button({ label: o.fix.label, href: o.fix.href })}</div>`;

// A section of a screen: the heading in small capitals with an optional count, like a ledger column.
export const section = (title: string, body: unknown, count?: number) =>
  html`<section><h2 class="sec"><span>${title}</span>${count ? html`<span class="n">${count}</span>` : ""}</h2>${body}</section>`;

// The screen's title is its question, with who can see it underneath.
export function screenHead(tab: TabId, locale?: string | null) {
  const c = consoleCopy(locale);
  const who = rolesFor(tab).map((r) => roleName(r, locale)).join(", ");
  return html`<header class="screen"><h1>${text(c, SCREENS[tab].question)}</h1><p class="visible">${c.visibleTo(who)}</p></header>`;
}

// List and detail: from 900 px the list sits on the left and the open item on the right, so you never lose your place.
// Under 900 px it shows the list, or (when an item is open) the item with a link back to the list.
export function listDetail(o: { list: unknown; detail?: unknown; backHref: string; locale?: string | null }) {
  const c = consoleCopy(o.locale);
  const open = o.detail !== undefined && o.detail !== null && o.detail !== "";
  return html`<div class="ld${open ? " open" : ""}"><div class="ld-list">${o.list}</div><div class="ld-detail">${open ? html`<a class="ld-back" href="${o.backHref}">← ${c.backToList}</a>${o.detail}` : emptyState(c.pickOne)}</div></div>`;
}

// ---------- The page frame ----------
export type FrameOpts = {
  role: ConsoleRole;
  locale?: string | null;
  active: TabId | null;
  title: string; // the browser tab's title, e.g. the screen name
  body: unknown; // already-escaped html: usually screenHead() then the screen's sections
  business: string; // the workspace's name (from settings, never hard-coded)
  member?: string; // the signed-in member's display name
  flash?: string | null;
  banners?: unknown;
  badges?: Partial<Record<TabId, number>>;
  // The language switch: a POST to `action` (default /app/language) with csrf, locale (the other language) and back (where to return).
  language?: { csrf: string; action?: string; back?: string };
  query?: string; // the current People search, shown in the rail's search box
};

export function consoleFrame(o: FrameOpts) {
  const lang = consoleLang(o.locale);
  const c = consoleCopy(lang);
  const tabs = tabsFor(o.role);
  const label = (t: TabId) => text(c, SCREENS[t].label);
  const badge = (t: TabId) => (o.badges?.[t] ? html`<span class="badge"><span class="vh">${c.waitingCount(o.badges[t] ?? 0)}: </span>${o.badges[t]}</span>` : "");
  const current = (t: TabId) => (t === o.active ? raw(' aria-current="page"') : "");
  const on = (t: TabId) => (t === o.active ? " on" : "");

  const railTabs = tabs.map((t) => html`<li><a class="tab${on(t)}" href="${SCREENS[t].href}"${current(t)}>${icon(t)}<span>${label(t)}</span>${badge(t)}</a></li>`);
  const phoneTabs = tabs.filter((t) => PHONE_TABS.includes(t));
  const moreTabs = tabs.filter((t) => !PHONE_TABS.includes(t));
  const moreOn = o.active !== null && moreTabs.includes(o.active);
  const bar = html`${phoneTabs.map((t) => html`<a class="tab${on(t)}" href="${SCREENS[t].href}"${current(t)}><span class="ic">${icon(t)}</span><span>${label(t)}</span>${badge(t)}</a>`)}${
    moreTabs.length
      ? html`<details class="more"><summary${moreOn ? raw(' class="on"') : ""}><span class="ic">${icon("more")}</span><span>${c.tabMore}</span></summary><div class="sheet">${moreTabs.map(
          (t) => html`<a${t === o.active ? raw(' class="on"') : ""} href="${SCREENS[t].href}"${current(t)}>${icon(t)}<span>${label(t)}</span></a>`,
        )}</div></details>`
      : ""
  }`;

  const other = lang === "hi" ? "en" : "hi";
  const switcher = o.language
    ? html`<form method="post" action="${o.language.action ?? "/app/language"}" class="lang"><input type="hidden" name="csrf" value="${o.language.csrf}"><input type="hidden" name="locale" value="${other}"><input type="hidden" name="back" value="${o.language.back ?? SCREENS[o.active ?? "today"].href}"><button class="btn quiet" type="submit" lang="${other}" title="${c.switchLanguage}">${c.otherLanguage}</button></form>`
    : "";
  const search = tabs.includes("people")
    ? html`<form class="find" method="get" action="${SCREENS.people.href}" role="search"><label class="vh" for="find-q">${c.searchLabel}</label><input id="find-q" type="search" name="q" value="${o.query ?? ""}" placeholder="${c.searchPlaceholder}" autocomplete="off"><button class="btn" type="submit">${c.searchButton}</button></form>`
    : "";

  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${o.title} · ${o.business}</title><style>${raw(FONT_FACES)}${raw(APP_CSS)}</style></head><body>
<a class="skip" href="#main">${c.skipToContent}</a>
<div class="shell">
<nav class="rail" aria-label="${c.navLabel}"><p class="brand">${o.business}</p>${search}<ul>${railTabs}</ul><div class="foot">${o.member ? html`<p class="me"><b>${o.member}</b>${roleName(o.role, lang)}</p>` : html`<p class="me">${roleName(o.role, lang)}</p>`}${switcher}</div></nav>
<main class="main" id="main"><div class="content"><div class="topline"><p class="brand">${o.business}</p>${switcher}</div>${o.flash ? html`<p class="flash" role="status">${o.flash}</p>` : ""}${o.banners ?? ""}${o.body}</div></main>
</div>
<nav class="tabbar" aria-label="${c.navLabel}">${bar}</nav>
</body></html>`;
}

// ---------- The old /admin pages (until ticket 25) ----------
// Rohit's console (/admin): one page shell, one stylesheet and a few small helpers, with today's CSP (no fonts). Same palette as above.
export const CONSOLE_CSS = `
:root{--bg:#FBFAF7;--card:#FFFFFF;--ink:#14302F;--muted:#5B6B69;--line:#E2DED3;--soft:#F3F1EA;--accent:#1B6F73;--accent-ink:#FFFFFF;
--red:#B3261E;--red-bg:#FBEAE8;--red-line:#F0C4BF;--amber:#A15C00;--amber-bg:#FCF4E6;--amber-line:#EED3A6;--green:#2E7D4F;--green-bg:#EEF6F0;--green-line:#BFDDC9;
--r:14px;--shadow:0 1px 2px rgba(20,48,47,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#121615;--card:#1A201F;--ink:#E8EEEC;--muted:#9FB0AD;--line:#2C3533;--soft:#202826;--accent:#5CC2BE;--accent-ink:#0E1A19;
--red:#FF8A80;--red-bg:#33191A;--red-line:#6A2D2A;--amber:#F0B35A;--amber-bg:#2E2414;--amber-line:#5E4720;--green:#7FD3A0;--green-bg:#15291E;--green-line:#2D5A3E;--shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
a{color:var(--accent)}
.wrap{max-width:760px;margin:0 auto;padding:16px 16px 104px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 16px}
header.top h1{font-size:22px;line-height:1.2;margin:0;letter-spacing:-.01em}
header.top .sub{color:var(--muted);font-size:13px}
h2{font-size:13px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px;display:flex;align-items:center;gap:8px}
h2 .count{background:var(--soft);color:var(--ink);border-radius:999px;padding:1px 9px;font-size:12px;letter-spacing:0}
h3{font-size:17px;line-height:1.3;margin:0}
p{margin:6px 0}
.muted{color:var(--muted)}
.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;margin:0 0 10px;box-shadow:var(--shadow)}
.card.red{border-color:var(--red-line);box-shadow:inset 4px 0 0 var(--red)}
.card.amber{border-color:var(--amber-line);box-shadow:inset 4px 0 0 var(--amber)}
.card .head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.card .who{color:var(--muted);font-size:14px;margin-top:2px}
.card .what{margin:6px 0 0}
.card .todo + .what{margin-top:2px}
.card .todo{margin:6px 0 0;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 10px;font-size:12.5px;font-weight:600;max-width:100%;background:var(--soft);color:var(--ink);border:1px solid var(--line)}
.chip.red{background:var(--red-bg);color:var(--red);border-color:var(--red-line)}
.chip.amber{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-line)}
.chip.green{background:var(--green-bg);color:var(--green);border-color:var(--green-line)}
.banner{border-radius:var(--r);padding:12px 14px;margin:0 0 10px;font-weight:600;border:1px solid}
.banner.red{background:var(--red-bg);color:var(--red);border-color:var(--red-line)}
.banner.amber{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-line)}
.banner.green{background:var(--green-bg);color:var(--green);border-color:var(--green-line)}
.banner .small{font-weight:400;display:block}
.health{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13.5px;color:var(--muted);margin:-2px 0 4px}
.health b{color:var(--ink);font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;vertical-align:1px}
.dot.red{background:var(--red)}.dot.amber{background:var(--amber)}
.msgs{margin:10px 0 0;border-left:3px solid var(--line);padding-left:10px}
.msg{margin:4px 0;font-size:15px;overflow-wrap:anywhere}
.msg .t{color:var(--muted);font-size:12.5px;margin-right:6px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:flex-start}
.actions form{margin:0}
form{margin:0}
button,.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-weight:600;font-size:15px;line-height:1.1;font-family:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger,.btn.danger{color:var(--red);border-color:var(--red-line)}
button.danger.solid{background:var(--red);border-color:var(--red);color:var(--card)}
textarea,input[type=text],input[type=search]{width:100%;font-size:16px;line-height:1.4;font-family:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea:focus,input:focus,button:focus-visible,.btn:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.reply{width:100%;margin-top:10px}
.reply button{margin-top:8px}
details.confirm{display:inline-block}
details.confirm>summary{list-style:none;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--line);font-weight:600;font-size:15px;cursor:pointer;background:var(--card)}
details.confirm>summary::-webkit-details-marker{display:none}
details.confirm.danger>summary{color:var(--red);border-color:var(--red-line)}
details.confirm[open]{display:block;width:100%;background:var(--soft);border-radius:12px;padding:10px 12px}
details.confirm[open]>summary{margin-bottom:8px}
details.confirm .why{font-size:14px;color:var(--muted);margin:0 0 10px}
details.note>summary{color:var(--muted);font-size:14px;cursor:pointer;min-height:32px;display:inline-flex;align-items:center}
.list{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow);margin-bottom:10px}
.li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none}
.li:first-child{border-top:0}
.li .time{font-weight:650;min-width:64px}
.li a{color:var(--ink);text-decoration:none}
.li .main{flex:1;min-width:0}
.li .main .muted{font-size:13.5px}
.li .end{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.li .act{display:flex;gap:8px;margin-top:8px}
.daylabel{font-size:14px;font-weight:650;margin:14px 0 6px}
.empty{text-align:center;color:var(--muted);padding:18px 12px}
.week{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (min-width:560px){.week{grid-template-columns:repeat(4,minmax(0,1fr))}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;box-shadow:var(--shadow)}
.kpi .k{font-size:12.5px;color:var(--muted)}
.kpi .v{font-size:24px;font-weight:700;letter-spacing:-.01em;line-height:1.2;margin-top:2px}
.kpi .d{font-size:12.5px;color:var(--muted)}
.switch .head{align-items:center}
.flash{background:var(--ink);color:var(--bg);border-radius:12px;padding:10px 14px;margin:0 0 12px;font-weight:600}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:15px;margin:8px 0 0}
.kv dt{color:var(--muted)}.kv dd{margin:0}
nav.tabs{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);display:flex;justify-content:center;padding:6px 8px calc(6px + env(safe-area-inset-bottom))}
nav.tabs a{flex:1;max-width:180px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;border-radius:10px;color:var(--muted);text-decoration:none;font-size:12.5px;font-weight:600;min-height:44px;justify-content:center}
nav.tabs a .i{font-size:18px;line-height:1}
nav.tabs a.on{color:var(--accent);background:var(--soft)}
.badge{background:var(--red);color:#fff;border-radius:999px;font-size:11px;padding:0 6px;margin-left:4px}
nav.tabs .brand{display:none}
.search{display:flex;gap:8px;margin:0 0 12px}
.search input{flex:1}
.pills{display:flex;gap:6px;overflow-x:auto;margin:0 0 12px;padding-bottom:2px;scrollbar-width:none}
.pill{flex:0 0 auto;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;border-radius:999px;padding:0 14px;min-height:36px;display:inline-flex;align-items:center;font-weight:600;font-size:14px}
.pill.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
a.li:hover{background:var(--soft)}
.thread{display:flex;flex-direction:column;gap:8px;margin-bottom:8px}
.bubble{max-width:88%;border-radius:16px;padding:8px 12px;border:1px solid var(--line);background:var(--card);overflow-wrap:anywhere;font-size:15px}
.bubble.in{align-self:flex-start;border-bottom-left-radius:6px}
.bubble.out{align-self:flex-end;background:var(--soft);border-bottom-right-radius:6px}
.bubble.out.green{background:var(--green-bg);border-color:var(--green-line)}
.bubble.out.red{background:var(--red-bg);border-color:var(--red-line)}
.bubble .meta{font-size:12px;color:var(--muted);margin-bottom:2px}
.bubble .chips{margin-top:6px}
.bubble .chips:empty{display:none}
.callnum{margin:10px 0 4px}
.nowrap{white-space:nowrap}
.li .go{color:var(--muted);font-size:22px;line-height:1}
.cols{display:block}
.cols>*{min-width:0}
/* Laptop and wider: navigation moves to the top, the page gets two columns (what needs you | the day, the numbers, the controls). */
@media (min-width:900px){
body{font-size:15px}
.wrap{max-width:1180px;padding:20px 28px 48px}
nav.tabs{position:sticky;top:0;bottom:auto;z-index:5;justify-content:flex-start;align-items:center;gap:4px;padding:8px max(28px,calc((100% - 1180px) / 2 + 28px));border-top:0;border-bottom:1px solid var(--line)}
.health{margin-bottom:10px}
nav.tabs .brand{display:block;font-weight:700;font-size:16px;margin-right:20px;letter-spacing:-.01em}
nav.tabs a{flex:0 0 auto;flex-direction:row;gap:8px;padding:0 14px;min-height:40px;font-size:14px}
nav.tabs a .i{font-size:16px}
header.top{margin-top:8px}
header.top h1{font-size:26px}
.cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(320px,1fr);gap:28px;align-items:start}
.cols>aside>h2:first-child,.cols>section>h2:first-child{margin-top:4px}
.week{grid-template-columns:repeat(4,minmax(0,1fr))}
.cols aside .week{grid-template-columns:repeat(2,minmax(0,1fr))}
.card{padding:16px 18px}
}
`;

export type Tab = "home" | "people" | "payments";
const TABS: { id: Tab; href: string; label: string; icon: string }[] = [
  { id: "home", href: "/admin", label: "Home", icon: "⌂" },
  { id: "people", href: "/admin/people", label: "People", icon: "☺" },
  { id: "payments", href: "/admin/payments", label: "Payments", icon: "₹" },
];

// One page: the shell, the stylesheet, the flash line and the tab bar. `body` is already-escaped html.
export function page(opts: { title: string; tab: Tab | null; body: unknown; flash?: string | null; test?: boolean; badge?: number }) {
  const tabs = TABS.map(
    (t) =>
      html`<a href="${t.href}" class="${t.id === opts.tab ? "on" : ""}"${t.id === opts.tab ? raw(' aria-current="page"') : ""}><span class="i" aria-hidden="true">${t.icon}</span><span>${t.label}${t.id === "home" && opts.badge ? html`<span class="badge">${opts.badge}</span>` : ""}</span></a>`,
  );
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${opts.title} · Disha Dira</title><style>${raw(CONSOLE_CSS)}</style></head><body>
<nav class="tabs" aria-label="Console"><span class="brand">Disha Dira</span>${tabs}</nav>
<div class="wrap">${opts.flash ? html`<p class="flash" role="status">${opts.flash}</p>` : ""}${opts.body}</div></body></html>`;
}

export const header = (title: string, sub: string, right: unknown = "") => html`<header class="top"><div><h1>${title}</h1><div class="sub">${sub}</div></div>${right}</header>`;

export type Tone = "red" | "amber" | "green" | "";
export const chip = (text: string, tone: Tone = "") => html`<span class="chip ${tone}">${text}</span>`;

// "…4821": enough for Rohit to recognise a number, never the whole number.
export const mask = (waId: string | null | undefined) => (waId ? `…${waId.slice(-4)}` : "");

// Bengaluru time: "9:42pm", "Fri 23 Oct, 9:42pm", or "today 9:42pm" / "yesterday 9:42pm".
export function ist(utc: string | null | undefined, nowMs = Date.now()): string {
  if (!utc) return "";
  const p = formatIstParts(utc);
  const day = istDay(Date.parse(utc));
  if (day === istDay(nowMs)) return `today ${p.time}`;
  if (day === istDay(nowMs - 86_400_000)) return `yesterday ${p.time}`;
  return `${p.day}, ${p.time}`;
}

// "just now", "14 min ago", "3 h ago", "2 days ago".
export function ago(utc: string | null | undefined, nowMs = Date.now()): string {
  if (!utc) return "";
  const m = Math.max(0, Math.round((nowMs - Date.parse(utc)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Time left until `untilMs`: "6 h 20 min", "45 min", or null once it has passed.
export function left(untilMs: number, nowMs = Date.now()): string | null {
  const m = Math.floor((untilMs - nowMs) / 60_000);
  if (m <= 0) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
