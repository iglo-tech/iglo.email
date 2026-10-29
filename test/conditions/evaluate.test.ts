// Evaluation of sequence conditions against a synthetic database
// (docs/design/05-sequences.md#conditions).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { compile } from "@/conditions/compile";
import { createConditionEvaluator } from "@/conditions/evaluate";
import type { ConditionContext } from "@/conditions/types";
import { validate } from "@/conditions/validate";
import {
  conditionsFixture,
  type ConditionsFixture,
  type ModelSubscriber,
} from "@/test/conditions/fixture";

let f: ConditionsFixture;
let rich: ModelSubscriber, bare: ModelSubscriber, disabled: ModelSubscriber;
let listA: number, listB: number;
const day = 86_400_000;
let now: Date;
let context: (subscriber: ModelSubscriber, extra?: Partial<ConditionContext>) => ConditionContext;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const value = async (condition: unknown, ctx: ConditionContext) => {
  const result = await f.evaluator.evaluate(condition, ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const failure = async (condition: unknown, ctx: ConditionContext) => {
  const result = await f.evaluator.evaluate(condition, ctx);
  if (result.ok) throw new Error(`expected an error, got ${result.value}`);
  return result.error;
};

function children(): number {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (
        new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(
          readFileSync(`/proc/${entry}/status`, "utf8"),
        )
      )
        count++;
    } catch {
      /* exited meanwhile */
    }
  }
  return count;
}

beforeAll(async () => {
  f = await conditionsFixture({ timeoutMs: 1_500, memoryBytes: 128 * 1024 * 1024 });
  now = f.clock.now();
  listA = f.addList("a");
  listB = f.addList("b");
  rich = f.addSubscriber({
    attribs: {
      plan: "subscription",
      n: 5,
      f: 1.5,
      flag: true,
      off: false,
      nul: null,
      s5: "5",
      one: 1,
      arr: [1, 2],
      obj: { city: "Kraków", zip: "00-001", deep: { x: 1 } },
      zażółć: "tak",
      quote: `O'Brien "x"`,
      inj: "' OR 1=1 --",
      status: "disabled",
      empty: "",
      e: "é",
    },
    lists: [
      { list: listA, status: "confirmed" },
      { list: listB, status: "unsubscribed" },
    ],
  });
  bare = f.addSubscriber({ attribs: {} });
  disabled = f.addSubscriber({ status: "disabled", attribs: { plan: "free" } });
  f.addMembership(bare, listA, "unconfirmed");
  const ev = (s: ModelSubscriber, name: string, offset: number, data = {}) =>
    f.addEvent(s, name, data, at(offset));
  ev(rich, "order_paid", -3 * day, { product: "prepaid", price: 79 }); // the trigger
  ev(rich, "download_finished", -3.5 * day, { source: "web" }); // before the trigger
  ev(rich, "download_finished", -2.5 * day, { source: "mcp" }); // after trigger
  ev(rich, "download_finished", -1.5 * day, { source: "mcp", nested: { ok: true } }); // after enrollment
  ev(rich, "download_finished", -0.5 * day, { source: "web", n: 2 }); // after last step
  ev(rich, "download_finished", 1 * day, { source: "future" }); // in the future
  ev(rich, "odd' OR '1'='1", -1 * day);
  ev(disabled, "download_finished", -10 * day, { source: "mcp" });
  context = (subscriber, extra = {}) => ({
    subscriberId: subscriber.id,
    triggerAt: at(-3 * day),
    enrolledAt: new Date(now.getTime() - 2 * day),
    lastStepAt: at(-1 * day),
    now,
    ...extra,
  });
});
afterAll(async () => {
  await f.close();
});

