// The `reset-password` command (D67). Not ported: listmonk recovers through its mail link alone,
// which a held install must not send. Here the operator proves control of the machine instead.
import { createRealClock } from "@/clock";
import { must } from "@/invariant";
import type { Clock } from "@/clock";
import { withStoppedDatabase } from "@/db/connection";
import { productionMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { hashPassword, validPassword } from "@/users/password";
import { createUserStore } from "@/users/store";
import type { AdminAccount, AdminCredentials } from "@/users/account";

/**
 * Acts on the instance admin account and every project's copy when `username` is the admin's
 * (B140); returns the account as it was, or null for any other name. main() passes
 * src/projects/admin-recovery.ts's `recoverAdmin`.
 */
export type AdminRecovery = (options: {
  dataDir: string;
  username: string;
  clock: Clock;
  change: (account: AdminAccount) => AdminCredentials;
}) => AdminAccount | null;

export const resetPasswordHelp = `
Usage: iglo.email reset-password --user <name> [--data-dir <path>]

Set a user's password with the server stopped, reading it from stdin. A restore hold stays, the
user's sessions end, and a second factor stays required. The instance admin's name changes the
admin account and its copy in every project; any other name is a user of the primary project:
  --user <name>          The account
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
`;

export const resetTotpHelp = `
Usage: iglo.email reset-totp --user <name> [--data-dir <path>]

Turn off a user's TOTP second factor with the server stopped, for a lost device. The user's
sessions end and they log in with their password alone, then can enroll again. The instance admin's
name acts on the admin account and its copy in every project; any other name is a user of the
primary project:
  --user <name>          The account
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
`;

interface ResetArguments {
  help: boolean;
  user?: string;
  dataDir?: string;
}

function parseArguments(args: Array<string>): ResetArguments {
  const parsed: ResetArguments = { help: false };
  const valued = { "--user": "user", "--data-dir": "dataDir" } as const;
  const isValuedFlag = (name: string): name is keyof typeof valued => Object.hasOwn(valued, name);
  for (let i = 0; i < args.length; i++) {
    const arg = must(args[i], "argument");
    if (arg === "--help") {
      parsed.help = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!isValuedFlag(name)) {
      throw new Error(`Unknown flag: ${name}`);
    }
    const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.trim() === "" || value.includes("\0")) {
      throw new Error(`${name} requires a value`);
    }
    parsed[valued[name]] = value;
  }
  return parsed;
}

export interface RecoveryOptions {
  dataDir: string;
  username: string;
  password: string;
  clock: Clock;
  supportedVersion: number;
}

export async function recoverPassword(options: RecoveryOptions): Promise<void> {
  const { dataDir, username, password, clock, supportedVersion } = options;
  if (!validPassword(password)) {
    throw new Error("A password must be 8 to 2000 bytes long");
  }
  const hash = await hashPassword(password);
  withStoppedDatabase(dataDir, supportedVersion, (db) => {
    const lists = createListReferences(db);
    const roles = createRoles(db, lists);
    const users = createUserStore(db, clock, roles);
    try {
      const user = users.byName(username);
      if (!user) {
        throw new Error(`No user named ${username}`);
      }
      if (!users.setPassword(user.id, hash)) {
        throw new Error(`${username} is not an enabled account with password login`);
      }
    } finally {
      users.close();
      roles.close();
      lists.close();
    }
  });
}

export async function runResetPassword(
  args: Array<string>,
  env: Record<string, string | undefined>,
  admin?: AdminRecovery,
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(resetPasswordHelp);
    return;
  }
  if (parsed.user === undefined) {
    throw new Error("--user is required");
  }
  const dataDir = parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  // The line a pipe or a here-string ends with is not part of it.
  const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  const clock = createRealClock();
  if (admin) {
    if (!validPassword(password)) {
      throw new Error("A password must be 8 to 2000 bytes long");
    }
    const hash = await hashPassword(password);
    const changed = admin({
      dataDir,
      username: parsed.user,
      clock,
      change: (account) => ({
        password: hash,
        twofaType: account.twofaType,
        twofaKey: account.twofaKey,
      }),
    });
    if (changed) {
      process.stdout.write(
        `Password set for ${parsed.user} in the instance and every project; their sessions have ended\n`,
      );
      return;
    }
  }
  await recoverPassword({
    dataDir,
    username: parsed.user,
    password,
    clock,
    supportedVersion: productionMigrations.length,
  });
  process.stdout.write(`Password set for ${parsed.user}; their sessions have ended\n`);
}

/** Whether the user had a TOTP to turn off. */
export async function recoverTotp(options: Omit<RecoveryOptions, "password">): Promise<boolean> {
  const { dataDir, username, clock, supportedVersion } = options;
  let had = false;
  withStoppedDatabase(dataDir, supportedVersion, (db) => {
    const lists = createListReferences(db);
    const roles = createRoles(db, lists);
    const users = createUserStore(db, clock, roles);
    try {
      const user = users.byName(username);
      if (!user) {
        throw new Error(`No user named ${username}`);
      }
      had = user.twofa_type !== "none";
      users.clearFactor(user.id);
    } finally {
      users.close();
      roles.close();
      lists.close();
    }
  });
  return had;
}

export async function runResetTotp(
  args: Array<string>,
  env: Record<string, string | undefined>,
  admin?: AdminRecovery,
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(resetTotpHelp);
    return;
  }
  if (parsed.user === undefined) {
    throw new Error("--user is required");
  }
  const dataDir = parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  const clock = createRealClock();
  const before = admin?.({
    dataDir,
    username: parsed.user,
    clock,
    change: (account) => ({ password: account.password, twofaType: "none", twofaKey: null }),
  });
  const had = before
    ? before.twofaType !== "none"
    : await recoverTotp({
        dataDir,
        username: parsed.user,
        clock,
        supportedVersion: productionMigrations.length,
      });
  process.stdout.write(
    had
      ? `TOTP turned off for ${parsed.user}; their sessions have ended\n`
      : `${parsed.user} has no TOTP: nothing to turn off; their sessions have ended\n`,
  );
}
