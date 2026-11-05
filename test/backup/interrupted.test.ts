// A `backup` killed midway through a large snapshot: nothing that looks complete is left. Its own
// file so that the slow cases run in a parallel worker beside the rest of test/backup/backup.test.ts.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildExecutable,
  removeDirectory,
  runBackup,
  seedSubscribers,
  startServer,
  temporaryDirectory,
  type Server,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);
const PARTIAL = ".iglo-email-backup-partial-";
let executable = "";
let build = "";
let base = "";
let dataDir = "";
let server: Server | undefined;

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
}, 120_000);
afterAll(() => removeDirectory(build));
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (base) removeDirectory(base);
  base = "";
});

const names = (directory: string) => readdirSync(directory).sort();

for (const signal of ["SIGKILL", "SIGTERM"] as const)
  test(`${signal} midway leaves nothing that looks complete`, async () => {
    base = temporaryDirectory();
    dataDir = join(base, "data");
    mkdirSync(join(dataDir, "uploads"), { recursive: true });
    await (await startServer(executable, dataDir)).stop();
    seedSubscribers(dataDir, 300_000);
    server = await startServer(executable, dataDir);
    const destination = join(base, "destination");
    mkdirSync(destination);
    const output = join(destination, "backup");

    const child = Bun.spawn([executable, "backup", "--data-dir", dataDir, "--output", output], {
      env: { PATH: "" },
      stdout: "ignore",
      stderr: "ignore",
    });
    let partial: string | undefined;
    for (const deadline = Date.now() + 20_000; !partial && Date.now() < deadline;) {
      partial = names(destination).find((name) => name.startsWith(PARTIAL));
      if (!partial || statSync(join(destination, partial, "iglo-email.db")).size === 0) {
        partial = undefined;
        await Bun.sleep(1);
      }
    }
    expect(partial).toBeDefined();
    child.kill(signal);
    expect(await child.exited).not.toBe(0);

    // The helper that syncs the snapshot goes with it.
    const helperRunning = () =>
      readdirSync("/proc").some((entry) => {
        try {
          return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(partial!);
        } catch {
          return false;
        }
      });
    for (const deadline = Date.now() + 5_000; helperRunning() && Date.now() < deadline;)
      await Bun.sleep(25);
    expect(helperRunning()).toBe(false);

    expect(existsSync(output)).toBe(false);
    expect(names(destination)).toEqual([partial!]);
    const refused = await runBackup(executable, ["--verify", join(destination, partial!)]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("interrupted backup");

    const next = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
    expect(next.exitCode).toBe(0);
    expect(next.stderr).toContain(partial!);
    expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  });