describe("attribute comparisons and type rules", () => {
  const attr = (path: string, op: string, v?: unknown) =>
    v === undefined ? { attr: path, op } : { attr: path, op, value: v };
  const cases: [unknown, boolean][] = [
    [attr("plan", "eq", "subscription"), true],
    [attr("plan", "eq", "Subscription"), false],
    [attr("plan", "ne", "free"), true],
    [attr("n", "eq", 5), true],
    [attr("n", "eq", 5.0), true],
    [attr("f", "eq", 1.5), true],
    // No coercion between JSON types.
    [attr("n", "eq", "5"), false],
    [attr("s5", "eq", 5), false],
    [attr("s5", "eq", "5"), true],
    [attr("one", "eq", true), false],
    [attr("flag", "eq", 1), false],
    [attr("flag", "eq", true), true],
    [attr("flag", "ne", true), false],
    [attr("off", "eq", false), true],
    [attr("off", "eq", 0), false],
    [attr("nul", "eq", "null"), false],
    [attr("arr", "eq", 1), false],
    [attr("obj", "eq", "Kraków"), false],
    // Missing attributes are never equal, so `ne` holds.
    [attr("missing", "eq", "x"), false],
    [attr("missing", "ne", "x"), true],
    [attr("n", "ne", "5"), true],
    // Ordering: numbers numerically, text by UTF-8 bytes, other types never.
    [attr("n", "gt", 4), true],
    [attr("n", "gt", 5), false],
    [attr("n", "gte", 5), true],
    [attr("n", "lt", 5.5), true],
    [attr("n", "lte", 4.99), false],
    [attr("f", "lt", 2), true],
    [attr("plan", "gt", "free"), true],
    [attr("plan", "lt", "free"), false],
    [attr("e", "gt", "z"), true],
    [attr("empty", "lt", "a"), true],
    [attr("s5", "gt", 1), false],
    [attr("n", "gt", "1"), false],
    [attr("missing", "gt", 0), false],
    [attr("missing", "lt", 0), false],
    [attr("flag", "gt", 0), false],
    // in: equality with any value.
    [attr("n", "in", ["5", 4, 5]), true],
    [attr("n", "in", ["5", true]), false],
    [attr("flag", "in", [false, true]), true],
    [attr("plan", "in", ["free", "subscription"]), true],
    [attr("missing", "in", ["x"]), false],
    // exists: present and not JSON null.
    [attr("plan", "exists"), true],
    [attr("empty", "exists"), true],
    [attr("off", "exists"), true],
    [attr("arr", "exists"), true],
    [attr("obj", "exists"), true],
    [attr("nul", "exists"), false],
    [attr("missing", "exists"), false],
    // Nested paths walk objects only.
    [attr("obj.city", "eq", "Kraków"), true],
    [attr("obj.deep.x", "gte", 1), true],
    [attr("obj.zip", "eq", "00-001"), true],
    [attr("obj.nope", "exists"), false],
    [attr("plan.x", "exists"), false],
    [attr("arr.0", "exists"), false],
    [attr("zażółć", "eq", "tak"), true],
    // Values are bound: quotes and SQL in values are plain text.
    [attr("quote", "eq", `O'Brien "x"`), true],
    [attr("inj", "eq", "' OR 1=1 --"), true],
    [attr("plan", "eq", "' OR 1=1 --"), false],
    [attr("plan", "eq", "subscription' OR '1'='1"), false],
    [attr("plan", "in", ["x') OR 1=1 OR ('", "y"]), false],
    // status reads the subscriber status, not an attribute named status.
    [attr("status", "eq", "enabled"), true],
    [attr("status", "ne", "enabled"), false],
    [attr("status", "in", ["disabled", "blocklisted"]), false],
  ];
  for (const [condition, expected] of cases)
    test(`${JSON.stringify(condition)} is ${expected}`, async () => {
      expect(await value(condition, context(rich))).toBe(expected);
    });

  test("status for a disabled subscriber, and attributes of an empty subscriber", async () => {
    expect(await value(attr("status", "eq", "disabled"), context(disabled))).toBe(true);
    expect(await value(attr("status", "in", ["disabled"]), context(disabled))).toBe(true);
    expect(await value(attr("plan", "exists"), context(bare))).toBe(false);
    expect(await value(attr("plan", "ne", "x"), context(bare))).toBe(true);
  });

  test("a huge in list at the limit is bound, not interpolated", async () => {
    const values = Array.from({ length: 100 }, (_, i) => `v${i}' OR '1'='1`);
    expect(await value(attr("plan", "in", values), context(rich))).toBe(false);
    expect(
      await value(attr("plan", "in", [...values.slice(1), "subscription"]), context(rich)),
    ).toBe(true);
  });
});

