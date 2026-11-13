// MCP tools generated from the API document's operations (D98). Every documented operation that
// no hand-written tool covers and coverage.ts does not exclude becomes one tool, so a new endpoint
// in src/openapi/operations.ts is a tool without code here.
import { operations, type Operation } from "@/openapi/operations";
import { schemas, type Schema } from "@/openapi/schemas";
import { EXCLUDED_OPERATIONS, HANDWRITTEN_COVERAGE } from "@/mcp/coverage";
import type { ToolAnnotations } from "@/mcp/annotations";
import type { ToolDefinition } from "@/mcp/tools";

/** A file a multipart tool sends: the request body is 2 MiB (routes.ts), so one MiB of file is the cap. */
export const MCP_MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = 4 * Math.ceil(MCP_MAX_UPLOAD_BYTES / 3);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Operations that send mail or call an outside URL, or start that work (D98). */
const OPEN_WORLD_IDS = new Set([
  // An admin write can send the opt-in mail; the send is explicit for subscriberSendOptin.
  "createSubscriber",
  "updateSubscriberById",
  "patchSubscriberById",
  "updateSubscriberByExternalId",
  "updateSubscriberByExternalQuery",
  "subscriberSendOptin",
  "updateCampaignStatusById",
  "testCampaignById",
  "testSmtpSettings",
  "transactWithSubscriber",
  "resendById",
  "createEnrollment",
  "updateSequenceStatusById",
  "rescheduleSequenceStep",
  "createSubscriberEvent",
  "createSubscriberEventBatch",
  // A webhook is where the server posts events.
  "createWebhook",
  "updateWebhookById",
]);

/** Changes that delete, block, or switch what is live (D98). DELETE routes are checked separately. */
const DESTRUCTIVE_IDS = new Set([
  "updateCampaignStatusById",
  "updateSettingByKey",
  "blocklistSubscriberById",
  "blocklistSubscribers",
  "blocklistBouncedSubscribers",
]);

const snake = (id: string): string => id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * A tool is named for its operation in snake_case, without a trailing `_by_id` (updateSequenceById
 * is update_sequence). A name that another operation would share keeps its `_by_id`.
 */
function toolNames(candidates: Operation[]): Map<string, string> {
  const claims = new Map<string, number>();
  for (const op of candidates) {
    const full = snake(op.id);
    for (const name of new Set([full, full.replace(/_by_id$/, "")]))
      claims.set(name, (claims.get(name) ?? 0) + 1);
  }
  return new Map(
    candidates.map((op) => {
      const full = snake(op.id);
      const short = full.replace(/_by_id$/, "");
      return [op.id, claims.get(short) === 1 ? short : full];
    }),
  );
}

/** A `$ref` inlined from the document's schemas. A schema that refers back to itself becomes `{}`. */
function inline(value: unknown, stack: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => inline(item, stack));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const name = record.$ref.replace("#/components/schemas/", "");
    if (stack.includes(name)) return {};
    const target = schemas[name];
    if (target === undefined) throw new Error(`no schema ${name} for an MCP tool`);
    return inline(target, [...stack, name]);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, inline(item, stack)]),
  );
}

const pathNames = (route: string): string[] => [...route.matchAll(/\{(\w+)\}/g)].map(([, n]) => n!);

/** The same defaults the document gives a path parameter (document.ts). */
const pathSchema = (op: Operation, name: string): Schema =>
  op.path?.[name] ?? (name === "id" ? { type: "integer", minimum: 1 } : { type: "string" });

/** A `.` or `..` segment, as written or as one percent-decoding away: the URL parser removes it (D98). */
function dotSegment(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not decodable: judged as written.
  }
  return [value, decoded].some((item) => item === "." || item === "..");
}

/**
 * Why a path argument is not a value of its parameter's schema, or undefined when it is. A numeric
 * ID is a positive integer; a string is never `.` or `..`, and an enumerated one is one of its values.
 */
