// Public-boundary tests for admin notification mails (task B38).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { createTranslation } from "@/i18n/i18n";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createListCounts } from "@/subscribers/list-counts";
import { createListStore } from "@/lists/store";
import { createSubscriberStore } from "@/subscribers/store";
import { createRoles } from "@/roles/roles";
import { createUserStore } from "@/users/store";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createRenderer } from "@/templates/renderer";
import { createTemplateStore } from "@/templates/store";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignStore } from "@/campaigns/store";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import { createTracking } from "@/unsubscribe/tracking";
import { createMediaStore } from "@/media/store";
import { createFilesystem } from "@/media/filesystem";
import { createAttachments } from "@/media/attachments";
import { createEmbeds } from "@/media/embed";
import { createSettings } from "@/settings/store";
import { createEmailer } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { registerSendRoutes } from "@/messaging/routes";
import { startOutbox } from "@/messaging/outbox";
import { createWebhookStore } from "@/webhooks/store";
import { createWebhookEffects } from "@/webhooks/effects";
import { createRouter } from "@/server/server";
import { registerCampaignRoutes } from "@/campaigns/routes";
import { registerSettingsRoutes } from "@/settings/routes";
import { registerImportRoutes } from "@/subscribers/import/routes";
import { createImporter } from "@/subscribers/import/importer";
import { createAdminNotifier } from "@/messaging/notify";
import {
  createCampaignRunnerRegistry,
  startCampaignRunner,
  type RunnerSettings,
} from "@/campaigns/runner/runner";
import { createRunnerStore } from "@/campaigns/runner/store";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { startWebhookDelivery } from "@/webhooks/delivery";
import { createSubscriberTracking } from "@/analytics/subscriber";
import { startReceiver } from "@/test/webhooks/receiver";
import { waitWall } from "@/test/wait";

const admin = { user: "fixture-admin", password: "fixture-admin-password" };
const root = "http://fixture.test";

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  clock: TestClock;
  settings: ReturnType<typeof createSettings>;
  campaignStore: ReturnType<typeof createCampaignStore>;
  runnerStore: ReturnType<typeof createRunnerStore>;
  importer: ReturnType<typeof createImporter>;
  sends: ReturnType<typeof createSends>;
  sink: Awaited<ReturnType<typeof startSink>>;
  outbox: ReturnType<typeof startOutbox>;
  subscribers: ReturnType<typeof createSubscriberStore>;
  listStore: ReturnType<typeof createListStore>;
  webhooks: ReturnType<typeof createWebhookStore>;
  effects: ReturnType<typeof createWebhookEffects>;
  startRunner(customSettings?: Partial<RunnerSettings>): ReturnType<typeof startCampaignRunner>;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, method?: string, body?: unknown): Promise<any>;
  createList(name?: string): { id: bigint; uuid: string; name: string };
  drainOutbox(): Promise<void>;
  /** Errors logged through the app logger, in order. */
  errors: unknown[];
  /** Makes the runner's open of a campaign fail when `fn` is true for its audience. */
  failOpen(fn: ((audience: { lists: { id: unknown }[] }) => boolean) | undefined): void;
  /** Advances the clock until `done` holds; fails with `what` if it never does. */
  waitUntil(done: () => boolean, what: string, step?: number, rounds?: number): Promise<void>;
  close(): Promise<void>;
}

