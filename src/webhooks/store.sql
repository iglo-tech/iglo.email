-- Native outbound webhooks (docs/design/04-sending.md#outbound-webhooks); no upstream query.
-- name: webhook-list
SELECT id, url, events, enabled, created_at, updated_at FROM webhooks ORDER BY id LIMIT ? OFFSET ?;
-- name: webhook-count
SELECT count(*) AS n FROM webhooks;
-- name: webhook-get
SELECT id, url, events, enabled, created_at, updated_at FROM webhooks WHERE id = ?;
-- name: webhook-insert
INSERT INTO webhooks (url, secret, events, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
  RETURNING id, url, events, enabled, created_at, updated_at;
-- name: webhook-update
UPDATE webhooks SET url = ?, events = ?, enabled = ?, updated_at = ? WHERE id = ?
  RETURNING id, url, events, enabled, created_at, updated_at;
-- name: webhook-delete
DELETE FROM webhooks WHERE id = ?;
-- name: webhook-targets
SELECT id, url, secret, enabled FROM webhooks ORDER BY id;
-- name: webhooks-for-event
SELECT id FROM webhooks WHERE enabled = 1 AND ? IN (SELECT value FROM json_each(events)) ORDER BY id;
-- name: delivery-insert
INSERT INTO webhook_deliveries (uuid, webhook_id, event, payload, subscriber_id, next_attempt_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?);
-- name: delivery-list
SELECT id, uuid, webhook_id, event, status, attempts, next_attempt_at, last_error, claimed_until, created_at, updated_at
  FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ? OFFSET ?;
-- name: delivery-count
SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?;
-- name: delivery-claim
-- The lease is also the next due time, so a row whose process died is due again by itself.
UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = ?1, claimed_until = ?1
  WHERE id IN (
    SELECT id FROM webhook_deliveries
    WHERE webhook_id = ?2 AND status = 'queued' AND next_attempt_at <= ?3
    ORDER BY next_attempt_at, id LIMIT ?4
  )
  RETURNING id, uuid, webhook_id, event, payload, attempts, created_at, claimed_until;
-- name: delivery-due
SELECT id, created_at FROM webhook_deliveries
  WHERE webhook_id = ? AND status = 'queued' AND next_attempt_at <= ?
  ORDER BY next_attempt_at, id LIMIT ?;
-- name: delivery-postpone
UPDATE webhook_deliveries SET next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?;
-- name: delivery-retry
UPDATE webhook_deliveries SET next_attempt_at = ?, last_error = ?, claimed_until = NULL, updated_at = ?
  WHERE id = ? AND status = 'queued' AND claimed_until = ?;
-- name: delivery-end
-- External IDs stay only while a subscriber.deleted delivery can still go out.
UPDATE webhook_deliveries SET status = ?1, last_error = ?2, next_attempt_at = NULL, claimed_until = NULL, updated_at = ?3,
    payload = CASE WHEN event = 'subscriber.deleted'
      THEN json_set(payload, '$.data.subscriber.external_id', json('null')) ELSE payload END
  WHERE id = ?4 AND status = 'queued' AND (?5 IS NULL OR claimed_until = ?5);
-- name: delivery-recover
UPDATE webhook_deliveries SET next_attempt_at = ?1, claimed_until = NULL, updated_at = ?1
  WHERE status = 'queued' AND claimed_until IS NOT NULL;
-- name: delivery-clear-subscribers
UPDATE webhook_deliveries SET updated_at = ?1,
    payload = json_set(payload, '$.data.subscriber.email', '', '$.data.subscriber.external_id', json('null'))
  WHERE subscriber_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2));
