// B118h: the Events tab's read for one page of a subscriber's events, with an enrollment exited by every
// event of the page, at the reviewer's seed: one subscriber holding one event name, 200,000 events by
// default, page 1 at per_page=100. A tab load is the events store's page (the page and its count) and
// the enrollments' event links for that page, through the production functions. Serial, opt-in, not a CI
// threshold; the results are stored in docs/perf/B118h-exit-event.md.
// Usage: bun test/events/measure-exit-shown.ts [events] [per_page] [repetitions] [loads]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createEventStore } from "@/events/store";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createEnrollments } from "@/sequences/enrollments";
import { createSubscriberStore } from "@/subscribers/store";

const [eventsArg, perPageArg, repsArg, loadsArg] = process.argv.slice(2);
const events = Number(eventsArg ?? 200_000);
const perPage = Number(perPageArg ?? 100);
const repetitions = Number(repsArg ?? 3);
const loads = Number(loadsArg ?? 5);
const clock = createRealClock();
const root = mkdtempSync(join(tmpdir(), "iglo-exit-shown-"));

const median = (values: Array<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const round = (value: number) => Math.round(value * 10) / 10;

try {
  const db = openDatabase(root);
  runMigrations(db, root, clock, productionMigrations);
  // One subscriber, one sequence that every page_view event triggers and exits (reentry always).
  // Events are one second apart in receive time, so each is the only event with its time. Every
  // event on page 1 carries one exited enrollment whose trigger is the event before it.
  db.run(
    "INSERT INTO subscribers (uuid, email, name) VALUES ('measure-sub', 'measure@example.test', 'Measure')",
  );
  db.run(
    `INSERT INTO sequences (uuid, name, status, trigger, exit_on, reentry)
     VALUES ('measure-seq', 'Measure path', 'active', '{"event":"page_view"}', '["page_view"]', 'always')`,
  );
  db.transaction(() => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO events (subscriber_id, name, data, occurred_at, created_at, idempotency_key)
       SELECT 1, 'page_view', '{}',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || i || ' seconds'),
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || i || ' seconds'),
         NULL
       FROM n`,
      [events],
    );
    db.run(
      `INSERT INTO enrollments (sequence_id, subscriber_id, trigger_event_id, status, exit_reason,
         created_at, updated_at, finished_at)
       SELECT 1, 1, e.id - 1, 'exited', 'event:page_view', e.created_at, e.created_at, e.created_at
         FROM events e WHERE e.id > ?1 - ?2 AND e.id <= ?1 AND e.subscriber_id = 1`,
      [events, perPage],
    );
  })();

  const subscribers = createSubscriberStore(db, clock, createListReferences(db));
  const eventStore = createEventStore(db, subscribers, {
    emailAllowed: () => true,
    i18n: createTranslation(),
  });
  const enrollments = createEnrollments(db, clock);

  const tabLoad = () => {
    const page = eventStore.page(1n, 1, perPage);
    const rows = page.results.map((row) => ({
      id: BigInt(JSON.stringify(row.id)),
      name: row.name,
      receivedAt: row.created_at,
    }));
    const links = enrollments.eventLinks(1n, rows);
    return [...links.values()].filter((link) => link.exited.length > 0).length;
  };

  const pageOnly = () => eventStore.page(1n, 1, perPage).results.length;
  const exitedOnPage = tabLoad();
  console.log(`seed: ${events} events, per_page ${perPage}, exits on the page: ${exitedOnPage}`);

  const pageMedians: Array<number> = [];
  const tabMedians: Array<number> = [];
  for (let rep = 1; rep <= repetitions; rep++) {
    const pageTimes: Array<number> = [];
    const tabTimes: Array<number> = [];
    for (let load = 0; load < loads; load++) {
      let start = performance.now();
      pageOnly();
      pageTimes.push(performance.now() - start);
      start = performance.now();
      tabLoad();
      tabTimes.push(performance.now() - start);
    }
    pageMedians.push(median(pageTimes));
    tabMedians.push(median(tabTimes));
    console.log(
      `repetition ${rep}: page+count ${round(median(pageTimes))} ms, Events tab ${round(median(tabTimes))} ms (median of ${loads} loads)`,
    );
  }
  console.log(
    `median of ${repetitions}: page+count ${round(median(pageMedians))} ms, Events tab ${round(median(tabMedians))} ms`,
  );

  enrollments.close();
  eventStore.close();
  db.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
