-- Adapted from listmonk queries/links.sql and queries/campaigns.sql at 6fcd95f,
-- tracked against send_id instead of campaign_id.
-- name: create-link
INSERT INTO links (uuid, url) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET url = excluded.url RETURNING uuid;
-- name: get-link
SELECT id, url FROM links WHERE uuid = ?;
-- name: register-send-click
INSERT INTO link_clicks (send_id, link_id, subscriber_id, created_at) VALUES (?, ?, ?, ?);
-- name: register-send-view
INSERT INTO campaign_views (send_id, subscriber_id, created_at) VALUES (?, ?, ?);
-- name: subscriber-link-clicks
-- Adapted from export-subscriber-data.
SELECT l.url, COUNT(c.id) AS clicks FROM link_clicks c
JOIN links l ON l.id = c.link_id
WHERE c.subscriber_id = ? GROUP BY l.id ORDER BY l.id LIMIT 5000;
