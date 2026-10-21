-- Ticket 12: the gatekeeper (safety, noise, quiet periods), re-prompts and the chat wipe.

-- Per-person state, keyed by conversation id. All times are ISO UTC. Days are India (IST) days, YYYY-MM-DD.
-- flirt_offences / abuse_offences: "a second offence" blocks. book_tap_at: last time the person tapped Book or typed "book" (warm leads in the digest).
CREATE TABLE person_state (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations (id),
  strikes INTEGER NOT NULL DEFAULT 0,
  last_strike_at TEXT,
  quiet_until TEXT,
  quiet_count_30d INTEGER NOT NULL DEFAULT 0,
  last_quiet_at TEXT,
  smalltalk_day TEXT,
  smalltalk_count INTEGER NOT NULL DEFAULT 0,
  ai_day TEXT,
  ai_count INTEGER NOT NULL DEFAULT 0,
  media_notice_day TEXT,
  no_sell_until TEXT,
  ai_crisis_day TEXT,
  opted_out_at TEXT,
  flirt_offences INTEGER NOT NULL DEFAULT 0,
  abuse_offences INTEGER NOT NULL DEFAULT 0,
  book_tap_at TEXT
);

-- Things the code used to read from old message rows now live on the conversation, so wiping message text changes nothing.
-- greeted_at: the greeting went out. last_ack_at: the last free-text acknowledgement that went out (one per 24 hours).
-- pending_step / pending_out / pending_until / pending_reprompts: the open booking step, the message to resend (JSON), when it stops being open,
-- and how many typed messages in a row it has been re-sent for.
ALTER TABLE conversations ADD COLUMN greeted_at TEXT;
ALTER TABLE conversations ADD COLUMN last_ack_at TEXT;
ALTER TABLE conversations ADD COLUMN pending_step TEXT;
ALTER TABLE conversations ADD COLUMN pending_out TEXT;
ALTER TABLE conversations ADD COLUMN pending_until TEXT;
ALTER TABLE conversations ADD COLUMN pending_reprompts INTEGER NOT NULL DEFAULT 0;

-- skip_reason: why a reply was recorded as SKIPPED without being sent (NEWER_MESSAGE). wiped_at: when the text of this message was removed.
ALTER TABLE messages ADD COLUMN skip_reason TEXT;
ALTER TABLE messages ADD COLUMN wiped_at TEXT;
CREATE INDEX messages_unwiped ON messages (conversation_id) WHERE body IS NOT NULL;

-- Everyone who exists gets a state row; new people get theirs with their first message.
INSERT INTO person_state (conversation_id) SELECT id FROM conversations;

-- Backfill from the old message rows (only messages that really went out counted).
UPDATE conversations SET greeted_at = (
  SELECT COALESCE(m.updated_at, m.created_at) FROM messages m
  WHERE m.dedupe_key = 'greet:' || conversations.id AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'))
WHERE EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'greet:' || conversations.id AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'));

UPDATE conversations SET last_ack_at = (
  SELECT MAX(COALESCE(m.updated_at, m.created_at)) FROM messages m
  WHERE m.conversation_id = conversations.id AND m.direction = 'OUT' AND m.dedupe_key LIKE '%:ack' AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'))
WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.direction = 'OUT' AND m.dedupe_key LIKE '%:ack' AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'));

UPDATE person_state SET media_notice_day = (
  SELECT MAX(substr(m.dedupe_key, -10)) FROM messages m
  WHERE m.conversation_id = person_state.conversation_id AND m.dedupe_key LIKE 'media:%' AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'))
WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = person_state.conversation_id AND m.dedupe_key LIKE 'media:%' AND m.status IN ('SENT', 'SENDING', 'UNKNOWN'));
