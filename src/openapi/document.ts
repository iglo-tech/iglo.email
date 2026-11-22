// The OpenAPI 3.1 document of GET /api/openapi.json. It starts from upstream's
// docs/swagger/collections.yaml and holds no secret and nothing of this instance.
import packageJson from "@/../package.json";
import { must } from "@/invariant";
import { differences } from "@/openapi/differences";
import { excluded } from "@/openapi/excluded";
import { operations } from "@/openapi/operations";
import type { Operation } from "@/openapi/operations";
import { nullable, object, schemas } from "@/openapi/schemas";
import { errorCodesFor } from "@/server/error-codes";

const error = { $ref: "#/components/responses/Error" };
const errorContent = {
  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
};
/**
 * What a client does with a failure (B131). A permanent status fails the same way again until the
 * request changes; a transient one is worth retrying with backoff, after `Retry-After` when sent.
 * A write that carries an `idempotency_key` replays its first answer, so a retry of it is safe.
 */
const retryGuidance =
  "The error envelope. Permanent, so retry only after the request changes: 400, 401, 403, 404, 409, 413 and 422, except the 409s `subscriber_changed`, `test_running` and `upload_changed`, which name a race. Worth retrying with backoff: 429, 503, other 5xx, network errors and those three 409s. Every 429 and 503 sends `Retry-After` in seconds. A 403 `invalid_credentials` is a wrong or unknown credential, and stays so until it is replaced. A write that carries an `idempotency_key` (`POST /api/subscriber-events`, its batch, `POST /api/tx`) is safe to retry: the first answer is replayed.";
/**
 * The envelope of one status (B131): `code` is the enum of the codes that status can send. A 409
 * may also name the holder of an address it refused (D129).
 */
const errorSchema = (status: number) =>
  object(
    {
      message: { type: "string" },
      code: { type: "string", enum: [...errorCodesFor(status)] },
      ...(status === 409
        ? { conflict: object({ external_id: nullable({ type: "string" }) }) }
        : {}),
    },
    status === 409 ? ["conflict"] : [],
  );
const refused = new Map<number, string>([
  [400, "Invalid input."],
  [401, "No valid credential."],
  [403, "No valid credential, or a missing permission."],
  [404, "Not found."],
  [405, "Method not allowed."],
  [406, "Refused, without a retry."],
  [409, "Conflict."],
  [413, "Too large."],
  [422, "The result is too large for this read."],
  [429, "Too many requests."],
  [499, "The client closed the request before the answer."],
  [503, "Unavailable: the feature is off, the server is shutting down, or a restore hold is on."],
]);

function applies(entry: string, operation: Operation): boolean {
  if (entry === "*id") {
    return /\{id\}/.test(operation.route);
  }
  if (entry === "*secured") {
    return !operation.anonymous;
  }
  if (entry === operation.route) {
    return true;
  }
  return operation.route.includes(entry) && !/^[A-Z]+ /.test(entry);
}

const pathParameters = ({ route, path }: Operation) =>
  [...route.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema:
      path?.[must(name, "path parameter name")] ??
      (name === "id" ? { type: "integer", minimum: 1 } : { type: "string" }),
  }));

/** The statuses an operation documents by name, beside the envelope every failure takes. */
function statusesOf(operation: Operation): Array<number> {
  const statuses = new Set(operation.errors);
  if (!operation.anonymous) {
    statuses.add(403);
  }
  if (/\{id\}/.test(operation.route)) {
    statuses.add(400);
  }
  return [...statuses].sort((a, b) => a - b);
}

function build(operation: Operation) {
  const content = operation.answer
    ? Object.fromEntries(
        Object.entries(operation.answer).map(([type, schema]) => [type, { schema }]),
      )
    : operation.data && {
        "application/json": {
          schema: {
            type: "object",
            properties: { data: operation.data },
            required: ["data"],
          },
        },
      };
  const named = differences
    .filter(({ applies: entries }) => entries.some((entry) => applies(entry, operation)))
    .map(({ area }) => area);
  return {
    operationId: operation.id,
    tags: [operation.tag],
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    ...(operation.anonymous ? { security: [] } : {}),
    ...(operation.session ? { security: [{ SessionCookie: [] }] } : {}),
    ...(operation.permissions ? { "x-required-permissions": operation.permissions } : {}),
    ...(operation.alsoPermissions
      ? { "x-also-required-permissions": operation.alsoPermissions }
      : {}),
    ...(operation.native ? { "x-native": true } : {}),
    ...(named.length ? { "x-differences": named } : {}),
    parameters: [
      ...pathParameters(operation),
      ...(operation.query ?? []).map((parameter) => ({
        schema: { type: "string" },
        ...parameter,
        in: "query",
      })),
    ],
    ...(operation.body
      ? {
          requestBody: {
            required: !operation.bodyOptional,
            content: {
              [operation.bodyType ?? "application/json"]: { schema: operation.body },
            },
          },
        }
      : {}),
    responses: {
      ...(content ? { 200: { description: "OK", content } } : {}),
      ...Object.fromEntries(
        statusesOf(operation).map((status) => [
          status,
          { $ref: `#/components/responses/Error${status}` },
        ]),
      ),
      default: error,
    },
  };
}

/** The document as text. Cheap, and the route builds it once, on the first request. */
export function buildDocument(): string {
  const paths: Record<string, Record<string, ReturnType<typeof build>>> = {};
  for (const operation of operations) {
    const [method = "", path = ""] = operation.route.split(" ");
    (paths[path] ??= {})[method.toLowerCase()] = build(operation);
  }
  // One named response per status, shared by every operation that documents it (B131). Its
  // envelope is inline: the codes a status can send are its own, not a schema of their own.
  const documented = [...new Set(operations.flatMap(statusesOf))].sort((a, b) => a - b);
  const statusResponses = Object.fromEntries(
    documented.map((status) => [
      `Error${status}`,
      {
        description: refused.get(status) ?? "Failed.",
        content: { "application/json": { schema: errorSchema(status) } },
      },
    ]),
  );
  return JSON.stringify({
    openapi: "3.1.0",
    info: {
      title: "iglo.email",
      version: packageJson.version,
      description:
        "The API of iglo.email. Ported endpoints keep listmonk v7.0.0-beta.1's contract except for the differences in `x-deliberate-differences`; an operation names those that touch it in `x-differences`. `x-native` marks endpoints listmonk does not have. `x-required-permissions` holds the permissions of which any one is enough, and every operation with a permission has it; `list:get` and `list:manage` there are grants on that list in the caller's list role. `x-also-required-permissions` holds further groups, one of each needed as well. Mutations by session cookie also need the `X-CSRF-Token` header. Rows beyond the caller's list role are left out of answers.",
      license: { name: "AGPL-3.0", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
    },
    servers: [{ url: "/" }],
    security: [{ BasicAuth: [] }, { TokenAuth: [] }, { SessionCookie: [] }],
    tags: [...new Set(operations.map(({ tag }) => tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        BasicAuth: { type: "http", scheme: "basic", description: "API user and token." },
        TokenAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "`token <api_user>:<token>`.",
        },
        SessionCookie: { type: "apiKey", in: "cookie", name: "session" },
      },
      responses: {
        Error: { description: retryGuidance, content: errorContent },
        ...statusResponses,
      },
      schemas,
    },
    "x-deliberate-differences": differences.map(({ area, summary }) => ({ area, summary })),
    "x-excluded-routes": excluded,
  });
}
