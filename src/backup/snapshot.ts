// A live backup of a data directory, and the check of one. Not ported: listmonk has no backup
// command. Design and limits are in docs/operations.md.
//
// A backup is a directory shaped like a data directory: `iglo-email.db`, the upload directory at
// its relative path, and a manifest naming that path, which an absolute setting does not say. It
// is built under a name that cannot be taken for a finished backup, synced, verified and renamed,
// so a process killed at any point leaves only that name.
//
// This process is a reader. It opens the database read-only, without `query_only`, which would
// also refuse the writes to the output file, and without WAL or journal changes. `VACUUM INTO`
// then needs only a read transaction on the source: it takes no write lock, the server keeps
// committing, and the snapshot is the committed state when it began. While it runs, a checkpoint
// cannot pass it, so the WAL grows with the writes of that time and is reused afterwards.
//
// The disk is what the two share. Syncing a whole snapshot at its end held the server's next
// commit for 1.5-1.8 s at 1,000,000 subscribers, and that time grows with the database. VACUUM is
// one synchronous statement, so a helper process syncs its output every 200 ms while it runs
// (docs/perf/M6.2-backup.md). It ends with stdin, so it cannot outlive a killed backup.
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { uploadRoot } from "@/media/filesystem";
import { createMediaStore } from "@/media/store";
import { defaults } from "@/settings/defaults";
import { parseStoredJson } from "@/settings/json";
import settingsSql from "@/settings/queries.sql" with { type: "text" };

const DATABASE = "iglo-email.db";
const MANIFEST = "iglo-email-backup.json";
const UPLOAD_PATH = "upload.filesystem.upload_path";
/** Never a backup: `backup --verify` refuses this name and `backup` reports it left behind. */
export const PARTIAL = ".iglo-email-backup-partial-";
const REPLACED = ".iglo-email-backup-replaced-";
/** The internal argument of the helper; see the header. */
export const flushChildArgument = "__backup-flush";
const FLUSH_INTERVAL_MS = 200;

export interface Inspection {
  schemaVersion: number;
  /** Schema version of this executable. */
  supportedVersion: number;
  databaseBytes: number;
  uploadFiles: number;
  uploadBytes: number;
  /** Stored names a media row of the snapshot has and the uploads lack. */
  missing: string[];
}

function single<T>(db: Database, pragma: string): T {
  return (db.query(`PRAGMA ${pragma}`).get() as Record<string, T>)[pragma]!;
}

/** The setting through the settings module's own query; its store seeds, and this one reads. */
function uploadPath(db: Database): string {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql: settingsSql }]);
  try {
    const rows = queries.get("all").all() as { key: string; value: string }[];
    const stored = rows.find(({ key }) => key === UPLOAD_PATH);
    const value = stored ? parseStoredJson(stored.value) : defaults[UPLOAD_PATH];
    return typeof value === "string" ? value : defaults[UPLOAD_PATH];
  } finally {
    queries.close();
  }
}

/** The directory's files as uploads keep them: visible regular names, and no symlink (D64). */
function uploadedFiles(directory: string): { name: string; size: number }[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || entry.name.startsWith(".")) return [];
    const size = lstatSync(join(directory, entry.name), { throwIfNoEntry: false })?.size;
    return size === undefined ? [] : [{ name: entry.name, size }];
  });
}

function sync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openSnapshot(path: string): Database {
  return new Database(path, { readonly: true, strict: true, safeIntegers: true });
}

/** Every stored name of the snapshot, thumbnails included. */
function storedNames(db: Database, clock: Clock): string[] {
  const media = createMediaStore(db, clock);
  try {
    return media
      .query("filesystem", "", 0, 0)
      .results.flatMap(({ filename, thumb }) => (thumb ? [filename, thumb] : [filename]));
  } finally {
    media.close();
  }
}

