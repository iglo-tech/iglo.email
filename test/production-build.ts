// The production build (`bun run build`) that tests use: `dist/iglo.email` and the embedded assets
// in `dist/assets`, which in-process tests import through `src/server/asset-manifest.ts`.
//
// Several test runs may share one checkout: `bun run test` in the background and a targeted
// `bun test <file>` beside it, or two bare runs. So a run builds only when the build is missing or
// out of date, and a build never deletes or truncates a file another run may be reading (D168):
//
// - Fresh: a stamp in `dist/.test-build` records a hash of the build's inputs (their paths and
//   contents, not timestamps), a hash of the template reference the build regenerates, and the
//   identity of the outputs it produced. A run whose inputs hash the same, whose reference is the
//   one the build wrote and whose outputs are still the ones recorded builds nothing.
// - Staged: a rebuild runs `bun run build` in a copy of the inputs under `dist/.test-build`, then
//   moves each new file into place with `rename`, the assets first, then the manifest that names
//   them, then the executable. A reader sees either a whole old file or a whole new one. Old asset
//   files stay, so a manifest a running file has already imported still names files that exist;
//   the next `bun run build` (which deletes `dist/assets`) clears them.
// - Serialized: builders in one checkout take an exclusive `flock` on a file beside the stamp. A
//   builder that waited checks the stamp again, so concurrent runs build once. The kernel releases
//   the lock when its holder exits, killed or not, so there is no owner to check and nothing to
//   take over (D178).
//
// The lock, the stamp and the staging copies live in the checkout's own `dist/`, so they go when
// the checkout does. `bun run test` runs this file before its workers start and sets
// IGLO_TEST_PREBUILT, so no file of that run checks again; any other `bun test` run (a file, a
// directory, a bare `--parallel` run) checks through `test/preload.ts` before each file.
import { FFIType, dlopen, read } from "bun:ffi";
import { must } from "@/invariant";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { asBody } from "@/test/read-body";

const repository = resolve(import.meta.dir, "..");
const dist = join(repository, "dist");
const work = join(dist, ".test-build");
// Never removed: a waiter holds a descriptor of this file, and a removed file would give the next
// builder another one, so two could hold "the" lock.
const lockFile = join(work, "build.lock");
const stampFile = join(work, "stamp");
// What `bun run build` reads: copied into a staging checkout and hashed for the stamp. bun.lock and
// patches/ stand for node_modules, which the staging checkout links to.
const inputs = [
  "src",
  "assets",
  "scripts",
  "i18n",
  "migrations",
  "patches",
  "docs/design/06-templates.md",
  "LICENSE",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  ".oxfmtrc.json",
];
// Written by the build, so neither an input nor copied: the asset manifest, and the template
// reference regenerated from docs/design/06-templates.md. The reference is tracked, so a checkout
// can change it alone; its hash is in the stamp, and a copy that is not the one the build wrote is
// rewritten by the next check (D178).
const manifest = "src/server/asset-manifest.ts";
const reference = "src/mcp/reference.ts";
const generated = new Set([manifest, reference]);
// A held lock is waited for as long as its holder lives: a build takes seconds, and the kernel
// releases the lock of a holder that dies.
const holdLimitMs = 15 * 60_000;
const LOCK_EX = 2;
const LOCK_NB = 4;
// EWOULDBLOCK (= EAGAIN) on Linux, x86-64 and arm64 alike: the lock is held by another.
const EWOULDBLOCK = 11;
// EINTR: a signal arrived during the call; the next attempt is as good as this one (D183).
const EINTR = 4;
let built: Promise<void> | undefined;

function files(path: string, into: Array<string>): Array<string> {
  let entries;
  try {
    entries = readdirSync(join(repository, path), { withFileTypes: true });
  } catch (error) {
    const code = asBody<NodeJS.ErrnoException>(error).code;
    if (code === "ENOTDIR") {
      into.push(path);
    } else if (code !== "ENOENT") {
      throw error;
    }
    return into;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      files(child, into);
    } else if (!generated.has(child)) {
      into.push(child);
    }
  }
  return into;
}

// A hash of every input's path and contents.
function inputHash(): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of inputs.flatMap((input) => files(input, []))) {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(repository, path)))
      .update("\0");
  }
  return hash.digest("hex");
}

