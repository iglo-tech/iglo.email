-- Adapted from listmonk queries/templates.sql at 6fcd95f.
-- name: templates-all
SELECT * FROM templates;
-- name: template-by-id
SELECT * FROM templates WHERE id = ?;
-- name: template-count
SELECT COUNT(*) AS count FROM templates;
-- name: template-default
SELECT * FROM templates WHERE is_default = 1 AND type = 'campaign';
-- name: template-insert
INSERT INTO templates (name, type, subject, body, body_source, is_default, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id;
-- name: template-update
UPDATE templates SET name = ?, subject = ?, body = ?, body_source = ?, updated_at = ? WHERE id = ?;
-- name: template-clear-default
UPDATE templates SET is_default = 0 WHERE is_default = 1;
-- name: template-set-default
UPDATE templates SET is_default = 1 WHERE id = ?;
-- name: template-delete
DELETE FROM templates WHERE id = ?;