function inspect(target: string, clock: Clock, supportedVersion: number): Inspection {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) throw new Error(`No backup at ${target}`);
  const file = stats.isDirectory() ? join(target, DATABASE) : target;
  const databaseBytes = statSync(file, { throwIfNoEntry: false })?.size;
  if (databaseBytes === undefined) throw new Error(`No ${DATABASE} in ${target}`);
  let db: Database;
  try {
    db = openSnapshot(file);
  } catch {
    throw new Error(`${target} does not open as a database`);
  }
  try {
    let integrity: string;
    try {
      integrity = single<string>(db, "integrity_check");
    } catch {
      throw new Error(`${target} is not a usable database`);
    }
    if (integrity !== "ok") throw new Error(`${target} failed its integrity check: ${integrity}`);
    const schemaVersion = Number(single<bigint>(db, "user_version"));
    const report = {
      schemaVersion,
      supportedVersion,
      databaseBytes,
      uploadFiles: 0,
      uploadBytes: 0,
      missing: [] as string[],
    };
    // A bare snapshot has no uploads, and a schema ahead of this executable cannot be read by it.
    if (!stats.isDirectory() || schemaVersion === 0 || schemaVersion > supportedVersion)
      return report;
    if (!statSync(join(target, MANIFEST), { throwIfNoEntry: false }))
      throw new Error(`No ${MANIFEST} in ${target}: not a backup`);
    const { uploads: directory } = JSON.parse(readFileSync(join(target, MANIFEST), "utf8")) as {
      uploads: string;
    };
    const uploads = uploadedFiles(join(target, directory));
    const held = new Set(uploads.map(({ name }) => name));
    report.uploadFiles = uploads.length;
    report.uploadBytes = uploads.reduce((sum, { size }) => sum + size, 0);
    report.missing = storedNames(db, clock).filter((name) => !held.has(name));
    return report;
  } finally {
    db.close(true);
  }
}

/** Reads a backup, or a bare snapshot file, and changes nothing. Throws if it is damaged. */
export function inspectBackup(path: string, clock: Clock, supportedVersion: number): Inspection {
  const target = resolve(path);
  if (basename(target).startsWith(PARTIAL))
    throw new Error(`${path} is an interrupted backup, not a backup`);
  return inspect(target, clock, supportedVersion);
}

/** Child entry: sync a file until stdin closes. Failing only makes the final sync larger. */
export async function runFlushChild(): Promise<void> {
  const file = await open(process.argv[3]!, "r");
  let running = true;
  void (async () => {
    for await (const _ of Bun.stdin.stream());
    running = false;
  })();
  while (running) {
    await file.sync();
    await Bun.sleep(FLUSH_INTERVAL_MS);
  }
  process.exit(0);
}

function backupName(clock: Clock): string {
  return `iglo-email-${clock.now().toISOString().replaceAll(":", "-")}`;
}

function inside(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}

