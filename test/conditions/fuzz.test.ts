// Generated conditions agree with the in-memory reference evaluator.
// Seed: FUZZ_SEED (default below, recorded in docs/perf/M5.2-conditions.md); cases: FUZZ_CASES.
// Rerun with another seed: FUZZ_SEED=12345 bun test test/conditions/fuzz.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { validate } from "@/conditions/validate";
import {
  conditionsFixture,
  type ConditionsFixture,
  type ModelSubscriber,
} from "@/test/conditions/fixture";
import { referenceEvaluate } from "@/test/conditions/reference";

const DEFAULT_SEED = 0x5eed_0502;
const seed = Number(process.env.FUZZ_SEED ?? DEFAULT_SEED);
const cases = Number(process.env.FUZZ_CASES ?? 10_000);

// mulberry32
function prng(state: number) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(seed);
const int = (n: number) => Math.floor(random() * n);
const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
const chance = (p: number) => random() < p;

const hour = 3_600_000;
const keys = ["a", "b", "n", "s", "flag", "obj", "nul"] as const;
const nestedKeys = ["x", "y", "deep"] as const;
const strings = ["a", "b", "", "é", "z", "5", "Kraków", "' OR 1=1 --", 'q"uote', "A"];
const numbers = [0, 1, 2, 5, -1, 1.5, 100];
const scalars = [...strings, ...numbers, true, false];
const eventNames = ["e1", "e2", "e3", "x' OR '1'='1"];
const sources = ["web", "mcp", "app"];
const durations = ["PT0S", "PT1H", "PT12H", "P1D", "P3D", "P1W", "P10D", "PT90M", "P1DT6H"];
const listStatuses = ["unconfirmed", "confirmed", "unsubscribed"] as const;
const subscriberStatuses = ["enabled", "disabled", "blocklisted"] as const;

function attrValue(depth: number): unknown {
  const r = random();
  if (r < 0.5) return pick(scalars);
  if (r < 0.6) return null;
  if (r < 0.7) return [pick(scalars)];
  if (depth > 1) return pick(scalars);
  const out: Record<string, unknown> = {};
  for (const key of nestedKeys) if (chance(0.6)) out[key] = attrValue(depth + 1);
  return out;
}
const attrPaths = [...keys, "obj.x", "obj.y", "obj.deep.x", "a.x", "missing", "status"];
const dataPaths = ["data.src", "data.n", "data.obj.k", "data.missing"];

let f: ConditionsFixture;
let lists: number[];
let base: number;

function genCondition(depth: number): Record<string, unknown> {
  const leaf = depth >= 4 || chance(0.55);
  if (!leaf) {
    const kind = pick(["all", "any", "not"]);
    if (kind === "not") return { not: genCondition(depth + 1) };
    return { [kind]: Array.from({ length: 1 + int(3) }, () => genCondition(depth + 1)) };
  }
  const r = random();
  if (r < 0.45) {
    const attr = pick(attrPaths);
    if (attr === "status") {
      const op = pick(["eq", "ne", "in"]);
      return op === "in"
        ? { attr, op, value: [pick(subscriberStatuses), pick(subscriberStatuses)] }
        : { attr, op, value: pick(subscriberStatuses) };
    }
    const op = pick(["eq", "ne", "gt", "gte", "lt", "lte", "in", "exists"]);
    if (op === "exists") return { attr, op };
    if (op === "in")
      return { attr, op, value: Array.from({ length: 1 + int(4) }, () => pick(scalars)) };
    if (op === "eq" || op === "ne") return { attr, op, value: pick(scalars) };
    return { attr, op, value: chance(0.5) ? pick(strings) : pick(numbers) };
  }
  if (r < 0.85) {
    const out: Record<string, unknown> = { event: pick(eventNames) };
    if (chance(0.7)) out.since = pick(["trigger", "enrollment", "last_step", ...durations]);
    if (chance(0.35)) {
      const where: Record<string, unknown> = {};
      for (let i = 0; i < 1 + int(2); i++)
        where[pick(dataPaths)] = chance(0.6) ? pick(sources) : pick([1, 2, "1", true]);
      out.where = where;
    }
    if (chance(0.5)) {
      const count: Record<string, number> = {};
      for (const comparator of ["gte", "lte", "eq"]) if (chance(0.4)) count[comparator] = int(4);
      if (Object.keys(count).length) out.count = count;
    }
    return out;
  }
  const list = pick([...lists, 999]);
  if (chance(0.3)) return { list };
  return {
    list,
    status: Array.from({ length: 1 + int(2) }, () => pick(listStatuses)),
  };
}

