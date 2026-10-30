import { describe, expect, it } from "vitest";
import wrangler from "../wrangler.toml?raw";
import deploy from "../.github/workflows/deploy.yml?raw";
import evalWorkflow from "../.github/workflows/eval.yml?raw";

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
  it("the three flags are off at the top level; test and live may switch them, but only to a plain true or false", () => {
    const flags = ["OWNER_APPROVED", "NEW_BOOKINGS", "SENDS"];
    expect(flags.map((k) => value(section("vars"), k)), "vars").toEqual(["false", "false", "false"]);
    for (const env of ["env.test.vars", "env.live.vars"]) for (const k of flags) expect(["true", "false"], `${env} ${k}`).toContain(value(section(env), k));
  });
  it("live follows the launch order: bookings only once the bot can reply, and the sign-off flag last", () => {
    const l = section("env.live.vars");
    if (value(l, "NEW_BOOKINGS") === "true") expect(value(l, "SENDS")).toBe("true");
    if (value(l, "OWNER_APPROVED") === "true") expect(value(l, "NEW_BOOKINGS")).toBe("true");
  });
  it("AI_REPLIES is \"false\" at the top level and in live; test may be either", () => {
    for (const name of ["vars", "env.live.vars"]) expect(value(section(name), "AI_REPLIES"), name).toBe("false");
    expect(["true", "false"]).toContain(value(section("env.test.vars"), "AI_REPLIES"));
  });
  it("CONSOLE_V2 is \"false\" at the top level and in live; test may be either", () => {
    for (const name of ["vars", "env.live.vars"]) expect(value(section(name), "CONSOLE_V2"), name).toBe("false");
    expect(["true", "false"]).toContain(value(section("env.test.vars"), "CONSOLE_V2"));
    // Exactly the three sections set it (no fourth environment, no second line that could win).
    expect(wrangler.match(/^CONSOLE_V2\s*=/gm)?.length).toBe(3);
  });
  it("SOCIAL_REPLIES (Instagram / Messenger, ticket 32) is \"false\" at the top level; test and live are a plain true or false", () => {
    expect(value(section("vars"), "SOCIAL_REPLIES")).toBe("false");
    for (const name of ["env.test.vars", "env.live.vars"]) expect(["true", "false"], name).toContain(value(section(name), "SOCIAL_REPLIES"));
    expect(wrangler.match(/^SOCIAL_REPLIES\s*=/gm)?.length).toBe(3);
  });
  it("chat text is wiped after 7 days on live and at the top level, after 10 minutes on test", () => {
    expect(value(section("vars"), "CHAT_RETENTION_MINUTES")).toBe("10080");
    expect(value(section("env.live.vars"), "CHAT_RETENTION_MINUTES")).toBe("10080");
    expect(value(section("env.test.vars"), "CHAT_RETENTION_MINUTES")).toBe("10");
  });
  it("logs and traces are on at the top level and in both environments", () => {
    for (const name of ["observability", "env.test.observability", "env.live.observability"]) {
      expect(section(name)).toMatch(/^enabled\s*=\s*true\s*$/m);
    }
  });
  it("each environment has exactly one cron, every 2 minutes (the Workers Free plan allows 5 per account; the daily jobs ride on it)", () => {
    for (const name of ["triggers", "env.test.triggers", "env.live.triggers"]) {
      expect(section(name)).toMatch(/^crons = \["\*\/2 \* \* \* \*"\]$/m);
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

describe("assistant eval workflow", () => {
  it("is manual only, uses only the ANTHROPIC_API_KEY secret, and does not touch Cloudflare or WhatsApp", () => {
    expect(evalWorkflow).toMatch(/^on:\s*\n\s+workflow_dispatch:\s*$/m);
    expect(evalWorkflow).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(evalWorkflow).toContain("secrets.ANTHROPIC_API_KEY");
    expect([...evalWorkflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(["ANTHROPIC_API_KEY"]);
    expect(evalWorkflow).not.toMatch(/wrangler|WA_TOKEN|CLOUDFLARE/);
    expect(evalWorkflow).toContain("vitest.eval.config.ts");
  });
});
