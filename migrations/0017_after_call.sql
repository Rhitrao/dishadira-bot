-- Ticket 40: after the call (src/aftercall.ts). One row per message, so each goes at most once: the session reminder once per session
-- offer, the review and referral ask once per session (and at most once per person in config.afterCall.reviewEveryDays). Ids and times
-- only, never message text.
--   kind: REMINDER (target = the intro whose call ended in "Session") | REVIEW (target = the paid session that took place)
--   state: inserted PENDING, one caller moves it to SENDING, then SENT | FAILED | UNKNOWN; SKIPPED when it could not go as a template
--     (not approved by Meta yet, or no review link) and is never tried again
-- Deleted after 180 days by the 2-minute cron.
CREATE TABLE after_call (
  kind TEXT NOT NULL CHECK (kind IN ('REMINDER', 'REVIEW')),
  target INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED')),
  skip_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (kind, target)
);
CREATE INDEX after_call_conv ON after_call (conversation_id, kind, created_at);
CREATE INDEX after_call_created ON after_call (created_at);
