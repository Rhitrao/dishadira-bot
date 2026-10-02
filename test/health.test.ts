import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("routes", () => {
  it("GET /health returns ok and a version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });

  it.each(["/pay/cashfree/webhook", "/amma", "/admin"])("%s is a 501 stub", async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(501);
  });
});
