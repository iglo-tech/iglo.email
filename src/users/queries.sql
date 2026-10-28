-- Adapted from listmonk queries/users.sql at 6fcd95f.
-- name: count-users
SELECT count(*) AS count FROM users;

-- name: get-user-id
SELECT * FROM users WHERE id = ?;

-- name: get-user-name
SELECT * FROM users WHERE username = ?;

-- name: get-users
SELECT * FROM users ORDER BY
  CASE WHEN ?1 = 'username' AND ?2 = 'asc' THEN username END ASC,
  CASE WHEN ?1 = 'username' AND ?2 = 'desc' THEN username END DESC,
  CASE WHEN ?1 = 'email' AND ?2 = 'asc' THEN email END ASC,
  CASE WHEN ?1 = 'email' AND ?2 = 'desc' THEN email END DESC,
  CASE WHEN ?1 = 'loggedin_at' AND ?2 = 'asc' THEN loggedin_at END ASC NULLS LAST,
  CASE WHEN ?1 = 'loggedin_at' AND ?2 = 'desc' THEN loggedin_at END DESC NULLS FIRST,
  CASE WHEN ?1 = 'created_at' AND ?2 = 'asc' THEN created_at END ASC NULLS LAST,
  CASE WHEN ?1 = 'created_at' AND ?2 = 'desc' THEN created_at END DESC NULLS FIRST;

-- name: create-user
INSERT INTO users(username, password_login, password, email, name, type, user_role_id, list_role_id, status, twofa_type, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *;

-- name: update-user
UPDATE users SET username = ?, password_login = ?, password = ?, email = ?, name = ?, type = ?, user_role_id = ?, list_role_id = ?, status = ?, updated_at = ? WHERE id = ? RETURNING *;

-- name: update-profile
UPDATE users SET name = ?, email = ?, password = ?, updated_at = ? WHERE id = ? RETURNING *;

-- name: update-login
UPDATE users SET loggedin_at = ? WHERE id = ?;

-- name: remaining-super-admins
SELECT count(*) AS count FROM users WHERE type = 'user' AND status = 'enabled' AND user_role_id = 1 AND id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?));

-- name: delete-users
DELETE FROM users WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?));

-- name: get-session
SELECT id, data, created_at FROM sessions WHERE id = ?;

-- name: create-session
INSERT INTO sessions(id, data, created_at) VALUES (?, ?, ?);

-- name: delete-session
DELETE FROM sessions WHERE id = ?;

-- name: delete-user-sessions
DELETE FROM sessions WHERE json_extract(data, '$.user_id') = ? AND (? = '' OR id != ?);

-- name: assigned-role-count
SELECT count(*) AS count FROM users WHERE user_role_id = ? OR list_role_id = ?;

-- name: set-twofa
UPDATE users SET twofa_type = ?, twofa_key = ?, updated_at = ? WHERE id = ?;