async function createNotifyFixture(
  options: {
    notifyEmails?: string[];
    sinkReject?: (to: string) => boolean;
  } = {},
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "iglo-notify-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: unknown[] = [];
  const i18n = createTranslation();
  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      rootUrl: root,
      initialAdmin: admin,
    },
    db,
    clock,
    i18n,
    logger: { error: (error) => errors.push(error) },
  });

  const lists = createListReferences(db);
  const counts = createListCounts(db);
  const listReferences = createCampaignListReferences(db);
  const listStore = createListStore(db, clock, counts, listReferences);
  const subscribers = createSubscriberStore(db, clock, lists);
  const roles = createRoles(db, lists);
  const users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(users, roles, clock, root, defaultAuthPolicy);
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("fixture login failed");

  const sink = await startSink({
    clock,
    reject: options.sinkReject,
  });

  const settingsStore = createSettings(db, clock, root, roles);
  if (options.notifyEmails !== undefined) {
    settingsStore.update((current) => ({
      ...current,
      "app.notify_emails": options.notifyEmails!,
    }));
  }

  const renderer = createRenderer(clock, i18n);
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateReferences);
  templates.initialize();

  const webhooks = createWebhookStore(db, clock);
  const effects = createWebhookEffects(webhooks, () => subscribers);

  const runnerStore = createRunnerStore(db);
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => root,
    ended: effects.sendEnded,
  });

  const emailer = createEmailer({
    clock,
    settings: () => ({
      rootUrl: root,
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
  });

  const outbox = startOutbox({
    db,
    clock,
    logger: app.logger,
    sends,
    emailer,
  });

  const tracking = createTracking(db, clock);
  const media = createMediaStore(db, clock);
  const files = createFilesystem(directory, () => {
    const current = settingsStore.read();
    return {
      uploadPath: current["upload.filesystem.upload_path"],
      uploadUri: current["upload.filesystem.upload_uri"],
    };
  });
  const attachments = createAttachments(media, files);
  const embedImages = createEmbeds(media, app.logger);

  const campaignStore = createCampaignStore(db, clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
    mediaFilename: (id) => media.filename(id),
  });

  const touchLists = (ids: bigint[]) => {
    listStore.touch(ids);
  };

  const notifier = createAdminNotifier({
    sends,
    renderer,
    logger: app.logger,
    settings: () => {
      const current = settingsStore.read();
      return {
        notifyEmails: current["app.notify_emails"],
        fromEmail: current["app.from_email"][0] ?? "",
        rootUrl: current["app.root_url"],
        logoUrl: current["app.logo_url"],
      };
    },
  });

  const importer = createImporter({
    dataDir: directory,
    clock,
    logger: app.logger,
    i18n,
    store: subscribers,
    touchLists,
    domainPolicy: () => ({
      allow: settingsStore.read()["privacy.domain_allowlist"],
      block: settingsStore.read()["privacy.domain_blocklist"],
    }),
    notify: notifier,
  });
  await importer.sweep();

  const router = createRouter();
  const campaignSettings = {
    fromEmail: "Fixture <noreply@fixture.test>",
    rootUrl: root,
    siteName: "Fixture list",
    messengers: ["email", "fixture"],
    unsubscribeHeader: true,
    allowBlocklist: true,
    disableTracking: false,
    individualTracking: false,
  };

  registerCampaignRoutes(router, {
    store: campaignStore,
    templates,
    renderer,
    roles,
    auth,
    lists,
    subscribers,
    tracking,
    emailer,
    settings: () => campaignSettings,
    attachments,
    embedImages,
    notify: notifier,
  });

  const subscriberTracking = createSubscriberTracking(db);
  registerSubscriberRoutes(
    router,
    subscribers,
    roles,
    auth,
    () => ({
      "privacy.domain_allowlist": [],
      "privacy.domain_blocklist": [],
    }),
    {
      afterAdminWrite: () => {},
      send: () => {},
    },
    {
      events: () => [],
      enrollments: () => ({ count: 0, results: [] }),
      sends: (id, page, perPage) => sends.list({ subscriberId: id, page, perPage }),
    },
    {
      activity: (id) => subscriberTracking.activity(id),
      clearActivity: (id, type) => subscriberTracking.clear(id, type),
      exportSections: () => ({}) as any,
    },
  );
  registerWebhookRoutes(router, { webhooks, auth });
  registerSendRoutes(router, sends, auth);

  const webhookDelivery = startWebhookDelivery({
    db,
    clock,
    logger: app.logger,
    webhooks,
    blockPrivate: () => false,
    transport: { fetch: globalThis.fetch },
  });

  registerSettingsRoutes(router, settingsStore, auth, undefined, () => true);
  registerImportRoutes(router, { importer, roles, auth });

  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`${root}${path}`, init));

  const json = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, {
      method,
      headers: {
        ...sessionHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };

  let openFailure: ((audience: { lists: { id: unknown }[] }) => boolean) | undefined;
  const recipientStore = createCampaignRecipients(db);
  const recipients: typeof recipientStore = {
    ...recipientStore,
    measure(audience) {
      if (openFailure?.(audience)) throw new Error("injected open failure");
      return recipientStore.measure(audience);
    },
  };
  const registry = createCampaignRunnerRegistry();
  const runners: ReturnType<typeof startCampaignRunner>[] = [];

  const startRunner = (customSettings?: Partial<RunnerSettings>) => {
    const runner = startCampaignRunner({
      db,
      clock,
      registry,
      logger: app.logger,
      store: runnerStore,
      campaigns: campaignStore,
      recipients,
      lists,
      templates: {
        get: (id) => templates.get(id),
        getDefault: () => templates.getDefault(),
      },
      renderer,
      tracking,
      emailer,
      attachments,
      embedImages,
      settings: () => ({
        batchSize: 1000,
        concurrency: 10,
        messageRate: 1000,
        maxSendErrors: 1000,
        slidingWindow: false,
        slidingWindowDuration: "1h",
        slidingWindowRate: 10000,
        rootUrl: root,
        messengers: ["email", "fixture"],
        unsubscribeHeader: true,
        disableTracking: false,
        individualTracking: false,
        ...customSettings,
      }),
      leaseMs: 30_000,
      notify: notifier,
    });
    runners.push(runner);
    return runner;
  };

  // Every send with this status, read through GET /api/sends as a client reads it (B57).
  const sendsWithStatus = async (status: "queued" | "sending") => {
    const rows: { next_attempt_at: string | null }[] = [];
    for (let page = 1; ; page++) {
      const response = await json(`/api/sends?status=${status}&per_page=100&page=${page}`);
      if (response.status !== 200)
        throw new Error(`GET /api/sends?status=${status} answered ${response.status}`);
      const list = response.data.data;
      rows.push(...list.results);
      if (page * 100 >= list.total) return rows;
    }
  };
  // Waits until no send is in flight and none is due: a retry scheduled for later does not count.
  const drainOutbox = () =>
    waitWall(
      async () => {
        sends.notify();
        webhookDelivery.wake();
        if ((await sendsWithStatus("sending")).length > 0) return false;
        const now = clock.now().getTime();
        const due = (await sendsWithStatus("queued")).filter(
          (row) => row.next_attempt_at === null || Date.parse(row.next_attempt_at) <= now,
        );
        return due.length === 0;
      },
      { label: "outbox drain", advance: (ms) => clock.advance(ms), step: 100 },
    );

  const waitUntil = async (done: () => boolean, what: string, step = 50, rounds = 200) => {
    for (let i = 0; i < rounds; i++) {
      if (done()) return;
      clock.advance(step);
      await Bun.sleep(5);
    }
    if (!done()) throw new Error(`timed out waiting for ${what}`);
  };

  return {
    db,
    clock,
    errors,
    failOpen(fn) {
      openFailure = fn;
    },
    waitUntil,
    settings: settingsStore,
    campaignStore,
    runnerStore,
    importer,
    sends,
    sink,
    outbox,
    subscribers,
    listStore,
    webhooks,
    effects,
    startRunner,
    request,
    json,
    createList(name = "List") {
      const created = listStore.create({
        name,
        type: "public",
        optin: "single",
        status: "active",
        tags: [],
        description: null,
      });
      return {
        ...created,
        id: BigInt(created.id as any),
      };
    },
    drainOutbox,
    async close() {
      // A runner whose claim failed reports that again at stop; a test that expects it has asserted it.
      for (const runner of runners) await runner.stop().catch(() => undefined);
      await outbox.stop();
      await webhookDelivery.stop();
      sink.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

describe("B38 admin notification mails", () => {
  test("1. With app.notify_emails = ['ops@example.com', 'boss@example.com'], a campaign that finishes produces exactly one campaign-status mail to each address", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com", "boss@example.com"],
    });

    // Create a list and a subscriber
    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub@example.com",
        name: "Subscriber",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    // Create campaign
    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Newsletter #1",
      subject: "Latest News",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    expect(createRes.status).toBe(200);
    const campaignId = BigInt(createRes.data.data.id);

    // Start campaign
    const statusRes = await f.json(`/api/campaigns/${campaignId}/status`, "PUT", {
      status: "running",
    });
    expect(statusRes.status).toBe(200);

    const runner = f.startRunner();

    // Drive runner until campaign finishes
    await f.waitUntil(
      () => f.runnerStore.state(campaignId)?.status === "finished",
      "the campaign to finish",
      50,
    );
    const state = f.runnerStore.state(campaignId);
    expect(state?.status).toBe("finished");

    await f.drainOutbox();
    await runner.stop();

    // Inspect sink messages
    const notifMessages = f.sink.messages.filter((m) =>
      m.to.some((to) => to === "ops@example.com" || to === "boss@example.com"),
    );

    // Exactly one to ops@example.com and one to boss@example.com
    expect(notifMessages.length).toBe(2);
    const opsMail = notifMessages.find((m) => m.to.includes("ops@example.com"));
    const bossMail = notifMessages.find((m) => m.to.includes("boss@example.com"));
    expect(opsMail).toBeDefined();
    expect(bossMail).toBeDefined();

    // Verify subject line and body
    expect(opsMail!.data).toContain("Subject: Finished: Newsletter #1");
    expect(opsMail!.data).toContain("Newsletter #1");
    expect(opsMail!.data).toContain("finished");
    expect(opsMail!.data).toContain("1 / 1");
  });

  test("2. Cancelling a running campaign through the API produces one notification with status cancelled", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub@example.com",
        name: "Subscriber",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Campaign To Cancel",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const campaignId = BigInt(createRes.data.data.id);

    // Set to running
    await f.json(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });

    // Cancel through the API
    const cancelRes = await f.json(`/api/campaigns/${campaignId}/status`, "PUT", {
      status: "cancelled",
    });
    expect(cancelRes.status).toBe(200);

    await f.drainOutbox();

    const notifMessages = f.sink.messages.filter((m) => m.to.includes("ops@example.com"));
    expect(notifMessages.length).toBe(1);
    expect(notifMessages[0]!.data).toContain("Subject: Cancelled: Campaign To Cancel");
    expect(notifMessages[0]!.data).toContain("cancelled");
  });

  test("3. Campaign that hits app.max_send_errors pauses and produces one notification saying paused; manual pause does not notify", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
      sinkReject: (to) => !to.includes("ops@example.com"), // Sink rejects subscribers but accepts admin notif
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub1@example.com",
        name: "Sub 1",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );
    f.subscribers.create(
      {
        email: "sub2@example.com",
        name: "Sub 2",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Error Prone Campaign",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const campaignId = BigInt(createRes.data.data.id);

    await f.json(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });

    // Start runner with maxSendErrors = 1
    const runner = f.startRunner({ maxSendErrors: 1 });

    await f.waitUntil(
      () => f.runnerStore.state(campaignId)?.status === "paused",
      "the campaign to be paused",
      50,
    );
    const state = f.runnerStore.state(campaignId);
    expect(state?.status).toBe("paused");

    await f.drainOutbox();
    await runner.stop();

    const notifMessages = f.sink.messages.filter((m) => m.to.includes("ops@example.com"));
    expect(notifMessages.length).toBe(1);
    expect(notifMessages[0]!.data).toContain("Subject: Paused: Error Prone Campaign");
    expect(notifMessages[0]!.data).toContain("Too many errors");
    expect(notifMessages[0]!.data).toContain("paused");

    // Now test manual pause on another campaign: does NOT notify
    const manualSink = await startSink({ clock: f.clock });
    f.settings.update((current) => ({
      ...current,
      smtp: [
        {
          name: "fixture",
          enabled: true,
          exclude_from_default: false,
          host: "127.0.0.1",
          port: manualSink.port,
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
    }));

    const c2 = await f.json("/api/campaigns", "POST", {
      name: "Manual Pause Campaign",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const c2Id = BigInt(c2.data.data.id);
    await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "running" });

    // Manually pause
    await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "paused" });
    await f.drainOutbox();

    expect(manualSink.messages.length).toBe(0);
    manualSink.close();
  });

  test("4. An import that finishes, and one that fails on a bad CSV, each produce one import-status mail", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
    });

    const list = f.createList("Import List");

    // Valid import
    const slot1 = f.importer.reserve()!;
    writeFileSync(
      slot1.path,
      "email,name\nuser1@example.com,User One\nuser2@example.com,User Two\n",
    );
    f.importer.start(slot1, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44, // comma
      listIds: [list.id],
    });

    // Wait for importer to finish
    await f.waitUntil(
      () => f.importer.status().status === "finished",
      "the import to be finished",
      50,
    );
    expect(f.importer.status().status).toBe("finished");

    await f.drainOutbox();

    let notifs = f.sink.messages.filter((m) => m.to.includes("ops@example.com"));
    expect(notifs.length).toBe(1);
    expect(notifs[0]!.data).toContain("Subject: Finished: subscribers.csv import");
    expect(notifs[0]!.data).toContain("finished");
    expect(notifs[0]!.data).toContain("2 / 2");

    // Clear sink messages
    f.sink.messages.length = 0;

    // Bad CSV import (missing email column)
    const slot2 = f.importer.reserve()!;
    writeFileSync(slot2.path, "name,phone\nAlice,1234\n");
    f.importer.start(slot2, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });

    await f.waitUntil(() => f.importer.status().status === "failed", "the import to be failed", 50);
    expect(f.importer.status().status).toBe("failed");

    await f.drainOutbox();

    notifs = f.sink.messages.filter((m) => m.to.includes("ops@example.com"));
    expect(notifs.length).toBe(1);
    expect(notifs[0]!.data).toContain("Subject: Failed: subscribers.csv import");
    expect(notifs[0]!.data).toContain("failed");
  });

  test("5. With app.notify_emails = [], nothing is sent for any of the above", async () => {
    f = await createNotifyFixture({
      notifyEmails: [],
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub@example.com",
        name: "Subscriber",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    // Finish a campaign
    const c = await f.json("/api/campaigns", "POST", {
      name: "No Notify Campaign",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const cId = BigInt(c.data.data.id);
    await f.json(`/api/campaigns/${cId}/status`, "PUT", { status: "running" });

    const runner = f.startRunner();
    await f.waitUntil(
      () => f.runnerStore.state(cId)?.status === "finished",
      "the campaign to finish",
      50,
    );
    await f.drainOutbox();
    await runner.stop();

    // Cancel a campaign
    const c2 = await f.json("/api/campaigns", "POST", {
      name: "Cancel No Notify",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const c2Id = BigInt(c2.data.data.id);
    await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "running" });
    await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "cancelled" });

    // Run import
    const slot = f.importer.reserve()!;
    writeFileSync(slot.path, "email,name\na@example.com,A\n");
    f.importer.start(slot, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(
      () => f.importer.status().status === "finished",
      "the import to be finished",
      50,
    );

    await f.drainOutbox();

    // Only subscriber mail from campaign might have been sent, NO admin notify mail
    const adminMail = f.sink.messages.filter(
      (m) =>
        m.data.includes("Subject: Finished:") ||
        m.data.includes("Subject: Cancelled:") ||
        m.data.includes("Subject: Paused:"),
    );
    expect(adminMail.length).toBe(0);
  });

  test("6. A notification never reaches a subscriber's activity, analytics or send.failed webhooks as if it were a subscriber send", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
      sinkReject: (to) => to.includes("ops@example.com"),
    });

    const receiver = startReceiver();
    try {
      const hookRes = await f.json("/api/webhooks", "POST", {
        url: receiver.url("/failed-hook"),
        events: ["send.failed"],
      });
      expect(hookRes.status).toBe(200);

      const list = f.createList();
      const sub = f.subscribers.create(
        {
          email: "ops@example.com", // Subscriber with the same address as the admin!
          name: "Ops Person",
          status: "enabled",
          lists: [list.id],
          attribs: {},
        },
        { all: true, ids: [] },
      );

      // Create and cancel campaign to trigger notification
      const c = await f.json("/api/campaigns", "POST", {
        name: "Camp",
        subject: "Hello",
        lists: [Number(list.id)],
        type: "regular",
        content_type: "html",
        body: "<p>Hello</p>",
        from_email: "noreply@fixture.test",
      });
      const cId = BigInt(c.data.data.id);
      await f.json(`/api/campaigns/${cId}/status`, "PUT", { status: "running" });
      await f.json(`/api/campaigns/${cId}/status`, "PUT", { status: "cancelled" });

      // Drain outbox so outbox attempts send, sink rejects, and send fails
      await f.drainOutbox();

      // Webhook delivery delivers send.failed to receiver
      await f.waitUntil(
        () => receiver.received.some((r) => r.body.event === "send.failed"),
        "the send.failed webhook",
        1000,
      );
      expect(receiver.received.length).toBeGreaterThanOrEqual(1);
      const delivery = receiver.received.find((r) => r.body.event === "send.failed");
      expect(delivery).toBeDefined();
      expect(delivery!.body.data.subscriber).toBeNull();
      expect(delivery!.body.data.send.source).toBe("tx");

      // Subscriber activity API: no activity recorded
      const activityRes = await f.json(`/api/subscribers/${sub.id}/activity`);
      expect(activityRes.status).toBe(200);
      expect(activityRes.data.data.campaign_views.length).toBe(0);
      expect(activityRes.data.data.link_clicks.length).toBe(0);

      // Subscriber sends API: no sends attributed
      const subSendsRes = await f.json(`/api/subscribers/${sub.id}/sends`);
      expect(subSendsRes.status).toBe(200);
      expect(subSendsRes.data.data.results.length).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  test("7. Admin settings page: the field is live, saving it round-trips", async () => {
    f = await createNotifyFixture();

    // Round-trip valid addresses through the settings API
    const res1 = await f.json("/api/settings", "PUT", {
      ...f.settings.read(),
      "app.notify_emails": ["ops@example.com", "alerts@example.com"],
    });
    expect(res1.status).toBe(200);

    const read = f.settings.read();
    expect(read["app.notify_emails"]).toEqual(["ops@example.com", "alerts@example.com"]);
  });

  test("8. A malformed entry in app.notify_emails (ops@) together with a valid one: campaign finish, cancel and import succeed normally", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com", "ops@"],
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub@example.com",
        name: "Subscriber",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    // 1. Campaign finish
    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Finish Malformed",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const c1Id = BigInt(createRes.data.data.id);
    await f.json(`/api/campaigns/${c1Id}/status`, "PUT", { status: "running" });

    const runner = f.startRunner();
    await f.waitUntil(
      () => f.runnerStore.state(c1Id)?.status === "finished",
      "the campaign to finish",
      50,
    );
    expect(f.runnerStore.state(c1Id)?.status).toBe("finished");
    await f.drainOutbox();
    await runner.stop();

    let notif = f.sink.messages.find(
      (m) =>
        m.to.includes("ops@example.com") && m.data.includes("Subject: Finished: Finish Malformed"),
    );
    expect(notif).toBeDefined();

    // 2. Campaign cancel (API returns 200, not 500)
    const c2 = await f.json("/api/campaigns", "POST", {
      name: "Cancel Malformed",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const c2Id = BigInt(c2.data.data.id);
    await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "running" });

    const cancelRes = await f.json(`/api/campaigns/${c2Id}/status`, "PUT", { status: "cancelled" });
    expect(cancelRes.status).toBe(200);
    await f.drainOutbox();

    notif = f.sink.messages.find(
      (m) =>
        m.to.includes("ops@example.com") && m.data.includes("Subject: Cancelled: Cancel Malformed"),
    );
    expect(notif).toBeDefined();

    // 3. Import (succeeds normally and ends finished, not failed)
    const slot = f.importer.reserve()!;
    writeFileSync(slot.path, "email,name\nimp@example.com,Imported\n");
    f.importer.start(slot, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(
      () => f.importer.status().status === "finished",
      "the import to be finished",
      50,
    );
    expect(f.importer.status().status).toBe("finished");
    await f.drainOutbox();

    notif = f.sink.messages.find(
      (m) =>
        m.to.includes("ops@example.com") &&
        m.data.includes("Subject: Finished: subscribers.csv import"),
    );
    expect(notif).toBeDefined();

    // 4. Process keeps serving normally
    const ping = await f.json("/api/campaigns");
    expect(ping.status).toBe(200);
  });

  test("9. Two consecutive bad-CSV imports each send a mail", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
    });

    const list = f.createList("Bad List");

    const slot1 = f.importer.reserve()!;
    writeFileSync(slot1.path, "name,phone\nAlice,1234\n");
    f.importer.start(slot1, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(() => f.importer.status().status === "failed", "the import to be failed", 50);
    expect(f.importer.status().status).toBe("failed");
    await f.drainOutbox();

    const slot2 = f.importer.reserve()!;
    writeFileSync(slot2.path, "name,phone\nBob,5678\n");
    f.importer.start(slot2, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(() => f.importer.status().status === "failed", "the import to be failed", 50);
    expect(f.importer.status().status).toBe("failed");
    await f.drainOutbox();

    const failedMails = f.sink.messages.filter(
      (m) =>
        m.to.includes("ops@example.com") &&
        m.data.includes("Subject: Failed: subscribers.csv import"),
    );
    expect(failedMails.length).toBe(2);
  });

  test("10. An address added between two imports with the same counts: the second import ends finished, with no false failed", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["admin1@example.com"],
    });

    const list = f.createList("Count List");

    // First import
    const slot1 = f.importer.reserve()!;
    writeFileSync(slot1.path, "email,name\nu1@example.com,User One\n");
    f.importer.start(slot1, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(
      () => f.importer.status().status === "finished",
      "the import to be finished",
      50,
    );
    expect(f.importer.status().status).toBe("finished");
    await f.drainOutbox();

    // Add address
    await f.json("/api/settings", "PUT", {
      ...f.settings.read(),
      "app.notify_emails": ["admin1@example.com", "admin2@example.com"],
    });

    // Second import with same counts: 1 row
    const slot2 = f.importer.reserve()!;
    writeFileSync(slot2.path, "email,name\nu2@example.com,User Two\n");
    f.importer.start(slot2, {
      mode: "subscribe",
      status: "confirmed",
      overwriteUserInfo: true,
      overwriteStatus: true,
      delimiter: 44,
      listIds: [list.id],
    });
    await f.waitUntil(
      () => f.importer.status().status === "finished" || f.importer.status().status === "failed",
      "the second import to end",
    );
    expect(f.importer.status().status).toBe("finished");
    await f.drainOutbox();

    const notifs1 = f.sink.messages.filter((m) => m.to.includes("admin1@example.com"));
    const notifs2 = f.sink.messages.filter((m) => m.to.includes("admin2@example.com"));
    expect(notifs1.length).toBe(2);
    expect(notifs2.length).toBe(1);
  });

  test("11. A second auto-pause after a resume sends a second Paused", async () => {
    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
      sinkReject: (to) => !to.includes("ops@example.com"),
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub1@example.com",
        name: "Sub 1",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );
    f.subscribers.create(
      {
        email: "sub2@example.com",
        name: "Sub 2",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Repeated Pause Campaign",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    const campaignId = BigInt(createRes.data.data.id);
    await f.json(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });

    let runner = f.startRunner({ maxSendErrors: 1, concurrency: 1 });
    await f.waitUntil(
      () => f.runnerStore.state(campaignId)?.status === "paused",
      "the campaign to be paused",
      50,
    );
    expect(f.runnerStore.state(campaignId)?.status).toBe("paused");
    await f.drainOutbox();
    await runner.stop();

    let pauseMails = f.sink.messages.filter(
      (m) => m.to.includes("ops@example.com") && m.data.includes("Subject: Paused:"),
    );
    expect(pauseMails.length).toBe(1);

    // Resume campaign
    await f.json(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });
    runner = f.startRunner({ maxSendErrors: 1, concurrency: 1 });
    await f.waitUntil(
      () => f.runnerStore.state(campaignId)?.status === "paused",
      "the campaign to be paused",
      50,
    );
    expect(f.runnerStore.state(campaignId)?.status).toBe("paused");
    await f.drainOutbox();
    await runner.stop();

    pauseMails = f.sink.messages.filter(
      (m) => m.to.includes("ops@example.com") && m.data.includes("Subject: Paused:"),
    );
    expect(pauseMails.length).toBe(2);
  });

  test("12. A cancel during a failing batch sends no Paused mail", async () => {
    let cancelled = false;
    let cancelPromise: Promise<any> | null = null;
    let campaignId = 0n;

    f = await createNotifyFixture({
      notifyEmails: ["ops@example.com"],
      sinkReject: (to) => {
        if (!to.includes("ops@example.com")) {
          if (!cancelled && campaignId !== 0n) {
            cancelled = true;
            cancelPromise = f.json(`/api/campaigns/${campaignId}/status`, "PUT", {
              status: "cancelled",
            });
          }
          return true;
        }
        return false;
      },
    });

    const list = f.createList();
    f.subscribers.create(
      {
        email: "sub1@example.com",
        name: "Sub 1",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );
    f.subscribers.create(
      {
        email: "sub2@example.com",
        name: "Sub 2",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );

    const createRes = await f.json("/api/campaigns", "POST", {
      name: "Racing Cancel Campaign",
      subject: "Hello",
      lists: [Number(list.id)],
      type: "regular",
      content_type: "html",
      body: "<p>Hello</p>",
      from_email: "noreply@fixture.test",
    });
    campaignId = BigInt(createRes.data.data.id);
    await f.json(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });

    const runner = f.startRunner({ maxSendErrors: 1, concurrency: 1 });
    await f.waitUntil(() => cancelled, "the cancel to be issued", 50);
    if (cancelPromise) await cancelPromise;
    await f.waitUntil(
      () => f.runnerStore.state(campaignId)?.status === "cancelled",
      "the campaign to be cancelled",
      50,
    );

    await f.drainOutbox();
    await runner.stop();

    const notifs = f.sink.messages.filter((m) => m.to.includes("ops@example.com"));
    const cancelMails = notifs.filter((m) => m.data.includes("Subject: Cancelled:"));
    const pauseMails = notifs.filter((m) => m.data.includes("Subject: Paused:"));

    expect(cancelMails.length).toBe(1);
    expect(pauseMails.length).toBe(0);
  });

  test("13. A finish whose claim transaction rolls back sends no Finished mail", async () => {
    f = await createNotifyFixture({ notifyEmails: ["ops@example.com"] });
    const empty = f.createList("Empty");
    const full = f.createList("Full");
    f.subscribers.create(
      {
        email: "full-sub@example.com",
        name: "Full",
        status: "enabled",
        lists: [full.id],
        attribs: {},
      },
      { all: true, ids: [] },
    );
    // Campaign A has no subscribers, so its claim finishes it. Campaign B's open fails in the same
    // claim transaction, which rolls A's finish back: A stays running and no mail is sent.
    const create = async (name: string, list: bigint) => {
      const res = await f.json("/api/campaigns", "POST", {
        name,
        subject: name,
        lists: [Number(list)],
        type: "regular",
        content_type: "html",
        body: "<p>Hello</p>",
        from_email: "noreply@fixture.test",
      });
      return BigInt(res.data.data.id);
    };
    const aId = await create("Rolled Back", empty.id);
    const bId = await create("Failing Open", full.id);
    await f.json(`/api/campaigns/${aId}/status`, "PUT", { status: "running" });
    await f.json(`/api/campaigns/${bId}/status`, "PUT", { status: "running" });
    f.failOpen((audience) => audience.lists.some((l) => Number(l.id) === Number(full.id)));

    const runner = f.startRunner();
    await f.waitUntil(() => f.errors.length > 0, "the failed claim to be logged");
    await f.drainOutbox();
    // The claim failure ends the runner's loop, and stop() reports it.
    await expect(runner.stop()).rejects.toThrow("injected open failure");

    expect(f.runnerStore.state(aId)?.status).toBe("running");
    const finished = f.sink.messages.filter((m) =>
      m.data.includes("Subject: Finished: Rolled Back"),
    );
    expect(finished.length).toBe(0);
  });

  test("14. An unusable app.from_email sends no admin mail, and the bad value is logged once", async () => {
    f = await createNotifyFixture({ notifyEmails: ["ops@example.com"] });
    // Settings validation refuses such a value, so only a restored or legacy row can hold one.
    f.db.run("UPDATE settings SET value = ? WHERE key = 'app.from_email'", [
      JSON.stringify(["not an address"]),
    ]);
    const empty = f.createList("Empty");
    const ids: bigint[] = [];
    for (const name of ["First", "Second"]) {
      const res = await f.json("/api/campaigns", "POST", {
        name,
        subject: name,
        lists: [Number(empty.id)],
        type: "regular",
        content_type: "html",
        body: "<p>Hello</p>",
        from_email: "noreply@fixture.test",
      });
      const id = BigInt(res.data.data.id);
      ids.push(id);
      await f.json(`/api/campaigns/${id}/status`, "PUT", { status: "running" });
    }

    const runner = f.startRunner();
    await f.waitUntil(
      () => f.runnerStore.state(ids[1]!)?.status === "finished",
      "the campaigns to finish",
    );
    await f.drainOutbox();
    await runner.stop();

    expect(f.sink.messages.some((m) => m.to.includes("ops@example.com"))).toBe(false);
    const logged = f.errors.filter((e) => String(e).includes("app.from_email"));
    expect(logged.length).toBe(1);
  });
});
