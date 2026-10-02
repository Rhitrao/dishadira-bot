import { Hono } from "hono";
import type { Env } from "./env";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

const notImplemented = (c: { json: (b: unknown, s: 501) => Response }) =>
  c.json({ ok: false, error: "not_implemented" }, 501);

app.all("/wa/webhook", notImplemented);
app.all("/pay/cashfree/webhook", notImplemented);
app.all("/amma", notImplemented);
app.all("/admin", notImplemented);

export default app;
