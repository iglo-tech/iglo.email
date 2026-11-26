-- B155b (15-external-sources section 4, D177): each retry queue row names the source it was read
-- from, the digest of the URL, collection and name field (events) or filter (users) that the
-- stream's markers use. A stream drops the rows of any other source, so after a source change no
-- old record is read again against the new source. Rows from before this migration have '' and are
-- adopted by the first stream that starts with a marker of the same source (src/sources/stream.ts).
ALTER TABLE source_stream_retries ADD COLUMN source TEXT NOT NULL DEFAULT '';
-- `waiting` is 1 while the row's last attempt met a settings mismatch (a configured field missing,
-- a re-read the source refused): it waits for the settings, never terminal. A retry-queue view shows
-- it as "waiting for settings". A row from before this migration shows 0 until its next attempt.
ALTER TABLE source_stream_retries ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0
  CHECK (waiting IN (0, 1));