function pathArgumentError(name: string, schema: Schema, value: unknown): string | undefined {
  const raw = text(value);
  if (schema.type === "integer") {
    const minimum = typeof schema.minimum === "number" ? schema.minimum : 1;
    const number =
      typeof value === "number" ? value : /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(number) || number < minimum)
      return `${name} must be a positive integer.`;
  } else if (Array.isArray(schema.enum) && !schema.enum.map(String).includes(raw)) {
    return `${name} must be one of: ${schema.enum.join(", ")}.`;
  }
  if (dotSegment(raw)) return `${name} must not be "." or "..".`;
  return undefined;
}

/**
 * Whether a built request path is the operation's route, with each parameter as one non-empty
 * segment. The URL parser rewrites dot segments, so a path it changes is not the route it was built for.
 */
function pathMatchesRoute(route: string, url: string): boolean {
  const template = route.split(" ")[1]!;
  const pathname = url.split("?", 1)[0]!;
  if (new URL(pathname, "http://127.0.0.1").pathname !== pathname) return false;
  const want = template.split("/");
  const got = pathname.split("/");
  return (
    want.length === got.length &&
    want.every((segment, i) =>
      segment.startsWith("{") ? got[i] !== "" && !dotSegment(got[i]!) : segment === got[i],
    )
  );
}

const isMultipart = (op: Operation): boolean => op.bodyType?.startsWith("multipart/") ?? false;

/** The one body field that holds the file of a multipart operation. */
function fileField(op: Operation): string | undefined {
  const fields = (op.body?.properties ?? {}) as Record<string, Schema>;
  return Object.keys(fields).find((name) => fields[name]?.contentMediaType !== undefined);
}

const requiredFields = (op: Operation): string[] =>
  (op.body?.required as string[] | undefined) ?? [];

function needs(op: Operation): string {
  const groups = [op.permissions, ...(op.alsoPermissions ?? [])].filter(
    (group): group is string[] => group !== undefined,
  );
  return groups.length
    ? groups.map((group) => group.join(" or ")).join(" and ")
    : "a valid API credential";
}

function annotationsFor(op: Operation): ToolAnnotations {
  const method = op.route.split(" ", 1)[0];
  if (method === "GET" || (method === "POST" && /^(preview|validate)/.test(op.id)))
    return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: method === "DELETE" || /blocklist/i.test(op.id) || DESTRUCTIVE_IDS.has(op.id),
    openWorldHint: OPEN_WORLD_IDS.has(op.id),
  };
}

export function toolFor(name: string, op: Operation): ToolDefinition {
  const route = op.route.split(" ")[1]!;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of pathNames(route)) {
    properties[param] = pathSchema(op, param);
    required.push(param);
  }
  for (const param of op.query ?? []) {
    const schema = inline(param.schema ?? { type: "string" }) as Schema;
    properties[param.name] = param.description
      ? { ...schema, description: param.description }
      : schema;
    if (param.required) required.push(param.name);
  }
  if (op.body && isMultipart(op)) {
    const file = fileField(op);
    const fields = (op.body.properties ?? {}) as Record<string, unknown>;
    for (const [field, schema] of Object.entries(fields))
      if (field !== file) properties[field] = inline(schema);
    properties.filename = { type: "string", description: "The file's name." };
    properties.content_base64 = {
      type: "string",
      contentEncoding: "base64",
      description: `The file's bytes, base64. At most ${MCP_MAX_UPLOAD_BYTES} bytes once decoded.`,
    };
    required.push(
      ...requiredFields(op).filter((field) => field !== file),
      "filename",
      "content_base64",
    );
  } else if (op.body) {
    properties.body = inline(op.body);
    required.push("body");
  }

  const note =
    op.body && isMultipart(op) ? "Send the file as content_base64, with its name in filename." : "";
  return {
    name,
    description: [op.summary, op.description, `Needs: ${needs(op)}.`, note]
      .filter(Boolean)
      .join(" "),
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: annotationsFor(op),
  };
}

