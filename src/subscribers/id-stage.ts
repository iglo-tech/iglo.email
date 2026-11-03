// Subscriber IDs staged on disk, so a selection of any size costs the parent a batch rather
// than about 40 bytes per ID in boxed bigints (docs/perf/B7-load-memory.md). A file holds one
// signed 64-bit little-endian integer per ID. The reader child writes it, the parent opens it,
// unlinks it at once and reads batches by position; an unlinked file disappears when its
// descriptor closes, including when the process is killed. Files a crash left between
// creation and that unlink are removed when the staging directory is next prepared.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const WIDTH = 8;
/** IDs buffered before a write; also the size of a progress step the child reports. */
export const STAGE_CHUNK = 8192;
const PREFIX = "q-";

/** A read-only sequence of IDs, in memory or on disk. `close` frees the disk file. */
export interface IdList {
  readonly length: number;
  slice(start: number, end: number): bigint[];
  close(): void;
}

export function memoryIds(ids: bigint[]): IdList {
  return { length: ids.length, slice: (start, end) => ids.slice(start, end), close() {} };
}

/** IDs `[start, end)` of the file behind `fd`, by position. */
export function readIds(fd: number, start: number, end: number): bigint[] {
  const count = Math.max(0, end - start);
  if (!count) return [];
  const buffer = Buffer.allocUnsafe(count * WIDTH);
  let filled = 0;
  while (filled < buffer.length) {
    const got = readSync(fd, buffer, filled, buffer.length - filled, start * WIDTH + filled);
    if (got === 0) break;
    filled += got;
  }
  const ids: bigint[] = [];
  for (let at = 0; at + WIDTH <= filled; at += WIDTH) ids.push(buffer.readBigInt64LE(at));
  return ids;
}

/** An open staged file (already unlinked) as an IdList; takes ownership of `fd`. */
export function fileIds(fd: number, length = Math.floor(fstatSync(fd).size / WIDTH)): IdList {
  let open = true;
  return {
    length,
    slice: (start, end) => readIds(fd, start, Math.min(end, length)),
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

/** Appends IDs to a file in chunks. */
export function createIdWriter(path: string) {
  const fd = openSync(path, "w", 0o600);
  let buffer = Buffer.allocUnsafe(STAGE_CHUNK * WIDTH);
  let used = 0;
  let written = 0;
  const flush = () => {
    let at = 0;
    while (at < used) at += writeSync(fd, buffer, at, used - at);
    written += used / WIDTH;
    used = 0;
  };
  return {
    push(id: bigint) {
      buffer.writeBigInt64LE(id, used);
      used += WIDTH;
      if (used === buffer.length) flush();
    },
    /** Write what is buffered; returns the total written so far. */
    flush(): number {
      flush();
      return written;
    },
    close() {
      closeSync(fd);
      buffer = Buffer.alloc(0);
    },
  };
}

/** Create the staging directory and remove files that an earlier run left behind. */
export function prepareStageDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir))
    if (name.startsWith(PREFIX)) rmSync(join(dir, name), { force: true });
}

let counter = 0;
/** A unique file name prefix inside the staging directory. */
export function stagePrefix(dir: string): string {
  return join(dir, `${PREFIX}${process.pid}-${Date.now().toString(36)}-${counter++}-`);
}

/** Open a staged file for reading and unlink it, so closing the descriptor frees the disk. */
export function openAndUnlink(path: string): number {
  const fd = openSync(path, "r");
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  return fd;
}

/** Stage rows (the first column of each) from the parent, for built-in filters. */
export function stageRows(dir: string, rows: Iterable<bigint>): IdList {
  const path = `${stagePrefix(dir)}0`;
  const writer = createIdWriter(path);
  let fd: number;
  try {
    for (const id of rows) writer.push(id);
    writer.flush();
    writer.close();
    fd = openAndUnlink(path);
  } catch (error) {
    try {
      writer.close();
    } catch {
      /* closed */
    }
    rmSync(path, { force: true });
    throw error;
  }
  return fileIds(fd);
}
