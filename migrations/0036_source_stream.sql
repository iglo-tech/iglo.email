-- B150b (15-external-sources sections 3 and 4, D171): the realtime stream's own state, owned by
-- src/sources/stream-store.ts. No source data is kept here beyond record IDs and their stamps.
--
-- source_stream_markers: one resume marker per subscribed name (events) or per watched users filter.
-- `topic` names the source, the collection and the name or filter (a digest, see the store); the
-- marker is the source's `created` (events) or `updated` (users) text of the newest committed
-- record, or the time the topic was first subscribed.
CREATE TABLE source_stream_markers (
  topic TEXT PRIMARY KEY NOT NULL,
  marker TEXT NOT NULL
) WITHOUT ROWID;

-- source_stream_seen: the dedupe table, one row per record handled: `kind` is `event` or `user`,
-- `stamp` the record's `created` (events) or `updated` (users) text. Pruned relative to the markers.
CREATE TABLE source_stream_seen (
  kind TEXT NOT NULL CHECK (kind IN ('event', 'user')),
  record_id TEXT NOT NULL,
  stamp TEXT NOT NULL,
  PRIMARY KEY (kind, record_id, stamp)
) WITHOUT ROWID;
CREATE INDEX idx_source_stream_seen_stamp ON source_stream_seen(kind, stamp);

-- source_stream_retries: the per-record retry queue. A record a handler failed on transiently waits
-- here for `next_attempt_at`; a permanent failure, or one past the retry window, is terminal and
-- stays for the attention view until it expires.
CREATE TABLE source_stream_retries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'user')),
  record_id TEXT NOT NULL,
  stamp TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_failed_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  UNIQUE (kind, record_id, stamp)
);
CREATE INDEX idx_source_stream_retries_due ON source_stream_retries(terminal, next_attempt_at);
