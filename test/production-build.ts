// One production build (`bun run build`) per test run, shared by every test that needs
// `dist/iglo.email` or the embedded assets in `dist/assets`.
//
// The build deletes and recreates `dist/assets`, which in-process tests import, so it must finish
// before any test file of the run loads. `bun run test` builds once before any worker starts and
// sets IGLO_TEST_PREBUILT, so no test rebuilds during the run. Any other `bun test` run (a single
// file, a directory, a bare `--parallel` run) builds through `test/preload.ts`, which bunfig.toml
// loads before every test file: the first file of the run builds under a lock that serializes
// concurrent processes and records the run in a stamp, and every later file of the same run
// (in any `--parallel` worker, each file in its own global) finds the stamp and does not rebuild.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asBody } from "@/test/read-body";

const repository = resolve(import.meta.dir, "..");
// One lock per checkout: builds in different checkouts write different `dist` directories.
const lock = join(tmpdir(), `iglo-email-build-${Bun.hash(repository).toString(36)}.lock`);
const ownerFile = join(lock, "owner");
// Names the last run that built; kept outside the lock directory, which is removed after a build.
const stamp = `${lock}.run`;
// A held lock is waited for as long as its owner lives (a build takes about a minute).
const holdLimitMs = 15 * 60_000;
// Any other `mkdir` failure (permissions, full disk) cannot clear by waiting.
const faultLimitMs = 5000;
let built: Promise<void> | undefined;

// The process that owns this test run: the coordinator for a `--parallel` worker (which Bun marks
// with BUN_TEST_WORKER_ID), this process otherwise. Its start time (Linux /proc) tells a reused PID
// from the original.
function currentRun(): string {
  const pid = process.env.BUN_TEST_WORKER_ID === undefined ? process.pid : process.ppid;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? ""}`;
  } catch {
    return String(pid);
  }
}

function builtFor(run: string): boolean {
  try {
    return readFileSync(stamp, "utf-8") === run;
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

async function build(run: string): Promise<void> {
  if (builtFor(run)) {
    return;
  }
  await acquire();
  try {
    // Another process of this run may have built while this one waited for the lock.
    if (builtFor(run)) {
      return;
    }
    const child = Bun.spawn([process.execPath, "run", "build"], {
      cwd: repository,
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
    writeFileSync(stamp, run);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function ensureProductionBuild(): Promise<void> {
  if (process.env.IGLO_TEST_PREBUILT === "1") {
    return Promise.resolve();
  }
  built ??= build(currentRun());
  return built;
}