beforeAll(async () => {
  f = await conditionsFixture();
  base = f.clock.now().getTime();
  lists = [f.addList("one"), f.addList("two"), f.addList("three")];
  // Times lie on an hour grid so trigger, enrollment and duration bounds hit event times exactly.
  f.db.run("BEGIN");
  for (let i = 0; i < 80; i++) {
    const attribs: Record<string, unknown> = {};
    for (const key of keys) if (chance(0.7)) attribs[key] = attrValue(0);
    const subscriber = f.addSubscriber({ attribs, status: pick(subscriberStatuses) });
    for (const list of lists)
      if (chance(0.5)) f.addMembership(subscriber, list, pick(listStatuses));
    for (let e = int(12); e > 0; e--) {
      const data: Record<string, unknown> = {};
      if (chance(0.8)) data.src = pick(sources);
      if (chance(0.5)) data.n = pick([1, 2, "1", true]);
      if (chance(0.3)) data.obj = { k: pick(sources) };
      f.addEvent(
        subscriber,
        pick(eventNames),
        data,
        new Date(base + (int(14 * 24) - 12 * 24) * hour).toISOString(),
      );
    }
  }
  f.db.run("COMMIT");
});
afterAll(async () => {
  await f.close();
});

const contextFor = (subscriber: ModelSubscriber) => {
  const trigger = base + (int(10 * 24) - 10 * 24) * hour;
  const enrolled = trigger + int(24) * hour;
  const last = chance(0.3) ? null : enrolled + int(48) * hour;
  const now = base + (chance(0.8) ? 0 : (int(96) - 48) * hour);
  return {
    subscriberId: subscriber.id,
    triggerAt: new Date(trigger).toISOString(),
    enrolledAt: new Date(enrolled),
    lastStepAt: last === null ? null : new Date(last).toISOString(),
    now: new Date(now),
  };
};

test(`generated conditions agree with the reference evaluator (seed ${seed}, ${cases} cases)`, async () => {
  const outcomes = { true: 0, false: 0 };
  for (let i = 0; i < cases; i++) {
    const condition = genCondition(0);
    const checked = validate(condition, { canUseSql: false });
    if (!checked.ok)
      throw new Error(
        `seed ${seed} case ${i}: generated condition invalid ${JSON.stringify(checked.errors)}`,
      );
    const subscriber = pick(f.subscribers);
    const context = contextFor(subscriber);
    const expected = referenceEvaluate(condition, subscriber, {
      ...context,
      enrolledAt: context.enrolledAt.toISOString(),
    });
    const actual = await f.evaluator.evaluate(condition, context);
    if (!actual.ok || actual.value !== expected)
      throw new Error(
        `seed ${seed} case ${i}: ${JSON.stringify({ condition, subscriber: subscriber.id, context, expected, actual })}`,
      );
    outcomes[String(expected) as "true" | "false"]++;
  }
  // Both outcomes are common, so agreement is not vacuous.
  expect(outcomes.true).toBeGreaterThan(cases / 10);
  expect(outcomes.false).toBeGreaterThan(cases / 10);
}, 120_000);

test(`generated conditions with sql leaves agree (seed ${seed})`, async () => {
  const fragments: Record<string, (s: ModelSubscriber) => boolean> = {
    "subscribers.status = 'enabled'": (s) => s.status === "enabled",
    "subscribers.id % 2 = 0": (s) => s.id % 2n === 0n,
  };
  for (let i = 0; i < 20; i++) {
    const condition = {
      [pick(["all", "any"])]: [genCondition(2), { sql: pick(Object.keys(fragments)) }],
    };
    const subscriber = pick(f.subscribers);
    const context = contextFor(subscriber);
    const expected = referenceEvaluate(
      condition,
      subscriber,
      { ...context, enrolledAt: context.enrolledAt.toISOString() },
      (fragment, s) => fragments[fragment]!(s),
    );
    const actual = await f.evaluator.evaluate(condition, context);
    expect([i, condition, actual]).toEqual([i, condition, { ok: true, value: expected }]);
  }
}, 60_000);
