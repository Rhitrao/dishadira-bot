import { Hono } from "hono";
import type { Env } from "./env";
import { amma } from "./amma";
import { applyDueOutcomes } from "./outcomes";
import { reconcile } from "./pay/apply";
import { cashfree } from "./pay/cashfree";
import { retryRefunds } from "./pay/refund";
import { cashfreeWebhook } from "./pay/webhook";
import { receiveWebhook, verifyWebhook } from "./whatsapp";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

const notImplemented = (c: { json: (b: unknown, s: 501) => Response }) =>
  c.json({ ok: false, error: "not_implemented" }, 501);

app.get("/wa/webhook", verifyWebhook);
app.post("/wa/webhook", receiveWebhook);
app.post("/pay/cashfree/webhook", (c) => cashfreeWebhook(c));
app.route("/amma", amma);
app.all("/admin", notImplemented);

export const RECONCILE_CRON = "*/2 * * * *";

// Cloudflare calls scheduled() for each cron in wrangler.toml; the 9pm digest (Ticket 07) will share this entry.
const scheduled = async (event: { cron: string }, env: Env) => {
  if (event.cron !== RECONCILE_CRON) return;
  const provider = cashfree(env);
  // One failing job must not stop the others; each is safe to run again.
  for (const job of [applyDueOutcomes, retryRefunds, reconcile]) await job(env, provider).catch(() => 0);
};

export default Object.assign(app, { scheduled });
