-- Native subscriber event store (docs/design/03-data-model.md#events); no upstream source.
-- name: event-by-key
SELECT id, subscriber_id, enrollments FROM events WHERE subscriber_id = ? AND idempotency_key = ?;
-- name: event-enrollments
UPDATE events SET enrollments = ? WHERE id = ?;
-- name: event-insert
INSERT INTO events (subscriber_id, name, data, occurred_at, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?) RETURNING id;
-- name: event-by-id
SELECT id, subscriber_id, name, data, occurred_at, created_at, idempotency_key FROM events WHERE id = ?;
-- name: events-by-subscriber
SELECT id, subscriber_id, name, data, occurred_at, created_at, idempotency_key FROM events WHERE subscriber_id = ? ORDER BY id LIMIT ?;
-- name: events-page
SELECT id, subscriber_id, name, data, occurred_at, created_at, idempotency_key FROM events WHERE subscriber_id = ? ORDER BY id DESC LIMIT ? OFFSET ?;
-- name: event-latest-named
-- The newest event of one name for a subscriber: the step preview's trigger (D105).
SELECT id, subscriber_id, name, data, occurred_at, created_at, idempotency_key FROM events WHERE subscriber_id = ? AND name = ? ORDER BY occurred_at DESC, id DESC LIMIT 1;
-- name: events-count
SELECT count(*) AS n FROM events WHERE subscriber_id = ?;
-- name: events-purge
-- Retention in receive order: only the oldest IDs are examined, so one batch is bounded.
DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id, created_at FROM events ORDER BY id LIMIT ?) WHERE created_at < ?) RETURNING id;