describe("large numbers", () => {
  let big: ModelSubscriber;
  // Stored as written: SQLite keeps the exact int64, beyond what a JavaScript number holds.
  const unsafe = 1000000000000000100;
  beforeAll(() => {
    big = f.addSubscriber({
      attribsJSON:
        '{"invoice_id":1000000000000000100,"edge":9007199254740991,"low":-9007199254740991,"over":9007199254740993,"zero":0,"frac":0.25}',
    });
    f.db
      .query(
        "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        big.id,
        "invoice_paid",
        '{"invoice_id":1000000000000000100,"edge":9007199254740991}',
        at(-1 * day),
        at(-1 * day),
      );
  });

  test("conditions comparing integers beyond the safe range are refused, not mis-evaluated", async () => {
    const conditions: unknown[] = [
      { attr: "invoice_id", op: "eq", value: unsafe },
      { attr: "invoice_id", op: "ne", value: unsafe },
      { attr: "invoice_id", op: "lt", value: unsafe },
      { attr: "invoice_id", op: "gte", value: unsafe },
      { attr: "invoice_id", op: "in", value: [unsafe] },
      { event: "invoice_paid", where: { "data.invoice_id": unsafe } },
    ];
    for (const condition of conditions) {
      const result: unknown = await f.evaluator.evaluate(condition, context(big));
      expect([condition, result]).toEqual([
        condition,
        { ok: false, error: { kind: "invalid", message: expect.stringContaining("safe integer") } },
      ]);
    }
  });

  test("safe edge integers compare exactly with stored attributes and event data", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const cases: [unknown, boolean][] = [
      [{ attr: "edge", op: "eq", value: max }, true],
      [{ attr: "edge", op: "ne", value: max }, false],
      [{ attr: "edge", op: "eq", value: max - 1 }, false],
      [{ attr: "edge", op: "gte", value: max }, true],
      [{ attr: "edge", op: "gt", value: max - 1 }, true],
      [{ attr: "edge", op: "lt", value: max }, false],
      [{ attr: "edge", op: "in", value: [1, max] }, true],
      [{ attr: "low", op: "eq", value: -max }, true],
      [{ attr: "low", op: "lt", value: -max + 1 }, true],
      // Stored integers beyond the safe range still order against safe comparands.
      [{ attr: "over", op: "gt", value: max }, true],
      [{ attr: "over", op: "eq", value: max }, false],
      [{ attr: "invoice_id", op: "gt", value: max }, true],
      [{ attr: "invoice_id", op: "lte", value: max }, false],
      [{ attr: "zero", op: "eq", value: -0 }, true],
      [{ attr: "frac", op: "eq", value: 0.25 }, true],
      [{ attr: "frac", op: "lt", value: 0.5 }, true],
      [{ event: "invoice_paid", where: { "data.edge": max } }, true],
      [{ event: "invoice_paid", where: { "data.edge": max - 1 } }, false],
    ];
    for (const [condition, expected] of cases)
      expect([condition, await value(condition, context(big))]).toEqual([condition, expected]);
  });
});

