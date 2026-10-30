-- Adapted from listmonk queries/campaigns.sql (next-campaigns counts and
-- next-campaign-subscribers) at 6fcd95f. ?1 is the campaign's lists as JSON
-- [{"id": …, "optin": "single"|"double"}], ?2 the campaign type. A membership qualifies:
-- opt-in campaigns take `unconfirmed` members of double opt-in lists; regular campaigns
-- take `confirmed` members of double opt-in lists and all but `unsubscribed` members of
-- single opt-in lists. Blocklisted subscribers never qualify.

-- name: campaign-audience
SELECT COUNT(DISTINCT sl.subscriber_id) AS count, COALESCE(MAX(sl.subscriber_id), 0) AS max
FROM json_each(?1) l
JOIN subscriber_lists sl ON sl.list_id = json_extract(l.value, '$.id')
JOIN subscribers s ON s.id = sl.subscriber_id AND s.status != 'blocklisted'
WHERE CASE
  WHEN ?2 = 'optin' THEN sl.status = 'unconfirmed' AND json_extract(l.value, '$.optin') = 'double'
  WHEN json_extract(l.value, '$.optin') = 'double' THEN sl.status = 'confirmed'
  ELSE sl.status != 'unsubscribed'
END;

-- name: campaign-recipient-ids
-- The next ?5 qualifying subscriber IDs above the cursor ?3, up to max_subscriber_id ?4, in
-- ID order. Each is distinct however many of the campaign's lists hold it. CROSS JOIN keeps
-- subscriber_lists as the outer loop, an ID-ordered range scan that stops at the limit.
SELECT DISTINCT sl.subscriber_id AS id
FROM subscriber_lists sl
CROSS JOIN json_each(?1) l ON json_extract(l.value, '$.id') = sl.list_id
CROSS JOIN subscribers s ON s.id = sl.subscriber_id AND s.status != 'blocklisted'
WHERE sl.subscriber_id > ?3 AND sl.subscriber_id <= ?4
  AND CASE
    WHEN ?2 = 'optin' THEN sl.status = 'unconfirmed' AND json_extract(l.value, '$.optin') = 'double'
    WHEN json_extract(l.value, '$.optin') = 'double' THEN sl.status = 'confirmed'
    ELSE sl.status != 'unsubscribed'
  END
ORDER BY sl.subscriber_id
LIMIT ?5;

-- name: campaign-recipient
SELECT id, uuid, email, name, attribs, external_id FROM subscribers
WHERE id = ? AND status != 'blocklisted';
