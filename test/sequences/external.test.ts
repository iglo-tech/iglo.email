// B150c (15-external-sources section 6, D172): sequences on a project's source, observed through the
// sequences and enrollments APIs, the scheduler loop with an injected clock, the SMTP sink and the
// real PocketBase 0.40.5 binary.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { ExternalSource } from "@/sources/source";
import { adapter, enableBatch } from "@/test/conditions/source-fixture";
import type { JsonObject } from "@/test/json-object";
import { day, hour, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(120_000);

let pb: PocketBase;
beforeAll(async () => {
  pb = await startPocketBase();
  await enableBatch(pb);
});
afterAll(async () => {
  await pb?.close();
});
const fixtures: Array<SchedulerFixture> = [];
const instances: Array<PocketBase> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
  for (const own of instances.splice(0)) {
    await own.close();
  }
});
/** A scheduler fixture whose project source is `source` (none when null). */
async function open(source: ExternalSource | null = adapter(pb)) {
  const f = await schedulerFixture({ source: () => source });
  fixtures.push(f);
  return f;
}
const tx = (template: number, extra: JsonObject = {}) => ({
  wait: "PT0S",
  kind: "transactional",
  template_id: template,
  ...extra,
});
const iso = (f: SchedulerFixture, plus = 0) =>
  new Date(f.clock.now().getTime() + plus).toISOString();
/** An external sequence with these steps, active. */
const external = (steps: Array<JsonObject>, extra: JsonObject = {}): JsonObject => ({
  source: "external",
  trigger: { event: "order_paid" },
  steps,
  ...extra,
});
const enroll = (
  f: SchedulerFixture,
  sequence: number,
  subscriber: number,
  extra: JsonObject = {},
) =>
  f.json("/api/enrollments", "POST", {
    sequence_id: sequence,
    subscriber_id: subscriber,
    ...extra,
  });
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  return data
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}
const attention = (f: SchedulerFixture) => f.errors.map(String).join("\n");

