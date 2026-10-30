// Adapted from listmonk internal/media/providers/filesystem/filesystem.go and makeFilename and
// appendSuffixToFilename in cmd/utils.go at 6fcd95f. Uploads are one flat directory of regular
// files inside the data directory (D64): names are single path components, nothing here follows
// a symlink at that level, and the directory's own path is checked component by component.
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export interface FilesystemSettings {
  uploadPath: string;
  uploadUri: string;
}

/**
 * Temporary files, inside the directory for an atomic rename. No stored name can start with a
 * dot, and this name says whose it is: an operator's `.tmp` is not ours to touch.
 */
const TEMPORARY = ".iglo-email-uploading";
const temporaryFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A name fits every common filesystem's 255 bytes, with room for a unique suffix. */
const MAX_NAME_BYTES = 200;
/**
 * Paths of the application. An upload URI cannot shadow them, and reading settings for each of
 * these requests, among them every tracked link and view, is skipped.
 */
const RESERVED_URIS = [
  "/api",
  "/admin",
  "/public",
  "/webhooks",
  "/link",
  "/campaign",
  "/subscription",
  "/archive",
  "/m",
  "/health",
];
const reserved = (path: string) =>
  RESERVED_URIS.some((uri) => path === uri || path.startsWith(`${uri}/`));

const uniqueTries = 8;

function randomString(length: number): string {
  const dictionary = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (value) => dictionary[value % dictionary.length],
  ).join("");
}

/** The longest prefix of `value` within `bytes` UTF-8 bytes, on a code point boundary. */
function truncate(value: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const char of value) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    out += char;
  }
  return out;
}

/**
 * makeFilename, for a name from outside: only its last component, whatever the separator, with
 * no whitespace, control or format characters and no leading dots, so it can name nothing but a
 * visible file in the upload directory.
 */
export function makeFilename(raw: string): string {
  const base =
    raw.trim().replace(/\s+/g, "-").replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ??
    "";
  const name = base.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/^\.+/, "");
  if (!name) return randomString(10);
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = truncate(extname(name), 32);
  return truncate(name.slice(0, name.length - extname(name).length), MAX_NAME_BYTES - 32) + ext;
}

/** The lowercase extension without its dot; listmonk's check in cmd/media.go: UploadMedia. */
export function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