export interface BackupOptions {
  dataDir: string;
  output?: string | undefined;
  force?: boolean;
  clock: Clock;
  supportedVersion: number;
  /** Writable bytes at a path; a test's way to fill a disk. */
  available?: (path: string) => number;
  warn(message: string): void;
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Refuses what no flag may replace; a forced replacement must hold a backup or nothing. */
function checkDestination(output: string, data: string, force: boolean): void {
  if (inside(data, output))
    throw new Error(`The output ${output} would replace the data directory`);
  const existing = lstatSync(output, { throwIfNoEntry: false });
  if (!existing) return;
  if (!force) throw new Error(`${output} already exists; pass --force to replace it`);
  const replaceable =
    existing.isDirectory() &&
    (readdirSync(output).length === 0 ||
      statSync(join(output, DATABASE), { throwIfNoEntry: false }));
  if (!replaceable) throw new Error(`${output} does not look like a backup; not replacing it`);
}

function publish(partial: string, output: string): void {
  const parent = dirname(output);
  // Rename cannot replace a directory that holds files, so the old backup steps aside first and
  // goes only once the new one has its name.
  const aside = lstatSync(output, { throwIfNoEntry: false })
    ? join(parent, `${REPLACED}${crypto.randomUUID()}`)
    : undefined;
  if (aside) renameSync(output, aside);
  try {
    renameSync(partial, output);
  } catch (error) {
    if (aside) renameSync(aside, output);
    throw error;
  }
  sync(parent);
  if (aside) rmSync(aside, { recursive: true, force: true });
}

export function createBackup(options: BackupOptions): Inspection & { path: string } {
  const { clock, warn } = options;
  const dataDir = resolve(options.dataDir);
  const databasePath = join(dataDir, DATABASE);
  if (!statSync(databasePath, { throwIfNoEntry: false }))
    throw new Error(`No database at ${databasePath}`);
  const data = realpathSync(dataDir);
  const named = options.output === undefined;
  if (named) mkdirSync(join(dataDir, "backups"), { recursive: true, mode: 0o700 });
  const wanted = resolve(options.output ?? join(dataDir, "backups", backupName(clock)));
  const parent = realpathSync(dirname(wanted));
  const output = join(parent, basename(wanted));
  checkDestination(output, data, options.force ?? false);

  const db = new Database(databasePath, { readonly: true, strict: true, safeIntegers: true });
  let partial: string | undefined;
  let flusher: Bun.Subprocess | undefined;
  try {
    db.run("PRAGMA busy_timeout = 5000");
    if (single<bigint>(db, "user_version") === 0n)
      throw new Error(`${databasePath} has no schema yet; start the server once`);
    const liveUploads = uploadRoot(data, uploadPath(db));
    if (inside(output, liveUploads))
      throw new Error(`The output ${output} is inside the upload directory`);
    const pages = single<bigint>(db, "page_count") - single<bigint>(db, "freelist_count");
    const needed =
      Number(pages * single<bigint>(db, "page_size")) +
      uploadedFiles(liveUploads).reduce((sum, { size }) => sum + size, 0);
    const available = (options.available ?? freeBytes)(parent);
    if (needed > available)
      throw new Error(`A backup needs about ${needed} bytes and ${parent} has ${available} free`);
    for (const entry of readdirSync(parent))
      if (entry.startsWith(PARTIAL))
        warn(`${join(parent, entry)} is left from an interrupted backup or is one still running`);

    // The directory is 0700 from mkdtemp and the database 0600 from its first byte: SQLite writes
    // into an empty file it finds and keeps its mode.
    partial = mkdtempSync(join(parent, PARTIAL));
    const snapshot = join(partial, DATABASE);
    closeSync(openSync(snapshot, "wx", 0o600));
    flusher = Bun.spawn([process.execPath, flushChildArgument, snapshot], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    db.run("VACUUM INTO ?", [snapshot]);
    flusher.kill();
    sync(snapshot);

    // The database comes first. A file that arrives after it is one no row names, which nothing
    // serves. A file deleted after it is a row without a file, reported below.
    const reader = openSnapshot(snapshot);
    let source: string;
    try {
      source = uploadRoot(data, uploadPath(reader));
    } finally {
      reader.close(true);
    }
    const uploads = relative(data, source);
    const target = join(partial, uploads);
    mkdirSync(target, { recursive: true });
    for (const { name } of uploadedFiles(source)) {
      try {
        copyFileSync(join(source, name), join(target, name), constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      sync(join(target, name));
    }
    const manifest = join(partial, MANIFEST);
    writeFileSync(manifest, `${JSON.stringify({ uploads })}\n`, { mode: 0o600, flag: "wx" });
    sync(manifest);
    for (let directory = target; directory !== parent; directory = dirname(directory))
      sync(directory);

    const inspection = inspect(partial, clock, options.supportedVersion);
    publish(partial, output);
    partial = undefined;
    return { ...inspection, path: output };
  } finally {
    flusher?.kill();
    db.close(true);
    if (partial) rmSync(partial, { recursive: true, force: true });
  }
}