describe("event predicates", () => {
  const cases: [string, unknown, boolean][] = [
    ["any time", { event: "download_finished" }, true],
    ["unknown name", { event: "nope" }, false],
    [
      "since trigger excludes earlier events",
      { event: "download_finished", since: "trigger", count: { eq: 4 } },
      true,
    ],
    ["since trigger excludes the trigger itself", { event: "order_paid", since: "trigger" }, false],
    [
      "since enrollment",
      { event: "download_finished", since: "enrollment", count: { eq: 3 } },
      true,
    ],
    ["since last_step", { event: "download_finished", since: "last_step", count: { eq: 2 } }, true],
    [
      "since a duration back from now",
      { event: "download_finished", since: "P3D", count: { eq: 4 } },
      true,
    ],
    ["since PT13H", { event: "download_finished", since: "PT13H", count: { eq: 2 } }, true],
    ["since PT11H", { event: "download_finished", since: "PT11H", count: { eq: 1 } }, true],
    ["since P1W", { event: "download_finished", since: "P1W", count: { eq: 5 } }, true],
    [
      "since PT0S counts only future events",
      { event: "download_finished", since: "PT0S", count: { eq: 1 } },
      true,
    ],
    ["total count", { event: "download_finished", count: { eq: 5 } }, true],
    ["gte", { event: "download_finished", count: { gte: 5 } }, true],
    ["gte above", { event: "download_finished", count: { gte: 6 } }, false],
    ["gte 0 always", { event: "nope", count: { gte: 0 } }, true],
    ["lte", { event: "download_finished", count: { lte: 5 } }, true],
    ["lte below", { event: "download_finished", count: { lte: 4 } }, false],
    ["eq 0 for no events", { event: "nope", count: { eq: 0 } }, true],
    ["range", { event: "download_finished", count: { gte: 2, lte: 5 } }, true],
    ["empty range", { event: "download_finished", count: { gte: 2, lte: 1 } }, false],
    [
      "where",
      { event: "download_finished", where: { "data.source": "mcp" }, count: { eq: 2 } },
      true,
    ],
    [
      "where since",
      {
        event: "download_finished",
        since: "enrollment",
        where: { "data.source": "mcp" },
        count: { eq: 1 },
      },
      true,
    ],
    ["where nested", { event: "download_finished", where: { "data.nested.ok": true } }, true],
    ["where number", { event: "download_finished", where: { "data.n": 2 } }, true],
    ["where number vs text", { event: "download_finished", where: { "data.n": "2" } }, false],
    [
      "where all fields",
      { event: "download_finished", where: { "data.source": "web", "data.n": 2 } },
      true,
    ],
    [
      "where all fields mismatch",
      { event: "download_finished", where: { "data.source": "mcp", "data.n": 2 } },
      false,
    ],
    [
      "where injection",
      { event: "download_finished", where: { "data.source": "x' OR '1'='1" } },
      false,
    ],
    ["name injection is an ordinary name", { event: "odd' OR '1'='1" }, true],
    ["name injection does not match others", { event: "x' OR name <> '" }, false],
    [
      "no download after the trigger",
      { not: { event: "download_finished", since: "trigger" } },
      false,
    ],
  ];
  for (const [name, condition, expected] of cases)
    test(name, async () => {
      expect(await value(condition, context(rich))).toBe(expected);
    });

  test("last_step falls back to the trigger before the first step", async () => {
    const condition = { event: "download_finished", since: "last_step", count: { eq: 4 } };
    expect(await value(condition, context(rich, { lastStepAt: null }))).toBe(true);
    const { lastStepAt: _, ...withoutLast } = context(rich);
    expect(await value(condition, withoutLast)).toBe(true);
  });

  test("events of other subscribers are never counted", async () => {
    expect(await value({ event: "download_finished" }, context(bare))).toBe(false);
    expect(await value({ event: "download_finished", since: "P1D" }, context(disabled))).toBe(
      false,
    );
    expect(await value({ event: "download_finished", since: "P11D" }, context(disabled))).toBe(
      true,
    );
  });

  test("an injected clock moves duration windows", async () => {
    const later = { ...context(rich), now: new Date(now.getTime() + 3 * day) };
    expect(await value({ event: "download_finished", since: "P1D" }, later)).toBe(false);
    expect(await value({ event: "download_finished", since: "P2D" }, later)).toBe(false);
    expect(await value({ event: "download_finished", since: "P3D" }, later)).toBe(true);
  });
});

describe("lists and combinators", () => {
  test("list membership with statuses", async () => {
    expect(await value({ list: listA }, context(rich))).toBe(true);
    expect(await value({ list: listB }, context(rich))).toBe(false);
    expect(await value({ list: listB, status: ["unsubscribed"] }, context(rich))).toBe(true);
    expect(await value({ list: listA, status: ["unconfirmed"] }, context(rich))).toBe(false);
    expect(await value({ list: listA, status: ["unconfirmed"] }, context(bare))).toBe(true);
    expect(await value({ list: listA }, context(bare))).toBe(true);
    expect(await value({ list: 999 }, context(rich))).toBe(false);
  });

  test("all, any and not, nested", async () => {
    const t = { attr: "plan", op: "exists" },
      no = { attr: "missing", op: "exists" };
    const cases: [unknown, boolean][] = [
      [{ all: [t] }, true],
      [{ all: [t, no] }, false],
      [{ any: [no, t] }, true],
      [{ any: [no, no] }, false],
      [{ not: t }, false],
      [{ not: no }, true],
      [{ not: { not: t } }, true],
      [{ all: [{ any: [no, { not: no }] }, { not: { all: [t, no] } }] }, true],
      [{ any: [{ all: [t, no] }, { not: { any: [t] } }] }, false],
    ];
    for (const [condition, expected] of cases)
      expect([condition, await value(condition, context(rich))]).toEqual([condition, expected]);
  });

  test("the worked example: prepaid without a download", async () => {
    const condition = {
      all: [
        { attr: "plan", op: "ne", value: "subscription" },
        { not: { event: "download_finished", since: "trigger" } },
      ],
    };
    expect(await value(condition, context(rich))).toBe(false);
    expect(await value(condition, context(disabled))).toBe(true);
  });
});

