// In-process production owners for the campaigns API and its template, list, subscriber,
// tracking and emailer seams, with a fake clock and a loopback SMTP sink, wired as
// src/main.ts does.
import { fixturePageSite } from "@/test/public/site";
import type { JsonObject } from "@/test/json-object";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignRoutes } from "@/campaigns/routes";
import type { CampaignSettings } from "@/campaigns/routes";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createSubscriberStore, noSubscriberEffects } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { createTracking } from "@/unsubscribe/tracking";
import { createTestSends } from "@/messaging/test-sends";
import { createAttachments } from "@/media/attachments";
import { createFilesystem } from "@/media/filesystem";
import { createEmbeds } from "@/media/embed";
import { registerMediaRoutes, uploadPathCheck } from "@/media/routes";
import { createMediaStore } from "@/media/store";
import { createSettings } from "@/settings/store";
import { registerSettingsRoutes } from "@/settings/routes";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { startWebhookDelivery } from "@/webhooks/delivery";
import type { WebhookTransport } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";
import { asBody } from "@/test/read-body";

const admin = { user: "fixture-admin", password: "fixture-admin-password" };
const root = "http://fixture.test";

export async function campaignsFixture(
  options: {
    attachmentCacheBytes?: number;
    smtpPort?: number;
    sinkPauseMs?: number;
    /** Recipients the sink refuses with a 550 at RCPT (B101: an undelivered test send). */
    sinkReject?: (to: string) => boolean;
    dkim?: { domain_name: string; key_selector: string; private_key: string };
    /** The app's logger, for a test of what it keeps. */
    logger?: (clock: Clock) => ErrorLogger;
    /** With a transport, webhooks run as in src/main.ts: their store, effects, routes and delivery. */
    webhooks?: WebhookTransport;
  } = {},
) {
  const sink = await startSink({
    ...(options.sinkPauseMs ? { pauseMs: options.sinkPauseMs } : {}),
    ...(options.sinkReject ? { reject: options.sinkReject } : {}),
  });
  const directory = mkdtempSync(join(tmpdir(), "iglo-campaigns-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: Array<unknown> = [];
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
    i18n: createTranslation(),
    logger: options.logger?.(clock) ?? {
      error: (error) => errors.push(error),
      attention: (message) => errors.push(new Error(message)),
    },
  });
  const lists = createListReferences(db),
    counts = createListCounts(db),
    listReferences = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, listReferences),
    webhooks = options.webhooks ? createWebhookStore(db, clock) : undefined,
    webhookEffects = webhooks && createWebhookEffects(webhooks, () => subscribers),
    subscribers = createSubscriberStore(db, clock, lists, {
      ...noSubscriberEffects,
      ...webhookEffects?.subscriberEffects,
    }),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(users, roles, clock, root, defaultAuthPolicy);
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) {
    throw new Error("fixture login failed");
  }
  const renderer = createRenderer(clock, app.i18n);
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateReferences);
  templates.initialize();
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
          port: options.smtpPort ?? sink.port,
          hello_hostname: "fixture.test",
          max_conns: 4,
          idle_timeout: "2s",
          wait_timeout: "2s",
          auth_protocol: "none",
          username: "",
          tls_type: "none",
          tls_skip_verify: false,
          email_headers: [{ Bcc: "copy@fixture.test" }],
          from_addresses: [],
          ...(options.dkim ? { dkim: options.dkim } : {}),
        },
      ],
    }),
  });
  const tracking = createTracking(db, clock);
  const testSends = createTestSends(db, clock);
  const settings: CampaignSettings & { allowBlocklist: boolean } = {
    fromEmail: "Fixture <noreply@fixture.test>",
    rootUrl: root,
    siteName: "Fixture list",
    brand: {
      logoUrl: "",
      siteName: "Fixture list",
      siteUrl: "",
      accent: "",
      font: "system-sans",
      header: "auto",
    },
    messengers: ["email", "fixture"],
    unsubscribeHeader: true,
    allowBlocklist: true,
    disableTracking: false,
    individualTracking: false,
  };
  const unsubscribed: Array<unknown> = [];
  const media = createMediaStore(db, clock);
  // Media settings are the real ones, so that tests reach them through the settings API.
  const stored = createSettings(db, clock, root, roles);
  const mediaSettings = () => {
    const current = stored.read();
    return {
      provider: current["upload.provider"],
      extensions: current["upload.extensions"],
      rootUrl: root,
      uploadPath: current["upload.filesystem.upload_path"],
      uploadUri: current["upload.filesystem.upload_uri"],
    };
  };
  const files = createFilesystem(directory, mediaSettings);
  const attachments = createAttachments(media, files, options.attachmentCacheBytes);
  const embedImages = createEmbeds(media, app.logger);
  const store = createCampaignStore(db, clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
    mediaFilename: (id) => media.filename(id),
  });
  // src/main.ts creates the runner after the campaign routes, so the routes read it lazily.
  const runnerWake: { current?: () => void } = {};
  const router = createRouter();
  registerSettingsRoutes(router, stored, auth, undefined, uploadPathCheck(directory, media));
  registerMediaRoutes(router, { store: media, files, auth, settings: mediaSettings });
  registerUserRoutes(router, users, roles, auth, fixturePageSite);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth, fixturePageSite);
  registerCampaignRoutes(router, {
    page: fixturePageSite,
    store,
    templates,
    renderer,
    roles,
    auth,
    lists,
    subscribers,
    emailer,
    testSends,
    settings: () => settings,
    attachments,
    embedImages,
    wakeRunner: () => runnerWake.current?.(),
  });
  registerCampaignPublicRoutes(router, {
    db,
    store,
    subscribers,
    tracking,
    settings: () => settings,
    effects: { unsubscribed: (event) => unsubscribed.push(event) },
    page: () => ({
      siteName: settings.siteName,
      rootUrl: settings.rootUrl,
      logoUrl: "",
      faviconUrl: "",
      subscriptionPage: false,
      archive: false,
      siteUrl: "",
      accent: "",
      font: "system-sans",
      header: "auto",
      allowBlocklist: settings.allowBlocklist,
      allowPreferences: false,
      allowExport: false,
      allowWipe: false,
    }),
    // The privacy answers are the public fixture's concern; here every path pairs nobody.
    privacy: { export: () => null, wipe: () => null },
  });
  if (webhooks) {
    registerWebhookRoutes(router, { webhooks, auth });
  }
  const delivery = webhooks
    ? startWebhookDelivery({
        db,
        clock,
        logger: app.logger,
        webhooks,
        blockPrivate: () => false,
        transport: options.webhooks!,
      })
    : undefined;
  // The loop's zero-length yields need no time to pass, only a turn of the injected clock.
  const pump = webhooks ? setInterval(() => clock.advance(0), 1) : undefined;
  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`${root}${path}`, init));
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
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      headers: response.headers,
      body: type.startsWith("application/json") ? JSON.parse(text) : text,
    };
  };
  const list = async (name: string, optin = "single") =>
    asBody<number>(
      (await json("/api/lists", "POST", { name, type: "public", optin })).body.data.id,
    );
  const subscriber = async (email: string, listIds: Array<number>, extra: JsonObject = {}) => {
    const created = await json("/api/subscribers", "POST", {
      email,
      name: "Ada Lovelace",
      lists: listIds,
      ...extra,
    });
    if (created.status !== 200) {
      throw new Error(`subscriber ${created.status}`);
    }
    return asBody<{ id: number; uuid: string; email: string }>(created.body.data);
  };
  const campaign = async (input: JsonObject) => {
    const created = await json("/api/campaigns", "POST", input);
    if (created.status !== 200) {
      throw new Error(`campaign ${created.status} ${JSON.stringify(created.body)}`);
    }
    return asBody<Record<string, any> & { id: number; uuid: string }>(created.body.data);
  };
  /** Wait for the sink: test sends are queued to the emailer, as in listmonk. */
  const mail = async (count: number) => {
    for (let i = 0; i < 400 && sink.messages.length < count; i++) {
      await Bun.sleep(5);
    }
    return sink.messages;
  };
  return {
    app,
    db,
    clock,
    sink,
    errors,
    testSends,
    settings,
    directory,
    unsubscribed,
    /** The wake the routes call; a campaign runner sets it when it starts. */
    runnerWake,
    sessionHeaders,
    request,
    json,
    list,
    subscriber,
    campaign,
    mail,
    /** Production owners, for wiring the campaign runner as src/main.ts does. */
    owners: {
      store,
      templates,
      renderer,
      tracking,
      lists,
      subscribers,
      emailer,
      roles,
      auth,
      attachments,
      embedImages,
    },
    router,
    async close() {
      await delivery?.halt();
      clearInterval(pump);
      webhooks?.close();
      await emailer.close();
      store.close();
      media.close();
      stored.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
      subscribers.close();
      listStore.close();
      counts.close();
      listReferences.close();
      lists.close();
      db.close(true);
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type CampaignsFixture = Awaited<ReturnType<typeof campaignsFixture>>;
