-- Ticket 13: sessions bought from the menu, packages, and the credits ledger.
-- SQLite cannot change a CHECK, so the tables whose CHECK grows are rebuilt (copying every row, keeping every id).
-- refunds points at payments, so it is moved out of the way first and put back after payments is rebuilt.

-- 1. refunds: out of the way (kept as a plain copy), and back later with amount_paise (NULL = the whole payment).
CREATE TABLE refunds_old AS SELECT * FROM refunds;
DROP TABLE refunds;

-- 2. payments: purpose may now be PACKAGE (target_id is then the packages.id).
CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('INTRO', 'SESSION', 'PACKAGE')),
  target_id INTEGER NOT NULL,
  provider_order_id TEXT UNIQUE,
  provider_link_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  state TEXT NOT NULL DEFAULT 'CREATING' CHECK (state IN (
    'CREATING', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN',
    'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT,
  payer_ref TEXT,
  paid_paise INTEGER
);
INSERT INTO payments_new (id, provider, purpose, target_id, provider_order_id, provider_link_id, provider_payment_id, amount_paise, state, created_at, updated_at, payer_ref, paid_paise)
  SELECT id, provider, purpose, target_id, provider_order_id, provider_link_id, provider_payment_id, amount_paise, state, created_at, updated_at, payer_ref, paid_paise FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX payments_target ON payments (purpose, target_id);
CREATE INDEX payments_payer ON payments (payer_ref);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING_APPROVAL', 'PENDING', 'REFUNDED', 'FAILED', 'DECLINED')),
  provider_refund_id TEXT UNIQUE,
  attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT,
  amount_paise INTEGER
);
INSERT INTO refunds (id, payment_id, reason, requested_by, state, provider_refund_id, attempt_at, created_at, updated_at)
  SELECT id, payment_id, reason, requested_by, state, provider_refund_id, attempt_at, created_at, updated_at FROM refunds_old;
DROP TABLE refunds_old;
CREATE INDEX refunds_reason ON refunds (reason, created_at);

-- 3. sessions: new states CREDIT_BOOKED (booked from package credits) and NOT_FIT (Amma's outcome on a first session), and where it came from.
-- origin: AMMA = offered after the 99 call; SELF = bought from the menu (single session, paid per session); CREDIT = booked from a package.
-- moves: how many times the customer moved it (a single session moves once).
CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  intro_id INTEGER REFERENCES intros (id),
  slot_id INTEGER REFERENCES slots (id),
  service TEXT NOT NULL CHECK (service IN ('PROTECTION', 'HEALING')),
  state TEXT NOT NULL DEFAULT 'OFFERED' CHECK (state IN (
    'OFFERED', 'HELD', 'CONFIRMED', 'CREDIT_BOOKED', 'COMPLETED', 'NO_SHOW', 'EXPIRED', 'CANCELLED', 'NOT_FIT')),
  override_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT,
  for_whom TEXT CHECK (for_whom IN ('SELF', 'FAMILY', 'PET')),
  call_lang TEXT CHECK (call_lang IN ('en', 'hi')),
  origin TEXT NOT NULL DEFAULT 'AMMA' CHECK (origin IN ('AMMA', 'SELF', 'CREDIT')),
  package_id INTEGER,
  moves INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions_new (id, conversation_id, intro_id, slot_id, service, state, override_by, created_at, updated_at)
  SELECT id, conversation_id, intro_id, slot_id, service, state, override_by, created_at, updated_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_conversation ON sessions (conversation_id);
CREATE INDEX sessions_slot ON sessions (slot_id);

-- 4. outcomes: Amma can also answer "not right fit" on a session that was a buyer's very first (no 99 call before it).
CREATE TABLE outcomes_new (
  id INTEGER PRIMARY KEY,
  intro_id INTEGER REFERENCES intros (id),
  value TEXT NOT NULL CHECK (value IN ('SESSION', 'NOT_FIT', 'MISSED', 'RUDE')),
  tapped_at TEXT NOT NULL,
  undo_until TEXT NOT NULL,
  applied_at TEXT,
  slot_id INTEGER,
  session_id INTEGER,
  CHECK (intro_id IS NOT NULL OR session_id IS NOT NULL)
);
INSERT INTO outcomes_new (id, intro_id, value, tapped_at, undo_until, applied_at, slot_id)
  SELECT id, intro_id, value, tapped_at, undo_until, applied_at, slot_id FROM outcomes;
DROP TABLE outcomes;
ALTER TABLE outcomes_new RENAME TO outcomes;
CREATE INDEX outcomes_intro ON outcomes (intro_id);
CREATE UNIQUE INDEX outcomes_intro_slot ON outcomes (intro_id, slot_id);
CREATE UNIQUE INDEX outcomes_session ON outcomes (session_id) WHERE session_id IS NOT NULL;

-- 5. packages and the credits ledger. A balance is always the SUM of credits.delta, never stored.
-- packages.state: CREATING -> PENDING -> PAID (credits added) -> CLOSED (refunded); EXPIRED/FAILED when the link was never paid.
CREATE TABLE packages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  size INTEGER NOT NULL CHECK (size > 0),
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  payment_id INTEGER REFERENCES payments (id),
  state TEXT NOT NULL DEFAULT 'CREATING' CHECK (state IN ('CREATING', 'PENDING', 'PAID', 'CLOSED', 'EXPIRED', 'FAILED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
CREATE INDEX packages_conversation ON packages (conversation_id);

CREATE TABLE credits (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages (id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('PURCHASE', 'BOOK', 'CANCEL_RETURN', 'REFUND', 'ADJUST')),
  session_id INTEGER REFERENCES sessions (id),
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE INDEX credits_package ON credits (package_id);
-- A replay can never add the purchase twice, use two credits for one session, or return one credit twice.
CREATE UNIQUE INDEX credits_purchase ON credits (package_id) WHERE reason = 'PURCHASE';
CREATE UNIQUE INDEX credits_book ON credits (session_id) WHERE reason = 'BOOK';
CREATE UNIQUE INDEX credits_return ON credits (session_id) WHERE reason = 'CANCEL_RETURN';
