-- Ticket 61: the tarot game's home screen and its first pricing rules.
-- tarot_messages: "Today's message" for each theme: one card drawn per person, IST day and theme (the same fair shuffle as a reading), free.
-- tarot_free: the themes in which a person has used their one free reading. Kept apart from the readings, so "Delete my history" does not
--   hand out the free readings again; removed with "Delete my account", People → Remove their data, and 90 days after the last reading.
-- tarot_passes: a period of unlimited theme readings (bought later through Razorpay, Google Play or Apple, or given by the team). Nothing in
--   this ticket sells one.
-- tarot_pin_tries: failed tester-PIN logins (test only), to stop guessing: five in 15 minutes per number.
-- tarot_profiles.email: an optional email the person gives with their details.
CREATE TABLE tarot_messages (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  day TEXT NOT NULL CHECK (length(day) = 10),
  theme TEXT NOT NULL CHECK (theme IN ('love', 'work', 'self')),
  card_id TEXT NOT NULL,
  reversed INTEGER NOT NULL CHECK (reversed IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, day, theme)
);
CREATE TABLE tarot_free (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  theme TEXT NOT NULL CHECK (theme IN ('love', 'work', 'self')),
  used_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, theme)
);
CREATE TABLE tarot_passes (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  plan TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('razorpay', 'play', 'apple', 'gift')),
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX tarot_passes_conv ON tarot_passes (conversation_id, ends_at);
CREATE TABLE tarot_pin_tries (
  phone TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX tarot_pin_tries_phone ON tarot_pin_tries (phone, at);
ALTER TABLE tarot_profiles ADD COLUMN email TEXT CHECK (email IS NULL OR length(email) <= 120);