export function appendSuffix(name: string): string {
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}_${randomString(6)}${ext}`;
}

/** Whether a stored or requested name is one visible entry of the upload directory. */
function singleComponent(name: string): boolean {
  return !!name && !name.startsWith(".") && !/[/\\\0]/.test(name);
}

/** `path` with each component that exists resolved; only a missing tail stays as written. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // realpath also says ENOENT for a broken link, and writing through one leaves this path.
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Broken link");
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), basename(path));
}

/** A setting that names a refused directory. Media stops; everything else runs on (D64). */
export class UploadRootError extends Error {}

/**
 * The real directory of `upload_path`: strictly inside the real data directory, which holds the
 * database. Relative paths are under the data directory. Other storage is mounted there.
 */
export function uploadRoot(dataDir: string, uploadPath: string): string {
  const refused = new UploadRootError(
    `The upload path "${uploadPath}" must be a directory inside the data directory. ` +
      "To use other storage, mount it there.",
  );
  let dir: string;
  let inside: string;
  try {
    const data = realpathSync(resolve(dataDir));
    inside = data.endsWith(sep) ? data : data + sep;
    dir = canonical(resolve(data, uploadPath.trim() || "uploads"));
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === false) throw refused;
  } catch {
    throw refused;
  }
  if (!dir.startsWith(inside)) throw refused;
  return dir;
}

export function createFilesystem(dataDir: string, settings: () => FilesystemSettings) {
  const directory = () => uploadRoot(dataDir, settings().uploadPath);
  /** filepath.Clean of the URI, or null when it cannot serve files. */
  function uri(): string | null {
    const clean = settings()
      .uploadUri.trim()
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "");
    if (!clean.startsWith("/") || /[?#\\]/.test(clean) || clean.split("/").includes(".."))
      return null;
    return reserved(clean) ? null : clean;
  }
  /** Characters with a meaning in a URL are escaped, so that it names the file. */
  const escapeName = (name: string) =>
    name.replace(/[%#?"<>]/g, (char) => encodeURIComponent(char));

  return {
    /** The path of a stored name, beginning at `rootUrl`, as `GetURL`. */
    url(rootUrl: string, name: string): string {
      return `${rootUrl}${uri() ?? settings().uploadUri}/${escapeName(name)}`;
    },
    /** The stored name a request path can name, if it is one single component of the URI. */
    nameOf(pathname: string): string | undefined {
      if (reserved(pathname)) return undefined;
      const prefix = uri();
      if (prefix === null) return undefined;
      const base = `${encodeURI(prefix)}/`;
      if (!pathname.startsWith(base)) return undefined;
      try {
        const name = decodeURIComponent(pathname.slice(base.length));
        return singleComponent(name) ? name : undefined;
      } catch {
        return undefined;
      }
    },
    /** The upload directory now, or an error saying why it is refused. */
    root: directory,
    /** Whether `root` is still the upload directory, for the end of a long operation. */
    current(root: string): boolean {
      try {
        return directory() === root;
      } catch {
        return false;
      }
    },
    /** Stores bytes under `name` in `dir`, or a suffixed name if it is taken; returns the name. */
    async put(
      dir: string,
      name: string,
      bytes: Uint8Array,
      taken: (name: string) => boolean,
    ): Promise<string> {
      const temporary = join(dir, TEMPORARY);
      await mkdir(temporary, { recursive: true });
      if (!(await lstat(temporary)).isDirectory()) throw new Error("Unusable temporary directory");
      const path = join(temporary, crypto.randomUUID());
      let stored: string | undefined;
      try {
        const file = await open(path, "wx", 0o644);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        // The exclusive create claims the name, so the rename cannot replace anything: not
        // another upload, and not a symlink someone left in the directory.
        for (let i = 0; i < uniqueTries && stored === undefined; i++) {
          const candidate = i === 0 && !taken(name) ? name : appendSuffix(name);
          if (taken(candidate)) continue;
          try {
            closeSync(openSync(join(dir, candidate), "wx", 0o644));
            stored = candidate;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        if (stored === undefined) throw new Error("No unique filename");
        renameSync(path, join(dir, stored));
        const entry = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await entry.sync();
        } finally {
          await entry.close();
        }
        return stored;
      } catch (error) {
        if (stored !== undefined) await rm(join(dir, stored), { force: true });
        throw error;
      } finally {
        await rm(path, { force: true });
      }
    },
    /** A stored regular file, or null: a symlink is never followed out of the directory. */
    async stat(name: string) {
      if (!singleComponent(name)) return null;
      const path = join(directory(), name);
      const stats = await lstat(path).catch(() => null);
      return stats?.isFile() ? { path, size: stats.size, modified: stats.mtimeMs } : null;
    },
    async read(path: string): Promise<Buffer> {
      return readFile(path);
    },
    /** Delete. A file already gone is what was asked for. */
    async remove(name: string, dir = directory()): Promise<void> {
      if (singleComponent(name)) await rm(join(dir, name), { force: true });
    },
    /**
     * Temporary files of an upload cut off by a crash; no upload runs yet at startup. Only this
     * module's own: regular files, named as it names them, directly in its directory.
     */
    async sweep(): Promise<void> {
      const temporary = join(directory(), TEMPORARY);
      if (!(await lstat(temporary).catch(() => null))?.isDirectory()) return;
      for (const entry of await readdir(temporary, { withFileTypes: true }))
        if (entry.isFile() && temporaryFile.test(entry.name))
          await rm(join(temporary, entry.name), { force: true });
    },
  };
}
export type Filesystem = ReturnType<typeof createFilesystem>;
