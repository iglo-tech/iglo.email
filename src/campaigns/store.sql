-- Adapted from listmonk queries/campaigns.sql at 6fcd95f. Lists, media and stats are
-- loaded as in get-campaign-stats; list and tag arrays are JSON (03-data-model.md).
-- name: campaign-by-id
SELECT c.*,
  (SELECT COUNT(*) FROM campaign_views WHERE campaign_id = c.id) AS views,
  (SELECT COUNT(*) FROM link_clicks WHERE campaign_id = c.id) AS clicks,
  (SELECT COUNT(*) FROM bounces WHERE campaign_id = c.id) AS bounces,
  (SELECT COALESCE(json_group_array(json_object('id', COALESCE(list_id, 0), 'name', list_name)), '[]')
    FROM (SELECT list_id, list_name FROM campaign_lists WHERE campaign_id = c.id ORDER BY id)) AS lists,
  (SELECT COALESCE(json_group_array(json_object('id', media_id, 'filename', filename)), '[]')
    FROM (SELECT media_id, filename FROM campaign_media WHERE campaign_id = c.id ORDER BY rowid)) AS media
FROM campaigns c WHERE c.id = ?;

-- name: campaign-by-uuid
SELECT id, uuid, type, status FROM campaigns WHERE uuid = ?;

-- name: query-campaign-ids
-- ?1 statuses JSON, ?2 tags JSON, ?3 search GLOB, ?4 type, ?5 all lists, ?6 permitted list IDs JSON,
-- ?7 sort field, ?8 ASC/DESC, ?9 limit (-1 all), ?10 offset. NULLs sort as in Postgres;
-- status sorts by the rank of upstream's campaign_status enum.
SELECT id, total FROM (
  SELECT c.id,
    CASE ?7 WHEN 'name' THEN c.name WHEN 'status' THEN (CASE c.status WHEN 'draft' THEN 0
        WHEN 'running' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'paused' THEN 3 WHEN 'cancelled' THEN 4
        ELSE 5 END) WHEN 'updated_at' THEN c.updated_at
      WHEN 'started_at' THEN c.started_at WHEN 'send_at' THEN c.send_at ELSE c.created_at END AS k,
    COUNT(*) OVER () AS total
  FROM campaigns c
  WHERE (json_array_length(?1) = 0 OR c.status IN (SELECT value FROM json_each(?1)))
    AND (json_array_length(?2) = 0 OR NOT EXISTS (
      SELECT 1 FROM json_each(?2) t
      WHERE NOT EXISTS (SELECT 1 FROM json_each(COALESCE(c.tags, '[]')) ct WHERE ct.value = t.value)))
    AND (c.name || ' ' || c.subject) GLOB ?3
    AND (?4 = '' OR c.type = ?4)
    AND (?5 OR EXISTS (SELECT 1 FROM campaign_lists cl WHERE cl.campaign_id = c.id
      AND cl.list_id IN (SELECT value FROM json_each(?6))))
)
ORDER BY CASE WHEN ?8 = 'ASC' THEN k IS NULL END ASC, CASE WHEN ?8 = 'ASC' THEN k END ASC,
  CASE WHEN ?8 = 'ASC' THEN id END ASC, CASE WHEN ?8 = 'DESC' THEN k IS NULL END DESC,
  CASE WHEN ?8 = 'DESC' THEN k END DESC, id DESC
LIMIT ?9 OFFSET ?10;

-- name: delete-campaign-ids
-- Bulk deletion selection: explicit IDs, or the collection filters (?2 search GLOB). Same
-- scope as listing.
SELECT c.id FROM campaigns c
WHERE (CASE WHEN json_array_length(?1) > 0 THEN c.id IN (SELECT value FROM json_each(?1))
  ELSE (c.name || ' ' || c.subject) GLOB ?2
    AND (json_array_length(?3) = 0 OR c.status IN (SELECT value FROM json_each(?3)))
    AND (json_array_length(?4) = 0 OR NOT EXISTS (
      SELECT 1 FROM json_each(?4) t
      WHERE NOT EXISTS (SELECT 1 FROM json_each(COALESCE(c.tags, '[]')) ct WHERE ct.value = t.value)))
    AND (?5 = '' OR c.type = ?5)
  END)
  AND (?6 OR EXISTS (SELECT 1 FROM campaign_lists cl WHERE cl.campaign_id = c.id
    AND cl.list_id IN (SELECT value FROM json_each(?7))));

-- name: campaign-has-lists
SELECT EXISTS (SELECT 1 FROM campaign_lists WHERE campaign_id = ?
  AND list_id IN (SELECT value FROM json_each(?))) AS has;

