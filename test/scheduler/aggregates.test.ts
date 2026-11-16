// Event aggregates in sequence step templates (docs/design/05-sequences.md#aggregates, D100),
// observed through the events and sequences APIs, the scheduler loop with an injected clock, and
// the Mailpit-style SMTP sink.
import { afterEach, expect, test } from "bun:test";
import {
  day,
  hour,
  minute,
  schedulerFixture,
  type SchedulerFixture,
} from "@/test/scheduler/fixture";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}

function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  const body = data
    .slice(at + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return { body };
}
const tx = (template: number, extra: object = {}) => ({
  wait: "PT0S",
  kind: "transactional",
  template_id: template,
  ...extra,
});
const iso = (f: SchedulerFixture, plus = 0) =>
  new Date(f.clock.now().getTime() + plus).toISOString();
/** Wait until `count` messages arrived and the outbox journaled every outcome. */
async function delivered(f: SchedulerFixture, count: number) {
  await f.until(
    async () =>
      f.sink.messages.length >= count &&
      (await f.sendLog()).every((s) => s.status !== "queued" && s.status !== "sending"),
    `${count} messages`,
  );
}
/** An event row as the database holds it, for JSON text the events API would canonicalize. */
function rawEvent(f: SchedulerFixture, subscriberId: number, name: string, data: string) {
  f.db.run(
    "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [subscriberId, name, data, iso(f), iso(f)],
  );
}
/** Replace the step's aggregates while its condition runs, once. */
const always = { not: { event: "never_happens", since: "trigger" } };
function during(f: SchedulerFixture, act: () => Promise<unknown> | unknown) {
  const state = { ran: false };
  f.onCondition = async (_, evaluate) => {
    if (!state.ran) {
      state.ran = true;
      await act();
    }
    return evaluate();
  };
  return state;
}
const save = (f: SchedulerFixture, id: number, steps: object[]) =>
  f.json(`/api/sequences/${id}`, "PUT", {
    name: "Your month",
    status: "active",
    trigger: { event: "subscription_created" },
    reentry: "always",
    steps,
  });

test("the your-month step sums, counts and distincts the events of its window", async () => {
  const f = await open();
  const template = await f.template(
    "<p>items {{ aggregates.items }}|sources {{ aggregates.sources }}|" +
      "actions {{ aggregates.actions }}|since {{ aggregates.since_trigger }}</p>",
  );
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "P30D",
        aggregates: {
          items: { event: "download_finished", since: "P30D", fn: "sum", field: "data.items" },
          sources: {
            event: "download_finished",
            since: "P30D",
            fn: "distinct",
            field: "data.source_id",
          },
          actions: { event: "assistant_action", since: "P30D" },
          since_trigger: { event: "download_finished", since: "trigger" },
        },
      }),
    ],
  });
  const email = "month@example.test";
  // Before the trigger: outside the window of the step, which starts at the trigger.
  await f.event(email, "download_finished", {
    data: { items: 100, source_id: "old" },
    occurred_at: iso(f, -day),
  });
  await f.event(email, "assistant_action", { occurred_at: iso(f, -day) });
  const started = (await f.event(email, "subscription_created")).enrollments.started;
  expect(started).toHaveLength(1);

  await f.pass(10 * day);
  // Inside the window: a string `items` is ignored by sum but still names its source.
  await f.event(email, "download_finished", { data: { items: 3, source_id: "a" } });
  await f.event(email, "download_finished", { data: { items: 4, source_id: "b" } });
  await f.event(email, "download_finished", { data: { items: 3, source_id: "a" } });
  await f.event(email, "download_finished", { data: { items: "7", source_id: "c" } });
  await f.event(email, "assistant_action");
  await f.event(email, "assistant_action");
  await f.pass(20 * day);
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("items 10|sources 3|actions 2|since 4");
});

