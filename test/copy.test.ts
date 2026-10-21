/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import copyDoc from "../docs/COPY.md?raw";
import { config } from "../src/config";
import { allCopy, copyFor, dateWords, hoursText, langOf, serviceName, timeLabel, type Copy, type Lang } from "../src/copy";
import { formatIstLang, dayLabelFor, generateSlots } from "../src/slots";
import { copyKeys, renderCopyDoc } from "./copydoc";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const LANGS: Lang[] = ["en", "hi"];

// Every string a language can produce, with its path: plain strings, and functions called with long sample values.
function strings(c: Copy, lang: Lang): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") out.push([path, v]);
    else if (typeof v === "function") {
      const n = v.length;
      const args = ["बुध, 21 अक्टूबर", "शाम 5:30", lang, "+91 00000 00000"];
      // confirmed(day, time, callLang, number) is the only function whose third argument is not text.
      const a = path === "confirmed" ? args : path === "rescheduled" ? [args[0], args[1], args[3]] : n === 1 && path === "amma.saved" ? [10] : args.slice(0, n);
      out.push([path, (v as (...x: unknown[]) => string)(...a)]);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(c, "");
  return out;
}
const keyPaths = (c: Copy) => {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    else out.push(path);
  };
  walk(c, "");
  return out.sort();
};

describe("copy: both languages", () => {
  it("has exactly the same keys in English and Hindi, and no placeholders", () => {
    expect(keyPaths(allCopy.hi)).toEqual(keyPaths(allCopy.en));
    for (const lang of LANGS) {
      for (const [path, text] of strings(allCopy[lang], lang)) {
        expect(text, `${lang} ${path}`).not.toContain("KN_TODO");
        expect(text.trim(), `${lang} ${path}`).not.toBe("");
      }
    }
  });

  it("Kannada is gone from the code", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/KN_TODO|Kannada|[\u0C80-\u0CFF]/);
      expect(text.replace(/lang_kn/g, ""), file).not.toMatch(/"kn"|\bkn:|\bkn\b/);
    }
    expect(config.languages).toEqual(["en", "hi"]);
  });

  it("every key is described in docs/COPY.md, and the file is up to date", async () => {
    const documented = new Set(copyKeys());
    for (const path of keyPaths(allCopy.en).filter((p) => !p.startsWith("amma."))) expect(documented.has(path), `${path} missing from test/copydoc.ts`).toBe(true);
    const fresh = renderCopyDoc();
    if ((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.UPDATE_COPY_DOC) {
      const mod = "node:fs";
      const fs = (await import(/* @vite-ignore */ mod)) as { writeFileSync(path: string, data: string): void };
      fs.writeFileSync("docs/COPY.md", fresh);
    } else {
      expect(copyDoc, "docs/COPY.md is out of date: run UPDATE_COPY_DOC=1 npx vitest run test/copy.test.ts").toBe(fresh);
    }
  });

  it("Amma's page copy stays English; unknown locales read as English", () => {
    expect(allCopy.hi.amma).toBe(allCopy.en.amma);
    expect(langOf("hi")).toBe("hi");
    for (const odd of ["en", "kn", "", null, undefined, "fr"]) expect(langOf(odd)).toBe("en");
    expect(copyFor("kn")).toBe(allCopy.en);
  });

  it("prices, minutes and the hold time come from config", () => {
    for (const lang of LANGS) {
      const c = allCopy[lang];
      expect(c.btnBook).toContain(`₹${config.prices.introPaise / 100}`);
      expect(c.payLabel).toContain(`₹${config.prices.introPaise / 100}`);
      expect(c.sessionPayLabel).toContain(`₹${config.prices.sessionPaise / 100}`);
      expect(c.payBody("d", "t")).toContain(`${config.holdMinutes}`);
      expect(c.payBody("d", "t")).toContain(`₹${config.prices.introPaise / 100}`);
      expect(c.sessionPayBody("d", "t")).toContain(`₹${config.prices.sessionPaise / 100}`);
      expect(c.rowCall).toContain(`${config.slots.callMinutes}`);
      expect(c.rowSession).toContain(`${config.slots.sessionMinutes}`);
      expect(c.faqAnswers.price).toContain(`₹${config.prices.sessionPaise / 100}`);
    }
  });

  it("the customer-facing service names come from config (Energy cleansing / एनर्जी क्लींजिंग for PROTECTION)", () => {
    expect(allCopy.en.btnCleansing).toBe(config.serviceNames.PROTECTION.en);
    expect(allCopy.hi.btnCleansing).toBe(config.serviceNames.PROTECTION.hi);
    expect(allCopy.en.btnCleansing).toBe("Energy cleansing");
    expect(allCopy.hi.btnCleansing).toBe("एनर्जी क्लींजिंग");
    expect(serviceName("PROTECTION", "hi")).toBe("एनर्जी क्लींजिंग");
    expect(allCopy.en.amma.protection).toBe("Energy cleansing"); // Amma sees the name the customer chose
  });
});