-- name: campaign-list-ids
SELECT list_id FROM campaign_lists WHERE campaign_id = ? AND list_id IS NOT NULL ORDER BY id;

-- name: insert-campaign
INSERT INTO campaigns (uuid, type, name, subject, from_email, body, altbody, content_type,
  send_at, headers, attribs, tags, messenger, template_id, archive, archive_slug,
  archive_template_id, archive_meta, body_source, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id;

-- name: insert-campaign-list
INSERT INTO campaign_lists (campaign_id, list_id, list_name) VALUES (?1, ?2, ?3)
ON CONFLICT (campaign_id, list_id) DO UPDATE SET list_name = excluded.list_name;

-- name: delete-other-campaign-lists
DELETE FROM campaign_lists WHERE campaign_id = ? AND list_id IS NOT NULL
  AND list_id NOT IN (SELECT value FROM json_each(?));

-- name: insert-campaign-media
-- The media table has no owner module until M3.5; this keeps upstream's ID filter.
INSERT INTO campaign_media (campaign_id, media_id, filename)
SELECT ?1, id, filename FROM media WHERE id = ?2
ON CONFLICT (campaign_id, media_id) DO NOTHING;

-- name: delete-other-campaign-media
DELETE FROM campaign_media WHERE campaign_id = ?
  AND (media_id IS NULL OR media_id NOT IN (SELECT value FROM json_each(?)));

-- name: update-campaign
UPDATE campaigns SET name = ?2, subject = ?3, from_email = ?4, body = ?5, altbody = ?6,
  content_type = ?7, send_at = ?8,
  status = (CASE WHEN status = 'scheduled' AND ?8 IS NULL THEN 'draft' ELSE status END),
  headers = ?9, attribs = ?10, tags = ?11, messenger = ?12,
  template_id = (CASE WHEN ?7 = 'visual' THEN NULL ELSE ?13 END),
  archive = ?14, archive_slug = ?15,
  archive_template_id = (CASE WHEN ?7 = 'visual' THEN NULL ELSE ?16 END),
  archive_meta = ?17, body_source = ?18, updated_at = ?19
WHERE id = ?1;

-- name: update-campaign-status
UPDATE campaigns SET
  status = (CASE WHEN send_at IS NOT NULL AND ?2 = 'running' THEN 'scheduled' ELSE ?2 END),
  updated_at = ?3
WHERE id = ?1;

-- name: update-campaign-archive
UPDATE campaigns SET archive = ?2, archive_slug = ?3,
  archive_template_id = (CASE WHEN ?4 > 0 THEN ?4 ELSE archive_template_id END),
  archive_meta = COALESCE(?5, archive_meta), updated_at = ?6
WHERE id = ?1;

-- name: archive-slug-owner
SELECT id FROM campaigns WHERE archive_slug = ?;

-- name: delete-campaign
DELETE FROM campaigns WHERE id = ?;

-- name: register-campaign-view
INSERT INTO campaign_views (campaign_id, subscriber_id, created_at) VALUES (?, ?, ?);

-- name: register-campaign-click
INSERT INTO link_clicks (campaign_id, link_id, subscriber_id, created_at) VALUES (?, ?, ?, ?);

-- name: register-campaign-link
INSERT INTO campaign_links (campaign_id, link_id) VALUES (?, ?) ON CONFLICT DO NOTHING;

-- name: campaign-has-link
SELECT EXISTS (SELECT 1 FROM campaign_links WHERE campaign_id = ? AND link_id = ?) AS has;

-- name: archived-campaigns
-- Adapted from get-archived-campaigns.
SELECT id, COUNT(*) OVER () AS total FROM campaigns
WHERE archive = 1 AND type = 'regular' AND status IN ('running', 'paused', 'finished')
ORDER BY started_at IS NULL, started_at DESC, id DESC LIMIT ? OFFSET ?;

-- name: archived-campaign-id
-- A UUID or slug; unsent campaigns are not published.
SELECT id FROM campaigns
WHERE (uuid = ?1 OR archive_slug = ?1)
  AND archive = 1 AND type = 'regular' AND status IN ('running', 'paused', 'finished');

-- name: subscriber-campaign-views
-- Adapted from export-subscriber-data.
SELECT c.subject AS campaign, COUNT(v.id) AS views FROM campaign_views v
JOIN campaigns c ON c.id = v.campaign_id
WHERE v.subscriber_id = ? GROUP BY c.id ORDER BY c.id LIMIT 5000;
