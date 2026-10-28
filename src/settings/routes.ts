// Settings endpoints adapted from listmonk cmd/settings.go and cmd/handlers.go at 6fcd95f.
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { readBody } from "@/users/input";
import type { Authentication } from "@/users/auth";
import type { SettingsStore } from "@/settings/store";
import { bindFull, bindKey, masked } from "@/settings/validate";

export function registerSettingsRoutes(
  router: Router,
  settings: SettingsStore,
  auth: Authentication,
): void {
  router.route(
    "GET",
    "/api/settings",
    () => ok(masked(settings.read())),
    auth.middleware("settings:get"),
  );
  router.route(
    "PUT",
    "/api/settings",
    async (context) => {
      const text = await readBody(context.request);
      if (
        text &&
        context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new HttpError(415);
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400);
      }
      auth.revalidate(context, "settings:manage");
      settings.update((current) => bindFull(body, current["app.root_url"]));
      return ok(true);
    },
    auth.middleware("settings:manage"),
  );
  router.route(
    "PUT",
    "/api/settings/:key",
    async (context) => {
      const text = await readBody(context.request);
      if (
        text &&
        context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new HttpError(415);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400);
      }
      auth.revalidate(context, "settings:manage");
      settings.update((current) => bindKey(current, context.params.key ?? "", body));
      return ok(true);
    },
    auth.middleware("settings:manage"),
  );
  router.route(
    "POST",
    "/api/settings/smtp/test",
    () => {
      throw new HttpError(501, "SMTP test is not implemented until M2.1");
    },
    auth.middleware("settings:manage"),
  );
}
