// Adapted from listmonk internal/core/users.go and queries/users.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { Roles } from "@/roles/roles";
import type { AdminAccount, AdminCredentials } from "@/users/account";
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

/** A first user; the store adds the Super Admin role, which the bootstrap always uses. */
export type BootstrapUser = Omit<UserFields, "userRoleId" | "listRoleId" | "twofaType">;

interface SessionRow {
  id: string;
  data: string;
  created_at: string;
}
export interface SessionData {
  user_id: string;
  csrf: string;
  expires_at: number;
}

/**
 * A change to the instance admin's copy that a project's API or UI may not make: delete, disable,
 * rename, or change its role, type or password login (14-projects section 5, B140).
 */
export class CopyProtectedError extends Error {
  constructor() {
    super("The instance admin cannot be changed here");
  }
}

/** A project user named as the instance admin, other than its copy (B140). */
export class UsernameReservedError extends Error {
  constructor() {
    super("The username belongs to the instance admin");
  }
}

/** The email a new copy gets, as the bootstrap admin always had (it is the project's own field). */
const copyEmail = "initial-admin@localhost.invalid";

const noop = () => {};
export function createUserStore(db: Database, clock: Clock, roles: Roles) {
  const queries = prepareNamedQueries(db, [{ name: "users", sql }]);
  const count = () => (queries.get("count-users").get() as { count: bigint }).count;
  const byId = (id: bigint): UserRow | null => queries.get("get-user-id").get(id) as UserRow | null;
  const byName = (name: string): UserRow | null =>
    queries.get("get-user-name").get(name) as UserRow | null;
  const byEmail = (email: string): UserRow | null =>
    queries.get("get-user-email").get(email) as UserRow | null;
  const now = () => clock.now().toISOString();
  const revoke = (id: bigint, except = "") =>
    queries.get("delete-user-sessions").run(String(id), except, except);
  const remaining = (ids: Array<bigint>) =>
    (
      queries.get("remaining-super-admins").get(JSON.stringify(ids.map(String))) as {
        count: bigint;
      }
    ).count;
  let onMutation: (id: bigint) => void = noop;
  let onAdminChange: (credentials: AdminCredentials) => void = noop;
  const copy = (): UserRow | null => queries.get("get-admin-copy").get() as UserRow | null;
  /**
   * Inside the transaction that changed the copy: the instance writes itself, then every other
   * project's copy, before this project's transaction commits (D153). A failed instance write throws
   * and rolls this one back.
   */
  function writeThrough(previous: UserRow, updated: UserRow | null): void {
    if (
      previous.admin_copy === 1n &&
      updated?.password &&
      (updated.password !== previous.password ||
        updated.twofa_type !== previous.twofa_type ||
        updated.twofa_key !== previous.twofa_key)
    ) {
      onAdminChange({
        password: updated.password,
        twofaType: updated.twofa_type,
        twofaKey: updated.twofa_key,
      });
    }
  }
  /** A name only the copy may hold, compared as `get-user-name` compares (exactly). */
  function reserved(username: string, id?: bigint): void {
    const current = copy();
    if (current && current.username === username && current.id !== id) {
      throw new UsernameReservedError();
    }
  }
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
    onIdentityMutation(callback: (id: bigint) => void): void {
      onMutation = callback;
    },
    roleAssigned: (id: bigint): boolean => {
      return (queries.get("assigned-role-count").get(id, id) as { count: bigint }).count > 0n;
    },
    byId,
    byName,
    byEmail,
    /** The first users, with the built-in Super Admin role, in one transaction and only while none exist. */
    bootstrap(users: Array<BootstrapUser>): void {
      writeTransaction(db, () => {
        if (count() !== 0n) {
          return;
        }
        const userRoleId = roles.primordial(now());
        for (const user of users) {
          insert({ ...user, userRoleId, listRoleId: null });
        }
      });
    },
    list(orderBy: string, order: string): Array<UserRow> {
      const sort = ["username", "email", "created_at", "loggedin_at"].includes(orderBy)
        ? orderBy
        : "created_at";
      // B80: order takes any case (a deliberate difference from upstream's ASC).
      const direction = order === "" || order.toLowerCase() === "asc" ? "asc" : "desc";
      return queries.get("get-users").all(sort, direction) as Array<UserRow>;
    },
    create(fields: UserFields): UserRow {
      return writeTransaction(db, () => {
        reserved(fields.username);
        return insert(fields);
      });
    },
    /** The instance admin's copy in this project, or null without one. */
    copy,
    /** Called with the copy's new credentials when this project changes them (B140). */
    onAdminChange(callback: (credentials: AdminCredentials) => void): void {
      onAdminChange = callback;
    },
    /**
     * Writes the account into this project's copy: at wiring (each start and a runtime add), after
     * another place changed the credentials, and from the CLI. A row with the account's username
     * and no mark is adopted. A changed password or factor ends every session of the copy, as a
     * reset does; true when anything changed. `endSessions` ends them even when nothing changed, as
     * the CLI's reset always does.
     */
    syncCopy(account: AdminAccount, endSessions = false): boolean {
      let changedId: bigint | undefined;
      writeTransaction(db, () => {
        let target = copy();
        const named = byName(account.username);
        if (target && named && named.id !== target.id) {
          // The account's name is held by another row: that row becomes the copy.
          target = named;
        }
        target ??= named;
        const userRoleId = roles.primordial(now());
        if (!target) {
          queries.get("unmark-admin-copy").run(0n);
          const email = byEmail(copyEmail) ? `${account.username}@localhost.invalid` : copyEmail;
          const created = insert({
            username: account.username,
            passwordLogin: true,
            password: account.password,
            email,
            name: account.username,
            type: "user",
            userRoleId,
            listRoleId: null,
            status: "enabled",
          });
          queries
            .get("write-admin-copy")
            .get(
              account.username,
              account.password,
              userRoleId,
              account.twofaType,
              account.twofaKey,
              now(),
              created.id,
            );
          return;
        }
        const same =
          target.admin_copy === 1n &&
          target.username === account.username &&
          target.password === account.password &&
          target.password_login === 1n &&
          target.type === "user" &&
          target.user_role_id === userRoleId &&
          target.list_role_id === null &&
          target.status === "enabled" &&
          target.twofa_type === account.twofaType &&
          target.twofa_key === account.twofaKey;
        if (same) {
          if (endSessions) {
            revoke(target.id);
            changedId = target.id;
          }
          return;
        }
        queries.get("unmark-admin-copy").run(target.id);
        queries
          .get("write-admin-copy")
          .get(
            account.username,
            account.password,
            userRoleId,
            account.twofaType,
            account.twofaKey,
            now(),
            target.id,
          );
        revoke(target.id);
        changedId = target.id;
      });
      if (changedId !== undefined) {
        onMutation(changedId);
        return true;
      }
      return false;
    },
    update(id: bigint, resolve: (current: UserRow) => UserFields): UserRow | null {
      const result = writeTransaction(db, () => {
        const previous = byId(id);
        if (!previous) {
          return null;
        }
        // Resolve omitted fields only after obtaining the current row and the
        // write lock. Password hashing must already have finished outside here.
        const fields = resolve(previous);
        // A Super Admin who cannot log in does not count: nothing else can repair the install.
        const canAdminister =
          previous.type === "user" &&
          previous.status === "enabled" &&
          previous.user_role_id === 1n &&
          previous.password_login === 1n &&
          previous.password !== null;
        const stillCan =
          fields.type === "user" &&
          fields.status === "enabled" &&
          fields.userRoleId === 1n &&
          fields.passwordLogin &&
          fields.password !== null;
        if (canAdminister && !stillCan && remaining([id]) === 0n) {
          return null;
        }
        // After the last-admin rule, so a refusal that answered before keeps its answer (B140).
        if (
          previous.admin_copy === 1n &&
          (fields.username !== previous.username ||
            fields.status !== previous.status ||
            fields.type !== previous.type ||
            fields.userRoleId !== previous.user_role_id ||
            fields.listRoleId !== previous.list_role_id ||
            Number(fields.passwordLogin) !== Number(previous.password_login))
        ) {
          throw new CopyProtectedError();
        }
        reserved(fields.username, id);
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
        ) {
          revoke(id);
        }
        writeThrough(previous, updated);
        return updated;
      });
      if (result) {
        onMutation(id);
      }
      return result;
    },
    updateProfile(
      id: bigint,
      name: string,
      email: string,
      hash: string | null,
      sessionId: string,
    ): UserRow | null {
      const result = writeTransaction(db, () => {
        const previous = byId(id);
        if (!previous) {
          return null;
        }
        const updated = queries
          .get("update-profile")
          .get(
            name,
            previous.password_login !== 0n ? email : previous.email,
            hash ?? previous.password,
            now(),
            id,
          ) as UserRow | null;
        if (updated && hash !== null) {
          revoke(id, sessionId);
        }
        writeThrough(previous, updated);
        return updated;
      });
      if (result && hash !== null) {
        onMutation(id);
      }
      return result;
    },
    /** A password reset: applies to an enabled login user and ends all of their sessions. */
    setPassword(id: bigint, hash: string): UserRow | null {
      const updated = writeTransaction(db, () => {
        const current = byId(id);
        if (
          !current ||
          current.type !== "user" ||
          current.status !== "enabled" ||
          current.password_login === 0n
        ) {
          return null;
        }
        const result = queries.get("update-password").get(hash, now(), id) as UserRow;
        revoke(id);
        writeThrough(current, result);
        return result;
      });
      if (updated) {
        onMutation(id);
      }
      return updated;
    },
    /** Operator recovery from a lost device: any user's TOTP goes and all their sessions end. */
    clearFactor(id: bigint): UserRow | null {
      const cleared = writeTransaction(db, () => {
        const previous = byId(id);
        if (!previous) {
          return null;
        }
        queries.get("set-twofa").run("none", null, now(), id);
        revoke(id);
        const cleared = byId(id);
        writeThrough(previous, cleared);
        return cleared;
      });
      if (cleared) {
        onMutation(id);
      }
      return cleared;
    },
    setFactor(
      expected: UserRow,
      type: "none" | "totp",
      secret: string | null,
      session: string,
      revalidate: () => void,
    ): boolean {
      const changed = writeTransaction(db, () => {
        revalidate();
        const current = byId(expected.id);
        if (
          !current ||
          current.type !== "user" ||
          current.status !== "enabled" ||
          current.password_login === 0n ||
          current.password !== expected.password ||
          current.username !== expected.username ||
          current.twofa_type !== expected.twofa_type ||
          current.twofa_key !== expected.twofa_key
        ) {
          return false;
        }
        queries.get("set-twofa").run(type, secret, now(), current.id);
        revoke(current.id, session);
        writeThrough(current, byId(current.id));
        return true;
      });
      if (changed) {
        onMutation(expected.id);
      }
      return changed;
    },
    delete(ids: Array<bigint>): boolean {
      const result = writeTransaction(db, () => {
        if (!ids.length || remaining(ids) === 0n) {
          return false;
        }
        // After the last-admin rule, as for an update (B140).
        const protectedId = copy()?.id;
        if (protectedId !== undefined && ids.includes(protectedId)) {
          throw new CopyProtectedError();
        }
        const result = queries.get("delete-users").run(JSON.stringify(ids.map(String)));
        if (!result.changes) {
          return false;
        }
        for (const id of ids) {
          revoke(id);
        }
        return true;
      });
      if (result) {
        for (const id of ids) {
          onMutation(id);
        }
      }
      return result;
    },
    createSession(user: UserRow, id: string, csrf: string, duration: number): boolean {
      return writeTransaction(db, () => {
        const current = byId(user.id);
        if (
          !current ||
          current.type !== "user" ||
          current.status !== "enabled" ||
          current.password_login === 0n ||
          current.twofa_type !== user.twofa_type ||
          current.twofa_key !== user.twofa_key ||
          current.password !== user.password ||
          current.username !== user.username
        ) {
          return false;
        }
        const time = now();
        const created = Date.parse(time);
        const expires = created + duration;
        if (
          !Number.isFinite(duration) ||
          duration <= 0 ||
          !Number.isSafeInteger(expires) ||
          expires <= created ||
          expires > 8_640_000_000_000_000
        ) {
          return false;
        }
        queries
          .get("create-session")
          .run(id, JSON.stringify({ user_id: String(user.id), csrf, expires_at: expires }), time);
        queries.get("update-login").run(time, user.id);
        return true;
      });
    },
    session(id: string): { user: UserRow; csrf: string } | null {
      const row = queries.get("get-session").get(id) as SessionRow | null;
      if (!row) {
        return null;
      }
      const time = Date.parse(row.created_at);
      const currentTime = clock.now().getTime();
      if (!Number.isFinite(time) || !Number.isFinite(currentTime) || time > currentTime) {
        return null;
      }
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        return null;
      }
      if (!data || typeof data !== "object") {
        return null;
      }
      const record = data as Partial<SessionData>;
      const expires = Object.hasOwn(record, "expires_at")
        ? record.expires_at
        : time + 7 * 24 * 60 * 60 * 1000;
      if (
        typeof expires !== "number" ||
        !Number.isSafeInteger(expires) ||
        expires > 8_640_000_000_000_000 ||
        expires <= time ||
        expires <= currentTime
      ) {
        return null;
      }
      if (
        typeof record.user_id !== "string" ||
        !/^[1-9]\d*$/.test(record.user_id) ||
        typeof record.csrf !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.csrf)
      ) {
        return null;
      }
      const sessionUserId = BigInt(record.user_id);
      if (sessionUserId > 9_223_372_036_854_775_807n) {
        return null;
      }
      const user = byId(sessionUserId);
      if (
        !user ||
        user.status !== "enabled" ||
        user.type !== "user" ||
        user.password_login === 0n
      ) {
        return null;
      }
      return { user, csrf: record.csrf };
    },
    deleteSession(id: string): void {
      queries.get("delete-session").run(id);
    },
    /** Delete up to `limit` sessions expired at `now`. */
    purgeSessions: (now: Date, limit: number) => {
      return queries.get("purge-expired-sessions").all(now.getTime(), limit);
    },
    close: () => queries.close(),
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
