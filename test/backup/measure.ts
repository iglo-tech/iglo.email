// Serial timing for docs/perf/M6.2-backup.md; opt-in, not a CI threshold. `backup` of a compiled
// server's data directory, generated at the given size on real disk, while clients add subscribers
// over HTTP and a second process watches the write lock (test/maintenance/measure-probe.ts).
// Appends one JSON line per run to docs/perf/M6.2-results.jsonl and removes its data.
// Usage: bun run backup:measure [subscribers] [runs]
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  apiClient,
  buildExecutable,
  createSubscriber,
  provisionAuthorization,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";

const repository = resolve(import.meta.dir, "../..");
const subscribers = Number(process.argv[2] ?? 1_000_000);
const runs = Number(process.argv[3] ?? 3);
const windowMs = 20_000;
const uploadFiles = 200;
const uploadBytes = 1024 * 1024;
const measurements = join(repository, "upstream/measurements");
mkdirSync(measurements, { recursive: true });
const base = temporaryDirectory(measurements);
const dataDir = join(base, "data");
const destination = join(base, "destination");
const wal = join(dataDir, "iglo-email.db-wal");
const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
const percentile = (values: number[], p: number) =>
  +(values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0).toFixed(1);
const summary = (values: number[]) => ({
  writes: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: percentile(values, 1),
});
const available = () => {
  const { bavail, bsize } = statfsSync(base);
  return Number(bavail) * Number(bsize);
};

function seed() {
  const db = new Database(join(dataDir, "iglo-email.db"));
  db.run("PRAGMA synchronous = OFF");
  const now = new Date().toISOString();
  const lists = [1, 2].map(
    (i) =>
      (
        db
          .query(
            "INSERT INTO lists (uuid, name, type, optin) VALUES (?, ?, 'public', 'single') RETURNING id",
          )
          .get(crypto.randomUUID(), `measure ${i}`) as { id: number }
      ).id,
  );
  const subscriber = db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', ?, ?, ?)",
  );
  const member = db.prepare(
    "INSERT INTO subscriber_lists (subscriber_id, list_id, status) VALUES (?, ?, 'confirmed')",
  );
  db.transaction(() => {
    for (let i = 1; i <= subscribers; i++) {
      const { lastInsertRowid } = subscriber.run(
        crypto.randomUUID(),
        `user${i}@example${i % 50}.test`,
        `Synthetic User ${i}`,
        JSON.stringify({ city: "Warsaw", n: i }),
        now,
        now,
      );
      member.run(lastInsertRowid, lists[i % 2]!);
    }
  })();
  db.close();
}

