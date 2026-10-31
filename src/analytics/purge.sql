-- Adapted from listmonk queries/campaigns.sql at 6fcd95f. %table% is campaign_views or link_clicks.
-- Campaign rows only: the rows of sends are the sends' own history (07-api-and-ui.md).
-- name: purge-page
-- Spelled out: a row value would start each page at the first row of the index, not at ?2.
SELECT id, created_at, campaign_id IS NOT NULL AS hit FROM %table%
  WHERE created_at < ?1 AND created_at >= ?2 AND (created_at > ?2 OR id > ?3)
  ORDER BY created_at, id LIMIT ?4;
-- name: purge-delete
DELETE FROM %table% WHERE id IN (SELECT value FROM json_each(?));
