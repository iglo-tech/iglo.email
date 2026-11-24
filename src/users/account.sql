-- B140 (D153): the instance admin account and its instance sessions. Native.
-- name: get-account
SELECT username, password, twofa_type, twofa_key, email FROM admin_account WHERE id = 1;

-- name: create-account
INSERT INTO admin_account(id, username, password, twofa_type, twofa_key, email, created_at, updated_at)
VALUES (1, ?, ?, 'none', NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING;

-- name: set-credentials
UPDATE admin_account SET password = ?, twofa_type = ?, twofa_key = ?, updated_at = ? WHERE id = 1;

-- name: create-session
INSERT INTO admin_sessions(id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?);

-- name: get-session
SELECT id, csrf, created_at, expires_at FROM admin_sessions WHERE id = ?;

-- name: delete-session
DELETE FROM admin_sessions WHERE id = ?;

-- name: delete-sessions
DELETE FROM admin_sessions WHERE (? = '' OR id != ?);

-- name: purge-sessions
DELETE FROM admin_sessions WHERE expires_at <= ?;
