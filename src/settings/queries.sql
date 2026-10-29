-- Settings SQL adapted from listmonk queries/misc.sql at 6fcd95f.
-- name: seed
INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING;
-- name: all
SELECT key, value FROM settings;
-- name: update
UPDATE settings SET value = ?, updated_at = ? WHERE key = ?;
