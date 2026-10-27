-- Fixture-owned queries, using the named-block convention from listmonk.
-- name: insert-record
INSERT INTO fixture_records (id, value) VALUES (?, ?);

-- name: get-record
SELECT id, value FROM fixture_records WHERE id = ?;

-- name: literal
SELECT '; -- name: not-a-header' AS value; -- ; comment
