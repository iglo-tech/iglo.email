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

test("a bare parallel run on a checkout with no build prepares it once", async () => {
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
    const child = Bun.spawn(
      [process.execPath, "test", "--parallel=2", "--timeout=60000", ...files.map((f) => `./${f}`)],
      {
        cwd: checkout,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    expect(output).not.toContain("Cannot find module");
    expect({ code, output }).toMatchObject({ code: 0 });
    const builds = new Set(output.match(/BUILD \d+:\d+/g));
    // One build for the whole run: every file of both workers sees the same files.
    expect(builds.size).toBe(1);
    expect(output).toContain(`${files.length} pass`);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}, 120_000);
