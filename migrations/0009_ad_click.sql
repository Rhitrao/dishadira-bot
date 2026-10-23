-- Ticket 15: which Click-to-WhatsApp ad a person came from, saved on their first message that carries a referral.
-- source_ad_id (ticket 03) already holds the ad id; this adds Meta's click id (needed later to report conversions per ad) and the ad headline,
-- so /admin can show a readable ad name. Both are the business's own ad data, never the customer's words.
ALTER TABLE conversations ADD COLUMN ad_click_id TEXT;
ALTER TABLE conversations ADD COLUMN ad_headline TEXT;
