-- Adapted from listmonk queries/roles.sql at 6fcd95f.
-- name: list-name
SELECT name FROM lists WHERE id = ?;
