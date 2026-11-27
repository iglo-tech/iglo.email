// A live backup of a data directory, and the check of one. Not ported: listmonk has no backup
// command. Design and limits are in docs/operations.md.
//
// A project's backup is a directory shaped like a project directory: `iglo-email.db`, the upload
// directory at its relative path, and a manifest naming that path, which an absolute setting does
// not say. A whole backup (14-projects section 12, D158) is shaped like a data directory:
// `instance.db`, `projects/<slug>/` as a project's backup for every registered project, and a
// manifest naming the projects. Either is built under one name that cannot be taken for a finished
// backup, synced, verified as a whole and renamed once, so a process killed at any point, or a
// failure on any database, leaves only that name.
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
//
// The finished snapshot is then written to once, before anything can read it: it gets the restore
// hold (D67), and an upload path that resolves to the copied files if the live one went through an
// alias, which a backup does not keep.
import { Database } from "bun:sqlite";
import { must } from "@/invariant";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Clock } from "@/clock";
import { holdDataDirectory } from "@/db/instance-lock";
import { instanceMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { uploadRoot } from "@/media/filesystem";
import { createMediaStore } from "@/media/store";
import {
  INSTANCE_DATABASE,
  PROJECT_DATABASE,
  PROJECTS,
  oldLayoutMessage,
  projectDirectory,
  usesOldLayout,
} from "@/projects/layout";
import { SLUG_PATTERN, registeredSlugs } from "@/projects/registry";
import { holdRecord, placeRestoreHold, releaseRestoreHold } from "@/settings/hold";
import type { HoldRecord } from "@/settings/hold";
import { storedUploadPath, writeUploadPath } from "@/settings/stored";

const DATABASE = PROJECT_DATABASE;
const MANIFEST = "iglo-email-backup.json";
/** Never a backup: `backup --verify` refuses this name and `backup` reports it left behind. */
export const PARTIAL = ".iglo-email-backup-partial-";
const REPLACED = ".iglo-email-backup-replaced-";
/** The internal argument of the helper; see the header. */
export const flushChildArgument = "__backup-flush";
const FLUSH_INTERVAL_MS = 200;
/**
 * The largest manifest `--verify` reads (D178). One the backup writes is a few hundred bytes: an
 * upload path, or the slugs of the projects, at most 41 bytes each.
 */
export const MANIFEST_LIMIT = 1024 * 1024;
const REGISTRY_CHANGED = "The registered projects changed while the backup ran; run it again";

/**
 * A whole backup met a registry change. Its cause, when it has one, is the error of the step that
 * met the change, which the command prints on a line of its own (D178, D183).
 */
export class RegistryChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super(REGISTRY_CHANGED, options);
  }
}

/** What a database is: instance.db, or a project's database. */
export type DatabaseKind = "instance" | "project";

export interface Inspection {
  kind: DatabaseKind;
  schemaVersion: number;
  /** Schema version of this executable. */
  supportedVersion: number;
  databaseBytes: number;
  uploadFiles: number;
  uploadBytes: number;
  /** Stored names a media row of the snapshot has and the uploads lack. */
  missing: Array<string>;
  hold: HoldRecord | null;
}

// The fs error code of a caught value: its `code` when that is a string, otherwise undefined.
function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

function single<T>(db: Database, pragma: string): T {
  return must((db.query(`PRAGMA ${pragma}`).get() as Record<string, T>)[pragma], "pragma value");
}

/** The directory's files as uploads keep them: visible regular names, and no symlink (D64). */
function uploadedFiles(directory: string): Array<{ name: string; size: number }> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      return [];
    }
    const size = lstatSync(join(directory, entry.name), {
      throwIfNoEntry: false,
    })?.size;
    return size === undefined ? [] : [{ name: entry.name, size }];
  });
}

/** A manifest's fields, unchecked: a project's backup names `uploads`, a whole one `projects`. */
interface Manifest {
  uploads?: unknown;
  projects?: unknown;
}

/**
 * A backup's manifest, parsed, read with a bound (D178): a hand-made one can be any size, and it is
 * refused over MANIFEST_LIMIT before it is parsed. It must be a regular file, not a symlink, and is
 * opened without blocking, so a FIFO in its place is refused rather than waited on.
 */
