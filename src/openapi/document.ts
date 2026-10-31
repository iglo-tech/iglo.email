// The OpenAPI 3.1 document of GET /api/openapi.json. It starts from upstream's
// docs/swagger/collections.yaml and holds no secret and nothing of this instance.
import packageJson from "@/../package.json";
import { differences } from "@/openapi/differences";
import { excluded } from "@/openapi/excluded";
import { operations, type Operation } from "@/openapi/operations";
import { schemas, type Schema } from "@/openapi/schemas";

const error = { $ref: "#/components/responses/Error" };
const errorContent = {
  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
};
const refused: Record<number, string> = {
  400: "Invalid input.",
  403: "No valid credential, or a missing permission.",
  404: "Not found.",
  406: "Refused, without a retry.",
  409: "Conflict.",
  413: "Too large.",
  429: "Too many requests.",
  503: "The feature is off.",
};

function applies(entry: string, operation: Operation): boolean {
  if (entry === "*id") return /\{id\}/.test(operation.route);
  if (entry === "*secured") return !operation.anonymous;
  if (entry === operation.route) return true;
  return operation.route.includes(entry) && !/^[A-Z]+ /.test(entry);
}

const pathParameters = ({ route, path }: Operation) =>
  [...route.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: path?.[name!] ?? (name === "id" ? { type: "integer", minimum: 1 } : { type: "string" }),
  }));

function build(operation: Operation): Record<string, unknown> {
  const statuses = new Set(operation.errors);
  if (!operation.anonymous) statuses.add(403);
  if (/\{id\}/.test(operation.route)) statuses.add(400);
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
            required: true,
            content: {
              [operation.bodyType ?? "application/json"]: { schema: operation.body },
            },
          },
        }
      : {}),
    responses: {
      ...(content ? { 200: { description: "OK", content } } : {}),
      ...Object.fromEntries(
        [...statuses]
          .sort()
          .map((status) => [status, { description: refused[status], content: errorContent }]),
      ),
      default: error,
    },
  };
}

/** The document as text. Cheap, and the route builds it once, on the first request. */
export function buildDocument(): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const [method, path] = operation.route.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = build(operation);
  }
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
        Error: { description: "The error envelope.", content: errorContent },
      },
      schemas: schemas as Record<string, Schema>,
    },
    "x-deliberate-differences": differences.map(({ area, summary }) => ({ area, summary })),
    "x-excluded-routes": excluded,
  });
}
