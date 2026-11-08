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
//
// The finished snapshot is then written to once, before anything can read it: it gets the restore
// hold (D67), and an upload path that resolves to the copied files if the live one went through an
// alias, which a backup does not keep.
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Clock } from "@/clock";
import { withStoppedDatabase } from "@/db/connection";
import { writeTransaction } from "@/db/transaction";
import { uploadRoot } from "@/media/filesystem";
import { createMediaStore } from "@/media/store";
import { holdRecord, placeRestoreHold, releaseRestoreHold, type HoldRecord } from "@/settings/hold";
import { storedUploadPath, writeUploadPath } from "@/settings/stored";

const DATABASE = "iglo-email.db";
const MANIFEST = "iglo-email-backup.json";
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
  hold: HoldRecord | null;
}

function single<T>(db: Database, pragma: string): T {
  return (db.query(`PRAGMA ${pragma}`).get() as Record<string, T>)[pragma]!;
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
      hold: schemaVersion === 0 ? null : holdRecord(db),
    };
    // A bare snapshot has no uploads, and a schema ahead of this executable cannot be read by it.
    if (!stats.isDirectory() || schemaVersion === 0 || schemaVersion > supportedVersion)
      return report;
    if (!statSync(join(target, MANIFEST), { throwIfNoEntry: false }))
      throw new Error(`No ${MANIFEST} in ${target}: not a backup`);
    const { uploads: directory } = JSON.parse(readFileSync(join(target, MANIFEST), "utf8")) as {
      uploads: string;
    };
    // What a restored server will serve: a relative setting says where, whatever the manifest says.
    const restored = storedUploadPath(db);
    const uploads = uploadedFiles(join(target, isAbsolute(restored) ? directory : restored));
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
  /** Runs at the moment of publication; a test's way to race it. The command line never sets it. */
  beforePublish?: () => void;
  warn(message: string): void;
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** What a forced publication may replace: a directory that holds a backup or nothing. */
function replaceable(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  return (
    !!existing?.isDirectory() &&
    (readdirSync(path).length === 0 || !!statSync(join(path, DATABASE), { throwIfNoEntry: false }))
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
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    throw new Error(`${path} is below something that is not a folder`);
  }
  if (!stats) return "missing";
  if (stats.isSymbolicLink()) {
    const target = followed(path);
    if (!target) throw new Error(`${path} is a symlink to a missing target`);
    if (target.isDirectory()) return "folder";
    throw new Error(
      target.isFile()
        ? `${path} is a symlink to a file, not a folder`
        : `${path} is a symlink to something other than a folder`,
    );
  }
  if (stats.isDirectory()) return "folder";
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
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOTDIR")
      throw new Error(`${path} is a symlink to a path below a file, not a folder`);
    if (code === "ELOOP") throw new Error(`${path} is a symlink loop`);
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
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOTDIR" || code === "ELOOP") return undefined;
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

/**
 * The folders of `directory` that do not exist, shallowest first, and the deepest one that does.
 * Each component is checked from the root, so the first problem named is the one nearest the root.
 * It creates nothing: the refusals after it leave no folder behind, and the folders are made later
 * with createFolders. The caller resolves the parent as the realpath of `existing`, joined with the
 * folders still to be made, so an alias in the existing part is followed as the kernel would.
 */
function missingFolders(directory: string): { existing: string; missing: string[] } {
  const names = directory.split(sep).filter(Boolean);
  let existing: string = sep;
  for (const [index, name] of names.entries()) {
    const current = join(existing, name);
    if (standing(current) === "missing") {
      const missing: string[] = [];
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
function createFolders(folders: string[], made: MadeFolder[]): void {
  for (const folder of folders) {
    try {
      mkdirSync(folder, { mode: 0o700 });
      made.push(madeAt(folder));
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "ENOENT") throw error;
      if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
      if (realFolder(folder)) continue;
      throw new Error(`${folder} changed meanwhile: it is not a folder`);
    }
  }
}

/**
 * The places an output may never be, checked on the path it has. createBackup runs it once, before
 * the folders are made; the realpath check after them is what keeps that answer true.
 */
function checkBoundaries(output: string, data: string, uploads: string): void {
  if (inside(data, output))
    throw new Error(`The output ${output} would replace the data directory`);
  if (inside(output, uploads))
    throw new Error(`The output ${output} is inside the upload directory`);
}

/**
 * Removes the folders a failed or refused backup made, deepest first. Only the folder this call made
 * goes, and only if it is empty. A folder that another process has started using is left without a
 * word, since it is not this backup's to remove. A different folder at a made folder's path is left
 * alone and named. rmdir never follows a symlink, so a link at the path is refused too.
 */
function removeCreated(made: MadeFolder[], warn: (message: string) => void): void {
  for (const folder of [...made].reverse()) {
    const current = currentAt(folder.path);
    if (!current) continue;
    if (!isMade(folder, current)) {
      warn(
        `${folder.path} was made by this backup, but another folder is at its place; it is left alone`,
      );
      continue;
    }
    try {
      rmdirSync(folder.path);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") continue;
      warn(`${folder.path} was made by this backup and could not be removed: ${code}`);
    }
  }
}

/**
 * Removes the partial backup where this call made it, or names it. A path that no longer holds that
 * folder is not searched: the warning gives the path it was last known at, for the operator to remove.
 */
function removePartial(partial: MadeFolder, warn: (message: string) => void): void {
  if (!isMade(partial)) {
    warn(
      `${partial.path} is an interrupted backup and was not removed: its path no longer holds the folder this backup made; remove it by hand`,
    );
    return;
  }
  try {
    rmSync(partial.path, { recursive: true, force: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    warn(`${partial.path} is an interrupted backup and could not be removed: ${code}`);
  }
}

function changedMeanwhile(path: string): Error {
  return new Error(
    `${path} changed meanwhile: the backup in progress is no longer where it was made`,
  );
}

/**
 * Runs a step that writes into the partial backup. When the step fails and the partial is no longer
 * the folder this call made, the failure is that change, whatever its code, and is named as one.
 */
function whileMade<T>(made: MadeFolder, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (isMade(made)) throw error;
    throw changedMeanwhile(made.path);
  }
}

/** Refuses what no flag may replace; a forced replacement must hold a backup or nothing. */
function checkDestination(output: string, data: string, force: boolean): void {
  if (inside(data, output))
    throw new Error(`The output ${output} would replace the data directory`);
  if (!lstatSync(output, { throwIfNoEntry: false })) return;
  if (!force) throw new Error(`${output} already exists; pass --force to replace it`);
  if (!replaceable(output))
    throw new Error(`${output} does not look like a backup; not replacing it`);
}

/** Back where it was. Neither step replaces what took the name meanwhile, unless it is empty. */
function putBack(aside: string, output: string): void {
  try {
    if (lstatSync(aside).isDirectory()) renameSync(aside, output);
    else {
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
 * The live data directory holds a database, so `replaceable` would accept it. It is refused by
 * identity instead: a path that came to name it cannot fool a comparison of device and inode.
 */
function stepAside(output: string, live: Stats): string | undefined {
  const aside = join(dirname(output), `${REPLACED}${crypto.randomUUID()}`);
  try {
    renameSync(output, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const moved = lstatSync(aside);
  if (moved.dev === live.dev && moved.ino === live.ino) {
    putBack(aside, output);
    throw new Error(`${output} is the live data directory; not replacing it`);
  }
  if (replaceable(aside)) return aside;
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
  live: Stats,
): string | undefined {
  if (!isMade(partial)) throw changedMeanwhile(partial.path);
  const aside = force ? stepAside(output, live) : undefined;
  try {
    renameSync(partial.path, output);
  } catch (error) {
    if (aside) putBack(aside, output);
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR")
      throw new Error(`${output} already exists; pass --force to replace it`);
    if (code === "ENOENT") throw changedMeanwhile(partial.path);
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
  missing: string[],
  created: MadeFolder[],
): MadeFolder {
  let folders = missing;
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1) {
        const again = missingFolders(dirname(wanted));
        if (resolvedParent(wanted, again) !== parent)
          throw new Error(
            `${dirname(wanted)} changed meanwhile: it no longer resolves to ${parent}`,
          );
        folders = again.missing;
      }
      createFolders(folders, created);
      if (realpathSync(dirname(wanted)) !== parent)
        throw new Error(`${dirname(wanted)} changed meanwhile: it no longer resolves to ${parent}`);
      // The directory is 0700 from mkdtemp: see the database file in createBackup.
      return madeAt(mkdtempSync(join(parent, PARTIAL)));
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (attempt > 1)
        throw new Error(
          `${dirname(wanted)} changed meanwhile: a folder in it was removed or replaced`,
        );
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
      if (resolve(data, stored) !== source) writeUploadPath(db, relative(data, source));
    })();
    return source;
  } finally {
    db.close(true);
  }
}

export function createBackup(options: BackupOptions): Inspection & { path: string } {
  const { clock, warn } = options;
  const dataDir = resolve(options.dataDir);
  const databasePath = join(dataDir, DATABASE);
  if (!statSync(databasePath, { throwIfNoEntry: false }))
    throw new Error(`No database at ${databasePath}`);
  const data = realpathSync(dataDir);
  // The identity of the live data directory, taken before anything can move: see stepAside.
  const live = statSync(data);
  const wanted = resolve(options.output ?? join(dataDir, "backups", backupName(clock)));
  // Folders are created only after every check that can refuse; see missingFolders.
  const folders = missingFolders(dirname(wanted));
  const parent = resolvedParent(wanted, folders);
  const output = join(parent, basename(wanted));
  checkDestination(output, data, options.force ?? false);

  const db = new Database(databasePath, { readonly: true, strict: true, safeIntegers: true });
  let created: MadeFolder[] = [];
  let partial: MadeFolder | undefined;
  let flusher: Bun.Subprocess | undefined;
  try {
    db.run("PRAGMA busy_timeout = 5000");
    if (single<bigint>(db, "user_version") === 0n)
      throw new Error(`${databasePath} has no schema yet; start the server once`);
    const liveUploads = uploadRoot(data, storedUploadPath(db));
    checkBoundaries(output, data, liveUploads);
    const pages = single<bigint>(db, "page_count") - single<bigint>(db, "freelist_count");
    const needed =
      Number(pages * single<bigint>(db, "page_size")) +
      uploadedFiles(liveUploads).reduce((sum, { size }) => sum + size, 0);
    const available = (options.available ?? freeBytes)(realpathSync(folders.existing));
    if (needed > available)
      throw new Error(`A backup needs about ${needed} bytes and ${parent} has ${available} free`);
    // A folder that does not exist yet has no leftovers in it.
    for (const entry of folders.missing.length === 0 ? readdirSync(parent) : [])
      if (entry.startsWith(PARTIAL))
        warn(`${join(parent, entry)} is left from an interrupted backup or is one still running`);
      else if (entry.startsWith(REPLACED))
        warn(`${join(parent, entry)} is a backup that a forced backup did not finish replacing`);

    // Once openPartial has checked the path, output is parent joined with the basename, which is the
    // real path of the output. The boundaries were checked on that path above, so they are not
    // checked again.
    const made = openPartial(wanted, parent, folders.missing, created);
    partial = made;
    const snapshot = join(made.path, DATABASE);
    // The directory is 0700 from mkdtemp and the database 0600 from its first byte: SQLite writes
    // into an empty file it finds and keeps its mode.
    const source = whileMade(made, () => {
      closeSync(openSync(snapshot, "wx", 0o600));
      flusher = Bun.spawn([process.execPath, flushChildArgument, snapshot], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      const since = clock.now().toISOString();
      db.run("VACUUM INTO ?", [snapshot]);
      flusher.kill();
      const sealed = sealSnapshot(snapshot, since, data);
      sync(snapshot);
      return sealed;
    });

    // The database comes first. A file that arrives after it is one no row names, which nothing
    // serves. A file deleted after it is a row without a file, reported below.
    const uploads = relative(data, source);
    whileMade(made, () => {
      const target = join(made.path, uploads);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      chmodSync(target, 0o700);
      for (const { name } of uploadedFiles(source)) {
        try {
          copyFileSync(join(source, name), join(target, name), constants.COPYFILE_EXCL);
        } catch (error) {
          // A file the live server deleted after it was listed is skipped. Anything else missing is
          // the backup's own path, which whileMade names.
          const gone = !lstatSync(join(source, name), { throwIfNoEntry: false });
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && gone) continue;
          throw error;
        }
        chmodSync(join(target, name), 0o600);
        sync(join(target, name));
      }
      const manifest = join(made.path, MANIFEST);
      writeFileSync(manifest, `${JSON.stringify({ uploads })}\n`, { mode: 0o600, flag: "wx" });
      sync(manifest);
      for (let directory = target; directory !== parent; directory = dirname(directory))
        sync(directory);
    });

    const inspection = whileMade(made, () => inspect(made.path, clock, options.supportedVersion));
    options.beforePublish?.();
    const aside = publish(made, output, options.force ?? false, live);
    // The rename is the publication. From here nothing is undone: the partial is no longer a partial,
    // and the folders are the backup's parents and stay. A failure in what follows is a warning, since
    // the backup is in place and cleanup must not run over it.
    partial = undefined;
    created = [];
    try {
      sync(dirname(output));
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      warn(`${output} is published, but its folder could not be synced: ${code}`);
    }
    if (aside) {
      try {
        rmSync(aside, { recursive: true, force: true });
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        warn(
          `${aside} is the backup that ${output} replaced, and it could not be removed: ${code}`,
        );
      }
    }
    return { ...inspection, path: output };
  } finally {
    flusher?.kill();
    db.close(true);
    try {
      if (partial) removePartial(partial, warn);
    } finally {
      removeCreated(created, warn);
    }
  }
}

export interface ReleaseOptions {
  dataDir: string;
  clock: Clock;
  supportedVersion: number;
}

/** Ends a restore hold, on a stopped server: otherwise it changes what one reads between claims. */
export function releaseHold(options: ReleaseOptions): HoldRecord | null {
  return withStoppedDatabase(options.dataDir, options.supportedVersion, (db) =>
    writeTransaction(db, () => {
      const record = holdRecord(db);
      if (!record || record.releasedAt !== null) return null;
      const at = options.clock.now().toISOString();
      releaseRestoreHold(db, record, at);
      return { since: record.since, releasedAt: at };
    }),
  );
}
