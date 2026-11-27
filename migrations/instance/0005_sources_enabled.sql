-- B162a (D188): the instance switch `sources.enabled` is off on a new instance, but an upgrade must
-- keep a running source working. Whether a project names a source lives in each project's own
-- database, which this migration cannot read, so an instance that already serves projects gets a
-- mark here; at start, once every project is open and migrated, src/settings/instance.ts turns the
-- switch on when any project has a non-empty `source.url` and removes the mark. A fresh instance
-- registers its first project after its migrations, so it gets no mark. The mark is a settings row
-- that `defaults` does not name, like `restore.hold`, so the settings API neither shows nor writes it.
-- Owned by src/settings.
INSERT OR IGNORE INTO settings (key, value)
SELECT 'sources.enabled_upgrade', 'true'
WHERE EXISTS (SELECT 1 FROM projects);
