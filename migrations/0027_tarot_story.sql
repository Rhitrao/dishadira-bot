-- Ticket 59: the plain-words explanation of a finished reading ("What this means for you"), written once by the assistant from the card
-- library and the person's question, then kept so it reads (and sounds) the same every time. NULL until it is first asked for, and when the
-- assistant is off (the page then shows the plain rule-based explanation, which is not stored).
ALTER TABLE tarot_readings ADD COLUMN story TEXT CHECK (story IS NULL OR length(story) <= 2000);
