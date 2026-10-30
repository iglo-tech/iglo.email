// In-process production owners for POST /api/tx, with a loopback SMTP sink.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import type { SubscriberMail } from "@/public/mail";
import { registerPublicRoutes } from "@/public/routes";
import type { PublicSettings } from "@/public/settings";
import type { Middleware } from "@/server/context";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import {
  createSubscriberStore,
  noSubscriberEffects,
  type SubscriberEffects,
} from "@/subscribers/store";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { createSendAnonymizer } from "@/messaging/anonymize";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";
import { createTemplateStore } from "@/templates/store";
import type { PageOptions } from "@/public/preferences";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { registerTxRoutes, type TxPolicy } from "@/tx/routes";
import type { Clock } from "@/clock";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { createMarketingPolicy, type MarketingSettings } from "@/unsubscribe/policy";
import { registerUnsubscribeRoutes, type UnsubscribeEffects } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";
import { startWebhookDelivery, type WebhookTransport } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

export async function txFixture(
  options: {
    reject?: () => boolean;
    policy?: Partial<TxPolicy>;
    clock?: Clock;
    emailHeaders?: Record<string, string>[];
    marketing?: Partial<MarketingSettings>;
    effects?: UnsubscribeEffects;
    page?: () => PageOptions;
    /** Wire the production webhook owners, with this transport. */
    webhooks?: WebhookTransport;
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
    webhooks = options.webhooks ? createWebhookStore(db, clock) : undefined,
    webhookEffects = webhooks && createWebhookEffects(webhooks, () => subscribers),
    anonymize = createSendAnonymizer(db),
    subscriberEffects: SubscriberEffects = {
      ...noSubscriberEffects,
      ...webhookEffects?.subscriberEffects,
      deleting(deleted, wipe) {
        anonymize(deleted);
        webhookEffects?.deleting(deleted, wipe);
      },
    },
    subscribers: ReturnType<typeof createSubscriberStore> = createSubscriberStore(
      db,
      clock,
      lists,
      subscriberEffects,
    ),
    readonly = webhooks && openReadOnly(db.filename),
    runner =
      webhooks && createQueryRunner({ path: db.filename, timeoutMs: 10_000, concurrency: 2 }),
    subscriberQuery =
      readonly &&
      runner &&
      createSubscriberQuery({ db, readonly, clock, runner, effects: subscriberEffects }),
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
          email_headers: options.emailHeaders ?? [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
  });
  // Production marketing settings defaults (settings/defaults.ts), mutable per test.
  const marketing: MarketingSettings = {
    rootUrl: "http://fixture.test",
    siteName: "Fixture list",
    minInterval: "P7D",
    unsubscribeHeader: true,
    allowBlocklist: true,
    individualTracking: false,
    disableTracking: false,
    ...options.marketing,
  };
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    ...(webhookEffects ? { ended: webhookEffects.sendEnded } : {}),
    marketingPolicy: createMarketingPolicy({ subscribers, lists, settings: () => marketing }),
  });
  const tracking = createTracking(db, clock);
  let outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const router = createRouter();
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  if (subscriberQuery)
    registerSubscriberQueryRoutes(router, subscriberQuery, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth);
  registerSendRoutes(router, sends, auth);
  if (webhooks) registerWebhookRoutes(router, { webhooks, auth });
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
    marketing: { settings: () => marketing, tracking },
  });
  registerUnsubscribeRoutes(router, {
    db,
    sends,
    subscribers,
    tracking,
    settings: () => marketing,
    ...(options.effects ? { effects: options.effects } : {}),
    ...(options.page ? { page: options.page } : {}),
  });
  if (webhooks) {
    // Only the public wipe is reached here: it sends no mail and reads one setting.
    const open: Middleware = (_context, next) => next();
    registerPublicRoutes(router, {
      db,
      lists,
      subscribers,
      mail: {} as SubscriberMail,
      settings: () => ({ allowWipe: true }) as PublicSettings,
      limits: { subscribe: open, optin: open, privacy: open },
      clientAddress: () => "127.0.0.1",
    });
  }
  const blockPrivate = { value: false };
  const startDelivery = () =>
    webhooks
      ? startWebhookDelivery({
          db,
          clock,
          logger: app.logger,
          webhooks,
          blockPrivate: () => blockPrivate.value,
          transport: options.webhooks!,
        })
      : undefined;
  let delivery = startDelivery();
  // The loop's zero-length yields need no time to pass, only a turn of the injected clock.
  const pump = webhooks ? setInterval(() => testClock.advance(0), 1) : undefined;
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
    directory,
    errors,
    request,
    json,
    tx,
    template,
    subscriber,
    sends,
    emailer,
    marketing,
    owners: { router, lists, subscribers, tracking, renderer, templates, roles },
    get outbox() {
      return outbox;
    },
    /** Stop delivery so queued rows stay queued, as during downtime. */
    stopOutbox: () => outbox.stop(),
    /** A fresh outbox over the same journal, as after a process restart. */
    restartOutbox() {
      outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
    },
    webhooks,
    blockPrivate,
    /** Move the injected clock, then let the delivery loop see it without its idle poll. */
    advanceWebhooks(milliseconds: number) {
      testClock.advance(milliseconds);
      delivery?.wake();
    },
    /** Stop the loop and drop what it knew; a held attempt's row keeps only its lease. */
    async crashWebhooks() {
      await delivery?.halt();
    },
    /** A fresh loop over the same rows, as after a process restart. */
    startWebhooks() {
      delivery = startDelivery();
    },
    count: () => Number((db.query("SELECT count(*) AS n FROM sends").get() as { n: bigint }).n),
    async close() {
      await delivery?.halt();
      clearInterval(pump);
      webhooks?.close();
      const stopped = outbox.stop();
      await emailer.close();
      await stopped;
      sends.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
      subscriberQuery?.close();
      await runner?.close();
      readonly?.close();
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
