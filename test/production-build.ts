// One production build (`bun run build`) shared by every test that needs `dist/iglo.email`.
//
// The build deletes and recreates `dist/assets`, which in-process tests import. `bun run test`
// builds once before any worker starts and sets IGLO_TEST_PREBUILT, so no test rebuilds during the
// run. Without it (a single file run by hand) the first caller in a process builds, under a lock
// that serializes concurrent processes.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const lock = join(tmpdir(), "iglo-email-production-build.lock");
let built: Promise<void> | undefined;

async function acquire(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch {
      try {
        // A lock older than any build is left over from a killed process.
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true });
      } catch {}
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
