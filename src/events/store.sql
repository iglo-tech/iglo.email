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
-- The page's IDs are sorted alone and its rows are read by ID (B116, D131): a row's outcome is
-- wide, and the sort would carry it for every event the subscriber has (perf/B116-skip-reasons.md).
SELECT e.id, e.subscriber_id, e.name, e.data, e.occurred_at, e.created_at, e.idempotency_key, e.enrollments
  FROM events e JOIN (SELECT id FROM events WHERE subscriber_id = ? ORDER BY id DESC LIMIT ? OFFSET ?) p
    ON p.id = e.id
  ORDER BY e.id DESC;
-- name: event-latest-named
-- The newest event of one name for a subscriber: the step preview's trigger (D105).
SELECT id, subscriber_id, name, data, occurred_at, created_at, idempotency_key FROM events WHERE subscriber_id = ? AND name = ? ORDER BY occurred_at DESC, id DESC LIMIT 1;
-- name: event-exits-shown
-- B118h (05-sequences.md#events-tab): the event each exit of one page is shown on, in one read. ?2 is a
-- JSON array of {"name", "at", "trigger"}: an exit's event name, the time it was received and its
-- enrollment's trigger event ID (or null). The subscriber's events with those names and times are read
-- once (cand), and each exit takes the lowest of them, or, when its trigger was received at the same
-- time whatever its name, the lowest after the trigger: an event exits only enrollments it did not start.
-- One row per array index; id is null when no event of the subscriber has the exit's name and time.
WITH want AS (
  SELECT CAST(j.key AS INTEGER) AS idx, json_extract(j.value, '$.name') AS name,
      json_extract(j.value, '$.at') AS at, CAST(json_extract(j.value, '$.trigger') AS INTEGER) AS trigger_id
    FROM json_each(?2) j
),
cand AS MATERIALIZED (
  SELECT id, name, created_at FROM events
    WHERE subscriber_id = ?1 AND name IN (SELECT name FROM want) AND created_at IN (SELECT at FROM want)
)
SELECT w.idx, (SELECT MIN(c.id) FROM cand c
    WHERE c.name = w.name AND c.created_at = w.at
      AND c.id > COALESCE((SELECT t.id FROM events t
        WHERE t.id = w.trigger_id AND t.subscriber_id = ?1 AND t.created_at = w.at), 0)) AS id
  FROM want w
  ORDER BY w.idx;
-- name: events-count
SELECT count(*) AS n FROM events WHERE subscriber_id = ?;
-- name: events-purge
-- Retention in receive order: only the oldest IDs are examined, so one batch is bounded.
DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id, created_at FROM events ORDER BY id LIMIT ?) WHERE created_at < ?) RETURNING id;
