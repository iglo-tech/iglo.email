// Validation of the sequence condition language (docs/design/05-sequences.md#conditions).
import { describe, expect, test } from "bun:test";
import { limits } from "@/conditions/types";
import { validate } from "@/conditions/validate";

const ok = (condition: unknown, canUseSql = false) => {
  const result = validate(condition, { canUseSql });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.condition;
};
const errors = (condition: unknown, canUseSql = false, field?: string) => {
  const result = validate(condition, { canUseSql, ...(field ? { field } : {}) });
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};
const fields = (condition: unknown, canUseSql = false) =>
  errors(condition, canUseSql).map((e) => e.field);

describe("accepted shapes", () => {
  test("every documented example validates and is returned as a copy", () => {
    const examples = [
      { all: [{ attr: "plan", op: "eq", value: "subscription" }] },
      { any: [{ list: 3, status: ["confirmed", "unconfirmed"] }] },
      { not: { event: "download_finished", since: "trigger" } },
      {
        event: "download_finished",
        since: "trigger",
        where: { "data.source": "mcp" },
        count: { gte: 1 },
      },
      { attr: "plan", op: "eq", value: "subscription" },
      { list: 3, status: ["confirmed", "unconfirmed"] },
    ];
    for (const example of examples) {
      const copy = ok(example);
      expect(copy).toEqual(example as never);
      expect(copy).not.toBe(example as never);
    }
    const sql = { sql: "json_extract(subscribers.attribs, '$.credits_left') < 100" };
    expect(ok(sql, true)).toEqual(sql);
  });

  test("every op, since form, count comparator and list status", () => {
    for (const op of ["eq", "ne", "gt", "gte", "lt", "lte"]) {
      ok({ attr: "n", op, value: 1 });
      ok({ attr: "n", op, value: "x" });
    }
    ok({ attr: "flag", op: "eq", value: true });
    ok({ attr: "flag", op: "ne", value: false });
    ok({ attr: "n", op: "in", value: [1, "a", true] });
    ok({ attr: "n", op: "exists" });
    ok({ attr: "status", op: "eq", value: "enabled" });
    ok({ attr: "status", op: "ne", value: "blocklisted" });
    ok({ attr: "status", op: "in", value: ["enabled", "disabled"] });
    for (const since of ["trigger", "enrollment", "last_step", "P30D", "PT0S", "P1W", "PT1H30M"])
      ok({ event: "e", since });
    ok({ event: "e", count: { gte: 0 } });
    ok({ event: "e", count: { lte: 3 } });
    ok({ event: "e", count: { eq: 2 } });
    ok({ event: "e", count: { gte: 1, lte: limits.count } });
    ok({ list: 1 });
    ok({ list: 1, status: ["unsubscribed"] });
    ok({ attr: "address.city", op: "eq", value: "Kraków" });
    ok({ attr: "zażółć_gęślą-1", op: "exists" });
    ok({ event: "e", where: { "data.a.b": 1, "data.c": "x", "data.d": false } });
  });
});

