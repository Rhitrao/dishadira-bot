-- Ticket 08: remember what was actually paid on a mismatch, and keep a declined refund as a row (DECLINED) instead of deleting it.

ALTER TABLE payments ADD COLUMN paid_paise INTEGER;

CREATE TABLE refunds_new (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING_APPROVAL', 'PENDING', 'REFUNDED', 'FAILED', 'DECLINED')),
  provider_refund_id TEXT UNIQUE,
  attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);
INSERT INTO refunds_new (id, payment_id, reason, requested_by, state, provider_refund_id, attempt_at, created_at, updated_at)
  SELECT id, payment_id, reason, requested_by, state, provider_refund_id, attempt_at, created_at, updated_at FROM refunds;
DROP TABLE refunds;
ALTER TABLE refunds_new RENAME TO refunds;
CREATE INDEX refunds_reason ON refunds (reason, created_at);
