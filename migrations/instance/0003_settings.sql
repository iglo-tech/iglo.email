-- B139 (14-projects section 4, D154): the instance settings, stored once for every project and
-- owned by src/settings/instance.ts. The same shape as a project's settings table; the store seeds
-- the instance defaults on open.

CREATE TABLE settings (
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
