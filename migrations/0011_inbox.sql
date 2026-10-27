-- Ticket 22: the Inbox (/app/inbox). Who is replying to a handed-over chat, and the one "still waiting" email per handoff.
-- claimed_by / claimed_at: "Assign to me". The claim lapses 30 minutes after claimed_at; a reply by the same member moves claimed_at on.
-- inbox_mail_at: when the team was emailed that this chat has waited 2 working hours; one email per handoff (it is sent again only
-- after a newer human_since). Only adds columns, so turning CONSOLE_V2 off needs no undo.
ALTER TABLE conversations ADD COLUMN claimed_by INTEGER REFERENCES members (id);
ALTER TABLE conversations ADD COLUMN claimed_at TEXT;
ALTER TABLE conversations ADD COLUMN inbox_mail_at TEXT;
