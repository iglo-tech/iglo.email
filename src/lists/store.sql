-- Adapted from listmonk queries/lists.sql at 6fcd95f.
-- name: all-lists
SELECT * FROM lists;
-- name: list-by-id
SELECT * FROM lists WHERE id = ?;
-- name: insert-list
INSERT INTO lists (uuid, name, type, optin, status, tags, description, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id;
-- name: update-list
UPDATE lists SET name = ?, type = ?, optin = ?, status = ?, tags = ?, description = ?, updated_at = ? WHERE id = ?;
-- name: delete-list
DELETE FROM lists WHERE id = ?;

-- name: lists-touch
-- Adapted from update-lists-date.
UPDATE lists SET updated_at = ? WHERE id IN (SELECT value FROM json_each(?));
