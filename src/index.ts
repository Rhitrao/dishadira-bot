import { Hono } from "hono";
import type { Env } from "./env";
import { admin } from "./admin";
import { amma } from "./amma";
import { sendAlerts } from "./mail";
import { applyDueOutcomes } from "./outcomes";
import { reconcile } from "./pay/apply";
import { cashfree } from "./pay/cashfree";
import { retryRefunds } from "./pay/refund";
import { cashfreeWebhook } from "./pay/webhook";
import { sendReminders } from "./remind";
import { runDigest } from "./report";
import { raiseAwayItems, raiseTapReminders, recordHeartbeat } from "./watch";
import { receiveWebhook, verifyWebhook } from "./whatsapp";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

app.get("/wa/webhook", verifyWebhook);
app.post("/wa/webhook", receiveWebhook);
app.post("/pay/cashfree/webhook", (c) => cashfreeWebhook(c));
app.route("/amma", amma);
app.route("/admin", admin);

export const RECONCILE_CRON = "*/2 * * * *";

export const DIGEST_CRON = "30 15 * * *";

export const REMINDER_CRON = "0 13 * * *"; // 18:30 IST

// Cloudflare calls scheduled() for each cron in wrangler.toml: every 2 minutes (jobs + heartbeat), 6:30pm IST (reminders) and 9pm IST (digest).
const scheduled = async (event: { cron: string }, env: Env) => {
  if (event.cron === DIGEST_CRON) return runDigest(env).catch(() => undefined);
  if (event.cron === REMINDER_CRON) return sendReminders(env).then(() => undefined, () => undefined);
  if (event.cron !== RECONCILE_CRON) return;
  const provider = cashfree(env);
  await recordHeartbeat(env).catch(() => 0);
  // One failing job must not stop the others; each is safe to run again.
  for (const job of [applyDueOutcomes, retryRefunds, reconcile]) await job(env, provider).catch(() => 0);
  for (const job of [raiseAwayItems, raiseTapReminders, sendAlerts]) await job(env).catch(() => 0);
};

export default Object.assign(app, { scheduled });
