import type { D1Database } from "@cloudflare/workers-types";

// Names only. Values are set by Rohit in Cloudflare, never in git.
export const SECRET_NAMES = [
  "WA_TOKEN",
  "WA_APP_SECRET",
  "WA_VERIFY_TOKEN",
  "WA_PHONE_ID",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "ACCESS_AUD",
  "ACCESS_TEAM",
  "DIGEST_TO",
  "AMMA_EMAIL",
  "ROHIT_EMAIL",
  "ANTHROPIC_API_KEY",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export type Env = {
  DB: D1Database;
  OWNER_APPROVED: string;
  NEW_BOOKINGS: string;
  SENDS: string;
  // "true" lets the assistant (src/ai.ts) answer typed questions; "false" everywhere until Rohit switches it on. /admin can pause it, never enable it.
  AI_REPLIES: string;
  PAYMENT_MODE: string;
  // "true" opens the role-based console under /app (src/console.ts); "false" at the top level and in live: /app is then a plain 404.
  CONSOLE_V2?: string;
  // Minutes after a person's last message that their chat text is wiped: live "10080" (7 days), test "10".
  CHAT_RETENTION_MINUTES: string;
  // The Worker's public address, for links in emails to Rohit (https://bot.disha-dira.com); unset: a relative /admin link.
  PUBLIC_URL?: string;
  // Cloudflare send_email binding (optional: without it, emails are logged and skipped).
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
} & Record<SecretName, string>;
