// Ticket 57: the tarot game's one page and its script. Night sky to dawn: deep indigo while you shuffle, warming to rose and gold as a card
// turns over. Cormorant Garamond for names and titles, Jost for reading (the console's own self-hosted fonts). The script is plain browser
// JavaScript with no libraries; every word that came from a person (their note) is set as text, never as HTML. People who ask their phone
// for less motion get no shuffle or flip animations; a tap skips any animation.

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const FONTS = [
  ["Jost", "jost-latin-400.woff2", 400],
  ["Jost", "jost-latin-500.woff2", 500],
  ["Cormorant Garamond", "cormorant-garamond-latin-500.woff2", 500],
  ["Cormorant Garamond", "cormorant-garamond-latin-600.woff2", 600],
] as const;
const FONT_CSS = FONTS.map(([f, file, w]) => `@font-face{font-family:"${f}";font-weight:${w};font-display:swap;src:url(/tarot/fonts/${file}) format("woff2")}`).join("");

const CSS = `${FONT_CSS}
:root{--night:#120f26;--night2:#1d1740;--violet:#3a2c6b;--gold:#d9b56c;--gold2:#f0d79b;--rose:#e9a7a0;--ivory:#f5eee1;--mist:#b9b0cf;--line:rgba(217,181,108,.35);--card-w:min(27vw,120px)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;background:var(--night);color:var(--ivory);font-family:Jost,system-ui,sans-serif;font-size:16px;line-height:1.5;-webkit-tap-highlight-color:transparent}
body{background:radial-gradient(120% 60% at 50% -10%,#3b2a6e 0%,rgba(58,44,107,0) 60%),radial-gradient(90% 50% at 50% 110%,#4a2340 0%,rgba(74,35,64,0) 60%),var(--night);background-attachment:fixed;transition:background .9s}
body.dawn{background:radial-gradient(120% 60% at 50% -10%,#6b3a5e 0%,rgba(107,58,94,0) 60%),radial-gradient(90% 60% at 50% 110%,#a65d4f 0%,rgba(166,93,79,0) 65%),#24163a;background-attachment:fixed}
.stars{position:fixed;inset:0;pointer-events:none;opacity:.55;z-index:0}
main{position:relative;z-index:1;max-width:560px;margin:0 auto;padding:calc(14px + env(safe-area-inset-top)) 16px calc(56px + env(safe-area-inset-bottom))}
h1,h2,h3,.serif{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;letter-spacing:.01em}
h1{font-size:2.2rem;line-height:1.1}h2{font-size:1.7rem;line-height:1.15;margin-bottom:6px}h3{font-size:1.3rem}
.muted{color:var(--mist)}.small{font-size:.85rem}.center{text-align:center}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:10px}.brand b{font-family:"Cormorant Garamond",serif;font-size:1.25rem;font-weight:600;color:var(--gold2)}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:.82rem;color:var(--gold2);background:rgba(217,181,108,.07)}
.hero{text-align:center;margin:10px 0 22px}.hero p{margin-top:6px}
.moon{display:inline-flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--mist);font-size:.9rem}
.moon i{width:18px;height:18px;border-radius:50%;display:inline-block;box-shadow:inset 0 0 0 1px var(--gold)}
.tile{display:block;width:100%;text-align:left;border:1px solid var(--line);border-radius:18px;padding:18px 44px 18px 18px;margin:12px 0;background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));color:inherit;font:inherit;cursor:pointer;position:relative;overflow:hidden}
.tile:hover,.tile:focus-visible{border-color:var(--gold);outline:none}
.tile h3{color:var(--gold2)}.tile .go{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:1.4rem;color:var(--gold)}
.tile.done{opacity:.92}.tile .row{display:flex;gap:14px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:999px;padding:13px 22px;font:500 1rem Jost,sans-serif;cursor:pointer;background:linear-gradient(180deg,var(--gold2),var(--gold));color:#2a1d0c;text-decoration:none;min-height:48px}
.btn.ghost{background:transparent;color:var(--gold2);border:1px solid var(--line)}
.btn:focus-visible{outline:2px solid var(--ivory);outline-offset:3px}
.bar{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:12px;margin:calc(-14px - env(safe-area-inset-top)) -16px 16px;padding:calc(8px + env(safe-area-inset-top)) 16px 8px;background:rgba(18,15,38,.86);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid rgba(217,181,108,.18)}
.bar .title{font-family:"Cormorant Garamond",serif;font-weight:600;font-size:1.15rem;color:var(--gold2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.back{display:inline-flex;align-items:center;gap:6px;min-height:48px;min-width:48px;padding:8px 18px 8px 12px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.07);color:var(--ivory);font:500 1rem Jost,sans-serif;cursor:pointer;flex:none}
.back b{font-size:1.5rem;line-height:1;color:var(--gold2);font-weight:400}.back:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.list button{display:block;width:100%;text-align:left;padding:14px 16px;margin:8px 0;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:inherit;font:inherit;cursor:pointer}
.list button:hover,.list button:focus-visible{border-color:var(--gold);outline:none}
.stage{min-height:62vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px}
.breath{width:150px;height:150px;border-radius:50%;border:1px solid var(--gold);display:grid;place-items:center;animation:breathe 6s ease-in-out infinite;background:radial-gradient(circle,rgba(217,181,108,.18),rgba(217,181,108,0) 70%)}
@keyframes breathe{0%,100%{transform:scale(.75)}50%{transform:scale(1.08)}}
.card{width:var(--card-w);aspect-ratio:.575;border-radius:10px;position:relative;transform-style:preserve-3d;transition:transform .95s cubic-bezier(.2,.7,.2,1)}
.card .face,.card .backside{position:absolute;inset:0;border-radius:10px;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden}
.card .face{transform:rotateY(180deg);background:#f3e9d2;box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(217,181,108,.6)}
.card .face img{width:100%;height:100%;object-fit:cover;display:block}
.card.rev .face img{transform:rotate(180deg)}
.card.flipped{transform:rotateY(180deg)}
.backside{background:radial-gradient(circle at 50% 50%,#3a2c6b 0%,#1b1438 70%);box-shadow:0 8px 22px rgba(0,0,0,.5),inset 0 0 0 1px var(--gold),inset 0 0 0 5px #1b1438,inset 0 0 0 6px rgba(217,181,108,.6)}
.backside svg{position:absolute;inset:18% 14%;width:72%;height:64%}
.deck{position:relative;width:var(--card-w);aspect-ratio:.575;cursor:pointer;border:0;background:none}
.deck .card{position:absolute;inset:0}
.deck.riffle .card:nth-child(odd){animation:riffL 1.1s ease-in-out}.deck.riffle .card:nth-child(even){animation:riffR 1.1s ease-in-out}
@keyframes riffL{0%,100%{transform:none}35%{transform:translateX(-60%) rotate(-8deg)}60%{transform:translateX(-10%) rotate(-2deg)}}
@keyframes riffR{0%,100%{transform:none}35%{transform:translateX(60%) rotate(8deg)}60%{transform:translateX(10%) rotate(2deg)}}
.piles{display:flex;gap:18px;justify-content:center}
.piles button{border:0;background:none;cursor:pointer;padding:0;--card-w:min(22vw,92px)}
.piles button:hover .backside,.piles button:focus-visible .backside{box-shadow:0 0 0 2px var(--gold2),0 0 24px rgba(240,215,155,.5)}
.fan{position:relative;width:100%;height:200px;margin:8px 0 4px}
.fan button{position:absolute;left:50%;top:26px;border:0;background:none;padding:0;cursor:pointer;--card-w:min(15vw,64px);transform-origin:50% 300%;transition:transform .35s ease}
.fan button .card{transition:transform .35s ease,filter .35s}
.fan button.chosen .card{transform:translateY(-26px);filter:drop-shadow(0 0 12px rgba(240,215,155,.85))}
.fan button:focus-visible .backside{box-shadow:0 0 0 2px var(--ivory)}
.slots{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.slot{display:flex;flex-direction:column;align-items:center;gap:8px}
.slot .pos{font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--gold2)}
.reading{margin-top:22px}
.rcard{display:grid;grid-template-columns:auto 1fr;gap:16px;padding:18px 0;border-top:1px solid var(--line)}
.rcard .card{--card-w:min(26vw,104px)}
.rcard .pos{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold2)}
.rcard h3{margin:2px 0 4px}.rcard .kw{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 8px}
.rcard .kw span{font-size:.78rem;border:1px solid var(--line);border-radius:999px;padding:1px 9px;color:var(--mist)}
.rcard .theme{margin-top:6px;color:var(--gold2)}.rcard .ask{margin-top:8px;font-family:"Cormorant Garamond",serif;font-size:1.15rem;font-style:italic;color:var(--rose)}
.summary{border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin:18px 0;background:rgba(217,181,108,.06)}
.summary h3{color:var(--gold2);margin-bottom:6px}.summary p+p{margin-top:6px}
textarea{width:100%;min-height:90px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ivory);font:inherit;padding:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.note{font-size:.82rem;color:var(--mist);text-align:center;margin-top:28px}
.grid{display:grid;grid-template-columns:repeat(13,1fr);gap:3px;margin-top:10px}
.grid div{aspect-ratio:.575;border-radius:3px;border:1px solid rgba(217,181,108,.22);background:rgba(255,255,255,.03);overflow:hidden}
.grid img{width:100%;height:100%;object-fit:cover;display:block}
.jitem{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line);cursor:pointer;background:none;border-left:0;border-right:0;border-bottom:0;width:100%;color:inherit;font:inherit;text-align:left}
.jitem img{width:34px;border-radius:4px}
.toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#2b2150;border:1px solid var(--line);padding:10px 16px;border-radius:999px;font-size:.9rem;z-index:5}
.again{display:block;margin:-4px 0 10px auto;background:none;border:0;color:var(--gold2);font:500 .88rem Jost,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.summary.today{background:linear-gradient(160deg,rgba(233,167,160,.12),rgba(217,181,108,.06))}
.summary.for-you{border-color:var(--rose);background:rgba(233,167,160,.08)}.summary.for-you h3{color:var(--rose)}
details.art{border:1px solid var(--line);border-radius:16px;padding:12px 16px;margin:10px 0;background:rgba(255,255,255,.03)}
details.art summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:baseline;gap:10px}
details.art summary::-webkit-details-marker{display:none}
.art-name{font-size:1.25rem;color:var(--gold2)}
.art-item{padding:10px 0;border-top:1px solid rgba(217,181,108,.18)}.art-item:first-of-type{margin-top:8px}
.art-label{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mist)}.art-value{font-size:1.3rem;color:var(--ivory)}
.form{display:flex;flex-direction:column;gap:14px;margin-top:14px}
.field{display:flex;flex-direction:column;gap:6px}.field span{font-weight:500}
.field input,.field select{width:100%;min-height:48px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--ivory);font:inherit;padding:10px 12px;color-scheme:dark}
.field input:focus,.field select:focus,textarea:focus{outline:2px solid var(--gold);outline-offset:1px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:.92rem}.check input{width:22px;height:22px;margin-top:2px;accent-color:var(--gold)}
.err{color:var(--rose);min-height:1.2em}
.table{position:relative;margin:0 auto}
.tslot{position:absolute;display:flex;flex-direction:column;align-items:center}
.tslot .pos{display:block;height:30px;font-size:.62rem;line-height:1.15;letter-spacing:.08em;text-transform:uppercase;color:var(--gold2);text-align:center;overflow:hidden}
.tslot .tcard{display:flex;align-items:center;justify-content:center}
.tslot.cross{z-index:2}.tslot.cross .tcard{transform:rotate(90deg)}
.ghost-card{width:var(--card-w);aspect-ratio:.575;border-radius:2px;border:1px solid var(--gold);background:rgba(217,181,108,.15)}
.mini{width:96px;display:flex;justify-content:center;flex:none}
.stage-table{display:flex;justify-content:center;margin:16px 0 6px}
.summary.story{border-color:var(--gold);background:linear-gradient(160deg,rgba(217,181,108,.14),rgba(233,167,160,.08))}
.summary.story h3{display:inline-block;margin-right:8px}
.story-text p{font-size:1.06rem;line-height:1.65}.story-text p+p{margin-top:10px}
.listen{float:right;min-height:40px;padding:8px 16px;font-size:.95rem;margin:-4px 0 8px 8px}
.listen[disabled]{opacity:.5}
.shimmer{animation:shim 1.6s ease-in-out infinite}@keyframes shim{50%{opacity:.45}}
.theme-card{border:1px solid var(--line);border-radius:20px;padding:16px;margin:14px 0;background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.015))}
.theme-card .head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.theme-card h3{color:var(--gold2)}
.msg{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;margin:12px 0;width:100%;padding:10px;border-radius:14px;border:1px solid rgba(217,181,108,.2);background:rgba(0,0,0,.14);color:inherit;font:inherit;text-align:left;cursor:pointer}
.msg .card{--card-w:58px}.msg .lbl{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--rose)}.msg .nm{font-family:"Cormorant Garamond",serif;font-size:1.15rem;font-weight:600}
.chip.free{color:#b9e3c6;border-color:rgba(185,227,198,.4);background:rgba(185,227,198,.07)}.chip.lock{color:var(--mist)}
.section{margin-top:28px}.danger{color:var(--rose)!important;border-color:rgba(233,167,160,.45)!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const BACK_SVG = `<svg viewBox="0 0 100 140" aria-hidden="true" fill="none" stroke="#d9b56c" stroke-width="1.2"><circle cx="50" cy="70" r="30"/><circle cx="50" cy="70" r="22" stroke-opacity=".5"/><path d="M50 30v80M10 70h80M22 42l56 56M78 42l-56 56" stroke-opacity=".35"/><path d="M50 52c6 6 6 14 0 22-6-8-6-16 0-22zM50 74c8-2 14 2 16 8-8 2-14 0-16-8zM50 74c-8-2-14 2-16 8 8 2 14 0 16-8z" fill="#d9b56c" fill-opacity=".18"/><circle cx="50" cy="70" r="2" fill="#f0d79b"/></svg>`;

export function pageHtml(waDigits: string, pin = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Disha Dira Tarot</title><meta name="theme-color" content="#120f26"><meta name="robots" content="noindex">
<meta name="description" content="A daily tarot ritual for calm moments, with Shantha Rao. A reflection tool, not advice or prediction.">
<style>${CSS}</style></head><body>
<canvas class="stars" id="stars" aria-hidden="true"></canvas>
<main id="app" aria-live="polite"><div class="stage"><p class="muted">Shuffling the stars…</p></div></main>
<template id="back">${BACK_SVG}</template>
<script src="/tarot/app.js" data-wa="${esc(waDigits)}" data-pin="${pin ? "1" : ""}" defer></script>
</body></html>`;
}

