// B150c (15-external-sources sections 6 and 9, D172): conditions and aggregates of external sequences
// evaluated against the real PocketBase 0.40.5 binary. The source's filter compares JSON loosely, so
// every loose case of spec section 9 is checked to reach the strict re-check: the filter alone would
// give the other answer.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { aggregateOnSource, evaluateOnSource, evaluateTriggerCondition } from "@/conditions/source";
import type { SourceContext } from "@/conditions/source";
import type { Condition, EventCount } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import { AGGREGATE_LIMIT } from "@/events/aggregate";
import type { Aggregate } from "@/events/aggregate";
import { SCAN_LIMIT } from "@/sources/source";
import { adapter, enableBatch, manyEvents } from "@/test/conditions/source-fixture";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(120_000);

let pb: PocketBase;
const day = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

beforeAll(async () => {
  pb = await startPocketBase();
  await enableBatch(pb);
});
afterAll(async () => {
  await pb?.close();
});

/** Validated as an external sequence's step condition, then evaluated for `user`. */
async function holds(condition: unknown, user: string, context: Partial<SourceContext> = {}) {
  const checked = validate(condition, { canUseSql: false, source: "external" });
  if (!checked.ok) {
    throw new Error(JSON.stringify(checked.errors));
  }
  const result = await evaluateOnSource(
    checked.condition,
    { externalId: user, now: new Date(NOW), ...context },
    { source: adapter(pb) },
  );
  if (!result.ok) {
    throw new Error(`${result.error.kind}: ${result.error.message}`);
  }
  return result.value;
}
const at = (ms: number) => ({ occurredAt: new Date(ms).toISOString() });
const prepaid = (since: string, count: EventCount) => ({
  event: "order_paid",
  since,
  where: { "data.product": "prepaid" },
  count,
});

test("event predicates read the source: existence and every count comparator", async () => {
  const ada = await pb.user();
  for (const offset of [3, 2, 1]) {
    await pb.event(ada.id, "order_paid", {}, at(NOW - offset * day));
  }
  await pb.event(ada.id, "download_finished", {}, at(NOW - day));
  const other = await pb.user();
  await pb.event(other.id, "order_paid", {}, at(NOW - day));

  expect(await holds({ event: "order_paid" }, ada.id)).toBe(true);
  expect(await holds({ event: "never_sent" }, ada.id)).toBe(false);
  expect(await holds({ not: { event: "never_sent" } }, ada.id)).toBe(true);
  expect(await holds({ event: "order_paid", count: { gte: 3 } }, ada.id)).toBe(true);
  expect(await holds({ event: "order_paid", count: { gte: 4 } }, ada.id)).toBe(false);
  expect(await holds({ event: "order_paid", count: { eq: 3 } }, ada.id)).toBe(true);
  expect(await holds({ event: "order_paid", count: { eq: 2 } }, ada.id)).toBe(false);
  expect(await holds({ event: "order_paid", count: { lte: 2 } }, ada.id)).toBe(false);
  expect(await holds({ event: "order_paid", count: { gte: 2, lte: 3 } }, ada.id)).toBe(true);
  expect(await holds({ event: "never_sent", count: { lte: 0 } }, ada.id)).toBe(true);
  expect(await holds({ event: "order_paid", count: { gte: 0 } }, ada.id)).toBe(true);
  // Another user's records never count.
  expect(await holds({ event: "download_finished" }, other.id)).toBe(false);
  expect(
    await holds(
      {
        all: [
          { event: "order_paid" },
          { any: [{ event: "never_sent" }, { event: "download_finished" }] },
        ],
      },
      ada.id,
    ),
  ).toBe(true);
});