describe("errors are returned, never thrown", () => {
  test("invalid conditions", async () => {
    expect(await failure({ attr: "a", op: "nope" }, context(rich))).toEqual({
      kind: "invalid",
      message: "condition.op: unknown operator",
    });
    let deep: unknown = { attr: "a", op: "exists" };
    for (let i = 0; i < 10_000; i++) deep = { any: [deep] };
    expect((await failure(deep, context(rich))).kind).toBe("invalid");
  });

  test("missing or invalid context times", async () => {
    const { enrolledAt: _, ...noEnrollment } = context(rich);
    expect(await failure({ event: "x", since: "enrollment" }, noEnrollment)).toEqual({
      kind: "context",
      message: "enrolledAt is required",
    });
    // A time the condition does not use is not needed.
    expect(await value({ event: "x", since: "trigger" }, noEnrollment)).toBe(false);
    const { triggerAt: __, ...noTrigger } = context(rich);
    expect(
      (await failure({ event: "x", since: "last_step" }, { ...noTrigger, lastStepAt: null })).kind,
    ).toBe("context");
    expect(
      (await failure({ event: "x", since: "trigger" }, context(rich, { triggerAt: "yesterday" })))
        .kind,
    ).toBe("context");
    expect(
      (await failure({ event: "x", since: "P1D" }, context(rich, { now: new Date(Number.NaN) })))
        .kind,
    ).toBe("context");
    expect(
      (await failure({ event: "x" }, context(rich, { now: new Date("+020000-01-01T00:00:00Z") })))
        .kind,
    ).toBe("context");
    expect((await failure({ event: "x" }, context(rich, { subscriberId: 1.5 }))).kind).toBe(
      "context",
    );
  });

  test("a missing subscriber", async () => {
    expect(
      await failure({ attr: "a", op: "exists" }, context(rich, { subscriberId: 99_999n })),
    ).toEqual({
      kind: "not_found",
      message: "subscriber not found",
    });
  });

  test("a huge duration reaches before every stored event", async () => {
    const condition = { event: "download_finished", since: "P36600D", count: { eq: 5 } };
    expect(await value(condition, context(rich))).toBe(true);
  });
});

describe("compilation", () => {
  test("one parameterized statement; values never appear in the SQL text", () => {
    const marker = "zz' OR '1'='1 marker";
    const checked = validate(
      {
        all: [
          { attr: "plan", op: "eq", value: marker },
          { attr: "plan", op: "in", value: [marker, 12345.678] },
          { event: marker, since: "P3D", where: { "data.source": marker }, count: { lte: 987 } },
          { list: 424242, status: ["confirmed"] },
        ],
      },
      { canUseSql: false },
    );
    if (!checked.ok) throw new Error("invalid");
    const compiled = compile(checked.condition);
    expect(compiled.sql.split(";").length).toBe(1);
    for (const literal of ["marker", "12345", "987", "424242", "confirmed", "P3D", "source"])
      expect(compiled.sql).not.toContain(literal);
    expect(compiled.fragments).toEqual([]);
  });
});

