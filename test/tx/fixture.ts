// In-process production owners for POST /api/tx, with a loopback SMTP sink.
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
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
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
import { registerTxRoutes, type TxPolicy } from "@/tx/routes";
import type { Clock } from "@/clock";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

export async function txFixture(
  options: {
    reject?: () => boolean;
    policy?: Partial<TxPolicy>;
    clock?: Clock;
    emailHeaders?: Record<string, string>[];
  } = {},
) {
  const sink = await startSink(options.reject ? { reject: options.reject } : {});
  const directory = mkdtempSync(join(tmpdir(), "iglo-tx-"));
  const testClock = new TestClock();
  const clock = options.clock ?? testClock;
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
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    subscribers = createSubscriberStore(db, clock, lists),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
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
  const templates = createTemplateStore(db, clock, renderer, templateReferences, app.logger);
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
          email_headers: options.emailHeaders ?? [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
  });
  const sends = createSends({ db, clock, subscribers, rootUrl: () => "http://fixture.test" });
  let outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const router = createRouter();
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
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
      ...options.policy,
    }),
  });
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
  const tx = (body: unknown, headers: Record<string, string> = sessionHeaders) =>
    json("/api/tx", "POST", body, headers);
  const template = async (body: string, subject = "Subject {{ data.order }}", type = "tx") => {
    const created = await json("/api/templates", "POST", { name: "fixture", type, subject, body });
    if (created.status !== 200) throw new Error(`template ${created.status}`);
    return created.body.data.id as number;
  };
  const subscriber = async (email: string, name = "Fixture Person", extra: object = {}) => {
    const created = await json("/api/subscribers", "POST", { email, name, ...extra });
    if (created.status !== 200) throw new Error(`subscriber ${created.status}`);
    return created.body.data.id as number;
  };
  return {
    app,
    db,
    clock: testClock,
    auth,
    session,
    sessionHeaders,
    sink,
    errors,
    request,
    json,
    tx,
    template,
    subscriber,
    sends,
    get outbox() {
      return outbox;
    },
    /** Stop delivery so queued rows stay queued, as during downtime. */
    stopOutbox: () => outbox.stop(),
    /** A fresh outbox over the same journal, as after a process restart. */
    restartOutbox() {
      outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
    },
    count: () => Number((db.query("SELECT count(*) AS n FROM sends").get() as { n: bigint }).n),
    async close() {
      const stopped = outbox.stop();
      await emailer.close();
      await stopped;
      sends.close();
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
export type TxFixture = Awaited<ReturnType<typeof txFixture>>;
