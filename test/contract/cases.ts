// Reference: listmonk cmd/handlers.go, cmd/lists.go, internal/auth/auth.go at 6fcd95f.
import type { ContractCase, Endpoint, Expectation, VolatileField } from "@/test/contract/types";

const wire = (status: number, contentType: string | null, value: string): Expectation => ({
  status,
  contentType,
  body: { kind: "wire", value },
});
const json = (status: number, value: string) => wire(status, "application/json", `${value}\n`);
const ok = json(200, '{"data":true}');
const notFound = json(404, '{"message":"404 unknown endpoint"}');
const invalidID = json(400, '{"message":"invalid ID"}');
const badEscape = wire(400, "text/plain; charset=utf-8", "400 Bad Request");
const html404 = (
  siteName: string,
  attribution: string,
  attributionUrl: string,
  customScript: boolean,
): Expectation => ({
  status: 404,
  contentType: "text/html; charset=UTF-8",
  body: { kind: "public-404", siteName, attribution, attributionUrl, customScript },
});
const referenceHTML = html404("Mailing list", "listmonk", "https://listmonk.app", true);
const productionHTML = html404("iglo.email", "iglo.email", "https://iglo.email", false);
const css: Expectation = {
  status: 200,
  contentType: "text/css; charset=utf-8",
  body: { kind: "public-css" },
};
const staticMissing = wire(404, "text/plain; charset=utf-8", "404 page not found\n");
const staticMethod = json(405, '{"message":"Method Not Allowed"}');
const referenceAllow = { allow: "OPTIONS, GET" };
const normalAllow = { allow: "OPTIONS, GET, HEAD" };
const referenceHead = { ...wire(405, null, ""), headers: referenceAllow };
const normalHead = wire(200, "text/css; charset=utf-8", "");
const endpoint = (path: string, expect: Expectation): Endpoint => ({ path, expect });
const same = (path: string, expect: Expectation) => ({
  reference: endpoint(path, expect),
  production: endpoint(path, expect),
  fixture: endpoint(path, expect),
});
const helper = (
  id: string,
  referencePath: string,
  fixturePath: string,
  expected: Expectation,
): ContractCase => ({
  id,
  group: "staged",
  reference: endpoint(referencePath, expected),
  fixture: endpoint(fixturePath, expected),
  auth: "basic",
});
const volatile: readonly VolatileField[] = [
  { path: ["data", "id"], kind: "id", bind: "entity" },
  { path: ["data", "owner_id"], kind: "id", bind: "entity" },
  { path: ["data", "other_id"], kind: "id", bind: "other" },
  { path: ["data", "created_at"], kind: "timestamp", bind: "created" },
  { path: ["data", "created_copy"], kind: "timestamp", bind: "created" },
  { path: ["data", "updated_at"], kind: "timestamp", bind: "updated", after: "created" },
];

