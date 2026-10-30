-- Adapted from listmonk queries/subscribers.sql at 6fcd95f.
-- name: subscriber-by-id
SELECT * FROM subscribers WHERE id = ?;
-- name: subscriber-by-external
SELECT * FROM subscribers WHERE external_id = ?;
-- name: subscriber-by-email
SELECT * FROM subscribers WHERE email = ?;
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
-- name: subscriber-by-uuid
SELECT * FROM subscribers WHERE uuid = ?;
-- name: webhook-unsubscribed
-- Webhook data as one JSON array, read before the write. ?2 null means every list.
SELECT json_group_array(json_object(
    'subscriber', json_object('id', s.id, 'uuid', s.uuid, 'email', s.email, 'external_id', s.external_id),
    'list_ids', json(m.list_ids))) AS data
  FROM (SELECT subscriber_id, json_group_array(list_id) AS list_ids FROM subscriber_lists
      WHERE status != 'unsubscribed' AND subscriber_id IN (SELECT value FROM json_each(?1))
        AND (?2 IS NULL OR list_id IN (SELECT value FROM json_each(?2)))
      GROUP BY subscriber_id) m
  JOIN subscribers s ON s.id = m.subscriber_id;
-- name: webhook-blocklisted
SELECT json_group_array(json_object(
    'subscriber', json_object('id', s.id, 'uuid', s.uuid, 'email', s.email, 'external_id', s.external_id),
    'list_ids', (SELECT json_group_array(list_id) FROM subscriber_lists WHERE subscriber_id = s.id))) AS data
  FROM subscribers s WHERE s.status != 'blocklisted' AND s.id IN (SELECT value FROM json_each(?));
-- name: webhook-deleted
-- D61: never the address.
SELECT json_group_array(json_object(
    'subscriber', json_object('id', s.id, 'uuid', s.uuid, 'email', '', 'external_id', s.external_id),
    'list_ids', (SELECT json_group_array(list_id) FROM subscriber_lists WHERE subscriber_id = s.id))) AS data
  FROM subscribers s WHERE s.id IN (SELECT value FROM json_each(?));
-- name: membership-get
SELECT * FROM subscriber_lists WHERE subscriber_id = ? AND list_id = ?;
-- name: membership-unsubscribe-list
-- Adapted from unsubscribe-by-campaign: one list, rows not already unsubscribed.
UPDATE subscriber_lists SET status='unsubscribed', updated_at=? WHERE subscriber_id=? AND list_id=? AND status != 'unsubscribed' RETURNING list_id;
-- name: membership-unsubscribe-all
-- Adapted from unsubscribe-by-campaign with blocklist: every subscription not already unsubscribed.
UPDATE subscriber_lists SET status='unsubscribed', updated_at=? WHERE subscriber_id=? AND status != 'unsubscribed' RETURNING list_id;
-- name: subscriber-blocklist-only
UPDATE subscribers SET status='blocklisted' WHERE id=?;
-- name: subscriber-touch
UPDATE subscribers SET updated_at=? WHERE id=?;
-- name: subscriber-rename
UPDATE subscribers SET name=?, updated_at=? WHERE id=?;
-- name: membership-unsubscribe-unconfirmed
-- Adapted from unsubscribe-by-campaign with unsubAllUnconfirmed: the opt-in mail's link.
UPDATE subscriber_lists SET status='unsubscribed', updated_at=? WHERE subscriber_id=? AND status = 'unconfirmed' RETURNING list_id;
-- name: membership-confirm
-- Adapted from confirm-subscription-optin, for rows still awaiting confirmation only.
UPDATE subscriber_lists SET status='confirmed', meta=json_patch(meta, ?), updated_at=? WHERE subscriber_id=? AND list_id=? AND status='unconfirmed';
