// The console's design system: "sunrise calm", from the Disha Dira logo (ticket 39). Cream paper with a soft sunrise glow, deep-teal
// actions, bronze serif titles, a thin gold rule used sparingly, generous space and large type (docs/CONSOLE-PRD.md, "Design system").
// Server-rendered HTML only, no scripts. The /app console uses consoleFrame() and the components below, with CONSOLE_CSP (today's strict
// CSP plus `font-src 'self'` for the self-hosted fonts in src/fonts.ts and `img-src 'self'` / `manifest-src 'self'` for the brand files in
// src/brand.ts). All its words come from src/console-copy.ts.
// The old /admin and /amma pages keep their own shell further down (page(), CONSOLE_CSS) until they are removed; nothing under /app uses it.
// Colour is never the only signal: every status has a word. Times are always the business's time (Bengaluru).
import { html, raw } from "hono/html";
import { BRAND_PATH, HEAD_LINKS } from "./brand";
import { accentCss, hasOwnName, type AccentName } from "./business";
import { config } from "./config";
import { consoleCopy, consoleLang, type ConsoleCopy } from "./console-copy";
import { FONT_FACES } from "./fonts";
import { formatIstLang, formatIstParts, istDay } from "./slots";

// ---------- Tokens ----------
// Sampled from the logo: sun gold #F2C84B, teal water #2A9A9C, deep teal #1D556C, bronze wordmark #9A7232, slate #557878, cream #FAF9EE,
// mint #D3E9DA. Text colours are those darkened (or, in dark mode, lightened) until they pass AA; gold, sun and water are decoration only,
// never text on cream. One source for the stylesheet and for the contrast test (test/ui.test.ts checks every pair in CONTRAST_PAIRS is at
// least 4.5:1, and ink at least 12:1 on paper).
export const TOKENS = {
  light: {
    paper: "#FAF9EE", surface: "#FFFEF9", sunk: "#F3F0E1", line: "#E3DCC6",
    ink: "#14343F", muted: "#4E6C6D", bronze: "#87622A",
    accent: "#1D556C", "on-accent": "#FFFFFF", "accent-tint": "#E2EEEA",
    waiting: "#7A5607", "waiting-tint": "#FBF0D0",
    attention: "#A04B2B", "attention-tint": "#F9E6DB",
    danger: "#A5322D", "on-danger": "#FFFFFF", "danger-tint": "#F8E3DF",
    done: "#1D6857", "done-tint": "#DCEEE3",
    gold: "#F2C84B", sun: "#F8E878", water: "#2A9A9C",
  },
  dark: {
    paper: "#0E1B20", surface: "#14262D", sunk: "#1A3038", line: "#2A454E",
    ink: "#F2EFE1", muted: "#A9BFBB", bronze: "#E4C483",
    accent: "#80D0C7", "on-accent": "#0B1C21", "accent-tint": "#163A3F",
    waiting: "#F0C75A", "waiting-tint": "#332C13",
    attention: "#F4AA88", "attention-tint": "#3A2419",
    danger: "#FF9D92", "on-danger": "#0E1B20", "danger-tint": "#3D1D1E",
    done: "#88D9BE", "done-tint": "#123229",
    gold: "#F2C84B", sun: "#F8E878", water: "#34ACA4",
  },
} as const;
export type TokenName = keyof (typeof TOKENS)["light"];

