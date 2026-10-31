// The `reset-password` command (D67). Not ported: listmonk recovers through its mail link alone,
// which a held install must not send. Here the operator proves control of the machine instead.
import { createRealClock, type Clock } from "@/clock";
import { withStoppedDatabase } from "@/db/connection";
import { productionMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { hashPassword, validPassword } from "@/users/password";
import { createUserStore } from "@/users/store";

export const resetPasswordHelp = `
Usage: iglo.email reset-password --user <name> [--data-dir <path>]

Set a user's password with the server stopped, reading it from stdin. A restore hold stays, the
user's sessions end, and a second factor stays required:
  --user <name>          The account
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
`;

interface ResetArguments {
  help: boolean;
  user?: string;
  dataDir?: string;
}

function parseArguments(args: string[]): ResetArguments {
  const parsed: ResetArguments = { help: false };
  const valued = { "--user": "user", "--data-dir": "dataDir" } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help") {
      parsed.help = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!Object.hasOwn(valued, name)) throw new Error(`Unknown flag: ${name}`);
    const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.trim() === "" || value.includes("\0"))
      throw new Error(`${name} requires a value`);
    parsed[valued[name as keyof typeof valued]] = value;
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
  if (!validPassword(password)) throw new Error("A password must be 8 to 2000 bytes long");
  const hash = await hashPassword(password);
  withStoppedDatabase(dataDir, supportedVersion, (db) => {
    const lists = createListReferences(db);
    const roles = createRoles(db, lists);
    const users = createUserStore(db, clock, roles);
    try {
      const user = users.byName(username);
      if (!user) throw new Error(`No user named ${username}`);
      if (!users.setPassword(user.id, hash))
        throw new Error(`${username} is not an enabled account with password login`);
    } finally {
      users.close();
      roles.close();
      lists.close();
    }
  });
}

export async function runResetPassword(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(resetPasswordHelp);
    return;
  }
  if (parsed.user === undefined) throw new Error("--user is required");
  await recoverPassword({
    dataDir: parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data",
    username: parsed.user,
    // The line a pipe or a here-string ends with is not part of it.
    password: (await Bun.stdin.text()).replace(/\r?\n$/, ""),
    clock: createRealClock(),
    supportedVersion: productionMigrations.length,
  });
  process.stdout.write(`Password set for ${parsed.user}; their sessions have ended\n`);
}
