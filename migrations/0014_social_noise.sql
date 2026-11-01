-- Ticket 34: insults, threats and sexual messages on Instagram and Messenger, counted as on WhatsApp (config.noise, src/social.ts).
-- Counts and times only; never message text.
--   offences: how many insulting, threatening or sexual messages (or comments) they sent; the second one blocks
--   blocked_at: a block word (config.noise.abuseBlockWords / sexualBlockWords) or a second offence: no more automatic replies on this
--     channel, DMs or comments (safety messages and "delete my data" excepted)
ALTER TABLE social_contacts ADD COLUMN offences INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_contacts ADD COLUMN blocked_at TEXT;
