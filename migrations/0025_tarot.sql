-- Ticket 57: the tarot game at /tarot (src/tarot/). A person opens it from the bot's "Open your cards" button: the link carries a one-time
-- login token (only its SHA-256 hash is kept; 15 minutes, used once), swapped for a session cookie (only its hash is kept; 90 days).
-- tarot_readings: one row per person, IST day and kind ('daily' = the daily card, 'ppf' = the free past-present-future spread). While open,
-- `deck` holds the cut deck (JSON) the fan is drawn from; once picked, `cards` holds the drawn cards (JSON [{"id","r"}]) and `deck` is cleared.
-- `note` is the person's own words, if they add any. tarot_seen: the cards a person has drawn at least once (their collection).
-- All of it goes with People → Remove their data, and 90 days after a person's last reading.
CREATE TABLE tarot_logins (
  token_hash TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tarot_sessions (
  id_hash TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tarot_sessions_conv ON tarot_sessions (conversation_id);
CREATE TABLE tarot_readings (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  day TEXT NOT NULL CHECK (length(day) = 10),
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'ppf')),
  theme TEXT CHECK (theme IS NULL OR theme IN ('love', 'work', 'self')),
  question TEXT,
  deck TEXT,
  cards TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (conversation_id, day, kind)
);
CREATE INDEX tarot_readings_done ON tarot_readings (conversation_id, done_at);
CREATE TABLE tarot_seen (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  card_id TEXT NOT NULL,
  first_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, card_id)
);
