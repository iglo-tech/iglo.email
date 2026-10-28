// Adapted from listmonk internal/core/roles.go, internal/auth/models.go and queries/roles.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import type { ListReferences } from "@/lists/references";
import sql from "@/roles/queries.sql" with { type: "text" };

export const permissions = [
  "lists:get_all",
  "lists:manage_all",
  "subscribers:get",
  "subscribers:get_all",
  "subscribers:manage",
  "subscribers:import",
  "subscribers:sql_query",
  "tx:send",
  "campaigns:get",
  "campaigns:get_all",
  "campaigns:get_analytics",
  "campaigns:manage",
  "campaigns:manage_all",
  "campaigns:send",
  "bounces:get",
  "bounces:manage",
  "webhooks:post_bounce",
  "media:get",
  "media:manage",
  "templates:get",
  "templates:manage",
  "users:get",
  "users:manage",
  "roles:get",
  "roles:manage",
  "settings:get",
  "settings:manage",
  "settings:maintain",
] as const;

interface RoleRow {
  id: bigint;
  type: string;
  name: string | null;
  permissions: string;
  parent_id: bigint | null;
  list_id: bigint | null;
}

export interface UserRole {
  id: bigint;
  name: string;
  permissions: string[];
}

export function createRoles(db: Database, lists: ListReferences) {
  const queries = prepareNamedQueries(db, [{ name: "roles", sql }]);
  const raw = (id: bigint): RoleRow | null => queries.get("get-role").get(id) as RoleRow | null;
  function role(id: bigint, type: "user" | "list"): RoleRow | null {
    const value = raw(id);
    if (!value || value.type !== type || value.parent_id !== null) return null;
    if (id === 1n && !isPrimordial(value)) return null;
    return value;
  }
  function decoded(value: RoleRow): string[] {
    const result: unknown = JSON.parse(value.permissions);
    if (!Array.isArray(result) || result.some((entry) => typeof entry !== "string"))
      throw new Error("Invalid role permissions");
    return result as string[];
  }
  function isPrimordial(value: RoleRow): boolean {
    const actual = decoded(value);
    return (
      value.type === "user" &&
      value.parent_id === null &&
      value.list_id === null &&
      value.name === "Super Admin" &&
      actual.length === permissions.length &&
      permissions.every((permission) => actual.includes(permission))
    );
  }
  return {
    primordial(now: string): bigint {
      const existing = raw(1n);
      if (existing) {
        if (!isPrimordial(existing))
          throw new Error("Cannot bootstrap: primordial role has unexpected contents");
        return 1n;
      }
      const count = (queries.get("role-count").get() as { count: bigint }).count;
      if (count !== 0n) throw new Error("Cannot bootstrap: unexpected existing roles");
      const inserted = queries
        .get("create-primordial-role")
        .get(JSON.stringify(permissions), now, now) as { id: bigint };
      if (inserted.id !== 1n)
        throw new Error("Cannot bootstrap: primordial role identity is unavailable");
      return inserted.id;
    },
    userRole(id: bigint): UserRole | null {
      const value = role(id, "user");
      return value ? { id: value.id, name: value.name ?? "", permissions: decoded(value) } : null;
    },
    createUserRole(name: string, granted: readonly string[], now: string): bigint {
      const row = queries.get("create-user-role").get(name, JSON.stringify(granted), now, now) as {
        id: bigint;
      };
      return row.id;
    },
    createListRole(name: string, now: string): bigint {
      const row = queries.get("create-list-role").get(name, now, now) as { id: bigint };
      return row.id;
    },
    hasRole(id: bigint, type: "user" | "list"): boolean {
      return role(id, type) !== null;
    },
    listRole(id: bigint, forList = false) {
      const value = role(id, "list");
      if (!value) return null;
      const children = queries.get("list-role-children").all(id) as RoleRow[];
      const entries = children.map((item) => ({
        id: item.list_id ?? 0n,
        name: item.list_id === null ? "" : (lists.name(item.list_id) ?? ""),
        permissions: decoded(item),
      }));
      if (forList && entries.length === 0) {
        entries.push({
          id: value.list_id ?? 0n,
          name: value.list_id === null ? "" : (lists.name(value.list_id) ?? ""),
          permissions: decoded(value),
        });
      }
      return {
        id: value.id,
        name: value.name ?? "",
        lists: entries.length ? entries : null,
      };
    },
    can(role: UserRole, permission: string): boolean {
      return role.id === 1n || role.permissions.includes(permission);
    },
    close: () => queries.close(),
  };
}

export type Roles = ReturnType<typeof createRoles>;
