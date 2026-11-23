// B117d (decision 4): the cost of the send-log page for a list-scoped reader, measured through the
// journal's own list(), as GET /api/sends calls it, at a million sends with 2 KB payloads kept. The
// unscoped page is the baseline. The scoped readers are a one-million-member list (every subscriber),
// a hundred-member list and a list with nobody on it. Each page is run `repetitions` times, and the
// medians are reported. Serial, opt-in, not a CI threshold. Results are stored in
// docs/perf/B117d-send-scope.md.
// Usage: bun test/sends/measure-scope.ts [sends] [repetitions]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createSends } from "@/messaging/sends";
import type { Scope } from "@/subscribers/store";
import { createSubscriberStore } from "@/subscribers/store";

const [sendsArg, repsArg] = process.argv.slice(2);
const sends = Number(sendsArg ?? 1_000_000);
const repetitions = Number(repsArg ?? 3);
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-send-scope-"));

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

// The predicate shapes the page could use, measured as SQL on the same database (the server's statements, with
// the journal's ORDER BY and LIMIT). None of them is the journal's predicate; the journal keeps the first.
const IN_MEMBERSHIP =
  "subscriber_id IN (SELECT m.subscriber_id FROM subscriber_lists m WHERE m.list_id IN (SELECT value FROM json_each(?)))";
const EXISTS_CORRELATED =
  "EXISTS (SELECT 1 FROM subscriber_lists m WHERE m.subscriber_id = sends.subscriber_id AND m.list_id IN (SELECT value FROM json_each(?)))";
const SHAPES: Array<{ name: string; where: string; setup?: string; teardown?: string }> = [
  { name: "in-membership (the journal's predicate)", where: IN_MEMBERSHIP },
  { name: "exists-correlated", where: EXISTS_CORRELATED },
  {
    name: "in-membership with covering index (list_id, subscriber_id)",
    where: IN_MEMBERSHIP,
    setup: "CREATE INDEX idx_sub_lists_list_sub ON subscriber_lists(list_id, subscriber_id)",
    teardown: "DROP INDEX idx_sub_lists_list_sub",
  },
];
function shapeExperiment(db: Database) {
  const rows: Array<Record<string, unknown>> = [];
  const timeQuery = (sql: string, list: string, reps: number) => {
    const times: Array<number> = [];
    for (let rep = 0; rep < reps; rep++) {
      const start = performance.now();
      db.query(sql).all(list);
      times.push(performance.now() - start);
    }
    return Math.round(median(times) * 10) / 10;
  };
  for (const shape of SHAPES) {
    if (shape.setup) {
      db.run(shape.setup);
    }
    try {
      for (const [label, list] of [
        ["every subscriber", "[1]"],
        ["a hundred", "[2]"],
        ["nobody", "[3]"],
      ] as const) {
        // The correlated form takes minutes on the sparse lists, so it runs once there.
        const reps = shape.name.startsWith("exists") && list !== "[1]" ? 1 : repetitions;
        rows.push({
          shape: shape.name,
          list: label,
          countMs: timeQuery(`SELECT count(*) AS n FROM sends WHERE ${shape.where}`, list, reps),
          pageMs: timeQuery(
            `SELECT id, json_extract(payload, '$.message.subject') AS subject FROM sends WHERE ${shape.where} ORDER BY id DESC LIMIT 20`,
            list,
            reps,
          ),
          runs: reps,
        });
      }
    } finally {
      if (shape.teardown) {
        db.run(shape.teardown);
      }
    }
  }
  return rows;
}

const dataDir = join(root, "scope");
const db = openDatabase(dataDir);
try {
  runMigrations(db, dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const journal = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://measure.test",
  });

  // Three lists: 1 has every subscriber, 2 has the first hundred, 3 has nobody.
  db.run(
    `INSERT INTO lists (id, uuid, name, type, optin) VALUES
       (1, 'list-all', 'Everyone', 'public', 'single'),
       (2, 'list-few', 'Few', 'public', 'single'),
       (3, 'list-none', 'Nobody', 'public', 'single')`,
  );
  const seedStart = performance.now();
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO subscribers (uuid, email, name, status)
       SELECT 'sub-' || i, 'sub' || i || '@example.test', 'Sub ' || i, 'enabled' FROM n`,
      [sends],
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO subscriber_lists (subscriber_id, list_id, status)
       SELECT i, 1, 'confirmed' FROM n`,
      [sends],
    );
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO subscriber_lists (subscriber_id, list_id, status)
       SELECT i, 2, 'confirmed' FROM n`,
    );
    // Each send goes to a different subscriber, in a scattered order; every payload is kept (2 KB of HTML).
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, created_at, sent_at, smtp_message_id, payload)
       SELECT 'seed-' || i, 'tx', 'transactional', ((i * 7919) % ?1) + 1, 'sub' || (((i * 7919) % ?1) + 1) || '@example.test',
         'sent',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (i % 300) || ' days'),
         '<seed-' || i || '@measure.test>',
         json_object('message', json_object('subject', 'Subject ' || i, 'html', replace(printf('%2000s', ''), ' ', 'x')))
       FROM n`,
      [sends],
    );
  })();
  // No ANALYZE: the server never runs it, and the planner's choice depends on the statistics it would store.
  const seeded = Math.round(performance.now() - seedStart);

  const readers: Array<[string, Scope]> = [
    ["unscoped", { all: true, ids: [] }],
    ["list of every subscriber", { all: false, ids: [1n] }],
    ["list of a hundred", { all: false, ids: [2n] }],
    ["list of nobody", { all: false, ids: [3n] }],
  ];
  const results = readers.map(([label, scope]) => {
    const page = () => journal.list({ page: 1, perPage: 20, scope });
    const first = page();
    const times: Array<number> = [];
    for (let rep = 0; rep < repetitions; rep++) {
      const start = performance.now();
      page();
      times.push(performance.now() - start);
    }
    return {
      reader: label,
      total: first.total,
      rows: first.results.length,
      ms: Math.round(median(times) * 10) / 10,
      runs: times.map((t) => Math.round(t * 10) / 10),
    };
  });
  const shapes = shapeExperiment(db);
  console.log(
    JSON.stringify({ sends, repetitions, seedMs: seeded, pages: results, shapes }, null, 2),
  );
  journal.close();
  subscribers.close();
  lists.close();
} finally {
  db.close(true);
  rmSync(root, { recursive: true, force: true });
}
