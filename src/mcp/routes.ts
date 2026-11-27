// MCP Streamable HTTP endpoint at /api/mcp (B34, D89, D91).
import type { RequestContext } from "@/server/context";
import { HttpError, errorResponse } from "@/server/response";
import type { Router } from "@/server/router";
import { cookie } from "@/users/auth";
import type { Authentication } from "@/users/auth";
import { TOOLS, executeTool } from "@/mcp/tools";
import { version } from "@/../package.json";

const MCP_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const LATEST_PROTOCOL_VERSION = SUPPORTED_VERSIONS[0];

/** The longest project name the instructions quote (D159); a longer one is cut with "…". */
export const INSTRUCTIONS_NAME_LIMIT = 40;

/**
 * The longest run of whole graphemes that fits INSTRUCTIONS_NAME_LIMIT − 1 UTF-16 units, so the cut
 * never splits a surrogate pair or a combined emoji or accent.
 */
function cutName(flat: string): string {
  let cut = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    flat,
  )) {
    if (cut.length + segment.length > INSTRUCTIONS_NAME_LIMIT - 1) {
      break;
    }
    cut += segment;
  }
  return cut;
}

/**
 * What an agent reads first, in the initialize result (D108). About 1,500 characters at most, with
 * a project name of up to INSTRUCTIONS_NAME_LIMIT characters (D159). Every tool named here exists
 * in tools/list for an admin credential (test/mcp/agent-guidance.test.ts).
 */
export function instructions(project: string): string {
  const flat = project.replaceAll(/[\p{Cc}"\s]+/gu, " ").trim() || "this project";
  const name = flat.length > INSTRUCTIONS_NAME_LIMIT ? `${cutName(flat)}…` : flat;
  return [
    `iglo.email is an email server. This endpoint serves only the project "${name}", for an agent working for a person; applications use the REST API (/api/openapi.json) with the same permissions; this endpoint omits what the last paragraph names.`,
    "Before writing Liquid, read `template_reference`.",
    "To author a sequence step: `get_sequence`; change the step with `update_sequence_step`, or a template with `update_template`; render it with `preview_sequence_step`, giving a real `subscriber_id` or a `sample`; send a labelled test with `test_sequence_step`. Campaigns: `update_campaign`, `preview_campaign`, `send_campaign_test`.",
    "A test send's `true` means queued: ask the person to check their inbox. A test writes no send row; a test that fails to deliver (at SMTP time, or by a later bounce or complaint) appears in `get_logs`. Never repeat a send to check it, real or test.",
    "Real sends: `get_sends`; bounces: `get_bounces`. Before scheduling a large campaign, check `get_sending_capacity` with its `campaign_id`.",
    "A failed call returns the API's message as a tool error: fix the arguments it names. Sends are real mail: confirm addresses with the person first. Reading users and roles is a tool (`get_users`, `get_user_roles`); changes to users and roles, two-factor sign-in, bulk deletes, deletes addressed by a query, bulk changes selected by a query and replacing all settings are not tools; a person uses the admin UI. Uploads and answers are capped at 1 MiB.",
  ].join("\n\n");
}

export interface McpDeps {
  auth: Authentication;
  router: Router;
  /**
   * The name of the project this endpoint serves, named in the instructions (B145a); read on each
   * `initialize`, so a rename shows at once (B170, D198).
   */
  project?: () => string;
}

/** A parsed JSON object that is not an array: the only shape a JSON-RPC request can take here. */
function isRpcObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerMcpRoutes(router: Router, deps: McpDeps): void {
  // GET /api/mcp answers 405 Method Not Allowed for Streamable HTTP servers without a stream. The
  // body is the API's JSON error, as the OpenAPI document declares for every 405.
  router.route("GET", "/api/mcp", () =>
    errorResponse(new HttpError(405, "Method Not Allowed", { Allow: "POST" }), "GET"),
  );

  router.route("POST", "/api/mcp", async (context: RequestContext) => {
    // 1. Origin validation: reuse auth.checkOrigin to validate Origin when present
    deps.auth.checkOrigin(context.request);

    // 2. Auth: existing API-user authentication on every request (Authorization: token user:key / Basic) or session cookie.
    // An unauthenticated request gets the API's normal 401 before any JSON-RPC processing.
    const authHeader = (context.request.headers.get("authorization") ?? "").trim();
    const session = cookie(context.request, "session");
    if (!authHeader && !session) {
      throw new HttpError(401, "unauthorized");
    }
    context.identity = deps.auth.authorize(context);

    // 3. MCP-Protocol-Version header validation per transport spec
    const protocolVersionHeader = context.request.headers.get("mcp-protocol-version");
    if (
      protocolVersionHeader !== null &&
      !(SUPPORTED_VERSIONS as ReadonlyArray<string>).includes(protocolVersionHeader)
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32_000,
            message: `Bad Request: Unsupported protocol version: ${protocolVersionHeader} (supported versions: ${SUPPORTED_VERSIONS.join(", ")})`,
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 4. Request body bounds: 2 MiB like other API bodies.
    const contentLength = Number(context.request.headers.get("content-length") ?? "0");
    if (contentLength > MCP_BODY_LIMIT) {
      throw new HttpError(413, "Payload Too Large");
    }

    const arrayBuffer = await context.request.arrayBuffer();
    if (arrayBuffer.byteLength > MCP_BODY_LIMIT) {
      throw new HttpError(413, "Payload Too Large");
    }
    const text = new TextDecoder().decode(arrayBuffer);

    // 5. Parse JSON
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_700, message: "Parse error" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 6. JSON array batch handling
    if (Array.isArray(body)) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_600, message: "Batch requests are not supported" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 7. Validate JSON-RPC 2.0 structure
    if (!isRpcObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_600, message: "Invalid Request" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 8. Notifications: any message without id gets HTTP 202 with no body and runs no tool
    if (!("id" in body) || body.id === undefined) {
      return new Response(null, { status: 202 });
    }

    const { id, method, params } = body;

    // 9. Reject invalid id types with -32600
    if (typeof id !== "string" && (typeof id !== "number" || !Number.isInteger(id))) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_600, message: "Invalid Request: invalid id" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 10. Ping
    if (method === "ping") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {},
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 11. Initialize: On an unsupported requested version, answer with the server's latest supported version as the spec says, not an error.
    if (method === "initialize") {
      const requested = isRpcObject(params) ? params.protocolVersion : undefined;
      let negotiated: string = LATEST_PROTOCOL_VERSION;
      if (
        typeof requested === "string" &&
        (SUPPORTED_VERSIONS as ReadonlyArray<string>).includes(requested)
      ) {
        negotiated = requested;
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: "iglo.email",
              version,
            },
            // B170 (D198): the project's current name, so a rename shows without a restart.
            instructions: instructions(deps.project?.() ?? ""),
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 12. tools/list
    if (method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 13. tools/call
    if (method === "tools/call") {
      if (!isRpcObject(params) || typeof params.name !== "string") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32_602, message: "Invalid params" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32_602, message: `Unknown tool: ${params.name}` },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const args = isRpcObject(params.arguments) ? params.arguments : {};

      const cookieHeader = context.request.headers.get("cookie") ?? undefined;
      const csrfHeader = context.request.headers.get("x-csrf-token") ?? undefined;
      const originHeader = context.request.headers.get("origin") ?? undefined;
      const toolResult = await executeTool(
        params.name,
        context.app,
        deps.router,
        authHeader,
        context.peerAddress,
        args,
        cookieHeader,
        csrfHeader,
        originHeader,
      );

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: toolResult,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Unknown method
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32_601, message: "Method not found" },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}
