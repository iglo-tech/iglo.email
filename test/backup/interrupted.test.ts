// A `backup` killed midway through a large snapshot: nothing that looks complete is left. Its own
// file so that the slow cases run in a parallel worker beside the rest of test/backup/backup.test.ts.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { commandLines } from "@/test/host-processes";
import {
  buildExecutable,
  removeDirectory,
  runBackup,
  seedSubscribers,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";
import type { Server } from "@/test/backup/fixture";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);
const PARTIAL = ".iglo-email-backup-partial-";
let executable = "";
let build = "";
let seeded = "";
let base = "";
let dataDir = "";
let server: Server | undefined;

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
}, 120_000);
// The 300k rows are seeded once, in a data directory that is stopped cleanly. Each case copies it
// into its own base directory, so every case still owns its data and kills its backup midway.
beforeAll(async () => {
  seeded = temporaryDirectory();
  const template = join(seeded, "data");
  mkdirSync(join(template, "uploads"), { recursive: true });
  await (await startServer(executable, template)).stop();
  seedSubscribers(template, 300_000);
}, 120_000);
afterAll(() => {
  removeDirectory(build);
  removeDirectory(seeded);
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (base) {
    removeDirectory(base);
  }
  base = "";
});

const names = (directory: string) => readdirSync(directory).sort();

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`${signal} midway leaves nothing that looks complete`, async () => {
    base = temporaryDirectory();
    dataDir = join(base, "data");
    cpSync(join(seeded, "data"), dataDir, { recursive: true });
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
    await untilState(
      () => {
        const found = names(destination).find((name) => name.startsWith(PARTIAL));
        // The folder exists before its database file does: a missing or empty file is not ready yet.
        const size =
          found &&
          statSync(join(destination, found, "iglo-email.db"), { throwIfNoEntry: false })?.size;
        if (size) {
          partial = found;
        }
        return Boolean(size);
      },
      {
        label: "interrupted backup folder",
        progress: () => names(destination).join(),
        stallMs: 20_000,
        intervalMs: 1,
      },
    ).catch(() => undefined);
    expect(partial).toBeDefined();
    child.kill(signal);
    expect(await child.exited).not.toBe(0);

    // The helper that syncs the snapshot goes with it.
    const helperRunning = () => commandLines().some((line) => line.includes(partial!));
    await untilState(() => !helperRunning(), {
      label: "snapshot helper",
      progress: () => commandLines().join("\n"),
      stallMs: 5000,
    }).catch(() => undefined);
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
}