// Every text colour (first) on every background (second) the stylesheet puts it on.
export const CONTRAST_PAIRS: [TokenName, TokenName][] = [
  ["ink", "paper"], ["ink", "surface"], ["ink", "sunk"], ["ink", "accent-tint"], ["ink", "waiting-tint"], ["ink", "attention-tint"], ["ink", "danger-tint"], ["ink", "done-tint"],
  ["muted", "paper"], ["muted", "surface"], ["muted", "sunk"], ["muted", "accent-tint"], ["muted", "danger-tint"], ["muted", "attention-tint"], ["muted", "waiting-tint"], ["muted", "done-tint"],
  ["bronze", "paper"], ["bronze", "surface"], ["bronze", "sunk"],
  ["accent", "paper"], ["accent", "surface"], ["accent", "sunk"], ["accent", "accent-tint"], ["on-accent", "accent"],
  ["waiting", "surface"], ["waiting", "waiting-tint"], ["attention", "surface"], ["attention", "attention-tint"],
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
  // Today: the sun rising over the horizon, as in the logo.
  today: '<path d="M2.5 17.5h19M6.5 17.5a5.5 5.5 0 0 1 11 0"/><path d="M12 5.5V8M5.2 9.2l1.7 1.7M18.8 9.2l-1.7 1.7M2.8 13.6h2.2M19 13.6h2.2M7.5 21h9"/>',
  inbox: '<path d="M3 13l2.4-7.2A2.5 2.5 0 0 1 7.8 4h8.4a2.5 2.5 0 0 1 2.4 1.8L21 13v4.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.3"/>',
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

// Which screens each role has (the PRD's permission table): a practitioner has four tabs, staff four, the owner all six.
// Practitioners speak on calls, so they have no Inbox; nobody but the owner sees money or the business's settings. A practitioner's
// Settings holds only "Alerts on this phone" (ticket 45).
const ROLE_TABS: Record<ConsoleRole, TabId[]> = {
  OWNER: ["today", "inbox", "calendar", "people", "payments", "settings"],
  PRACTITIONER: ["today", "calendar", "people", "settings"],
  STAFF: ["today", "inbox", "calendar", "people"],
};
export const tabsFor = (role: ConsoleRole): TabId[] => ROLE_TABS[role];
export const rolesFor = (tab: TabId): ConsoleRole[] => CONSOLE_ROLES.filter((r) => ROLE_TABS[r].includes(tab));
// On a phone the bottom bar holds these four (when the role has them); the rest go under More. A role with four tabs or fewer has them all.
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
// Sizes: body 19 px, nothing under 16 px, screen titles 26 px in the UI face (the serif titles are drawn larger, 34 px, because Cormorant's
// letters are small for their size), times and amounts 20 px semibold; tap targets at least 48 by 48 px with 8 px between them.
export const APP_CSS = `
:root{${vars(TOKENS.light)};--r:20px;--r-sm:14px;--glow:rgba(248,232,120,.42);--glow2:rgba(211,233,218,.55);--shade:rgba(20,52,63,.10);
--serif:"Cormorant Garamond","Noto Sans Devanagari",Georgia,serif;--sans:Jost,"Noto Sans Devanagari",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{${vars(TOKENS.dark)};--glow:rgba(242,200,75,.12);--glow2:rgba(52,172,164,.10);--shade:rgba(0,0,0,.32)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light dark;background:var(--paper)}
body{margin:0;min-height:100vh;color:var(--ink);font:400 19px/1.45 Jost,"Noto Sans Devanagari",system-ui,sans-serif;font-variant-numeric:tabular-nums lining-nums;
background:radial-gradient(110% 380px at 50% -140px,var(--glow),transparent 72%) no-repeat,radial-gradient(90% 300px at 100% 100%,var(--glow2),transparent 70%) fixed no-repeat,var(--paper)}
[lang=hi] body{line-height:1.6}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
p{margin:8px 0}
img{max-width:100%}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
::selection{background:var(--waiting-tint);color:var(--ink)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px;top:8px}
.skip:focus{left:16px;z-index:30;background:var(--surface);color:var(--ink);padding:12px 16px;border-radius:var(--r-sm)}
.muted{color:var(--muted)}
.nw{white-space:nowrap}
.crumb,a.tap{display:inline-flex;align-items:center;min-height:48px;font-weight:500}
.num{font-size:20px;font-weight:600}
.main{padding:4px 16px calc(112px + env(safe-area-inset-bottom));min-width:0}
.content{max-width:1200px;margin:0 auto}
.topline{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;margin:0 0 4px}
.brand{display:inline-flex;align-items:center;gap:12px;min-height:48px;color:var(--bronze);text-decoration:none;margin:0}
.brand .mark{width:40px;height:40px;flex:none;filter:drop-shadow(0 2px 6px var(--glow))}
.brand .bw{display:flex;flex-direction:column;min-width:0}
.brand .bn{font-family:var(--serif);font-size:26px;font-weight:600;line-height:1.05;letter-spacing:.01em}
.brand .bt{font-size:16px;font-weight:500;letter-spacing:.12em;white-space:nowrap;text-transform:uppercase;color:var(--muted);line-height:1.3}
[lang=hi] .brand .bt{letter-spacing:.04em}
.screen{margin:12px 0 28px}
.screen .eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 6px;color:var(--muted);font-size:16px;font-weight:500;letter-spacing:.06em}
.screen .eyebrow::before{content:"";width:12px;height:12px;border-radius:50%;flex:none;background:radial-gradient(circle at 50% 50%,var(--sun),var(--gold));box-shadow:0 0 0 4px var(--glow)}
.screen h1{font-family:"Cormorant Garamond","Noto Sans Devanagari",Georgia,serif;font-size:34px;line-height:1.12;font-weight:600;color:var(--bronze);letter-spacing:0;margin:0;text-wrap:balance}
[lang=hi] .screen h1{font-family:Jost,"Noto Sans Devanagari",sans-serif;font-size:26px;font-weight:600;line-height:1.35}
.screen h1::after{content:"";display:block;width:64px;height:2px;margin:14px 0 0;border-radius:2px;background:linear-gradient(90deg,var(--gold),transparent)}
.screen .visible{color:var(--muted);font-size:16px;margin:12px 0 0}
h2.sec{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:36px 0 14px}
h2.sec>span:first-child{display:inline-flex;align-items:center;gap:12px}
[lang=hi] h2.sec{letter-spacing:0}
h2.sec .n:empty{display:none}
h2.sec .n{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:0 10px;border-radius:999px;background:var(--sunk);color:var(--ink);letter-spacing:0;font-weight:600}
.screen+section>h2.sec,.screen+.ld h2.sec{margin-top:8px}
form{margin:0}
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;min-width:48px;padding:10px 20px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--surface);color:var(--ink);font-family:inherit;font-size:18px;font-weight:500;line-height:1.25;text-align:center;text-decoration:none;cursor:pointer;transition:background-color .15s,border-color .15s,box-shadow .15s}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 6px 16px -8px var(--shade)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.danger{background:var(--danger);border-color:var(--danger);color:var(--on-danger)}
.btn.quiet{background:transparent;border-color:transparent;color:var(--accent);padding:10px 12px}
.btn.quiet:hover{background:var(--accent-tint)}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;align-items:center}
.acts>.btn,.acts>form,.acts>details{flex:1 1 100%}
.acts>form>.btn,.acts>details>summary{width:100%}
.acts>.link{display:inline-flex;align-items:center;min-height:48px;padding:0 4px;font-weight:500}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin:0 0 12px;box-shadow:0 1px 2px var(--shade),0 10px 28px -22px var(--shade)}
.card.danger{box-shadow:inset 4px 0 0 var(--danger),0 1px 2px var(--shade)}
.card.attention{box-shadow:inset 4px 0 0 var(--attention),0 1px 2px var(--shade)}
.card.waiting{box-shadow:inset 4px 0 0 var(--gold),0 1px 2px var(--shade)}
.card h3{font-size:20px;line-height:1.3;font-weight:600;margin:0}
.card .why{color:var(--muted);margin:4px 0 0}
.card .chip{margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:1px 12px;font-size:16px;font-weight:500;line-height:1.5;background:var(--sunk);color:var(--muted);white-space:nowrap}
.chip::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.chip.accent{background:var(--accent-tint);color:var(--accent)}
.chip.waiting{background:var(--waiting-tint);color:var(--waiting)}
.chip.waiting::before{background:var(--gold)}
.chip.attention{background:var(--attention-tint);color:var(--attention)}
.chip.danger{background:var(--danger-tint);color:var(--danger)}
.chip.done{background:var(--done-tint);color:var(--done)}
.ledger{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:0 20px;margin:0 0 12px;box-shadow:0 1px 2px var(--shade)}
.appt{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px 16px;padding:18px 0;border-top:1px solid var(--line)}
.appt:first-child{border-top:0}
.appt .time{font-size:20px;font-weight:600;line-height:1.3;padding-right:14px;border-right:2px solid var(--gold);white-space:nowrap;color:var(--accent)}
.appt .who{font-size:20px;font-weight:600;line-height:1.3;margin:0}
.appt .who .d{color:var(--muted);font-weight:400}
.appt .meta{color:var(--muted);margin:2px 0 0}
.appt .side{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.appt .side .btn{flex:1 1 auto}
.appt .extra{grid-column:1/-1}
.appt .extra:empty{display:none}
.hero{position:relative;overflow:hidden;background:radial-gradient(120% 140% at 100% 0%,var(--glow),transparent 60%),var(--surface);border:1px solid var(--line);border-radius:24px;padding:4px 22px 8px;margin:0 0 16px;box-shadow:0 1px 2px var(--shade),0 18px 40px -28px var(--shade)}
.hero::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,var(--gold),var(--water))}
.hero .when{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:18px 0 0;font-size:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
[lang=hi] .hero .when{letter-spacing:0}
.hero .when .in{letter-spacing:0;text-transform:none;font-weight:500;color:var(--muted)}
.hero .appt{grid-template-columns:minmax(0,1fr);gap:8px;padding:8px 0 14px;border:0}
.hero .appt .time{font-size:34px;line-height:1.1;border:0;padding:0}
.hero .appt .who{font-size:26px}
.hero .appt .side>*{flex:1 1 100%}
.hero .appt .side>.chip{flex:0 0 auto}
.hero .appt .side .btn{width:100%;min-height:56px;font-size:20px}
.hero .appt .side .btn.primary{font-weight:600}
.hero .later{color:var(--muted);margin:0 0 10px}
.rows{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin:0 0 12px;box-shadow:0 1px 2px var(--shade)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;padding:12px 20px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none;transition:background-color .15s}
a.row:hover{background:var(--sunk)}
.row:first-child{border-top:0}
.row{flex-wrap:wrap}
.row>div:first-child{flex:1 1 220px;min-width:0}
span.d{white-space:nowrap}
.row .t{font-weight:600;margin:0}
.row .s{color:var(--muted);margin:0}
.row.on{background:var(--accent-tint);box-shadow:inset 4px 0 0 var(--accent)}
.av{display:inline-flex;align-items:center;justify-content:center;flex:none;width:56px;height:56px;border-radius:50%;font-family:var(--serif);font-size:30px;font-weight:600;color:var(--bronze);background:radial-gradient(circle at 50% 30%,var(--waiting-tint),var(--sunk));box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--gold)}
.thread{display:flex;flex-direction:column;gap:12px;margin:0 0 12px;padding:16px;border-radius:var(--r);background:var(--sunk);border:1px solid var(--line)}
.bubble{max-width:min(86%,560px);border-radius:18px;padding:12px 16px;background:var(--surface);border:1px solid var(--line);overflow-wrap:anywhere;box-shadow:0 1px 1px var(--shade)}
.bubble p{margin:0}
.bubble .by{font-size:16px;font-weight:500;color:var(--muted);margin:0 0 4px}
.bubble .kind{font-size:16px;color:var(--muted);margin:8px 0 0}
.bubble .view{margin:8px 0 0}
.bubble.customer{align-self:flex-start;border-bottom-left-radius:6px}
.bubble.bot,.bubble.assistant{align-self:flex-end;background:var(--paper);border-bottom-right-radius:6px}
.bubble.team{align-self:flex-end;background:var(--accent-tint);border-color:var(--accent-tint);border-bottom-right-radius:6px}
.bubble.safety{align-self:flex-end;background:var(--danger-tint);border-color:var(--danger);border-bottom-right-radius:6px}
.bubble.quiet{background:transparent;border:1px dashed var(--muted);box-shadow:none}
.bubble.quiet>p:not(.by){color:var(--muted)}
.wiped{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:16px;margin:4px 0;text-align:center}
.wiped::before,.wiped::after{content:"";flex:1 1 24px;border-top:1px solid var(--line)}
.earlier{margin:0 0 12px;text-align:center}
.earlier a{display:inline-flex;align-items:center;min-height:48px;font-weight:500}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}
details.confirm>summary{list-style:none;display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 20px;border-radius:var(--r-sm);border:1px solid var(--danger);background:var(--surface);color:var(--danger);font-size:18px;font-weight:500;line-height:1.25;cursor:pointer;text-align:center}
details.confirm>summary::-webkit-details-marker{display:none}
details.confirm .panel{margin-top:8px;background:var(--danger-tint);border-radius:var(--r-sm);padding:16px}
details.confirm .effect{margin:0 0 12px}
details.confirm .panel .btn{width:100%}
.empty{position:relative;border:1px dashed var(--line);background:var(--surface);border-radius:var(--r);padding:24px 20px 20px;margin:0 0 12px;color:var(--muted)}
.empty::before{content:"";display:block;width:36px;height:18px;margin:0 0 14px;border-radius:36px 36px 0 0;background:linear-gradient(180deg,var(--sun),var(--gold));box-shadow:0 6px 0 -4px var(--water)}
.empty p{margin:0}
.empty p+p{margin-top:12px}
.empty a{display:inline-flex;align-items:center;min-height:48px;font-weight:500}
.banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 16px;border-radius:var(--r);margin:0 0 12px;background:var(--attention-tint);border:1px solid var(--attention)}
.banner.danger{background:var(--danger-tint);border-color:var(--danger)}
.banner p{margin:0;font-weight:600}
.banner .btn{flex:0 0 auto}
.flash{background:var(--ink);color:var(--paper);border-radius:var(--r-sm);padding:14px 18px;margin:0 0 16px;font-weight:500;box-shadow:0 10px 24px -16px var(--shade)}
.ld-back{display:inline-flex;align-items:center;min-height:48px;font-weight:500;margin:0 0 8px}
.ld.open .ld-list,.ld:not(.open) .ld-detail{display:none}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;border-radius:999px;background:var(--danger);color:var(--on-danger);font-size:16px;font-weight:600;line-height:1}
.seg{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:4px;border-radius:999px;background:var(--sunk);border:1px solid var(--line);width:max-content;max-width:100%}
.seg a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 18px;border-radius:999px;color:var(--ink);text-decoration:none;font-weight:500}
.seg a.on{background:var(--surface);color:var(--accent);font-weight:600;box-shadow:0 1px 2px var(--shade),0 0 0 1px var(--line)}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.pills a{display:inline-flex;align-items:center;min-height:48px;padding:0 18px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-decoration:none;font-weight:500}
.pills a.on{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.pills .n{margin-left:8px;color:inherit;opacity:.85}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;justify-content:space-around;gap:4px;background:var(--surface);border-top:1px solid var(--line);padding:6px 8px calc(6px + env(safe-area-inset-bottom));box-shadow:0 -10px 30px -24px var(--shade)}
.tabbar>a,.tabbar>details{flex:1 1 0;max-width:120px;min-width:0}
.tabbar a.tab,.tabbar summary{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:60px;padding:4px 2px;border-radius:var(--r-sm);color:var(--muted);text-decoration:none;font-size:16px;font-weight:500;line-height:1.2;position:relative;list-style:none;cursor:pointer}
.tabbar summary::-webkit-details-marker{display:none}
.tabbar .ic{display:inline-flex;align-items:center;justify-content:center;width:60px;height:32px;border-radius:999px;transition:background-color .2s}
.tabbar .on{color:var(--accent);font-weight:600}
.tabbar .on .ic{background:var(--accent-tint);box-shadow:inset 0 -2px 0 var(--gold)}
.tabbar .badge{position:absolute;top:2px;left:calc(50% + 8px)}
.tabbar details{position:relative;display:flex}
.tabbar details>summary{flex:1}
.tabbar .sheet{position:absolute;right:0;bottom:calc(100% + 12px);width:240px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:8px;box-shadow:0 16px 40px var(--shade)}
.tabbar .sheet a{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 12px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none;font-weight:500}
.tabbar .sheet a.on{background:var(--accent-tint);color:var(--accent)}
.rail{display:none}
.rail ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.rail a.tab{display:flex;align-items:center;gap:14px;min-height:52px;padding:0 14px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none;font-weight:500;transition:background-color .15s}
.rail a.tab:hover{background:var(--sunk)}
.rail a.tab svg{color:var(--muted)}
.rail a.tab.on{background:var(--surface);color:var(--accent);font-weight:600;box-shadow:0 1px 2px var(--shade),inset 3px 0 0 var(--gold)}
.rail a.tab.on svg{color:var(--accent)}
.rail a.tab .badge{margin-left:auto}
.find{display:flex;gap:8px}
.rail .find{flex-direction:column}
.find input,.field-input{flex:1;min-width:0;min-height:48px;font:inherit;font-size:18px;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:var(--r-sm);padding:8px 14px}
.find input::placeholder{color:var(--muted);opacity:1}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
.me{color:var(--muted);font-size:16px;margin:0;padding:0 14px}
.me b{display:block;color:var(--ink);font-weight:500}
.main.plain{display:flex;align-items:flex-start;justify-content:center;padding:32px 16px 48px}
.plain .content{width:100%;max-width:560px}
.plain .logo{display:block;width:180px;height:auto;margin:0 auto 20px}
.plain .sheetc{background:var(--surface);border:1px solid var(--line);border-radius:28px;padding:28px 22px;box-shadow:0 1px 2px var(--shade),0 24px 60px -36px var(--shade)}
.plain .screen{text-align:center;margin-top:0}
.plain .screen h1::after{margin-left:auto;margin-right:auto}
.plain .acts>form,.plain .acts>.btn{flex:1 1 100%}
.plain .empty{border:0;background:transparent;padding:0;text-align:center}
.plain .empty::before{margin:0 auto 14px}
@media (prefers-reduced-motion:no-preference){
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.screen,.content>section,.content>.ld,.content>.ibx,.content>.hero,.content>.calbar,.plain .sheetc{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.content>section:nth-of-type(2){animation-delay:.06s}.content>section:nth-of-type(3){animation-delay:.12s}.content>section:nth-of-type(n+4){animation-delay:.18s}
.screen .eyebrow::before{animation:glow 3.2s ease-in-out 1 both}
@keyframes glow{from{box-shadow:0 0 0 0 var(--glow)}to{box-shadow:0 0 0 4px var(--glow)}}
}
@media (min-width:900px){
.tabbar,.topline{display:none}
.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
.rail{display:flex;flex-direction:column;gap:22px;position:sticky;top:0;height:100vh;overflow-y:auto;padding:28px 18px;border-right:1px solid var(--line);background:linear-gradient(180deg,var(--glow),transparent 220px),var(--sunk)}
.rail .brand{padding:0 8px 18px;border-bottom:1px solid var(--line)}
.rail .brand .mark{width:52px;height:52px}
.rail .brand .bn{font-size:28px}
.rail .foot{margin-top:auto;display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:1px solid var(--line)}
.rail .foot .btn{justify-content:flex-start}
.main{padding:44px 56px 72px}
.main.plain{padding:72px 48px}
.plain .sheetc{padding:40px 44px}
.screen{margin-top:0}
.screen h1{font-size:40px}
[lang=hi] .screen h1{font-size:28px}
.acts>.btn,.acts>form,.acts>details{flex:0 0 auto}
.acts>details[open]{flex:1 1 100%}
.appt{grid-template-columns:5.4em minmax(0,1fr) auto;align-items:center}
.appt .side{grid-column:auto;justify-content:flex-end}
.appt .side .btn{flex:0 0 auto}
.hero{padding:4px 32px 12px}
.hero .appt{grid-template-columns:auto minmax(0,1fr) auto;gap:8px 28px;align-items:center}
.hero .appt .time{font-size:40px;padding-right:28px;border-right:2px solid var(--gold)}
.hero .appt .side>*{flex:0 0 auto}
.hero .appt .side .btn{min-width:200px}
.ld{display:grid;grid-template-columns:minmax(320px,2fr) minmax(0,3fr);gap:28px;align-items:start}
.ld.open .ld-list,.ld:not(.open) .ld-detail{display:block}
.ld-detail{position:sticky;top:24px}
.ld-back{display:none}
}
`;

// The strict CSP of today's pages plus the self-hosted fonts and the brand's own images and manifest. Every /app response uses this.
export const CONSOLE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'";

// ---------- Components ----------
// The chip tones: paid and confirmed teal-mint (done), waiting on the customer gold (waiting), needs the team warm terracotta (attention),
// failures and safety muted red (danger), and the accent and plain ones.
export type ChipTone = "plain" | "accent" | "waiting" | "attention" | "danger" | "done";

// A word plus a colour: the word always carries the meaning.
export const statusChip = (word: string, tone: ChipTone = "plain") => html`<span class="chip ${tone}">${word}</span>`;

// Fixed lists per object: a booking (intro call or session) is Held, Confirmed, Done, Missed or Cancelled.
const BOOKING_STATUS: Record<string, [keyof ConsoleCopy, ChipTone]> = {
  HELD: ["bookingHeld", "waiting"],
  PAID: ["bookingConfirmed", "done"], RESCHEDULED: ["bookingConfirmed", "done"], CONFIRMED: ["bookingConfirmed", "done"], CREDIT_BOOKED: ["bookingConfirmed", "done"],
  CALLED_SESSION: ["bookingDone", "plain"], CALLED_NOT_FIT: ["bookingDone", "plain"], RUDE: ["bookingDone", "plain"], COMPLETED: ["bookingDone", "plain"], NOT_FIT: ["bookingDone", "plain"],
  MISSED: ["bookingMissed", "attention"], NO_SHOW: ["bookingMissed", "attention"],
  EXPIRED: ["bookingCancelled", "plain"], CANCELLED: ["bookingCancelled", "plain"], CANCELLED_BY_US: ["bookingCancelled", "plain"],
};
// A payment is Paid, Waiting, Failed, Refund on its way, Refunded, or Check with Razorpay.
const PAYMENT_STATUS: Record<string, [keyof ConsoleCopy, ChipTone]> = {
  CREATING: ["payWaiting", "waiting"], PENDING: ["payWaiting", "waiting"],
  PAID: ["payPaid", "done"], FAILED: ["payFailed", "danger"], UNKNOWN: ["payCheck", "danger"],
  REFUND_PENDING: ["payRefunding", "waiting"], REFUNDED: ["payRefunded", "plain"], REFUND_FAILED: ["payCheck", "danger"],
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

// "Asha …4821" with the last 4 digits kept on one line with their ellipsis (escaped text in, html out).
export const keep4 = (s: string) => s.split(/(…\d{4})/).map((p, i) => (i % 2 ? html`<span class="nw">${p}</span>` : html`${p}`));

// Task card: what to do, why and how long it has waited, one primary button, at most one secondary link.
export function taskCard(o: { title: string; why: string; tone?: "danger" | "attention" | "waiting" | "plain"; chip?: unknown; primary: Action; secondary?: { label: string; href: string } }) {
  return html`<article class="card ${o.tone ?? "plain"}"><h3>${keep4(o.title)}</h3><p class="why">${keep4(o.why)}</p>${o.chip ?? ""}
<div class="acts">${button({ ...o.primary, kind: o.primary.kind ?? "primary" })}${o.secondary ? html`<a class="link" href="${o.secondary.href}">${o.secondary.label}</a>` : ""}</div></article>`;
}

// Appointment row: time, first name and last 4 digits, the service, who it's for and the call language, the status in words,
// and a Call or Open action. `extra` (the outcome buttons, "Saved. Undo until …") goes under the row. Rows sit inside ledger().
export function appointmentRow(o: { time: string; name: string; waId?: string | null; service: string; details?: string[]; status?: unknown; action?: Action; extra?: unknown }) {
  // Short parts ("15-minute call") never break inside; a long one ("Waiting for payment until 2:32 pm") may.
  const parts = [o.service, ...(o.details ?? [])].filter(Boolean);
  const meta = parts.map((p, i) => html`${i ? " · " : ""}<span${p.length <= 22 ? raw(' class="nw"') : ""}>${p}</span>`);
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

// A person's initial in a gold-ringed circle (the person page and the Inbox thread): decoration, so hidden from screen readers.
export const avatar = (name: string | null | undefined) => {
  const ch = [...(name?.trim() ?? "")][0]?.toUpperCase() ?? "";
  return html`<span class="av" aria-hidden="true">${/\p{L}/u.test(ch) ? ch : "·"}</span>`;
};

// Conversation bubble: every message labelled. Assistant answers show the question type in small text.
// Staff never see a safety message's text: pass hideSafety and the bubble says only that an owner is needed.
export type From = "customer" | "bot" | "assistant" | "team" | "safety";
// `quiet`: a line about the message rather than its words (a tap, a photo, a template), drawn lighter.
// `extra`: a control under the text (ticket 38: the View button of a customer's photo or file).
export function bubble(o: { from: From; text: string; time: string; teamName?: string; kind?: string; hideSafety?: boolean; locale?: string | null; quiet?: boolean; extra?: unknown }) {
  const c = consoleCopy(o.locale);
  const who = { customer: c.fromCustomer, bot: c.fromBot, assistant: c.fromAssistant, team: o.teamName || c.roleSTAFF, safety: c.fromSafety }[o.from];
  const body = o.from === "safety" && o.hideSafety ? c.safetyHidden : o.text;
  return html`<div class="bubble ${o.from}${o.quiet ? " quiet" : ""}"><p class="by">${who} · <time>${o.time}</time></p><p>${body}</p>${o.extra ?? ""}${o.kind ? html`<p class="kind">${o.kind}</p>` : ""}</div>`;
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

// The screen's title is its question, with who can see it underneath. `eyebrow`: a quiet line above it (Today's greeting and date).
// `roles`: who sees what this screen shows, when that isn't everyone with the tab (the business's Settings: the owner alone).
export function screenHead(tab: TabId, locale?: string | null, o: { eyebrow?: string; roles?: ConsoleRole[] } = {}) {
  const c = consoleCopy(locale);
  const who = (o.roles ?? rolesFor(tab)).map((r) => roleName(r, locale)).join(", ");
  return html`<header class="screen">${o.eyebrow ? html`<p class="eyebrow">${o.eyebrow}</p>` : ""}<h1>${text(c, SCREENS[tab].question)}</h1><p class="visible">${c.visibleTo(who)}</p></header>`;
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
  accent?: AccentName; // the workspace's accent colour from Settings (src/business.ts); teal, the default, adds nothing
};

const head = (lang: string, title: string, accent: AccentName) =>
  html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${title}</title>${raw(HEAD_LINKS)}<style>${raw(FONT_FACES)}${raw(APP_CSS)}</style>${raw(accentCss(accent))}</head>`;
// The sun-and-path mark beside the name (decoration: the name is the link's text).
const markImg = (size: number) => raw(`<img class="mark" src="${BRAND_PATH}mark-112.webp" alt="" width="${size}" height="${size}">`);

export function consoleFrame(o: FrameOpts) {
  const lang = consoleLang(o.locale);
  const c = consoleCopy(lang);
  const tabs = tabsFor(o.role);
  const own = hasOwnName(o.business);
  const business = own ? o.business : c.brandNeutral; // the seeded default name is never shown
  const label = (t: TabId) => text(c, SCREENS[t].label);
  const badge = (t: TabId) => (o.badges?.[t] ? html`<span class="badge"><span class="vh">${c.waitingCount(o.badges[t] ?? 0)}: </span>${o.badges[t]}</span>` : "");
  const current = (t: TabId) => (t === o.active ? raw(' aria-current="page"') : "");
  const on = (t: TabId) => (t === o.active ? " on" : "");

  const railTabs = tabs.map((t) => html`<li><a class="tab${on(t)}" href="${SCREENS[t].href}"${current(t)}>${icon(t)}<span>${label(t)}</span>${badge(t)}</a></li>`);
  const phoneTabs = tabs.length <= 4 ? tabs : tabs.filter((t) => PHONE_TABS.includes(t));
  const moreTabs = tabs.filter((t) => !phoneTabs.includes(t));
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
  // The tagline ("Healing Center") belongs with the business's own name, never with the neutral label.
  const tagline = own ? html`<span class="bt">${config.brand.tagline}</span>` : "";

  return html`${head(lang, `${o.title} · ${business}`, o.accent ?? "teal")}<body>
<a class="skip" href="#main">${c.skipToContent}</a>
<div class="shell">
<nav class="rail" aria-label="${c.navLabel}"><a class="brand" href="/app">${markImg(52)}<span class="bw"><span class="bn">${business}</span>${tagline}</span></a>${search}<ul>${railTabs}</ul><div class="foot">${o.member ? html`<p class="me"><b>${o.member}</b>${roleName(o.role, lang)}</p>` : html`<p class="me">${roleName(o.role, lang)}</p>`}${switcher}</div></nav>
<main class="main" id="main"><div class="content"><div class="topline"><a class="brand" href="/app">${markImg(40)}<span class="bw"><span class="bn">${business}</span></span></a>${switcher}</div>${o.flash ? html`<p class="flash" role="status">${o.flash}</p>` : ""}${o.banners ?? ""}${o.body}</div></main>
</div>
<nav class="tabbar" aria-label="${c.navLabel}">${bar}</nav>
</body></html>`;
}

// A page with no tabs, on the same look: "No access" before sign-in, an invite to accept, "The console has moved". `body` is escaped html.
// The full logo sits above a single soft card.
export function plainFrame(o: { locale?: string | null; title: string; body: unknown; accent?: AccentName }) {
  const lang = consoleLang(o.locale);
  const c = consoleCopy(lang);
  const alt = `${config.brand.name} ${config.brand.tagline}`;
  return html`${head(lang, `${o.title} · ${c.brandNeutral}`, o.accent ?? "teal")}<body>
<main class="main plain" id="main"><div class="content"><img class="logo" src="${BRAND_PATH}logo-328.webp" alt="${alt}" width="328" height="300"><div class="sheetc">${o.body}</div></div></main>
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
textarea,input[type=text],input[type=search],input[type=date]{width:100%;font-size:16px;line-height:1.4;font-family:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
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
.bubble .view{margin-top:6px}
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
