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
      config.prices.introPaise,
      config.prices.sessionPaise,
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

  it("lists languages, services and FAQ ids", () => {
    expect(config.languages).toEqual(["en", "kn"]);
    expect(config.services).toHaveLength(2);
    expect(new Set(config.faqIds).size).toBe(config.faqIds.length);
  });

  it("names every required secret", () => {
    expect(SECRET_NAMES).toHaveLength(10);
  });
});
