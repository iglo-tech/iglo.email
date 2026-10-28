-- Adapted from listmonk queries/roles.sql at 6fcd95f.
-- name: list-name
SELECT name FROM lists WHERE id = ?;

-- name: subscriber-list-metadata
SELECT id, uuid, name, type, optin, status, tags, description, created_at, updated_at FROM lists WHERE id = ?;
