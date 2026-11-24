-- B138b (D142, D151): the instance database's project registry, owned by src/projects/registry.ts.
-- A project is one directory under projects/<slug>/ with its own database; this file only names it.

CREATE TABLE projects (
  slug TEXT PRIMARY KEY CHECK (
    length(slug) BETWEEN 1 AND 40
    AND slug GLOB '[a-z0-9]*'
    AND slug NOT GLOB '*[^a-z0-9-]*'
  ),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
);
-- At most one primary project.
CREATE UNIQUE INDEX projects_one_primary ON projects(is_primary) WHERE is_primary = 1;

-- Stored lowercase without a port, so a request's Host matches it exactly once normalized.
CREATE TABLE hostnames (
  hostname TEXT PRIMARY KEY CHECK (hostname = lower(hostname) AND length(hostname) > 0),
  project TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'extra'))
);
-- One main hostname per project.
CREATE UNIQUE INDEX hostnames_one_main ON hostnames(project) WHERE kind = 'main';
CREATE INDEX hostnames_project ON hostnames(project);
