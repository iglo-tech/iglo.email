-- Adapted from listmonk queries/subscribers.sql at 6fcd95f. Rows of sends have no campaign, so
-- they come back as the rows upstream's left join gives for a missing one.
-- name: subscriber-activity-views
SELECT c.id, c.uuid, c.name, c.subject, COUNT(*) AS view_count, MAX(v.created_at) AS last_viewed_at
FROM campaign_views v
LEFT JOIN campaigns c ON c.id = v.campaign_id
WHERE v.subscriber_id = ?
GROUP BY c.id
ORDER BY last_viewed_at DESC LIMIT 5000;
-- name: subscriber-activity-clicks
SELECT l.id AS link_id, l.url, c.id AS campaign_id, c.uuid AS campaign_uuid, c.name AS campaign_name,
  c.subject AS campaign_subject, COUNT(*) AS click_count, MAX(k.created_at) AS last_clicked_at
FROM link_clicks k
LEFT JOIN links l ON l.id = k.link_id
LEFT JOIN campaigns c ON c.id = k.campaign_id
WHERE k.subscriber_id = ?
GROUP BY l.id, c.id
ORDER BY last_clicked_at DESC LIMIT 5000;
-- name: delete-subscriber-campaign-views
DELETE FROM campaign_views WHERE subscriber_id = ?;
-- name: delete-subscriber-link-clicks
DELETE FROM link_clicks WHERE subscriber_id = ?;
