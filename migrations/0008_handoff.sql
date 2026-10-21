-- Ticket 14: handoff fixes found in testing.
-- human_since: when a chat last went from BOT to HUMAN (a "Talk to a person" tap, a crisis message, or the assistant handing over).
-- The 2-minute cron returns a HUMAN chat to BOT 24 hours after that if Rohit has not replied from /admin (docs/AGENT.md section 3.2 step 6).
-- human_mail_at: when Rohit was last emailed about this person's request for a human (at most one email per person per 6 hours).
ALTER TABLE conversations ADD COLUMN human_since TEXT;
ALTER TABLE person_state ADD COLUMN human_mail_at TEXT;

-- Chats that are HUMAN today get 24 hours from now, not an instant return.
UPDATE conversations SET human_since = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE mode = 'HUMAN';