test("windows are strictly after since: the bound itself is out, one millisecond later is in", async () => {
  const ada = await pb.user();
  const trigger = NOW - 10 * day;
  await pb.event(ada.id, "order_paid", {}, at(trigger));
  await pb.event(ada.id, "visit", {}, at(NOW - day));
  // Duration: the record exactly one day back is not after the bound; a millisecond earlier "now" it is.
  expect(await holds({ event: "visit", since: "P1D" }, ada.id)).toBe(false);
  expect(await holds({ event: "visit", since: "P1D" }, ada.id, { now: new Date(NOW - 1) })).toBe(
    true,
  );
  // `since: trigger` never counts the trigger itself, nor another record at the same instant.
  await pb.event(ada.id, "order_paid", {}, at(trigger));
  expect(
    await holds({ event: "order_paid", since: "trigger" }, ada.id, {
      triggerAt: new Date(trigger),
    }),
  ).toBe(false);
  expect(
    await holds({ event: "order_paid", since: "trigger" }, ada.id, {
      triggerAt: new Date(trigger - 1),
    }),
  ).toBe(true);
  // `last_step` without a step falls back to the trigger; `enrollment` reads the enrollment's start.
  expect(
    await holds({ event: "visit", since: "last_step" }, ada.id, {
      triggerAt: new Date(trigger),
      lastStepAt: null,
    }),
  ).toBe(true);
  expect(
    await holds({ event: "visit", since: "enrollment" }, ada.id, {
      enrolledAt: new Date(NOW - day),
    }),
  ).toBe(false);
  // A context without the time `since` names is an error, never false.
  const missing = await evaluateOnSource(
    { event: "visit", since: "trigger" },
    { externalId: ada.id, now: new Date(NOW) },
    { source: adapter(pb) },
  );
  expect(missing).toMatchObject({ ok: false, error: { kind: "context" } });
});

test("where is re-checked strictly on every loose case of the source's filter", async () => {
  const source = adapter(pb);
  const ada = await pb.user();
  const rows = [
    { b: 1 },
    { b: true },
    { n: "10" },
    { n: 10 },
    { f: 5.0 },
    { o: { "0": "x" } },
    { o: ["x"] },
    { s: "Ab" },
  ];
  for (const data of rows) {
    await pb.event(ada.id, "e", data, at(NOW - day));
  }
  // The filter alone matches `true` and `1` both ways (spec section 9): two records for each.
  expect(await source.count({ user: ada.id, names: ["e"], data: { b: true } }, 10)).toBe(2);
  expect(await source.count({ user: ada.id, names: ["e"], data: { b: 1 } }, 10)).toBe(2);
  // Strictly, a boolean is not a number.
  expect(await holds({ event: "e", where: { "data.b": true }, count: { eq: 1 } }, ada.id)).toBe(
    true,
  );
  expect(await holds({ event: "e", where: { "data.b": 1 }, count: { eq: 1 } }, ada.id)).toBe(true);
  expect(await holds({ event: "e", where: { "data.b": false } }, ada.id)).toBe(false);
  expect(await holds({ event: "e", where: { "data.b": 0 } }, ada.id)).toBe(false);
  // Text and numbers stay apart; 5 equals 5.0.
  expect(await holds({ event: "e", where: { "data.n": 10 }, count: { eq: 1 } }, ada.id)).toBe(true);
  expect(await holds({ event: "e", where: { "data.n": "10" }, count: { eq: 1 } }, ada.id)).toBe(
    true,
  );
  expect(await holds({ event: "e", where: { "data.f": 5 } }, ada.id)).toBe(true);
  // A path walks object keys only: `o.0` is the key "0", never an array index.
  expect(await holds({ event: "e", where: { "data.o.0": "x" }, count: { eq: 1 } }, ada.id)).toBe(
    true,
  );
  // Text compares exactly.
  expect(await holds({ event: "e", where: { "data.s": "ab" } }, ada.id)).toBe(false);
  // Loose matches before the strict ones do not end a count early: two strict among three loose.
  const bob = await pb.user();
  for (const b of [1, 1, 1, true, true]) {
    await pb.event(bob.id, "flag", { b }, at(NOW - day));
  }
  expect(await holds({ event: "flag", where: { "data.b": true }, count: { gte: 2 } }, bob.id)).toBe(
    true,
  );
  expect(await holds({ event: "flag", where: { "data.b": true }, count: { gte: 3 } }, bob.id)).toBe(
    false,
  );
  expect(await holds({ event: "flag", where: { "data.b": 1 }, count: { eq: 3 } }, bob.id)).toBe(
    true,
  );
});

