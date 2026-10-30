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
  // Instagram DMs and Messenger (ticket 32, docs/SOCIAL.md). The same Meta app as WhatsApp, so the signature uses WA_APP_SECRET.
  "META_VERIFY_TOKEN", // the verify token typed into the app's Messenger / Instagram webhook settings (not the WhatsApp one)
  "META_PAGE_TOKEN", // the long-lived Page access token of the Page "Disha Dira Pranic Healing"
  "META_PAGE_ID", // that Page's id (not secret, but kept with the token so a deploy never wipes it)
  "META_IG_ID", // the id of the Instagram professional account linked to the Page
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
  // "true" lets the bot answer Instagram DMs and Messenger (src/social.ts); anything else: /meta/webhook checks and answers 200, and sends nothing.
  SOCIAL_REPLIES?: string;
  // Minutes after a person's last message that their chat text is wiped: live "10080" (7 days), test "10".
  CHAT_RETENTION_MINUTES: string;
  // The Worker's public address, for links in emails to Rohit (https://bot.disha-dira.com); unset: a relative /admin link.
  PUBLIC_URL?: string;
  // Cloudflare send_email binding (optional: without it, emails are logged and skipped).
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
} & Record<SecretName, string>;
