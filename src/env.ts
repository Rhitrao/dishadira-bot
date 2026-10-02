import type { D1Database } from "@cloudflare/workers-types";

// Names only. Values are set by Rohit in Cloudflare, never in git.
export const SECRET_NAMES = [
  "WA_TOKEN",
  "WA_APP_SECRET",
  "WA_VERIFY_TOKEN",
  "WA_PHONE_ID",
  "CASHFREE_APP_ID",
  "CASHFREE_SECRET",
  "CASHFREE_WEBHOOK_SECRET",
  "ACCESS_AUD",
  "ACCESS_TEAM",
  "DIGEST_TO",
  "AMMA_EMAIL",
  "ROHIT_EMAIL",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export type Env = {
  DB: D1Database;
  OWNER_APPROVED: string;
  NEW_BOOKINGS: string;
  SENDS: string;
  PAYMENT_MODE: string;
  // Cloudflare send_email binding (optional: without it, emails are logged and skipped).
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
} & Record<SecretName, string>;
