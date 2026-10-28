-- Adapted from listmonk queries/roles.sql at 6fcd95f.
-- name: get-role
SELECT id, type, name, permissions, parent_id, list_id FROM roles WHERE id = ?;

-- name: role-count
SELECT count(*) AS count FROM roles;

-- name: create-primordial-role
INSERT INTO roles(type, name, permissions, created_at, updated_at) VALUES('user', 'Super Admin', ?, ?, ?) RETURNING id;

-- name: create-user-role
INSERT INTO roles(type, name, permissions, created_at, updated_at) VALUES('user', ?, ?, ?, ?) RETURNING id;

-- name: create-list-role
INSERT INTO roles(type, name, permissions, created_at, updated_at) VALUES('list', ?, '[]', ?, ?) RETURNING id;

-- name: list-role-children
SELECT id, type, name, permissions, parent_id, list_id FROM roles WHERE parent_id = ? AND type = 'list' ORDER BY id;
