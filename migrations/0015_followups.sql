-- Ticket 35: automatic follow-ups on WhatsApp, Instagram and Messenger, 60 minutes and 20 hours after a person's last real message
-- (src/followup.ts). Times and counters only; never message text.
--   real_in_at: their last real message (not spam, not rude, not a reaction): the follow-ups count from it, and a new one starts again
--   gentle_at: their last message that named an illness (config.router.topics.medical): then only the gentle check-in, never a price
ALTER TABLE social_contacts ADD COLUMN real_in_at TEXT;
ALTER TABLE social_contacts ADD COLUMN gentle_at TEXT;
ALTER TABLE person_state ADD COLUMN real_in_at TEXT;
ALTER TABLE person_state ADD COLUMN gentle_at TEXT;
CREATE INDEX person_state_real_in ON person_state (real_in_at);
CREATE INDEX social_contacts_real_in ON social_contacts (real_in_at);

-- One row per follow-up: claimed atomically (inserted PENDING, one caller moves it to SENDING), then SENT | FAILED | UNKNOWN; never resent.
--   channel: whatsapp | instagram | messenger; person: the WhatsApp conversation id, or the Instagram / Messenger id
--   anchor: the real_in_at it counted from; stage: 1 (60 minutes) or 2 (20 hours, or the gentle check-in)
-- Deleted after 30 days by the 2-minute cron, and with the person's row on "delete my data".
CREATE TABLE followups (
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'messenger')),
  person TEXT NOT NULL,
  anchor TEXT NOT NULL,
  stage INTEGER NOT NULL CHECK (stage IN (1, 2)),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (channel, person, anchor, stage)
);
CREATE INDEX followups_created ON followups (created_at);
