-- Ticket 49: the 14-day CARD test (src/cardtest.ts). A person who sends CARD gets three cards for one theme a day. One row per person and
-- day (IST date, "2026-11-24"), so a second CARD the same day returns the same draw. theme: WORK | RELATIONSHIPS | ENERGY. c1..c3: the three
-- cards (0-21, the Major Arcana, all different). Never a name or number. Deleted 90 days after the draw and by People → Remove their data.
CREATE TABLE card_draws (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  day TEXT NOT NULL CHECK (length(day) = 10),
  theme TEXT NOT NULL CHECK (theme IN ('WORK', 'RELATIONSHIPS', 'ENERGY')),
  c1 INTEGER NOT NULL CHECK (c1 BETWEEN 0 AND 21),
  c2 INTEGER NOT NULL CHECK (c2 BETWEEN 0 AND 21),
  c3 INTEGER NOT NULL CHECK (c3 BETWEEN 0 AND 21),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, day),
  CHECK (c1 <> c2 AND c1 <> c3 AND c2 <> c3)
);
CREATE INDEX card_draws_created ON card_draws (created_at);
