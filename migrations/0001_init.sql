-- Disha Dira v1 schema. Times are UTC ISO strings (YYYY-MM-DDTHH:MM:SSZ); money is paise.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  mode TEXT NOT NULL DEFAULT 'BOT' CHECK (mode IN ('BOT', 'HUMAN', 'BLOCKED')),
  last_user_at TEXT,
  source_ad_id TEXT,
  consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED')),
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  processed_at TEXT,
  UNIQUE (provider, event_key)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  wa_message_id TEXT UNIQUE,
  dedupe_key TEXT UNIQUE,
  kind TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);

-- A row is a claim on Amma's single calendar. Rows exist only once someone holds or books a slot.
-- Active = BOOKED, or HELD with hold_until in the future. Expired holds are simply ignored (no cron).
CREATE TABLE slots (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('CALL', 'SESSION')),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES conversations (id),
  state TEXT NOT NULL CHECK (state IN ('HELD', 'BOOKED')),
  hold_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (kind, start_utc),
  CHECK (end_utc > start_utc)
);
CREATE INDEX slots_owner ON slots (owner_id);
CREATE INDEX slots_time ON slots (start_utc, end_utc);

CREATE TABLE intros (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  slot_id INTEGER REFERENCES slots (id),
  service TEXT NOT NULL CHECK (service IN ('PROTECTION', 'HEALING')),
  state TEXT NOT NULL DEFAULT 'HELD' CHECK (state IN (
    'HELD', 'PAID', 'CALLED_SESSION', 'CALLED_NOT_FIT', 'MISSED', 'RUDE',
    'EXPIRED', 'RESCHEDULED', 'CANCELLED_BY_US')),
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
CREATE INDEX intros_conversation ON intros (conversation_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  intro_id INTEGER REFERENCES intros (id),
  slot_id INTEGER REFERENCES slots (id),
  service TEXT NOT NULL CHECK (service IN ('PROTECTION', 'HEALING')),
  state TEXT NOT NULL DEFAULT 'OFFERED' CHECK (state IN (
    'OFFERED', 'HELD', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'EXPIRED', 'CANCELLED')),
  override_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
CREATE INDEX sessions_conversation ON sessions (conversation_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('INTRO', 'SESSION')),
  target_id INTEGER NOT NULL,
  provider_order_id TEXT UNIQUE,
  provider_link_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  state TEXT NOT NULL DEFAULT 'CREATING' CHECK (state IN (
    'CREATING', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN',
    'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
CREATE INDEX payments_target ON payments (purpose, target_id);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'REFUNDED', 'FAILED')),
  provider_refund_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  wa_id TEXT,
  upi_handle TEXT,
  payer_ref TEXT,
  reason TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (wa_id IS NOT NULL OR upi_handle IS NOT NULL OR payer_ref IS NOT NULL)
);
CREATE INDEX blocks_wa ON blocks (wa_id);
CREATE INDEX blocks_upi ON blocks (upi_handle);
CREATE INDEX blocks_payer ON blocks (payer_ref);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  intro_id INTEGER NOT NULL REFERENCES intros (id),
  value TEXT NOT NULL CHECK (value IN ('SESSION', 'NOT_FIT', 'MISSED', 'RUDE')),
  tapped_at TEXT NOT NULL,
  undo_until TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX outcomes_intro ON outcomes (intro_id);

CREATE TABLE attention (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at TEXT
);
CREATE INDEX attention_open ON attention (resolved_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
