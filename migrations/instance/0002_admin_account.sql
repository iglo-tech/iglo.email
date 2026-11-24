-- B140 (14-projects section 5, D153): the one admin account and its instance sessions, owned by
-- src/users/account.ts. Every project holds a copy of the account as a Super Admin user row.

CREATE TABLE admin_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 2000),
  password TEXT NOT NULL,
  twofa_type TEXT NOT NULL DEFAULT 'none' CHECK (twofa_type IN ('none', 'totp')),
  twofa_key TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- `instance_session` cookies: the id, the CSRF token it pairs with, and when it ends (ms).
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
