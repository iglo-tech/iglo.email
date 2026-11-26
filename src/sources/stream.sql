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
  (kind, record_id, stamp, attempts, first_failed_at, next_attempt_at, last_error, terminal, source)
  VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
  ON CONFLICT (kind, record_id, stamp) DO NOTHING;
-- name: retries-adopt
-- D177: rows from before migration 38 have no source; the stream of the same source takes them.
UPDATE source_stream_retries SET source = ?2 WHERE source = '' AND kind = ?1;
-- name: retries-other-sources
-- D177: a new source ignores history, its retry queue included.
DELETE FROM source_stream_retries
  WHERE source <> CASE kind WHEN 'event' THEN ?1 ELSE ?2 END;
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
-- A non-null fourth parameter restarts the 72-hour window and marks the row waiting for the
-- settings (a settings mismatch, D177).
UPDATE source_stream_retries SET next_attempt_at = ?1, last_error = ?2, terminal = ?3,
    first_failed_at = coalesce(?4, first_failed_at), waiting = ?4 IS NOT NULL
  WHERE id = ?5 AND attempts = ?6 AND terminal = 0;
-- name: retry-expire
DELETE FROM source_stream_retries WHERE terminal = 1 AND next_attempt_at < ?;
-- name: retries
SELECT id, kind, record_id, stamp, attempts, first_failed_at, next_attempt_at, last_error, terminal,
    waiting
  FROM source_stream_retries ORDER BY id LIMIT ?;