// Paths are explicit for each target: fixture paths exercise shared helpers and
// do not pretend that their corresponding production domain routes exist.
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const cases: readonly ContractCase[] = freeze([
  { id: "health", group: "core", ...same("/health", ok) },
  {
    id: "production-api-health-unregistered",
    group: "production-only",
    production: endpoint("/api/health", notFound),
  },
  ...(["basic", "token", "bad-token"] as const).map((auth): ContractCase => ({
    id: `protected-health-${auth}`,
    group: "staged",
    auth,
    reference: endpoint(
      "/api/health",
      auth === "bad-token" ? json(403, '{"message":"invalid API credentials"}') : ok,
    ),
    fixture: endpoint(
      "/api/health",
      auth === "bad-token" ? json(403, '{"message":"invalid API credentials"}') : ok,
    ),
  })),
  { id: "unknown-api", group: "core", ...same("/api/does-not-exist", notFound) },
  {
    id: "unknown-api-head",
    group: "core",
    method: "HEAD",
    ...same("/api/does-not-exist", wire(404, null, "")),
  },
  {
    id: "unknown-api-post",
    group: "core",
    method: "POST",
    ...same("/api/does-not-exist", notFound),
  },
  {
    id: "health-head",
    group: "core",
    method: "HEAD",
    ...same("/health", wire(404, "text/html; charset=UTF-8", "")),
  },
  {
    id: "health-post-html",
    group: "core",
    method: "POST",
    reference: endpoint("/health", referenceHTML),
    production: endpoint("/health", productionHTML),
    fixture: endpoint("/health", productionHTML),
  },
  {
    id: "missing-public-html",
    group: "core",
    reference: endpoint("/missing-public-page", referenceHTML),
    production: endpoint("/missing-public-page", productionHTML),
    fixture: endpoint("/missing-public-page", productionHTML),
  },
  {
    id: "missing-public-head",
    group: "core",
    method: "HEAD",
    ...same("/missing-public-page", wire(404, "text/html; charset=UTF-8", "")),
  },
  { id: "public-style", group: "core", ...same("/public/static/style.css", css) },
  ...["%73tyle.css", "style%2ecss", "/style.css"].map((spelling, index): ContractCase => ({
    id: `public-style-equivalent-${index + 1}`,
    group: "core",
    ...same(`/public/static/${spelling}`, css),
  })),
  {
    id: "missing-public-asset",
    group: "core",
    ...same("/public/static/no-such-file.css", staticMissing),
  },
  {
    id: "public-asset-head",
    group: "core",
    method: "HEAD",
    difference: "D21",
    reference: endpoint("/public/static/style.css", referenceHead),
    production: endpoint("/public/static/style.css", normalHead),
    fixture: endpoint("/public/static/style.css", normalHead),
  },
  {
    id: "public-asset-post",
    group: "core",
    method: "POST",
    difference: "D21",
    reference: endpoint("/public/static/style.css", { ...staticMethod, headers: referenceAllow }),
    production: endpoint("/public/static/style.css", { ...staticMethod, headers: normalAllow }),
    fixture: endpoint("/public/static/style.css", { ...staticMethod, headers: normalAllow }),
  },
  {
    id: "public-asset-options",
    group: "core",
    method: "OPTIONS",
    difference: "D21",
    reference: endpoint("/public/static/style.css", {
      ...wire(204, null, ""),
      headers: referenceAllow,
    }),
    production: endpoint("/public/static/style.css", {
      ...wire(204, null, ""),
      headers: normalAllow,
    }),
    fixture: endpoint("/public/static/style.css", { ...wire(204, null, ""), headers: normalAllow }),
  },
  {
    id: "missing-public-asset-head",
    group: "core",
    method: "HEAD",
    difference: "D21",
    reference: endpoint("/public/static/no-such-file.css", referenceHead),
    production: endpoint(
      "/public/static/no-such-file.css",
      wire(404, "text/plain; charset=utf-8", ""),
    ),
    fixture: endpoint(
      "/public/static/no-such-file.css",
      wire(404, "text/plain; charset=utf-8", ""),
    ),
  },
  {
    id: "public-static-dot-escape",
    group: "core",
    difference: "D18",
    reference: endpoint("/public/static/%2e%2e/style.css", staticMissing),
    production: endpoint("/public/static/%2e%2e/style.css", productionHTML),
    fixture: endpoint("/public/static/%2e%2e/style.css", productionHTML),
  },
  helper("invalid-id", "/api/lists/not-an-id", "/fixture/id/not-an-id", invalidID),
  ...["%31%32", "%2B12", "1%32", "%252B12", "%FF"].map((id, index) =>
    helper(`escaped-id-${index + 1}`, `/api/lists/${id}`, `/fixture/id/${id}`, invalidID),
  ),
  ...["%2E", "%2E%2E"].map((id, index): ContractCase => ({
    id: index === 0 ? "encoded-dot" : "encoded-dot-dot",
    group: "staged",
    auth: "basic",
    difference: "D18",
    reference: endpoint(`/api/lists/${id}`, invalidID),
    fixture: endpoint(`/fixture/id/${id}`, productionHTML),
  })),
  {
    id: "literal-backslash",
    group: "staged",
    auth: "basic",
    difference: "D18",
    reference: endpoint("/api/lists\\1", notFound),
    fixture: endpoint("/fixture/id\\12", json(200, '{"data":12}')),
  },
  ...["%zz", "1%", "%2"].map((id, index) =>
    helper(`malformed-path-${index + 1}`, `/api/lists/${id}`, `/fixture/id/${id}`, badEscape),
  ),
  { id: "malformed-api-path", group: "core", ...same("/api/lists%zz", badEscape) },
  { id: "malformed-query", group: "core", ...same("/health?value=%zz", ok) },
  {
    ...helper(
      "invalid-field",
      "/api/lists",
      "/fixture/input",
      json(400, '{"message":"Invalid name."}'),
    ),
    method: "POST",
    requestBody: '{"name":""}',
    requestContentType: "application/json",
  },
  {
    ...helper(
      "empty-body-no-type",
      "/api/lists",
      "/fixture/input",
      json(400, '{"message":"Invalid name."}'),
    ),
    method: "POST",
  },
  {
    ...helper(
      "empty-json-body",
      "/api/lists",
      "/fixture/input",
      json(400, '{"message":"Invalid name."}'),
    ),
    method: "POST",
    requestBody: "",
    requestContentType: "application/json",
  },
  {
    ...helper(
      "unsupported-media",
      "/api/lists",
      "/fixture/input",
      json(415, '{"message":"Unsupported Media Type"}'),
    ),
    method: "POST",
    requestBody: "not JSON",
    requestContentType: "text/plain",
  },
  {
    id: "positive-id-overflow",
    group: "staged",
    auth: "basic",
    difference: "D17",
    reference: endpoint(
      "/api/lists/9223372036854775808",
      json(
        500,
        '{"message":"Error fetching Lists: pq: value \\\"9223372036854775807\\\" is out of range for type integer (22003)"}',
      ),
    ),
    fixture: endpoint("/fixture/id/9223372036854775808", invalidID),
  },
  {
    ...helper(
      "invalid-enum",
      "/api/lists",
      "/fixture/input",
      json(400, '{"message":"Invalid fields: type"}'),
    ),
    method: "POST",
    requestBody: '{"name":"ok","type":"bad"}',
    requestContentType: "application/json",
  },
  {
    ...helper(
      "malformed-json",
      "/api/lists",
      "/fixture/input",
      json(400, '{"message":"Bad Request"}'),
    ),
    method: "POST",
    requestBody: "{",
    requestContentType: "application/json",
  },
  {
    ...helper("api-method-mismatch", "/api/lists/not-an-id", "/api/health", notFound),
    method: "POST",
  },
  {
    id: "probe-entities",
    group: "probe",
    fixture: endpoint("/fixture/probe", {
      status: 200,
      contentType: "application/json",
      body: {
        kind: "json",
        value: {
          data: {
            id: "<id:entity>",
            owner_id: "<id:entity>",
            other_id: "<id:other>",
            created_at: "<timestamp:created>",
            created_copy: "<timestamp:created>",
            updated_at: "<timestamp:updated>",
            label: "synthetic 101",
            fixed: { id: 77 },
          },
        },
        volatile,
      },
    }),
  },
  {
    id: "probe-entity-reference",
    group: "probe",
    fixture: endpoint("/fixture/probe/reference", {
      status: 200,
      contentType: "application/json",
      body: {
        kind: "json",
        value: { data: { id: "<id:entity>" } },
        volatile: [{ path: ["data", "id"], kind: "id", bind: "entity", requireBound: true }],
      },
    }),
  },
]);
