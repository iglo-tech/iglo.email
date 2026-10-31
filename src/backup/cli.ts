// The `backup` command. Not ported: listmonk has no backup command.
import { createRealClock } from "@/clock";
import { createBackup, inspectBackup, type Inspection } from "@/backup/snapshot";
import { productionMigrations } from "@/db/migrations";

export const backupHelp = `
Usage: iglo.email backup [options]
       iglo.email backup --verify <path>

Write a consistent backup of a data directory, while the server runs or not:
  --output <path>        Backup directory to create
                         (default: <data-dir>/backups/iglo-email-<time>)
  --force                Replace an existing backup at that path
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
  --verify <path>        Check a backup read-only and report its schema version
`;

type Environment = Record<string, string | undefined>;

interface BackupArguments {
  help: boolean;
  force: boolean;
  output?: string;
  verify?: string;
  dataDir?: string;
}

function parseArguments(args: string[]): BackupArguments {
  const parsed: BackupArguments = { help: false, force: false };
  const valued = { "--output": "output", "--verify": "verify", "--data-dir": "dataDir" } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help") parsed.help = true;
    else if (arg === "--force") parsed.force = true;
    else {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (!Object.hasOwn(valued, name)) throw new Error(`Unknown flag: ${name}`);
      const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
      if (value === undefined || value.trim() === "" || value.includes("\0"))
        throw new Error(`${name} requires a value`);
      parsed[valued[name as keyof typeof valued]] = value;
    }
  }
  if (parsed.verify !== undefined && (parsed.output !== undefined || parsed.force))
    throw new Error("--verify cannot be combined with --output or --force");
  return parsed;
}

function print(report: Inspection): void {
  process.stdout.write(
    `Schema version: ${report.schemaVersion}\n` +
      `Database: ${report.databaseBytes} bytes\n` +
      `Uploads: ${report.uploadFiles} files, ${report.uploadBytes} bytes\n`,
  );
  // Not a failure: such a row behaves as a missing attachment does, here as on the live server.
  for (const name of report.missing)
    process.stderr.write(`A media row names a file the backup lacks: ${name}\n`);
}

export function runBackup(args: string[], env: Environment): void {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(backupHelp);
    return;
  }
  const clock = createRealClock();
  const supportedVersion = productionMigrations.length;
  if (parsed.verify !== undefined) {
    const report = inspectBackup(parsed.verify, clock, supportedVersion);
    print(report);
    if (report.schemaVersion > supportedVersion)
      throw new Error(
        `Database version ${report.schemaVersion} is ahead of this executable, which supports ` +
          `${supportedVersion}: restore it with a newer one`,
      );
    process.stdout.write(
      report.schemaVersion < supportedVersion
        ? `Integrity: ok; the server migrates this backup to version ${supportedVersion}\n`
        : "Integrity: ok\n",
    );
    return;
  }
  const report = createBackup({
    dataDir: parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data",
    output: parsed.output,
    force: parsed.force,
    clock,
    supportedVersion,
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`Backup: ${report.path}\n`);
  print(report);
}
