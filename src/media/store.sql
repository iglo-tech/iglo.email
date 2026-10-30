-- Adapted from listmonk queries/media.sql at 6fcd95f. Search is a literal case-insensitive GLOB.

-- name: insert-media
INSERT INTO media (uuid, filename, thumb, content_type, provider, meta, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: query-media
SELECT COUNT(*) OVER () AS total, * FROM media
WHERE provider = ?1 AND filename GLOB ?2
ORDER BY created_at DESC, id DESC
LIMIT ?3 OFFSET ?4;

-- name: get-media
SELECT * FROM media WHERE id = ?;

-- name: media-filename-exists
SELECT 1 FROM media WHERE filename = ? LIMIT 1;

-- name: get-media-by-filename
-- A name is one file of this instance's directory. Public requests reach this: it is indexed.
SELECT * FROM media WHERE provider = 'filesystem' AND filename = ? ORDER BY id LIMIT 1;

-- name: any-media
SELECT 1 FROM media LIMIT 1;

-- name: delete-media
DELETE FROM media WHERE id = ? RETURNING *;
