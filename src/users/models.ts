// Adapted from listmonk internal/auth/models.go and internal/core/users.go at 6fcd95f.
import type { Roles, UserRole } from "@/roles/roles";

export interface UserRow {
  id: bigint;
  username: string;
  password_login: bigint;
  password: string | null;
  email: string;
  name: string;
  avatar: string | null;
  type: "user" | "api";
  user_role_id: bigint;
  list_role_id: bigint | null;
  status: "enabled" | "disabled";
  twofa_type: "none" | "totp";
  loggedin_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Identity {
  readonly user: UserRow;
  readonly role: UserRole;
  readonly transport: "header" | "session";
  readonly sessionId?: string;
  readonly csrf?: string;
}

function jsonID(id: bigint): number | object {
  if (id <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(id);
  const rawJSON = (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON;
  return rawJSON(id.toString());
}

export function projectUser(user: UserRow, roles: Roles, token?: string, forList = false) {
  const role = roles.userRole(user.user_role_id);
  if (!role) throw new Error("User has an invalid role");
  const listRole = user.list_role_id === null ? null : roles.listRole(user.list_role_id, forList);
  return {
    id: jsonID(user.id),
    created_at: user.created_at,
    updated_at: user.updated_at,
    username: user.username,
    password: token ?? null,
    // listmonk's setupUserFields reports any stored credential as password_login.
    password_login: user.password !== null || user.password_login !== 0n,
    email: user.type === "api" ? null : user.email,
    name: user.name,
    type: user.type,
    status: user.status,
    avatar: user.avatar,
    twofa_type: user.twofa_type,
    loggedin_at: user.loggedin_at,
    ...(user.list_role_id === null ? {} : { list_role_id: jsonID(user.list_role_id) }),
    user_role: { ...role, id: jsonID(role.id) },
    list_role:
      listRole === null
        ? null
        : {
            ...listRole,
            id: jsonID(listRole.id),
            lists: listRole.lists?.map((item) => ({ ...item, id: jsonID(item.id) })) ?? null,
          },
  };
}
