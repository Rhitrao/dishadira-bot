// Email to Rohit through a Cloudflare Email Service `send_email` binding (EMAIL). DIGEST_TO is a secret; nothing real is in git.
// If the binding or DIGEST_TO is missing, we log and skip: email never makes a job fail.
import { config } from "./config";
import type { Env } from "./env";
import { getSetting } from "./switches";
import { iso, istDay } from "./slots";

export const ALERT_KINDS = ["REFUND_FAILED", "REFUND_STUCK", "PAYMENT_MISMATCH", "UNKNOWN_PAYMENT_LINK", "OUTCOME_FAILED"] as const;
export const HEARTBEAT_KEY = "HEARTBEAT";
export const HEARTBEAT_STALE_MIN = 15;

export const mailConfigured = (env: Env) => Boolean(env.EMAIL && env.DIGEST_TO);

export async function sendEmail(env: Env, subject: string, text: string): Promise<"SENT" | "SKIPPED" | "FAILED"> {
  if (!mailConfigured(env)) {
    console.log("email skipped: not configured");
    return "SKIPPED";
  }
  try {
    await env.EMAIL!.send({ to: env.DIGEST_TO, from: config.mail.from, subject, text });
    return "SENT";
  } catch (e) {
    console.log("email failed", (e as { code?: string }).code ?? "error");
    return "FAILED";
  }
}

const plural = (n: number) => (n === 1 ? "item" : "items");

// At most one email per kind per IST day: the day's claim is one settings row, taken before sending and released if the send fails.
async function alertOnce(env: Env, kind: string, subject: string, body: string, nowMs: number): Promise<boolean> {
  const key = `alert:${kind}:${istDay(nowMs)}`;
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, 'sent', ?2)").bind(key, iso(nowMs)).run();
  if (!claim.meta.changes) return false;
  if ((await sendEmail(env, subject, body)) === "SENT") return true;
  await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
  return false;
}

export async function heartbeatStale(env: Env, nowMs: number): Promise<boolean> {
  const last = await getSetting(env.DB, HEARTBEAT_KEY);
  return !last || nowMs - Date.parse(last) > HEARTBEAT_STALE_MIN * 60_000;
}

// Immediate alerts for open attention items of the urgent kinds, and (when asked) for a missing 2-minute heartbeat.
export async function sendAlerts(env: Env, nowMs = Date.now(), opts: { heartbeat?: boolean } = {}): Promise<string[]> {
  if (!mailConfigured(env)) return [];
  const sent: string[] = [];
  for (const kind of ALERT_KINDS) {
    const { results } = await env.DB.prepare("SELECT target FROM attention WHERE kind = ?1 AND resolved_at IS NULL ORDER BY id").bind(kind).all<{ target: string | null }>();
    if (!results.length) continue;
    const body = `${results.length} open ${plural(results.length)} of kind ${kind}:\n${results.map((r) => `- ${r.target ?? ""}`).join("\n")}\n\nOpen /admin to act.`;
    if (await alertOnce(env, kind, `Disha Dira alert: ${kind}`, body, nowMs)) sent.push(kind);
  }
  if (opts.heartbeat && (await heartbeatStale(env, nowMs))) {
    const body = `The 2-minute cron has not recorded a heartbeat in ${HEARTBEAT_STALE_MIN} minutes. Check the Worker's cron triggers in Cloudflare.`;
    if (await alertOnce(env, "HEARTBEAT_STALE", "Disha Dira alert: cron heartbeat missing", body, nowMs)) sent.push("HEARTBEAT_STALE");
  }
  return sent;
}
