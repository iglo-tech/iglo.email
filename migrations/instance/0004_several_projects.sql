-- B149b r2 (D165; 14-projects section 8): whether the instance has ever served more than one
-- project, owned by src/projects/registry.ts. One row once a project other than the primary is
-- registered (or, on start, once a deleted project's snapshot is found); never removed, so the SES
-- route never looks a notice up by address after a project is deleted.

CREATE TABLE several_projects (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
-- An instance that already serves a project besides the primary.
INSERT INTO several_projects (id) SELECT 1 WHERE EXISTS (SELECT 1 FROM projects WHERE is_primary = 0);
