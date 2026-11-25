-- Ticket 60: logging in to the tarot game (in the Android app, or on the website from anywhere) by sending a code on WhatsApp.
-- The app (or page) asks for a code: 8 letters and digits, shown and pre-typed as "TAROT ABCD2345" in a WhatsApp message, plus a private
-- secret only that device knows (only its SHA-256 kept). When the person sends the message, the bot ties the code to their chat; the device,
-- polling with the secret, then gets its session. A code lives 10 minutes and logs in once.
CREATE TABLE tarot_codes (
  code TEXT PRIMARY KEY CHECK (length(code) = 8),
  secret_hash TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  linked_at TEXT,
  used_at TEXT
);
CREATE INDEX tarot_codes_expires ON tarot_codes (expires_at);
