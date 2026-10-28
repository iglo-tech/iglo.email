// Adapted from listmonk internal/core/users.go and queries/users.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { Roles } from "@/roles/roles";
import type { UserRow } from "@/users/models";
import sql from "@/users/queries.sql" with { type: "text" };

export interface UserFields {
  username: string;
  passwordLogin: boolean;
  password: string | null;
  email: string;
  name: string;
  type: "user" | "api";
  userRoleId: bigint;
  listRoleId: bigint | null;
  status: "enabled" | "disabled";
  twofaType?: "none" | "totp";
}

interface SessionRow {
  id: string;
  data: string;
  created_at: string;
}
export interface SessionData {
  user_id: string;
  csrf: string;
}

export function createUserStore(db: Database, clock: Clock, roles: Roles) {
  const queries = prepareNamedQueries(db, [{ name: "users", sql }]);
  const count = () => (queries.get("count-users").get() as { count: bigint }).count;
  const byId = (id: bigint): UserRow | null => queries.get("get-user-id").get(id) as UserRow | null;
  const byName = (name: string): UserRow | null =>
    queries.get("get-user-name").get(name) as UserRow | null;
  const now = () => clock.now().toISOString();
  const revoke = (id: bigint, except = "") =>
    queries.get("delete-user-sessions").run(String(id), except, except);
  const remaining = (ids: bigint[]) =>
    (
      queries.get("remaining-super-admins").get(JSON.stringify(ids.map(String))) as {
        count: bigint;
      }
    ).count;
  function insert(fields: UserFields): UserRow {
    const time = now();
    return queries
      .get("create-user")
      .get(
        fields.username,
        Number(fields.passwordLogin),
        fields.password,
        fields.email,
        fields.name,
        fields.type,
        fields.userRoleId,
        fields.listRoleId,
        fields.status,
        fields.twofaType ?? "none",
        time,
        time,
      ) as UserRow;
  }
  return {
    count,
    byId,
    byName,
    bootstrap(username: string, hash: string): void {
      writeTransaction(db, () => {
        if (count() !== 0n) return;
        const userRoleId = roles.primordial(now());
        insert({
          username,
          passwordLogin: true,
          password: hash,
          email: "initial-admin@localhost.invalid",
          name: username,
          type: "user",
          userRoleId,
          listRoleId: null,
          status: "enabled",
        });
      });
    },
    list(orderBy: string, order: string): UserRow[] {
      const sort = ["username", "email", "created_at", "loggedin_at"].includes(orderBy)
        ? orderBy
        : "created_at";
      const direction = order === "" || order === "asc" ? "asc" : "desc";
      return queries.get("get-users").all(sort, direction) as UserRow[];
    },
    create(fields: UserFields): UserRow {
      return insert(fields);
    },
    update(id: bigint, resolve: (current: UserRow) => UserFields): UserRow | null {
      return writeTransaction(db, () => {
        const previous = byId(id);
        if (!previous) return null;
        // Resolve omitted fields only after obtaining the current row and the
        // write lock. Password hashing must already have finished outside here.
        const fields = resolve(previous);
        if (
          previous.type === "user" &&
          previous.status === "enabled" &&
          previous.user_role_id === 1n &&
          (fields.type !== "user" || fields.status !== "enabled" || fields.userRoleId !== 1n) &&
          remaining([id]) === 0n
        )
          return null;
        const updated = queries
          .get("update-user")
          .get(
            fields.username,
            Number(fields.passwordLogin),
            fields.password,
            fields.email,
            fields.name,
            fields.type,
            fields.userRoleId,
            fields.listRoleId,
            fields.status,
            now(),
            id,
          ) as UserRow | null;
        if (
          updated &&
          (previous.password !== updated.password ||
            previous.password_login !== updated.password_login ||
            previous.username !== updated.username ||
            previous.type !== updated.type ||
            previous.status !== updated.status)
        )
          revoke(id);
        return updated;
      });
    },
    updateProfile(
      id: bigint,
      name: string,
      email: string,
      hash: string | null,
      sessionId: string,
    ): UserRow | null {
      return writeTransaction(db, () => {
        const previous = byId(id);
        if (!previous) return null;
        const updated = queries
          .get("update-profile")
          .get(
            name,
            previous.password_login !== 0n ? email : previous.email,
            hash ?? previous.password,
            now(),
            id,
          ) as UserRow | null;
        if (updated && hash !== null) revoke(id, sessionId);
        return updated;
      });
    },
    delete(ids: bigint[]): boolean {
      return writeTransaction(db, () => {
        if (!ids.length || remaining(ids) === 0n) return false;
        const result = queries.get("delete-users").run(JSON.stringify(ids.map(String)));
        if (!result.changes) return false;
        for (const id of ids) revoke(id);
        return true;
      });
    },
    createSession(user: UserRow, id: string, csrf: string): boolean {
      return writeTransaction(db, () => {
        const current = byId(user.id);
        if (
          !current ||
          current.type !== "user" ||
          current.status !== "enabled" ||
          current.password_login === 0n ||
          current.twofa_type !== "none" ||
          current.password !== user.password ||
          current.username !== user.username
        )
          return false;
        const time = now();
        queries
          .get("create-session")
          .run(id, JSON.stringify({ user_id: String(user.id), csrf }), time);
        queries.get("update-login").run(time, user.id);
        return true;
      });
    },
    session(id: string, duration: number): { user: UserRow; csrf: string } | null {
      const row = queries.get("get-session").get(id) as SessionRow | null;
      if (!row) return null;
      const time = Date.parse(row.created_at);
      if (
        !Number.isFinite(time) ||
        time > clock.now().getTime() ||
        time + duration <= clock.now().getTime()
      )
        return null;
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        return null;
      }
      if (!data || typeof data !== "object") return null;
      const record = data as Partial<SessionData>;
      if (
        typeof record.user_id !== "string" ||
        !/^[1-9]\d*$/.test(record.user_id) ||
        typeof record.csrf !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.csrf)
      )
        return null;
      const sessionUserId = BigInt(record.user_id);
      if (sessionUserId > 9223372036854775807n) return null;
      const user = byId(sessionUserId);
      if (
        !user ||
        user.status !== "enabled" ||
        user.type !== "user" ||
        user.password_login === 0n ||
        user.twofa_type !== "none"
      )
        return null;
      return { user, csrf: record.csrf };
    },
    deleteSession(id: string): void {
      queries.get("delete-session").run(id);
    },
    close: () => queries.close(),
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
