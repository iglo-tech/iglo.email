// Reduced synthetic schema informed by listmonk schema.sql and queries/campaigns.sql.
// Events and FTS5 are new SQLite design work, not upstream endpoint ports.
export const schema = `
CREATE TABLE IF NOT EXISTS spike_subscribers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spike_subscriber_status ON spike_subscribers(status);
CREATE INDEX IF NOT EXISTS spike_subscriber_id_status ON spike_subscribers(id, status);
CREATE INDEX IF NOT EXISTS spike_subscriber_created ON spike_subscribers(created_at);
CREATE INDEX IF NOT EXISTS spike_subscriber_updated ON spike_subscribers(updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS spike_subscribers_fts USING fts5(
  name, email, content='spike_subscribers', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS spike_subscribers_ai AFTER INSERT ON spike_subscribers BEGIN
  INSERT INTO spike_subscribers_fts(rowid, name, email) VALUES (new.id, new.name, new.email);
END;
CREATE TRIGGER IF NOT EXISTS spike_subscribers_ad AFTER DELETE ON spike_subscribers BEGIN
  INSERT INTO spike_subscribers_fts(spike_subscribers_fts, rowid, name, email)
    VALUES ('delete', old.id, old.name, old.email);
END;
CREATE TRIGGER IF NOT EXISTS spike_subscribers_au AFTER UPDATE OF name, email ON spike_subscribers BEGIN
  INSERT INTO spike_subscribers_fts(spike_subscribers_fts, rowid, name, email)
    VALUES ('delete', old.id, old.name, old.email);
  INSERT INTO spike_subscribers_fts(rowid, name, email) VALUES (new.id, new.name, new.email);
END;
CREATE TABLE IF NOT EXISTS spike_campaigns (
  id INTEGER PRIMARY KEY, max_subscriber_id INTEGER NOT NULL,
  last_subscriber_id INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS spike_events (
  id INTEGER PRIMARY KEY,
  subscriber_id INTEGER NOT NULL REFERENCES spike_subscribers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS spike_events_subscriber_name_time
  ON spike_events(subscriber_id, name, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS spike_events_idempotency
  ON spike_events(subscriber_id, idempotency_key);
`;