test("where filters the events, a conditional line reads a count, and an empty result is 0", async () => {
  const f = await open();
  const template = await f.template(
    "<p>{% if aggregates.had > 0 %}HAD{% else %}NONE{% endif %}|" +
      "{% if aggregates.lacks == 0 %}ZERO{% endif %}|bulk {{ aggregates.bulk }}|" +
      "sum {{ aggregates.none_sum }}|distinct {{ aggregates.none_distinct }}</p>",
  );
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          had: { event: "feedback_given" },
          lacks: { event: "never_sent" },
          bulk: { event: "download_finished", where: { "data.kind": "bulk" } },
          none_sum: {
            event: "download_finished",
            fn: "sum",
            field: "data.items",
            where: { "data.kind": "nothing" },
          },
          none_distinct: { event: "never_seen", fn: "distinct", field: "data.x" },
        },
      }),
    ],
  });
  const email = "filters@example.test";
  await f.event(email, "download_finished", { data: { kind: "bulk", items: 2 } });
  await f.event(email, "download_finished", { data: { kind: "bulk", items: 5 } });
  await f.event(email, "download_finished", { data: { kind: "single", items: 9 } });
  await f.event(email, "feedback_given");
  await f.event(email, "subscription_created");
  await f.pass(hour);
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("HAD|ZERO|bulk 2|sum 0|distinct 0");
});

test("distinct counts numbers, text and booleans as the condition language's eq does", async () => {
  const f = await open();
  const template = await f.template("<p>distinct {{ aggregates.values }}</p>");
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          values: { event: "sample", fn: "distinct", field: "data.v" },
        },
      }),
    ],
  });
  const email = "distinct@example.test";
  const subscriber = (await f.event(email, "subscription_created")).subscriber_id;
  // Stored as the database holds them: a real 5.0 and an integer 5 are one value, "5" is text,
  // true is a boolean that is not 1, and missing, null, objects and arrays are not values.
  for (const data of [
    '{"v": 5}',
    '{"v": 5.0}',
    '{"v": "5"}',
    '{"v": 6}',
    '{"v": true}',
    '{"v": 1}',
    '{"v": ""}',
    '{"v": null}',
    "{}",
    '{"v": {"a": 1}}',
    '{"v": [1]}',
  ])
    rawEvent(f, subscriber, "sample", data);
  await f.pass(hour);
  await delivered(f, 1);
  // Numbers {5, 6, 1}, text {"5", ""}, booleans {true}.
  expect(decoded(f.sink.messages[0]!.data).body).toContain("distinct 6");
});

test("an edit while the aggregates are read discards the stale decision and reads the current ones", async () => {
  const f = await open();
  const template = await f.template("<p>pings {{ aggregates.n }}</p>");
  const seq = await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        condition: always,
        aggregates: { n: { event: "ping" } },
      }),
    ],
  });
  const [step] = seq.steps as { id: number }[];
  const email = "inflight@example.test";
  await f.event(email, "ping");
  await f.event(email, "subscription_created");
  const changed = during(f, async () => {
    const r = await save(f, seq.id, [
      tx(template, {
        id: step!.id,
        wait: "PT1H",
        condition: always,
        aggregates: { n: { event: "pong" } },
      }),
    ]);
    expect(r.status).toBe(200);
  });
  await f.pass(hour);
  await delivered(f, 1);
  expect(changed.ran).toBe(true);
  // The decision read `ping` (one event) before the edit; the current `pong` count is zero.
  expect(decoded(f.sink.messages[0]!.data).body).toContain("<p>pings 0</p>");
});

test("a test enrollment computes its aggregates like a real one", async () => {
  const f = await open();
  const template = await f.template("<p>pings {{ aggregates.n }}</p>", "Test pings");
  const seq = await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [tx(template, { wait: "P30D", aggregates: { n: { event: "ping", since: "P30D" } } })],
  });
  const email = "test-mode@example.test";
  const subscriber = (await f.event(email, "ping")).subscriber_id;
  await f.event(email, "ping");
  const created = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriber,
    test: true,
  });
  expect(created.status).toBe(200);
  await f.pass(minute);
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("<p>pings 2</p>");
});

