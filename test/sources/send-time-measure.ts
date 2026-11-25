// B150e measurement (docs/perf/B150e-send.md): a campaign to `count` recipients through the
// campaign runner (D174), with every recipient source-linked and read from the real PocketBase
// 0.40.5 binary per batch (`source`), or with no source at all (`none`, the existing path, which
// runs unchanged on a checkout before B150e). The emailer is the runner fixture's stand-in, which
// accepts each push at once, so the time is the runner's own: claims, source reads, renders,
// eligibility and progress writes. 1 % of the users are renamed in the source first, so those
// batches also write. Run:
// `bun test/sources/send-time-measure.ts <data-dir> [count] [source|none]`, with the iglo.email
// database directory on the filesystem to measure (PocketBase stays in the system temporary
// directory). Setup rows are inserted with SQL for speed; the measured part goes through the API
// and the runner only.
import { mkdirSync } from "node:fs";
import { enableBatch } from "@/test/conditions/source-fixture";
import type { CampaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { createEnrollments } from "@/sequences/enrollments";
import { createRealClock } from "@/clock";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { createSendTimeLookup } from "@/sources/send-time";
import type { SendTimeLookup } from "@/sources/send-time";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

const parent = process.argv[2];
const count = Number(process.argv[3] ?? 10_000);
const mode = process.argv[4] ?? "source";
if (!parent || !Number.isSafeInteger(count) || count < 1 || !["source", "none"].includes(mode)) {
  throw new Error("usage: bun test/sources/send-time-measure.ts <data-dir> [count] [source|none]");
}
mkdirSync(parent, { recursive: true });
const round = (n: number) => Math.round(n * 10) / 10;
const quantiles = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { n: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};

const pb = mode === "source" ? await startPocketBase() : null;
const ids: Array<string> = [];
if (pb) {
  await enableBatch(pb);
  const rule = '@request.auth.collectionName = "services"';
  // A plain collection as the recipients "view": auth records would hash a password each.
  await pb.api("POST", "/api/collections", {
    name: "people",
    type: "base",
    listRule: rule,
    viewRule: rule,
    fields: [
      { name: "email", type: "text" },
      { name: "name", type: "text" },
    ],
  });
  for (let start = 0; start < count; start += 1000) {
    const requests = [];
    for (let i = start; i < Math.min(count, start + 1000); i++) {
      const id = `person${String(i).padStart(9, "0")}`;
      ids.push(id);
      requests.push({
        method: "POST",
        url: "/api/collections/people/records",
        body: { id, email: `person${i}@example.com`, name: `Person ${i}` },
      });
    }
    await pb.api("POST", "/api/batch", { requests });
  }
}

const reads: Array<number> = [];
const batches: Array<number> = [];
let batchStart: number | null = null;
let lastEnd = 0;
const closeBatch = () => {
  if (batchStart !== null) {
    batches.push(lastEnd - batchStart);
  }
};
const previous = process.env.TMPDIR;
process.env.TMPDIR = parent;
const f = await runnerFixture(
  pb
    ? {
        sendTime: (fixture: CampaignsFixture) => {
          const source = createPocketBaseSource({
            config: {
              ...sourceConfig(pb.url, pb.service),
              recipients: { collection: "people", email: "email", name: "name", optOut: "" },
            },
            clock: createRealClock(),
            guard: openGuard,
          });
          const lookup = createSendTimeLookup({
            db: fixture.db,
            source: () => source,
            subscribers: fixture.owners.subscribers,
            enrollments: createEnrollments(fixture.db, fixture.clock),
            emailAllowed: () => true,
          });
          // Timed: each read, and each batch from its lookup's start to its last read or write.
          const timed: SendTimeLookup = {
            configured() {
              closeBatch();
              batchStart = performance.now();
              return lookup.configured();
            },
            async read(...args) {
              const at = performance.now();
              try {
                return await lookup.read(...args);
              } finally {
                lastEnd = performance.now();
                reads.push(lastEnd - at);
              }
            },
            apply(planned) {
              try {
                return lookup.apply(planned);
              } finally {
                lastEnd = performance.now();
              }
            },
          };
          return timed;
        },
      }
    : {},
);
if (previous === undefined) {
  delete process.env.TMPDIR;
} else {
  process.env.TMPDIR = previous;
}

try {
  const list = await f.list("measured");
  const now = new Date().toISOString();
  const insert = f.db.prepare<{ id: bigint }, Array<string | null>>(
    "INSERT INTO subscribers (uuid,email,name,status,attribs,external_id,created_at,updated_at) VALUES (?,?,?,'enabled','{}',?,?,?) RETURNING id",
  );
  const member = f.db.prepare(
    "INSERT INTO subscriber_lists (subscriber_id,list_id,status,created_at,updated_at) VALUES (?,?,'confirmed',?,?)",
  );
  f.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const row = insert.get(
        crypto.randomUUID(),
        `person${i}@example.com`,
        `Person ${i}`,
        pb ? ids[i]! : null,
        now,
        now,
      );
      member.run(row!.id, list, now, now);
    }
  })();
  if (pb) {
    for (let i = 0; i < count; i += 100) {
      await pb.update("people", ids[i]!, { name: `Renamed ${i}` });
    }
  }
  const c = await f.campaign({
    name: "measured",
    subject: 'Hello {{ subscriber.name | first_name | default: "there" }}',
    lists: [list],
    content_type: "html",
    messenger: "email",
    body: "<p>{{ subscriber.email }}</p>",
  });
  f.start();
  global.gc?.();
  const started = performance.now();
  await f.status(c.id, "running");
  await f.drive(async () => (await f.read(c.id)).status === "finished", 50, 10_000_000, 600_000);
  const seconds = (performance.now() - started) / 1000;
  closeBatch();
  const sent = Number((await f.read(c.id)).sent);
  console.log(
    JSON.stringify(
      {
        mode,
        count,
        sent,
        pushes: f.pushes.length,
        seconds: round(seconds),
        perSecond: Math.round(sent / seconds),
        readMs: reads.length ? quantiles(reads) : null,
        batchLookupMs: batches.length ? quantiles(batches) : null,
        rssMiB: round(process.memoryUsage().rss / 1_048_576),
        errors: f.errors.length,
      },
      null,
      2,
    ),
  );
} finally {
  await f.close();
  await pb?.close();
}
