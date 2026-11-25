-- Native (15-external-sources sections 3 and 4, D171): the realtime stream's markers, dedupe
-- entries and retry queue. Owned by src/sources/stream-store.ts.
-- name: markers
SELECT topic, marker FROM source_stream_markers;
-- name: marker-insert
INSERT INTO source_stream_markers (topic, marker) VALUES (?, ?) ON CONFLICT (topic) DO NOTHING;
-- name: markers-keep
-- Drops every marker whose topic is not in the JSON array: a name no longer subscribed, or another
-- source, collection or filter.
DELETE FROM source_stream_markers WHERE topic NOT IN (SELECT value FROM json_each(?));
-- name: markers-advance
-- Moves the listed topics' markers forward to the stamp; never back.
UPDATE source_stream_markers SET marker = ?2
  WHERE topic IN (SELECT value FROM json_each(?1)) AND marker < ?2;
-- name: seen
SELECT 1 FROM source_stream_seen WHERE kind = ? AND record_id = ? AND stamp = ?;
-- name: seen-insert
INSERT INTO source_stream_seen (kind, record_id, stamp) VALUES (?, ?, ?);
-- name: seen-prune
DELETE FROM source_stream_seen WHERE kind = ? AND stamp < ?;
-- name: seen-count
SELECT count(*) AS n FROM source_stream_seen;
-- name: retry-insert
INSERT INTO source_stream_retries
  (kind, record_id, stamp, attempts, first_failed_at, next_attempt_at, last_error, terminal)
  VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT (kind, record_id, stamp) DO NOTHING;
-- name: retry-claim
-- Claims due rows: each attempt counts, and the row is leased until the next attempt time.
UPDATE source_stream_retries SET attempts = attempts + 1, next_attempt_at = ?1
  WHERE id IN (
    SELECT id FROM source_stream_retries WHERE terminal = 0 AND next_attempt_at <= ?2
      ORDER BY next_attempt_at, id LIMIT ?3
  )
  RETURNING id, kind, record_id, stamp, attempts, first_failed_at;
-- name: retry-done
DELETE FROM source_stream_retries WHERE id = ? AND attempts = ? AND terminal = 0;
-- name: retry-failed
UPDATE source_stream_retries SET next_attempt_at = ?, last_error = ?, terminal = ?
  WHERE id = ? AND attempts = ? AND terminal = 0;
-- name: retry-expire
DELETE FROM source_stream_retries WHERE terminal = 1 AND next_attempt_at < ?;
-- name: retries
SELECT id, kind, record_id, stamp, attempts, first_failed_at, next_attempt_at, last_error, terminal
  FROM source_stream_retries ORDER BY id LIMIT ?;
