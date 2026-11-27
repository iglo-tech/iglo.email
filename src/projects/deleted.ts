// A deleted project's final snapshot (14-projects sections 1 and 10; B143a, D157). Native: listmonk
// has no projects. The project is already stopped and its database closed: the database file is
// copied as `backups/deleted/<slug>-<timestamp>.db` (with `-2`, `-3`… when that name is taken; never
// replaced), every other file of the directory (its uploads) goes into `<slug>-<timestamp>.tar`
// beside it, and then the directory is removed.
import { Database } from "bun:sqlite";
import { constants, existsSync, opendirSync } from "node:fs";
import type { Dir } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Clock } from "@/clock";
import { PROJECT_DATABASE, projectDirectory } from "@/projects/layout";

/** Where the final snapshots of deleted projects go. */
export function deletedDirectory(dataDir: string): string {
  return join(dataDir, "backups", "deleted");
}

/**
 * B149b r2/r3 (D165): whether a deleted project's final snapshot is kept, so the instance has served
 * more than one project (an instance that deleted one before it recorded that in its registry).
 * Only names are read, one at a time, stopping at the first `.db`. A missing directory is the usual
 * case (`none`); one that cannot be listed fails no start: `attention` names it and the answer is
 * `unlisted`, which the caller treats as several projects for that start only (B155a, D176).
 */
export function deletedSnapshots(
  dataDir: string,
  attention: (line: string) => void,
): "found" | "none" | "unlisted" {
  let dir: Dir;
  try {
    dir = opendirSync(deletedDirectory(dataDir));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "none";
    }
    attention(unlisted(error));
    return "unlisted";
  }
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (entry.name.endsWith(".db")) {
        return "found";
      }
    }
    return "none";
  } catch (error) {
    attention(unlisted(error));
    return "unlisted";
  } finally {
    dir.closeSync();
  }
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
const unlisted = (error: unknown) =>
  `backups/deleted cannot be listed (${errorCode(error) || String(error)}): the instance is ` +
  "treated as one that has served several projects until it can be listed at a start";

export interface DeletedProject {
  /** The database snapshot, relative to the data directory. */
  readonly database: string;
  /** The tarball of the project's other files, relative to the data directory; null without any. */
  readonly files: string | null;
}

/** The files of a project's database: the database, its WAL and shared-memory files. */
const databaseFiles = new Set([
  PROJECT_DATABASE,
  `${PROJECT_DATABASE}-wal`,
  `${PROJECT_DATABASE}-shm`,
]);
/** D62 staging: temporary copies, never kept. */
const STAGE = "stage";

/**
 * How far one project's archive got (B149a, D164). The caller keeps it across attempts, so a retry
 * after a failure resumes from the step that failed and never repeats a finished one: the snapshot
 * is claimed once, the tarball written once, and only then is the directory removed.
 */
export interface ArchiveProgress {
  /** The snapshot's absolute path once its name is claimed (the database is copied there). */
  database?: string;
  /** Once the tarball is written: its absolute path, or null when there was no file to archive. */
  files?: string | null;
}

/**
 * Moves a closed project's database to its final snapshot, archives its other files, then removes
 * its directory. The database is checkpointed first so the one file holds every committed write.
 * Each step records itself in `progress` once done, so calling again with the same `progress`
 * after a failure finishes from the failed step.
 */
