-- B140 (14-projects section 5, D153): the one user row that is the instance admin's copy. The
-- instance writes its password and TOTP; a project's API and UI cannot delete, disable, rename it or
-- change its role or password login. Owned by src/users/store.ts.
ALTER TABLE users ADD COLUMN admin_copy INTEGER NOT NULL DEFAULT 0 CHECK (admin_copy IN (0, 1));
-- At most one copy per project.
CREATE UNIQUE INDEX users_one_admin_copy ON users(admin_copy) WHERE admin_copy = 1;
