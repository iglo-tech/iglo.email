-- Adapted from listmonk queries/lists.sql update-list at 6fcd95f.
-- name: update-campaign-list-name
UPDATE campaign_lists SET list_name = ? WHERE list_id = ?;
