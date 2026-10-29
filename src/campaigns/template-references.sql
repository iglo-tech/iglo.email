-- Adapted from listmonk queries/templates.sql delete-template at 6fcd95f.
-- name: reassign-primary-template
UPDATE campaigns SET template_id = ? WHERE template_id = ?;
