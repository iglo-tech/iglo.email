// `reset-password` and `reset-totp` for the instance admin (14-projects sections 5 and 12; B140,
// D153). Native. With the server stopped and under the one lock: instance.db first, then every
// registered project's copy, each with a reset's session effect (every session ends). A crash between
// the writes is repaired at the next start, which writes the account into every copy again.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "@/clock";
import { holdDataDirectory } from "@/db/instance-lock";
import { instanceMigrations, productionMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import {
  INSTANCE_DATABASE,
  oldLayoutMessage,
  projectDirectory,
  usesOldLayout,
} from "@/projects/layout";
import { createRegistry } from "@/projects/registry";
import { createRoles } from "@/roles/roles";
import { createAdminAccountStore } from "@/users/account";
import type { AdminAccount, AdminCredentials } from "@/users/account";
import { createUserStore } from "@/users/store";

/** A database a stopped server left, opened alone, as withStoppedDatabase opens one (D67). */
function openStopped(path: string, supportedVersion: number): Database {
  if (!existsSync(path)) {
    throw new Error(`No database at ${path}`);
  }
  const db = new Database(path, { readwrite: true, strict: true, safeIntegers: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.run("BEGIN IMMEDIATE");
    } catch {
      throw new Error(`${path} is in use: stop what has it open first`);
    }
    const version = db.query<{ user_version: bigint }, []>("PRAGMA user_version").get();
    db.run("ROLLBACK");
    const current = Number(version?.user_version ?? 0n);
    if (current > supportedVersion) {
      throw new Error(`Database version ${current} is ahead of this executable`);
    }
    if (current < supportedVersion) {
      throw new Error(`${path} is not migrated yet; start the server once`);
    }
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/**
 * Changes the admin account when `username` is its name and returns the account as it was; returns
 * null, writing nothing, when the instance has no account or another name. `change` gets the
 * account and returns its new credentials.
 */
export function recoverAdmin(options: {
  dataDir: string;
  username: string;
  clock: Clock;
  change: (account: AdminAccount) => AdminCredentials;
}): AdminAccount | null {
  const root = resolve(options.dataDir);
  if (usesOldLayout(root)) {
    throw new Error(oldLayoutMessage(root));
  }
  const path = join(root, INSTANCE_DATABASE);
  // Before the lock, which would create the directory.
  if (!existsSync(path)) {
    throw new Error(`No database at ${path}`);
  }
  const lock = holdDataDirectory(root);
  try {
    const instance = openStopped(path, instanceMigrations.length);
    try {
      const account = createAdminAccountStore(instance, options.clock);
      const registry = createRegistry(instance, options.clock);
      try {
        const before = account.get();
        if (!before || before.username !== options.username) {
          return null;
        }
        // Each project is checked before anything is written, so a refusal writes nothing.
        const projects = registry.list().map((record) => {
          const db = openStopped(
            join(projectDirectory(root, record.slug), "iglo-email.db"),
            productionMigrations.length,
          );
          return { slug: record.slug, db };
        });
        try {
          if (!account.setCredentials(options.change(before))) {
            throw new Error("The admin account could not be changed");
          }
          const after = account.get() ?? before;
          for (const project of projects) {
            const lists = createListReferences(project.db);
            const roles = createRoles(project.db, lists);
            const users = createUserStore(project.db, options.clock, roles);
            try {
              users.syncCopy(after, true);
            } finally {
              users.close();
              roles.close();
              lists.close();
            }
          }
          return before;
        } finally {
          for (const project of projects) {
            project.db.close(true);
          }
        }
      } finally {
        registry.close();
        account.close();
      }
    } finally {
      instance.close(true);
    }
  } finally {
    lock.release();
  }
}
