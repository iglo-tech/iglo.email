-- M3.1 campaign link registrations (docs/design/04-sending.md#tracking). The public campaign
-- redirect follows a link only when the campaign's own rendered content registered it, so a
-- link registered by a transactional send or another campaign cannot redirect for this one.
CREATE TABLE campaign_links (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (campaign_id, link_id)
) WITHOUT ROWID;
