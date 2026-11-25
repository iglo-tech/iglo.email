// A deleted project's final snapshot (14-projects sections 1 and 10; B143a, D157). Native: listmonk
// has no projects. The project is already stopped and its database closed: the database file is
// linked as `backups/deleted/<slug>-<timestamp>.db` (with `-2`, `-3`… when that name is taken; never
// replaced), every other file of the directory (its uploads) goes into `<slug>-<timestamp>.tar`
// beside it, and then the directory is removed.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Clock } from "@/clock";
import { PROJECT_DATABASE, projectDirectory } from "@/projects/layout";

/** Where the final snapshots of deleted projects go. */
export function deletedDirectory(dataDir: string): string {
  return join(dataDir, "backups", "deleted");
}

/**
 * B149b r2 (D165): whether a deleted project's final snapshot is kept, so the instance has served
 * more than one project (an instance that deleted one before it recorded that in its registry).
 */
export function hasDeletedSnapshots(dataDir: string): boolean {
  const target = deletedDirectory(dataDir);
  return existsSync(target) && readdirSync(target).some((name) => name.endsWith(".db"));
}

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
  /** The snapshot's absolute path once its name is claimed (the database is linked there). */
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
  // The snapshot is a second name of the database file: removing the directory drops the first.
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
  await rm(directory, { recursive: true, force: true });
  return {
    database: relative(dataDir, database),
    files: progress.files ? relative(dataDir, progress.files) : null,
  };
}

/**
 * Links the database as `<base>.db`, or `<base>-2.db`, `-3`… when an earlier snapshot has that name
 * (two deletes of one slug in the same millisecond, or a clock set back; B149a, D164), and returns
 * the claimed path. A hard link fails on a taken name, where `rename` would replace it. A name whose `.tar` exists is skipped too, so the pair is always one
 * delete's.
 */
async function claimName(source: string, target: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const database = join(target, `${name}.db`);
    if (existsSync(join(target, `${name}.tar`))) {
      continue;
    }
    try {
      await link(source, database);
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

function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  header.set(encoder.encode(value.toString(8).padStart(length - 1, "0")), offset);
}

/** One ustar header block; a name longer than its field is carried by a PAX record before it. */
function header(name: string, type: "0" | "5" | "x", size: number, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const short = encoder.encode(name).subarray(0, 100);
  block.set(short, 0);
  octal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, Math.floor(mtime / 1000));
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.set(encoder.encode("ustar\u000000"), 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
  return block;
}

/** A PAX `path` record, for a name that does not fit the 100-byte field. */
function paxPath(name: string): Uint8Array {
  const body = ` path=${name}\n`;
  const size = encoder.encode(body).length;
  // The record's length counts its own digits.
  let length = size + String(size).length;
  length = size + String(length).length;
  return encoder.encode(`${length}${body}`);
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
      if (encoder.encode(entry).length > 100) {
        const record = paxPath(entry);
        await handle.write(header("PaxHeader", "x", record.length, stat.mtimeMs));
        await handle.write(record);
        await handle.write(padding(record.length));
      }
      if (entry.endsWith("/")) {
        await handle.write(header(entry, "5", 0, stat.mtimeMs));
        continue;
      }
      await handle.write(header(entry, "0", stat.size, stat.mtimeMs));
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
