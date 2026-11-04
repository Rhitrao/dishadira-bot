-- Ticket 41 (owner's decision, 4 Nov 2026): after a paid ₹99 call, three short skippable questions (src/intent.ts).
--   intros.profession: their work, as they typed it (short); intros.help_area: what they would like help with, a code
--     (STRESS | SLEEP | RELATIONSHIPS | WORK | ENERGY | PHYSICAL | OTHER). "Something else" words are never stored here: they stay in the chat
--     and are wiped with it. Both are cleared with the name, config.retention.nameDaysAfterLastBooking after the last booking (src/wipe.ts).
--   conversations.name_given_at: when the person typed the name Shantha Rao should use; from then on their WhatsApp profile name no longer
--     replaces it. Cleared with the name.
ALTER TABLE intros ADD COLUMN profession TEXT;
ALTER TABLE intros ADD COLUMN help_area TEXT;
ALTER TABLE conversations ADD COLUMN name_given_at TEXT;
