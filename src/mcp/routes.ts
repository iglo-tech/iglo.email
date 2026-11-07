// MCP Streamable HTTP endpoint at /api/mcp (B34, D89, D91).
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import { cookie, type Authentication } from "@/users/auth";
import { TOOLS, executeTool } from "@/mcp/tools";

const MCP_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const LATEST_PROTOCOL_VERSION = SUPPORTED_VERSIONS[0];

export interface McpDeps {
  auth: Authentication;
  router: Router;
  settings?: () => { rootUrl: string };
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
              version: "0.1.0",
            },
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
      const toolResult = await executeTool(
        params.name,
        context.app,
        deps.router,
        authHeader,
        context.peerAddress,
        args,
        cookieHeader,
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
