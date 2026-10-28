// Route registration adapted from listmonk cmd/handlers.go at 6fcd95f.
import type { Roles } from "@/roles/roles";
import { registerRoleRoutes } from "@/roles/routes";
import type { Router } from "@/server/router";
import { hasID } from "@/server/validation";
import { ok } from "@/server/response";
import type { Authentication } from "@/users/auth";
import { createFactorHandlers } from "@/users/factor";
import { createUserHandlers } from "@/users/handlers";
import { createLoginHandlers } from "@/users/login";
import type { UserStore } from "@/users/store";

export function registerUserRoutes(
  router: Router,
  store: UserStore,
  roles: Roles,
  auth: Authentication,
): void {
  registerRoleRoutes(router, roles, store, auth);
  const handlers = createUserHandlers(store, roles, auth);
  const login = createLoginHandlers(auth);
  const factor = createFactorHandlers(store, auth);
  router.route("GET", "/api/users/:id/twofa/totp", factor.generate, auth.middleware(), hasID);
  router.route("PUT", "/api/users/:id/twofa", factor.enable, auth.middleware(), hasID);
  router.route("DELETE", "/api/users/:id/twofa", factor.disable, auth.middleware(), hasID);
  router.route("GET", "/admin/login", login.getLogin);
  router.route("POST", "/admin/login", login.postLogin);
  router.route("GET", "/admin/login/twofa", login.getTwofa);
  router.route("POST", "/admin/login/twofa", login.postTwofa);
  router.route("GET", "/api/health", () => ok(true), auth.middleware());
  router.route("GET", "/api/profile", handlers.getProfile, auth.middleware());
  router.route("PUT", "/api/profile", handlers.updateProfile, auth.middleware());
  router.route("GET", "/api/users", handlers.getUsers, auth.middleware("users:get"));
  router.route("GET", "/api/users/:id", handlers.getUser, auth.middleware("users:get"), hasID);
  router.route("POST", "/api/users", handlers.createUser, auth.middleware("users:manage"));
  router.route(
    "PUT",
    "/api/users/:id",
    handlers.updateUser,
    auth.middleware("users:manage"),
    hasID,
  );
  router.route("DELETE", "/api/users", handlers.deleteUsers, auth.middleware("users:manage"));
  router.route(
    "DELETE",
    "/api/users/:id",
    handlers.deleteUser,
    auth.middleware("users:manage"),
    hasID,
  );
  router.route(
    "POST",
    "/api/logout",
    (context) => {
      auth.endSession(context);
      const response = new Response('{"data":true,"redirect_url":null}\n', {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
      if (context.identity?.transport === "session")
        for (const value of auth.clearCookies()) response.headers.append("Set-Cookie", value);
      return response;
    },
    auth.middleware(),
  );
}
