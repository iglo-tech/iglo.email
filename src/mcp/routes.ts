// MCP Streamable HTTP endpoint at /api/mcp (B34, D89, D91).
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import { cookie, type Authentication } from "@/users/auth";
import { TOOLS, executeTool } from "@/mcp/tools";
import { version } from "@/../package.json";

const MCP_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const LATEST_PROTOCOL_VERSION = SUPPORTED_VERSIONS[0];

/**
 * What an agent reads first, in the initialize result (D108). About 1,500 characters at most. Every
 * tool named here exists in tools/list for an admin credential (test/mcp/agent-guidance.test.ts).
 */
const INSTRUCTIONS = [
  "iglo.email is an email server. This endpoint is for an agent working on an instance for a person; applications use the REST API (/api/openapi.json) with an API user. Both apply the same permissions; this endpoint omits what the last paragraph names.",
  "Before writing Liquid, read `template_reference`.",
  "To author a sequence step: `get_sequence`; change the step with `update_sequence_step`, or a template with `update_template`; render it with `preview_sequence_step`, giving a real `subscriber_id` or a `sample`; send a labelled test with `test_sequence_step`. Campaigns follow the same loop: `update_campaign`, `preview_campaign`, `send_campaign_test`.",
  "A test send's `true` means queued, not delivered: ask the person to check their inbox. A test writes no send row. A test that fails to deliver, at SMTP time or later by a bounce or complaint, appears in `get_logs`; silence may be delay or filtering. Never repeat a send to check it, real or test.",
  "Check real sends with `get_sends`; `get_bounces` lists the bounces that came back.",
  "A failed call returns the API's message as a tool error: correct the arguments it names. Sends are real mail: confirm addresses with the person first. Reading users and roles is a tool (`get_users`, `get_user_roles`); changes to users and roles, two-factor sign-in, bulk deletes, deletes addressed by a query, bulk changes selected by a query and replacing all settings are not tools; a person does those in the admin UI. Uploads and answers are capped at 1 MiB.",
].join("\n\n");

export interface McpDeps {
  auth: Authentication;
  router: Router;
}

export function registerMcpRoutes(router: Router, deps: McpDeps): void {
  // GET /api/mcp answers 405 Method Not Allowed for Streamable HTTP servers without a stream.
  router.route("GET", "/api/mcp", () => {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: {
        Allow: "POST",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  });

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
      !(SUPPORTED_VERSIONS as readonly string[]).includes(protocolVersionHeader)
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
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
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
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
          error: { code: -32600, message: "Batch requests are not supported" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 7. Validate JSON-RPC 2.0 structure
    if (
      typeof body !== "object" ||
      body === null ||
      body.jsonrpc !== "2.0" ||
      typeof body.method !== "string"
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
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
          error: { code: -32600, message: "Invalid Request: invalid id" },
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
      const requested = params?.protocolVersion;
      let negotiated: string = LATEST_PROTOCOL_VERSION;
      if (
        typeof requested === "string" &&
        (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
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
            instructions: INSTRUCTIONS,
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
      if (typeof params !== "object" || params === null || typeof params.name !== "string") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params" },
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
            error: { code: -32602, message: `Unknown tool: ${params.name}` },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const args =
        typeof params.arguments === "object" &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

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
        error: { code: -32601, message: "Method not found" },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}
