-- Ticket 38: the team can view a photo or file a customer sent, on demand (owner decision, 4 Nov 2026). Nothing of the file is stored:
-- only Meta's media id and the type Meta gave, for an incoming image, document, video, sticker or voice note / audio (src/media.ts).
-- Viewing asks Meta for a short-lived link with the id and streams the file to the browser; never kept in D1, KV or R2.
--   media_id: Meta's id for the file (not the file, not a link); media_mime: e.g. image/jpeg
-- Both are wiped with the message text (src/wipe.ts: CHAT_RETENTION_MINUTES after their last message, and People -> Remove their data).
ALTER TABLE messages ADD COLUMN media_id TEXT;
ALTER TABLE messages ADD COLUMN media_mime TEXT;
