-- D25: deleting a subscriber also anonymizes retained sends addressed to them without a
-- subscriber link (external or unknown-at-send transactional recipients). Subscriber emails
-- are case-insensitive, so the lookup is too. Linked rows use idx_sends_cap.
CREATE INDEX idx_sends_unlinked_to ON sends(to_email COLLATE NOCASE) WHERE subscriber_id IS NULL;
