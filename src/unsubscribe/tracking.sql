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
