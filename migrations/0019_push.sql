-- Ticket 45: phone alerts for the team when a customer books and pays (src/alerts.ts, src/push.ts). Team members' devices only, never a
-- customer's; ids, times and the push service's address only, never a customer's name, number or message.

-- One row per browser that turned alerts on (Settings → Alerts on this phone). endpoint: the push service's address for that browser (https,
-- a known push service host only); p256dh and auth: the browser's public key and secret for encrypting to it (RFC 8291); ua: a short
-- "Chrome on Android", nothing more. Deleted when the member turns it off or removes it, or when the push service says it is gone (404/410).
CREATE TABLE push_subs (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members (id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_member ON push_subs (member_id);

-- One alert per booking and member (UNIQUE target + member, so a replayed payment never alerts twice).
--   kind: CALL | SESSION | PACKAGE (target = payment:<id>) | CREDIT_SESSION (target = session:<id>, a session booked from a package)
--   state: PENDING until due_at (a practitioner's alert made in the quiet hours waits for the morning: held = 1), SENDING while one run has
--     claimed it (claim), then SENT | FAILED (config.push.maxAttempts tries) | SKIPPED (the booking no longer stands, no device left, the
--     member was removed). Deleted after config.push.keepDays by the 2-minute cron.
CREATE TABLE push_outbox (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members (id),
  kind TEXT NOT NULL CHECK (kind IN ('CALL', 'SESSION', 'PACKAGE', 'CREDIT_SESSION')),
  target TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
  due_at TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  sent_at TEXT,
  UNIQUE (target, member_id)
);
CREATE INDEX push_outbox_due ON push_outbox (state, due_at);
CREATE INDEX push_outbox_claim ON push_outbox (claim);
CREATE INDEX push_outbox_created ON push_outbox (created_at);
