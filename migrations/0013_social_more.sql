-- PR #52 (Ticket 32 follow-up): what the Instagram/Messenger replies need to greet a returning person and to see a booking that started
-- there (src/social.ts). Ids, codes and times only; never message text, names or usernames.
--   followed_at: when the follow was confirmed (Instagram said yes, or "I've followed" on Messenger): a returning follower isn't asked again
--   ref_code: a short random code put in the WhatsApp text we prefill, "(ref: IGK7Q2M)"; the WhatsApp bot takes it out of the message
--   wa_conversation_id: the WhatsApp chat that started with that code, so a booking from Instagram or Messenger can be counted
--   stopped_at: they said "stop" or "not interested": no more automated messages (safety excepted) until the flow restarts after 30 days
--   said_booked_at: they said they have booked or paid: no more follow ask or ₹99 call, only the way to WhatsApp
ALTER TABLE social_contacts ADD COLUMN followed_at TEXT;
ALTER TABLE social_contacts ADD COLUMN ref_code TEXT;
ALTER TABLE social_contacts ADD COLUMN wa_conversation_id INTEGER;
ALTER TABLE social_contacts ADD COLUMN stopped_at TEXT;
ALTER TABLE social_contacts ADD COLUMN said_booked_at TEXT;
CREATE INDEX social_contacts_ref ON social_contacts (ref_code);
