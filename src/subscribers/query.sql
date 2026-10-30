-- Adapted from listmonk queries/subscribers.sql at 6fcd95f: the *-by-query actions. Each ? JSON array is one bounded batch of IDs.
-- name: emails-by-ids
SELECT id, email FROM subscribers WHERE id IN (SELECT value FROM json_each(?));
-- name: delete-by-ids
DELETE FROM subscribers WHERE id IN (SELECT value FROM json_each(?));
-- name: blocklist-by-ids
UPDATE subscribers SET status='blocklisted', updated_at=? WHERE id IN (SELECT value FROM json_each(?));
-- name: blocklist-memberships-by-ids
UPDATE subscriber_lists SET status='unsubscribed', updated_at=? WHERE subscriber_id IN (SELECT value FROM json_each(?));
-- name: add-memberships-by-ids
INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
    SELECT s.value, l.value, ?, ?, ? FROM json_each(?) s, json_each(?) l WHERE true
    ON CONFLICT (subscriber_id, list_id) DO NOTHING;
-- name: unsubscribed-memberships-by-ids
SELECT subscriber_id, list_id FROM subscriber_lists WHERE status = 'unsubscribed'
    AND subscriber_id IN (SELECT value FROM json_each(?)) AND list_id IN (SELECT value FROM json_each(?));
-- name: delete-memberships-by-ids
DELETE FROM subscriber_lists WHERE subscriber_id IN (SELECT value FROM json_each(?))
    AND list_id IN (SELECT value FROM json_each(?));
-- name: unsubscribe-memberships-by-ids
UPDATE subscriber_lists SET status='unsubscribed', updated_at=?
    WHERE subscriber_id IN (SELECT value FROM json_each(?)) AND list_id IN (SELECT value FROM json_each(?));