const started = performance.now();
const executable = await buildExecutable(base);
try {
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  mkdirSync(destination);
  const first = await startServer(executable, dataDir);
  const authorization = await provisionAuthorization(first.origin);
  await first.stop();
  seed();
  const bytes = new Uint8Array(uploadBytes).fill(7);
  for (let i = 0; i < uploadFiles; i++)
    writeFileSync(join(dataDir, "uploads", `orphan-${i}.bin`), bytes);
  console.log(`seeded in ${Math.round((performance.now() - started) / 1000)} s`);

  const server = await startServer(executable, dataDir);
  const client = apiClient(server.origin, authorization);
  try {
    for (let run = 1; run <= runs; run++) {
      const output = join(destination, `backup-${run}`);
      let phase: "before" | "during" | "after" = "before";
      const latencies = { before: [] as number[], during: [] as number[], after: [] as number[] };
      let writing = true;
      let next = 0;
      let backupBegun = 0;
      const stalls: { atSeconds: number; ms: number }[] = [];
      const writers = [0, 1, 2, 3].map(async () => {
        while (writing) {
          const begun = performance.now();
          const { status } = await createSubscriber(
            client,
            `r${run}-${next++}-${crypto.randomUUID()}`,
          );
          if (status !== 200) throw new Error(`write ${status}`);
          const elapsed = performance.now() - begun;
          latencies[phase].push(elapsed);
          if (phase === "during" && elapsed > 300)
            stalls.push({
              atSeconds: +((begun - backupBegun) / 1000).toFixed(2),
              ms: Math.round(elapsed),
            });
          // About 100 writes a second over the four clients.
          await Bun.sleep(40);
        }
      });
      await Bun.sleep(windowMs);

      const probe = Bun.spawn(
        [
          "bun",
          join(repository, "test/maintenance/measure-probe.ts"),
          join(dataDir, "iglo-email.db"),
        ],
        { stdin: "pipe", stdout: "pipe" },
      );
      phase = "during";
      const freeBefore = available();
      const begun = performance.now();
      backupBegun = begun;
      const child = Bun.spawn([executable, "backup", "--data-dir", dataDir, "--output", output], {
        env: { PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      let exited = false;
      void child.exited.then(() => (exited = true));
      let peakWal = 0;
      let peakRss = 0;
      let lowestFree = freeBefore;
      let snapshotEnd = 0;
      let copyEnd = 0;
      while (!exited) {
        peakWal = Math.max(peakWal, statSync(wal, { throwIfNoEntry: false })?.size ?? 0);
        lowestFree = Math.min(lowestFree, available());
        try {
          const peak = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"));
          peakRss = Math.max(peakRss, Number(peak?.[1] ?? 0) * 1024);
        } catch {
          // It exited between the check and the read.
        }
        const partial = readdirSync(destination).find((name) => name.startsWith("."));
        if (partial) {
          const elapsed = performance.now() - begun;
          if (!snapshotEnd && existsSync(join(destination, partial, "uploads")))
            snapshotEnd = elapsed;
          if (!copyEnd && existsSync(join(destination, partial, "iglo-email-backup.json")))
            copyEnd = elapsed;
        }
        await Bun.sleep(20);
      }
      const seconds = (performance.now() - begun) / 1000;
      if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
      await probe.stdin.end();
      const lockWaitMs = Number(await new Response(probe.stdout).text());

      phase = "after";
      await Bun.sleep(windowMs);
      writing = false;
      await Promise.all(writers);
      const walAfter = statSync(wal, { throwIfNoEntry: false })?.size ?? 0;

      const verifyBegun = performance.now();
      const verify = Bun.spawnSync([executable, "backup", "--verify", output], {
        env: { PATH: "" },
      });
      const verifySeconds = (performance.now() - verifyBegun) / 1000;
      if (verify.exitCode !== 0) throw new Error(verify.stderr.toString());

      const databaseBytes = statSync(join(dataDir, "iglo-email.db")).size;
      const snapshotBytes = statSync(join(output, "iglo-email.db")).size;
      const record = {
        run,
        at: new Date().toISOString(),
        head: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repository })
          .stdout.toString()
          .trim(),
        subscribers,
        uploadFiles,
        uploadMiB: mb(uploadFiles * uploadBytes),
        seconds: +seconds.toFixed(2),
        snapshotSeconds: +(snapshotEnd / 1000).toFixed(2),
        copySeconds: +((copyEnd - snapshotEnd) / 1000).toFixed(2),
        verifyAtEndSeconds: +((seconds * 1000 - copyEnd) / 1000).toFixed(2),
        verifySeconds: +verifySeconds.toFixed(2),
        peakRssMiB: mb(peakRss),
        databaseMiB: mb(databaseBytes),
        snapshotMiB: mb(snapshotBytes),
        peakWalMiB: mb(peakWal),
        walAfterMiB: mb(walAfter),
        diskUsedMiB: mb(freeBefore - lowestFree),
        writeLockWaitMs: lockWaitMs,
        stalls,
        before: summary(latencies.before),
        during: summary(latencies.during),
        after: summary(latencies.after),
      };
      console.log(JSON.stringify(record));
      appendFileSync(
        join(repository, "docs/perf/M6.2-results.jsonl"),
        `${JSON.stringify(record)}\n`,
      );
      removeDirectory(output);
      Bun.gc(true);
    }
  } finally {
    await server.stop();
  }
} finally {
  removeDirectory(base);
}
