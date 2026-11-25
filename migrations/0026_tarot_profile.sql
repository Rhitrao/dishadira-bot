-- Ticket 58: the tarot game's profile, spreads per theme, the person's own question, and unlimited turns for testers.
-- tarot_profiles: what a person tells us the first time they log in (name as at birth, date of birth, optional birth time with its UTC
-- offset, optional birth place). Used only to personalise their readings (src/tarot/profile.ts); deleted with "Delete my details", People →
-- Remove their data, and 90 days after their last visit.
-- tarot_readings is rebuilt: `kind` is now 'daily' or 'spread' with the spread's id in `spread`; `custom` = 1 when the person typed the
-- question; `n` counts readings of one kind on one day (always 1, except for the numbers in the TAROT_TESTERS secret). Rows are copied over.
CREATE TABLE tarot_profiles (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  dob TEXT NOT NULL CHECK (length(dob) = 10),
  birth_time TEXT CHECK (birth_time IS NULL OR length(birth_time) = 5),
  tz_minutes INTEGER NOT NULL DEFAULT 330 CHECK (tz_minutes BETWEEN -720 AND 840),
  birth_place TEXT CHECK (birth_place IS NULL OR length(birth_place) <= 80),
  consent_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tarot_readings_new (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  day TEXT NOT NULL CHECK (length(day) = 10),
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'spread')),
  n INTEGER NOT NULL DEFAULT 1 CHECK (n >= 1),
  spread TEXT NOT NULL,
  theme TEXT CHECK (theme IS NULL OR theme IN ('love', 'work', 'self')),
  question TEXT CHECK (question IS NULL OR length(question) <= 300),
  custom INTEGER NOT NULL DEFAULT 0 CHECK (custom IN (0, 1)),
  deck TEXT,
  cards TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (conversation_id, day, kind, n)
);
INSERT INTO tarot_readings_new (id, conversation_id, day, kind, n, spread, theme, question, custom, deck, cards, note, created_at, done_at)
  SELECT id, conversation_id, day, CASE kind WHEN 'daily' THEN 'daily' ELSE 'spread' END, 1, kind, theme, question, 0, deck, cards, note, created_at, done_at
  FROM tarot_readings;
DROP TABLE tarot_readings;
ALTER TABLE tarot_readings_new RENAME TO tarot_readings;
CREATE INDEX tarot_readings_done ON tarot_readings (conversation_id, done_at);
