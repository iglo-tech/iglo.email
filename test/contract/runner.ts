import { isDeepStrictEqual } from "node:util";
import { cases as corpus } from "@/test/contract/cases";
import type {
  ContractCase,
  ContractTarget,
  Credentials,
  Difference,
  ExpectedBody,
  VolatileField,
} from "@/test/contract/types";
import { rawRequest } from "@/test/server/raw-request";

const differences: Readonly<
  Record<Difference, { readonly cases: readonly string[]; readonly reason: string }>
> = {
  D17: {
    cases: ["positive-id-overflow"],
    reason:
      "reject unrepresentable IDs before storage; docs/design/07-api-and-ui.md and 09-decisions.md#d17-reject-positive-route-id-overflow-before-storage",
  },
  D18: {
    cases: ["encoded-dot", "encoded-dot-dot", "literal-backslash"],
    reason:
      "Bun canonicalizes request paths before routing; docs/design/07-api-and-ui.md and 09-decisions.md#d18-use-buns-normalized-request-path",
  },
};

export interface ContractReport {
  readonly passed: boolean;
  readonly lines: readonly string[];
}

export function validateTarget(target: ContractTarget): void {
  const validProfile =
    (target.mode === "reference" &&
      target.target === "upstream" &&
      ["all", "core", "staged"].includes(target.profile)) ||
    (target.mode === "normal" && target.target === "production" && target.profile === "core") ||
    (target.mode === "normal" &&
      target.target === "fixture" &&
      ["staged", "probe"].includes(target.profile));
  if (!validProfile) throw new Error("Unsupported mode, target, or profile combination");
  // Numeric loopback only: DNS, external services, credentials and URL paths are forbidden.
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(target.baseUrl))
    throw new Error(
      "Invalid base URL: use a loopback HTTP origin with an explicit port and no credentials or path",
    );
  let url: URL;
  try {
    url = new URL(target.baseUrl);
  } catch {
    throw new Error("Invalid base URL");
  }
  const match = /:([0-9]+)\/?$/.exec(target.baseUrl);
  const port = Number(match?.[1]);
  if (!url || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid loopback port");
  if (target.credentials) validateCredentials(target.credentials);
}

function validateCredentials(credentials: Credentials): void {
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(credentials.user) ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(credentials.token)
  ) {
    throw new Error("Invalid synthetic credentials");
  }
}

function validateCorpus(items: readonly ContractCase[], complete: boolean): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || ids.has(item.id))
      throw new Error("Invalid or duplicate contract case ID");
    ids.add(item.id);
    for (const endpoint of [item.reference, item.production, item.fixture]) {
      if (
        endpoint &&
        (!endpoint.path.startsWith("/") ||
          endpoint.path.startsWith("//") ||
          endpoint.path.startsWith("/\\") ||
          /[\u0000-\u0020\u007f#]/.test(endpoint.path))
      ) {
        throw new Error("Invalid contract request target: expected an origin-form path");
      }
    }
    const prescribed = Object.entries(differences).find(([, metadata]) =>
      metadata.cases.includes(item.id),
    )?.[0];
    if (item.difference !== prescribed)
      throw new Error("Unknown, missing, duplicate, or orphaned deliberate-difference marker");
    if (item.difference && items !== corpus) {
      const canonical = corpus.find((entry) => entry.id === item.id);
      if (
        !canonical ||
        !isDeepStrictEqual(item.reference, canonical.reference) ||
        !isDeepStrictEqual(item.fixture, canonical.fixture)
      )
        throw new Error("Deliberate-difference expectations do not match the declared contract");
    }
    if (
      item.difference &&
      (!item.reference ||
        !item.fixture ||
        isDeepStrictEqual(item.reference.expect, item.fixture.expect))
    ) {
      throw new Error("Deliberate difference must declare distinct reference and fixture results");
    }
  }
  if (complete) {
    for (const metadata of Object.values(differences))
      for (const id of metadata.cases) {
        if (!ids.has(id)) throw new Error("Orphaned deliberate-difference metadata");
      }
  }
}

function selected(item: ContractCase, target: ContractTarget): boolean {
  if (target.profile === "all") return item.group !== "probe" && item.group !== "production-only";
  return (
    item.group === target.profile ||
    (target.target === "production" && item.group === "production-only")
  );
}