test("a window counts only the subscriber's own events inside it", async () => {
  const f = await open();
  const template = await f.template("<p>total {{ aggregates.total }}</p>");
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: { total: { event: "bulk", fn: "sum", field: "data.items", since: "P1D" } },
      }),
    ],
  });
  const mine = "mine@example.test",
    other = "other@example.test";
  await f.event(other, "bulk", { data: { items: 1000 } });
  await f.event(mine, "bulk", { data: { items: 4 } });
  await f.event(mine, "bulk", { data: { items: 5 } });
  await f.event(mine, "subscription_created");
  await f.pass(hour);
  await delivered(f, 1);
  expect(f.sink.messages).toHaveLength(1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("<p>total 9</p>");
});

/** Inserts `count` events of one subscriber in one transaction; `at` and `data` build row `i`. */
function bulkEvents(
  f: SchedulerFixture,
  subscriberId: number,
  name: string,
  count: number,
  at: (i: number) => string,
  data: (i: number) => string,
) {
  const insert = f.db.prepare(
    "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  f.db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(subscriberId, name, data(i), at(i), iso(f));
  })();
  insert.finalize();
}

test("exactly 10,000 events of the name in the window are read in full: the step sends the complete totals", async () => {
  const f = await open();
  const template = await f.template(
    "<p>count {{ aggregates.n }}|sum {{ aggregates.total }}|sources {{ aggregates.sources }}</p>",
  );
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          n: { event: "download_finished", since: "P1D" },
          total: { event: "download_finished", since: "P1D", fn: "sum", field: "data.items" },
          sources: {
            event: "download_finished",
            since: "P1D",
            fn: "distinct",
            field: "data.source_id",
          },
        },
      }),
    ],
  });
  const email = "edge@example.test";
  const subscriber = (await f.event(email, "subscription_created")).subscriber_id;
  bulkEvents(
    f,
    subscriber,
    "download_finished",
    10_000,
    () => iso(f),
    (i) => JSON.stringify({ items: 2, source_id: `s${i % 25}` }),
  );
  await f.pass(hour);
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain(
    "<p>count 10000|sum 20000|sources 25</p>",
  );
  expect(f.errors).toHaveLength(0);
});

test("10,001 events of the name in the window hold the step: skipped with aggregate_limit, advanced, no mail, one log", async () => {
  const f = await open();
  const template = await f.template("<p>count {{ aggregates.n }}</p>");
  const seq = await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          n: { event: "download_finished", since: "P1D" },
          lacks: { event: "never_sent" },
        },
      }),
    ],
  });
  const email = "over@example.test";
  const created = await f.event(email, "subscription_created");
  const id = created.enrollments.started[0]!.id;
  bulkEvents(
    f,
    created.subscriber_id,
    "download_finished",
    10_001,
    () => iso(f),
    (i) => JSON.stringify({ items: 1, source_id: `s${i}` }),
  );
  await f.pass(hour);
  const sends = (await f.sendLog()).filter((s) => s.enrollment_id === id);
  expect(sends).toMatchObject([
    {
      step_id: seq.steps[0]!.id,
      status: "skipped",
      skip_reason: "aggregate_limit",
      template_id: template,
    },
  ]);
  expect(f.sink.messages).toHaveLength(0);
  expect(f.errors).toHaveLength(1);
  const logged = f.errors.map((e) => (e as Error).message).join("\n");
  expect(logged).toContain("aggregate");
  expect(logged).not.toContain(email);
  // The step advanced past the last step: no retry, no second log, no partial total.
  await f.pass(hour);
  expect(f.errors).toHaveLength(1);
  expect(f.sink.messages).toHaveLength(0);
  expect((await f.enrollment(id)).status).toBe("completed");
});