describe("rejected shapes", () => {
  test("non-objects and unknown or missing discriminators", () => {
    for (const value of [null, 1, "x", [], true, undefined])
      expect(fields(value)).toEqual(["condition"]);
    expect(fields({})).toEqual(["condition"]);
    expect(fields({ attr: "a", op: "exists", event: "e" })).toEqual(["condition"]);
    expect(fields({ attr: "a", op: "exists", extra: 1 })).toEqual(["condition.extra"]);
    expect(fields({ list: 1, "hostile key; DROP TABLE": 1 })).toEqual(["condition"]);
  });

  test("combinators", () => {
    expect(fields({ all: [] })).toEqual(["condition.all"]);
    expect(fields({ any: {} })).toEqual(["condition.any"]);
    expect(fields({ not: [] })).toEqual(["condition.not"]);
    expect(fields({ all: [{ attr: "a", op: "exists" }, { attr: "a" }] })).toEqual([
      "condition.all.1.op",
    ]);
    expect(fields({ not: { any: [{ list: 0 }] } })).toEqual(["condition.not.any.0.list"]);
  });

  test("attribute comparisons", () => {
    expect(fields({ attr: "a", op: "like", value: "x" })).toEqual(["condition.op"]);
    expect(fields({ attr: "a", op: "eq" })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "eq", value: null })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "eq", value: { x: 1 } })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "eq", value: [1] })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "eq", value: Number.NaN })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "gt", value: Infinity })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "gt", value: true })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "exists", value: 1 })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "in", value: [] })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "in", value: "x" })).toEqual(["condition.value"]);
    expect(fields({ attr: "a", op: "in", value: [1, null] })).toEqual(["condition.value.1"]);
    expect(fields({ attr: "a", op: "eq", value: "x".repeat(limits.stringBytes + 1) })).toEqual([
      "condition.value",
    ]);
    expect(fields({ attr: "status", op: "eq", value: "deleted" })).toEqual(["condition.value"]);
    expect(fields({ attr: "status", op: "gt", value: "enabled" })).toEqual(["condition.op"]);
    expect(fields({ attr: "status", op: "exists" })).toEqual(["condition.op"]);
    expect(fields({ attr: "status", op: "in", value: ["enabled", 1] })).toEqual([
      "condition.value.1",
    ]);
  });

  test("odd attribute and data paths", () => {
    const paths = [
      "",
      ".",
      "a.",
      ".a",
      "a..b",
      "$.a",
      'a"b',
      "a'b",
      "a[0]",
      "a b",
      "a\u0000b",
      "a\nb",
      "a*",
      "a.b.c.d.e.f.g.h.i",
      "x".repeat(limits.segmentLength + 1),
      "\ud800",
      "a)--",
      7,
      null,
    ];
    for (const path of paths) {
      expect(fields({ attr: path, op: "exists" })).toEqual(["condition.attr"]);
      if (typeof path === "string")
        expect(fields({ event: "e", where: { [`data.${path}`]: 1 } })).toEqual(["condition.where"]);
    }
    expect(fields({ event: "e", where: { product: "x" } })).toEqual(["condition.where"]);
    expect(fields({ event: "e", where: { data: "x" } })).toEqual(["condition.where"]);
    expect(fields({ event: "e", where: { "data.a": null } })).toEqual(["condition.where.data.a"]);
    expect(fields({ event: "e", where: { "data.a": [1] } })).toEqual(["condition.where.data.a"]);
    expect(fields({ event: "e", where: [] })).toEqual(["condition.where"]);
    expect(fields({ event: "e", where: {} })).toEqual(["condition.where"]);
    const many = Object.fromEntries(
      Array.from({ length: limits.whereFields + 1 }, (_, i) => [`data.k${i}`, i]),
    );
    expect(fields({ event: "e", where: many })).toEqual(["condition.where"]);
  });

  test("events: name, since and count", () => {
    for (const name of ["", 1, null, "a\u0001", "x".repeat(limits.eventNameBytes + 1), "\udc00"])
      expect(fields({ event: name })).toEqual(["condition.event"]);
    for (const since of [
      "",
      "now",
      "P",
      "PT",
      "P1Y",
      "P1M",
      "P1.5D",
      "P-1D",
      "p1d",
      "P1DT",
      " P1D",
      "P1D ",
      "2026-01-01T00:00:00Z",
      `P${limits.durationDays + 1}D`,
      "P9999999999D",
      1,
      null,
    ])
      expect(fields({ event: "e", since })).toEqual(["condition.since"]);
    for (const count of [{}, [], 1, { gt: 1 }, { gte: -1 }, { gte: 1.5 }, { eq: "1" }])
      expect(fields({ event: "e", count }).length).toBeGreaterThan(0);
    expect(fields({ event: "e", count: { gte: limits.count + 1 } })).toEqual([
      "condition.count.gte",
    ]);
    expect(fields({ event: "e", count: { gt: 1 } })).toEqual(["condition.count.gt"]);
  });

  test("lists", () => {
    for (const list of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2])
      expect(fields({ list })).toEqual(["condition.list"]);
    expect(fields({ list: 1, status: [] })).toEqual(["condition.status"]);
    expect(fields({ list: 1, status: "confirmed" })).toEqual(["condition.status"]);
    expect(fields({ list: 1, status: ["confirmed", "maybe"] })).toEqual(["condition.status.1"]);
    expect(
      fields({ list: 1, status: ["confirmed", "confirmed", "confirmed", "confirmed"] }),
    ).toEqual(["condition.status"]);
  });

  test("sql needs the permission and M1.7's fragment checks", () => {
    const fragment = "subscribers.name = 'x'";
    expect(errors({ sql: fragment })).toEqual([
      { field: "condition.sql", message: "permission denied for raw SQL conditions" },
    ]);
    expect(fields({ all: [{ attr: "a", op: "exists" }, { sql: fragment }] })).toEqual([
      "condition.all.1.sql",
    ]);
    for (const sql of [
      "",
      "   ",
      "1); DELETE FROM subscribers; --",
      "1 -- comment",
      "1 /* x */",
      "1) OR (1",
      "'unterminated",
      "a\u0000",
      1,
      "x".repeat(limits.sqlLength + 1),
    ])
      expect(fields({ sql }, true)).toEqual(["condition.sql"]);
    ok({ sql: "subscribers.name = 'x';" }, true);
    const many = Array.from({ length: limits.sqlPredicates + 1 }, () => ({ sql: "1 = 1" }));
    expect(fields({ all: many }, true)).toEqual([`condition.all.${limits.sqlPredicates}.sql`]);
  });
});

