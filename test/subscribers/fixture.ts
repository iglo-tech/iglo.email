// In-process production owners for the subscriber query, export and query-selected actions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { registerListRoutes } from "@/lists/routes";
import { createListStore } from "@/lists/store";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createListCounts } from "@/subscribers/list-counts";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberStore } from "@/subscribers/store";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

export async function queryFixture(
  options: { timeoutMs?: number; admissionMs?: number; command?: string[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "iglo-query-"));
  const clock = new TestClock();
  const errors: unknown[] = [];
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      rootUrl: "http://fixture.test",
      initialAdmin: admin,
    },
    db,
    clock,
    i18n: createTranslation(),
    logger: { error: (error) => errors.push(error) },
  });
  const lists = createListReferences(db),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles),
    subscribers = createSubscriberStore(db, clock, lists),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    readonly = openReadOnly(db.filename),
    runner = createQueryRunner({
      path: db.filename,
      timeoutMs: options.timeoutMs ?? 10_000,
      concurrency: 2,
      ...(options.admissionMs === undefined ? {} : { admissionMs: options.admissionMs }),
      ...(options.command === undefined ? {} : { command: options.command }),
    }),
    query = createSubscriberQuery({ db, readonly, clock, runner });
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, admin);
  const router = createRouter();
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerSubscriberQueryRoutes(router, query, subscribers, roles, auth);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("fixture login failed");
  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`http://fixture.test${path}`, init));
  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = sessionHeaders,
  ) => {
    const response = await request(path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  /** An API user with exactly these user permissions and optional per-list permissions. */
  const apiUser = async (
    name: string,
    permissions: string[],
    listPermissions?: { id: number; permissions: string[] }[],
  ) => {
    const role = await json("/api/roles/users", "POST", { name, permissions });
    if (role.status !== 200) throw new Error(`role ${role.status}`);
    let listRole: number | undefined;
    if (listPermissions) {
      const created = await json("/api/roles/lists", "POST", {
        name: `${name}-lists`,
        lists: listPermissions,
      });
      if (created.status !== 200) throw new Error(`list role ${created.status}`);
      listRole = created.body.data.id;
    }
    const user = await json("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
      ...(listRole === undefined ? {} : { list_role_id: listRole }),
    });
    if (user.status !== 200) throw new Error(`user ${user.status}`);
    return { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` };
  };
  return {
    db,
    clock,
    errors,
    runner,
    sessionHeaders,
    request,
    json,
    apiUser,
    async close() {
      await runner.close();
      query.close();
      readonly.close();
      listStore.close();
      campaigns.close();
      counts.close();
      subscribers.close();
      users.close();
      roles.close();
      lists.close();
      db.close(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type QueryFixture = Awaited<ReturnType<typeof queryFixture>>;
