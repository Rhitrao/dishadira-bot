import { Hono } from "hono";
import type { Env } from "./env";
import { admin } from "./admin";
import { loadPrices } from "./business";
import { amma } from "./amma";
import { cleanFollowUps, whatsappFollowUps } from "./followup";
import { serveFont } from "./fonts";
import { consoleApp } from "./console";
import { nudgeWaitingChats } from "./inbox";
import { sendAlerts } from "./mail";
import { applyDueOutcomes, sendRefundNotices } from "./outcomes";
import { reconcile, resendSkippedPaid } from "./pay/apply";
import { razorpay } from "./pay/razorpay";
import { retryRefunds } from "./pay/refund";
import { razorpayWebhook } from "./pay/webhook";
import { nudgeUnpaidHolds, payLinkPage } from "./paylink";
import { mailOpenRequests } from "./requests";
import { REMINDER_AT, sendReminders } from "./remind";
import { runDigest } from "./report";
import { raiseAwayItems, raiseTapReminders, recordHeartbeat, returnStaleHumans } from "./watch";
import { istDay, iso } from "./slots";
import { bookRedirect, cleanSocial, dataDeletionPage, pageRedirect, profileRedirect, receiveMetaWebhook, socialFollowUps, verifyMetaWebhook } from "./social";
import { sendsOn } from "./switches";
import { switchOver } from "./switchover";
import { wipeChats } from "./wipe";
import { receiveWebhook, verifyWebhook } from "./whatsapp";

export const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

// Log the route and nothing else: error text can carry user data.
app.onError((_e, c) => {
  console.error("unhandled error", c.req.method, c.req.routePath);
  return c.text("error", 500);
});

// Every request quotes the owner's prices from Settings (src/business.ts); /health, the font files, the payment link, /fb and /ig don't need
// them (/b/ does: its WhatsApp text says the ₹99).
app.use("*", async (c, next) => {
  if (!["/health", "/fb", "/ig"].includes(c.req.path) && !c.req.path.startsWith("/app/fonts/") && !c.req.path.startsWith("/p/")) await loadPrices(c.env);
  await next();
});

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
// The console's self-hosted fonts (ticket 20); 404 unless CONSOLE_V2 is "true".
app.get("/app/fonts/:file", serveFont);

app.get("/wa/webhook", verifyWebhook);
app.post("/wa/webhook", receiveWebhook);
// Instagram DMs and Messenger (ticket 32, src/social.ts): its own route and verify token, the same app secret. Public, like /wa/webhook.
app.get("/meta/webhook", verifyMetaWebhook);
app.post("/meta/webhook", receiveMetaWebhook);
// The data deletion instructions URL for Meta App Review (public).
app.get("/data-deletion", dataDeletionPage);
// Short links for Messenger texts (ticket 33): /b/<ref>[/hi] to WhatsApp, /fb to the Page, /ig to the Instagram profile. Public, 302s.
app.get("/b", bookRedirect);
app.get("/b/*", bookRedirect);
app.get("/fb", pageRedirect);
app.get("/ig", profileRedirect);
app.post("/pay/razorpay/webhook", (c) => razorpayWebhook(c));
// Our own payment link (ticket 29): public, outside /amma, /admin and /app, so Cloudflare Access never stands in front of it.
app.get("/p/:token", payLinkPage);
// With CONSOLE_V2 on, the old pages send people to /app (src/switchover.ts); off, they work exactly as before.
for (const path of ["/amma", "/amma/*", "/admin", "/admin/*"]) app.use(path, switchOver);
app.route("/amma", amma);
app.route("/admin", admin);
app.route("/app", consoleApp); // the role-based console, behind CONSOLE_V2 (a 404 while it is off)

// One cron per Worker: the Workers Free plan allows 5 cron triggers per account, and test and live share the account.
export const RECONCILE_CRON = "*/2 * * * *";

// The two daily jobs ride on the 2-minute cron. Each runs once per IST day, on the first tick at or after its time (so a missed
// tick only delays it by 2 minutes); the day's claim is one settings row, released if the job fails so the next tick tries again.
export const DAILY_JOBS = [
  { key: "reminders", at: REMINDER_AT, needsSends: true, run: (env: Env) => sendReminders(env) },
  { key: "digest", at: "21:00", needsSends: false, run: (env: Env) => runDigest(env) },
] as const;

export async function runDailyJobs(env: Env, nowMs: number): Promise<string[]> {
  const ran: string[] = [];
  const day = istDay(nowMs);
  for (const job of DAILY_JOBS) {
    if (nowMs < Date.parse(`${day}T${job.at}:00+05:30`)) continue;
    // While sends are paused, reminders are not claimed, so resuming sends the same evening still sends them.
    if (job.needsSends && !(await sendsOn(env))) continue;
    const key = `daily:${job.key}:${day}`;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, 'ran', ?2)").bind(key, iso(nowMs)).run();
    if (!claim.meta.changes) continue;
    try {
      await job.run(env);
      ran.push(job.key);
    } catch {
      await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run().catch(() => undefined);
    }
  }
  return ran;
}

// Cloudflare calls scheduled() every 2 minutes: the heartbeat, the jobs, then the daily reminders (6:30 pm IST) and digest (9 pm IST).
const scheduled = async (event: { cron: string; scheduledTime?: number }, env: Env) => {
  if (event.cron !== RECONCILE_CRON) return;
  await loadPrices(env);
  const provider = razorpay(env);
  await recordHeartbeat(env).catch(() => 0);
  // One failing job must not stop the others; each is safe to run again.
  for (const job of [applyDueOutcomes, retryRefunds, reconcile]) await job(env, provider).catch(() => 0);
  for (const job of [raiseAwayItems, raiseTapReminders, returnStaleHumans, sendAlerts, wipeChats, nudgeWaitingChats, mailOpenRequests, nudgeUnpaidHolds, resendSkippedPaid, sendRefundNotices, cleanSocial,
    whatsappFollowUps, socialFollowUps, cleanFollowUps]) await job(env).catch(() => 0);
  await runDailyJobs(env, event.scheduledTime ?? Date.now()).catch(() => undefined);
};

export default Object.assign(app, { scheduled });
