-- Ticket 06: outcomes per call slot (a rescheduled call gets its own outcome), payer reference, refund retry state.

ALTER TABLE payments ADD COLUMN payer_ref TEXT;
CREATE INDEX payments_payer ON payments (payer_ref);

ALTER TABLE outcomes ADD COLUMN slot_id INTEGER;
CREATE UNIQUE INDEX outcomes_intro_slot ON outcomes (intro_id, slot_id);

-- refunds gains PENDING_APPROVAL (rude reports wait for Rohit) and attempt_at (lease for the retry cron).
-- SQLite cannot change a CHECK, so the table is rebuilt; nothing references it.
CREATE TABLE refunds_new (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING_APPROVAL', 'PENDING', 'REFUNDED', 'FAILED')),
  provider_refund_id TEXT UNIQUE,
  attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
INSERT INTO refunds_new (id, payment_id, reason, requested_by, state, provider_refund_id, created_at, updated_at)
  SELECT id, payment_id, reason, requested_by, state, provider_refund_id, created_at, updated_at FROM refunds;
DROP TABLE refunds;
ALTER TABLE refunds_new RENAME TO refunds;
CREATE INDEX refunds_reason ON refunds (reason, created_at);
