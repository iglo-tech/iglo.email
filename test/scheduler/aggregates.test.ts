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

test("a sum beyond the safe integer range holds the step, retries with a log, and never sends", async () => {
  const f = await open();
  const template = await f.template("<p>total {{ aggregates.total }}</p>");
  await f.sequence({
    trigger: { event: "subscription_created" },
    steps: [
      tx(template, {
        wait: "PT1H",
        aggregates: { total: { event: "bulk", fn: "sum", field: "data.items" } },
      }),
    ],
  });
  const email = "total@example.test";
  const subscriber = (await f.event(email, "subscription_created")).subscriber_id;
  // Two values that are each a safe integer but whose sum is not: nothing is sent, the decision
  // is retried with backoff, and the attention log names no subscriber.
  rawEvent(f, subscriber, "bulk", '{"items": 9007199254740991}');
  rawEvent(f, subscriber, "bulk", '{"items": 9007199254740991}');
  await f.pass(hour);
  await f.until(() => f.errors.length > 0, "logged aggregate error");
  expect(f.errors.map((e) => (e as Error).message).join("\n")).toContain(
    "Sequence aggregates failed",
  );
  expect(f.errors.map((e) => (e as Error).message).join("\n")).not.toContain(email);
  expect(f.sink.messages).toHaveLength(0);
  const [enrollment] = (await f.json(`/api/enrollments?subscriber_id=${subscriber}`)).body.data
    .results as { status: string }[];
  expect(enrollment?.status).toBe("active");
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
