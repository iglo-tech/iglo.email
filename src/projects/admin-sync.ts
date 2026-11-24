// The admin sync (14-projects sections 3 and 5, invariants 1 and 6; B140, D153). Native. The one
// admin account lives in instance.db; every project holds a copy. A password or TOTP change, from
// wherever it comes, writes instance.db first and then every project's copy. A crash between the
// writes leaves some copies stale; the next start writes the account into every copy again, because
// the instance is the source. Projects are reached only through their narrow `syncAdmin`.
import type { AdminAccount, AdminAccountStore, AdminCredentials } from "@/users/account";

export interface AdminCopyHolder {
  readonly slug: string;
  /** Writes the account into this project's copy, with a reset's session effect when it changed. */
  syncAdmin(account: AdminAccount): void;
}

export interface AdminSyncOptions {
  readonly account: AdminAccountStore;
  /** The projects being served now, read at each change (a runtime add or remove included). */
  readonly projects: () => Iterable<AdminCopyHolder>;
  /** An attention line: a copy that a change could not reach until the next start. */
  readonly attention: (message: string) => void;
}

export function createAdminSync(options: AdminSyncOptions) {
  const { account } = options;
  /**
   * New credentials from `source` (a project's slug, or null for the instance itself): instance.db
   * first, ending every instance session but `keepSession`; then each other project's copy. A
   * failed instance write throws, so the source's own change rolls back with it.
   */
  function change(source: string | null, credentials: AdminCredentials, keepSession = ""): void {
    if (!account.setCredentials(credentials, keepSession)) {
      throw new Error("There is no admin account to change");
    }
    const current = account.get();
    if (!current) {
      throw new Error("There is no admin account to change");
    }
    for (const project of options.projects()) {
      if (project.slug === source) {
        continue;
      }
      try {
        project.syncAdmin(current);
      } catch {
        options.attention(
          `The admin's copy in project ${project.slug} was not updated; the next start updates it`,
        );
      }
    }
  }
  return {
    /** The account, or null when the instance has none (D153: projects behave as before). */
    account: (): AdminAccount | null => account.get(),
    change,
  };
}

export type AdminSync = ReturnType<typeof createAdminSync>;
