// The contract's verdicts are only as good as this validator, so it is held to refusing.
import { expect, test } from "bun:test";
import { validate, type Document } from "@/test/openapi/schema";

const document: Document = {
  paths: {},
  components: {
    responses: {},
    schemas: {
      Item: {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: ["string", "null"] } },
        required: ["id"],
      },
    },
  },
};
const item = { $ref: "#/components/schemas/Item" };

test("accepts what fits", () => {
  expect(validate(document, item, { id: 1, name: null })).toEqual([]);
  expect(validate(document, { type: "array", items: item }, [{ id: 1 }])).toEqual([]);
  expect(validate(document, { anyOf: [item, { type: "null" }] }, null)).toEqual([]);
});

test.each([
  ["a wrong type", { type: "string" }, 1],
  ["a fraction for an integer", { type: "integer" }, 1.5],
  ["a value outside the enum", { type: "string", enum: ["a"] }, "b"],
  ["a different constant", { const: true }, false],
  ["a missing required field", item, { name: "x" }],
  ["a field the document leaves out", item, { id: 1, extra: true }],
  ["a bad item", { type: "array", items: item }, [{ id: "1" }]],
  ["a bad date-time", { type: "string", format: "date-time" }, "yesterday"],
  ["a bad UUID", { type: "string", format: "uuid" }, "x"],
  ["no branch of anyOf", { anyOf: [{ type: "string" }, { type: "null" }] }, 1],
  ["two branches of oneOf", { oneOf: [{ type: "integer" }, { type: "number" }] }, 1],
  ["too many items", { type: "array", maxItems: 0 }, [1]],
  ["a false schema", false, 1],
])("refuses %s", (_, schema, value) => {
  expect(validate(document, schema, value)).not.toEqual([]);
});

test("additionalProperties opts in, and is itself checked", () => {
  const free = { type: "object", additionalProperties: { type: "integer" } };
  expect(validate(document, free, { a: 1 })).toEqual([]);
  expect(validate(document, free, { a: "1" })).not.toEqual([]);
});

test("a keyword or format it does not know fails instead of passing", () => {
  expect(() => validate(document, { nullable: true }, 1)).toThrow("Unknown schema keyword");
  expect(() => validate(document, { type: "string", format: "x" }, "a")).toThrow("Unknown format");
  expect(() => validate(document, { $ref: "#/components/schemas/Nope" }, 1)).toThrow("Unresolved");
});
