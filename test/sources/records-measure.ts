// B150d measurement (docs/perf/B150d-records.md): records per second through the record handler
// (D173) against the real PocketBase 0.40.5 binary, in a catch-up. A first stream subscribes once
// (its marker is set) and stops; PocketBase gets `count` events records spread over `users` users
// through its batch API; a second stream on the same database catches them up through the full
// handler: one grant rule, one active external sequence (`reentry: always`, so every record ends
// the user's running enrollment and starts a new one), the recipient read and one write
// transaction per record. Run: `bun test/sources/records-measure.ts <data-dir> [count] [users]`,
// with the iglo.email database directory on the filesystem to measure (PocketBase stays in the
// system temporary directory).
import { mkdirSync } from "node:fs";
import { enableBatch, adapter } from "@/test/conditions/source-fixture";
import { schedulerFixture } from "@/test/scheduler/fixture";
import { createSourceRecords } from "@/sources/records-stream";
import type { GrantRule } from "@/sources/settings";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

const parent = process.argv[2];
const count = Number(process.argv[3] ?? 5000);
const userCount = Number(process.argv[4] ?? 100);
if (!parent || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(userCount)) {
  throw new Error("usage: bun test/sources/records-measure.ts <data-dir> [count] [users]");
}
mkdirSync(parent, { recursive: true });
const pb = await startPocketBase();
await enableBatch(pb);
// The project's database goes to `parent`; PocketBase stays where it started.
const previous = process.env.TMPDIR;
process.env.TMPDIR = parent;
const f = await schedulerFixture({ source: () => adapter(pb) });
if (previous === undefined) {
  delete process.env.TMPDIR;
} else {
  process.env.TMPDIR = previous;
}
const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const name = "measured";

async function until(check: () => boolean) {
  while (!check()) {
    await Bun.sleep(20);
  }
}

try {
  const news = await f.list("News");
  const template = await f.template();
  await f.sequence({
    source: "external",
    trigger: { event: name },
    steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
  });
  const rules: Array<GrantRule> = [{ event: name, where: {}, lists: [news] }];
  let handled = 0;
  const start = () => {
    const records = createSourceRecords({
      db: f.db,
      clock: f.clock,
      logger: { attention: (message) => console.error(message), error: (e) => console.error(e) },
      config: () => ({
        ...sourceConfig(pb.url, pb.service),
        users: { collection: "", leavingFilter: "" },
      }),
      grantRules: () => rules,
      guard: openGuard,
      subscribers: f.stores.subscribers,
      enrollments: f.stores.enrollments,
      emailAllowed: () => true,
      onOutcome: () => {
        handled++;
      },
    });
    records.start();
    return records;
  };
  // The first stream sets the marker, then stops.
  const first = start();
  await until(() => first.stream()?.state().state === "live");
  await first.stop();

  const users: Array<string> = [];
  for (let i = 0; i < userCount; i++) {
    users.push((await pb.user()).id);
  }
  const occurredAt = f.clock.now().toISOString();
  const created = performance.now();
  for (let done = 0; done < count; done += 1000) {
    const requests = Array.from({ length: Math.min(1000, count - done) }, (_, i) => ({
      method: "POST",
      url: "/api/collections/events/records",
      body: {
        user: users[(done + i) % users.length],
        name,
        data: { n: done + i },
        occurredAt,
      },
    }));
    await pb.api("POST", "/api/batch", { requests });
  }
  const createMs = performance.now() - created;
  Bun.gc(true);
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakHeap = Math.max(peakHeap, now.heapUsed);
  }, 50);
  const started = performance.now();
  const second = start();
  await until(() => handled >= count && second.stream()?.state().state === "live");
  const ms = performance.now() - started;
  clearInterval(sampler);
  const retries = second.stream()?.retries().length ?? 0;
  await second.stop();
  const enrolled = await f.json("/api/enrollments?per_page=1&status=active");
  console.log(
    JSON.stringify({
      dir: parent,
      records: count,
      users: userCount,
      createSeconds: Math.round(createMs / 100) / 10,
      catchUpSeconds: Math.round(ms / 100) / 10,
      recordsPerSecond: Math.round(count / (ms / 1000)),
      rssBeforeMiB: mib(before.rss),
      peakRssMiB: mib(peakRss),
      heapBeforeMiB: mib(before.heapUsed),
      peakHeapMiB: mib(peakHeap),
      activeEnrollments: enrolled.body?.data?.total,
      retries,
    }),
  );
} finally {
  await f.close();
  await pb.close();
}
