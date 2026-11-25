// B149a: a whole backup in a worker thread, for test/projects/backup-delete.test.ts. createBackup is
// synchronous, as the `backup` command runs it; with `pause`, the worker stops at the free-space
// check (after every source is open and the registered projects are read, before any snapshot)
// until the test's shared flag is set, so a project delete can run at exactly that moment.
import { createBackup } from "@/backup/snapshot";
import { createRealClock } from "@/clock";
import { productionMigrations } from "@/db/migrations";

declare const self: Worker;

interface Job {
  dataDir: string;
  output: string;
  pause: SharedArrayBuffer | null;
}

self.onmessage = (event: MessageEvent<Job>) => {
  const { dataDir, output, pause } = event.data;
  try {
    const report = createBackup({
      dataDir,
      output,
      clock: createRealClock(),
      supportedVersion: productionMigrations.length,
      available: () => {
        if (pause) {
          self.postMessage({ paused: true });
          Atomics.wait(new Int32Array(pause), 0, 0, 30_000);
        }
        return Number.MAX_SAFE_INTEGER;
      },
      warn: () => {},
    });
    self.postMessage({ done: true, path: report.path });
  } catch (error) {
    self.postMessage({
      done: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
