-- Ticket 48: the service catalogue the owner edits in /app Settings → Services (src/catalogue.ts), and which service each booking was for.
-- Nothing a customer sees changes: the catalogue is seeded with exactly today's offer, and the bot still offers only those two rows.

-- One row per bookable offer. key: a stable id (never changes). pathway: ENTRY (the first call) | RELEASE | UNDERSTAND | REWIRE.
-- minutes: 15, 30, 60 or 90 only. price_paise: whole rupees, ₹1 to ₹1,00,000 (the rule of src/business.ts validPrice).
-- needs_call_first: only for someone who has had the first call. daily_cap: at most this many a day (NULL: no cap of its own; the
-- 5-sessions-a-day cap counts sessions anyway). active: can be booked. public: offered by the bot; only the two seeded rows are, until a
-- later ticket and the owner's go-ahead. sort: the order in the list. updated_by: the member who last changed it (NULL: the seed).
CREATE TABLE services (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 40),
  name_en TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 60),
  name_hi TEXT NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 60),
  pathway TEXT NOT NULL CHECK (pathway IN ('ENTRY', 'RELEASE', 'UNDERSTAND', 'REWIRE')),
  minutes INTEGER NOT NULL CHECK (minutes IN (15, 30, 60, 90)),
  price_paise INTEGER NOT NULL CHECK (price_paise BETWEEN 100 AND 10000000 AND price_paise % 100 = 0),
  needs_call_first INTEGER NOT NULL DEFAULT 0 CHECK (needs_call_first IN (0, 1)),
  daily_cap INTEGER CHECK (daily_cap IS NULL OR daily_cap BETWEEN 1 AND 20),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by INTEGER REFERENCES members (id)
);

-- Today's offer, with config's prices and lengths (config.prices, config.slots) and the names Settings already used.
INSERT INTO services (key, name_en, name_hi, pathway, minutes, price_paise, needs_call_first, daily_cap, active, public, sort) VALUES
  ('first_call', 'First call', 'पहली कॉल', 'ENTRY', 15, 9900, 0, NULL, 1, 1, 10),
  ('single_session', 'Single session', 'एक सेशन', 'RELEASE', 60, 79900, 0, NULL, 1, 1, 20);

-- The owner's prices from Settings (ticket 24) carry over, when they are valid whole rupees (the rule readPrices used).
UPDATE services SET price_paise = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'price.intro_paise')
  WHERE key = 'first_call' AND EXISTS (SELECT 1 FROM settings WHERE key = 'price.intro_paise' AND value != '' AND value NOT GLOB '*[^0-9]*'
    AND CAST(value AS INTEGER) BETWEEN 100 AND 10000000 AND CAST(value AS INTEGER) % 100 = 0);
UPDATE services SET price_paise = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'price.single_paise')
  WHERE key = 'single_session' AND EXISTS (SELECT 1 FROM settings WHERE key = 'price.single_paise' AND value != '' AND value NOT GLOB '*[^0-9]*'
    AND CAST(value AS INTEGER) BETWEEN 100 AND 10000000 AND CAST(value AS INTEGER) % 100 = 0);

-- Which service each booking (and each calendar slot) was for. Back-filled from the kind: every call is the first call, every session the
-- single session. NULL is read the same way (src/catalogue.ts SLOT_SERVICE_SQL).
ALTER TABLE slots ADD COLUMN service_key TEXT REFERENCES services (key);
ALTER TABLE intros ADD COLUMN service_key TEXT REFERENCES services (key);
ALTER TABLE sessions ADD COLUMN service_key TEXT REFERENCES services (key);
UPDATE slots SET service_key = CASE kind WHEN 'CALL' THEN 'first_call' ELSE 'single_session' END WHERE service_key IS NULL;
UPDATE intros SET service_key = 'first_call' WHERE service_key IS NULL;
UPDATE sessions SET service_key = 'single_session' WHERE service_key IS NULL;
