// The `backup` command. Not ported: listmonk has no backup command.
import { createRealClock } from "@/clock";
import { createBackup, inspectBackup, releaseHold, type Inspection } from "@/backup/snapshot";
import { productionMigrations } from "@/db/migrations";

export const backupHelp = `
Usage: iglo.email backup [options]
       iglo.email backup --verify <path>
       iglo.email backup --release-hold --consent-reconciled [--data-dir <path>]

Write a consistent backup of a data directory, while the server runs or not:
  --output <path>        Backup directory to create
                         (default: <data-dir>/backups/iglo-email-<time>)
  --force                Replace an existing backup at that path
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
  --verify <path>        Check a backup read-only and report its schema version and hold
  --release-hold         End a restored install's sending hold, with the server stopped
  --consent-reconciled   Required with --release-hold: states that opt-outs and deliveries
                         after the backup were reconciled (docs/operations.md, Restore)
`;

type Environment = Record<string, string | undefined>;

interface BackupArguments {
  help: boolean;
  force: boolean;
  releaseHold: boolean;
  acknowledged: boolean;
  output?: string;
  verify?: string;
  dataDir?: string;
}

function parseArguments(args: string[]): BackupArguments {
  const parsed: BackupArguments = {
    help: false,
    force: false,
    releaseHold: false,
    acknowledged: false,
  };
  const valued = { "--output": "output", "--verify": "verify", "--data-dir": "dataDir" } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help") parsed.help = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--release-hold") parsed.releaseHold = true;
    else if (arg === "--consent-reconciled") parsed.acknowledged = true;
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
  if (
    parsed.releaseHold &&
    (parsed.verify !== undefined || parsed.output !== undefined || parsed.force)
  )
    throw new Error("--release-hold cannot be combined with --verify, --output or --force");
  if (parsed.acknowledged && !parsed.releaseHold)
    throw new Error("--consent-reconciled only goes with --release-hold");
  return parsed;
}

function print(report: Inspection): void {
  process.stdout.write(
    `Schema version: ${report.schemaVersion}\n` +
      `Database: ${report.databaseBytes} bytes\n` +
      `Uploads: ${report.uploadFiles} files, ${report.uploadBytes} bytes\n` +
      (report.hold
        ? report.hold.releasedAt === null
          ? `Hold: held since ${report.hold.since}; a restored server sends nothing until released\n`
          : `Hold: released at ${report.hold.releasedAt}\n`
        : ""),
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
  const dataDir = parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  if (parsed.releaseHold) {
    if (!parsed.acknowledged)
      throw new Error(
        "--release-hold needs --consent-reconciled: restoring lost opt-outs and deliveries " +
          "after the backup is yours to do first (docs/operations.md, Restore)",
      );
    const released = releaseHold({ dataDir, clock, supportedVersion });
    process.stdout.write(
      released
        ? `Hold released at ${released.releasedAt}; sending starts with the server\n`
        : "No hold on this data directory\n",
    );
    return;
  }
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
    dataDir,
    output: parsed.output,
    force: parsed.force,
    clock,
    supportedVersion,
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`Backup: ${report.path}\n`);
  print(report);
}
