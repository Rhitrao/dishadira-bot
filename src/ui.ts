// The look of Rohit's console (/admin): one page shell, one stylesheet and a few small helpers. Server-rendered HTML only: no scripts, no fonts or
// files from elsewhere, so the strict CSP stays as it is. Colour only ever means a status (red: act now, amber: a deadline or money, green: fine).
// Dark mode follows the phone's own setting. Times are always Bengaluru time.
import { html, raw } from "hono/html";
import { formatIstParts, istDay } from "./slots";

export const CONSOLE_CSS = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#101828;--muted:#5d6779;--line:#e4e7ec;--soft:#f2f4f7;--accent:#3e4fd6;--accent-ink:#fff;
--red:#b42318;--red-bg:#fef3f2;--red-line:#fecdca;--amber:#a15c07;--amber-bg:#fffaeb;--amber-line:#fedf89;--green:#067647;--green-bg:#ecfdf3;--green-line:#abefc6;
--r:14px;--shadow:0 1px 2px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0c111b;--card:#151b27;--ink:#eef1f6;--muted:#a0a9b8;--line:#263042;--soft:#1c2433;--accent:#8b98ff;--accent-ink:#0c111b;
--red:#ff8b80;--red-bg:#2b1512;--red-line:#5c2620;--amber:#fdc35c;--amber-bg:#2a2110;--amber-line:#5a4416;--green:#5fd99a;--green-bg:#0f2a1d;--green-line:#1f5238;--shadow:none}}
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
button.danger.solid{background:var(--red);border-color:var(--red);color:#fff}
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
.week{grid-template-columns:repeat(2,minmax(0,1fr))}
.card{padding:16px 18px}
}
`;

export type Tab = "home" | "people" | "payments";
const TABS: { id: Tab; href: string; label: string; icon: string }[] = [{ id: "home", href: "/admin", label: "Home", icon: "⌂" }];

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
