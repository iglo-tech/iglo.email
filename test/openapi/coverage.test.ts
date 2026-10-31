// The document against the production composition: `bun run check` fails on a route it lacks.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDocument } from "@/openapi/document";
import { differences } from "@/openapi/differences";
import { excluded } from "@/openapi/excluded";
import { validate } from "@/test/openapi/schema";

const repository = resolve(import.meta.dir, "../..");
const document = JSON.parse(buildDocument());
const methods = ["get", "post", "put", "patch", "delete"];
const documented = Object.entries(document.paths as Record<string, object>).flatMap(
  ([path, item]) =>
    Object.keys(item)
      .filter((method) => methods.includes(method))
      .map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`),
);
const skipped = excluded.flatMap(({ routes }) => routes);
const exact = skipped.filter((route) => !route.endsWith("/*"));
const prefixes = skipped.filter((route) => route.endsWith("/*")).map((route) => route.slice(0, -1));

async function registered(): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "iglo-openapi-routes-"));
  try {
    const child = Bun.spawn(
      ["bun", "test/openapi/routes-entry.ts", "--data-dir", join(directory, "data")],
      { cwd: repository, stdout: "pipe", stderr: "pipe" },
    );
    const [text, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Route listing failed: ${errors}`);
    return (JSON.parse(text) as { method: string; path: string }[]).map(
      ({ method, path }) => `${method} ${path}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("coverage", async () => {
  const routes = await registered();

  test("the router is the production composition", () => {
    expect(routes.length).toBeGreaterThan(200);
    expect(routes).toContain("GET /api/openapi.json");
  });
  test("every route is documented or excluded", () => {
    const known = new Set([...documented, ...exact]);
    expect(routes.filter((route) => !known.has(route))).toEqual([]);
  });
  test("the document names no route that does not exist", () => {
    const real = new Set(routes);
    expect(documented.filter((route) => !real.has(route))).toEqual([]);
  });
  test("every exclusion names a route that exists, with a reason", () => {
    const real = new Set(routes);
    expect(exact.filter((route) => !real.has(route))).toEqual([]);
    for (const { reason } of excluded) expect(reason.length).toBeGreaterThan(10);
  });
  test("a route is never both documented and excluded", () => {
    const listed = new Set(documented);
    expect(exact.filter((route) => listed.has(route))).toEqual([]);
  });
  test("excluded prefixes are served outside the router", () => {
    expect(
      routes.filter((route) => prefixes.some((prefix) => route.split(" ")[1]!.startsWith(prefix))),
    ).toEqual([]);
  });
  test("every JSON API route is documented, not excluded", () => {
    expect(exact.filter((route) => / \/(api|webhooks|health)\b/.test(route))).toEqual([]);
  });
});

describe("document", () => {
  const operations = Object.entries(document.paths as Record<string, Record<string, any>>).flatMap(
    ([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({ path, method, operation })),
  );

  test("is OpenAPI 3.1 with the size the design states", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(buildDocument().length).toBeLessThan(256 * 1024);
  });
  test("is the same on every build and names no instance", () => {
    expect(buildDocument()).toBe(buildDocument());
    expect(document.servers).toEqual([{ url: "/" }]);
  });
  test("operation IDs are unique", () => {
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("each path parameter is declared", () => {
    for (const { path, operation } of operations) {
      const declared = operation.parameters
        .filter((parameter: any) => parameter.in === "path")
        .map((parameter: any) => parameter.name);
      expect(declared).toEqual([...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name!));
    }
  });
  test("each operation answers with the error envelope by default", () => {
    for (const { operation } of operations)
      expect(operation.responses.default).toEqual({ $ref: "#/components/responses/Error" });
  });
  test("every reference resolves and each schema is used", () => {
    const text = JSON.stringify(document);
    const names = new Set([...text.matchAll(/#\/components\/schemas\/(\w+)/g)].map(([, n]) => n!));
    expect([...names].filter((name) => !document.components.schemas[name])).toEqual([]);
    expect(Object.keys(document.components.schemas).filter((name) => !names.has(name))).toEqual([]);
  });
  test("every schema compiles under the fail-closed validator", () => {
    for (const name of Object.keys(document.components.schemas))
      expect(() =>
        validate(document, { $ref: `#/components/schemas/${name}` }, null),
      ).not.toThrow();
  });
  test("the error envelope is exactly a message", () => {
    expect(validate(document, { $ref: "#/components/schemas/Error" }, { message: "x" })).toEqual(
      [],
    );
    expect(
      validate(document, { $ref: "#/components/schemas/Error" }, { message: "x", code: 1 }),
    ).not.toEqual([]);
  });
});

describe("deliberate differences", () => {
  const areas = async () => {
    const text = await readFile(join(repository, "docs/design/07-api-and-ui.md"), "utf8");
    const table = text.slice(
      text.indexOf("Deliberate differences:"),
      text.indexOf("## New endpoints"),
    );
    return table
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) => line.split(" | ", 1)[0]!.slice(2).trim())
      .filter((area) => area !== "Area" && !/^-+$/.test(area));
  };

  test("every row of 07 is in the document", async () => {
    const shown = (document["x-deliberate-differences"] as { area: string }[]).map(
      ({ area }) => area,
    );
    expect(shown.sort()).toEqual((await areas()).sort());
  });
  test("each named operation selector matches something", () => {
    const named = new Set(
      Object.values(document.paths as Record<string, Record<string, any>>).flatMap((item) =>
        Object.values(item).flatMap((operation) => operation["x-differences"] ?? []),
      ),
    );
    for (const { area, applies } of differences)
      if (applies.length) expect([area, named.has(area)]).toEqual([area, true]);
  });
});
