-- Adapted from export-campaign-views and export-campaign-link-clicks in listmonk
-- queries/campaigns.sql at 6fcd95f. A page is of the date index, so a rare `since` costs no scan,
-- and the position is a row, not an OFFSET, so rows deleted meanwhile cannot shift it. Upstream
-- orders by ID, which is the same order unless the clock went back.
-- name: export-views
SELECT p.id, p.created_at, p.campaign_id,
    coalesce(c.uuid, '') AS campaign_uuid,
    coalesce(c.name, '') AS campaign_name,
    coalesce(p.subscriber_id, 0) AS subscriber_id,
    coalesce(s.uuid, '') AS subscriber_uuid,
    coalesce(s.email, '') AS email,
    coalesce(s.name, '') AS subscriber_name
  FROM (SELECT id, created_at, campaign_id, subscriber_id FROM campaign_views
      WHERE created_at >= max(?1, ?2) AND (created_at > ?2 OR id > ?3)
      ORDER BY created_at, id LIMIT ?4) p
  LEFT JOIN campaigns c ON c.id = p.campaign_id
  LEFT JOIN subscribers s ON s.id = p.subscriber_id
  ORDER BY p.created_at, p.id;
-- name: export-clicks
SELECT p.id, p.created_at, p.campaign_id,
    coalesce(c.uuid, '') AS campaign_uuid,
    coalesce(c.name, '') AS campaign_name,
    coalesce(p.subscriber_id, 0) AS subscriber_id,
    coalesce(s.uuid, '') AS subscriber_uuid,
    coalesce(s.email, '') AS email,
    coalesce(s.name, '') AS subscriber_name,
    l.url
  FROM (SELECT id, created_at, campaign_id, subscriber_id, link_id FROM link_clicks
      WHERE created_at >= max(?1, ?2) AND (created_at > ?2 OR id > ?3)
      ORDER BY created_at, id LIMIT ?4) p
  LEFT JOIN campaigns c ON c.id = p.campaign_id
  LEFT JOIN links l ON l.id = p.link_id
  LEFT JOIN subscribers s ON s.id = p.subscriber_id
  ORDER BY p.created_at, p.id;
