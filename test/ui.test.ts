import { describe, expect, it } from "vitest";
import app from "../src/index";
import { CONSOLE_COPY, consoleCopy } from "../src/console-copy";
import { FONT_FACES } from "../src/fonts";
import {
  APP_CSS, CONSOLE_CSP, CONSOLE_ROLES, CONTRAST_PAIRS, TOKENS, appointmentRow, bookingChip, bubble, confirmStep, consoleFrame, listDetail,
  paymentChip, rolesFor, screenHead, tabsFor, type ConsoleRole,
} from "../src/ui";

// Ticket 20: the console's design system, fonts and strings. All data is synthetic.
const str = (h: unknown) => String(h);
const frame = (role: ConsoleRole, locale = "en", extra: Partial<Parameters<typeof consoleFrame>[0]> = {}) =>
  str(consoleFrame({ role, locale, active: "today", title: "Today", business: "Sample Practice", body: "", language: { csrf: "tok123" }, ...extra }));
const hrefs = (page: string) => [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const between = (page: string, open: string, close: string) => page.slice(page.indexOf(open), page.indexOf(close, page.indexOf(open)));

describe("string catalogue", () => {
  const DEVANAGARI = /[ऀ-ॿ]/;
  const sample = (f: (...a: never[]) => string) => (f as (...a: unknown[]) => string)("X", "Y", "Z");
  const keys = Object.keys(CONSOLE_COPY.en) as (keyof typeof CONSOLE_COPY.en)[];

  it("has every key in both languages, of the same kind, and nothing extra", () => {
    expect(Object.keys(CONSOLE_COPY.hi).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const en = CONSOLE_COPY.en[k];
      const hi = CONSOLE_COPY.hi[k];
      expect(typeof hi, k).toBe(typeof en);
      const enText = typeof en === "function" ? sample(en) : en;
      const hiText = typeof hi === "function" ? sample(hi) : hi;
      expect(enText.trim(), k).not.toBe("");
      expect(hiText.trim(), k).not.toBe("");
      if (k === "otherLanguage") continue; // the switch names the other language in its own script
      expect(DEVANAGARI.test(hiText), `${k} is Hindi`).toBe(true);
      expect(DEVANAGARI.test(enText), `${k} is English`).toBe(false);
    }
  });

  it("puts the passed-in values into the sentence", () => {
    for (const lang of ["en", "hi"] as const) {
      const c = CONSOLE_COPY[lang];
      expect(c.savedUndoUntil("4:15 pm")).toContain("4:15 pm");
      expect(c.outcomeNotFit("₹99")).toContain("₹99");
      expect(c.alreadyMarked("Not a fit", "Asha", "4:05 pm")).toMatch(/Not a fit.*Asha.*4:05 pm/);
      expect(c.tomorrowCalls(3)).toContain("3");
    }
    expect(consoleCopy("en").tomorrowCalls(1)).toBe("Tomorrow: 1 call");
  });

  it("chooses Hindi only for locale hi", () => {
    expect(consoleCopy("hi").tabToday).toBe("आज");
    for (const l of ["en", null, undefined, "xx"]) expect(consoleCopy(l).tabToday).toBe("Today");
  });

  it("shows no internal codes", () => {
    const all = JSON.stringify(CONSOLE_COPY) + keys.map((k) => { const v = CONSOLE_COPY.en[k]; return typeof v === "function" ? sample(v) : v; }).join(" ");
    for (const code of ["HUMAN", "SENDS", "AMMA_NO_TAP", "HEALING", "PROTECTION", "REFUND_PENDING", "NEW_BOOKINGS"]) expect(all).not.toContain(code);
  });
});

describe("colour tokens", () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  it("every text colour is at least 4.5:1 on every background it is used on, light and dark", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [fg, bg] of CONTRAST_PAIRS) {
        const r = ratio(TOKENS[theme][fg], TOKENS[theme][bg]);
        expect(r, `${theme}: ${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(TOKENS[theme].ink, TOKENS[theme].paper)).toBeGreaterThanOrEqual(12); // the PRD: ink at least 12:1 on paper
    }
  });

  it("keeps the PRD's token values", () => {
    expect(TOKENS.light).toMatchObject({ paper: "#FBFAF7", surface: "#FFFFFF", ink: "#14302F", muted: "#5B6B69", accent: "#1B6F73", attention: "#A15C00", danger: "#B3261E", done: "#2E7D4F" });
    expect(TOKENS.dark).toMatchObject({ paper: "#121615", surface: "#1A201F", ink: "#E8EEEC", muted: "#9FB0AD", accent: "#5CC2BE", attention: "#F0B35A", danger: "#FF8A80", done: "#7FD3A0" });
  });

  it("the stylesheet uses every token in both themes", () => {
    for (const theme of ["light", "dark"] as const) for (const [k, v] of Object.entries(TOKENS[theme])) expect(APP_CSS).toContain(`--${k}:${v}`);
    expect(APP_CSS).toContain("@media (prefers-color-scheme:dark)");
  });
});

describe("type and spacing", () => {
  it("19 px body in Jost, nothing under 16 px, 48 px tap targets, tabular figures", () => {
    expect(APP_CSS).toMatch(/body\{[^}]*font:400 19px\/1\.45 Jost,"Noto Sans Devanagari",system-ui,sans-serif/);
    const sizes = [...APP_CSS.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
    expect(APP_CSS).not.toMatch(/font-size:[\d.]+(em|rem|%)/);
    expect(APP_CSS).toMatch(/\.btn\{[^}]*min-height:48px[^}]*min-width:48px/);
    expect(APP_CSS).toMatch(/\.screen h1\{[^}]*font-size:26px/);
    expect(APP_CSS).toMatch(/\.num\{font-size:20px;font-weight:600\}/);
    expect(APP_CSS).toContain("tabular-nums");
    expect(APP_CSS).not.toMatch(/Inter|Arial|Helvetica/);
  });

  it("declares the self-hosted faces under /app/fonts/", () => {
    expect(FONT_FACES).toContain('font-family:"Jost"');
    expect(FONT_FACES).toContain('font-family:"Noto Sans Devanagari"');
    expect(FONT_FACES).not.toMatch(/url\((?!\/app\/fonts\/)/);
  });
});

describe("the page frame", () => {
  const tabHrefs = { today: "/app", inbox: "/app/inbox", calendar: "/app/calendar", people: "/app/people", payments: "/app/payments", settings: "/app/settings" };

  it("shows each role exactly its tabs: owner six, staff four, practitioner three", () => {
    expect(tabsFor("OWNER")).toEqual(["today", "inbox", "calendar", "people", "payments", "settings"]);
    expect(tabsFor("STAFF")).toEqual(["today", "inbox", "calendar", "people"]);
    expect(tabsFor("PRACTITIONER")).toEqual(["today", "calendar", "people"]);
    for (const role of CONSOLE_ROLES) {
      const page = frame(role);
      const links = new Set(hrefs(page).filter((h) => h.startsWith("/app")));
      const want = tabsFor(role).map((t) => tabHrefs[t]);
      expect([...links].sort(), role).toEqual([...want].sort());
      // The laptop rail lists every tab; the phone bar holds the first four and puts the rest under More.
      const rail = between(page, '<nav class="rail"', "</nav>");
      for (const h of want) expect(rail, `${role} rail ${h}`).toContain(`href="${h}"`);
      const bar = between(page, '<nav class="tabbar"', "</nav>");
      for (const h of want) expect(bar, `${role} bar ${h}`).toContain(`href="${h}"`);
      expect(bar.includes('class="more"'), `${role} More`).toBe(role === "OWNER");
    }
  });

  it("hides money and settings from staff and practitioners, and the inbox from practitioners", () => {
    for (const role of ["STAFF", "PRACTITIONER"] as const) {
      const page = frame(role);
      expect(page).not.toContain("/app/payments");
      expect(page).not.toContain("/app/settings");
      expect(page).not.toContain(">Payments<");
    }
    expect(frame("PRACTITIONER")).not.toContain("/app/inbox");
  });

  it("marks the current tab, in the rail and in the bar", () => {
    const page = frame("OWNER", "en", { active: "people" });
    expect(page.match(/href="\/app\/people"[^>]*aria-current="page"/g)?.length).toBe(2);
    expect(page).not.toMatch(/href="\/app"[^>]*aria-current/);
    // A tab under More: the More button is lit on the phone.
    expect(frame("OWNER", "en", { active: "payments" })).toMatch(/<summary class="on">/);
  });

  it("renders in Hindi for a Hindi member, with a switch back to English", () => {
    const page = frame("PRACTITIONER", "hi");
    expect(page).toContain('<html lang="hi">');
    for (const w of ["आज", "कैलेंडर", "लोग", "प्रैक्टिशनर"]) expect(page).toContain(w);
    expect(page).toContain('name="locale" value="en"');
    expect(page).toContain(">English</button>");
  });

  it("has a language switch that is a POST with the form's CSRF token", () => {
    const page = frame("STAFF");
    expect(page).toMatch(/<form method="post" action="\/app\/language" class="lang"><input type="hidden" name="csrf" value="tok123"><input type="hidden" name="locale" value="hi"><input type="hidden" name="back" value="\/app">/);
    expect(frame("STAFF", "en", { language: undefined })).not.toContain('class="lang"');
  });

  it("has no scripts, escapes what it is given, and inlines its own CSS and font faces", () => {
    const page = frame("OWNER", "en", { business: "<b>Sample & Co</b>", member: '"Asha"', flash: "<i>saved</i>" });
    expect(page).not.toMatch(/<script|javascript:|\son\w+=/i);
    expect(page).toContain("&lt;b&gt;Sample &amp; Co&lt;/b&gt;");
    expect(page).toContain("&lt;i&gt;saved&lt;/i&gt;");
    expect(page).not.toContain("<b>Sample");
    expect(page).toContain("@font-face");
    expect(page).toContain('<meta name="robots" content="noindex">');
  });

  it("shows a badge count with words for screen readers", () => {
    const page = frame("STAFF", "en", { badges: { inbox: 3 } });
    expect(page).toContain('<span class="badge"><span class="vh">3 waiting: </span>3</span>');
  });

  it("titles each screen with its question and who can see it", () => {
    expect(rolesFor("payments")).toEqual(["OWNER"]);
    expect(rolesFor("inbox")).toEqual(["OWNER", "STAFF"]);
    expect(str(screenHead("inbox"))).toContain("<h1>Who is waiting for a reply?</h1><p class=\"visible\">Visible to: Owner, Staff</p>");
    expect(str(screenHead("today", "hi"))).toContain("अभी मुझे क्या करना है?");
  });

  it("list and detail: the list alone until an item is open, then the item with a way back", () => {
    const closed = str(listDetail({ list: "LIST", backHref: "/app/inbox" }));
    expect(closed).toMatch(/^<div class="ld">/);
    expect(closed).toContain("Pick one from the list");
    const open = str(listDetail({ list: "LIST", detail: "ITEM", backHref: "/app/inbox" }));
    expect(open).toMatch(/^<div class="ld open">/);
    expect(open).toContain('<a class="ld-back" href="/app/inbox">← Back to the list</a>ITEM');
  });

  it("the console CSP is today's plus self-hosted fonts, and no scripts", () => {
    expect(CONSOLE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'");
  });
});

describe("components", () => {
  it("status chips are words from a fixed list, never a code", () => {
    expect(str(bookingChip("CREDIT_BOOKED"))).toBe('<span class="chip done">Confirmed</span>');
    expect(str(bookingChip("NO_SHOW", "hi"))).toBe('<span class="chip attention">छूट गया</span>');
    expect(str(paymentChip("REFUND_PENDING"))).toBe('<span class="chip attention">Refund on its way</span>');
    expect(str(paymentChip("UNKNOWN"))).toContain("Check with Razorpay");
    expect(str(bookingChip("SOMETHING_NEW"))).toBe("");
  });

  it("an appointment row shows only the last 4 digits", () => {
    const row = str(appointmentRow({ time: "2:00 pm", name: "Priya", waId: "919800004821", service: "Healing", details: ["For family"] }));
    expect(row).toContain("…4821");
    expect(row).not.toContain("98000");
    expect(row.replace(/<[^>]+>/g, "")).toContain("Healing · For family"); // each part in its own span (ticket 27: short parts never break)
  });

  it("staff never see a safety message's text", () => {
    const hidden = str(bubble({ from: "safety", text: "synthetic crisis text", time: "4:03 pm", hideSafety: true }));
    expect(hidden).not.toContain("synthetic crisis text");
    expect(hidden).toContain("A safety message. An owner is needed.");
    expect(str(bubble({ from: "assistant", text: "Answer", time: "4:02 pm", kind: "Price question" }))).toMatch(/Assistant · <time>4:02 pm<\/time>.*Price question/);
  });

  it("the confirm step opens in place, names the effect and confirms with a red POST button", () => {
    const c = str(confirmStep({ label: "Refund", effect: "Refund ₹99 now.", confirm: "Refund ₹99", post: { action: "/app/refund", csrf: "tok", fields: { id: "7" } } }));
    expect(c).toMatch(/^<details class="confirm"><summary>Refund<\/summary><div class="panel"><p class="effect">Refund ₹99 now.<\/p><form method="post" action="\/app\/refund"><input type="hidden" name="csrf" value="tok"><input type="hidden" name="id" value="7"><button class="btn danger" type="submit">Refund ₹99<\/button>/);
  });
});

describe("fonts route", () => {
  const files = [...FONT_FACES.matchAll(/\/app\/fonts\/([\w.-]+\.woff2)/g)].map((m) => m[1]);
  const get = (path: string, on = "true") => app.fetch(new Request(`https://bot.example.test${path}`), { CONSOLE_V2: on } as never);

  it("serves every declared font as woff2 with a year-long immutable cache", async () => {
    expect(files.length).toBe(7);
    for (const f of files) {
      const r = await get(`/app/fonts/${f}`);
      expect(r.status, f).toBe(200);
      expect(r.headers.get("content-type")).toBe("font/woff2");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 4)), f).toBe("wOF2");
      expect(bytes.length).toBeGreaterThan(5000);
      expect(bytes.length).toBeLessThan(60000);
    }
  });

  it("serves nothing else, and nothing while CONSOLE_V2 is off", async () => {
    expect((await get("/app/fonts/other.woff2")).status).toBe(404);
    expect((await get("/app/fonts/..%2Fwrangler.toml")).status).toBe(404);
    expect((await get(`/app/fonts/${files[0]}`, "false")).status).toBe(404);
  });
});
