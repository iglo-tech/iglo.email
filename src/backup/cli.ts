// The `backup` command. Not ported: listmonk has no backup command.
import { createRealClock } from "@/clock";
import { must } from "@/invariant";
import { createBackup, inspectBackup, releaseHold } from "@/backup/snapshot";
import type { BackupOptions, Checked } from "@/backup/snapshot";
import { productionMigrations } from "@/db/migrations";

export const backupHelp = `
Usage: iglo.email backup [--project <slug>] [options]
       iglo.email backup --verify <path>
       iglo.email backup --release-hold --consent-reconciled [--project <slug>] [--data-dir <path>]

Write a consistent backup of a data directory, while the server runs or not:
  --output <path>        Backup directory to create
                         (default: <data-dir>/backups/iglo-email-<time>)
  --project <slug>       Back up that project only; without it, instance.db and every project
  --force                Replace an existing backup at that path
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
  --verify <path>        Check a backup read-only and report its schema versions and holds
  --release-hold         End a restored database's sending hold, with the server stopped:
                         instance.db's, or with --project that project's
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
  project?: string;
}

function parseArguments(args: Array<string>): BackupArguments {
  const parsed: BackupArguments = {
    help: false,
    force: false,
    releaseHold: false,
    acknowledged: false,
  };
  const valued = {
    "--output": "output",
    "--verify": "verify",
    "--data-dir": "dataDir",
    "--project": "project",
  } as const;
  const isValuedFlag = (name: string): name is keyof typeof valued => Object.hasOwn(valued, name);
  for (let i = 0; i < args.length; i++) {
    const arg = must(args[i], "argument");
    if (arg === "--help") {
      parsed.help = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--release-hold") {
      parsed.releaseHold = true;
    } else if (arg === "--consent-reconciled") {
      parsed.acknowledged = true;
    } else {
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
  }
  if (
    parsed.verify !== undefined &&
    (parsed.output !== undefined || parsed.force || parsed.project !== undefined)
  ) {
    throw new Error("--verify cannot be combined with --output, --force or --project");
  }
  if (
    parsed.releaseHold &&
    (parsed.verify !== undefined || parsed.output !== undefined || parsed.force)
  ) {
    throw new Error("--release-hold cannot be combined with --verify, --output or --force");
  }
  if (parsed.acknowledged && !parsed.releaseHold) {
    throw new Error("--consent-reconciled only goes with --release-hold");
  }
  return parsed;
}

/** A database's lines; in a whole backup each database has its place as a heading. */
function print(databases: Array<Checked>): void {
  for (const { place, inspection: report } of databases) {
    const indent = place ? "  " : "";
    const line = (text: string) => `${indent}${text}\n`;
    process.stdout.write(
      (place ? `${place}\n` : "") +
        line(`Schema version: ${report.schemaVersion}`) +
        line(`Database: ${report.databaseBytes} bytes`) +
        (place === "instance.db"
          ? ""
          : line(`Uploads: ${report.uploadFiles} files, ${report.uploadBytes} bytes`)) +
        (report.hold
          ? report.hold.releasedAt === null
            ? line(
                place === "instance.db"
                  ? `Hold: held since ${report.hold.since}; a restored instance sends nothing in any project until released`
                  : `Hold: held since ${report.hold.since}; a restored server sends nothing until released`,
              )
            : line(`Hold: released at ${report.hold.releasedAt}`)
          : ""),
    );
    // Not a failure: such a row behaves as a missing attachment does, here as on the live server.
    for (const name of report.missing) {
      process.stderr.write(
        `A media row ${place ? `of ${place} ` : ""}names a file the backup lacks: ${name}\n`,
      );
    }
  }
}

/** One result for the whole backup: every database's integrity held, and none is ahead. */
function verdict(databases: Array<Checked>): void {
  const ahead = databases.find(
    ({ inspection }) => inspection.schemaVersion > inspection.supportedVersion,
  );
  if (ahead) {
    const { schemaVersion, supportedVersion } = ahead.inspection;
    throw new Error(
      `${ahead.place ? `${ahead.place}: ` : ""}Database version ${schemaVersion} is ahead of this ` +
        `executable, which supports ${supportedVersion}: restore it with a newer one`,
    );
  }
  const behind = databases.filter(
    ({ inspection }) => inspection.schemaVersion < inspection.supportedVersion,
  );
  process.stdout.write(
    behind.length === 0
      ? "Integrity: ok\n"
      : `Integrity: ok; the server migrates this backup to version ${behind
          .map(({ place, inspection }) =>
            place ? `${inspection.supportedVersion} (${place})` : `${inspection.supportedVersion}`,
          )
          .join(", ")}\n`,
  );
}

export function runBackup(
  args: Array<string>,
  env: Environment,
  hooks: Pick<BackupOptions, "beforePublish"> = {},
): void {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(backupHelp);
    return;
  }
  const clock = createRealClock();
  const supportedVersion = productionMigrations.length;
  const dataDir = parsed.dataDir ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  if (parsed.releaseHold) {
    if (!parsed.acknowledged) {
      throw new Error(
        "--release-hold needs --consent-reconciled: restoring lost opt-outs and deliveries " +
          "after the backup is yours to do first (docs/operations.md, Restore)",
      );
    }
    const project = parsed.project;
    const { released, held } = releaseHold({
      dataDir,
      clock,
      supportedVersion,
      project,
    });
    const which = project === undefined ? "instance.db" : `project ${project}`;
    process.stdout.write(
      released ? `Hold released on ${which} at ${released.releasedAt}\n` : `No hold on ${which}\n`,
    );
    const projects = held.filter((name) => name !== "instance.db");
    if (held.includes("instance.db")) {
      process.stdout.write(
        "instance.db is still held, which holds every project: release it with --release-hold and no --project\n",
      );
    }
    if (projects.length > 0) {
      process.stdout.write(
        `Still held: ${projects.map((slug) => `project ${slug}`).join(", ")}; ` +
          "release each with --release-hold --project <slug>\n",
      );
    } else if (!held.includes("instance.db")) {
      process.stdout.write("Nothing is held; sending starts with the server\n");
    }
    return;
  }
  if (parsed.verify !== undefined) {
    const databases = inspectBackup(parsed.verify, clock, supportedVersion);
    print(databases);
    verdict(databases);
    return;
  }
  const report = createBackup({
    dataDir,
    output: parsed.output,
    project: parsed.project,
    force: parsed.force,
    clock,
    supportedVersion,
    ...hooks,
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`Backup: ${report.path}\n`);
  print(report.databases);
}
