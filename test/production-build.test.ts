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
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
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
    // scripts/release.ts imports these.
    "test/serve-port.ts",
    "test/wait.ts",
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

/** A checkout built by one short run, with its probe. */
async function builtCheckout() {
  const checkout = cleanCheckout();
  writeFiles(checkout, "test/short", ["a"], probe);
  const first = await start(checkout, ["test/short"]);
  expect({ code: first.code, output: first.output }).toMatchObject({ code: 0 });
  return { checkout, first };
}

// Holds the checkout's build lock in another process until killed, as a builder does.
const holder = `import { dlopen, FFIType } from "bun:ffi";
import { openSync } from "node:fs";
const { symbols } = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
if (symbols.flock(openSync(process.argv[2], "a"), 2 | 4) !== 0) throw new Error("not taken");
console.log("held");
setInterval(() => {}, 1000);
`;

test("a builder holds the lock while it lives, and a killed one releases it at once", async () => {
  const checkout = cleanCheckout();
  writeFiles(checkout, "test/short", ["a"], probe);
  mkdirSync(join(checkout, "dist/.test-build"), { recursive: true });
  writeFileSync(join(checkout, "holder.ts"), holder);
  const held = Bun.spawn(
    [process.execPath, join(checkout, "holder.ts"), join(checkout, "dist/.test-build/build.lock")],
    { cwd: checkout, stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = held.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    let finished = false;
    const run = start(checkout, ["test/short"]).finally(() => {
      finished = true;
    });
    // The run waits for the holder instead of building beside it.
    await Bun.sleep(3000);
    expect(finished).toBe(false);
    expect(existsSync(join(checkout, "dist/iglo.email"))).toBe(false);
    // Killed with no chance to clean up, as a builder can be: the run goes on without waiting for
    // any owner check or age.
    held.kill("SIGKILL");
    await held.exited;
    const killedAt = Date.now();
    const result = await run;
    expect({ code: result.code, output: result.output }).toMatchObject({ code: 0 });
    expect(result.builds.size).toBe(1);
    expect(Date.now() - killedAt).toBeLessThan(60_000);
  } finally {
    held.kill("SIGKILL");
  }
}, 120_000);

test("a lock directory left by a builder whose PID now names a live process does not hold a run", async () => {
  // The layout before D178: a lock directory and its owner's PID. A PID reused by a live process
  // made every later run wait 15 minutes and fail.
  const checkout = cleanCheckout();
  writeFiles(checkout, "test/short", ["a"], probe);
  mkdirSync(join(checkout, "dist/.test-build/lock"), { recursive: true });
  writeFileSync(join(checkout, "dist/.test-build/lock/owner"), String(process.pid));
  writeFileSync(join(checkout, "dist/.test-build/build.lock"), String(process.pid));
  const run = await start(checkout, ["test/short"]);
  expect({ code: run.code, output: run.output }).toMatchObject({ code: 0 });
  expect(run.builds.size).toBe(1);
}, 90_000);

test("a template reference changed alone is rewritten by the next run", async () => {
  const { checkout, first } = await builtCheckout();
  const path = join(checkout, "src/mcp/reference.ts");
  const generated = readFileSync(path, "utf-8");
  writeFileSync(path, "export const TEMPLATE_REFERENCE = 'edited by hand';\n");
  const second = await start(checkout, ["test/short"]);
  expect({ code: second.code, output: second.output }).toMatchObject({ code: 0 });
  expect(readFileSync(path, "utf-8")).toBe(generated);
  expect(second.builds).not.toEqual(first.builds);
  // Up to date again: a third run builds nothing.
  const third = await start(checkout, ["test/short"]);
  expect(third.builds).toEqual(second.builds);
}, 120_000);

test("an executable written in place at the same size is not taken for the recorded build", async () => {
  // As a `bun run build` from other sources would leave it after the sources were reverted: the
  // same inode, the same size, the same manifest, other bytes.
  const { checkout } = await builtCheckout();
  const executable = join(checkout, "dist/iglo.email");
  const before = statSync(executable);
  const descriptor = openSync(executable, "r+");
  try {
    writeSync(descriptor, Buffer.from("stale build"), 0, 11, 4096);
  } finally {
    closeSync(descriptor);
  }
  const marked = () => readFileSync(executable).subarray(4096, 4107).toString("latin1");
  expect(marked()).toBe("stale build");
  expect(statSync(executable)).toMatchObject({ ino: before.ino, size: before.size });
  const second = await start(checkout, ["test/short"]);
  expect({ code: second.code, output: second.output }).toMatchObject({ code: 0 });
  expect(marked()).not.toBe("stale build");
}, 120_000);

test("release:package lists the licenses the build embedded, not files earlier builds left", async () => {
  // A test build keeps old asset files (D168): after a dependency bump the old license stays.
  const { checkout } = await builtCheckout();
  writeFileSync(
    join(checkout, "dist/assets/admin/licenses/left-behind@0.0.1.txt"),
    "An old version's license\n",
  );
  const child = Bun.spawn(
    [process.execPath, "scripts/release.ts", "package", "dist/iglo.email", "dist/release"],
    { cwd: checkout, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const notices = readFileSync(join(checkout, "dist/release/THIRD-PARTY-NOTICES.txt"), "utf-8");
  expect(notices).not.toContain("left-behind@0.0.1");
  expect(notices).toContain("----- Geist fonts -----");
  // Every license the manifest names is there.
  const manifest = readFileSync(join(checkout, "src/server/asset-manifest.ts"), "utf-8");
  const named = [...manifest.matchAll(/"\/admin\/static\/licenses\/([^"]+)\.txt"/g)].flatMap(
    ([, name]) => (name === undefined || name === "listmonk-AGPL-3.0" ? [] : [name]),
  );
  expect(named.length).toBeGreaterThan(10);
  for (const name of named) {
    expect(notices).toContain(`----- ${name} -----`);
  }
}, 120_000);

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
