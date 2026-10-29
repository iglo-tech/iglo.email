// In-process production owners for the subscriber events API with a fake clock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { allowedDomain } from "@/subscribers/email";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberStore } from "@/subscribers/store";
import { createEventStore, type ExitThenTrigger } from "@/events/store";
import { registerEventRoutes } from "@/events/routes";
import { startEventRetention } from "@/events/retention";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

export async function eventsFixture(
  options: {
    exitThenTrigger?: ExitThenTrigger;
    domains?: { allow?: string[]; block?: string[] };
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "iglo-events-"));
  const clock = new TestClock();
  const errors: unknown[] = [];
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
      i18n: createTranslation(),
      logger: { error: (error) => errors.push(error) },
    });
    const lists = createListReferences(db),
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
    });
    const router = createRouter();
    registerUserRoutes(router, users, roles, auth);
    registerSubscriberRoutes(router, subscribers, roles, auth);
    registerEventRoutes(router, events, auth);
    return { db, app, users, roles, lists, subscribers, auth, events, router };
  };
  let current = await open();
  const session = await current.auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("fixture login failed");
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
  /** An API user whose role grants exactly `permissions`. */
  const apiUser = async (name: string, permissions: string[]) => {
    const role = await json("/api/roles/users", "POST", { name, permissions });
    if (role.status !== 200) throw new Error(`role ${role.status}`);
    const user = await json("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
    });
    if (user.status !== 200) throw new Error(`user ${user.status}`);
    return { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` };
  };
  const api = await apiUser("events-api", ["subscriber_events:create"]);
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
  const count = (table: "events" | "subscribers") =>
    Number((current.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
  const close = () => {
    current.events.close();
    current.subscribers.close();
    current.users.close();
    current.roles.close();
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
    request,
    json,
    apiUser,
    post,
    postStream,
    batch,
    subscriber,
    count,
    /** Reopen every owner over the same data directory, as after a process restart. */
    async restart() {
      close();
      current = await open();
    },
    retention: (retention: Partial<Parameters<typeof startEventRetention>[0]> = {}) =>
      startEventRetention({
        db: current.db,
        clock,
        logger: { error: (error) => errors.push(error) },
        events: current.events,
        ...retention,
      }),
    close() {
      close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type EventsFixture = Awaited<ReturnType<typeof eventsFixture>>;
