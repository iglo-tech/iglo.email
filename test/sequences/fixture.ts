// In-process production owners for sequences, enrollments and their event, subscriber and
// unsubscribe seams, with a fake clock and a loopback SMTP sink, wired as src/main.ts does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { allowedDomain } from "@/subscribers/email";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { registerTxRoutes } from "@/tx/routes";
import { createEmbeds } from "@/media/embed";
import { createEventStore } from "@/events/store";
import { registerEventRoutes } from "@/events/routes";
import { createEnrollments } from "@/sequences/enrollments";
import { createSequenceStore } from "@/sequences/store";
import { registerSequenceRoutes } from "@/sequences/routes";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { createMarketingPolicy, type MarketingSettings } from "@/unsubscribe/policy";
import { registerUnsubscribeRoutes } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";

export const admin = {
  user: "fixture-admin",
  password: "fixture-admin-password",
};

export async function sequencesFixture() {
  const sink = await startSink({});
  const directory = mkdtempSync(join(tmpdir(), "iglo-sequences-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: unknown[] = [];
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
  const enrollments = createEnrollments(db, clock);
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    subscribers = createSubscriberStore(db, clock, lists, enrollments.subscriberEffects),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const readonly = openReadOnly(db.filename);
  const runner = createQueryRunner({
    path: db.filename,
    timeoutMs: 10_000,
    concurrency: 2,
  });
  const query = createSubscriberQuery({
    db,
    readonly,
    clock,
    runner,
    effects: enrollments.subscriberEffects,
  });
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("fixture login failed");
  const renderer = createRenderer(clock, app.i18n);
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateReferences);
  templates.initialize();
  const emailer = createEmailer({
    clock,
    settings: () => ({
      rootUrl: "http://fixture.test",
      smtp: [
        {
          name: "fixture",
          enabled: true,
          exclude_from_default: false,
          host: "127.0.0.1",
          port: sink.port,
          hello_hostname: "fixture.test",
          max_conns: 4,
          idle_timeout: "2s",
          wait_timeout: "2s",
          auth_protocol: "none",
          username: "",
          tls_type: "none",
          tls_skip_verify: false,
          email_headers: [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
  });
  const marketing: MarketingSettings = {
    rootUrl: "http://fixture.test",
    siteName: "Fixture list",
    minInterval: "",
    unsubscribeHeader: true,
    allowBlocklist: true,
    individualTracking: false,
    disableTracking: false,
  };
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    marketingPolicy: createMarketingPolicy({
      subscribers,
      lists,
      settings: () => marketing,
    }),
  });
  const tracking = createTracking(db, clock);
  const outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const events = createEventStore(db, subscribers, {
    emailAllowed: (email) => allowedDomain(email, [], []),
    exitThenTrigger: enrollments.exitThenTrigger,
  });
  const sequences = createSequenceStore(db, clock, {
    templates,
    lists,
    enrollments,
  });
  const router = createRouter();
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerSubscriberQueryRoutes(router, query, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth);
  registerSendRoutes(router, sends, auth);
  registerTxRoutes(router, {
    auth,
    sends,
    outbox: { dispatch: (ids: bigint[]) => outbox.dispatch(ids) },
    subscribers,
    templates,
    renderer,
    lists,
    policy: () => ({
      fromEmail: "Fixture <noreply@fixture.test>",
      domainAllowlist: [],
      domainBlocklist: [],
    }),
    marketing: { settings: () => marketing, tracking },
    attachments: async () => [],
    embedImages: createEmbeds({ byFilename: () => null }, app.logger),
  });
  registerUnsubscribeRoutes(router, {
    db,
    sends,
    subscribers,
    tracking,
    settings: () => marketing,
    effects: enrollments.unsubscribeEffects,
  });
  registerEventRoutes(router, events, auth);
  registerSequenceRoutes(router, {
    sequences,
    enrollments,
    subscribers,
    roles,
    auth,
  });

  const sessionHeaders = {
    cookie: `session=${session.id}`,
    "x-csrf-token": session.csrf,
  };
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
  /** An API user whose role grants exactly `permissions`, optionally with a list role. */
  let roleCount = 0;
  const apiUser = async (
    permissions: string[],
    listPermissions?: { id: number; permissions: string[] }[],
  ) => {
    const name = `api-${++roleCount}`;
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
    return {
      authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}`,
    };
  };
  const template = async (type = "tx", body = "<p>{{ subscriber.name }}</p>") => {
    const created = await json("/api/templates", "POST", {
      name: `fixture ${type}`,
      type,
      subject: type === "tx" ? "Hello" : "",
      body: type === "campaign" ? `${body}{{ content | raw }}` : body,
    });
    if (created.status !== 200) throw new Error(`template ${created.status}`);
    return created.body.data.id as number;
  };
  const list = async (name: string) =>
    (
      await json("/api/lists", "POST", {
        name,
        type: "public",
        optin: "single",
      })
    ).body.data.id as number;
  const subscriber = async (email: string, extra: object = {}) => {
    const created = await json("/api/subscribers", "POST", {
      email,
      name: "Fixture",
      ...extra,
    });
    if (created.status !== 200) throw new Error(`subscriber ${created.status}`);
    return created.body.data.id as number;
  };
  const event = (body: object, headers: Record<string, string> = sessionHeaders) =>
    json("/api/subscriber-events", "POST", body, headers);
  /** Rows of an owned table, for checks that nothing partial was written. */
  const count = (table: "sequences" | "sequence_steps" | "enrollments" | "events") =>
    Number((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
  return {
    app,
    db,
    clock,
    sink,
    errors,
    sessionHeaders,
    request,
    json,
    apiUser,
    template,
    list,
    subscriber,
    event,
    count,
    sends,
    async close() {
      const stopped = outbox.stop();
      await emailer.close();
      await stopped;
      await runner.close();
      sequences.close();
      enrollments.close();
      events.close();
      query.close();
      readonly.close();
      sends.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
      subscribers.close();
      listStore.close();
      counts.close();
      campaigns.close();
      lists.close();
      db.close(true);
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type SequencesFixture = Awaited<ReturnType<typeof sequencesFixture>>;
