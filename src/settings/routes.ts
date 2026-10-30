// Settings endpoints adapted from listmonk cmd/settings.go and cmd/handlers.go at 6fcd95f.
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { readBodyBytes } from "@/users/input";
import type { Authentication } from "@/users/auth";
import type { SettingsStore } from "@/settings/store";
import { bindFull, bindKey, hasField, masked, shapes } from "@/settings/validate";
import { decodeJsonBytes, orderedJson } from "@/settings/json";
import { xmlSettings, xmlValue } from "@/settings/xml";

export function registerSettingsRoutes(
  router: Router,
  settings: SettingsStore,
  auth: Authentication,
  smtpTest?: (body: unknown, revalidate: () => void) => Promise<void>,
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
      const bytes = await readBodyBytes(context.request);
      const contentType = context.request.headers.get("content-type") ?? "";
      const media = contentType.split(";", 1)[0]?.trim();
      let body: unknown;
      try {
        if (!bytes.length) body = {};
        else if (media === "application/json") body = orderedJson(decodeJsonBytes(bytes));
        else if (media === "application/xml" || media === "text/xml")
          body = xmlSettings(bytes, shapes);
        else if (media === "application/x-www-form-urlencoded") {
          const form = bytes.toString("utf8");
          if (/%(?![0-9a-fA-F]{2})/.test(form) || form.includes(";")) throw new Error("form");
          body = {};
        } else if (media === "multipart/form-data") {
          await new Request("http://fixture.invalid", {
            method: "POST",
            headers: { "content-type": contentType },
            body: Uint8Array.from(bytes),
          }).formData();
          body = {};
        } else throw new HttpError(415);
      } catch {
        if (
          bytes.length &&
          ![
            "application/json",
            "application/xml",
            "text/xml",
            "application/x-www-form-urlencoded",
            "multipart/form-data",
          ].includes(media ?? "")
        )
          throw new HttpError(415);
        throw new HttpError(400);
      }
      auth.revalidate(context, "settings:manage");
      settings.update((current) => {
        const next = bindFull(body, current["app.root_url"]);
        // listmonk clients replace the full object without these native keys; keep them.
        for (const native of [
          "marketing.min_interval",
          "webhooks.block_private_addresses",
          "security.trusted_proxies",
          "security.public_rate_limit",
        ])
          if (!hasField(body, native)) next[native] = current[native];
        return next;
      });
      return ok(true);
    },
    auth.middleware("settings:manage"),
  );
  router.route(
    "PUT",
    "/api/settings/:key",
    async (context) => {
      const bytes = await readBodyBytes(context.request);
      const media = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (
        bytes.length &&
        ![
          "application/json",
          "application/xml",
          "text/xml",
          "application/x-www-form-urlencoded",
          "multipart/form-data",
        ].includes(media ?? "")
      )
        throw new HttpError(415);
      let body: unknown;
      try {
        if (media === "application/xml" || media === "text/xml")
          body = orderedJson(xmlValue(bytes));
        else if (media === "application/json") body = orderedJson(decodeJsonBytes(bytes));
        else throw new Error("invalid raw value");
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
    async (context) => {
      const bytes = await readBodyBytes(context.request);
      let body: unknown;
      try {
        body = JSON.parse(decodeJsonBytes(bytes));
      } catch {
        throw new HttpError(400, "Invalid data.");
      }
      auth.revalidate(context, "settings:manage");
      if (!smtpTest) throw new HttpError(501, "SMTP test is unavailable");
      await smtpTest(body, () => auth.revalidate(context, "settings:manage"));
      return ok([]);
    },
    auth.middleware("settings:manage"),
  );
}