describe("numbers are exactly comparable", () => {
  const unsafe = 1000000000000000100;
  const message = "number must be a safe integer (within ±9007199254740991) or a finite fraction";
  const refused = (condition: unknown, field: string) =>
    expect(validate(condition, { canUseSql: false })).toEqual({
      ok: false,
      errors: [{ field, message }],
    });

  test("integers beyond the safe range are refused in every comparison", () => {
    for (const op of ["eq", "ne", "lt", "lte", "gt", "gte"])
      refused({ attr: "invoice_id", op, value: unsafe }, "condition.value");
    refused({ attr: "n", op: "eq", value: -unsafe }, "condition.value");
    refused({ attr: "n", op: "eq", value: 2 ** 53 }, "condition.value");
    refused({ attr: "n", op: "gt", value: 1e300 }, "condition.value");
    refused({ attr: "invoice_id", op: "in", value: [1, unsafe] }, "condition.value.1");
    refused(
      { event: "invoice_paid", where: { "data.invoice_id": unsafe } },
      "condition.where.data.invoice_id",
    );
    refused({ not: { attr: "n", op: "eq", value: unsafe } }, "condition.not.value");
  });

  test("safe integers, their edges, zero, negatives and fractions are accepted", () => {
    for (const value of [
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      0,
      -0,
      -1,
      0.1,
      -1.5,
      1e-300,
      123456789.125,
      4503599627370495.5,
    ]) {
      ok({ attr: "n", op: "eq", value });
      ok({ attr: "n", op: "in", value: [value] });
      ok({ event: "e", where: { "data.n": value } });
    }
  });
});

describe("hostile input stays bounded", () => {
  test("deep nesting is refused at the depth limit without recursing further", () => {
    let deep: unknown = { attr: "a", op: "exists" };
    for (let i = 0; i < 100_000; i++) deep = { not: deep };
    const result = errors(deep);
    expect(result).toHaveLength(1);
    expect(result[0]!.message).toBe("nesting is too deep");
    expect(result[0]!.field.split(".").length).toBe(limits.depth + 1);

    let ok9: unknown = { attr: "a", op: "exists" };
    for (let i = 1; i < limits.depth; i++) ok9 = { not: ok9 };
    ok(ok9);
    expect(fields({ not: ok9 })[0]!.split(".").length).toBe(limits.depth + 1);
  });

  test("huge arrays and node counts are refused before they are walked", () => {
    const leaf = { attr: "a", op: "exists" };
    expect(errors({ any: Array.from({ length: 1_000_000 }, () => leaf) })).toEqual([
      { field: "condition.any", message: "too many conditions" },
    ]);
    expect(fields({ attr: "a", op: "in", value: Array(limits.inValues + 1).fill(1) })).toEqual([
      "condition.value",
    ]);
    ok({ attr: "a", op: "in", value: Array(limits.inValues).fill("v") });
    const wide = { all: Array.from({ length: 8 }, () => ({ all: Array(8).fill(leaf) })) };
    expect(errors(wide)[0]!.message).toBe("too many conditions");
    ok({ all: Array.from({ length: 7 }, () => ({ all: Array(8).fill(leaf) })) });
  });

  test("errors are capped and never echo input", () => {
    const bad = { any: Array.from({ length: 60 }, () => ({ attr: "a", op: "<script>" })) };
    const result = errors(bad);
    expect(result).toHaveLength(limits.errors);
    for (const e of result) expect(JSON.stringify(e)).not.toContain("<script>");
  });

  test("prototype keys and accessors are plain data", () => {
    const parsed = JSON.parse('{"__proto__": {"attr": "a"}, "attr": "x", "op": "exists"}');
    expect(fields(parsed)).toEqual(["condition.__proto__"]);
    const proto = ok({ attr: "__proto__", op: "eq", value: "constructor" });
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(ok({ event: "e", where: JSON.parse('{"data.__proto__": 1}') })).toEqual({
      event: "e",
      where: JSON.parse('{"data.__proto__": 1}'),
    });
  });

  test("the root field name is configurable", () => {
    expect(errors({ list: 0 }, false, "steps.1.condition")[0]!.field).toBe(
      "steps.1.condition.list",
    );
  });
});
