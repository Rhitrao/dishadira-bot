-- Ticket 47: the team's notes for each customer (src/notes.ts) and the chat gist above the chat (src/gist.ts).

-- Notes: the practice's own record of a customer (owner; the practitioner for her own customers; never staff). Each note belongs to a
-- person and, optionally, one booking (booking_kind CALL = intros.id, SESSION = sessions.id), with a phase: BEFORE (prep), DURING,
-- AFTER (follow-up), or ABOUT (the one pinned "About this person" note, edited in place: at most one per person).
-- Not wiped with the chat text (CHAT_RETENTION_MINUTES); deleted by People -> Remove their data. Never in the export, the AI, emails, the
-- digest, notifications or logs. The audit log keeps ids only (NOTE_ADD / NOTE_EDIT / NOTE_DELETE), never the text.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  booking_kind TEXT CHECK (booking_kind IN ('CALL', 'SESSION')),
  booking_id INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('BEFORE', 'DURING', 'AFTER', 'ABOUT')),
  body TEXT NOT NULL,
  author_id INTEGER REFERENCES members (id),
  created_at TEXT NOT NULL,
  edited_at TEXT,
  CHECK ((booking_kind IS NULL) = (booking_id IS NULL)),
  CHECK (phase != 'ABOUT' OR booking_kind IS NULL)
);
CREATE INDEX notes_conversation ON notes (conversation_id, created_at);
CREATE INDEX notes_booking ON notes (booking_kind, booking_id);
CREATE UNIQUE INDEX notes_about ON notes (conversation_id) WHERE phase = 'ABOUT';

-- The AI part of a chat's gist: a few short lines (JSON {"en": {...}, "hi": {...}}) made by the 2-minute cron or the Refresh button,
-- from the stored chat text only. It is derived from the chat, so it goes with the chat text (the retention wipe) and with People ->
-- Remove their data. Never in the export, emails or notifications. summary NULL: nothing could be summarised (or the last try failed).
--   last_message_id / message_count: what the chat held when it was made (a newer message makes it due again).
--   held: 1 when some messages were left out for safety (crisis or emergency, a sexual-health concern, a threat or a sexual message).
--   tried_at: the last attempt, made or not (the 10-minute limit counts from it, so a failing chat isn't retried every 2 minutes).
CREATE TABLE gists (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations (id),
  summary TEXT,
  made_at TEXT,
  tried_at TEXT NOT NULL,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0
);
