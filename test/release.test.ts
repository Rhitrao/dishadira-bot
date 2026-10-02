import { describe, expect, it } from "vitest";
import wrangler from "../wrangler.toml?raw";
import deploy from "../.github/workflows/deploy.yml?raw";

// Release checks on the deploy files: test and live never share data, and every safety flag starts off.
const section = (name: string) => {
  const start = wrangler.indexOf(`[${name}]`);
  expect(start, `[${name}] exists`).toBeGreaterThan(-1);
  const rest = wrangler.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
};
const value = (text: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];

describe("wrangler environments", () => {
  it("test and live each have their own database, worker name and PAYMENT_MODE", () => {
    const t = wrangler.slice(wrangler.indexOf("[env.test]"), wrangler.indexOf("[env.live]"));
    const l = wrangler.slice(wrangler.indexOf("[env.live]"));
    expect(value(t, "database_id")).not.toBe(value(l, "database_id"));
    expect(value(t, "database_name")).toBe("dishadira-bot-test");
    expect(value(l, "database_name")).toBe("dishadira-bot-live");
    expect(value(t, "name")).not.toBe(value(l, "name"));
    expect(value(section("env.test.vars"), "PAYMENT_MODE")).toBe("test");
    expect(value(section("env.live.vars"), "PAYMENT_MODE")).toBe("live");
  });
  it("every safety flag starts off in both environments, and at the top level", () => {
    for (const name of ["vars", "env.test.vars", "env.live.vars"]) {
      const s = section(name);
      expect(["OWNER_APPROVED", "NEW_BOOKINGS", "SENDS"].map((k) => value(s, k))).toEqual(["false", "false", "false"]);
    }
  });
  it("both environments carry the three crons, including 18:30 IST reminders", () => {
    for (const name of ["triggers", "env.test.triggers", "env.live.triggers"]) {
      expect(section(name)).toContain('"0 13 * * *"');
      expect(section(name)).toContain('"30 15 * * *"');
      expect(section(name)).toContain('"*/2 * * * *"');
    }
  });
  it("the email binding is repeated for each environment", () => {
    expect(wrangler).toContain("[[env.test.send_email]]");
    expect(wrangler).toContain("[[env.live.send_email]]");
  });
});

describe("deploy workflow", () => {
  it("is manual only, with a test | live choice, and uses the two GitHub secrets", () => {
    expect(deploy).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(deploy).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(deploy).toContain("options: [test, live]");
    expect(deploy).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(deploy).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
  it("checks first, then migrates the matching database, then deploys", () => {
    const at = (s: string) => deploy.indexOf(s);
    expect(at("npm run typecheck")).toBeGreaterThan(-1);
    expect(at("npm test")).toBeGreaterThan(at("npm run typecheck"));
    expect(at("d1 migrations apply DB --remote --env ${{ inputs.environment }}")).toBeGreaterThan(at("npm test"));
    expect(at("wrangler deploy --env ${{ inputs.environment }}")).toBeGreaterThan(at("migrations apply"));
  });
});
