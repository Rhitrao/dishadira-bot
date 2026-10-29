/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { SECRET_NAMES } from "../src/env";

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

describe("config", () => {
  it("has positive numbers", () => {
    const nums = [
      config.prices.intro,
      config.prices.single,
      config.slots.callMinutes,
      config.slots.sessionMinutes,
      config.slots.maxSessionsPerDay,
      config.holdMinutes,
      config.undoMinutes,
      config.limits.notFitRefundsPerDay,
      config.limits.ammaTapReminderHours,
    ];
    for (const n of nums) expect(n).toBeGreaterThan(0);
  });

  it("session slots per day fit inside opening hours (and 300 minutes)", () => {
    const open = minutes(config.hours.end) - minutes(config.hours.start);
    const used = config.slots.maxSessionsPerDay * config.slots.sessionMinutes;
    expect(used).toBeLessThanOrEqual(300);
    expect(used).toBeLessThanOrEqual(open);
  });

  it("hours are ordered and slot lengths divide the day", () => {
    const open = minutes(config.hours.end) - minutes(config.hours.start);
    expect(open).toBeGreaterThan(0);
    expect(open % config.slots.callMinutes).toBe(0);
  });

  it("working days are Monday to Saturday, 2 to 7 pm India time; never Sunday (ticket 30)", () => {
    expect(config.hours.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(config.hours.days).not.toContain(0);
    expect([config.hours.start, config.hours.end]).toEqual(["14:00", "19:00"]);
  });

  it("the day step fits one WhatsApp list: 6 days, and enough look-ahead to find them past full days and holidays (ticket 30)", () => {
    expect(config.booking.workingDays).toBe(6);
    expect(config.booking.workingDays).toBeLessThanOrEqual(config.booking.maxListRows);
    expect(config.booking.lookaheadDays).toBeGreaterThanOrEqual(2 * config.booking.workingDays);
    expect(config.holidays.maxDaysAhead).toBe(60);
  });

  it("lists languages, services and FAQ ids", () => {
    expect(config.languages).toEqual(["en", "hi"]);
    expect(config.services).toHaveLength(2);
    expect(new Set(config.faqIds).size).toBe(config.faqIds.length);
  });

  it("names every required secret", () => {
    expect(SECRET_NAMES).toHaveLength(13);
  });

  it("Razorpay's secrets are the payment secrets, and the provider config is complete", () => {
    for (const name of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) expect(SECRET_NAMES).toContain(name);
    expect(SECRET_NAMES.filter((n) => /KEY_ID|CASH|STRIPE|PAYPAL|PAYU/i.test(n))).toEqual(["RAZORPAY_KEY_ID"]);
    expect(config.razorpay.baseUrl).toBe("https://api.razorpay.com/v1");
    expect(config.razorpay.minLinkExpiryMinutes).toBeGreaterThan(0);
    expect(config.razorpay.pollAfterMinutes).toBeGreaterThan(0);
  });

  it("only one payment provider is in the code at a time", () => {
    const files = Object.keys(import.meta.glob("../src/pay/*.ts")).map((f) => f.split("/").pop());
    expect(files.sort()).toEqual(["apply.ts", "provider.ts", "razorpay.ts", "refund.ts", "webhook.ts"]);
  });
});
