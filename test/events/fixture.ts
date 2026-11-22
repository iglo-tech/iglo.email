// In-process production owners for the subscriber events API with a fake clock.
import { fixturePageSite } from "@/test/public/site";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createListReferences } from "@/lists/references";
import { registerListRoutes } from "@/lists/routes";
import { createListStore } from "@/lists/store";
import { createListCounts } from "@/subscribers/list-counts";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { allowedDomain } from "@/subscribers/email";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberStore } from "@/subscribers/store";
import { createEventStore } from "@/events/store";
import type { ExitThenTrigger } from "@/events/store";
import { registerEventRoutes } from "@/events/routes";
import { createEventPurge } from "@/events/retention";
import { startPurge } from "@/loops/purge";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

export async function eventsFixture(
  options: {
    exitThenTrigger?: ExitThenTrigger;
    domains?: { allow?: Array<string>; block?: Array<string> };
    /** The app's language code, as the settings choose it. */
    language?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "iglo-events-"));
  const clock = new TestClock();
  const errors: Array<unknown> = [];
  const open = async () => {
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
      i18n: createTranslation(options.language),
      logger: {
        error: (error) => errors.push(error),
        attention: (message) => errors.push(new Error(message)),
      },
    });
    const lists = createListReferences(db),
      counts = createListCounts(db),
      campaigns = createCampaignListReferences(db),
      listStore = createListStore(db, clock, counts, campaigns),
      roles = createRoles(db, lists),
      users = createUserStore(db, clock, roles),
      subscribers = createSubscriberStore(db, clock, lists);
    const auth = await createAuthentication(
      users,
      roles,
      clock,
      "http://fixture.test",
      defaultAuthPolicy,
    );
    await bootstrapAdmin(users, auth, admin);
    const events = createEventStore(db, subscribers, {
      emailAllowed: (email) =>
        allowedDomain(email, options.domains?.allow ?? [], options.domains?.block ?? []),
      ...(options.exitThenTrigger ? { exitThenTrigger: options.exitThenTrigger } : {}),
      i18n: app.i18n,
    });
    const router = createRouter();
    registerUserRoutes(router, users, roles, auth, fixturePageSite);
    registerSubscriberRoutes(router, subscribers, roles, auth);
    registerListRoutes(router, listStore, roles, auth);
    registerEventRoutes(router, events, auth, roles);
    return {
      db,
      app,
      users,
      roles,
      lists,
      counts,
      campaigns,
      listStore,
      subscribers,
      auth,
      events,
      router,
    };
  };
  let current = await open();
  const session = await current.auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) {
    throw new Error("fixture login failed");
  }
  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    current.router.handle(current.app, new Request(`http://fixture.test${path}`, init));
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
  /** An API user whose role grants exactly `permissions`, and list grants like `{ id, permissions }`. */
  const apiUser = async (name: string, permissions: Array<string>, lists?: Array<object>) => {
    const role = await json("/api/roles/users", "POST", { name, permissions });
    if (role.status !== 200) {
      throw new Error(`role ${role.status}`);
    }
    const listRole = lists && (await json("/api/roles/lists", "POST", { name, lists }));
    if (listRole && listRole.status !== 200) {
      throw new Error(`list role ${listRole.status}`);
    }
    const user = await json("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
      ...(listRole ? { list_role_id: listRole.body.data.id } : {}),
    });
    if (user.status !== 200) {
      throw new Error(`user ${user.status}`);
    }
    return { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` };
  };
  // Events that grant lists need subscribers:manage and list management too (D99).
  const api = await apiUser("events-api", [
    "subscriber_events:create",
    "subscribers:manage",
    "lists:manage_all",
  ]);
  const post = (body: unknown, headers: Record<string, string> = api) =>
    json("/api/subscriber-events", "POST", body, headers);
  /** A single-event POST whose body arrives through a caller-controlled stream. */
  const postStream = async (body: ReadableStream<Uint8Array>) => {
    const response = await request("/api/subscriber-events", {
      method: "POST",
      headers: { ...api, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await response.text();
    return { status: response.status };
  };
  const batch = (body: unknown, headers: Record<string, string> = api) =>
    json("/api/subscriber-events/batch", "POST", body, headers);
  const subscriber = async (id: number) => (await json(`/api/subscribers/${id}`)).body?.data;
  /** A list of the given opt-in kind, created through the admin API. */
  const list = async (name: string, optin = "single") => {
    const created = await json("/api/lists", "POST", { name, type: "public", optin });
    if (created.status !== 200) {
      throw new Error(`list ${created.status}`);
    }
    return created.body.data.id as number;
  };
  const count = (table: "events" | "subscribers") =>
    Number((current.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
  const close = () => {
    current.events.close();
    current.subscribers.close();
    current.users.close();
    current.roles.close();
    current.listStore.close();
    current.counts.close();
    current.campaigns.close();
    current.lists.close();
    current.db.close(true);
  };
  return {
    clock,
    errors,
    api,
    sessionHeaders,
    get db() {
      return current.db;
    },
    get events() {
      return current.events;
    },
    get app() {
      return current.app;
    },
    request,
    json,
    apiUser,
    post,
    postStream,
    batch,
    subscriber,
    list,
    count,
    /** Reopen every owner over the same data directory, as after a process restart. */
    async restart() {
      close();
      current = await open();
    },
    retention: (retention: { batchSize?: number } = {}) =>
      startPurge({
        db: current.db,
        clock,
        logger: {
          error: (error) => errors.push(error),
          attention: (message) => errors.push(new Error(message)),
        },
        purges: [createEventPurge(current.events)],
        ...retention,
      }),
    close() {
      close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type EventsFixture = Awaited<ReturnType<typeof eventsFixture>>;
