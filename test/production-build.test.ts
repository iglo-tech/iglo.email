// `bun test` runs on a checkout's build (B149e item 1, D168), observed through runs of `bun test`
// in a fresh copy of the build's inputs.
//
// - A bare `bun test --parallel=N` run on a checkout with no build prepares it once: without the
//   bunfig.toml preload the in-process files fail with "Cannot find module dist/assets/...".
// - A second run in the same checkout neither rebuilds an up-to-date build nor, when an input has
//   changed, removes a file a run in progress reads (council round 1 on #233): a run that rebuilt
//   `dist/assets` in place failed the other run's files with "Cannot find module".
import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");

// Reads an embedded asset through the generated manifest (as the admin pages do), asks for the
// executable, and prints the change times of both, which a rebuild would move.
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
  console.log(\`ADDED \${"/admin/static/added.txt" in assets}\`);
});
`;

// A file of a long run: keeps reading every asset its manifest names and the executable for two
// seconds, so a second run that removes or truncates one fails it.
const reader = `import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { assets } from "@/server/asset-manifest";

test("assets stay readable while the file runs", async () => {
  writeFileSync("started", "");
  const end = Date.now() + 2000;
  let reads = 0;
  while (Date.now() < end) {
    for (const asset of Object.values(assets)) {
      expect(readFileSync(asset.path).length).toBeGreaterThan(0);
      reads++;
    }
    expect(statSync("dist/iglo.email").size).toBeGreaterThan(0);
    await Bun.sleep(5);
  }
  expect(reads).toBeGreaterThan(0);
});
`;

const checkouts: Array<string> = [];
afterEach(() => {
  for (const checkout of checkouts.splice(0)) {
    rmSync(checkout, { recursive: true, force: true });
  }
});

/** A fresh copy of the build's inputs with no `dist/` and no asset manifest. */
function cleanCheckout(): string {
  const checkout = mkdtempSync(join(tmpdir(), "iglo-b149e-build-"));
  checkouts.push(checkout);
  for (const path of [
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
    "tsconfig.json",
    "bunfig.toml",
    ".oxfmtrc.json",
    "test/preload.ts",
    "test/production-build.ts",
    "test/read-body.ts",
  ]) {
    cpSync(join(repository, path), join(checkout, path), { recursive: true });
  }
  // A checkout copied from one that has been built still has no build of its own.
  rmSync(join(checkout, "src/server/asset-manifest.ts"), { force: true });
  symlinkSync(join(repository, "node_modules"), join(checkout, "node_modules"));
  return checkout;
}

function writeFiles(
  checkout: string,
  directory: string,
  names: ReadonlyArray<string>,
  text: string,
) {
  mkdirSync(join(checkout, directory), { recursive: true });
  return names.map((name) => {
    const file = `${directory}/${name}.test.ts`;
    writeFileSync(join(checkout, file), text);
    return file;
  });
}

/** Starts `bun test <args>` in the checkout as a developer's own run. */
function start(checkout: string, args: ReadonlyArray<string>) {
  // Not IGLO_TEST_PREBUILT or BUN_TEST_WORKER_ID: the run is a developer's own.
  const child = Bun.spawn([process.execPath, "test", "--timeout=60000", ...args], {
    cwd: checkout,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    return { code, output, builds: new Set(output.match(/BUILD \d+:\d+/g)) };
  })();
}

test("a bare parallel run on a checkout with no build prepares it once", async () => {
  const checkout = cleanCheckout();
  const files = writeFiles(checkout, "test", ["a", "b", "c", "d", "e", "f"], probe);
  // A directory named as people type it, without `./`: Bun takes it as a filter.
  const run = await start(checkout, ["--parallel=2", "test"]);
  expect(run.output).not.toContain("Cannot find module");
  expect({ code: run.code, output: run.output }).toMatchObject({ code: 0 });
  // One build for the whole run: every file of both workers sees the same files.
  expect(run.builds.size).toBe(1);
  expect(run.output).toContain(`${files.length} pass`);
}, 120_000);

test("a serial filter run on a checkout with no build prepares it", async () => {
  const checkout = cleanCheckout();
  const files = writeFiles(checkout, "test", ["a", "b", "c", "d", "e", "f"], probe);
  // A filter makes Bun scan for test files before the preload builds. Scanning src/ then would keep
  // a listing of src/server without the manifest the build writes there.
  const run = await start(checkout, ["test"]);
  expect(run.output).not.toContain("Cannot find module");
  expect({ code: run.code, output: run.output }).toMatchObject({ code: 0 });
  expect(run.builds.size).toBe(1);
  expect(run.output).toContain(`${files.length} pass`);
}, 120_000);

/**
 * Starts a long parallel run, and once its first file is reading the assets, makes `changes`
 * (if any) and runs a short bare run three times one after the other in the same checkout.
 */
async function secondRunBeside(changes: (checkout: string) => void) {
  const checkout = cleanCheckout();
  const long = writeFiles(checkout, "test/long", ["a", "b", "c", "d", "e", "f"], reader);
  writeFiles(checkout, "test/short", ["a"], probe);
  // The checkout is built, as by an earlier run.
  const first = await start(checkout, ["test/short"]);
  expect({ code: first.code, output: first.output }).toMatchObject({ code: 0 });
  const running = start(checkout, ["--parallel=2", "test/long"]);
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(checkout, "started")) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  changes(checkout);
  const seconds = [];
  for (let index = 0; index < 3; index++) {
    seconds.push(await start(checkout, ["test/short"]));
  }
  const longRun = await running;
  expect(longRun.output).not.toContain("Cannot find module");
  expect({ code: longRun.code, output: longRun.output }).toMatchObject({ code: 0 });
  expect(longRun.output).toContain(`${long.length} pass`);
  for (const second of seconds) {
    expect({ code: second.code, output: second.output }).toMatchObject({ code: 0 });
  }
  return { first, seconds };
}

test("a second run in the same checkout neither rebuilds nor disturbs a run in progress", async () => {
  const { first, seconds } = await secondRunBeside(() => {});
  // Every run sees the build the first one made.
  const builds = new Set([first, ...seconds].flatMap((run) => [...run.builds]));
  expect(builds.size).toBe(1);
}, 180_000);

test("a second run after an input changed rebuilds once, beside a run in progress", async () => {
  const { first, seconds } = await secondRunBeside((checkout) => {
    writeFileSync(join(checkout, "assets/admin/static/added.txt"), "added");
  });
  expect(first.output).toContain("ADDED false");
  // The first of the later runs rebuilds with the new asset; the others find it up to date.
  for (const second of seconds) {
    expect(second.output).toContain("ADDED true");
  }
  const later = new Set(seconds.flatMap((run) => [...run.builds]));
  expect(later.size).toBe(1);
  expect(later).not.toContain([...first.builds][0]);
}, 180_000);