export async function archiveDeleted(
  dataDir: string,
  slug: string,
  clock: Clock,
  progress: ArchiveProgress = {},
): Promise<DeletedProject> {
  const directory = projectDirectory(dataDir, slug);
  const target = deletedDirectory(dataDir);
  const source = join(directory, PROJECT_DATABASE);
  if (progress.database === undefined) {
    await mkdir(target, { recursive: true });
    // B155a r1 (D176): a copy an earlier attempt of this delete left when it stopped (a crash)
    // between the copy and its claim is never a snapshot; the copy is made again below.
    await removeStalePartials(target, slug);
    if (existsSync(source)) {
      const db = new Database(source, { strict: true });
      try {
        db.run("PRAGMA busy_timeout = 5000");
        const result = db
          .query<{ busy: number | bigint }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
          .get();
        if (Number(result?.busy ?? 1) !== 0) {
          throw new Error(`The database of ${slug} is still in use: nothing was moved`);
        }
      } finally {
        db.close(true);
      }
    }
    progress.database = await claimName(
      source,
      target,
      `${slug}-${clock.now().toISOString().replaceAll(":", "-")}`,
    );
  }
  // The snapshot is its own file (B155a, D176): a delete that stops after this step leaves the
  // project's database in its directory, and opening that leftover in place (sqlite3, a
  // checkpoint) must not change the only snapshot of the deleted project.
  const database = progress.database;
  if (progress.files === undefined) {
    // The name was claimed with no `.tar` beside it, so a tarball there is this delete's partial one.
    const tarball = `${database.slice(0, -".db".length)}.tar`;
    await rm(tarball, { force: true });
    try {
      progress.files = await tarFiles(directory, tarball);
    } catch (error) {
      // The database stays in its snapshot; the retry writes the tarball again from the start.
      await rm(tarball, { force: true }).catch(() => {});
      throw error;
    }
  }
  // B155a r1 (D176): the snapshot's and the tarball's names reach the disk before the project's
  // directory goes, so a crash right after the delete never leaves the snapshot's name missing
  // (each file's data was synced before its name was claimed). Repeated on a retry: a sync of a
  // directory with nothing pending costs nothing.
  for (const path of [target, dirname(target), dataDir]) {
    await syncPath(path);
  }
  await rm(directory, { recursive: true, force: true });
  return {
    database: relative(dataDir, database),
    files: progress.files ? relative(dataDir, progress.files) : null,
  };
}

/**
 * Copies the database as `<base>.db`, or `<base>-2.db`, `-3`… when an earlier snapshot has that name
 * (two deletes of one slug in the same millisecond, or a clock set back; B149a, D164), and returns
 * the claimed path. The copy is written as `<base>.db.partial` first (a clone where the filesystem
 * can, B155a, D176), then claimed with a hard link, which fails on a taken name where `rename`
 * would replace it. A name whose `.tar` exists is skipped too, so the pair is always one delete's.
 * A failure removes the partial copy; a crash can leave one, which no start counts as a snapshot
 * and the next attempt of the delete removes.
 */
async function claimName(source: string, target: string, base: string): Promise<string> {
  const partial = join(target, `${base}.db.partial`);
  try {
    await copyFile(source, partial, constants.COPYFILE_FICLONE);
    // B155a r1 (D176): the copy's data is on disk before any name claims it. A plain copy goes
    // through the page cache, and the project's database is removed once the delete finishes.
    await syncPath(partial);
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const database = join(target, `${name}.db`);
      if (existsSync(join(target, `${name}.tar`))) {
        continue;
      }
      try {
        await link(partial, database);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          continue;
        }
        throw error;
      }
      return database;
    }
  } finally {
    // The claimed name keeps the copy; one this cannot remove is left over, never counted.
    await rm(partial, { force: true }).catch(() => {});
  }
}

/** Flushes a file's data, or a directory's entries, to the disk. */
async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Removes the `.db.partial` copies an earlier attempt of this slug's delete left: the name is the
 * slug, then the delete's timestamp, so another slug's (`<slug>-old-…`) never matches.
 */
async function removeStalePartials(target: string, slug: string): Promise<void> {
  const stale = new RegExp(
    `^${slug}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.db\\.partial$`,
  );
  for (const name of await readdir(target)) {
    if (stale.test(name)) {
      await rm(join(target, name), { force: true });
    }
  }
}

