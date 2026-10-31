// Native: upstream ships docs/swagger/collections.yaml and serves no document.
import { buildDocument } from "@/openapi/document";
import type { Router } from "@/server/router";
import type { Authentication } from "@/users/auth";

export function registerOpenApiRoutes(router: Router, auth: Authentication) {
  let document: string | undefined;
  // Any valid credential, as /api/health: nothing here is secret, but every /api/ route outside
  // /api/public/ needs one, and those who call this API hold one.
  router.route(
    "GET",
    "/api/openapi.json",
    () => {
      document ??= buildDocument();
      return new Response(document, { headers: { "Content-Type": "application/json" } });
    },
    auth.middleware(),
  );
}