// The browser script. Plain ES2019, no template literals (it lives inside one), so a reader can follow it top to bottom.
export const APP_JS = String.raw`(function () {
"use strict";
var WA = document.currentScript.getAttribute("data-wa");
var PIN = document.currentScript.getAttribute("data-pin") === "1";
var app = document.getElementById("app");
var BACK = document.getElementById("back").innerHTML;
var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var S = { data: null, kind: null, theme: null, spread: null, qi: null, own: null, picks: [], count: 0 };

function el(tag, attrs, kids) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "text") n.textContent = attrs[k];
    else if (k === "html") n.innerHTML = attrs[k];
    else if (k === "on") for (var e in attrs.on) n.addEventListener(e, attrs.on[e]);
    else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return n;
}
function clear() { stopVoice(); app.innerHTML = ""; window.scrollTo(0, 0); }
// Ticket 61: a sticky top bar with a big back button (48px, with a label) and the screen's name.
function bar(label, fn, title) {
  return el("div", { class: "bar" }, [el("button", { class: "back", type: "button", "aria-label": "Back to " + label, on: { click: fn } }, [el("b", { "aria-hidden": "true", text: "‹" }), el("span", { text: label })]), title ? el("span", { class: "title", text: title }) : null]);
}
function twoTap(text, again, fn) {
  var armed = false;
  var b = el("button", { class: "btn ghost danger", type: "button", text: text, on: { click: function () { if (!armed) { armed = true; b.textContent = again; return; } fn(); } } });
  return b;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, REDUCED ? 0 : ms); }); }
function toast(t) { var x = el("div", { class: "toast", role: "status", text: t }); document.body.appendChild(x); setTimeout(function () { x.remove(); }, 2600); }
function waLink(text) { return "https://wa.me/" + WA + "?text=" + encodeURIComponent(text); }

function api(path, body) {
  var opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" } : { credentials: "same-origin" };
  return fetch("/tarot/api/" + path, opt).then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
}

function back() { var d = el("div", { class: "backside", html: BACK }); return d; }
function cardEl(id, reversed, flipped) {
  var c = el("div", { class: "card" + (reversed ? " rev" : "") + (flipped ? " flipped" : "") });
  c.appendChild(back());
  var f = el("div", { class: "face" });
  if (id) f.appendChild(el("img", { src: "/tarot/art/" + id + ".webp", alt: "", loading: "lazy" }));
  c.appendChild(f);
  return c;
}

// The moon tonight, worked out on the phone (synodic month from a known new moon). Nothing is sent anywhere.
function moon() {
  var days = (Date.now() - Date.UTC(2000, 0, 6, 18, 14)) / 864e5;
  var age = ((days % 29.530588853) + 29.530588853) % 29.530588853;
  var names = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
  var i = Math.floor((age / 29.530588853) * 8 + 0.5) % 8;
  var lit = Math.round((1 - Math.cos((age / 29.530588853) * 2 * Math.PI)) / 2 * 100);
  return { name: names[i], lit: lit, waxing: age < 14.77 };
}
function moonEl() {
  var m = moon();
  var dot = el("i");
  var p = m.lit / 100;
  dot.style.background = m.waxing
    ? "linear-gradient(90deg,#120f26 " + Math.round((1 - p) * 100) + "%,#f0d79b " + Math.round((1 - p) * 100) + "%)"
    : "linear-gradient(90deg,#f0d79b " + Math.round(p * 100) + "%,#120f26 " + Math.round(p * 100) + "%)";
  return el("div", { class: "moon" }, [dot, m.name + " · " + m.lit + "% lit"]);
}
function greeting() { var h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }

function stars() {
  var c = document.getElementById("stars"); var dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; c.style.width = innerWidth + "px"; c.style.height = innerHeight + "px";
  var x = c.getContext("2d"); var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  for (var i = 0; i < 90; i++) { x.fillStyle = "rgba(245,238,225," + (0.2 + rnd() * 0.6) + ")"; x.beginPath(); x.arc(rnd() * c.width, rnd() * c.height * 0.8, (rnd() * 1.1 + 0.2) * dpr, 0, 7); x.fill(); }
}

function header() {
  var d = S.data;
  return el("div", { class: "top" }, [
    el("div", { class: "brand" }, [el("b", { text: "Disha Dira Tarot" })]),
    el("div", { class: "chips" }, [
      el("span", { class: "chip", title: "Days in a row", text: "✦ " + d.streak + (d.streak === 1 ? " day" : " days") }),
      el("span", { class: "chip", title: "Cards collected", text: d.seen.length + " / 78" }),
    ]),
  ]);
}
function footer() { return el("p", { class: "note", text: "A reflection tool for calm moments. Not advice or prediction." }); }

function showLogin(old) {
  clear();
  var s = el("div", { class: "stage" });
  s.appendChild(cardEl(null, false, false));
  s.appendChild(el("h1", { text: "Disha Dira Tarot" }));
  s.appendChild(el("p", { class: "muted", text: old ? "That link has already been used or has expired. Log in again below." : "One calm reading a day, for the questions that matter to you. With Shantha Rao." }));
  var status = el("p", { class: "small muted", role: "status", text: "WhatsApp opens with a short code typed in. Send it, come back here, and you are in. No password needed." });
  var go = el("button", { class: "btn", type: "button", text: "Continue with WhatsApp" });
  go.onclick = function () { codeLogin(status, go); };
  s.appendChild(go); s.appendChild(status);
  if (PIN) s.appendChild(el("button", { class: "again", style: "margin:0 auto", type: "button", text: "Tester login", on: { click: function () { pinForm(s); } } }));
  app.appendChild(s); app.appendChild(footer());
  var saved = null; try { saved = JSON.parse(sessionStorage.getItem("ddCode") || "null"); } catch (e) {}
  if (saved && saved.code) pollCode(saved, status, go);
}
// Ticket 61: testers (test only) log in with their number and the test PIN.
function pinForm(s) {
  if (s.querySelector(".pinform")) return;
  var phone = el("input", { type: "tel", inputmode: "tel", autocomplete: "tel", placeholder: "Your number, e.g. 98xxxxxxxx", maxlength: "20" });
  var pin = el("input", { type: "password", inputmode: "numeric", autocomplete: "off", placeholder: "PIN", maxlength: "20" });
  var err = el("p", { class: "err", role: "alert" });
  var f = el("form", { class: "form pinform", style: "width:100%;max-width:320px" }, [el("label", { class: "field" }, [el("span", { text: "Tester number" }), phone]), el("label", { class: "field" }, [el("span", { text: "PIN" }), pin]), err, el("button", { class: "btn", type: "submit", text: "Log in" })]);
  f.addEventListener("submit", function (e) {
    e.preventDefault(); err.textContent = "";
    api("tester-login", { phone: phone.value, pin: pin.value }).then(function (r) {
      if (r.ok) { load(); return; }
      err.textContent = r.error === "wait" ? "Too many tries. Please wait 15 minutes." : "That number and PIN do not match a tester.";
    }).catch(function () { err.textContent = "No connection. Please try again."; });
  });
  s.appendChild(f); phone.focus();
}
// Ticket 60: log in by sending "TAROT <code>" on WhatsApp; this page (or the app) waits for the bot to see it.
function codeLogin(status, go) {
  go.setAttribute("disabled", "");
  api("code/start", {}).then(function (r) {
    if (!r.code) { go.removeAttribute("disabled"); status.textContent = "Too many people are logging in right now. Please try again in a minute."; return; }
    try { sessionStorage.setItem("ddCode", JSON.stringify({ code: r.code, secret: r.secret, at: Date.now() })); } catch (e) {}
    window.open(r.wa, "_blank");
    pollCode(r, status, go);
  }).catch(function () { go.removeAttribute("disabled"); status.textContent = "No connection. Please try again."; });
}
function pollCode(r, status, go) {
  status.textContent = "Waiting for your message with the code " + r.code + "… Send it in WhatsApp, then come back here.";
  go.textContent = "Open WhatsApp again";
  go.removeAttribute("disabled");
  go.onclick = function () { window.open("https://wa.me/" + WA + "?text=" + encodeURIComponent("TAROT " + r.code), "_blank"); };
  var tries = 0;
  (function tick() {
    api("code/poll", { code: r.code, secret: r.secret }).then(function (p) {
      if (p.ok) { try { sessionStorage.removeItem("ddCode"); } catch (e) {} load(); return; }
      if (p.expired || ++tries > 240) { try { sessionStorage.removeItem("ddCode"); } catch (e) {} showLogin(false); return; }
      setTimeout(tick, 2500);
    }).catch(function () { setTimeout(tick, 5000); });
  })();
}

// Ticket 60: in the Android app, a daily reminder from the phone itself (no message is sent by us). Off until the person turns it on.
function isApp() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
function notes() { return isApp() && window.Capacitor.Plugins ? window.Capacitor.Plugins.LocalNotifications : null; }
function reminderBox() {
  var LN = notes(); if (!LN) return null;
  var saved = null; try { saved = localStorage.getItem("ddReminder"); } catch (e) {}
  var time = el("input", { type: "time", value: saved || "07:30", "aria-label": "Reminder time" });
  var state = el("p", { class: "small muted", text: saved ? "On, every day at " + saved + "." : "Off." });
  var on = el("button", { class: "btn ghost", type: "button", text: saved ? "Change time" : "Turn on", on: { click: function () {
    LN.requestPermissions().then(function (p) {
      if (p.display !== "granted") { state.textContent = "Please allow notifications for Disha Dira Tarot in your phone's settings."; return; }
      var hm = time.value.split(":");
      return LN.cancel({ notifications: [{ id: 1 }] }).catch(function () {}).then(function () {
        return LN.schedule({ notifications: [{ id: 1, title: "Your card is waiting", body: "Take a breath and draw today's card.", schedule: { on: { hour: Number(hm[0]), minute: Number(hm[1]) } } }] });
      }).then(function () { try { localStorage.setItem("ddReminder", time.value); } catch (e) {} state.textContent = "On, every day at " + time.value + "."; off.style.display = ""; });
    }).catch(function () { state.textContent = "Could not set the reminder."; });
  } } });
  var off = el("button", { class: "btn ghost", type: "button", text: "Turn off", style: saved ? "" : "display:none", on: { click: function () {
    LN.cancel({ notifications: [{ id: 1 }] }).catch(function () {}); try { localStorage.removeItem("ddReminder"); } catch (e) {}
    state.textContent = "Off."; off.style.display = "none";
  } } });
  return el("div", { class: "summary" }, [el("h3", { text: "Daily reminder" }), el("p", { class: "small", text: "A gentle note from your phone once a day. Nothing is sent to us." }), el("label", { class: "field" }, [el("span", { text: "Time" }), time]), el("div", { class: "actions" }, [on, off]), state]);
}

// What a person may read in a theme right now, in words.
function accessLine(k) {
  var a = S.data.access ? S.data.access[k] : "free";
  if (a === "tester") return "Tester: as many readings as you like.";
  if (a === "pass") return "Your pass is active until " + S.data.pass.endsAt.slice(0, 10) + ".";
  if (a === "free") return "Your first reading in this theme is free.";
  return "Your free reading here is used. Today's message stays free every day.";
}
function themeCard(k) {
  var t = S.data.themes[k], m = S.data.messages ? S.data.messages[k] : null, a = S.data.access ? S.data.access[k] : "free";
  var chip = { tester: ["chip", "Tester"], pass: ["chip", "Pass active"], free: ["chip free", "1 free reading"], locked: ["chip lock", "Pass needed"] }[a];
  var card = el("div", { class: "theme-card" }, [el("div", { class: "head" }, [el("h3", { text: t.label }), el("span", { class: chip[0], text: chip[1] })]), el("p", { class: "muted small", text: t.blurb })]);
  if (m) {
    var ce = cardEl(m.id, m.reversed, true);
    card.appendChild(el("button", { class: "msg", type: "button", "aria-label": "Today's message: " + m.name, on: { click: function () { showMessage(k); } } }, [ce, el("div", {}, [
      el("div", { class: "lbl", text: "Today's message" }), el("div", { class: "nm", text: m.name + (m.reversed ? " (upside down)" : "") }), el("p", { class: "small", text: m.theme }),
    ])]));
  }
  card.appendChild(el("div", { class: "actions", style: "margin:4px 0 0" }, [el("button", { class: a === "locked" ? "btn ghost" : "btn", type: "button", text: a === "locked" ? "See passes" : "Ask the cards", on: { click: function () {
    S.theme = k; if (a === "locked") showPasses(k); else showSpreads();
  } } })]));
  return card;
}
// Today's message in one theme, opened up: the card, what it says for this theme, and a question to sit with.
function showMessage(k) {
  var m = S.data.messages[k], t = S.data.themes[k];
  clear(); document.body.classList.add("dawn");
  app.appendChild(bar("Home", showHome, "Today's message"));
  var ce = cardEl(m.id, m.reversed, true); ce.style.setProperty("--card-w", "min(52vw,220px)");
  app.appendChild(el("div", { class: "stage", style: "min-height:auto;margin:8px 0 18px" }, [ce]));
  app.appendChild(el("p", { class: "center muted small", text: t.label }));
  app.appendChild(el("h2", { class: "center", text: m.name + (m.reversed ? " (upside down)" : "") }));
  var kw = el("div", { class: "chips", style: "justify-content:center;margin:8px 0 14px" }); m.keywords.forEach(function (w) { kw.appendChild(el("span", { class: "chip", text: w })); });
  app.appendChild(kw);
  app.appendChild(el("div", { class: "summary story" }, [el("h3", { text: "Today, for " + t.label.toLowerCase() }), el("p", { text: m.theme }), el("p", { class: "muted", text: m.meaning }), el("p", { class: "serif", style: "font-size:1.2rem;font-style:italic;color:var(--rose)", text: m.ask })]));
  app.appendChild(el("div", { class: "actions", style: "justify-content:center" }, [el("button", { class: "btn", text: "Ask the cards about " + t.label.split(" ")[0].toLowerCase(), on: { click: function () { S.theme = k; if (S.data.access[k] === "locked") showPasses(k); else showSpreads(); } } })]));
  app.appendChild(footer());
}
// Ticket 61: after the free reading in a theme, a pass. Passes go on sale in a later ticket; until then this screen says so plainly.
function showPasses(k) {
  clear(); document.body.classList.remove("dawn");
  app.appendChild(bar("Home", showHome, "Passes"));
  app.appendChild(el("h2", { text: "Keep reading with a pass" }));
  app.appendChild(el("p", { class: "muted", text: "Your free reading in " + S.data.themes[k].label + " is used. A pass opens every theme and every spread for a set number of days. It is paid once and never renews by itself." }));
  app.appendChild(el("div", { class: "summary" }, [el("h3", { text: "Passes open soon" }), el("p", { text: "Until then, today's card and today's message in each theme stay free, every day." })]));
  app.appendChild(el("div", { class: "summary" }, [
    el("h3", { text: "Want to talk it through?" }),
    el("p", { class: "muted", text: "Shantha Rao can talk with you on a ₹99 call." }),
    el("div", { class: "actions" }, [el("a", { class: "btn", href: waLink("Book a call"), rel: "noopener", text: "Book a ₹99 call" })]),
  ]));
  app.appendChild(footer());
}
function deleteHistoryBtn() {
  return twoTap("Delete my history", "Tap again to delete all readings", function () {
    api("history/delete", {}).then(function (r) { toast(r.ok ? "Your readings and notes are deleted." : "Could not delete. Please try again."); load(); });
  });
}

function showHome() {
  stopVoice(); clear(); document.body.classList.remove("dawn");
  var d = S.data, ins = d.insights;
  app.appendChild(header());
  app.appendChild(el("div", { class: "hero" }, [moonEl(), el("h1", { text: greeting() + (ins && ins.firstName ? ", " + ins.firstName : "") }), el("p", { class: "muted", text: "Take a breath. What would you like to look at today?" })]));
  if (ins) {
    var box = el("div", { class: "summary today" }, [el("h3", { text: "Today for you" })]);
    ins.today.forEach(function (l) { box.appendChild(el("p", { text: l })); });
    app.appendChild(box);
  }
  var daily = d.today.daily;
  app.appendChild(el("button", { class: "tile" + (daily ? " done" : ""), on: { click: function () { daily ? showReading(daily) : beginDaily(); } } }, [
    el("div", { class: "row" }, [
      daily ? (function () { var c = cardEl(daily.cards[0].id, daily.cards[0].reversed, true); c.style.setProperty("--card-w", "52px"); return c; })() : null,
      el("div", {}, [el("h3", { text: daily ? "Today's card: " + daily.cards[0].name : "Today's card" }), el("p", { class: "muted small", text: daily ? "Tap to read it again." : "One card to carry through your day." })]),
    ]),
    el("span", { class: "go", text: "›" }),
  ]));
  if (daily && d.tester) app.appendChild(el("button", { class: "again", text: "Draw another card (tester)", on: { click: beginDaily } }));
  // Ticket 61: the three themes live on the home screen, each with today's message (one free card a day) and its own reading.
  app.appendChild(el("h2", { class: "section", text: "Your themes today" }));
  app.appendChild(el("p", { class: "muted small", text: "A free message in each theme, every day. Tap a theme to ask your own question." }));
  Object.keys(d.themes).forEach(function (k) { app.appendChild(themeCard(k)); });
  var sp = d.today.spread;
  if (sp) app.appendChild(el("button", { class: "tile done", on: { click: function () { showReading(sp); } } }, [
    el("h3", { text: "Your latest reading" }), el("p", { class: "muted small", text: sp.question + " · " + sp.spread }), el("span", { class: "go", text: "›" }),
  ]));
  if (ins) {
    app.appendChild(el("h2", { text: "Your path across the arts", style: "margin-top:26px" }));
    app.appendChild(el("p", { class: "muted small", text: "Worked out from your birth details. They shape how your readings are explained, never which cards appear." }));
    ins.arts.forEach(function (a, i) {
      var det = el("details", { class: "art" }, [el("summary", {}, [el("span", { class: "serif art-name", text: a.art }), el("span", { class: "small muted", text: a.items.map(function (x) { return x.value; }).slice(0, 2).join(" · ") })])]);
      if (i === 0) det.setAttribute("open", "");
      a.items.forEach(function (x) {
        det.appendChild(el("div", { class: "art-item" }, [el("div", { class: "art-label", text: x.label }), el("div", { class: "art-value serif", text: x.value }), el("p", { class: "small", text: x.text })]));
      });
      if (a.note) det.appendChild(el("p", { class: "small muted", text: a.note }));
      det.appendChild(el("p", { class: "small muted", text: "Method: " + a.method }));
      app.appendChild(det);
    });
    app.appendChild(el("div", { class: "actions" }, [el("button", { class: "btn ghost", text: "Edit my details", on: { click: function () { showProfileForm(d.profile); } } })]));
  }
  var rb = reminderBox(); if (rb) app.appendChild(rb);
  if (d.journal.length) {
    app.appendChild(el("h2", { text: "Your journal", style: "margin-top:26px" }));
    app.appendChild(el("p", { class: "muted small", text: "Your readings from the last 7 days." }));
    var delWrap = el("div", { class: "actions" });
    d.journal.forEach(function (j) {
      var c = j.cards[0];
      app.appendChild(el("button", { class: "jitem", on: { click: function () { showReading(j); } } }, [
        el("img", { src: "/tarot/art/" + c.id + ".webp", alt: "", style: c.reversed ? "transform:rotate(180deg)" : null }),
        el("div", {}, [el("div", { text: (j.kind === "daily" ? "Daily card: " + c.name : j.question) }), el("div", { class: "small muted", text: j.day + (j.kind === "daily" ? "" : " · " + j.spread) + (j.note ? " · has your note" : "") })]),
      ]));
    });
    delWrap.appendChild(deleteHistoryBtn());
    app.appendChild(delWrap);
  }
  app.appendChild(el("h2", { text: "Your collection", style: "margin-top:26px" }));
  app.appendChild(el("p", { class: "muted small", text: d.seen.length + " of 78 cards found. Each card you draw joins your deck." }));
  var g = el("div", { class: "grid" }); var seen = {}; d.seen.forEach(function (x) { seen[x] = 1; });
  allIds().forEach(function (id) { var b = el("div", { title: seen[id] ? id : "Not found yet" }); if (seen[id]) b.appendChild(el("img", { src: "/tarot/art/" + id + ".webp", alt: "", loading: "lazy" })); g.appendChild(b); });
  app.appendChild(g);
  app.appendChild(el("div", { class: "actions", style: "justify-content:center;margin-top:26px" }, [el("button", { class: "btn ghost", on: { click: logout }, text: "Log out" })]));
  app.appendChild(footer());
}
function allIds() {
  var out = []; for (var i = 0; i < 22; i++) out.push("m" + (i < 10 ? "0" : "") + i);
  ["wands", "cups", "swords", "pentacles"].forEach(function (s) { for (var n = 1; n <= 14; n++) out.push(s + (n < 10 ? "0" : "") + n); });
  return out;
}

// The first visit (and "Edit my details"): name as at birth, date of birth, birth time and place if known, and consent.
var OFFSETS = [[330, "India (IST, UTC+5:30)"], [345, "Nepal (UTC+5:45)"], [360, "Bangladesh (UTC+6)"], [300, "Pakistan, Maldives (UTC+5)"], [240, "UAE, Oman (UTC+4)"], [180, "Saudi Arabia, Qatar, Kuwait (UTC+3)"], [480, "Singapore, Malaysia (UTC+8)"], [600, "Sydney, Melbourne, standard time (UTC+10)"], [0, "UK, standard time (UTC+0)"], [60, "UK summer time, central Europe (UTC+1)"], [-300, "US East, standard time (UTC−5)"], [-240, "US East, summer time (UTC−4)"], [-480, "US West, standard time (UTC−8)"], [-420, "US West, summer time (UTC−7)"]];
function showProfileForm(p) {
  clear(); document.body.classList.remove("dawn");
  if (p) app.appendChild(bar("Home", showHome, "Your details"));
  app.appendChild(el("h2", { text: p ? "Your details" : "Welcome" }));
  app.appendChild(el("p", { class: "muted", text: "Tell us a little about you once. We use it to read your numbers and stars, and to make each reading speak to you." }));
  var f = el("form", { class: "form", novalidate: "" });
  function field(label, input, hint) { return el("label", { class: "field" }, [el("span", { text: label }), input, hint ? el("small", { class: "muted", text: hint }) : null]); }
  var name = el("input", { name: "name", autocomplete: "name", maxlength: "80", required: "" }); name.value = p ? p.name : "";
  var dob = el("input", { name: "dob", type: "date", required: "", max: new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10), min: "1900-01-01" }); dob.value = p ? p.dob : "";
  var time = el("input", { name: "time", type: "time" }); time.value = p && p.birthTime ? p.birthTime : "";
  var tz = el("select", { name: "tz" });
  OFFSETS.forEach(function (o) { var op = el("option", { value: String(o[0]), text: o[1] }); if ((p ? p.tzMinutes : 330) === o[0]) op.selected = true; tz.appendChild(op); });
  var place = el("input", { name: "place", maxlength: "80", placeholder: "City, for example Bengaluru" }); place.value = p && p.birthPlace ? p.birthPlace : "";
  var email = el("input", { name: "email", type: "email", autocomplete: "email", maxlength: "120", placeholder: "you@example.com" }); email.value = p && p.email ? p.email : "";
  var consent = el("input", { type: "checkbox", name: "consent" }); if (p) consent.checked = true;
  f.appendChild(field("Your full name, as at birth", name, "Used for your name numbers. English letters work best."));
  f.appendChild(field("Date of birth", dob, "For adults 18 and over."));
  f.appendChild(field("Time of birth (if you know it)", time, "Leave empty if you don't know. It makes your Moon sign and birth star exact."));
  f.appendChild(field("Where you were born: time zone", tz, null));
  f.appendChild(field("Place of birth (optional)", place, null));
  f.appendChild(field("Email (optional)", email, "Only to reach you about your account. Never shared, never used for adverts."));
  f.appendChild(el("label", { class: "check" }, [consent, el("span", { text: "I am 18 or older, and I agree that Disha Dira keeps these details to personalise my readings. I can delete them at any time." })]));
  var err = el("p", { class: "err", role: "alert" });
  f.appendChild(err);
  f.appendChild(el("button", { class: "btn", type: "submit", text: p ? "Save" : "See my path" }));
  f.addEventListener("submit", function (e) {
    e.preventDefault(); err.textContent = "";
    api("profile", { name: name.value, dob: dob.value, birthTime: time.value, tzMinutes: Number(tz.value), birthPlace: place.value, email: email.value, consent: consent.checked }).then(function (r) {
      if (r.ok) { load(); return; }
      err.textContent = { name: "Please write your name.", dob: "Please choose a real date of birth.", age: "Disha Dira Tarot is for adults 18 and over.", time: "Please check the birth time.", tz: "Please choose a time zone.", email: "Please check your email address, or leave it empty.", consent: "Please tick the box to agree." }[r.error] || "Something went wrong. Please try again.";
    }).catch(function () { err.textContent = "No connection. Please try again."; });
  });
  app.appendChild(f);
  if (p) {
    app.appendChild(el("h3", { class: "section", text: "Your data" }));
    var del = twoTap("Delete my account", "Tap again to delete everything", function () {
      api("account/delete", {}).then(function () { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} S.data = null; showLogin(false); toast("Your account and readings are deleted."); });
    });
    app.appendChild(el("div", { class: "actions" }, [deleteHistoryBtn(), el("button", { class: "btn ghost", text: "Delete my details", on: { click: function () { api("profile/delete", {}).then(function () { toast("Your details are deleted."); load(); }); } } }), del]));
    app.appendChild(el("p", { class: "small muted", text: "Delete my history removes your readings and notes. Delete my details removes your birth details and email. Delete my account removes everything, including your collection." }));
  }
  app.appendChild(footer());
}

// A spread laid out as it sits on the table. cards: the reading's cards, or null for an empty preview.
function layoutEl(positions, cards, maxW, labels) {
  var cols = 1, rows = 1;
  positions.forEach(function (p) { cols = Math.max(cols, p.x + 1); rows = Math.max(rows, p.y + 1); });
  var w = Math.min(labels ? 104 : 16, Math.floor(maxW / (cols * 1.12)));
  var h = Math.round(w / 0.575), lab = labels ? 30 : 0, gx = Math.round(w * 0.12), gy = Math.round(h * 0.08);
  var box = el("div", { class: "table", style: "width:" + Math.ceil(cols * w + (cols - 1) * gx) + "px;height:" + Math.ceil(rows * (h + lab) + (rows - 1) * gy) + "px" });
  var out = [];
  positions.forEach(function (p, i) {
    var c = cards ? cards[i] : null;
    var slot = el("div", { class: "tslot" + (p.cross ? " cross" : ""), style: "left:" + Math.round(p.x * (w + gx)) + "px;top:" + Math.round(p.y * (h + lab + gy)) + "px;width:" + w + "px" });
    if (labels && !p.cross) slot.appendChild(el("span", { class: "pos", text: c ? c.position : "" }));
    var ce = cards ? cardEl(c.id, c.reversed, false) : el("div", { class: "ghost-card" });
    ce.style.setProperty("--card-w", w + "px");
    var holder = el("div", { class: "tcard", style: "height:" + h + "px;margin-top:" + (labels && p.cross ? lab : 0) + "px" }, [ce]);
    slot.appendChild(holder);
    box.appendChild(slot); out.push(ce);
  });
  box.cards = out;
  return box;
}

function showSpreads() {
  clear(); app.appendChild(bar("Home", showHome, S.data.themes[S.theme].label));
  var t = S.data.themes[S.theme];
  app.appendChild(el("h2", { text: "Choose a spread" }));
  app.appendChild(el("p", { class: "muted", text: "The shape of your reading. " + accessLine(S.theme) }));
  t.spreads.forEach(function (s) {
    app.appendChild(el("button", { class: "tile spread", on: { click: function () { S.spread = s.id; S.count = s.count; showQuestions(); } } }, [
      el("div", { class: "row" }, [el("div", { class: "mini" }, [layoutEl(s.layout, null, 90, false)]), el("div", {}, [el("h3", { text: s.label }), el("p", { class: "muted small", text: s.blurb + " · " + s.count + (s.count === 1 ? " card" : " cards") })])]),
      el("span", { class: "go", text: "›" }),
    ]));
  });
}
function showQuestions() {
  clear(); app.appendChild(bar("Spreads", showSpreads, "Your question"));
  var t = S.data.themes[S.theme];
  app.appendChild(el("h2", { text: "Your question" }));
  app.appendChild(el("p", { class: "muted", text: "Ask in your own words, or pick one of ours." }));
  var own = el("textarea", { "aria-label": "Your question", maxlength: "300", placeholder: "For example: How can I feel closer to my sister?" });
  var err = el("p", { class: "err", role: "alert" });
  app.appendChild(own);
  app.appendChild(el("p", { class: "small muted", text: "Tarot here is for reflection. Ask what you can understand or do, not what will happen to you." }));
  app.appendChild(err);
  app.appendChild(el("div", { class: "actions" }, [el("button", { class: "btn", text: "Ask this", on: { click: function () {
    var q = own.value.replace(/\s+/g, " ").trim();
    if (q.length < 3) { err.textContent = "Please write your question."; return; }
    api("check", { own: q }).then(function (r) {
      if (r.ok) { S.own = q; S.qi = null; S.kind = "spread"; ritual(); return; }
      if (r.error === "crisis") return showCrisis();
      err.textContent = { predict: "Tarot here cannot tell you about health, pregnancy, death, exams or court results. Try asking what would help you, or how to find peace with it.", spell: "We do not read for black magic, curses or the evil eye. You could ask what would help you feel safe and strong.", bad: "Please ask your question kindly.", length: "Please keep your question under 300 letters." }[r.error] || "Something went wrong. Please try again.";
    }).catch(function () { err.textContent = "No connection. Please try again."; });
  } } })]));
  app.appendChild(el("h3", { text: "Or choose one", style: "margin-top:18px" }));
  var l = el("div", { class: "list" });
  t.questions.forEach(function (q, i) { l.appendChild(el("button", { on: { click: function () { S.qi = i; S.own = null; S.kind = "spread"; ritual(); } }, text: q })); });
  app.appendChild(l);
}
function showCrisis() {
  clear();
  app.appendChild(el("div", { class: "stage" }, [
    el("h2", { text: "You don't have to carry this alone" }),
    el("p", { text: "It sounds like you are going through something very hard. Please talk to someone now." }),
    el("p", { class: "serif", style: "font-size:1.3rem", text: "Tele-MANAS: 14416 (free, any time, India)" }),
    el("p", { text: "In an emergency, call 112." }),
    el("a", { class: "btn", href: "tel:14416", text: "Call 14416" }),
    el("button", { class: "btn ghost", text: "Back home", on: { click: showHome } }),
  ]));
}
function beginDaily() { S.kind = "daily"; S.theme = null; S.spread = "daily"; S.qi = null; S.own = null; S.count = 1; ritual(); }
function questionText() { return S.own || (S.qi !== null ? S.data.themes[S.theme].questions[S.qi] : ""); }

// The ritual: breathe, shuffle, cut, choose, turn over.
function ritual() {
  clear(); S.picks = []; S.stage = null;
  var s = el("div", { class: "stage" });
  var b = el("div", { class: "breath", "aria-hidden": "true" });
  var t = el("p", { class: "serif", style: "font-size:1.4rem", text: "Breathe in slowly…" });
  var q = S.kind === "spread" ? el("p", { class: "muted", text: questionText() }) : el("p", { class: "muted", text: "Hold your day in mind." });
  var skip = el("button", { class: "btn ghost", text: "I'm ready", on: { click: shuffleStep } });
  s.appendChild(b); s.appendChild(t); s.appendChild(q); s.appendChild(skip); app.appendChild(s);
  var done = false; skip.addEventListener("click", function () { done = true; });
  wait(3000).then(function () { if (!done) t.textContent = "…and out."; return wait(3000); }).then(function () { if (!done) shuffleStep(); });
}
function shuffleStep() {
  if (S.stage === "shuffle") return; S.stage = "shuffle";
  clear();
  var s = el("div", { class: "stage" });
  var deck = el("button", { class: "deck", "aria-label": "Shuffle the deck" });
  for (var i = 0; i < 6; i++) deck.appendChild(cardEl(null, false, false));
  var t = el("p", { class: "serif", style: "font-size:1.4rem", text: "Tap the deck to shuffle" });
  var n = 0;
  var next = el("button", { class: "btn", text: "Cut the deck", style: "visibility:hidden", on: { click: cutStep } });
  deck.addEventListener("click", function () {
    deck.classList.remove("riffle"); void deck.offsetWidth; deck.classList.add("riffle"); n++;
    t.textContent = n === 1 ? "Shuffle as long as it feels right" : "Shuffled " + n + " times";
    next.style.visibility = "visible";
  });
  s.appendChild(deck); s.appendChild(t); s.appendChild(next); app.appendChild(s);
}
function cutStep() {
  S.stage = "cut"; clear();
  var s = el("div", { class: "stage" });
  s.appendChild(el("p", { class: "serif", style: "font-size:1.4rem", text: "Cut the deck: choose a pile" }));
  var piles = el("div", { class: "piles" });
  [0, 1, 2].forEach(function (p) {
    var btn = el("button", { "aria-label": "Pile " + (p + 1) }, [cardEl(null, false, false)]);
    btn.addEventListener("click", function () { start(p); });
    piles.appendChild(btn);
  });
  s.appendChild(piles); s.appendChild(el("p", { class: "muted small", text: "The pile you choose goes on top." })); app.appendChild(s);
}
function start(pile) {
  var body = { kind: S.kind, pile: pile };
  if (S.kind === "spread") { body.theme = S.theme; body.spread = S.spread; if (S.own) body.own = S.own; else body.question = S.qi; }
  api("start", body).then(function (r) {
    if (r._status === 401) return load();
    if (r.error === "crisis") return showCrisis();
    if (r._status === 402) return load(true).then(function () { showPasses(S.theme); });
    if (r._status === 409) { toast(r.error === "profile" ? "Please add your details first." : "Today's reading is already done."); return load(); }
    if (!r.ok) { toast("Something went wrong. Please try again."); return; }
    fanStep();
  }).catch(function () { toast("No connection. Please try again."); });
}
function fanStep() {
  S.stage = "fan"; clear();
  var s = el("div", { class: "stage" });
  var t = el("p", { class: "serif", style: "font-size:1.4rem", text: S.count === 1 ? "Choose the card that pulls at you" : "Choose " + S.count + " cards that pull at you" });
  var c = el("p", { class: "muted small", text: "0 of " + S.count + " chosen" });
  var fan = el("div", { class: "fan" });
  var N = 22;
  for (var i = 0; i < N; i++) (function (i) {
    var ang = -34 + (68 * i) / (N - 1);
    var b = el("button", { "aria-label": "Card " + (i + 1) + " of " + N, style: "transform:translateX(-50%) rotate(" + ang + "deg)" }, [cardEl(null, false, false)]);
    b.addEventListener("click", function () {
      var at = S.picks.indexOf(i);
      if (at >= 0) { S.picks.splice(at, 1); b.classList.remove("chosen"); }
      else if (S.picks.length < S.count) { S.picks.push(i); b.classList.add("chosen"); }
      c.textContent = S.picks.length + " of " + S.count + " chosen";
      go.style.visibility = S.picks.length === S.count ? "visible" : "hidden";
    });
    fan.appendChild(b);
  })(i);
  var go = el("button", { class: "btn", style: "visibility:hidden", text: "Turn them over", on: { click: pick } });
  s.appendChild(t); s.appendChild(fan); s.appendChild(c); s.appendChild(go); app.appendChild(s);
}
function pick() {
  api("pick", { kind: S.kind, picks: S.picks }).then(function (r) {
    if (r._status === 402) return load(true).then(function () { showPasses(S.theme); });
    if (!r.ok) { toast("Something went wrong. Please try again."); return load(); }
    reveal(r.reading);
  }).catch(function () { toast("No connection. Please try again."); });
}
function reveal(reading) {
  S.stage = null; clear();
  var s = el("div", { class: "stage" });
  var table = layoutEl(reading.cards, reading.cards, Math.min((app.clientWidth || 392) - 32, 528), true);
  var t = el("p", { class: "serif", style: "font-size:1.4rem", text: "Turning over…" });
  s.appendChild(table); s.appendChild(t); app.appendChild(s);
  var skipped = false; s.addEventListener("click", function () { skipped = true; });
  var p = wait(500), gap = reading.cards.length > 5 ? 900 : 1500;
  table.cards.forEach(function (ce, i) {
    p = p.then(function () { ce.classList.add("flipped"); if (i === 0) document.body.classList.add("dawn"); t.textContent = reading.cards[i].name + (reading.cards[i].reversed ? ", upside down" : ""); return skipped ? null : wait(gap); });
  });
  p.then(function () { return skipped ? null : wait(700); }).then(function () { load(true).then(function () { showReading(reading); }); });
}

// "What this means for you": the reading in plain words, and a Listen button (a warm recorded voice when the server has one, else the phone's).
// Ticket 61: the recorded voice is fetched as soon as the words arrive, so Listen plays at once; it stops when the person leaves the reading
// or the screen goes off, and a voice that arrives late never starts by itself.
var VOICE = { audio: null, url: null, id: null, speaking: false, ready: {}, label: null };
function stopVoice() {
  if (VOICE.audio) { VOICE.audio.pause(); VOICE.audio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  VOICE.speaking = false;
  if (VOICE.label) { VOICE.label(" Listen"); VOICE.label = null; }
}
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") stopVoice(); });
window.addEventListener("pagehide", stopVoice);
function voiceBlob(id) {
  if (!VOICE.ready[id]) VOICE.ready[id] = fetch("/tarot/api/voice/" + id, { credentials: "same-origin" }).then(function (res) {
    if (!res.ok) throw new Error("voice");
    return res.blob();
  });
  VOICE.ready[id].catch(function () { delete VOICE.ready[id]; });
  return VOICE.ready[id];
}
function storyBox(r) {
  var box = el("div", { class: "summary story" }, [el("h3", { text: "What this means for you" })]);
  var body = el("div", { class: "story-text" }, [el("p", { class: "muted shimmer", text: "Reading your cards for you…" })]);
  var btn = el("button", { class: "btn listen", type: "button", disabled: "", "aria-label": "Listen to this reading" }, [el("span", { "aria-hidden": "true", text: "▶" }), el("span", { class: "lbl", text: " Listen" })]);
  box.appendChild(btn); box.appendChild(body);
  var text = "";
  function label(t) { btn.querySelector(".lbl").textContent = t; btn.firstChild.textContent = t === " Pause" ? "❚❚" : "▶"; }
  api("story/" + r.id).then(function (s) {
    if (!s.text) { body.innerHTML = ""; body.appendChild(el("p", { class: "muted", text: "Please read the cards below." })); return; }
    text = s.text; body.innerHTML = "";
    s.text.split(/\n\n+/).forEach(function (para) { body.appendChild(el("p", { text: para })); });
    btn.removeAttribute("disabled");
    VOICE.server = !!s.voice;
    if (VOICE.server) voiceBlob(r.id).catch(function () {});
  }).catch(function () { body.innerHTML = ""; body.appendChild(el("p", { class: "muted", text: "No connection. Please read the cards below." })); });
  btn.addEventListener("click", function () {
    if (VOICE.speaking && VOICE.id === r.id) { stopVoice(); return; }
    stopVoice(); VOICE.id = r.id; VOICE.speaking = true; VOICE.label = label; label(" Pause");
    var done = function () { VOICE.speaking = false; VOICE.label = null; label(" Listen"); };
    if (VOICE.server) {
      label(" Preparing…");
      voiceBlob(r.id).then(function (b) {
        if (!VOICE.speaking || VOICE.id !== r.id || document.visibilityState !== "visible" || !document.body.contains(btn)) return;
        if (VOICE.url) URL.revokeObjectURL(VOICE.url);
        VOICE.url = URL.createObjectURL(b); VOICE.audio = new Audio(VOICE.url);
        VOICE.audio.onended = done; label(" Pause");
        return VOICE.audio.play();
      }).catch(function () { if (VOICE.speaking && VOICE.id === r.id) phoneVoice(text, done, label); });
    } else phoneVoice(text, done, label);
  });
  return box;
}
// The phone's own voice: a female English voice if the phone has one (Indian English first), slow and soft.
function phoneVoice(text, done, label) {
  if (!window.speechSynthesis) { toast("This phone cannot read aloud."); done(); return; }
  var vs = window.speechSynthesis.getVoices();
  var female = /female|woman|samantha|veena|lekha|heera|kalpana|zira|susan|karen|moira|tessa|fiona|victoria|serena|neerja|swara/i;
  var pick = vs.filter(function (v) { return /^en[-_]IN/i.test(v.lang) && female.test(v.name); })[0] || vs.filter(function (v) { return /^en/i.test(v.lang) && female.test(v.name); })[0] || vs.filter(function (v) { return /^en[-_]IN/i.test(v.lang); })[0] || null;
  var u = new SpeechSynthesisUtterance(text.replace(/\n\n+/g, " … "));
  if (pick) u.voice = pick;
  u.lang = pick ? pick.lang : "en-IN"; u.rate = 0.9; u.pitch = 1.08;
  u.onend = done; u.onerror = done;
  label(" Pause");
  window.speechSynthesis.speak(u);
}

function showReading(r) {
  clear(); document.body.classList.add("dawn");
  app.appendChild(bar("Home", showHome, r.kind === "daily" ? "Today's card" : S.data.themes[r.theme].label));
  app.appendChild(el("h2", { text: r.kind === "daily" ? "Today's card" : r.question }));
  if (r.kind !== "daily") {
    app.appendChild(el("p", { class: "muted", text: r.spread + " · " + S.data.themes[r.theme].label }));
    if (r.cards.length > 1) { var tb = layoutEl(r.cards, r.cards, Math.min((app.clientWidth || 392) - 32, 528), true); tb.cards.forEach(function (c) { c.classList.add("flipped"); }); app.appendChild(el("div", { class: "stage-table" }, [tb])); }
  }
  app.appendChild(storyBox(r));
  if (r.personal && r.personal.length) {
    var pb = el("div", { class: "summary for-you" }, [el("h3", { text: "For you" })]);
    r.personal.forEach(function (l) { pb.appendChild(el("p", { text: l })); });
    app.appendChild(pb);
  }
  app.appendChild(el("h3", { text: r.cards.length > 1 ? "Your cards, one by one" : "Your card", style: "margin-top:22px" }));
  var box = el("div", { class: "reading" });
  r.cards.forEach(function (c) {
    var kw = el("div", { class: "kw" }); c.keywords.forEach(function (k) { kw.appendChild(el("span", { text: k })); });
    box.appendChild(el("div", { class: "rcard" }, [
      cardEl(c.id, c.reversed, true),
      el("div", {}, [
        el("div", { class: "pos", text: c.position + " · " + c.frame }),
        el("h3", { text: c.name + (c.reversed ? " (upside down)" : "") }),
        c.reversed ? el("p", { class: "small muted", text: "Upside down means the card's energy is blocked or turned inward." }) : null,
        kw,
        el("p", { text: c.meaning }),
        c.theme ? el("p", { class: "theme", text: "For you: " + c.theme }) : null,
        el("p", { class: "ask", text: c.ask }),
      ]),
    ]));
  });
  app.appendChild(box);
  var sum = el("div", { class: "summary" }, [el("h3", { text: "In short" })]);
  r.summary.forEach(function (l) { sum.appendChild(el("p", { text: l })); });
  app.appendChild(sum);
  var ta = el("textarea", { "aria-label": "Your note", placeholder: "What does this bring up for you? Your note is private." });
  ta.value = r.note || "";
  app.appendChild(ta);
  app.appendChild(el("div", { class: "actions" }, [
    el("button", { class: "btn ghost", text: "Save my note", on: { click: function () { api("note", { id: r.id, note: ta.value }).then(function (x) { toast(x.ok ? "Saved to your journal." : "Could not save."); if (x.ok) { r.note = ta.value; load(true); } }); } } }),
    el("button", { class: "btn ghost", text: "Share this card", on: { click: function () { share(r.cards[0]); } } }),
  ]));
  app.appendChild(el("div", { class: "summary" }, [
    el("h3", { text: "Want to talk it through?" }),
    el("p", { class: "muted", text: "Shantha Rao can talk with you on a ₹99 call." }),
    el("div", { class: "actions" }, [el("a", { class: "btn", href: waLink("Book a call"), rel: "noopener", text: "Book a ₹99 call" })]),
  ]));
  app.appendChild(footer());
}

// A story-sized image of one card: the card, its name, one line and how to draw your own. Never the person's name or question.
function share(c) {
  var cv = document.createElement("canvas"); cv.width = 1080; cv.height = 1920; var x = cv.getContext("2d");
  var g = x.createLinearGradient(0, 0, 0, 1920); g.addColorStop(0, "#2b1f55"); g.addColorStop(0.65, "#5a2c52"); g.addColorStop(1, "#a65d4f");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
  var img = new Image(); img.src = "/tarot/art/" + c.id + ".webp";
  img.onload = function () {
    var w = 600, h = Math.round(w / 0.575), left = 240, topY = 300;
    x.save(); x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 40;
    if (c.reversed) { x.translate(left + w / 2, topY + h / 2); x.rotate(Math.PI); x.drawImage(img, -w / 2, -h / 2, w, h); }
    else x.drawImage(img, left, topY, w, h);
    x.restore(); x.strokeStyle = "#d9b56c"; x.lineWidth = 4; x.strokeRect(left, topY, w, h);
    x.fillStyle = "#f5eee1"; x.textAlign = "center"; x.font = "600 76px 'Cormorant Garamond', serif";
    x.fillText(c.name + (c.reversed ? " (upside down)" : ""), 540, topY + h + 120);
    x.fillStyle = "#f0d79b"; x.font = "400 40px Jost, sans-serif"; x.fillText(c.keywords.join(" · "), 540, topY + h + 190);
    x.fillStyle = "#f5eee1"; x.font = "400 36px Jost, sans-serif"; x.fillText("Draw your own: send TAROT on WhatsApp", 540, 1780);
    x.fillStyle = "#d9b56c"; x.font = "600 44px 'Cormorant Garamond', serif"; x.fillText("Disha Dira Tarot", 540, 200);
    cv.toBlob(function (blob) {
      var file = new File([blob], "disha-dira-tarot.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: "My card today" }).catch(function () {});
      else { var a = el("a", { href: URL.createObjectURL(blob), download: "disha-dira-tarot.png" }); document.body.appendChild(a); a.click(); a.remove(); }
    }, "image/png");
  };
}

function logout() { api("logout", {}).then(function () { S.data = null; showLogin(false); }); }

function load(quiet) {
  return api("state").then(function (d) {
    if (!d.in) { showLogin(/link=old/.test(location.search)); return; }
    S.data = d; if (quiet) return;
    if (!d.profile) showProfileForm(null); else showHome();
  }).catch(function () { clear(); app.appendChild(el("div", { class: "stage" }, [el("p", { text: "No connection. Please check your internet and reload." })])); });
}

if (location.search) history.replaceState(null, "", "/tarot" + (/link=old/.test(location.search) ? "?link=old" : ""));
stars(); load();
})();`;
