-- B125 (D122, lead decisions): the private-target block is on by default. An earlier release seeded
-- `false` into every install, and no install can tell that seeded value from a deliberate choice, so
-- the upgrade turns a stored false on, once. A later operator's choice of false is kept: this is
-- version 24, so it runs on a database at schema 23 (version 23 is applied first), and only while
-- the row still holds false. A fresh install has no row yet, so the seed stores true.
UPDATE settings
SET value = 'true', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'webhooks.block_private_addresses' AND value = 'false';
