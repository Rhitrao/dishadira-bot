-- Ticket 19: workspaces, members with one role each, invites, the "ask owner" requests queue, and who a booking is with.
-- The members themselves are not seeded here (their emails are secrets): the first /app request does it once (src/auth.ts).
-- Everything here is added to; no existing column or row changes meaning, so turning CONSOLE_V2 off needs no undo.

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'))
);
-- Today's data is workspace 1. The owner renames it in Settings (ticket 24).
INSERT INTO workspaces (id, name, slug, time_zone, status) VALUES (1, 'My business', 'main', 'Asia/Kolkata', 'active');

-- One row per person per workspace, with exactly one role. A removed member keeps the row (the audit log points to it).
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'PRACTITIONER', 'STAFF')),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'hi')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'removed')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (workspace_id, email)
);
-- At most one owner per workspace (the code makes it at least one: the owner can't be removed or demoted, only hand over).
CREATE UNIQUE INDEX members_one_owner ON members (workspace_id) WHERE role = 'OWNER' AND status != 'removed';

-- A one-time link sent by email. Only the SHA-256 of the token is stored. used_at is set when it is accepted or replaced by a newer invite.
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('PRACTITIONER', 'STAFF')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  invited_by INTEGER NOT NULL REFERENCES members (id),
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX invites_email ON invites (workspace_id, email);

-- "Ask owner": staff ask, the owner approves or declines on Today (ticket 21). Nothing happens until then.
CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  kind TEXT NOT NULL CHECK (kind IN ('REFUND', 'MARK_PAID', 'BLOCK')),
  target TEXT NOT NULL,
  amount_paise INTEGER,
  asked_by INTEGER NOT NULL REFERENCES members (id),
  decided_by INTEGER REFERENCES members (id),
  decision TEXT CHECK (decision IN ('APPROVED', 'DECLINED')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  decided_at TEXT
);
CREATE INDEX requests_open ON requests (workspace_id, decided_at);

-- Who a call or session is with. Phase 1 has one practitioner: existing rows get them in the one-time seed, and every new row is
-- written with the workspace's first active practitioner (PRACTITIONER_SQL in src/slots.ts) until booking picks one itself (Phase 2).
ALTER TABLE slots ADD COLUMN practitioner_id INTEGER REFERENCES members (id);
ALTER TABLE intros ADD COLUMN practitioner_id INTEGER REFERENCES members (id);
ALTER TABLE sessions ADD COLUMN practitioner_id INTEGER REFERENCES members (id);

-- The actor becomes a member. Old rows keep their raw email in actor and show as "before roles" (member_id NULL).
ALTER TABLE audit_log ADD COLUMN workspace_id INTEGER REFERENCES workspaces (id);
ALTER TABLE audit_log ADD COLUMN member_id INTEGER REFERENCES members (id);
ALTER TABLE audit_log ADD COLUMN reason TEXT;