test("an external sequence needs a source; sql, trigger.where conditions and pushed trigger.condition are refused", async () => {
  const none = await open(null);
  const template = await none.template();
  const refused = await none.json("/api/sequences", "POST", {
    name: "No source",
    ...external([tx(template)]),
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("source");

  const f = await open();
  const t = await f.template();
  const post = (definition: JsonObject) =>
    f.json("/api/sequences", "POST", { name: "Source", reentry: "always", ...definition });
  for (const [definition, field] of [
    [external([tx(t, { condition: { sql: "1 = 1" } })]), "steps.0.condition.sql"],
    [
      external([tx(t)], { trigger: { event: "order_paid", where: { event: "visit" } } }),
      "trigger.where",
    ],
    [
      {
        trigger: { event: "order_paid", condition: { event: "order_paid", count: { gte: 2 } } },
        steps: [tx(t)],
      },
      "trigger.condition",
    ],
    [
      external([tx(t)], {
        trigger: { event: "order_paid", condition: { attr: "plan", op: "eq", value: "x" } },
      }),
      "trigger.condition.attr",
    ],
    [
      external([tx(t)], {
        trigger: { event: "order_paid", condition: { event: "order_paid", since: "trigger" } },
      }),
      "trigger.condition.since",
    ],
    [
      {
        trigger: { event: "order_paid" },
        steps: [tx(t, { condition: { recipient: "name", op: "exists" } })],
      },
      "steps.0.condition",
    ],
    [external([tx(t)], { source: "elsewhere" }), "source"],
  ] as const) {
    const answer = await post(definition as unknown as JsonObject);
    expect([answer.status, String(answer.body.message)]).toEqual([
      400,
      expect.stringContaining(field) as unknown as string,
    ]);
  }

  // The data.* equality form of trigger.where, trigger.condition and recipient conditions are kept.
  const condition = {
    event: "order_paid",
    since: "P180D",
    where: { "data.product": "prepaid" },
    count: { gte: 2 },
  };
  const saved = await post(
    external([tx(t, { condition: { recipient: "optOut", op: "eq", value: false } })], {
      trigger: { event: "order_paid", where: { "data.plan": "pro" }, condition },
    }),
  );
  expect(saved.status).toBe(200);
  expect(saved.body.data).toMatchObject({
    source: "external",
    trigger: { event: "order_paid", where: { "data.plan": "pro" }, condition },
  });
  // A sequence without `source` stays on pushed events; an update without it keeps the stored one.
  const pushed = await post({ trigger: { event: "order_paid" }, steps: [tx(t)] });
  expect(pushed.body.data.source).toBe("events");
  const kept = await f.json(`/api/sequences/${saved.body.data.id}`, "PUT", {
    name: "Renamed",
    trigger: { event: "order_paid" },
    reentry: "always",
    steps: [tx(t)],
  });
  expect(kept.body.data).toMatchObject({ name: "Renamed", source: "external" });

  // The condition check answers for either place.
  const check = (body: JsonObject) => f.json("/api/conditions/validate", "POST", body);
  expect(
    (await check({ condition: { recipient: "name", op: "exists" }, source: "external" })).body.data,
  ).toEqual({ ok: true, errors: [] });
  expect((await check({ condition: { recipient: "name", op: "exists" } })).body.data.ok).toBe(
    false,
  );
  expect(
    (await check({ condition: { sql: "1 = 1" }, source: "external" })).body.data.errors[0].field,
  ).toBe("condition.sql");
  expect(
    (
      await check({
        condition: { attr: "plan", op: "exists" },
        source: "external",
        trigger: true,
      })
    ).body.data.ok,
  ).toBe(false);
  expect((await check({ condition: { event: "x" }, trigger: true })).status).toBe(400);
});

test("a step reads its condition, aggregates and trigger data from the source", async () => {
  const f = await open();
  const ada = await pb.user({ name: "Ada" });
  const other = await pb.user();
  await pb.event(ada.id, "order_paid", { plan: "basic" }, { occurredAt: iso(f, -3 * day) });
  const paid = await pb.event(ada.id, "order_paid", { plan: "pro" }, { occurredAt: iso(f, -day) });
  await pb.event(ada.id, "download", { items: 3 }, { occurredAt: iso(f, -hour) });
  await pb.event(ada.id, "download", { items: "4" }, { occurredAt: iso(f, -hour) });
  const foreign = await pb.event(other.id, "order_paid", {}, { occurredAt: iso(f, -day) });
  const template = await f.template(
    "<p>plan {{ trigger.data.plan }}|items {{ aggregates.items }}|orders {{ aggregates.orders }}</p>",
  );
  const seq = await f.sequence(
    external([
      tx(template, {
        condition: {
          all: [
            { event: "download", since: "trigger", where: { "data.items": 3 } },
            { recipient: "name", op: "eq", value: "Ada" },
          ],
        },
        aggregates: {
          items: { event: "download", since: "trigger", fn: "sum", field: "data.items" },
          orders: { event: "order_paid", fn: "count" },
        },
      }),
    ]),
  );
  const subscriber = await f.subscriber("ada@example.test", { external_id: ada.id });
  // A record of another user, or a pushed event ID, is refused.
  expect((await enroll(f, seq.id, subscriber, { trigger_external_id: foreign.id })).status).toBe(
    400,
  );
  expect((await enroll(f, seq.id, subscriber, { trigger_external_id: "bad id" })).status).toBe(400);
  // Without a record named, the subscriber's latest under the trigger's name.
  const started = await enroll(f, seq.id, subscriber);
  expect(started.status).toBe(200);
  expect(started.body.data).toMatchObject({
    trigger_event_id: null,
    trigger_external_id: paid.id,
    trigger_occurred_at: new Date(String(paid.occurredAt).replace(" ", "T")).toISOString(),
    error_since: null,
  });

  // The preview reads the same record and totals.
  const preview = await f.json(
    `/api/sequences/${seq.id}/steps/${seq.steps[0]!.id}/preview`,
    "POST",
    {
      subscriber_id: subscriber,
      trigger_external_id: paid.id,
    },
  );
  expect(preview.status).toBe(200);
  expect(preview.body.data.body).toContain("plan pro|items 3|orders 2");

  await f.pass(0);
  await f.until(() => f.sink.messages.length === 1, "one message");
  expect(decoded(f.sink.messages[0]!.data)).toContain("plan pro|items 3|orders 2");
  const id = started.body.data.id as number;
  await f.until(async () => (await f.enrollment(id)).status === "completed", "completed");
  const entries = (await f.json(`/api/enrollments/${id}/timeline`)).body.data.entries;
  expect(entries[0]).toMatchObject({
    type: "trigger",
    name: "order_paid",
    data: { plan: "pro" },
    external_id: paid.id,
    unavailable: null,
  });

  // A pushed event never starts an external sequence.
  const pushed = await f.event("ada@example.test", "order_paid");
  expect(pushed.enrollments.started).toEqual([]);
});

test("a step whose condition is false on the source follows on_false; a missing trigger record ends trigger_missing", async () => {
  const f = await open();
  const ada = await pb.user();
  const record = await pb.event(ada.id, "order_paid", { plan: "x" }, { occurredAt: iso(f, -day) });
  const template = await f.template("<p>{{ trigger.data.plan }}</p>");
  const seq = await f.sequence(
    external([
      tx(template, { condition: { event: "never_sent" }, on_false: "skip" }),
      tx(template, { wait: "P1D" }),
    ]),
  );
  const subscriber = await f.subscriber("gone@example.test", { external_id: ada.id });
  const started = await enroll(f, seq.id, subscriber, { trigger_external_id: record.id });
  const id = started.body.data.id as number;
  await f.pass(0);
  await f.until(async () => (await f.enrollment(id)).step_id === seq.steps[1]!.id, "skipped");
  expect(f.sink.messages).toHaveLength(0);

  await pb.remove("events", record.id);
  await f.pass(day);
  await f.until(async () => (await f.enrollment(id)).status !== "active", "ended");
  expect(await f.enrollment(id)).toMatchObject({
    status: "exited",
    exit_reason: "trigger_missing",
  });
  expect(f.sink.messages).toHaveLength(0);
  // The subscriber stays.
  expect((await f.json(`/api/subscribers/${subscriber}`)).status).toBe(200);
  const entries = (await f.json(`/api/enrollments/${id}/timeline`)).body.data.entries;
  expect(entries[0]).toMatchObject({
    type: "trigger",
    external_id: record.id,
    unavailable: "missing",
  });
});

test("a transient source failure is retried with backoff for 72 hours, then ends source_error; nothing is sent", async () => {
  const own = await startPocketBase();
  instances.push(own);
  const f = await open(adapter(own));
  const ada = await own.user();
  await own.event(ada.id, "order_paid", {}, { occurredAt: iso(f, -day) });
  const template = await f.template();
  const seq = await f.sequence(
    external([tx(template, { wait: "PT1H", condition: { event: "order_paid" } })]),
  );
  const subscriber = await f.subscriber("down@example.test", { external_id: ada.id });
  const id = (await enroll(f, seq.id, subscriber)).body.data.id as number;
  await own.stop();

  const failedAt = f.clock.now().getTime() + hour;
  await f.pass(hour);
  await f.until(async () => (await f.enrollment(id)).error_since !== null, "first failure");
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    step_id: seq.steps[0]!.id,
    error_since: new Date(failedAt).toISOString(),
  });
  expect(attention(f)).toContain(`Sequence source read failed for enrollment ${id}`);
  // Retried within the window: still active, still the first failure's time.
  while (f.clock.now().getTime() + hour < failedAt + 72 * hour) {
    await f.pass(hour);
  }
  expect(await f.enrollment(id)).toMatchObject({
    status: "active",
    error_since: new Date(failedAt).toISOString(),
  });
  await f.pass(hour);
  await f.until(async () => (await f.enrollment(id)).status !== "active", "source_error");
  expect(await f.enrollment(id)).toMatchObject({ status: "exited", exit_reason: "source_error" });
  expect(attention(f)).toContain(`Sequence enrollment ${id} ended with source_error`);
  expect(f.sink.messages).toHaveLength(0);
  expect((await f.sendLog()).filter((s) => s.enrollment_id === id)).toEqual([]);
});

