// The health response is adapted from listmonk's cmd/handlers.go: HealthCheck.
import type { BootstrapConfig } from "@/config/bootstrap";

export function startServer(config: BootstrapConfig) {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        }
        return new Response('{"data":true}\n', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}