function redact(message: string, credentials?: Credentials): string {
  if (!credentials) return message;
  const pair = `${credentials.user}:${credentials.token}`;
  const encoded = Buffer.from(pair).toString("base64");
  const secrets = [
    credentials.user,
    credentials.token,
    pair,
    encoded,
    `Basic ${encoded}`,
    `token ${pair}`,
    "invalid-synthetic-token",
  ];
  let result = message;
  for (const value of secrets.sort((a, b) => b.length - a.length)) {
    if (value)
      for (const representation of [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
      ])
        result = result.replaceAll(representation, "[redacted]");
  }
  return result;
}

interface Binding {
  readonly kind: "id" | "timestamp";
  readonly value: number | string;
}
function normalize(
  value: unknown,
  fields: readonly VolatileField[],
  bindings: Map<string, Binding>,
  numericTokens: WeakMap<object, Map<string, string>>,
): unknown {
  for (const field of fields) {
    if (!field.path.length || !/^[a-z][a-z0-9-]*$/.test(field.bind))
      throw new Error("Invalid volatile field declaration");
    let parent: unknown = value;
    for (const component of field.path.slice(0, -1)) {
      if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, component))
        throw new Error(`Missing volatile field ${field.path.join(".")}`);
      parent = (parent as Record<string, unknown>)[component];
    }
    const key = field.path.at(-1)!;
    if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, key))
      throw new Error(`Missing volatile field ${field.path.join(".")}`);
    const object = parent as Record<string, unknown>;
    const original = object[key];
    if (field.kind === "id") {
      const token = numericTokens.get(parent)?.get(key);
      if (
        typeof original !== "number" ||
        !Number.isSafeInteger(original) ||
        original < 1 ||
        !token ||
        !/^[1-9][0-9]*$/.test(token) ||
        BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error(`Invalid or unsafe ID at ${field.path.join(".")}`);
    } else if (field.kind === "timestamp") {
      if (
        typeof original !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(original) ||
        Number.isNaN(Date.parse(original)) ||
        new Date(original).toISOString() !== original
      )
        throw new Error(`Invalid timestamp at ${field.path.join(".")}`);
    } else throw new Error("Unknown volatile field type");
    const previous = bindings.get(field.bind);
    if (field.requireBound && !previous)
      throw new Error(`${field.kind} ${field.bind} requires an existing binding`);
    if (previous && (previous.kind !== field.kind || previous.value !== original))
      throw new Error(`Inconsistent ${field.kind} binding ${field.bind}`);
    if (
      !previous &&
      field.kind === "id" &&
      [...bindings.values()].some((entry) => entry.kind === "id" && entry.value === original)
    )
      throw new Error(`Distinct ID binding ${field.bind} reused another entity`);
    if (field.after) {
      const earlier = bindings.get(field.after);
      if (
        field.kind !== "timestamp" ||
        !earlier ||
        earlier.kind !== "timestamp" ||
        Date.parse(original as string) <= Date.parse(earlier.value as string)
      )
        throw new Error(`Timestamp ${field.bind} is not after ${field.after}`);
    }
    bindings.set(field.bind, { kind: field.kind, value: original as number | string });
    object[key] = `<${field.kind}:${field.bind}>`;
  }
  return value;
}

