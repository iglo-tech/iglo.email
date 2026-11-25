// A bare `bun test --parallel=N` run on a checkout with no build (B149e item 1, D168). Without the
// bunfig.toml preload the in-process files fail with "Cannot find module dist/assets/...";
// without the per-run stamp in test/production-build.ts each file of each worker rebuilds and
// deletes `dist/assets` under the files still running in the other worker.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");

// Each file reads an embedded asset through the generated manifest (as the admin pages do), asks
// for the executable, and prints the change times of both, which a rebuild would move.
const probe = `import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { assets } from "@/server/asset-manifest";
import { ensureProductionBuild } from "@/test/production-build";

test("assets and executable are ready", async () => {
  const favicon = assets["/admin/static/favicon.png"];
  expect(favicon && statSync(favicon.path).size).toBeGreaterThan(0);
  await ensureProductionBuild();
  const executable = statSync("dist/iglo.email", { bigint: true });
  const asset = statSync("dist/assets/admin/favicon.png", { bigint: true });
  console.log(\`BUILD \${asset.ctimeNs}:\${executable.ctimeNs}\`);
});
`;

/**
 * Runs `bun test <args>` in a fresh copy of the build's inputs with no `dist/` and no asset
 * manifest, holding six probe files; returns the exit code, the output and the distinct builds the
 * probes saw.
 */
async function runInCleanCheckout(args: ReadonlyArray<string>) {
  const checkout = mkdtempSync(join(tmpdir(), "iglo-b149e-build-"));
  try {
    for (const path of [
      "src",
      "assets",
      "scripts",
      "i18n",
      "migrations",
      "docs/design/06-templates.md",
      "LICENSE",
      "package.json",
      "tsconfig.json",
      "bunfig.toml",
      "test/preload.ts",
      "test/production-build.ts",
      "test/read-body.ts",
    ]) {
      cpSync(join(repository, path), join(checkout, path), { recursive: true });
    }
    // A checkout copied from one that has been built still has no build of its own.
    rmSync(join(checkout, "src/server/asset-manifest.ts"), { force: true });
    symlinkSync(join(repository, "node_modules"), join(checkout, "node_modules"));
    const files = ["a", "b", "c", "d", "e", "f"].map((name) => `test/probe-${name}.test.ts`);
    for (const file of files) {
      writeFileSync(join(checkout, file), probe);
    }
    // Not IGLO_TEST_PREBUILT or BUN_TEST_WORKER_ID: the run is a developer's own.
    const child = Bun.spawn([process.execPath, "test", "--timeout=60000", ...args], {
      cwd: checkout,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    return { code, output, builds: new Set(output.match(/BUILD \d+:\d+/g)).size, files };
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

test("a bare parallel run on a checkout with no build prepares it once", async () => {
  // A directory named as people type it, without `./`: Bun takes it as a filter.
  const run = await runInCleanCheckout(["--parallel=2", "test"]);
  expect(run.output).not.toContain("Cannot find module");
  expect({ code: run.code, output: run.output }).toMatchObject({ code: 0 });
  // One build for the whole run: every file of both workers sees the same files.
  expect(run.builds).toBe(1);
  expect(run.output).toContain(`${run.files.length} pass`);
}, 120_000);

test("a serial filter run on a checkout with no build prepares it", async () => {
  // A filter makes Bun scan for test files before the preload builds. Scanning src/ then would keep
  // a listing of src/server without the manifest the build writes there.
  const run = await runInCleanCheckout(["test"]);
  expect(run.output).not.toContain("Cannot find module");
  expect({ code: run.code, output: run.output }).toMatchObject({ code: 0 });
  expect(run.builds).toBe(1);
  expect(run.output).toContain(`${run.files.length} pass`);
}, 120_000);
