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

  it("/admin is closed without Access", async () => {
    const res = await app.request("/admin");
    expect(res.status).toBe(403);
  });
});