function compareBody(actual: string, expected: ExpectedBody, bindings: Map<string, Binding>): void {
  if (expected.kind === "deferred-html") return;
  if (expected.kind === "wire") {
    if (actual !== expected.value)
      throw new Error(`body ${JSON.stringify(actual)}; expected ${JSON.stringify(expected.value)}`);
    return;
  }
  if (!actual.endsWith("\n") || actual.endsWith("\n\n"))
    throw new Error("JSON response must end with exactly one newline");
  let value: unknown;
  // Preserve the original JSON number token so a rounded value cannot masquerade
  // as a safe integer after parsing. Other fields retain their original values.
  const numericTokens = new WeakMap<object, Map<string, string>>();
  try {
    const parse = JSON.parse as (
      text: string,
      reviver: (
        this: object,
        key: string,
        entry: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown;
    value = parse(actual, function (key, entry, context) {
      if (typeof entry === "number" && context?.source) {
        let tokens = numericTokens.get(this);
        if (!tokens) {
          tokens = new Map();
          numericTokens.set(this, tokens);
        }
        tokens.set(key, context.source);
      }
      return entry;
    });
  } catch {
    throw new Error("Invalid JSON response");
  }
  const normalized = normalize(value, expected.volatile, bindings, numericTokens);
  if (!isDeepStrictEqual(normalized, expected.value))
    throw new Error(
      `JSON body ${JSON.stringify(normalized)}; expected ${JSON.stringify(expected.value)}`,
    );
}

export async function runContract(
  target: ContractTarget,
  options: { readonly caseId?: string; readonly cases?: readonly ContractCase[] } = {},
): Promise<ContractReport> {
  validateTarget(target);
  const items = options.cases ?? corpus;
  validateCorpus(items, options.cases === undefined);
  const filtered = items.filter((item) => selected(item, target));
  const selectedCases =
    options.caseId === undefined ? filtered : filtered.filter((item) => item.id === options.caseId);
  if (!selectedCases.length)
    throw new Error("Unsupported or unknown case for the selected target/profile");
  for (const item of selectedCases) {
    if (!item[target.target === "upstream" ? "reference" : target.target])
      throw new Error("Unsupported case for the selected target/profile");
    if (item.auth && !target.credentials)
      throw new Error("Synthetic credentials are required for the selected cases");
  }
  const lines = [`mode=${target.mode} target=${target.target} profile=${target.profile}`];
  const bindings = new Map<string, Binding>();
  let failures = 0;
  for (const item of selectedCases) {
    target.signal?.throwIfAborted();
    const endpoint = item[target.target === "upstream" ? "reference" : target.target]!;
    const marker = item.difference
      ? ` [${item.difference}: ${differences[item.difference].reason}]`
      : "";
    const headers: Record<string, string> = {};
    if (item.auth) {
      const credentials = target.credentials!;
      const token = item.auth === "bad-token" ? "invalid-synthetic-token" : credentials.token;
      headers.Authorization =
        item.auth === "basic"
          ? `Basic ${Buffer.from(`${credentials.user}:${token}`).toString("base64")}`
          : `token ${credentials.user}:${token}`;
    }
    if (item.requestContentType) headers["Content-Type"] = item.requestContentType;
    try {
      const actual = await rawRequest(target.baseUrl, endpoint.path, {
        method: item.method ?? "GET",
        headers,
        ...(item.requestBody === undefined ? {} : { body: item.requestBody }),
        ...(target.signal ? { signal: target.signal } : {}),
      });
      if (
        actual.status !== endpoint.expect.status ||
        actual.contentType !== endpoint.expect.contentType
      )
        throw new Error(
          `status/content-type ${actual.status} ${actual.contentType}; expected ${endpoint.expect.status} ${endpoint.expect.contentType}; body ${JSON.stringify(actual.body)}`,
        );
      const caseBindings = new Map(bindings);
      compareBody(actual.body, endpoint.expect.body, caseBindings);
      bindings.clear();
      for (const [name, binding] of caseBindings) bindings.set(name, binding);
      const deferred =
        endpoint.expect.body.kind === "deferred-html"
          ? " (status/content type only; HTML body deferred)"
          : "";
      lines.push(`PASS ${item.id}${marker}${deferred}`);
    } catch (error) {
      target.signal?.throwIfAborted();
      failures++;
      lines.push(
        `FAIL ${item.id}${marker}: ${redact(error instanceof Error ? error.message : "request failed", target.credentials).slice(0, 1200)}`,
      );
    }
  }
  if (target.profile === "probe")
    lines.push("NOTE synthetic harness probe; no upstream domain or production coverage");
  if (target.target !== "upstream")
    lines.push(
      "PENDING production: protected health/auth (M1.3); list validation/domain routes (M1.5); public HTML 404 body (M0.6/public pages)",
    );
  if (target.target === "upstream")
    lines.push(
      "PENDING production: protected health/auth (M1.3); list domain routes (M1.5); public HTML 404 body (M0.6/public pages)",
    );
  lines.push(`RESULT ${selectedCases.length - failures} passed, ${failures} failed`);
  return { passed: failures === 0, lines };
}
