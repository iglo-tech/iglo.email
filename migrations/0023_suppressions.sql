-- B124 (D125): a self-wipe leaves a suppression, so the same person is not re-opted into marketing
-- when an event, a request or an import creates them again. A suppression names the person only by
-- HMAC-SHA-256 of their normalised e-mail and, when set, of their external ID, keyed with one random
-- 32-byte secret per database. The secret is made here, once, and read only by the subscribers
-- module; no route returns it or a hash. `lists` holds the numeric list IDs the person had.
CREATE TABLE suppression_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret BLOB NOT NULL
);
INSERT INTO suppression_keys (id, secret) VALUES (1, randomblob(32));
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  external_hash TEXT,
  lists TEXT NOT NULL,
  wiped_at TEXT NOT NULL
);
CREATE INDEX idx_suppressions_email ON suppressions(email_hash);
CREATE INDEX idx_suppressions_external ON suppressions(external_hash);
