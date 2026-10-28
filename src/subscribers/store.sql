-- Adapted from listmonk queries/subscribers.sql at 6fcd95f.
-- name: subscriber-by-id
SELECT * FROM subscribers WHERE id = ?;
-- name: subscriber-by-external
SELECT * FROM subscribers WHERE external_id = ?;
-- name: subscriber-memberships
SELECT * FROM subscriber_lists WHERE subscriber_id = ? ORDER BY created_at, list_id;
-- name: subscriber-insert
INSERT INTO subscribers (uuid,email,name,status,attribs,external_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id;
-- name: subscriber-update
UPDATE subscribers SET email=?, name=?, status=?, attribs=?, external_id=?, updated_at=? WHERE id=?;
-- name: subscriber-delete
DELETE FROM subscribers WHERE id=?;
-- name: membership-insert
INSERT INTO subscriber_lists (subscriber_id,list_id,status,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT (subscriber_id,list_id) DO NOTHING;
-- name: membership-status
UPDATE subscriber_lists SET status=? WHERE subscriber_id=? AND list_id=?;
-- name: membership-update
UPDATE subscriber_lists SET status=?, updated_at=? WHERE subscriber_id=? AND list_id=?;
-- name: membership-delete
DELETE FROM subscriber_lists WHERE subscriber_id=? AND list_id=?;
-- name: subscriber-blocklist
UPDATE subscribers SET status='blocklisted',updated_at=? WHERE id=?;
-- name: membership-blocklist
UPDATE subscriber_lists SET status='unsubscribed',updated_at=? WHERE subscriber_id=?;
