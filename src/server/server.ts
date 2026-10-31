// The health handler is adapted from listmonk's cmd/handlers.go: HealthCheck.
import type { App } from "@/app";
import { ok } from "@/server/response";
import { Router } from "@/server/router";
import type { RestoreHold } from "@/settings/hold";

/** Names when a hold began. The body stays the same, since probes match it (D67). */
const HOLD_HEADER = "X-Iglo-Email-Hold";

export function createRouter(hold: () => RestoreHold | null = () => null): Router {
  const router = new Router();
  router.route("GET", "/health", () => {
    const response = ok(true);
    const held = hold();
    if (held) response.headers.set(HOLD_HEADER, held.since);
    return response;
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
