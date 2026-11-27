-- B162a (D188): a project names its source's connector in `source.connector`. Every source an
-- earlier build stored is a PocketBase one, so a project whose `source.url` is non-empty gets
-- `pocketbase`; nothing else changes. Idempotent: a stored connector other than none is kept, and a
-- project without a URL keeps none (the store seeds the empty default). Owned by src/settings.
INSERT INTO settings (key, value)
SELECT 'source.connector', '"pocketbase"'
FROM settings
WHERE key = 'source.url' AND json_type(value) = 'text' AND trim(json_extract(value, '$')) <> ''
ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value IN ('""', 'null');
