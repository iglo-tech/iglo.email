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
    if (held) {
      response.headers.set(HOLD_HEADER, held.since);
    }
    return response;
  });
  return router;
}

/** One app on its own router: the fixtures' server. Production serves an instance (serveRouted). */
export function startServer(app: App, router: Router = createRouter()) {
  return serveRouted({ host: app.bootstrap.host, port: app.bootstrap.port }, (request, peer) =>
    router.handle(app, request, peer),
  );
}

/**
 * The routing seam (14-projects section 2): one `Bun.serve` on the instance's port, which hands
 * every request and its peer address to `dispatch`. The instance picks the project by `Host`.
 */
export function serveRouted(
  listen: { readonly host: string; readonly port: number },
  dispatch: (request: Request, peerAddress: string) => Promise<Response>,
) {
  return Bun.serve({
    hostname: listen.host,
    port: listen.port,
    fetch: (request, server) => dispatch(request, server.requestIP(request)?.address ?? "unknown"),
  });
}

export type RoutedServer = ReturnType<typeof serveRouted>;
