// B150b measurement (docs/perf/B150b-stream.md): catch-up throughput and memory over 100,000
// events records against the real PocketBase 0.40.5 binary. The stream subscribes once (so its
// marker exists), stops, PocketBase gets the records through its batch API, and a new stream on
// the same database catches them all up; each record is one handler write transaction with its
// dedupe entry, as B150d's will be. Run: `bun test/sources/stream-measure.ts <data-dir> [count]`
// with the iglo.email database directory on the filesystem to measure (PocketBase stays in the
// harness's temporary directory).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { createSourceStream } from "@/sources/stream";
import type { RecordHandler } from "@/sources/stream-record";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

const parent = process.argv[2];
const count = Number(process.argv[3] ?? 100_000);
if (!parent || !Number.isSafeInteger(count) || count < 1) {
  throw new Error("usage: bun test/sources/stream-measure.ts <data-dir> [count]");
}
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, "iglo-stream-measure-"));
const pb = await startPocketBase();
const clock = createRealClock();
const config = {
  ...sourceConfig(pb.url, pb.service),
  users: { collection: "", leavingFilter: "" },
};
const name = "measured";
const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

function run(db: ReturnType<typeof openDatabase>, onRecord: () => void) {
  const handler: RecordHandler = {
    async event(_record, commit) {
      writeTransaction(db, () => commit.write());
      onRecord();
    },
    async userLeft(_record, commit) {
      writeTransaction(db, () => commit.write());
    },
  };
  const stream = createSourceStream({
    db,
    clock,
    logger: { attention: (message) => console.error(message), error: (e) => console.error(e) },
    config,
    guard: openGuard,
    source: createPocketBaseSource({ config, clock, guard: openGuard }).stream,
    handler,
    names: () => [name],
  });
  stream.start();
  return stream;
}

async function until(check: () => boolean) {
  while (!check()) {
    await Bun.sleep(20);
  }
}

try {
  const db = openDatabase(dir);
  runMigrations(db, dir, clock, productionMigrations);
  // The first stream sets the marker, then stops.
  const first = run(db, () => {});
  await until(() => first.state().state === "live");
  await first.stop();
  // The records, 1,000 per batch request.
  await pb.api("PATCH", "/api/settings", {
    batch: { enabled: true, maxRequests: 1000, timeout: 60, maxBodySize: 0 },
  });
  const user = await pb.user();
  const occurredAt = new Date().toISOString();
  const created = performance.now();
  for (let done = 0; done < count; done += 1000) {
    const requests = Array.from({ length: Math.min(1000, count - done) }, (_, i) => ({
      method: "POST",
      url: "/api/collections/events/records",
      body: { user: user.id, name, data: { n: done + i, plan: "pro" }, occurredAt },
    }));
    await pb.api("POST", "/api/batch", { requests });
  }
  const createMs = performance.now() - created;
  Bun.gc(true);
  const before = process.memoryUsage();
  let handled = 0;
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakHeap = Math.max(peakHeap, now.heapUsed);
  }, 50);
  const started = performance.now();
  const second = run(db, () => {
    handled++;
  });
  await until(() => handled >= count && second.state().state === "live");
  const ms = performance.now() - started;
  clearInterval(sampler);
  const seen = second.seenCount();
  await second.stop();
  db.close();
  console.log(
    JSON.stringify({
      dir: parent,
      records: count,
      createSeconds: Math.round(createMs / 100) / 10,
      catchUpSeconds: Math.round(ms / 100) / 10,
      recordsPerSecond: Math.round(count / (ms / 1000)),
      rssBeforeMiB: mib(before.rss),
      peakRssMiB: mib(peakRss),
      heapBeforeMiB: mib(before.heapUsed),
      peakHeapMiB: mib(peakHeap),
      dedupeEntries: seen,
    }),
  );
} finally {
  await pb.close();
  rmSync(dir, { recursive: true, force: true });
}
