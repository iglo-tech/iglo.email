-- Adapted from listmonk queries/subscribers.sql query-subscribers-for-export at 6fcd95f.
-- The ? JSON array is one bounded batch of IDs.
-- name: export-rows
SELECT id, uuid, email, name, attribs, status, created_at, updated_at FROM subscribers
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id;
