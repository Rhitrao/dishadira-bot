-- Ticket 32: automatic replies to Instagram DMs and Facebook Messenger (src/social.ts). One row per person per platform, keyed by the
-- id Meta gives that person on that platform (Instagram-scoped id or Page-scoped id). No message text, no names, no usernames.
--   step: NEW (nothing sent yet) | ASKED (the follow ask went) | RECHECK (Instagram said "not following yet") | LINKED (the WhatsApp link went)
--   asks: how many times they tapped "I'm following" since the last follow ask round (the second tap gets the link anyway)
--   last_in_at: their last message or tap (after 30 days without one, the flow starts again)
--   last_auto_at / autos_since / autos_today: our last automated message, and the count in the current 24 hours (at most 3)
--   nudge_at: the last "message us on WhatsApp" line after the link (at most one a day)
--   paused_until: a person from the team wrote to them by hand, so the automation keeps out of that chat until then
CREATE TABLE social_contacts (
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'messenger')),
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'hi')),
  step TEXT NOT NULL DEFAULT 'NEW' CHECK (step IN ('NEW', 'ASKED', 'RECHECK', 'LINKED')),
  asks INTEGER NOT NULL DEFAULT 0,
  link_sent_at TEXT,
  last_in_at TEXT,
  last_auto_at TEXT,
  autos_since TEXT,
  autos_today INTEGER NOT NULL DEFAULT 0,
  nudge_at TEXT,
  paused_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT,
  PRIMARY KEY (platform, user_id)
);

-- Message ids already handled (in:<mid>, so a webhook retry does nothing) and message ids we sent (out:<mid>, so the echo of our own
-- message is not mistaken for a person from the team writing). Deleted after 7 days by the 2-minute cron.
CREATE TABLE social_seen (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE INDEX social_seen_at ON social_seen (at);
