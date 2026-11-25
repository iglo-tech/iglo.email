// The production build (`bun run build`) that tests use: `dist/iglo.email` and the embedded assets
// in `dist/assets`, which in-process tests import through `src/server/asset-manifest.ts`.
//
// Several test runs may share one checkout: `bun run test` in the background and a targeted
// `bun test <file>` beside it, or two bare runs. So a run builds only when the build is missing or
// out of date, and a build never deletes or truncates a file another run may be reading (D168):
//
// - Fresh: a stamp in `dist/.test-build` records a hash of the build's inputs (their paths and
//   contents, not timestamps) and the identity of the outputs it produced. A run whose inputs hash
//   the same and whose outputs are still the ones recorded builds nothing.
// - Staged: a rebuild runs `bun run build` in a copy of the inputs under `dist/.test-build`, then
//   moves each new file into place with `rename`, the assets first, then the manifest that names
//   them, then the executable. A reader sees either a whole old file or a whole new one. Old asset
//   files stay, so a manifest a running file has already imported still names files that exist;
//   the next `bun run build` (which deletes `dist/assets`) clears them.
// - Serialized: builders in one checkout take a lock directory beside the stamp. A builder that
//   waited checks the stamp again, so concurrent runs build once.
//
// The lock, the stamp and the staging copies live in the checkout's own `dist/`, so they go when
// the checkout does. `bun run test` runs this file before its workers start and sets
// IGLO_TEST_PREBUILT, so no file of that run checks again; any other `bun test` run (a file, a
// directory, a bare `--parallel` run) checks through `test/preload.ts` before each file.
import {
  cpSync,
  existsSync,
  mkdirSync,
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
const lock = join(work, "lock");
const ownerFile = join(lock, "owner");
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
// reference regenerated from docs/design/06-templates.md.
const manifest = "src/server/asset-manifest.ts";
const reference = "src/mcp/reference.ts";
const generated = new Set([manifest, reference]);
// A held lock is waited for as long as its owner lives (a build takes about a minute at most).
const holdLimitMs = 15 * 60_000;
// Any other `mkdir` failure (permissions, full disk) cannot clear by waiting.
const faultLimitMs = 5000;
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

// The outputs as they are now: the manifest's contents and the inodes of the executable and the
// assets directory. `bun run build` replaces all three, so a build made without this file (or from
// other inputs) is never taken for the recorded one.
function outputIdentity(): string | undefined {
  try {
    const executable = statSync(join(dist, "iglo.email"), { bigint: true });
    const assets = statSync(join(dist, "assets"), { bigint: true });
    const text = readFileSync(join(repository, manifest));
    return `${Bun.hash(text).toString(36)}:${executable.ino}:${executable.size}:${assets.ino}`;
  } catch {
    return undefined;
  }
}

function stamp(inputs: string, outputs: string): string {
  return `${inputs}\n${outputs}`;
}

function fresh(inputs: string): boolean {
  const outputs = outputIdentity();
  if (outputs === undefined) {
    return false;
  }
  try {
    return readFileSync(stampFile, "utf-8") === stamp(inputs, outputs);
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return asBody<NodeJS.ErrnoException>(error).code === "EPERM";
  }
}

// A lock is stale when its recorded owner is gone. A lock without a readable owner yet is a
// fresh `mkdir` whose owner has not written its PID: stale only after a few seconds.
function stale(dir = lock): boolean {
  try {
    const pid = Number(readFileSync(join(dir, "owner"), "utf-8"));
    if (Number.isInteger(pid) && pid > 0) {
      return !alive(pid);
    }
  } catch {
    // No readable owner yet: the age of the lock decides below.
  }
  try {
    return Date.now() - statSync(dir).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

// Moves a stale lock away, so that of several processes finding it only one succeeds (a second
// `rename` finds nothing). The moved directory is checked again: if a new owner took the path in
// between, the lock is put back and nobody has been misled.
function takeOver(): boolean {
  const moved = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, moved);
  } catch {
    return false;
  }
  if (!stale(moved)) {
    try {
      renameSync(moved, lock);
    } catch {
      // Best effort: if another process has taken the lock path, that process owns it now.
    }
    return false;
  }
  rmSync(moved, { recursive: true, force: true });
  return true;
}

async function acquire(): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(work, { recursive: true });
      mkdirSync(lock);
      writeFileSync(ownerFile, String(process.pid));
      return;
    } catch (error) {
      const code = asBody<NodeJS.ErrnoException>(error).code;
      if (code === "EEXIST") {
        if (stale() && takeOver()) {
          continue;
        }
        if (Date.now() - start > holdLimitMs) {
          throw new Error(`Production build lock ${lock} is still held by a live process`, {
            cause: error,
          });
        }
      } else if (Date.now() - start > faultLimitMs) {
        throw new Error(
          `Cannot create production build lock ${lock}: ${asBody<Error>(error).message}`,
          { cause: error },
        );
      }
      await Bun.sleep(50);
    }
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

async function rebuild(): Promise<void> {
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
    let current: Buffer | undefined;
    try {
      current = readFileSync(join(repository, reference));
    } catch {
      current = undefined;
    }
    if (current === undefined || !next.equals(current)) {
      publishFile(join(stage, reference), join(repository, reference));
    }
    publishFile(join(stage, "dist/iglo.email"), join(dist, "iglo.email"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function build(): Promise<void> {
  if (fresh(inputHash())) {
    return;
  }
  await acquire();
  try {
    // Another run may have built while this one waited for the lock.
    const before = inputHash();
    if (fresh(before)) {
      return;
    }
    await rebuild();
    // Recorded against the inputs read before the build, so an edit made during it is rebuilt by
    // the next check.
    const outputs = outputIdentity();
    if (outputs !== undefined) {
      writeFileSync(`${stampFile}.${process.pid}`, stamp(before, outputs));
      renameSync(`${stampFile}.${process.pid}`, stampFile);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
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
