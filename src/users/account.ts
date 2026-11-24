// The instance admin account (14-projects section 5, B140, D153). Native: listmonk has one database
// and no account above its users. The account lives in instance.db; every project holds a copy of it
// as a Super Admin user row (store.ts `syncCopy`). Its sessions are the `instance_session` cookies.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import sql from "@/users/account.sql" with { type: "text" };

/** What a copy shares with the account: the password hash and the second factor. */
export interface AdminCredentials {
  readonly password: string;
  readonly twofaType: "none" | "totp";
  readonly twofaKey: string | null;
}

export interface AdminAccount extends AdminCredentials {
  readonly username: string;
  readonly email: string | null;
}

interface AccountRow {
  username: string;
  password: string;
  twofa_type: "none" | "totp";
  twofa_key: string | null;
  email: string | null;
}

interface SessionRow {
  id: string;
  csrf: string;
  created_at: string;
  expires_at: bigint;
}

/** The users module's store of instance.db's `admin_account` and `admin_sessions` tables. */
export function createAdminAccountStore(db: Database, clock: Clock) {
  const queries = prepareNamedQueries(db, [{ name: "account", sql }]);
  const now = () => clock.now().toISOString();
  const get = (): AdminAccount | null => {
    const row = queries.get("get-account").get() as AccountRow | null;
    return row
      ? {
          username: row.username,
          password: row.password,
          twofaType: row.twofa_type,
          twofaKey: row.twofa_key,
          email: row.email,
        }
      : null;
  };
  return {
    get,
    /** The first account, only while there is none. True when this call created it. */
    create(username: string, hash: string): boolean {
      const time = now();
      return queries.get("create-account").run(username, hash, time, time).changes === 1;
    },
    /**
     * New credentials, and every instance session ends but `keepSession` (the one that changed
     * them, if it was an instance session), in one transaction of instance.db.
     */
    setCredentials(credentials: AdminCredentials, keepSession = ""): boolean {
      return writeTransaction(db, () => {
        const changed = queries
          .get("set-credentials")
          .run(credentials.password, credentials.twofaType, credentials.twofaKey, now());
        if (changed.changes !== 1) {
          return false;
        }
        queries.get("delete-sessions").run(keepSession, keepSession);
        return true;
      });
    },
    createSession(id: string, csrf: string, duration: number): boolean {
      const created = clock.now().getTime();
      const expires = created + duration;
      if (!Number.isSafeInteger(expires) || expires <= created || !get()) {
        return false;
      }
      queries.get("purge-sessions").run(created);
      queries.get("create-session").run(id, csrf, new Date(created).toISOString(), expires);
      return true;
    },
    /** A live session's CSRF token, or null when it is unknown, expired or from the future. */
    session(id: string): { csrf: string } | null {
      const row = queries.get("get-session").get(id) as SessionRow | null;
      if (!row) {
        return null;
      }
      const time = clock.now().getTime();
      const created = Date.parse(row.created_at);
      if (!Number.isFinite(created) || created > time || Number(row.expires_at) <= time) {
        return null;
      }
      return get() ? { csrf: row.csrf } : null;
    },
    deleteSession(id: string): void {
      queries.get("delete-session").run(id);
    },
    close: () => queries.close(),
  };
}

export type AdminAccountStore = ReturnType<typeof createAdminAccountStore>;