/** Every regular file and directory under `directory` except the database and staging. */
async function* walk(directory: string, base = directory): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const inside = relative(base, path);
    if (directory === base && (databaseFiles.has(entry.name) || entry.name === STAGE)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield `${inside}/`;
      yield* walk(path, base);
    } else if (entry.isFile()) {
      yield inside;
    }
  }
}

const BLOCK = 512;
const encoder = new TextEncoder();

/** The largest value of a 12-byte ustar number field: 11 octal digits (8 GiB less one byte). */
const OCTAL_MAX = 0o777_7777_7777;

function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  // A value the field cannot hold would spill into the next field: callers carry it in PAX (D193).
  if (!Number.isSafeInteger(value) || value < 0 || digits.length > length - 1) {
    throw new Error(`${value} does not fit a ${length}-byte tar field`);
  }
  header.set(encoder.encode(digits.padStart(length - 1, "0")), offset);
}

/** A value clamped to the ustar number range; the exact one goes in a PAX record. */
const clamped = (value: number) => Math.min(Math.max(value, 0), OCTAL_MAX);

/**
 * One ustar header block. A name longer than its field, a time before 1970 or past the field's
 * range, and a size of 8 GiB or more are carried by PAX records before it; the fields hold the
 * clamped value.
 */
function header(name: string, type: "0" | "5" | "x", size: number, seconds: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const short = encoder.encode(name).subarray(0, 100);
  block.set(short, 0);
  octal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, clamped(size));
  octal(block, 136, 12, clamped(seconds));
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.set(encoder.encode("ustar\u000000"), 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
  return block;
}

/** One PAX record: `path` for a long name, `mtime` and `size` for values the fields cannot hold. */
function paxRecord(key: "path" | "mtime" | "size", value: string): string {
  const body = ` ${key}=${value}\n`;
  const size = encoder.encode(body).length;
  // The record's length counts its own digits.
  let length = size + String(size).length;
  length = size + String(length).length;
  return `${length}${body}`;
}

/** The PAX records an entry needs, or an empty string when its ustar header holds it all. */
function paxRecords(name: string, size: number, seconds: number): string {
  return (
    (encoder.encode(name).length > 100 ? paxRecord("path", name) : "") +
    (clamped(seconds) !== seconds ? paxRecord("mtime", String(seconds)) : "") +
    (size > OCTAL_MAX ? paxRecord("size", String(size)) : "")
  );
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * Writes an uncompressed tar of the directory's files, one file at a time through a stream, so its
 * memory is bounded whatever the uploads weigh (only the names are listed first). Returns its path,
 * or null when there is no file: empty directories alone make no tarball.
 */
async function tarFiles(directory: string, path: string): Promise<string | null> {
  const names = await Array.fromAsync(walk(directory));
  if (names.every((name) => name.endsWith("/"))) {
    return null;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for (const name of names) {
      handle ??= await open(path, "wx", 0o600);
      const full = join(directory, name);
      const stat = await lstat(full);
      const entry = name;
      const seconds = Math.floor(stat.mtimeMs / 1000);
      const size = entry.endsWith("/") ? 0 : stat.size;
      const records = paxRecords(entry, size, seconds);
      if (records) {
        const record = encoder.encode(records);
        await handle.write(header("PaxHeader", "x", record.length, seconds));
        await handle.write(record);
        await handle.write(padding(record.length));
      }
      if (entry.endsWith("/")) {
        await handle.write(header(entry, "5", 0, seconds));
        continue;
      }
      await handle.write(header(entry, "0", size, seconds));
      let written = 0;
      for await (const chunk of Bun.file(full).stream()) {
        await handle.write(chunk);
        written += chunk.length;
      }
      if (written !== stat.size) {
        throw new Error(`${name} changed while it was archived`);
      }
      await handle.write(padding(written));
    }
    if (!handle) {
      return null;
    }
    await handle.write(new Uint8Array(BLOCK * 2));
    await handle.sync();
    return path;
  } finally {
    await handle?.close();
  }
}