test("hostile where values and names reach the source as literals and match only themselves", async () => {
  const ada = await pb.user();
  const values = [
    "it's",
    String.raw`trailing\\`,
    String.raw`a\'b`,
    "x' || name != '",
    "a && b || c",
    "zażółć 🎉",
    "nul\u0000byte",
    "0.0000001",
  ];
  for (const value of values) {
    await pb.event(ada.id, "hostile", { v: value }, at(NOW - day));
  }
  await pb.event(ada.id, "hostile", { v: 1e-7 }, at(NOW - day));
  for (const value of values) {
    expect(
      await holds({ event: "hostile", where: { "data.v": value }, count: { eq: 1 } }, ada.id),
    ).toBe(true);
  }
  // A number written with an exponent is left to the strict check, which finds its own record.
  expect(
    await holds({ event: "hostile", where: { "data.v": 1e-7 }, count: { eq: 1 } }, ada.id),
  ).toBe(true);
  expect(await holds({ event: "hostile", where: { "data.v": "it" } }, ada.id)).toBe(false);
  // A hostile event name is a literal too.
  await pb.event(ada.id, String.raw`na'me \ && x`, {}, at(NOW - day));
  expect(await holds({ event: String.raw`na'me \ && x`, count: { eq: 1 } }, ada.id)).toBe(true);
});

test("recipient reads the recipients view with attr's operators and type rules", async () => {
  const ada = await pb.user({ name: "Ada Lovelace", marketingOptOut: true });
  expect(await holds({ recipient: "name", op: "eq", value: "Ada Lovelace" }, ada.id)).toBe(true);
  expect(await holds({ recipient: "name", op: "ne", value: "Ada" }, ada.id)).toBe(true);
  expect(await holds({ recipient: "name", op: "gt", value: "Ada" }, ada.id)).toBe(true);
  expect(await holds({ recipient: "name", op: "lt", value: "Ada" }, ada.id)).toBe(false);
  expect(await holds({ recipient: "name", op: "in", value: ["x", "Ada Lovelace"] }, ada.id)).toBe(
    true,
  );
  expect(await holds({ recipient: "optOut", op: "eq", value: true }, ada.id)).toBe(true);
  // No coercion: a boolean is not 1, and text never orders against a number.
  expect(await holds({ recipient: "optOut", op: "eq", value: 1 }, ada.id)).toBe(false);
  expect(await holds({ recipient: "name", op: "gt", value: 1 }, ada.id)).toBe(false);
  // A field the view does not have is missing: it does not exist, and `ne` holds.
  expect(await holds({ recipient: "plan", op: "exists" }, ada.id)).toBe(false);
  expect(await holds({ recipient: "plan", op: "ne", value: "pro" }, ada.id)).toBe(true);
  expect(await holds({ recipient: "optOut", op: "exists" }, ada.id)).toBe(true);
  // A user the view no longer has holds no fields.
  await pb.update("users", ada.id, { deletedAt: new Date().toISOString() });
  expect(await holds({ recipient: "name", op: "exists" }, ada.id)).toBe(false);
  expect(await holds({ recipient: "name", op: "ne", value: "Ada Lovelace" }, ada.id)).toBe(true);
});

/** Aggregates of a step, read from the source, for `user`. */
async function totals(aggregates: Record<string, Aggregate>, user: string, now = NOW) {
  return aggregateOnSource(
    aggregates,
    { externalId: user, now: new Date(now) },
    { source: adapter(pb) },
  );
}

