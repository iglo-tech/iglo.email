// One production build (`bun run build`) shared by every test that needs `dist/iglo.email`.
//
// The build deletes and recreates `dist/assets`, which in-process tests import. `bun run test`
// builds once before any worker starts and sets IGLO_TEST_PREBUILT, so no test rebuilds during the
// run. Without it (a single file run by hand) the first caller in a process builds, under a lock
// that serializes concurrent processes.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
// One lock per checkout: builds in different checkouts write different `dist` directories.
const lock = join(tmpdir(), `iglo-email-build-${Bun.hash(repository).toString(36)}.lock`);
const ownerFile = join(lock, "owner");
// A held lock is waited for as long as its owner lives (a build takes about a minute).
const holdLimitMs = 15 * 60_000;
// Any other `mkdir` failure (permissions, full disk) cannot clear by waiting.
const faultLimitMs = 5_000;
let built: Promise<void> | undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock is stale when its recorded owner is gone. A lock without a readable owner yet is a
// fresh `mkdir` whose owner has not written its PID: stale only after a few seconds.
function stale(): boolean {
  try {
    const pid = Number(readFileSync(ownerFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  } catch {}
  try {
    return Date.now() - statSync(lock).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

async function acquire(): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(ownerFile, String(process.pid));
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (stale()) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - start > holdLimitMs) {
          throw new Error(`Production build lock ${lock} is still held by a live process`);
        }
      } else if (Date.now() - start > faultLimitMs) {
        throw new Error(`Cannot create production build lock ${lock}: ${(error as Error).message}`);
      }
      await Bun.sleep(50);
    }
  }
}

async function build(): Promise<void> {
  await acquire();
  try {
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
    if (code !== 0) throw new Error(`Build failed:\n${stdout}\n${stderr}`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function ensureProductionBuild(): Promise<void> {
  if (process.env.IGLO_TEST_PREBUILT === "1") return Promise.resolve();
  built ??= build();
  return built;
}
