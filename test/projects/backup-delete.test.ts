// B149a (14-projects sections 10 and 12, D158, D164): a project deleted while a whole `backup` runs.
// The backup has opened every database and read the registered projects when the delete runs to
// its end; it must then fail with nothing published and nothing left behind, and a rerun must be a
// whole backup of the projects that remain. The backup runs in a worker thread (createBackup is
// synchronous, as the command runs it) paused at its free-space check; the delete goes through the
// instance API; the result is read back with the same check `backup --verify` makes.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBackup } from "@/backup/snapshot";
import { createRealClock } from "@/clock";
import { productionMigrations } from "@/db/migrations";
import {
  createProject,
  deleteProject,
  openLifecycle,
  projectCall,
  projectSession,
} from "@/test/projects/lifecycle-fixture";

setDefaultTimeout(60_000);

type Outcome = { done: true; path: string } | { done: false; error: string };

/** Runs a whole backup to `output` in a worker; with `during`, runs it while the backup is paused. */
async function backup(
  dataDir: string,
  output: string,
  during?: () => Promise<void>,
): Promise<Outcome> {
  const worker = new Worker(new URL("backup-worker.ts", import.meta.url).href);
  const pause = during ? new SharedArrayBuffer(4) : null;
  try {
    return await new Promise<Outcome>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = (event: MessageEvent<{ paused: true } | Outcome>) => {
        if ("paused" in event.data) {
          void during!()
            .catch(reject)
            .finally(() => {
              const flag = new Int32Array(pause!);
              Atomics.store(flag, 0, 1);
              Atomics.notify(flag, 0);
            });
          return;
        }
        resolve(event.data);
      };
      worker.postMessage({ dataDir, output, pause });
    });
  } finally {
    worker.terminate();
  }
}

test("a project deleted during a whole backup fails the backup cleanly, and a rerun is whole", async () => {
  const f = await openLifecycle(createRealClock());
  const outside = await mkdtemp(join(tmpdir(), "iglo-email-b149a-backups-"));
  try {
    for (const slug of ["drop", "keep"]) {
      const host = `${slug}.example.test`;
      await createProject(f, { slug, name: slug, hostname: host });
      const session = await projectSession(f, host);
      const created = await projectCall(f, host, session, "POST", "/api/subscribers", {
        email: `reader@${host}`,
        name: "Reader",
      });
      expect(created.status).toBe(200);
    }

    // The delete runs to its end while the backup holds every source open.
    let deleted = 0;
    const first = await backup(f.dataDir, join(outside, "first"), async () => {
      deleted = (await deleteProject(f, "drop")).status;
    });
    expect(deleted).toBe(200);
    // Failed (today at the deleted project's uploads, which are gone: src/backup's message names the
    // upload path rather than the registry change it would report next; D164).
    expect(first.done).toBe(false);
    // Nothing published, nothing partial left beside it.
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(f.dataDir, "projects", "drop"))).toBe(false);

    // A rerun is whole: instance.db and every remaining project, checked as one.
    const second = await backup(f.dataDir, join(outside, "second"));
    expect(second).toEqual({ done: true, path: join(outside, "second") });
    const manifest = JSON.parse(
      readFileSync(join(outside, "second", "iglo-email-backup.json"), "utf-8"),
    );
    expect(manifest).toEqual({ projects: ["keep", "main"] });
    const checked = inspectBackup(
      join(outside, "second"),
      createRealClock(),
      productionMigrations.length,
    );
    expect(checked.map((item) => item.place).toSorted()).toEqual([
      "instance.db",
      "projects/keep",
      "projects/main",
    ]);
    expect(readdirSync(outside)).toEqual(["second"]);
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
  expect(f.failures).toEqual([]);
});
