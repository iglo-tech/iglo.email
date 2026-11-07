// MCP Streamable HTTP endpoint at /api/mcp (B34, D89, D91).
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { Authentication } from "@/users/auth";
import { TOOLS, executeTool } from "@/mcp/tools";

const MCP_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB

const SUPPORTED_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export interface McpDeps {
  auth: Authentication;
  router: Router;
  settings: () => { rootUrl: string };
}

function sessionCookie(request: Request): string {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("session="));
  return values.length === 1 ? values[0]!.slice("session=".length) : "";
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
    // 1. Origin validation: validate Origin when present (spec security note) and reject unknown origins with 403
    const origin = context.request.headers.get("origin");
    if (origin !== null) {
      const rootUrl = deps.settings().rootUrl;
      let allowed = false;
      try {
        const rootOrigin = new URL(rootUrl).origin;
        allowed = new URL(origin).origin === rootOrigin && origin === new URL(origin).origin;
      } catch {
        /* foreign origin */
      }
      if (!allowed) {
        throw new HttpError(403, "invalid origin");
      }
    }

    // 2. Auth: existing API-user authentication on every request (Authorization: token user:key / Basic).
    // An unauthenticated request gets the API's normal 401 before any JSON-RPC processing.
    const authHeader = (context.request.headers.get("authorization") ?? "").trim();
    const session = sessionCookie(context.request);
    if (!authHeader && !session) {
      throw new HttpError(401, "unauthorized");
    }
    context.identity = deps.auth.authorize(context);

    // 3. Request body bounds: 2 MiB like other API bodies.
    const contentLength = Number(context.request.headers.get("content-length") ?? "0");
    if (contentLength > MCP_BODY_LIMIT) {
      throw new HttpError(413, "Payload Too Large");
    }

    const arrayBuffer = await context.request.arrayBuffer();
    if (arrayBuffer.byteLength > MCP_BODY_LIMIT) {
      throw new HttpError(413, "Payload Too Large");
    }
    const text = new TextDecoder().decode(arrayBuffer);

    // 4. Parse JSON
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

    // 5. Validate JSON-RPC 2.0 structure
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      body.jsonrpc !== "2.0" ||
      typeof body.method !== "string"
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: { code: -32600, message: "Invalid Request" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const { id, method, params } = body;

    // 6. Notifications
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    // 7. Ping
    if (method === "ping") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {},
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 8. Initialize
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      let negotiated = "2025-11-25";
      if (typeof requested === "string") {
        if ((SUPPORTED_VERSIONS as readonly string[]).includes(requested)) {
          negotiated = requested;
        } else {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: id ?? null,
              error: {
                code: -32022,
                message: "Unsupported protocol version",
                data: {
                  supported: SUPPORTED_VERSIONS,
                  requested,
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
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

    // 9. tools/list
    if (method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
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

    // 10. tools/call
    if (method === "tools/call") {
      if (typeof params !== "object" || params === null || typeof params.name !== "string") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: id ?? null,
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
            id: id ?? null,
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

      const toolResult = await executeTool(
        params.name,
        context.app,
        deps.router,
        authHeader,
        context.peerAddress,
        args,
      );

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
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
        id: id ?? null,
        error: { code: -32601, message: "Method not found" },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}