export interface GeneratedOperation {
  name: string;
  operation: Operation;
  tool: ToolDefinition;
}

const candidates = operations.filter(
  (op) => !Object.hasOwn(HANDWRITTEN_COVERAGE, op.id) && !Object.hasOwn(EXCLUDED_OPERATIONS, op.id),
);
const names = toolNames(candidates);

/** One entry per generated tool, in the document's order. */
export const GENERATED: GeneratedOperation[] = candidates.map((operation) => {
  const name = names.get(operation.id)!;
  return { name, operation, tool: toolFor(name, operation) };
});

export const GENERATED_BY_NAME = new Map(GENERATED.map((entry) => [entry.name, entry]));

/** A value as the request carries it: strings as they are, objects and arrays as JSON. */
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);

export type OperationRequest =
  | { method: string; path: string; body?: unknown; contentType?: string }
  | { error: string };

const missing = (name: string): OperationRequest => ({
  error: `Missing required argument: ${name}`,
});

/**
 * The HTTP request an operation tool sends. Path and query values go in the URL; a JSON body is
 * `body`; a form body is sent as urlencoded fields; a multipart body is built from `filename` and
 * `content_base64` (the file) and the operation's other form fields.
 */
export function operationRequest(op: Operation, args: Record<string, unknown>): OperationRequest {
  const [method, route] = op.route.split(" ") as [string, string];
  let path = route;
  for (const param of pathNames(route)) {
    const value = args[param];
    if (value === undefined || value === null || value === "") return missing(param);
    const problem = pathArgumentError(param, pathSchema(op, param), value);
    if (problem) return { error: problem };
    path = path.replace(`{${param}}`, encodeURIComponent(text(value)));
  }

  const search = new URLSearchParams();
  for (const param of op.query ?? []) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) return missing(param.name);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value])
      search.append(param.name, text(item));
  }
  const query = search.toString();
  const url = query ? `${path}?${query}` : path;
  if (!pathMatchesRoute(op.route, url))
    return { error: "The request path does not match the operation's route, so nothing was sent." };

  if (!op.body) return { method, path: url };

  if (isMultipart(op)) {
    const { filename, content_base64: encoded } = args;
    if (typeof filename !== "string" || filename === "") return missing("filename");
    if (typeof encoded !== "string") return missing("content_base64");
    const compact = encoded.replace(/\s+/g, "");
    if (compact.length > MAX_BASE64_CHARS)
      return {
        error: `The file is larger than ${MCP_MAX_UPLOAD_BYTES} bytes. Upload larger files through the REST API.`,
      };
    if (!BASE64.test(compact)) return { error: "content_base64 is not valid base64." };

    const file = fileField(op);
    if (file === undefined) return { error: "The operation has no file field." };
    const form = new FormData();
    for (const field of Object.keys(op.body.properties ?? {})) {
      if (field === file) continue;
      const value = args[field];
      if (value === undefined || value === null) {
        if (requiredFields(op).includes(field)) return missing(field);
        continue;
      }
      form.append(field, text(value));
    }
    form.append(file, new File([new Uint8Array(Buffer.from(compact, "base64"))], filename));
    return { method, path: url, body: form, contentType: "multipart/form-data" };
  }

  if (op.bodyType === "application/x-www-form-urlencoded") {
    const fields = args.body;
    if (fields === undefined) return missing("body");
    if (typeof fields === "string")
      return { method, path: url, body: fields, contentType: op.bodyType };
    if (typeof fields !== "object" || fields === null || Array.isArray(fields))
      return { error: "body must be an object of form fields." };
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields))
      if (value !== undefined) form.append(key, text(value));
    return { method, path: url, body: form.toString(), contentType: op.bodyType };
  }

  if (args.body === undefined) return missing("body");
  return { method, path: url, body: args.body, contentType: "application/json" };
}