describe("the sql escape hatch", () => {
  const credits = "json_extract(subscribers.attribs, '$.n') < 100";
  test("runs through the read-only child and combines with other predicates", async () => {
    expect(await value({ sql: credits }, context(rich))).toBe(true);
    expect(await value({ sql: credits }, context(bare))).toBe(false);
    expect(await value({ not: { sql: credits } }, context(bare))).toBe(true);
    expect(
      await value(
        {
          all: [
            { sql: credits },
            { sql: "subscribers.status = 'enabled'" },
            { event: "download_finished", since: "trigger" },
          ],
        },
        context(rich),
      ),
    ).toBe(true);
    expect(
      await value(
        { any: [{ sql: "1 = 0" }, { attr: "plan", op: "eq", value: "free" }] },
        context(disabled),
      ),
    ).toBe(true);
    // The fragment sees the subscriber_lists join as segment queries do.
    expect(await value({ sql: "subscriber_lists.list_id IS NULL" }, context(rich))).toBe(true);
    expect((await failure({ sql: credits }, context(rich, { subscriberId: 99_999n }))).kind).toBe(
      "not_found",
    );
  });

  test("conditions without sql never start a child", async () => {
    let calls = 0;
    const counted = {
      ...f.runner,
      all: (statements: Parameters<typeof f.runner.all>[0]) => {
        calls++;
        return f.runner.all(statements);
      },
      run: (...args: Parameters<typeof f.runner.run>) => {
        calls++;
        return f.runner.run(...args);
      },
      condition: (statement: Parameters<typeof f.runner.condition>[0]) => {
        calls++;
        return f.runner.condition(statement);
      },
    };
    const evaluator = createConditionEvaluator({ readonly: f.readonly, runner: counted });
    try {
      for (const condition of [
        { attr: "plan", op: "exists" },
        { event: "download_finished", since: "trigger" },
        { list: listA },
        { not: { any: [{ list: listB }, { attr: "status", op: "eq", value: "enabled" }] } },
      ])
        expect((await evaluator.evaluate(condition, context(rich))).ok).toBe(true);
      expect(calls).toBe(0);
      expect((await evaluator.evaluate({ sql: "1 = 1" }, context(rich))).ok).toBe(true);
      expect(calls).toBe(1);
    } finally {
      evaluator.close();
    }
  });

  test("a mixed condition reads one snapshot when an update commits during evaluation", async () => {
    // Neither state satisfies the condition: low credits on a trial, then high credits when paid.
    const payer = f.addSubscriber({ attribs: { plan: "trial", credits: 0 } });
    const upgrade = () =>
      f.db
        .query("UPDATE subscribers SET attribs = ? WHERE id = ?")
        .run(JSON.stringify({ plan: "paid", credits: 100 }), payer.id);
    // The update commits as soon as the child has answered, before anything else is read.
    const interleaved = {
      all: async (statements: Parameters<typeof f.runner.all>[0]) => {
        const results = await f.runner.all(statements);
        upgrade();
        return results;
      },
      condition: async (statement: Parameters<typeof f.runner.condition>[0]) => {
        const results = await f.runner.condition(statement);
        upgrade();
        return results;
      },
    };
    const evaluator = createConditionEvaluator({ readonly: f.readonly, runner: interleaved });
    const condition = {
      all: [
        { sql: "json_extract(subscribers.attribs, '$.credits') < 10" },
        { attr: "plan", op: "eq", value: "paid" },
      ],
    };
    try {
      expect(await value(condition, context(payer))).toBe(false);
      expect(await evaluator.evaluate(condition, context(payer))).toEqual({
        ok: true,
        value: false,
      });
      expect(await value(condition, context(payer))).toBe(false);
    } finally {
      evaluator.close();
    }
  });

  test("fragments bind no parameters of the generated query", async () => {
    for (const sql of ["subscribers.id = ?1", "subscribers.id = :id", "subscribers.id = ?"])
      expect([sql, (await failure({ sql }, context(rich))).kind]).toEqual([sql, "query"]);
  });

  test("refused fragments and tables", async () => {
    expect((await failure({ sql: "1); DELETE FROM subscribers; --" }, context(rich))).kind).toBe(
      "invalid",
    );
    for (const sql of [
      "(SELECT count(*) FROM users) > 0",
      "(SELECT count(*) FROM events) > 0",
      "(SELECT count(*) FROM sqlite_schema) > 0",
      "(SELECT count(*) FROM pragma_table_list) > 0",
      "no_such_column = 1",
    ])
      expect([sql, (await failure({ sql }, context(rich))).kind]).toEqual([sql, "query"]);
    // Writes are impossible: the subscriber is unchanged.
    expect(await value({ attr: "plan", op: "eq", value: "subscription" }, context(rich))).toBe(
      true,
    );
  });

  test("time and memory limits are safe errors and leave no child running", async () => {
    const before = children();
    const spin =
      "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0";
    const started = performance.now();
    expect(
      await failure({ all: [{ attr: "plan", op: "exists" }, { sql: spin }] }, context(rich)),
    ).toEqual({
      kind: "timeout",
      message: "query timed out",
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await failure({ sql: "length(randomblob(1000000000)) > 0" }, context(rich))).toEqual({
      kind: "memory",
      message: "query exceeded the memory limit",
    });
    expect(children()).toBe(before);
  });

  test("busy slots are a safe error", async () => {
    const spin =
      "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0";
    const running = [
      f.evaluator.evaluate({ sql: spin }, context(rich)),
      f.evaluator.evaluate({ sql: spin }, context(rich)),
    ];
    await Bun.sleep(50);
    expect(await failure({ sql: "1 = 1" }, context(rich))).toEqual({
      kind: "busy",
      message: "too many queries in progress",
    });
    for (const result of await Promise.all(running))
      expect(result).toEqual({ ok: false, error: { kind: "timeout", message: "query timed out" } });
  });
});