function readManifest(directory: string): Manifest {
  const path = join(directory, MANIFEST);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new Error(`No ${MANIFEST} in ${directory}: not a backup`, {
        cause: error,
      });
    }
    if (code === "ELOOP") {
      throw new Error(`${path} is a symlink, which a backup never holds: not a backup`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`${path} is not a file: not a backup`);
    }
    const tooLarge = () =>
      new Error(
        `${path} is larger than the ${MANIFEST_LIMIT} bytes a backup's manifest may have: not a backup`,
      );
    if (stats.size > MANIFEST_LIMIT) {
      throw tooLarge();
    }
    // One byte more than the limit, so a file that grew after the fstat is still refused.
    const buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) {
        break;
      }
      length += read;
      if (length > MANIFEST_LIMIT) {
        throw tooLarge();
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf-8", 0, length));
    } catch (error) {
      throw new Error(`${path} is not JSON: not a backup`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} is not a manifest: not a backup`);
    }
    // Each field is checked where it is used: `uploads` by a project's check, `projects` by a whole one.
    const { uploads, projects } = parsed as Manifest;
    return { uploads, projects };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Refuses a backup directory holding anything but files and directories (D178), checked by the
 * directory entry's type, without opening it. `backup` never writes a symlink, and one in a
 * hand-made backup would have `--verify` open or list something outside it: a project's directory
 * or database, a manifest, an upload directory. Slugs cannot leave the backup (D166); this keeps
 * the paths they name inside it too. A FIFO, socket or device would have SQLite's open of a
 * database or its WAL wait forever.
 */
function refuseOddEntries(root: string): void {
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${path} is a symlink, which a backup never holds: not a backup`);
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (!entry.isFile()) {
        throw new Error(`${path} is not a regular file, which a backup never holds: not a backup`);
      }
    }
  }
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
  return new Database(path, {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
}

/** Every stored name of the snapshot, thumbnails included. */
function storedNames(db: Database, clock: Clock): Array<string> {
  const media = createMediaStore(db, clock);
  try {
    return media
      .query("filesystem", "", 0, 0)
      .results.flatMap(({ filename, thumb }) => (thumb ? [filename, thumb] : [filename]));
  } finally {
    media.close();
  }
}

/** The first schema version with the settings table: a project's migration 1, instance.db's 3. */
const PROJECT_SETTINGS_FROM = 1;
const INSTANCE_SETTINGS_FROM = 3;

/**
 * Whether a database is instance.db by its schema (D195): instance.db has `projects` from its
 * migration 1 and never `subscribers`; a project database has `subscribers` from its migration 1
 * and never `projects`. One with neither, such as an empty file, is read as a project's.
 */
function isInstanceSchema(db: Database): boolean {
  return hasTable(db, "projects") && !hasTable(db, "subscribers");
}

/**
 * Reads one database. `projectVersion` is this executable's project schema version; `kind` says
 * what the database is, and a bare file, which is either, leaves it out to be told by its schema.
 */
function inspect(
  target: string,
  clock: Clock,
  projectVersion: number,
  given?: DatabaseKind,
): Inspection {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(`No backup at ${target}`);
  }
  const file = stats.isDirectory() ? join(target, DATABASE) : target;
  const database = lstatSync(file, { throwIfNoEntry: false });
  if (database === undefined) {
    throw new Error(`No ${DATABASE} in ${target}`);
  }
  // Checked here, before SQLite opens it, so nothing but a regular file is opened (D178).
  if (!database.isFile()) {
    throw new Error(`${file} is not a regular file: not a backup`);
  }
  // SQLite also opens the journal, WAL and shared-memory files beside it; a FIFO there would make
  // that open wait forever. The walk covers them inside a backup directory, not beside a bare file.
  for (const companion of [`${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    const entry = lstatSync(companion, { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isFile()) {
      throw new Error(`${companion} is not a regular file: not a backup`);
    }
  }
  const databaseBytes = database.size;
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
    if (integrity !== "ok") {
      throw new Error(`${target} failed its integrity check: ${integrity}`);
    }
    const schemaVersion = Number(single<bigint>(db, "user_version"));
    // A database with no schema is no backup's, whatever kind it is: `backup` refuses such a source
    // (D192, D193). SQLite stores the version as a signed 32-bit integer; a negative one is no
    // schema this executable writes, and `runMigrations` refuses it.
    if (schemaVersion === 0) {
      throw new Error(`${file} has no schema: not a backup`);
    }
    if (schemaVersion < 0) {
      throw new Error(`${file} has invalid schema version ${schemaVersion}: not a backup`);
    }
    // A directory holds a project's database; a bare file is either kind, told by its schema.
    const kind = given ?? (!stats.isDirectory() && isInstanceSchema(db) ? "instance" : "project");
    const supportedVersion = kind === "instance" ? instanceMigrations.length : projectVersion;
    const settingsFrom = kind === "instance" ? INSTANCE_SETTINGS_FROM : PROJECT_SETTINGS_FROM;
    // The hold is in the settings table, which every schema of this executable from `settingsFrom`
    // on has. One without it at such a version was not written by `backup` (D193).
    const settings = hasSettings(db);
    if (!settings && schemaVersion >= settingsFrom && schemaVersion <= supportedVersion) {
      throw new Error(
        `${file} has no settings table at schema version ${schemaVersion}: not a backup`,
      );
    }
    // instance.db has its registry from migration 1 on; a whole backup compares it with the
    // manifest, which one without it cannot have been written with (D195).
    if (kind === "instance" && schemaVersion <= supportedVersion && !hasTable(db, "projects")) {
      throw new Error(
        `${file} has no projects table at schema version ${schemaVersion}: not a backup`,
      );
    }
    const report = {
      kind,
      schemaVersion,
      supportedVersion,
      databaseBytes,
      uploadFiles: 0,
      uploadBytes: 0,
      missing: [] as Array<string>,
      hold: settings ? holdRecord(db) : null,
    };
    // A bare snapshot has no uploads, and a schema ahead of this executable cannot be read by it.
    if (!stats.isDirectory() || schemaVersion > supportedVersion) {
      return report;
    }
    const { uploads: directory } = readManifest(target);
    if (typeof directory !== "string") {
      throw new Error(`${join(target, MANIFEST)} names no upload directory: not a backup`);
    }
    // What a restored server will serve: a relative setting says where, whatever the manifest says.
    const restored = storedUploadPath(db);
    const uploadDirectory = resolve(target, isAbsolute(restored) ? directory : restored);
    // `backup` writes only a path inside the backup, which a restored server requires (D64).
    if (uploadDirectory === target || !inside(uploadDirectory, target)) {
      throw new Error(
        `${target} names an upload directory outside it (${relative(target, uploadDirectory) || "."}): not a backup`,
      );
    }
    const uploads = uploadedFiles(uploadDirectory);
    const held = new Set(uploads.map(({ name }) => name));
    report.uploadFiles = uploads.length;
    report.uploadBytes = uploads.reduce((sum, { size }) => sum + size, 0);
    report.missing = storedNames(db, clock).filter((name) => !held.has(name));
    return report;
  } finally {
    db.close(true);
  }
}

/** One database of a backup: its place in the backup ("" for a project's backup or a bare file). */
export interface Checked {
  place: string;
  inspection: Inspection;
}

/** Whether a directory is a whole backup: instance.db and the manifest at its root. */
function isWholeBackup(path: string): boolean {
  return (
    !!statSync(path, { throwIfNoEntry: false })?.isDirectory() &&
    !!statSync(join(path, INSTANCE_DATABASE), {
      throwIfNoEntry: false,
    })?.isFile() &&
    !!statSync(join(path, MANIFEST), { throwIfNoEntry: false })
  );
}

/** A whole backup: instance.db, then each project the manifest names, which its registry names too. */
function inspectWhole(target: string, clock: Clock, supportedVersion: number): Array<Checked> {
  const instanceFile = join(target, INSTANCE_DATABASE);
  const instance = inspect(instanceFile, clock, supportedVersion, "instance");
  const { projects } = readManifest(target);
  if (!Array.isArray(projects) || !projects.every((slug) => typeof slug === "string")) {
    throw new Error(`${join(target, MANIFEST)} names no projects: not a backup`);
  }
  // Each slug becomes a path below projects/, so one that is not a slug is refused before any is
  // read: a hand-made manifest could otherwise point outside the backup (D166).
  const invalid = projects.find((slug: string) => !SLUG_PATTERN.test(slug));
  if (invalid !== undefined) {
    throw new Error(
      `${join(target, MANIFEST)} names ${JSON.stringify(invalid)}, which is not a project slug: not a backup`,
    );
  }
  // An instance.db with no schema or no projects table, which registers nothing to compare, is
  // refused by `inspect` (D192, D193, D195).
  if (instance.schemaVersion <= instanceMigrations.length) {
    const db = openSnapshot(instanceFile);
    try {
      const registered = registeredSlugs(db);
      if (registered.join("\n") !== projects.join("\n")) {
        throw new Error(
          `${target} is not one backup: its instance.db registers ${registered.join(", ") || "no project"} ` +
            `and its manifest names ${projects.join(", ") || "none"}`,
        );
      }
    } finally {
      db.close(true);
    }
  }
  return [
    { place: INSTANCE_DATABASE, inspection: instance },
    ...projects.map((slug: string) => {
      const place = join(PROJECTS, slug);
      const directory = join(target, place);
      // `inspect` takes a file as a bare snapshot, but a whole backup restores each project as a
      // directory, uploads and all: a file there cannot be restored (D193).
      const entry = lstatSync(directory, { throwIfNoEntry: false });
      if (entry !== undefined && !entry.isDirectory()) {
        throw new Error(`${directory} is not a directory: not a backup`);
      }
      return {
        place,
        inspection: inspect(directory, clock, supportedVersion, "project"),
      };
    }),
  ];
}

/**
 * Reads a backup, whole or of one project, or a bare snapshot file, and changes nothing. Throws if
 * any database in it is damaged: one result for the whole backup.
 */
export function inspectBackup(
  path: string,
  clock: Clock,
  supportedVersion: number,
): Array<Checked> {
  const given = resolve(path);
  if (basename(given).startsWith(PARTIAL)) {
    throw new Error(`${path} is an interrupted backup, not a backup`);
  }
  // The path given may be a symlink to a backup; inside the backup there may be none (D178).
  let target: string;
  try {
    target = realpathSync(given);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`No backup at ${given}`, { cause: error });
    }
    throw error;
  }
  if (basename(target).startsWith(PARTIAL)) {
    throw new Error(`${path} is an interrupted backup, not a backup`);
  }
  // A path that resolves to nothing on disk, such as `/dev/stdin` on a pipe (`pipe:[…]`), is no
  // backup either (D183).
  const found = statSync(target, { throwIfNoEntry: false });
  if (found === undefined) {
    throw new Error(`No backup at ${given}`);
  }
  // A bare snapshot that is not a regular file is refused by `inspect`, before SQLite opens it
  // (D178, D183).
  if (found.isDirectory()) {
    refuseOddEntries(target);
  }
  if (isWholeBackup(target)) {
    return inspectWhole(target, clock, supportedVersion);
  }
  return [{ place: "", inspection: inspect(target, clock, supportedVersion) }];
}

/** Child entry: sync a file until stdin closes. Failing only makes the final sync larger. */
export async function runFlushChild(): Promise<void> {
  const path = must(process.argv[3], "flush path");
  let running = true;
  void (async () => {
    for await (const _ of Bun.stdin.stream()) {
      // Reading stdin to its end is the whole job: the stream ends when the parent closes it.
    }
    running = false;
  })();
  const file = await openWhenCreated(path, () => running);
  while (file && running) {
    await file.sync();
    await Bun.sleep(FLUSH_INTERVAL_MS);
  }
  process.exit(0);
}

/** Opens `path` once VACUUM INTO has created it, or returns undefined when `wanted` turns false. */
async function openWhenCreated(
  path: string,
  wanted: () => boolean,
): Promise<FileHandle | undefined> {
  while (wanted()) {
    try {
      return await open(path, "r");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    await Bun.sleep(10);
  }
  return undefined;
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
  /** The project schema version of this executable; instance.db's comes from its manifest. */
  supportedVersion: number;
  /** One project's backup instead of the whole instance (D158). */
  project?: string | undefined;
  /** Writable bytes at a path; a test's way to fill a disk. */
  available?: (path: string) => number;
  /** Runs at the moment of publication; a test's way to race it. The command line never sets it. */
  beforePublish?: () => void;
  warn: (message: string) => void;
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * What a forced publication may replace: a directory that holds a backup or nothing. A whole backup
 * has its manifest beside instance.db, which a data directory does not.
 */
function replaceable(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  return (
    !!existing?.isDirectory() &&
    (readdirSync(path).length === 0 ||
      !!statSync(join(path, DATABASE), { throwIfNoEntry: false }) ||
      isWholeBackup(path))
  );
}

/**
 * What stands at one path of a folder chain: nothing, or a folder. It refuses, naming the path, a
 * file, a symlink to a file and a symlink to nothing, since none of them can hold a backup.
 */
function standing(path: string): "missing" | "folder" {
  let stats;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (errorCode(error) !== "ENOTDIR") {
      throw error;
    }
    throw new Error(`${path} is below something that is not a folder`, {
      cause: error,
    });
  }
  if (!stats) {
    return "missing";
  }
  if (stats.isSymbolicLink()) {
    const target = followed(path);
    if (!target) {
      throw new Error(`${path} is a symlink to a missing target`);
    }
    if (target.isDirectory()) {
      return "folder";
    }
    throw new Error(
      target.isFile()
        ? `${path} is a symlink to a file, not a folder`
        : `${path} is a symlink to something other than a folder`,
    );
  }
  if (stats.isDirectory()) {
    return "folder";
  }
  throw new Error(stats.isFile() ? `${path} is a file, not a folder` : `${path} is not a folder`);
}

/**
 * What the symlink at `path` leads to, or undefined if nothing does. A chain through a file or a
 * loop is refused by name, since the kernel gives no more than ENOTDIR or ELOOP for it.
 */
function followed(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOTDIR") {
      throw new Error(`${path} is a symlink to a path below a file, not a folder`, {
        cause: error,
      });
    }
    if (code === "ELOOP") {
      throw new Error(`${path} is a symlink loop`, { cause: error });
    }
    throw error;
  }
}

/**
 * A folder this call made, with the identity it had then. A path alone cannot show that it is still
 * that folder once a parent has been renamed or replaced, so cleanup compares identities first.
 */
interface MadeFolder {
  path: string;
  dev: number;
  ino: number;
}

/** What `path` names: nothing if nothing is there, or if the path runs through a file or a loop. */
function currentAt(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOTDIR" || code === "ELOOP") {
      return undefined;
    }
    throw error;
  }
}

function madeAt(path: string): MadeFolder {
  const { dev, ino } = lstatSync(path);
  return { path, dev, ino };
}

/** Whether the path still names the folder this call made: a real folder with the same identity. */
function isMade(made: MadeFolder, current: Stats | undefined = currentAt(made.path)): boolean {
  return !!current?.isDirectory() && current.dev === made.dev && current.ino === made.ino;
}

/**
 * Whether `path` is a folder itself. A symlink to one is not: the folders made here must be real.
 */
function realFolder(path: string): boolean {
  return !!currentAt(path)?.isDirectory();
}

interface MissingFolders {
  existing: string;
  missing: Array<string>;
}
/**
 * The folders of `directory` that do not exist, shallowest first, and the deepest one that does.
 * Each component is checked from the root, so the first problem named is the one nearest the root.
 * It creates nothing: the refusals after it leave no folder behind, and the folders are made later
 * with createFolders. The caller resolves the parent as the realpath of `existing`, joined with the
 * folders still to be made, so an alias in the existing part is followed as the kernel would.
 */
function missingFolders(directory: string): MissingFolders {
  const names = directory.split(sep).filter(Boolean);
  let existing: string = sep;
  for (const [index, name] of names.entries()) {
    const current = join(existing, name);
    if (standing(current) === "missing") {
      const missing: Array<string> = [];
      let path = existing;
      for (const next of names.slice(index)) {
        path = join(path, next);
        missing.push(path);
      }
      return { existing, missing };
    }
    existing = current;
  }
  return { existing, missing: [] };
}

/**
 * Makes the folders shallowest first, recording each one this call makes in `made`. A folder that
 * appears in the meantime is accepted only if it is a folder itself: a symlink, even to a folder,
 * is refused, since mkdir would follow it to wherever it points. A path that changed since the
 * check is named, rather than reported as a raw ENOTDIR, ELOOP or EEXIST. A missing folder above
 * one that was made is left as ENOENT: openPartial makes the chain again, and names it if that fails.
 */
function createFolders(folders: Array<string>, made: Array<MadeFolder>): void {
  for (const folder of folders) {
    try {
      mkdirSync(folder, { mode: 0o700 });
      made.push(madeAt(folder));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        throw error;
      }
      if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "ELOOP") {
        throw error;
      }
      if (realFolder(folder)) {
        continue;
      }
      throw new Error(`${folder} changed meanwhile: it is not a folder`, {
        cause: error,
      });
    }
  }
}

/**
 * The places an output may never be, checked on the path it has. createBackup runs it once, before
 * the folders are made; the realpath check after them is what keeps that answer true.
 */
function checkBoundaries(output: string, root: string, uploads: Array<string>): void {
  if (inside(root, output)) {
    throw new Error(`The output ${output} would replace the data directory`);
  }
  if (uploads.some((directory) => inside(output, directory))) {
    throw new Error(`The output ${output} is inside the upload directory`);
  }
  // Where a restore reads (D158): a backup there could be taken for a project, or for instance.db.
  const projects = join(root, PROJECTS);
  if (inside(output, projects)) {
    throw new Error(
      `The output ${output} is inside ${projects}, where the projects are read from; ` +
        `write it outside it, such as under ${join(root, "backups")}`,
    );
  }
  if (dirname(output) === root && basename(output).startsWith(INSTANCE_DATABASE)) {
    throw new Error(`The output ${output} is where instance.db is read from`);
  }
}

/**
 * Removes the folders a failed or refused backup made, deepest first. Only the folder this call made
 * goes, and only if it is empty. A folder that another process has started using is left without a
 * word, since it is not this backup's to remove. A different folder at a made folder's path is left
 * alone and named. rmdir never follows a symlink, so a link at the path is refused too.
 */
function removeCreated(made: Array<MadeFolder>, warn: (message: string) => void): void {
  for (const folder of [...made].reverse()) {
    // Each folder is inspected and removed on its own, so one that cannot be looked at does not stop
    // the rest from being cleaned.
    try {
      const current = currentAt(folder.path);
      if (!current) {
        continue;
      }
      if (!isMade(folder, current)) {
        warn(
          `${folder.path} was made by this backup, but another folder is at its place; it is left alone`,
        );
        continue;
      }
      rmdirSync(folder.path);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") {
        continue;
      }
      warn(`${folder.path} was made by this backup and could not be removed: ${code}`);
    }
  }
}

/**
 * Removes the partial backup where this call made it, or names it. A path that no longer holds that
 * folder is not searched: the warning gives the path it was last known at, for the operator to remove.
 */
function removePartial(partial: MadeFolder, warn: (message: string) => void): void {
  try {
    if (!isMade(partial)) {
      warn(
        `${partial.path} is an interrupted backup and was not removed: its path no longer holds the folder this backup made; remove it by hand`,
      );
      return;
    }
    rmSync(partial.path, { recursive: true, force: true });
  } catch (error) {
    const code = errorCode(error);
    warn(`${partial.path} is an interrupted backup and could not be removed: ${code}`);
  }
}

function changedMeanwhile(path: string): Error {
  return new Error(
    `${path} changed meanwhile: the backup in progress is no longer where it was made`,
  );
}

/**
 * Whether the path verifiably no longer names the folder this call made. A path that cannot be
 * looked at is not known to have moved, so the caller keeps the failure it has.
 */
function movedAway(made: MadeFolder): boolean {
  try {
    return !isMade(made);
  } catch {
    return false;
  }
}

/**
 * Runs a step that writes into the partial backup. When the step fails and the partial is no longer
 * the folder this call made, the failure is that change, whatever its code, and is named as one.
 */
function whileMade<T>(made: MadeFolder, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (movedAway(made)) {
      throw changedMeanwhile(made.path);
    }
    throw error;
  }
}

/** Refuses what no flag may replace; a forced replacement must hold a backup or nothing. */
function checkDestination(output: string, live: Array<string>, force: boolean): void {
  if (live.some((data) => inside(data, output))) {
    throw new Error(`The output ${output} would replace the data directory`);
  }
  if (!lstatSync(output, { throwIfNoEntry: false })) {
    return;
  }
  if (!force) {
    throw new Error(`${output} already exists; pass --force to replace it`);
  }
  if (!replaceable(output)) {
    throw new Error(`${output} does not look like a backup; not replacing it`);
  }
}

/** Back where it was. Neither step replaces what took the name meanwhile, unless it is empty. */
function putBack(aside: string, output: string): void {
  try {
    if (lstatSync(aside).isDirectory()) {
      renameSync(aside, output);
    } else {
      linkSync(aside, output);
      rmSync(aside);
    }
  } catch {
    throw new Error(`${output} was taken meanwhile; what stood there is now ${aside}`);
  }
}

/**
 * Rename cannot replace a directory that holds files, so a forced old backup steps aside and goes
 * only once the new one has its name. The checks come after the move, so they are of what moved.
 * A live project directory holds a database, so `replaceable` would accept it. It and the data
 * directory are refused by identity instead: a path that came to name one cannot fool a comparison
 * of device and inode.
 */
function stepAside(output: string, live: Array<Stats>): string | undefined {
  const aside = join(dirname(output), `${REPLACED}${crypto.randomUUID()}`);
  try {
    renameSync(output, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const moved = lstatSync(aside);
  if (live.some((directory) => moved.dev === directory.dev && moved.ino === directory.ino)) {
    putBack(aside, output);
    throw new Error(`${output} is the live data directory; not replacing it`);
  }
  if (replaceable(aside)) {
    return aside;
  }
  putBack(aside, output);
  throw new Error(`${output} does not look like a backup; not replacing it`);
}

/**
 * One rename is the whole publication, and its result is the answer. It refuses a directory that
 * holds anything and a file, atomically, so nothing is moved or deleted, and there is no earlier
 * step for a kill to leave behind. It does replace an empty directory, which loses nothing.
 * Returns the old backup it moved aside, which the caller removes once the new one has its name.
 */
function publish(
  partial: MadeFolder,
  output: string,
  force: boolean,
  live: Array<Stats>,
): string | undefined {
  if (!isMade(partial)) {
    throw changedMeanwhile(partial.path);
  }
  const aside = force ? stepAside(output, live) : undefined;
  try {
    renameSync(partial.path, output);
  } catch (error) {
    if (aside) {
      putBack(aside, output);
    }
    const code = errorCode(error);
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
      throw new Error(`${output} already exists; pass --force to replace it`, {
        cause: error,
      });
    }
    if (code === "ENOENT") {
      throw changedMeanwhile(partial.path);
    }
    throw error;
  }
  return aside;
}

/** The output's parent as the kernel resolves it: the realpath of the existing part, then the rest. */
function resolvedParent(wanted: string, folders: { existing: string }): string {
  return join(realpathSync(folders.existing), relative(folders.existing, dirname(wanted)));
}

/**
 * Makes the folders the output needs, then the partial folder in its parent. The folders were checked
 * when they were missing, but another backup can make one, use it and remove it again before this one
 * writes into it. So the chain is checked and made again once. The parent must still resolve where it
 * did, and the partial's folder must still be the one made: a symlink that took a folder's place since
 * the check would move the backup, so it is refused before anything is written.
 */
function openPartial(
  wanted: string,
  parent: string,
  missing: Array<string>,
  created: Array<MadeFolder>,
): MadeFolder {
  let folders = missing;
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1) {
        // A folder made by the first attempt that no longer stands where it was made is not this
        // call's to report or remove. The retry makes it again if it is still missing.
        created.splice(0, created.length, ...created.filter((folder) => !movedAway(folder)));
        const again = missingFolders(dirname(wanted));
        if (resolvedParent(wanted, again) !== parent) {
          throw new Error(
            `${dirname(wanted)} changed meanwhile: it no longer resolves to ${parent}`,
          );
        }
        folders = again.missing;
      }
      createFolders(folders, created);
      if (realpathSync(dirname(wanted)) !== parent) {
        throw new Error(`${dirname(wanted)} changed meanwhile: it no longer resolves to ${parent}`);
      }
      // The directory is 0700 from mkdtemp: see the database file in createBackup.
      return madeAt(mkdtempSync(join(parent, PARTIAL)));
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      if (attempt > 1) {
        throw new Error(
          `${dirname(wanted)} changed meanwhile: a folder in it was removed or replaced`,
          { cause: error },
        );
      }
    }
  }
}

/** The snapshot's one write: see the header. It leaves no journal or WAL beside the file. */
function sealSnapshot(path: string, since: string, data: string): string {
  const db = new Database(path, { strict: true, safeIntegers: true });
  try {
    db.run("PRAGMA journal_mode = DELETE");
    const stored = storedUploadPath(db);
    const source = uploadRoot(data, stored);
    db.transaction(() => {
      placeRestoreHold(db, since);
      if (resolve(data, stored) !== source) {
        writeUploadPath(db, relative(data, source));
      }
    })();
    return source;
  } finally {
    db.close(true);
  }
}

/** A live database a backup reads: instance.db, or a project's database and its uploads. */
interface Source {
  /** Its place in the backup, relative: "" for a project's own backup. */
  place: string;
  /** The snapshot's file name. */
  file: string;
  /** The live database file. */
  path: string;
  /** The real directory it lives in: a project's paths resolve there. */
  data: string;
  db: Database;
  /** A project's live upload directory; instance.db has none. */
  uploads?: string;
}

/**
 * Opens a live database read-only, as the server's readers do. Its schema must be one this
 * executable knows, 1 to `supportedVersion` (B170, D198): sealing writes into it, so one ahead of
 * the executable is refused before any folder is made.
 */
function openSource(path: string, supportedVersion: number): Database {
  if (!statSync(path, { throwIfNoEntry: false })) {
    throw new Error(`No database at ${path}`);
  }
  const db = new Database(path, {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const version = single<bigint>(db, "user_version");
    if (version === 0n) {
      throw new Error(`${path} has no schema yet; start the server once`);
    }
    checkVersion(path, version, supportedVersion);
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/**
 * A live database's schema version past 0: refused when negative (SQLite stores a signed 32-bit
 * integer, and no migration writes one) or ahead of this executable (B170, D198).
 */
function checkVersion(path: string, version: bigint, supportedVersion: number): void {
  if (version < 0n) {
    throw new Error(`${path} has invalid schema version ${version}`);
  }
  if (Number(version) > supportedVersion) {
    throw new Error(
      `${path} has schema version ${version}, ahead of this executable, which supports ${supportedVersion}: use a newer one`,
    );
  }
}

/** The instance.db snapshot's one write: the hold. It leaves no journal or WAL beside the file. */
function sealInstance(path: string, since: string): void {
  const db = new Database(path, { strict: true, safeIntegers: true });
  try {
    db.run("PRAGMA journal_mode = DELETE");
    db.transaction(() => placeRestoreHold(db, since))();
  } finally {
    db.close(true);
  }
}

/** The result of a backup: where it is and the check of each database in it. */
export interface BackupReport {
  path: string;
  databases: Array<Checked>;
}

/**
 * A whole backup (instance.db and every registered project), or with `project` one project's, as
 * one directory published by one rename (14-projects section 12, D158).
 */
export function createBackup(options: BackupOptions): BackupReport {
  const { clock, warn } = options;
  const dataDir = resolve(options.dataDir);
  if (usesOldLayout(dataDir)) {
    throw new Error(oldLayoutMessage(dataDir));
  }
  const whole = options.project === undefined;
  const sources: Array<Source> = [];
  let created: Array<MadeFolder> = [];
  let partial: MadeFolder | undefined;
  let flusher: Bun.Subprocess | undefined;
  // The projects a whole backup set out to copy, until it is published: see the catch below.
  let unpublished: Array<string> | undefined;
  try {
    // Every database is opened, and every check that can refuse is made, before any folder is.
    const instancePath = join(dataDir, INSTANCE_DATABASE);
    const instance = openSource(instancePath, instanceMigrations.length);
    const root = realpathSync(dataDir);
    sources.push({
      place: INSTANCE_DATABASE,
      file: INSTANCE_DATABASE,
      path: instancePath,
      data: root,
      db: instance,
    });
    const registered = registeredSlugs(instance);
    unpublished = whole ? registered : undefined;
    if (options.project !== undefined && !registered.includes(options.project)) {
      throw new Error(`No project ${options.project} in ${dataDir}`);
    }
    for (const slug of options.project === undefined ? registered : [options.project]) {
      const directory = projectDirectory(dataDir, slug);
      const path = join(directory, DATABASE);
      const db = openSource(path, options.supportedVersion);
      const data = realpathSync(directory);
      sources.push({
        place: whole ? join(PROJECTS, slug) : "",
        file: DATABASE,
        path,
        data,
        db,
        uploads: uploadRoot(data, storedUploadPath(db)),
      });
    }
    // A project's backup has no instance.db.
    const included = whole ? sources : sources.slice(1);
    // The identities of the live directories, taken before anything can move: see stepAside.
    const live = [root, ...sources.slice(1).map(({ data }) => data)].map((path) => statSync(path));

    const wanted = resolve(options.output ?? join(dataDir, "backups", backupName(clock)));
    const folders = missingFolders(dirname(wanted));
    const parent = resolvedParent(wanted, folders);
    const output = join(parent, basename(wanted));
    // The places an output may never be come first, so each is refused by its own message: the
    // projects directory itself holds every project, which checkDestination would call the data
    // directory (D166).
    const uploadDirectories = included.flatMap(({ uploads }) => (uploads ? [uploads] : []));
    checkBoundaries(output, root, uploadDirectories);
    checkDestination(
      output,
      sources.map(({ data }) => data),
      options.force ?? false,
    );
    let needed = 0;
    for (const { db, uploads } of included) {
      const pages = single<bigint>(db, "page_count") - single<bigint>(db, "freelist_count");
      needed += Number(pages * single<bigint>(db, "page_size"));
      needed += uploads ? uploadedFiles(uploads).reduce((sum, { size }) => sum + size, 0) : 0;
    }
    const available = (options.available ?? freeBytes)(realpathSync(folders.existing));
    if (needed > available) {
      throw new Error(`A backup needs about ${needed} bytes and ${parent} has ${available} free`);
    }
    // A folder that does not exist yet has no leftovers in it.
    for (const entry of folders.missing.length === 0 ? readdirSync(parent) : []) {
      if (entry.startsWith(PARTIAL)) {
        warn(`${join(parent, entry)} is left from an interrupted backup or is one still running`);
      } else if (entry.startsWith(REPLACED)) {
        warn(`${join(parent, entry)} is a backup that a forced backup did not finish replacing`);
      }
    }

    // Once openPartial has checked the path, output is parent joined with the basename, which is the
    // real path of the output. The boundaries were checked on that path above, so they are not
    // checked again.
    const made = openPartial(wanted, parent, folders.missing, created);
    partial = made;
    for (const source of included) {
      const target = join(made.path, source.place === INSTANCE_DATABASE ? "" : source.place);
      if (target !== made.path) {
        whileMade(made, () => {
          mkdirSync(target, { recursive: true, mode: 0o700 });
          chmodSync(dirname(target), 0o700);
          chmodSync(target, 0o700);
        });
      }
      const snapshot = join(target, source.file);
      // The directory is 0700 from mkdtemp, so only this user and root can reach the database while
      // VACUUM INTO creates it with the umask mode (0644 under umask 022). It is made 0600 right
      // after. The flusher runs as this user and may open the file during VACUUM, so the directory
      // is what protects it in that window.
      // VACUUM INTO refuses a path that exists, even an empty file (macOS's SQLite does), so the
      // flusher may start before the file does and waits for it.
      const copied = whileMade(made, () => {
        flusher = Bun.spawn([process.execPath, flushChildArgument, snapshot], {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        });
        const since = clock.now().toISOString();
        source.db.run("VACUUM INTO ?", [snapshot]);
        chmodSync(snapshot, 0o600);
        flusher.kill();
        flusher = undefined;
        if (source.uploads === undefined) {
          sealInstance(snapshot, since);
          sync(snapshot);
          return undefined;
        }
        const sealed = sealSnapshot(snapshot, since, source.data);
        sync(snapshot);
        return sealed;
      });
      if (copied !== undefined) {
        copyUploads(made, target, source.data, copied, parent);
      }
    }
    if (whole) {
      whileMade(made, () => {
        // The set is one backup only if the instance.db snapshot registers what was copied: a project
        // added or removed meanwhile fails the backup, which a rerun takes whole.
        const db = openSnapshot(join(made.path, INSTANCE_DATABASE));
        let copied: Array<string>;
        try {
          copied = registeredSlugs(db);
        } finally {
          db.close(true);
        }
        if (copied.join("\n") !== registered.join("\n")) {
          throw new RegistryChangedError();
        }
        const manifest = join(made.path, MANIFEST);
        writeFileSync(manifest, `${JSON.stringify({ projects: registered })}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        sync(manifest);
        sync(made.path);
      });
    }

    const databases = whileMade(made, () =>
      whole
        ? inspectWhole(made.path, clock, options.supportedVersion)
        : [
            {
              place: "",
              inspection: inspect(made.path, clock, options.supportedVersion),
            },
          ],
    );
    options.beforePublish?.();
    // B170 (D198): the live registry, read again just before the rename. The instance.db snapshot
    // was taken first, so a project deleted while its uploads were copied is still in it, and its
    // missing files were skipped as deleted ones: only the live registry shows the change.
    const now = registeredSlugs(instance);
    if (whole && now.join("\n") !== registered.join("\n")) {
      throw new RegistryChangedError();
    }
    if (options.project !== undefined && !now.includes(options.project)) {
      throw new Error(`Project ${options.project} was deleted while the backup ran`);
    }
    const aside = publish(made, output, options.force ?? false, live);
    unpublished = undefined;
    // The rename is the publication. From here nothing is undone: the partial is no longer a partial,
    // and the folders are the backup's parents and stay. Cleanup must not run over the backup from
    // here. A failed sync of the folder is an error, since the backup may not be durable; a failure
    // to remove the replaced backup is a warning.
    partial = undefined;
    created = [];
    try {
      sync(dirname(output));
    } catch (error) {
      // The replaced backup is kept: the new one may not be durable, so it is the one to fall back on.
      const code = errorCode(error);
      throw new Error(
        `${output} is in place, but its folder could not be synced (${code}), so it may not survive a crash; ` +
          (aside ? `the backup it replaced is kept at ${aside}; ` : "") +
          `check it with --verify`,
        { cause: error },
      );
    }
    if (aside) {
      try {
        rmSync(aside, { recursive: true, force: true });
      } catch (error) {
        const code = errorCode(error);
        warn(
          `${aside} is the backup that ${output} replaced, and it could not be removed: ${code}`,
        );
      }
    }
    return { path: output, databases };
  } catch (error) {
    // A project created or deleted meanwhile fails a whole backup at whichever step meets it first:
    // a deleted project's directory or upload path is gone. The cause to report is then the change
    // of the registry, which a rerun takes whole, not that step's message (D164, D178).
    const instance = sources[0]?.db;
    if (unpublished !== undefined && instance !== undefined) {
      let now: Array<string> | undefined;
      try {
        now = registeredSlugs(instance);
      } catch {
        // The registry unread is no evidence of a change: the step's own error stands.
      }
      if (now !== undefined && now.join("\n") !== unpublished.join("\n")) {
        throw new RegistryChangedError({ cause: error });
      }
    }
    throw error;
  } finally {
    flusher?.kill();
    for (const { db } of sources) {
      db.close(true);
    }
    try {
      if (partial) {
        removePartial(partial, warn);
      }
    } finally {
      removeCreated(created, warn);
    }
  }
}

