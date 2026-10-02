import { Hono } from "hono";
import type { Env } from "./env";
import { receiveWebhook, verifyWebhook } from "./whatsapp";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

const notImplemented = (c: { json: (b: unknown, s: 501) => Response }) =>
  c.json({ ok: false, error: "not_implemented" }, 501);

app.get("/wa/webhook", verifyWebhook);
app.post("/wa/webhook", receiveWebhook);
app.all("/pay/cashfree/webhook", notImplemented);
app.all("/amma", notImplemented);
app.all("/admin", notImplemented);

export default app;
