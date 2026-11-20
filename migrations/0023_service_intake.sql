-- Ticket 49 (CONTRACT v19): the bot may offer catalogue services (behind the NEW_SERVICES env flag), each with its own question after
-- payment and, for some, two yes/no questions before a time is held (src/offer.ts). The owner edits all three in /app Settings → Services.

-- intake_en / intake_hi: one free-text question the bot asks after a paid booking of this service ("What question would you like to bring to
-- your reading?"), in English and Hindi. NULL or empty: no question. Up to 300 characters.
-- screen: 1 = before the hold, two yes/no questions (a mental-health condition under treatment now; seizures or epilepsy ever). Any "yes":
-- no booking, a kind fixed reply recommending the ₹99 call first. The answers are never stored (only an audited outcome code, SCREENED_TO_CALL).
ALTER TABLE services ADD COLUMN intake_en TEXT CHECK (intake_en IS NULL OR length(intake_en) <= 300);
ALTER TABLE services ADD COLUMN intake_hi TEXT CHECK (intake_hi IS NULL OR length(intake_hi) <= 300);
ALTER TABLE services ADD COLUMN screen INTEGER NOT NULL DEFAULT 0 CHECK (screen IN (0, 1));

-- The answer to that question, as typed (up to config.offer.intakeMaxChars). Shown on the Today card and the person page to the owner and the
-- session's practitioner only; wiped with the name (config.retention.nameDaysAfterLastBooking) and by People → Remove their data.
ALTER TABLE sessions ADD COLUMN intake_answer TEXT;