describe("copy: WhatsApp limits on every fixed string", () => {
  it("buttons ≤ 20, list rows and sections ≤ 24, row descriptions ≤ 72, bodies ≤ 1024", () => {
    for (const lang of LANGS) {
      const c = allCopy[lang];
      for (const b of [c.btnBook, c.btnHow, c.btnPerson, c.btnYes, c.btnNo, c.btnHealing, c.btnCleansing, c.btnMe, c.btnFamily, c.btnPet, c.payLabel, c.sessionPayLabel, c.btnChooseTime, c.listButtonTimes, c.faqButton]) {
        expect(b.length, `${lang} button "${b}"`).toBeLessThanOrEqual(20);
        expect(b.length).toBeGreaterThan(0);
      }
      for (const r of [c.changeLanguageRow, c.sectionAfternoon, c.sectionEvening, c.anotherDay, ...Object.values(c.faqTitles)]) {
        expect(r.length, `${lang} row/section "${r}"`).toBeLessThanOrEqual(24);
      }
      for (const d of [c.rowCall, c.rowSession]) expect(d.length, `${lang} description`).toBeLessThanOrEqual(72);
      for (const [path, text] of strings(c, lang).filter(([p]) => !p.startsWith("amma."))) expect(text.length, `${lang} ${path}`).toBeLessThanOrEqual(1024);
    }
  });

  it("the language buttons are the same in every language", async () => {
    const { LANGUAGE_BUTTONS } = await import("../src/copy");
    expect(LANGUAGE_BUTTONS).toEqual({ en: "English", hi: "हिंदी" });
    expect(allCopy.hi.greeting).toBe(allCopy.en.greeting);
    expect(allCopy.en.greeting).toContain("automated booking assistant");
    expect(allCopy.en.greeting).toContain("ऑटोमैटिक बुकिंग असिस्टेंट");
  });
});

describe("dates and times (India time)", () => {
  // 2026-10-21 is a Wednesday.
  it("English: Wed, 21 Oct and 2:30 pm", () => {
    expect(formatIstLang("2026-10-21T09:00:00Z", "en")).toEqual({ day: "Wed, 21 Oct", time: "2:30 pm" });
    expect(dayLabelFor("2026-10-21", "en")).toBe("Wed, 21 Oct");
  });
  it("Hindi: बुध, 21 अक्टूबर, दोपहर before 4 pm and शाम from 4 pm", () => {
    expect(formatIstLang("2026-10-21T09:00:00Z", "hi")).toEqual({ day: "बुध, 21 अक्टूबर", time: "दोपहर 2:30" });
    expect(formatIstLang("2026-10-21T12:00:00Z", "hi").time).toBe("शाम 5:30");
    expect(timeLabel("hi", 15, 45)).toBe("दोपहर 3:45");
    expect(timeLabel("hi", 16, 0)).toBe("शाम 4:00");
    expect(timeLabel("hi", 12, 0)).toBe("दोपहर 12:00");
    expect(timeLabel("hi", 9, 15)).toBe("सुबह 9:15"); // opening hours may move to the morning
    expect(timeLabel("en", 12, 0)).toBe("12:00 pm");
    expect(timeLabel("en", 0, 5)).toBe("12:05 am");
  });
  it("a late-night UTC time lands on the right IST day", () => {
    expect(formatIstLang("2026-10-20T19:00:00Z", "en").day).toBe("Wed, 21 Oct"); // 00:30 IST
  });
  it("every weekday and month fits a button (20), and every day plus time fits a row title (24), in both languages", () => {
    for (const lang of LANGS) {
      for (let d = 0; d < 366; d++) {
        const ymd = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
        expect(dayLabelFor(ymd, lang).length, `${lang} ${ymd}`).toBeLessThanOrEqual(20);
      }
      for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45]) expect(timeLabel(lang, h, m).length).toBeLessThanOrEqual(24);
    }
    expect(dateWords.hi.months).toHaveLength(12);
    expect(dateWords.hi.weekdays).toHaveLength(7);
  });
  it("every slot of a working week has a label in both languages", () => {
    for (const lang of LANGS) for (const s of generateSlots("2026-10-05", "CALL")) expect(formatIstLang(s.startUtc, lang).time).toMatch(/\d:\d\d/);
  });
});

describe("timings answer, from config.hours", () => {
  it("says the days and hours in plain words", () => {
    expect(hoursText("en")).toBe("Calls are Monday to Friday, 2 pm to 7 pm (India time).");
    expect(hoursText("hi")).toBe("कॉल सोमवार से शुक्रवार, दोपहर 2 बजे से शाम 7 बजे तक (भारतीय समय) होती हैं।");
    expect(allCopy.en.faqAnswers.timings).toBe(hoursText("en"));
    expect(allCopy.hi.faqAnswers.timings).toBe(hoursText("hi"));
  });
  it("follows config: other days and other hours", () => {
    const hours = config.hours as unknown as { days: number[]; start: string; end: string };
    const saved = { ...hours };
    try {
      hours.days = [1, 3, 5];
      hours.start = "09:30";
      hours.end = "13:00";
      expect(hoursText("en")).toBe("Calls are Monday, Wednesday and Friday, 9:30 am to 1 pm (India time).");
      expect(hoursText("hi")).toBe("कॉल सोमवार, बुधवार और शुक्रवार, सुबह 9:30 बजे से दोपहर 1 बजे तक (भारतीय समय) होती हैं।");
      hours.days = [6, 0];
      expect(hoursText("en")).toContain("Saturday and Sunday");
      hours.days = [1, 2, 3, 4, 5, 6];
      expect(hoursText("en")).toContain("Monday to Saturday");
    } finally {
      Object.assign(hours, saved);
    }
  });
});