test("the limit counts the events of the name in the window, whatever where matches", async () => {
  const f = await open();
  const template = await f.template("<p>bulk {{ aggregates.bulk }}</p>");
  const seq = await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          bulk: { event: "download_finished", since: "P1D", where: { "data.kind": "bulk" } },
        },
      }),
    ],
  });
  // 10,001 events in the window, none of them bulk: the aggregate reads more than 10,000 rows,
  // so the step is held, whatever its `where` keeps.
  const created = await f.event("over-where@example.test", "subscription_created");
  bulkEvents(
    f,
    created.subscriber_id,
    "download_finished",
    10_001,
    () => iso(f),
    () => '{"kind":"single"}',
  );
  await f.pass(hour);
  const sends = (await f.sendLog()).filter(
    (s) => s.enrollment_id === created.enrollments.started[0]!.id,
  );
  expect(sends).toMatchObject([
    { step_id: seq.steps[0]!.id, status: "skipped", skip_reason: "aggregate_limit" },
  ]);
  expect(f.sink.messages).toHaveLength(0);
  expect(f.errors).toHaveLength(1);
});

test("10,000 events of the name in the window are read in full, and only they count", async () => {
  const f = await open();
  const template = await f.template("<p>bulk {{ aggregates.bulk }}</p>");
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          bulk: { event: "download_finished", since: "P1D", where: { "data.kind": "bulk" } },
        },
      }),
    ],
  });
  const created = await f.event("window@example.test", "subscription_created");
  const subscriber = created.subscriber_id;
  // 10,000 single events now (read, none bulk), 10,000 bulk events two days old (outside `since`)
  // and 10,000 events of another name now (not read). Were any of them read, the limit would hold
  // the step; were the old bulk events counted, the total would be wrong.
  bulkEvents(
    f,
    subscriber,
    "download_finished",
    10_000,
    () => iso(f),
    () => '{"kind":"single"}',
  );
  bulkEvents(
    f,
    subscriber,
    "download_finished",
    10_000,
    () => iso(f, -2 * day),
    () => '{"kind":"bulk"}',
  );
  bulkEvents(
    f,
    subscriber,
    "another_event",
    10_000,
    () => iso(f),
    () => '{"kind":"bulk"}',
  );
  await f.pass(hour);
  await delivered(f, 1);
  expect(decoded(f.sink.messages[0]!.data).body).toContain("<p>bulk 0</p>");
  expect(f.errors).toHaveLength(0);
});

test("a sum past the safe integer range or the 64-bit range holds the step as aggregate_limit", async () => {
  const f = await open();
  const template = await f.template("<p>total {{ aggregates.total }}</p>");
  const seq = await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: {
          total: { event: "download_finished", fn: "sum", field: "data.items" },
        },
      }),
    ],
  });
  // Two events whose exact sum is 2^53: beyond ±(2^53 − 1), so it would be a rounded total.
  const past = await f.event("past-safe@example.test", "subscription_created");
  await f.event("past-safe@example.test", "download_finished", {
    data: { items: Number.MAX_SAFE_INTEGER },
  });
  await f.event("past-safe@example.test", "download_finished", { data: { items: 1 } });
  // Two values whose sum overflows SQLite's 64-bit integer sum.
  const overflow = await f.event("overflow@example.test", "subscription_created");
  rawEvent(f, overflow.subscriber_id, "download_finished", '{"items":9223372036854775807}');
  rawEvent(f, overflow.subscriber_id, "download_finished", '{"items":9223372036854775807}');
  await f.pass(hour);
  const sends = await f.sendLog();
  for (const created of [past, overflow]) {
    expect(
      sends.filter((s) => s.enrollment_id === created.enrollments.started[0]!.id),
    ).toMatchObject([
      { step_id: seq.steps[0]!.id, status: "skipped", skip_reason: "aggregate_limit" },
    ]);
  }
  expect(f.sink.messages).toHaveLength(0);
  // Skipped, not retried: one log per decision and no retry scheduled.
  expect(f.errors).toHaveLength(2);
  await f.pass(hour);
  expect(f.errors).toHaveLength(2);
});
