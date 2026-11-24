// B139 (D154): the instance settings for a fixture that wires a project's stores directly. In
// production the instance opens instance.db and hands every project its reader; here it is an
// in-memory instance database with the instance migrations.
import type { Database as SqliteDatabase } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import type { Clock } from "@/clock";
import { instanceMigrations, runMigrations } from "@/db/migrations";
import { createInstanceSettings } from "@/settings/instance";
import { openInstanceDatabase } from "@/projects/instance";
import { pickSide } from "@/settings/keys";
import { createSettings } from "@/settings/store";
import type { SettingsStore } from "@/settings/store";
import { settingsHandlers } from "@/settings/routes";
import { instanceSettingsPage } from "@/admin/instance/routes";
import type { Router } from "@/server/router";
import type { Authentication } from "@/users/auth";

/** In memory, or with `directory` in an instance.db there that a reopened fixture finds again. */
export function createTestInstanceSettings(clock: Clock, directory?: string) {
  const db = directory ? openInstanceDatabase(directory, clock) : new Database(":memory:");
  if (!directory) {
    runMigrations(db, tmpdir(), clock, instanceMigrations);
  }
  const store = createInstanceSettings(db, clock);
  return {
    read: store.read,
    reader: store.reader,
    update: store.update,
    close() {
      store.close();
      db.close();
    },
  };
}
export type TestInstanceSettings = ReturnType<typeof createTestInstanceSettings>;

/**
 * `/api/instance/settings` on an in-process fixture's router, with the instance settings handlers
 * production serves on the instance host. The instance session and CSRF belong to the instance router
 * (test/projects covers them); here the fixture's project authentication stands in for them, so a
 * fixture test changes an instance key over HTTP, and reads the instance Settings page, as an admin
 * does on the instance host.
 */
export function registerFixtureInstanceSettingsRoutes(
  router: Router,
  instance: Pick<TestInstanceSettings, "read" | "update">,
  auth: Authentication,
): void {
  const handlers = settingsHandlers({
    side: "instance",
    read: instance.read,
    update: instance.update,
    rootUrl: () => "",
  });
  router.route("GET", "/api/instance/settings", handlers.get, auth.middleware("settings:get"));
  router.route(
    "GET",
    "/admin/instance/settings",
    (context) =>
      new Response(instanceSettingsPage(context.app.i18n, "http://fixture.test"), {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }),
    auth.middleware("settings:get"),
  );
  router.route(
    "PUT",
    "/api/instance/settings",
    (context) =>
      handlers.putAll(context.request, () => auth.revalidate(context, "settings:manage")),
    auth.middleware("settings:manage"),
  );
  router.route(
    "PUT",
    "/api/instance/settings/:key",
    (context) =>
      handlers.putKey(context.request, context.params.key ?? "", () =>
        auth.revalidate(context, "settings:manage"),
      ),
    auth.middleware("settings:manage"),
  );
}

/**
 * A project's settings store over its own instance settings, as a fixture used one store before the
 * split: `update` writes the instance keys `build` changed to the instance, then the project keys to
 * the project (two writes, as two requests would make), and `close` closes both.
 */
export function createFixtureSettings(
  db: SqliteDatabase,
  clock: Clock,
  rootUrl: string,
): SettingsStore & { readonly instance: TestInstanceSettings } {
  const instance = createTestInstanceSettings(clock);
  const project = createSettings(db, clock, rootUrl, instance.reader);
  return {
    ...project,
    instance,
    update(build) {
      const next = build(structuredClone(project.read()));
      // A build that returns project keys only (the routes' builds) leaves the instance as it is.
      const shared = { ...structuredClone(instance.read()), ...pickSide(next, "instance") };
      if (JSON.stringify(shared) !== JSON.stringify(instance.read())) {
        instance.update(() => shared);
      }
      project.update(() => next);
    },
    close() {
      project.close();
      instance.close();
    },
  };
}