test("aggregates: count, sum and distinct with the strict type rules", async () => {
  const ada = await pb.user();
  for (const data of [
    { items: 2, src: 5, kind: "a" },
    { items: 3.5, src: 5.0, kind: "a" },
    { items: "7", src: "5", kind: "b" },
    { items: true, src: true, kind: "a" },
    { src: null, kind: "a" },
    { items: 4, src: { x: 1 }, kind: "a" },
  ]) {
    await pb.event(ada.id, "download", data, at(NOW - day));
  }
  await pb.event(ada.id, "download", { items: 100 }, at(NOW - 40 * day));
  expect(
    await totals(
      {
        all: { event: "download", fn: "count" },
        recent: { event: "download", since: "P30D", fn: "count" },
        kindA: { event: "download", since: "P30D", where: { "data.kind": "a" }, fn: "count" },
        items: { event: "download", since: "P30D", fn: "sum", field: "data.items" },
        sources: { event: "download", since: "P30D", fn: "distinct", field: "data.src" },
        none: { event: "never", fn: "sum", field: "data.items" },
      },
      ada.id,
    ),
  ).toEqual({
    ok: true,
    values: { all: 7, recent: 6, kindA: 5, items: 9.5, sources: 3, none: 0 },
  });
  // A sum past the exact integer range has no total.
  const big = await pb.user();
  await pb.event(big.id, "big", { n: Number.MAX_SAFE_INTEGER }, at(NOW - day));
  await pb.event(big.id, "big", { n: 1 }, at(NOW - day));
  expect(await totals({ n: { event: "big", fn: "sum", field: "data.n" } }, big.id)).toEqual({
    ok: false,
    limit: true,
  });
});

test("AGGREGATE_LIMIT: a window over the limit has no total, whatever where keeps", async () => {
  const ada = await pb.user();
  await manyEvents(pb, ada.id, "view", AGGREGATE_LIMIT, (i) => ({
    at: new Date(NOW - day - i * 1000),
    data: { hit: i === 0 },
  }));
  const aggregates: Record<string, Aggregate> = {
    views: { event: "view", fn: "count" },
    hits: { event: "view", where: { "data.hit": true }, fn: "count" },
  };
  expect(await totals(aggregates, ada.id)).toEqual({
    ok: true,
    values: { views: AGGREGATE_LIMIT, hits: 1 },
  });
  await pb.event(ada.id, "view", { hit: false }, at(NOW - 2 * day));
  expect(await totals(aggregates, ada.id)).toEqual({ ok: false, limit: true });
  // A window bounded by since stays under the limit: an hour holds 3,600 of the records a second apart.
  expect(
    await totals({ recent: { event: "view", since: "PT1H", fn: "count" } }, ada.id, NOW - day + 1),
  ).toEqual({ ok: true, values: { recent: 3600 } });
});

test("SCAN_LIMIT: a where window of exactly the limit is read whole and decides; one more record does not (B155e, D180)", async () => {
  const ada = await pb.user();
  // `data.b = true` is loose in the filter: it keeps every `1`, which the strict check then refuses,
  // so the count reads the whole window and matches nothing.
  await manyEvents(pb, ada.id, "scan", SCAN_LIMIT, (i) => ({
    at: new Date(NOW - day - i * 1000),
    data: { b: 1 },
  }));
  const condition = { event: "scan", where: { "data.b": true } };
  expect(await holds(condition, ada.id)).toBe(false);
  expect(await holds({ not: condition }, ada.id)).toBe(true);
  // A further record, even one sharing the newest record's instant, is a page the scan never read.
  await pb.event(ada.id, "scan", { b: 1 }, at(NOW - day));
  const result = await evaluateOnSource(
    condition,
    { externalId: ada.id, now: new Date(NOW) },
    { source: adapter(pb) },
  );
  expect(result).toMatchObject({ ok: false, error: { kind: "source_permanent" } });
});

test("step windows end at now plus the ahead tolerance of a pushed event (B155e, D180)", async () => {
  const ada = await pb.user();
  await pb.event(ada.id, "renewal", { n: 1 }, at(NOW + 14 * 60_000));
  await pb.event(ada.id, "renewal", { n: 10 }, at(NOW + 16 * 60_000));
  await pb.event(ada.id, "renewal", { n: 100 }, at(NOW + 365 * day));
  // Within 15 minutes ahead counts, as a pushed event's `occurred_at` is accepted; further does not.
  expect(await holds({ event: "renewal", count: { eq: 1 } }, ada.id)).toBe(true);
  expect(
    await holds({ event: "renewal", where: { "data.n": 100 } }, ada.id, {
      now: new Date(NOW + 365 * day - 15 * 60_000),
    }),
  ).toBe(true);
  expect(
    await totals(
      {
        count: { event: "renewal", fn: "count" },
        sum: { event: "renewal", fn: "sum", field: "data.n" },
      },
      ada.id,
    ),
  ).toEqual({ ok: true, values: { count: 1, sum: 1 } });
  expect(
    await totals({ sum: { event: "renewal", fn: "sum", field: "data.n" } }, ada.id, NOW + 2 * day),
  ).toEqual({ ok: true, values: { sum: 11 } });
});

