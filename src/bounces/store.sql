-- Adapted from listmonk queries/bounces.sql at 6fcd95f.
-- name: bounce-count
SELECT COUNT(*) AS n FROM bounces WHERE subscriber_id = ? AND type = ?;
-- name: bounce-insert
INSERT INTO bounces (subscriber_id, campaign_id, send_id, type, source, meta, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id;
-- name: bounces-delete-ids
DELETE FROM bounces WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?));
-- name: bounces-delete-filtered
DELETE FROM bounces WHERE (?1 = 0 OR campaign_id = ?1) AND (?2 = '' OR source = ?2)
  AND (?3 = '' OR type = ?3);
-- name: bounces-delete-subscriber
DELETE FROM bounces WHERE subscriber_id = ?;
-- name: bounces-delete-sends
-- Bounces of unlinked sends. A linked subscriber's bounces go by cascade.
DELETE FROM bounces WHERE subscriber_id IS NULL
  AND send_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?));
-- name: bounced-subscribers-ids
SELECT DISTINCT subscriber_id FROM bounces WHERE subscriber_id IS NOT NULL
  AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?));
-- name: bounced-subscribers-filtered
SELECT DISTINCT subscriber_id FROM bounces WHERE subscriber_id IS NOT NULL
  AND (?1 = 0 OR campaign_id = ?1) AND (?2 = '' OR source = ?2) AND (?3 = '' OR type = ?3);
-- name: bounces-export
SELECT b.type, b.source, b.meta, b.created_at, c.subject AS campaign FROM bounces b
  LEFT JOIN campaigns c ON c.id = b.campaign_id
  WHERE b.subscriber_id = ? ORDER BY b.id DESC LIMIT ?;
-- name: receipts-expire
DELETE FROM bounce_receipts WHERE expires_at <= ?;
-- name: receipt-insert
INSERT INTO bounce_receipts (key, expires_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING;