/**
 * A project's uploads, after its database. A file that arrives after it is one no row names, which
 * nothing serves. A file deleted after it is a row without a file, which the check reports.
 */
function copyUploads(
  made: MadeFolder,
  project: string,
  data: string,
  source: string,
  parent: string,
): void {
  const uploads = relative(data, source);
  whileMade(made, () => {
    const target = join(project, uploads);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
    for (const { name } of uploadedFiles(source)) {
      try {
        copyFileSync(join(source, name), join(target, name), constants.COPYFILE_EXCL);
      } catch (error) {
        // A file the live server deleted after it was listed is skipped. Anything else missing is
        // the backup's own path, which whileMade names.
        const gone = !lstatSync(join(source, name), { throwIfNoEntry: false });
        if (errorCode(error) === "ENOENT" && gone) {
          continue;
        }
        throw error;
      }
      chmodSync(join(target, name), 0o600);
      sync(join(target, name));
    }
    const manifest = join(project, MANIFEST);
    writeFileSync(manifest, `${JSON.stringify({ uploads })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    sync(manifest);
    for (let directory = target; directory !== parent; directory = dirname(directory)) {
      sync(directory);
    }
  });
}

/** A database a stopped server left, opened alone and exclusively (D67, D69). */
function openStopped(path: string, supportedVersion: number): Database {
  if (!statSync(path, { throwIfNoEntry: false })) {
    throw new Error(`No database at ${path}`);
  }
  const db = new Database(path, {
    readwrite: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    // Before the first read: a connection that has read keeps its shared-memory locking.
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.run("BEGIN IMMEDIATE");
    } catch {
      throw new Error(`${path} is in use: stop what has it open first`);
    }
    const version = single<bigint>(db, "user_version");
    db.run("ROLLBACK");
    if (version === 0n) {
      throw new Error(`${path} has no schema yet; start the server once`);
    }
    // B170 (D198): a negative version is no schema any migration writes.
    if (version < 0n) {
      throw new Error(`${path} has invalid schema version ${version}`);
    }
    if (Number(version) > supportedVersion) {
      throw new Error(`Database version ${version} is ahead of this executable`);
    }
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}

/** instance.db has its settings table, where a hold is, from its migration 3 on. */
function hasSettings(db: Database): boolean {
  return hasTable(db, "settings");
}

/** A database's own hold, read-only; a database with no settings table has none. */
function heldNow(path: string): boolean {
  if (!statSync(path, { throwIfNoEntry: false })) {
    return false;
  }
  const db = new Database(path, {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    if (!hasSettings(db)) {
      return false;
    }
    const record = holdRecord(db);
    return !!record && record.releasedAt === null;
  } finally {
    db.close(true);
  }
}

export interface ReleaseOptions {
  dataDir: string;
  clock: Clock;
  /** The project schema version of this executable. */
  supportedVersion: number;
  /** The project whose database is released; without it, instance.db's (D158). */
  project?: string | undefined;
}

export interface Release {
  /** The released hold, or null when that database had none. */
  released: HoldRecord | null;
  /** The databases still held afterwards: `instance.db` and the slugs of held projects. */
  held: Array<string>;
}

/**
 * Ends one database's restore hold, on a stopped server under the one lock: otherwise it changes
 * what a server reads between claims. instance.db's hold holds every project and a project's holds
 * that project, so each is released on its own (D158).
 */
export function releaseHold(options: ReleaseOptions): Release {
  const root = resolve(options.dataDir);
  if (usesOldLayout(root)) {
    throw new Error(oldLayoutMessage(root));
  }
  const instancePath = join(root, INSTANCE_DATABASE);
  // Before the lock, which would create the directory.
  if (!statSync(instancePath, { throwIfNoEntry: false })) {
    throw new Error(`No database at ${instancePath}`);
  }
  const lock = holdDataDirectory(root);
  try {
    const instance = openStopped(instancePath, instanceMigrations.length);
    let slugs: Array<string>;
    try {
      slugs = registeredSlugs(instance);
    } finally {
      instance.close(true);
    }
    const project = options.project;
    if (project !== undefined && !slugs.includes(project)) {
      throw new Error(`No project ${project} in ${root}`);
    }
    const databaseOf = (slug: string) => join(projectDirectory(root, slug), DATABASE);
    const db =
      project === undefined
        ? openStopped(instancePath, instanceMigrations.length)
        : openStopped(databaseOf(project), options.supportedVersion);
    let released: HoldRecord | null;
    try {
      released = writeTransaction(db, () => {
        const record = hasSettings(db) ? holdRecord(db) : null;
        if (!record || record.releasedAt !== null) {
          return null;
        }
        const at = options.clock.now().toISOString();
        releaseRestoreHold(db, record, at);
        return { since: record.since, releasedAt: at };
      });
    } finally {
      db.close(true);
    }
    const held = [
      ...(project !== undefined && heldNow(instancePath) ? [INSTANCE_DATABASE] : []),
      ...slugs.filter((slug) => slug !== project && heldNow(databaseOf(slug))),
    ];
    return { released, held };
  } finally {
    lock.release();
  }
}