// A hash of the checkout's template reference, or "none" when it has none.
function referenceHash(text = readReference()): string {
  return text === undefined ? "none" : new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function readReference(): Buffer | undefined {
  try {
    return readFileSync(join(repository, reference));
  } catch {
    return undefined;
  }
}

// The outputs as they are now: the manifest's contents, and the inode, size and change time of the
// executable and the assets directory. Any write to the executable (`bun run build` from other
// sources, even into the same inode at the same size) and any recreation of the assets directory
// moves a change time, which no process can set back, so such a build is never taken for the
// recorded one (D178). Reading or copying the executable moves nothing.
function outputIdentity(): string | undefined {
  try {
    const executable = statSync(join(dist, "iglo.email"), { bigint: true });
    const assets = statSync(join(dist, "assets"), { bigint: true });
    const text = readFileSync(join(repository, manifest));
    return [
      Bun.hash(text).toString(36),
      executable.ino,
      executable.size,
      executable.ctimeNs,
      assets.ino,
      assets.ctimeNs,
    ].join(":");
  } catch {
    return undefined;
  }
}

function stamp(inputs: string, referenced: string, outputs: string): string {
  return `${inputs}\n${referenced}\n${outputs}`;
}

function fresh(inputs: string): boolean {
  const outputs = outputIdentity();
  if (outputs === undefined) {
    return false;
  }
  try {
    return readFileSync(stampFile, "utf-8") === stamp(inputs, referenceHash(), outputs);
  } catch {
    return false;
  }
}

// libc's flock(2) and errno, loaded when a build is needed: neither Node's nor Bun's file API has
// flock.
let libc: ReturnType<typeof loadLibc> | undefined;

function loadLibc() {
  return dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
}

// flock(2)'s result: 0, or the errno of its failure, read at once after the call.
function flockCall(descriptor: number, operation: number): number {
  libc ??= loadLibc();
  if (libc.flock(descriptor, operation) === 0) {
    return 0;
  }
  return read.i32(must(libc.__errno_location(), "errno location"), 0);
}

// Takes the checkout's build lock and returns its descriptor; closing it releases the lock. A
// non-blocking attempt every 50 ms keeps this process's event loop running while it waits. Only
// "held by another" (EWOULDBLOCK) is waited on, and an interrupted call (EINTR) is retried; any
// other error fails at once (D178, D183).
async function acquire(): Promise<number> {
  mkdirSync(work, { recursive: true });
  const descriptor = openSync(lockFile, "a");
  try {
    const start = Date.now();
    for (let errno = flockCall(descriptor, LOCK_EX | LOCK_NB); errno !== 0;) {
      if (errno !== EWOULDBLOCK && errno !== EINTR) {
        throw new Error(`Cannot lock ${lockFile}: flock failed with errno ${errno}`);
      }
      if (Date.now() - start > holdLimitMs) {
        throw new Error(
          errno === EINTR
            ? `Cannot lock ${lockFile}: flock was still being interrupted (EINTR) after ${holdLimitMs} ms of retries`
            : `Production build lock ${lockFile} is still held by a live process`,
        );
      }
      await Bun.sleep(50);
      errno = flockCall(descriptor, LOCK_EX | LOCK_NB);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

// Moves every file under `from` to the same place under `to`, replacing a file there by `rename`
// and deleting nothing.
function publishTree(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      publishTree(source, target);
    } else {
      renameSync(source, target);
    }
  }
}

function publishFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

// Builds in a staging copy and moves the outputs into place; returns the template reference the
// build wrote.
async function rebuild(): Promise<Buffer> {
  // Staging copies left by a builder that died; the lock is held, so none is in use.
  for (const name of readdirSync(work)) {
    if (name.startsWith("stage-")) {
      rmSync(join(work, name), { recursive: true, force: true });
    }
  }
  const stage = join(work, `stage-${process.pid}-${Date.now()}`);
  try {
    for (const input of inputs) {
      if (existsSync(join(repository, input))) {
        cpSync(join(repository, input), join(stage, input), {
          recursive: true,
          filter: (source) => !generated.has(relative(repository, source)),
        });
      }
    }
    symlinkSync(join(repository, "node_modules"), join(stage, "node_modules"));
    const child = Bun.spawn([process.execPath, "run", "build"], {
      cwd: stage,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`Build failed:\n${stdout}\n${stderr}`);
    }
    // Assets before the manifest that names them; the executable embeds its own copy.
    mkdirSync(join(dist, "assets"), { recursive: true });
    publishTree(join(stage, "dist/assets"), join(dist, "assets"));
    publishFile(join(stage, manifest), join(repository, manifest));
    // The build regenerates the reference from the design text; a checkout whose copy is out of
    // date gets the new one, as `bun run build` would write it.
    const next = readFileSync(join(stage, reference));
    const current = readReference();
    if (current === undefined || !next.equals(current)) {
      publishFile(join(stage, reference), join(repository, reference));
    }
    publishFile(join(stage, "dist/iglo.email"), join(dist, "iglo.email"));
    return next;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function build(): Promise<void> {
  if (fresh(inputHash())) {
    return;
  }
  const held = await acquire();
  try {
    // Another run may have built while this one waited for the lock.
    const before = inputHash();
    if (fresh(before)) {
      return;
    }
    const written = await rebuild();
    // Recorded against the inputs read before the build and the reference the build wrote, so an
    // edit made during it, of either, is rebuilt by the next check.
    const outputs = outputIdentity();
    if (outputs !== undefined) {
      writeFileSync(`${stampFile}.${process.pid}`, stamp(before, referenceHash(written), outputs));
      renameSync(`${stampFile}.${process.pid}`, stampFile);
    }
  } finally {
    // Closing the descriptor releases the lock; the file stays (see lockFile).
    closeSync(held);
  }
}

export function ensureProductionBuild(): Promise<void> {
  if (process.env.IGLO_TEST_PREBUILT === "1") {
    return Promise.resolve();
  }
  built ??= build();
  return built;
}

// `bun test/production-build.ts`: the build step of `bun run test`.
if (import.meta.main) {
  await build();
}
