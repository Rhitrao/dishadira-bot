-- Ticket 11: English + Hindi, and the clear booking flow.
-- Kannada is gone: its conversations continue in English.
UPDATE conversations SET locale = 'en' WHERE locale = 'kn';

-- Asked once per person (the 18+ check); and the id of a first message that was a real question, answered after the language tap.
ALTER TABLE conversations ADD COLUMN age_ok_at TEXT;
ALTER TABLE conversations ADD COLUMN first_question_msg TEXT;

-- Who the call is for, and the language Amma should speak (the chat language at booking time). Shown on Amma's page.
ALTER TABLE intros ADD COLUMN for_whom TEXT CHECK (for_whom IN ('SELF', 'FAMILY', 'PET'));
ALTER TABLE intros ADD COLUMN call_lang TEXT CHECK (call_lang IN ('en', 'hi'));