test("a recovered source clears error_since and sends; a 400 ends source_error at once", async () => {
  const own = await startPocketBase();
  instances.push(own);
  const f = await open(adapter(own));
  const ada = await own.user();
  await own.event(ada.id, "order_paid", { plan: "x" }, { occurredAt: iso(f, -day) });
  const template = await f.template();
  const seq = await f.sequence(
    external([
      tx(template, {
        wait: "PT1H",
        condition: { event: "order_paid", where: { "data.plan": "x" } },
      }),
      tx(template, {
        wait: "P1D",
        condition: { event: "order_paid", where: { "data.plan": "x" } },
      }),
    ]),
  );
  const subscriber = await f.subscriber("flaky@example.test", { external_id: ada.id });
  const id = (await enroll(f, seq.id, subscriber)).body.data.id as number;
  await own.stop();
  await f.pass(hour);
  await f.until(async () => (await f.enrollment(id)).error_since !== null, "first failure");
  await own.start();
  await f.pass(hour);
  await f.until(async () => (await f.enrollment(id)).step_id === seq.steps[1]!.id, "advanced");
  expect((await f.enrollment(id)).error_since).toBeNull();
  await f.until(() => f.sink.messages.length === 1, "one message");

  // A renamed field: PocketBase answers 400, which no retry fixes.
  await own.renameField("events", "data", "payload");
  await f.pass(day);
  await f.until(async () => (await f.enrollment(id)).status !== "active", "source_error");
  expect(await f.enrollment(id)).toMatchObject({ status: "exited", exit_reason: "source_error" });
  expect(f.sink.messages).toHaveLength(1);
});
