-- Ticket 52 (CONTRACT v20): the Karmic Coaching front door, behind the KARMIC_FRONT_DOOR env flag (src/frontdoor.ts). The bot asks what
-- the person would like help with, from five fixed topics, and recommends the ₹99 Karmic Clarity Call first. The chosen topic is kept
-- on the booking it led to, so the owner and the practitioner see "Came for: Relationships & family" on Today, the calendar's day view
-- and the person page.

-- A topic is one of five fixed keys, never free text, and not health data. It is wiped with the customer's name (90 days after the last
-- booking, and People → Remove their data); the chat wipe leaves it, because it lives on the booking, not in the chat.
ALTER TABLE intros ADD COLUMN topic TEXT CHECK (topic IS NULL OR topic IN ('RELATIONSHIPS', 'HEAVY', 'DECISION', 'HABIT', 'NOT_SURE'));
ALTER TABLE sessions ADD COLUMN topic TEXT CHECK (topic IS NULL OR topic IN ('RELATIONSHIPS', 'HEAVY', 'DECISION', 'HABIT', 'NOT_SURE'));

-- The topic tapped most recently, and when: a booking started within config.frontDoor.topicHours of the tap takes it. Wiped with the name.
ALTER TABLE conversations ADD COLUMN topic_pick TEXT CHECK (topic_pick IS NULL OR topic_pick IN ('RELATIONSHIPS', 'HEAVY', 'DECISION', 'HABIT', 'NOT_SURE'));
ALTER TABLE conversations ADD COLUMN topic_pick_at TEXT;
