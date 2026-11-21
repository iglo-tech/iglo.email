-- B124 (D125, adopter review): suppressions:manage is a permission of its own. The built-in Super Admin
-- (role 1) holds every permission, as roles.isPrimordial requires, so an install made before it gets
-- it here. No other role gets it: a role starts without it, as a new role's editor defaults do.
UPDATE roles
  SET permissions = json_insert(permissions, '$[#]', 'suppressions:manage')
  WHERE id = 1 AND type = 'user' AND parent_id IS NULL AND list_id IS NULL AND name = 'Super Admin'
    AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'suppressions:manage');
