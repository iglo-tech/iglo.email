-- name: upsert-summary
INSERT INTO analytics_summaries (name, data, updated_at) VALUES (?, ?, ?)
ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;
-- name: get-summary
SELECT data FROM analytics_summaries WHERE name = ?;
-- name: clear-summaries
DELETE FROM analytics_summaries;
