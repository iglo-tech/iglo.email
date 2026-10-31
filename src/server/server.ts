// The health handler is adapted from listmonk's cmd/handlers.go: HealthCheck.
import type { App } from "@/app";
import { ok } from "@/server/response";
import { Router } from "@/server/router";
import { restoreHold } from "@/settings/hold";

export function createRouter(): Router {
  const router = new Router();
  router.route("GET", "/health", (context) => {
    const hold = restoreHold(context.app.db);
    return ok(true, 200, hold ? { hold } : {});
  });
  return router;
}

export function startServer(app: App, router: Router = createRouter()) {
  return Bun.serve({
    hostname: app.bootstrap.host,
    port: app.bootstrap.port,
    fetch: (request, server) =>
      router.handle(app, request, server.requestIP(request)?.address ?? "unknown"),
  });
}
