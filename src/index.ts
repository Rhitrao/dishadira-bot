import { Hono } from "hono";
import type { Env } from "./env";
import { admin } from "./admin";
import { amma } from "./amma";
import { serveFont } from "./fonts";
import { consoleApp } from "./console";
import { nudgeWaitingChats } from "./inbox";
import { sendAlerts } from "./mail";
import { applyDueOutcomes } from "./outcomes";
import { reconcile } from "./pay/apply";
import { razorpay } from "./pay/razorpay";
import { retryRefunds } from "./pay/refund";
import { razorpayWebhook } from "./pay/webhook";
import { sendReminders } from "./remind";
import { runDigest } from "./report";
import { raiseAwayItems, raiseTapReminders, recordHeartbeat, returnStaleHumans } from "./watch";
import { wipeChats } from "./wipe";
import { receiveWebhook, verifyWebhook } from "./whatsapp";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

// Log the route and nothing else: error text can carry user data.
app.onError((_e, c) => {
  console.error("unhandled error", c.req.method, c.req.routePath);
  return c.text("error", 500);
});

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
// The console's self-hosted fonts (ticket 20); 404 unless CONSOLE_V2 is "true".
app.get("/app/fonts/:file", serveFont);

app.get("/wa/webhook", verifyWebhook);
app.post("/wa/webhook", receiveWebhook);
app.post("/pay/razorpay/webhook", (c) => razorpayWebhook(c));
app.route("/amma", amma);
app.route("/admin", admin);
app.route("/app", consoleApp); // the role-based console, behind CONSOLE_V2 (a 404 while it is off)

export const RECONCILE_CRON = "*/2 * * * *";

export const DIGEST_CRON = "30 15 * * *";

export const REMINDER_CRON = "0 13 * * *"; // 18:30 IST

// Cloudflare calls scheduled() for each cron in wrangler.toml: every 2 minutes (jobs + heartbeat), 6:30pm IST (reminders) and 9pm IST (digest).
const scheduled = async (event: { cron: string }, env: Env) => {
  if (event.cron === DIGEST_CRON) return runDigest(env).catch(() => undefined);
  if (event.cron === REMINDER_CRON) return sendReminders(env).then(() => undefined, () => undefined);
  if (event.cron !== RECONCILE_CRON) return;
  const provider = razorpay(env);
  await recordHeartbeat(env).catch(() => 0);
  // One failing job must not stop the others; each is safe to run again.
  for (const job of [applyDueOutcomes, retryRefunds, reconcile]) await job(env, provider).catch(() => 0);
  for (const job of [raiseAwayItems, raiseTapReminders, returnStaleHumans, sendAlerts, wipeChats, nudgeWaitingChats]) await job(env).catch(() => 0);
};

export default Object.assign(app, { scheduled });
