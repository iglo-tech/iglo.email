// Settings endpoints adapted from listmonk cmd/settings.go and cmd/handlers.go at 6fcd95f.
// B139 (14-projects section 4, D154): a project host serves its project keys on /api/settings; the
// instance host serves the instance keys on /api/instance/settings (src/admin/instance/routes.tsx).
// Both take the same bodies with the same rules; a key of the other side, or no key, is a 400 that
// names it, with nothing written. Each request writes one database.
import { refuseWhileHeld } from "@/settings/hold";
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { readBodyBytes } from "@/users/input";
import type { Authentication } from "@/users/auth";
import type { SettingsStore } from "@/settings/store";
import { isSettingKey, settingSides } from "@/settings/keys";
import type { SettingsSide } from "@/settings/keys";
import { bindFull, bindKey, bodyFields, hasField, masked, shapes } from "@/settings/validate";
import type { Settings } from "@/settings/validate";
import { decodeJsonBytes, orderedJson } from "@/settings/json";
import { xmlSettings, xmlValue } from "@/settings/xml";

const bodyMedia = new Set([
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

/**
 * The native keys a listmonk client's full write leaves out: every key of a side that listmonk's
 * settings API does not serve (models/settings.go at 6fcd95f). A full write without one keeps it
 * (D193; test/settings/native-keys.test.ts fails on a native key missing here).
 * `source.password` is not one: left out it is blank, which keeps the stored password only for the
 * same source URL and identity (src/sources/settings.ts), so it never follows a new URL.
 */
const nativeKeys: Record<SettingsSide, ReadonlyArray<string>> = {
  project: [
    "app.site_url",
    "privacy.preference_fields",
    "marketing.min_interval",
    "security.public_rate_limit",
    "source.url",
    "source.auth_collection",
    "source.identity",
    "source.events",
    "source.recipients",
    "source.users",
    "source.grant_lists",
    "appearance.brand.accent",
    "appearance.brand.font",
    "appearance.brand.header",
  ],
  instance: [
    "messaging.max_send_rate",
    "bounce.ses_topic_arns",
    "webhooks.block_private_addresses",
    "sources.private_hosts",
    "security.trusted_proxies",
    "ses.api_region",
    "ses.api_access_key_id",
    "ses.api_secret_access_key",
  ],
};

/** A project's public custom CSS and JS, as the instance reads and writes them (D201). */
export interface CustomCode {
  readonly css: string;
  readonly js: string;
  /** The stored script is held back, served empty, until the instance admin saves it (D201). */
  readonly jsHeld: boolean;
}

/** The instance's write of them: a field left undefined keeps its stored value. */
export interface CustomCodeChange {
  readonly css: string | undefined;
  readonly js: string | undefined;
}

/**
 * Project keys only the instance admin writes (D201): the public custom CSS and JS, which run on
 * the project's pages beside its users' sessions. A project write leaves them as stored: one that
 * omits them or repeats the stored value succeeds, one that changes them is a 403 naming the key.
 */
const instanceAuthored = ["appearance.public.custom_css", "appearance.public.custom_js"];

function keepInstanceAuthored(next: Settings, current: Settings, body?: unknown): void {
  for (const key of instanceAuthored) {
    if (body !== undefined && !hasField(body, key)) {
      next[key] = current[key];
    } else if (next[key] !== current[key]) {
      throw new HttpError(
        403,
        `${key} is set by the instance admin: change it on the instance host's Projects page.`,
      );
    }
  }
}

const refusal = (side: SettingsSide, key: string) =>
  new HttpError(
    400,
    side === "project"
      ? `Not a project setting: ${key}. Instance settings are changed on the instance host.`
      : `Not an instance setting: ${key}. Project settings are changed on the project's host.`,
  );

/** Whether `key` is one of `side`'s keys. */
export function onSide(key: string, side: SettingsSide): boolean {
  return isSettingKey(key) && settingSides[key] === side;
}

/** A body's media type, without its parameters. */
const mediaOf = (request: Request) =>
  request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";

/** A full-write body as listmonk decodes it: JSON, XML, or a form that binds nothing. */
async function decodeFull(request: Request, bytes: Buffer): Promise<{ value: unknown }> {
  const contentType = request.headers.get("content-type") ?? "";
  const media = mediaOf(request);
  try {
    if (!bytes.length) {
      return { value: {} };
    }
    if (media === "application/json") {
      return { value: orderedJson(decodeJsonBytes(bytes)) };
    }
    if (media === "application/xml" || media === "text/xml") {
      return { value: xmlSettings(bytes, shapes) };
    }
    if (media === "application/x-www-form-urlencoded") {
      const form = bytes.toString("utf-8");
      if (/%(?![0-9a-fA-F]{2})/.test(form) || form.includes(";")) {
        throw new Error("form");
      }
      return { value: {} };
    }
    if (media === "multipart/form-data") {
      await new Request("http://fixture.invalid", {
        method: "POST",
        headers: { "content-type": contentType },
        body: Uint8Array.from(bytes),
      }).formData();
      return { value: {} };
    }
    throw new HttpError(415);
  } catch {
    if (bytes.length && !bodyMedia.has(media)) {
      throw new HttpError(415);
    }
    throw new HttpError(400);
  }
}

/** A one-key body: JSON or XML. */
function decodeKey(request: Request, bytes: Buffer): { value: unknown } {
  const media = mediaOf(request);
  if (bytes.length && !bodyMedia.has(media)) {
    throw new HttpError(415);
  }
  try {
    if (media === "application/xml" || media === "text/xml") {
      return { value: orderedJson(xmlValue(bytes)) };
    }
    if (media === "application/json") {
      return { value: orderedJson(decodeJsonBytes(bytes)) };
    }
    throw new Error("invalid raw value");
  } catch {
    throw new HttpError(400);
  }
}

/** One side's settings API: what the project routes below and the instance routes both serve. */
export interface SettingsApi {
  readonly side: SettingsSide;
  /** This side's keys (the project's with `app.root_url`). */
  read(): Settings;
  /** Writes this side's keys `build` returns; the current value holds at least this side's keys. */
  update(build: (current: Settings) => Settings): void;
  /** `app.root_url` for the full write's binding. */
  rootUrl(): string;
  /** Another owner's rule on a change; throws inside the settings transaction to refuse it. */
  check?: (next: Settings, current: Settings) => void;
}

export function settingsHandlers(api: SettingsApi) {
  const { side } = api;
  return {
    get: () => ok(masked(api.read())),
    /** `PUT …/settings`: the whole side replaced, as listmonk replaces the whole object. */
    async putAll(request: Request, revalidate: () => void): Promise<Response> {
      const { value: body } = await decodeFull(request, await readBodyBytes(request));
      // A caller who may no longer write learns nothing about the body: 403 before any 400.
      revalidate();
      for (const [name, key] of bodyFields(body)) {
        // The read-only root URL comes back from a project's GET, so a project write ignores it.
        const ignored = side === "project" && name.toLowerCase() === "app.root_url";
        if (!ignored && !(key && onSide(key, side))) {
          throw refusal(side, name);
        }
      }
      api.update((current) => {
        const bound = bindFull(body, api.rootUrl());
        const next: Settings = {};
        for (const key of Object.keys(settingSides)) {
          if (onSide(key, side)) {
            next[key] = bound[key];
          }
        }
        // listmonk clients replace the full object without these native keys; keep them.
        for (const native of nativeKeys[side]) {
          if (!hasField(body, native)) {
            next[native] = current[native];
          }
        }
        if (side === "project") {
          next["app.root_url"] = current["app.root_url"];
          keepInstanceAuthored(next, current, body);
        }
        api.check?.(next, current);
        return next;
      });
      return ok(true);
    },
    /** `PUT …/settings/:key`: one key of this side. */
    async putKey(request: Request, key: string, revalidate: () => void): Promise<Response> {
      const { value: body } = decodeKey(request, await readBodyBytes(request));
      revalidate();
      // The read-only root URL stays the 400 it always was (D14), from bindKey.
      if (!onSide(key, side) && !(side === "project" && key === "app.root_url")) {
        throw refusal(side, key);
      }
      api.update((current) => {
        const next = bindKey(current, key, body);
        // B150a (D170): a one-key write of another source key carries no password, so a stored one
        // is kept only for the same URL and identity, as in a full write.
        if (key.startsWith("source.") && key !== "source.password") {
          next["source.password"] = "";
        }
        if (side === "project") {
          keepInstanceAuthored(next, current);
        }
        api.check?.(next, current);
        return next;
      });
      return ok(true);
    },
  };
}

export function registerSettingsRoutes(
  router: Router,
  settings: SettingsStore,
  auth: Authentication,
  smtpTest?: (body: unknown, revalidate: () => void) => Promise<void>,
  /** Another owner's rule on a change; throws inside the settings transaction to refuse it. */
  check: (next: Settings, current: Settings) => void = () => {},
): void {
  const handlers = settingsHandlers({
    side: "project",
    read: () => settings.readProject(),
    update: (build) => settings.update(build),
    rootUrl: () => String(settings.read()["app.root_url"]),
    check,
  });
  router.route("GET", "/api/settings", handlers.get, auth.middleware("settings:get"));
  router.route(
    "PUT",
    "/api/settings",
    (context) =>
      handlers.putAll(context.request, () => auth.revalidate(context, "settings:manage")),
    auth.middleware("settings:manage"),
  );
  router.route(
    "PUT",
    "/api/settings/:key",
    (context) =>
      handlers.putKey(context.request, context.params.key ?? "", () =>
        auth.revalidate(context, "settings:manage"),
      ),
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
      if (!smtpTest) {
        throw new HttpError(501, "SMTP test is unavailable");
      }
      refuseWhileHeld(context.app.db);
      await smtpTest(body, () => auth.revalidate(context, "settings:manage"));
      return ok([]);
    },
    auth.middleware("settings:manage"),
  );
}
