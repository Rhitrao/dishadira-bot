-- Ticket 03: messages gain SKIPPED (SENDS off) and RECEIVED (inbound) statuses, plus a delivery receipt column.
-- SQLite cannot alter a CHECK, so the table is rebuilt.
ALTER TABLE messages RENAME TO messages_old;
DROP INDEX messages_conversation;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  wa_message_id TEXT UNIQUE,
  dedupe_key TEXT UNIQUE,
  kind TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED', 'RECEIVED')),
  delivery TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
INSERT INTO messages (id, conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at, updated_at)
  SELECT id, conversation_id, direction, wa_message_id, dedupe_key, kind, body, status, created_at, updated_at FROM messages_old;
DROP TABLE messages_old;
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);
