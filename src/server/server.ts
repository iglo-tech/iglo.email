// The health handler is adapted from listmonk's cmd/handlers.go: HealthCheck.
import type { App } from "@/app";
import { ok } from "@/server/response";
import { Router } from "@/server/router";

export function createRouter(): Router {
  const router = new Router();
  router.route("GET", "/health", () => ok(true));
  return router;
}

export function startServer(app: App, router: Router = createRouter()) {
  return Bun.serve({
    hostname: app.bootstrap.host,
    port: app.bootstrap.port,
    fetch: (request) => router.handle(app, request),
  });
}