test("trigger.condition counts the trigger record and ends at it", async () => {
  const source = adapter(pb);
  const ada = await pb.user();
  const trigger = NOW - 5 * day;
  await pb.event(ada.id, "order_paid", { product: "prepaid" }, at(trigger - 100 * day));
  await pb.event(ada.id, "order_paid", { product: "subscription" }, at(trigger - 10 * day));
  await pb.event(ada.id, "order_paid", { product: "prepaid" }, at(trigger));
  // Records after the trigger are outside its window.
  await pb.event(ada.id, "order_paid", { product: "prepaid" }, at(trigger + 3_600_000));
  const record = { occurredAt: new Date(trigger) };
  expect(
    await evaluateTriggerCondition(source, prepaid("P180D", { gte: 2 }), ada.id, record),
  ).toEqual({
    ok: true,
    value: true,
  });
  expect(
    await evaluateTriggerCondition(source, prepaid("P180D", { eq: 2 }), ada.id, record),
  ).toEqual({
    ok: true,
    value: true,
  });
  // Durations count back from the record, not from now.
  expect(
    await evaluateTriggerCondition(source, prepaid("P30D", { gte: 2 }), ada.id, record),
  ).toEqual({
    ok: true,
    value: false,
  });
  expect(
    await evaluateTriggerCondition(
      source,
      { event: "order_paid", count: { eq: 3 } },
      ada.id,
      record,
    ),
  ).toEqual({ ok: true, value: true });
  expect(
    await evaluateTriggerCondition(
      source,
      { all: [prepaid("P180D", { gte: 2 }), { recipient: "optOut", op: "eq", value: false }] },
      ada.id,
      record,
    ),
  ).toEqual({ ok: true, value: true });
  // A condition the trigger cannot hold (local or `since: trigger`) is permanent.
  for (const invalid of [
    { attr: "plan", op: "eq", value: "x" },
    { event: "order_paid", since: "trigger" },
    { sql: "1 = 1" },
  ]) {
    expect(await evaluateTriggerCondition(source, invalid, ada.id, record)).toMatchObject({
      ok: false,
      kind: "permanent",
    });
  }
});

test("a stopped source is transient, a renamed field permanent, a user without ID permanent", async () => {
  const own = await startPocketBase();
  try {
    const source = adapter(own);
    const ada = await own.user();
    await own.event(ada.id, "order_paid", { plan: "x" }, at(NOW - day));
    const condition: Condition = { event: "order_paid", where: { "data.plan": "x" } };
    const run = (externalId: string | null) =>
      evaluateOnSource(condition, { externalId, now: new Date(NOW) }, { source });
    expect(await run(ada.id)).toEqual({ ok: true, value: true });
    expect(await run(null)).toMatchObject({ ok: false, error: { kind: "source_permanent" } });
    await own.renameField("events", "data", "payload");
    expect(await run(ada.id)).toMatchObject({ ok: false, error: { kind: "source_permanent" } });
    expect(
      await aggregateOnSource(
        { n: { event: "order_paid", fn: "count" } },
        { externalId: ada.id, now: new Date(NOW) },
        { source },
      ),
    ).toMatchObject({ ok: false, error: { kind: "source_permanent" } });
    await own.renameField("events", "payload", "data");
    await own.stop();
    expect(await run(ada.id)).toMatchObject({ ok: false, error: { kind: "source_transient" } });
    expect(
      await evaluateTriggerCondition(source, condition, ada.id, { occurredAt: new Date(NOW) }),
    ).toMatchObject({ ok: false, kind: "transient" });
  } finally {
    await own.close();
  }
});
