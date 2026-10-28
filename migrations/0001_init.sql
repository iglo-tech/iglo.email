-- SQLite translation of listmonk v7.0.0-beta.1 schema.sql (6fcd95f), plus
-- iglo.email's events, sequences, outbox, webhooks and FTS5 storage design.
-- The installer seeds, Postgres types/extensions and materialized views are not run.

CREATE TABLE subscribers (
  -- Never reuse automatically allocated subscriber IDs: campaign cursors use an ID high-water mark.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  attribs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attribs) AND json_type(attribs) = 'object'),
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled', 'blocklisted')),
  external_id TEXT UNIQUE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_subs_status ON subscribers(status);
CREATE INDEX idx_subs_id_status ON subscribers(id, status);
CREATE INDEX idx_subs_created_at ON subscribers(created_at);
CREATE INDEX idx_subs_updated_at ON subscribers(updated_at);

CREATE VIRTUAL TABLE subscribers_fts USING fts5(name, email, content='subscribers', content_rowid='id');
CREATE TRIGGER subscribers_fts_insert AFTER INSERT ON subscribers BEGIN
  INSERT INTO subscribers_fts(rowid, name, email) VALUES (new.id, new.name, new.email);
END;
CREATE TRIGGER subscribers_fts_delete AFTER DELETE ON subscribers BEGIN
  INSERT INTO subscribers_fts(subscribers_fts, rowid, name, email) VALUES ('delete', old.id, old.name, old.email);
END;
CREATE TRIGGER subscribers_fts_update AFTER UPDATE OF id, name, email ON subscribers BEGIN
  INSERT INTO subscribers_fts(subscribers_fts, rowid, name, email) VALUES ('delete', old.id, old.name, old.email);
  INSERT INTO subscribers_fts(rowid, name, email) VALUES (new.id, new.name, new.email);
END;

CREATE TABLE lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('public', 'private', 'temporary')),
  optin TEXT NOT NULL DEFAULT 'single' CHECK (optin IN ('single', 'double')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  tags TEXT CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array')),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_lists_type ON lists(type);
CREATE INDEX idx_lists_optin ON lists(optin);
CREATE INDEX idx_lists_status ON lists(status);
CREATE INDEX idx_lists_name ON lists(name);
CREATE INDEX idx_lists_created_at ON lists(created_at);
CREATE INDEX idx_lists_updated_at ON lists(updated_at);

CREATE TABLE subscriber_lists (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE ON UPDATE CASCADE,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND json_type(meta) = 'object'),
  status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed', 'unsubscribed')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (subscriber_id, list_id)
);
CREATE INDEX idx_sub_lists_sub_id ON subscriber_lists(subscriber_id);
CREATE INDEX idx_sub_lists_list_id ON subscriber_lists(list_id);
CREATE INDEX idx_sub_lists_status ON subscriber_lists(status);
CREATE INDEX idx_sub_lists_created_at ON subscriber_lists(created_at);
CREATE INDEX idx_sub_lists_unsubscribed_updated_at ON subscriber_lists(updated_at) WHERE status = 'unsubscribed';

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'campaign' CHECK (type IN ('campaign', 'campaign_visual', 'tx')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  body_source TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_templates_default ON templates(is_default) WHERE is_default = 1;

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_email TEXT NOT NULL,
  body TEXT NOT NULL,
  body_source TEXT,
  altbody TEXT,
  content_type TEXT NOT NULL DEFAULT 'richtext' CHECK (content_type IN ('richtext', 'html', 'plain', 'markdown', 'visual')),
  send_at TEXT,
  headers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(headers) AND json_type(headers) = 'array'),
  attribs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attribs) AND json_type(attribs) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'scheduled', 'paused', 'cancelled', 'finished')),
  tags TEXT CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array')),
  type TEXT DEFAULT 'regular' CHECK (type IS NULL OR type IN ('regular', 'optin')),
  messenger TEXT NOT NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  to_send INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  max_subscriber_id INTEGER NOT NULL DEFAULT 0,
  last_subscriber_id INTEGER NOT NULL DEFAULT 0,
  archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1)),
  archive_slug TEXT UNIQUE,
  archive_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  archive_meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(archive_meta) AND json_type(archive_meta) = 'object'),
  started_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_camps_status ON campaigns(status);
CREATE INDEX idx_camps_name ON campaigns(name);
CREATE INDEX idx_camps_created_at ON campaigns(created_at);
CREATE INDEX idx_camps_updated_at ON campaigns(updated_at);

CREATE TABLE campaign_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL ON UPDATE CASCADE,
  list_name TEXT NOT NULL DEFAULT '',
  UNIQUE (campaign_id, list_id)
);
CREATE INDEX idx_camp_lists_camp_id ON campaign_lists(campaign_id);
CREATE INDEX idx_camp_lists_list_id ON campaign_lists(list_id);

CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  thumb TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND json_type(meta) = 'object'),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_media_filename ON media(provider, filename);
CREATE TABLE campaign_media (
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL ON UPDATE CASCADE,
  filename TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_camp_media_id ON campaign_media(campaign_id, media_id);
CREATE INDEX idx_camp_media_camp_id ON campaign_media(campaign_id);
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE settings (
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_settings_key ON settings(key);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'user' CHECK (type IN ('user', 'list')),
  parent_id INTEGER REFERENCES roles(id) ON DELETE CASCADE ON UPDATE CASCADE,
  list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE ON UPDATE CASCADE,
  permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
  name TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_roles ON roles(parent_id, list_id);
CREATE UNIQUE INDEX idx_roles_name ON roles(type, name) WHERE name IS NOT NULL;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_login INTEGER NOT NULL DEFAULT 0 CHECK (password_login IN (0, 1)),
  password TEXT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT,
  type TEXT NOT NULL DEFAULT 'user' CHECK (type IN ('user', 'api')),
  user_role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  list_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
  twofa_type TEXT NOT NULL DEFAULT 'none' CHECK (twofa_type IN ('none', 'totp')),
  twofa_key TEXT,
  loggedin_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE sessions (
  id TEXT NOT NULL PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sessions ON sessions(id, created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE (subscriber_id, idempotency_key)
);
CREATE INDEX idx_events_subscriber_name_time ON events(subscriber_id, name, occurred_at);
CREATE TABLE sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  trigger TEXT NOT NULL CHECK (json_valid(trigger) AND json_type(trigger) = 'object'),
  exit_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exit_on) AND json_type(exit_on) = 'array'),
  reentry TEXT NOT NULL DEFAULT 'never' CHECK (reentry IN ('never', 'after_exit', 'always')),
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position INTEGER NOT NULL,
  wait TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('marketing', 'transactional')),
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL ON UPDATE CASCADE,
  subject TEXT,
  condition TEXT CHECK (condition IS NULL OR (json_valid(condition) AND json_type(condition) = 'object')),
  on_false TEXT NOT NULL DEFAULT 'exit' CHECK (on_false IN ('skip', 'exit')),
  cap_policy TEXT NOT NULL DEFAULT 'defer' CHECK (cap_policy IN ('defer', 'skip')),
  max_late TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_sequence_steps_active_position ON sequence_steps(sequence_id, position) WHERE status = 'active';
CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  trigger_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL ON UPDATE CASCADE,
  step_id INTEGER REFERENCES sequence_steps(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'exited', 'canceled')),
  exit_reason TEXT,
  claimed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX idx_enrollments_due ON enrollments(status, due_at);
CREATE INDEX idx_enrollments_subscriber_sequence ON enrollments(subscriber_id, sequence_id);
CREATE TABLE sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('tx', 'sequence')),
  kind TEXT NOT NULL CHECK (kind IN ('marketing', 'transactional')),
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  to_email TEXT NOT NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL ON UPDATE CASCADE,
  enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL ON UPDATE CASCADE,
  step_id INTEGER REFERENCES sequence_steps(id) ON DELETE SET NULL ON UPDATE CASCADE,
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL ON UPDATE CASCADE,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  skip_reason TEXT,
  smtp_message_id TEXT,
  error TEXT,
  payload TEXT DEFAULT '{}' CHECK (payload IS NULL OR json_valid(payload)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  UNIQUE (enrollment_id, step_id)
);
CREATE INDEX idx_sends_outbox ON sends(status, created_at);
CREATE INDEX idx_sends_cap ON sends(subscriber_id, kind, sent_at);

CREATE TABLE campaign_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  send_id INTEGER REFERENCES sends(id) ON DELETE CASCADE ON UPDATE CASCADE,
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((campaign_id IS NOT NULL) <> (send_id IS NOT NULL))
);
CREATE INDEX idx_views_camp_id ON campaign_views(campaign_id);
CREATE INDEX idx_views_send_id ON campaign_views(send_id);
CREATE INDEX idx_views_subscriber_id ON campaign_views(subscriber_id);
CREATE INDEX idx_views_date ON campaign_views(created_at);
CREATE TABLE link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  send_id INTEGER REFERENCES sends(id) ON DELETE CASCADE ON UPDATE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE ON UPDATE CASCADE,
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((campaign_id IS NOT NULL) <> (send_id IS NOT NULL))
);
CREATE INDEX idx_clicks_camp_id ON link_clicks(campaign_id);
CREATE INDEX idx_clicks_send_id ON link_clicks(send_id);
CREATE INDEX idx_clicks_link_id ON link_clicks(link_id);
CREATE INDEX idx_clicks_sub_id ON link_clicks(subscriber_id);
CREATE INDEX idx_clicks_date ON link_clicks(created_at);
CREATE TABLE bounces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL ON UPDATE CASCADE,
  send_id INTEGER REFERENCES sends(id) ON DELETE SET NULL ON UPDATE CASCADE,
  type TEXT NOT NULL DEFAULT 'hard' CHECK (type IN ('soft', 'hard', 'complaint')),
  source TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND json_type(meta) = 'object'),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bounces_sub_id ON bounces(subscriber_id);
CREATE INDEX idx_bounces_camp_id ON bounces(campaign_id);
CREATE INDEX idx_bounces_send_id ON bounces(send_id);
CREATE INDEX idx_bounces_source ON bounces(source);
CREATE INDEX idx_bounces_date ON bounces(created_at);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events) AND json_type(events) = 'array'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  claimed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id);

-- Stored summaries have the upstream materialized-view shapes. Their owner will populate them.
CREATE TABLE mat_dashboard_counts (
  updated_at TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object')
);
CREATE TABLE mat_dashboard_charts (
  updated_at TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object')
);
CREATE TABLE mat_list_subscriber_stats (
  updated_at TEXT NOT NULL,
  list_id INTEGER NOT NULL,
  status TEXT CHECK (status IS NULL OR status IN ('unconfirmed', 'confirmed', 'unsubscribed')),
  subscriber_count INTEGER NOT NULL,
  UNIQUE (list_id, status)
);
CREATE TABLE mat_list_charts (
  list_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  subscriptions INTEGER NOT NULL,
  unsubscriptions INTEGER NOT NULL,
  campaign_views INTEGER NOT NULL,
  UNIQUE (list_id, date)
);
