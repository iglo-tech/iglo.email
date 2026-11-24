// Project composition: the wiring half of listmonk's cmd/main.go, split out of main() by B138a
// (docs/design/14-projects.md section 3). One call wires one database's stores, routes and loops.
// The lock, the CLI, the bind and the signal handling stay in main(); the instance (instance.ts)
// calls this once per registered project (B138b). Every loop is created here, before the port
// binds, and starts only from start(), after main() binds (B52).
// The settings store is `Record<string, any>` by design (settings/validate.ts; D132); the unsafe-any
// rules are off for this file in oxlint.config.ts.
import type { Database } from "bun:sqlite";
import { createApp } from "@/app";
import type { App } from "@/app";
import type { Clock } from "@/clock";
import type { BootstrapConfig } from "@/config/bootstrap";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import type { SnapshotPlace } from "@/db/migrations";
import type { InstanceBudgets } from "@/projects/budgets";
import { createSourceLogger } from "@/projects/logger";
import { createTranslation } from "@/i18n/i18n";
import { createClientAddress } from "@/server/client-address";
import type { Router } from "@/server/router";
import { createRouter } from "@/server/server";
import type { RoutedServer } from "@/server/server";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import { openReadOnly } from "@/subscribers/query-runner";
import type { QueryRunner } from "@/subscribers/query-runner";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { must } from "@/invariant";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerHandoffRoute } from "@/users/handoff";
import { registerUserRoutes } from "@/users/routes";
import type { AdminAccount, AdminCredentials } from "@/users/account";
import { createUserStore } from "@/users/store";
import { createSettings } from "@/settings/store";
import { sessionDuration } from "@/settings/duration";
import { registerSettingsRoutes } from "@/settings/routes";
import { refuseWhileHeld, restoreHold } from "@/settings/hold";
import { createEmailer } from "@/messaging/email";
import { createSendRateLimiter } from "@/messaging/rate";
import { createSMTPTest } from "@/messaging/test";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { createSendAnonymizer, createUnlinkedSends } from "@/messaging/anonymize";
import { createOutbox } from "@/messaging/outbox";
import { createSendCompaction } from "@/messaging/retention";
import { createTestSends } from "@/messaging/test-sends";
import { registerSendRoutes } from "@/messaging/routes";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { registerTxRoutes } from "@/tx/routes";
import { createMarketingPolicy, marketingSettings } from "@/unsubscribe/policy";
import { registerUnsubscribeRoutes } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";
import { allowedDomain } from "@/subscribers/email";
import { createEventStore } from "@/events/store";
import { registerEventRoutes } from "@/events/routes";
import { createEnrollments } from "@/sequences/enrollments";
import { createSequenceStore } from "@/sequences/store";
import { registerSequenceRoutes } from "@/sequences/routes";
import { linkEvents } from "@/sequences/event-links";
import { listedWithHolds } from "@/sequences/timeline";
import { createEventPurge } from "@/events/retention";
import { createPurge } from "@/loops/purge";
import { createConditionEvaluator } from "@/conditions/evaluate";
import { createScheduler } from "@/scheduler/scheduler";
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignRoutes } from "@/campaigns/routes";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createAdminNotifier } from "@/messaging/notify";
import type { AdminNotifier } from "@/messaging/notify";
import { createImporter } from "@/subscribers/import/importer";
import { registerImportRoutes } from "@/subscribers/import/routes";
import { createAttachments } from "@/media/attachments";
import { createFilesystem } from "@/media/filesystem";
import { createEmbeds, createPublicImages } from "@/media/embed";
import { registerMediaRoutes, uploadPathCheck } from "@/media/routes";
import { createMediaStore } from "@/media/store";
import { createRunnerStore } from "@/campaigns/runner/store";
import { createCampaignRunner } from "@/campaigns/runner/runner";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import { registerArchiveRoutes } from "@/public/archive";
import { googleFontUrl } from "@/public/brand";
import { createSubscriberMail, createSignupMail } from "@/public/mail";
import type { SubscriberMail } from "@/public/mail";
import { createPrivacy } from "@/public/privacy";
import { personalPageHeaders } from "@/public/headers";
import { registerPublicRoutes } from "@/public/routes";
import { publicSettings } from "@/public/settings";
import { createBounceStore } from "@/bounces/store";
import { registerBounceRoutes } from "@/bounces/routes";
import { createWebhookDelivery } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";
import type { AnalyticsReader } from "@/analytics/reader";
import { createAnalyticsPurge } from "@/analytics/purge";
import { createSubscriberTracking } from "@/analytics/subscriber";
import { registerAnalyticsRoutes } from "@/analytics/routes";
import { registerAdminRoutes } from "@/admin/routes";
import { createLogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { createSummaries, createSummaryRefresh } from "@/analytics/summaries";
import { registerOpenApiRoutes } from "@/openapi/routes";
import { registerMcpRoutes } from "@/mcp/routes";

/**
 * Process-wide services, passed in by the instance. Every project in the process shares them, so a
 * budget here is one budget for the process, never one per project (invariant 7).
 */
export interface ProjectServices {
  readonly clock: Clock;
  readonly budgets: InstanceBudgets;
  /**
   * Where the process listens. Only `App.bootstrap` carries it, which the fixtures' startServer
   * reads; production binds once, in main().
   */
  readonly listen: { readonly host: string; readonly port: number };
  /**
   * The instance admin (B140, D153): the account every project copies, the write-through of this
   * project's changes to it, and the handoff tokens this project redeems. Without it (a fixture),
   * the seed's admin is bootstrapped as before.
   */
  readonly admin?: {
    account(): AdminAccount | null;
    changed(slug: string, credentials: AdminCredentials): void;
    redeem(slug: string, token: string): boolean;
  };
}

/** What one project is wired from: its identity, its directory, its root URL and its seed. */
export interface ProjectOptions {
  readonly slug: string;
  /** `projects/<slug>/`: the database, `uploads/` and `stage/` live here. */
  readonly directory: string;
  /** `--root-url` with the host replaced by the project's main hostname (14-projects section 2). */
  readonly rootUrl: string;
  /** Where a pre-migration snapshot of this project's database goes. */
  readonly snapshots: SnapshotPlace;
  /** The first users when the project has none, as the environment's pair did for one install. */
  readonly seed: {
    readonly admin: BootstrapConfig["initialAdmin"];
    readonly api?: BootstrapConfig["initialApi"];
  };
}

export type ProjectServer = RoutedServer;

/** A wired project. main() binds `router` on `app`, then calls start(), then stop() and close(). */
export interface Project {
  readonly app: App;
  readonly db: Database;
  readonly router: Router;
  /** The bound server, read by the maintenance routes' keep-open and stopped by main(). */
  attach(server: ProjectServer): void;
  /**
   * Subscribes each loop's failure to `fail` and starts the loops in their wiring order. Call it
   * only after the port is bound. A start that throws calls `fail` with the error.
   */
  start(fail: (failure?: unknown) => void): void;
  /**
   * Starts the orderly stop of the claims, the importer, uploads and the mail sender, in the order
   * they stop. Returns their results in that order; main() appends the HTTP stop after them.
   */
  stop(): Array<unknown>;
  /** Closes every store and the database. main() calls it last, after the lock is still held. */
  close(): Promise<void>;
  /** Writes the instance admin account into this project's copy (B140). */
  syncAdmin(account: AdminAccount): void;
}

/**
 * Wires one project's database: migrations, every store, route and loop. The data-directory lock
 * is already held by the caller, which releases it when this rejects or the project closes.
 */
export async function createProject(
  services: ProjectServices,
  options: ProjectOptions,
): Promise<Project> {
  const clock = services.clock;
  const budgets = services.budgets;
  const directory = options.directory;
  const rootUrl = options.rootUrl;
  const db = openDatabase(directory);
  let lists: ReturnType<typeof createListReferences> | undefined;
  let listStore: ReturnType<typeof createListStore> | undefined;
  let subscriberStore: ReturnType<typeof createSubscriberStore> | undefined;
  let counts: ReturnType<typeof createListCounts> | undefined;
  let readonly: ReturnType<typeof openReadOnly> | undefined;
  let queryRunner: QueryRunner | undefined;
  let subscriberQuery: ReturnType<typeof createSubscriberQuery> | undefined;
  let campaigns: ReturnType<typeof createCampaignListReferences> | undefined;
  let roles: ReturnType<typeof createRoles> | undefined;
  let users: ReturnType<typeof createUserStore> | undefined;
  let settings: ReturnType<typeof createSettings> | undefined;
  let emailer: ReturnType<typeof createEmailer> | undefined;
  let sends: ReturnType<typeof createSends> | undefined;
  let templateReferences: ReturnType<typeof createCampaignTemplateReferences> | undefined;
  let templates: ReturnType<typeof createTemplateStore> | undefined;
  let outbox: ReturnType<typeof createOutbox> | undefined;
  let tracking: ReturnType<typeof createTracking> | undefined;
  let subscriberTracking: ReturnType<typeof createSubscriberTracking> | undefined;
  let events: ReturnType<typeof createEventStore> | undefined;
  let purge: ReturnType<typeof createPurge> | undefined;
  let enrollments: ReturnType<typeof createEnrollments> | undefined;
  let sequences: ReturnType<typeof createSequenceStore> | undefined;
  let conditions: ReturnType<typeof createConditionEvaluator> | undefined;
  let scheduler: ReturnType<typeof createScheduler> | undefined;
  let campaignStore: ReturnType<typeof createCampaignStore> | undefined;
  let mediaStore: ReturnType<typeof createMediaStore> | undefined;
  let runnerStore: ReturnType<typeof createRunnerStore> | undefined;
  let recipients: ReturnType<typeof createCampaignRecipients> | undefined;
  let runner: ReturnType<typeof createCampaignRunner> | undefined;
  let mail: SubscriberMail | undefined;
  let signups: ReturnType<typeof createSignupMail> | undefined;
  let webhooks: ReturnType<typeof createWebhookStore> | undefined;
  let bounces: ReturnType<typeof createBounceStore> | undefined;
  let deliveries: ReturnType<typeof createWebhookDelivery> | undefined;
  let analyticsReader: AnalyticsReader | undefined;
  let summaries: ReturnType<typeof createSummaries> | undefined;
  let summaryRefresh: ReturnType<typeof createSummaryRefresh> | undefined;
  let analyticsPurge: ReturnType<typeof createAnalyticsPurge> | undefined;
  let maintenance: ReturnType<typeof registerMaintenanceRoutes> | undefined;
  let importer: ReturnType<typeof createImporter> | undefined;
  let notifier: ReturnType<typeof createAdminNotifier> | undefined;
  // Read by the routes below, so it exists before them; requests only arrive after the bind.
  interface ServerRef {
    server?: ProjectServer;
  }
  const serverRef: ServerRef = {};
  // The finally body of the composition: every store that exists is closed, the database last.
  // A wiring failure runs it before the error propagates, so nothing that was opened stays open.
  const closeAll: () => Promise<void> = async () => {
    enrollments?.onDue(() => {});
    await importer?.close();
    await maintenance?.close();
    const running = runner?.stop();
    const scheduling = scheduler?.stop();
    const stopped = outbox?.stop();
    const retaining = purge?.stop();
    const signing = signups?.stop();
    const delivering = deliveries?.stop();
    const summarizing = summaryRefresh?.stop();
    await analyticsReader?.close();
    // A decision awaiting a condition finishes before the runner and connections close.
    await scheduling?.catch(() => {});
    const closing = emailer?.close();
    await running?.catch(() => {});
    await closing;
    await queryRunner?.close();
    conditions?.close();
    await stopped?.catch(() => {});
    await retaining?.catch(() => {});
    await signing?.catch(() => {});
    await delivering?.catch(() => {});
    await summarizing?.catch(() => {});
    summaries?.close();
    analyticsPurge?.close();
    bounces?.close();
    webhooks?.close();
    sequences?.close();
    recipients?.close();
    runnerStore?.close();
    campaignStore?.close();
    mediaStore?.close();
    events?.close();
    sends?.close();
    tracking?.close();
    subscriberTracking?.close();
    templates?.close();
    templateReferences?.close();
    settings?.close();
    users?.close();
    listStore?.close();
    subscriberQuery?.close();
    readonly?.close();
    subscriberStore?.close();
    enrollments?.close();
    campaigns?.close();
    counts?.close();
    roles?.close();
    lists?.close();
    db.close(true);
  };
  try {
    runMigrations(db, directory, clock, productionMigrations, options.snapshots);
    lists = createListReferences(db);
    roles = createRoles(db, lists);
    settings = createSettings(db, clock, rootUrl, roles);
    counts = createListCounts(db);
    enrollments = createEnrollments(db, clock);
    webhooks = createWebhookStore(db, clock);
    const webhookEffects = createWebhookEffects(webhooks, () =>
      must(subscriberStore, "subscriberStore"),
    );
    const anonymizeSends = createSendAnonymizer(db);
    const unlinkedSends = createUnlinkedSends(db);
    const subscriberEffects = {
      ...enrollments.subscriberEffects,
      ...webhookEffects.subscriberEffects,
      deleting(deleted: Array<{ id: bigint; email: string }>, wipe?: boolean) {
        must(bounces, "bounces").deleteForSends(unlinkedSends(deleted.map(({ email }) => email)));
        anonymizeSends(deleted);
        webhookEffects.deleting(deleted, wipe);
      },
    };
    subscriberStore = createSubscriberStore(db, clock, lists, subscriberEffects);
    readonly = openReadOnly(db.filename);
    // The project's own runner, whose children count against the process's slots (invariant 7).
    queryRunner = budgets.queries({
      path: db.filename,
      timeoutMs: 10_000,
      concurrency: 2,
    });
    subscriberQuery = createSubscriberQuery({
      db,
      readonly,
      clock,
      runner: queryRunner,
      effects: subscriberEffects,
    });
    campaigns = createCampaignListReferences(db);
    const writer = db;
    analyticsReader = budgets.analytics({
      path: db.filename,
      // After a long run of overlapping reads, let the WAL be checkpointed and restarted (D62).
      onGap: () => void writer.run("PRAGMA wal_checkpoint(PASSIVE)"),
    });
    summaries = createSummaries(db, clock, analyticsReader);
    const liveCounts = counts;
    const cachedSummaries = summaries;
    // With app.cache_slow_queries, list counters come from the summary too (query-lists).
    listStore = createListStore(
      db,
      clock,
      {
        ...liveCounts,
        all: () =>
          (must(settings, "settings").read()["app.cache_slow_queries"]
            ? cachedSummaries.listCounts()
            : null) ?? liveCounts.all(),
      },
      campaigns,
    );
    users = createUserStore(db, clock, roles);
    const logs = createLogBuffer(clock);
    const logger = createSourceLogger(options.slug, logs);
    const clientAddress = createClientAddress(
      () => must(settings, "settings").read()["security.trusted_proxies"],
      logger,
    );
    const auth = await createAuthentication(users, roles, clock, rootUrl, {
      ...defaultAuthPolicy,
      clientAddress,
      get sessionDurationMs() {
        return sessionDuration(
          must(settings, "settings").read()["security.session_duration"],
          clock.now().getTime(),
        );
      },
    });
    const admin = services.admin;
    if (admin) {
      // The API user is seeded first, as before only while the project has no users; then the
      // account's copy is written, adopting a row of its name (D153).
      await bootstrapAdmin(users, auth, { user: undefined, password: undefined }, options.seed.api);
      const account = admin.account();
      if (account) {
        users.syncCopy(account);
      }
      users.onAdminChange((credentials) => admin.changed(options.slug, credentials));
    } else {
      await bootstrapAdmin(users, auth, options.seed.admin, options.seed.api);
    }
    // Only the fixtures' startServer reads host and port from here; the instance binds in main().
    const bootstrap: BootstrapConfig = {
      host: services.listen.host,
      port: services.listen.port,
      dataDir: directory,
      rootUrl,
      initialAdmin: options.seed.admin,
    };
    if (options.seed.api) {
      bootstrap.initialApi = options.seed.api;
    }
    const app = createApp({
      bootstrap,
      clock,
      db,
      logger,
      i18n: createTranslation(),
    });
    const renderer = createRenderer(clock, app.i18n);
    templateReferences = createCampaignTemplateReferences(db);
    templates = createTemplateStore(db, clock, renderer, templateReferences);
    templates.initialize();
    const router = createRouter(() => restoreHold(db));
    // B125: every personal public page, whichever route family serves it (src/public/headers.ts).
    router.use(personalPageHeaders);
    registerTemplateRoutes(router, templates, renderer, auth, () =>
      publicSettings(must(settings, "settings").read()),
    );
    registerUserRoutes(router, users, roles, auth, () =>
      publicSettings(must(settings, "settings").read()),
    );
    if (admin) {
      registerHandoffRoute(router, users, auth, (token) => admin.redeem(options.slug, token));
    }
    registerListRoutes(router, listStore, roles, auth);
    registerSubscriberRoutes(
      router,
      subscriberStore,
      roles,
      auth,
      () => {
        const current = must(settings, "settings").read();
        return {
          "privacy.domain_allowlist": current["privacy.domain_allowlist"],
          "privacy.domain_blocklist": current["privacy.domain_blocklist"],
        };
      },
      {
        afterAdminWrite: (row, listIds) => must(mail, "mail").afterAdminWrite(row, listIds),
        send: (row) => {
          must(mail, "mail").optin(row);
        },
      },
      {
        events: (id, page, perPage) =>
          linkEvents(
            must(events, "events").page(id, page, perPage),
            id,
            must(enrollments, "enrollments"),
            must(sequences, "sequences"),
          ),
        enrollments: (id, page, perPage) =>
          must(enrollments, "enrollments").list({ subscriberId: id, page, perPage }, (rows) =>
            listedWithHolds(
              rows,
              (sequenceId) => must(enrollments, "enrollments").steps(sequenceId),
              must(sends, "sends").capFreeAt,
              clock.now(),
            ),
          ),
        // The subscriber's sends tab: the subscriber's own read checks the caller's list scope first (B117d).
        sends: (id, page, perPage) =>
          must(sends, "sends").list({
            subscriberId: id,
            page,
            perPage,
            scope: { all: true, ids: [] },
          }),
      },
      {
        activity: (id) => must(subscriberTracking, "subscriberTracking").activity(id),
        clearActivity: (id, type) => must(subscriberTracking, "subscriberTracking").clear(id, type),
        exportSections: (row) => must(mail, "mail").exportSections(row),
      },
    );
    registerSubscriberQueryRoutes(router, subscriberQuery, subscriberStore, roles, auth);
    const touchLists = listStore.touch;
    const adminNotifier: AdminNotifier = {
      campaignStatus: (c, r) => notifier?.campaignStatus(c, r),
      importStatus: (s) => notifier?.importStatus(s),
    };
    importer = createImporter({
      dataDir: directory,
      clock,
      logger: app.logger,
      i18n: app.i18n,
      store: subscriberStore,
      touchLists,
      domainPolicy: () => {
        const current = must(settings, "settings").read();
        return {
          allow: current["privacy.domain_allowlist"],
          block: current["privacy.domain_blocklist"],
        };
      },
      notify: adminNotifier,
    });
    await importer.sweep().catch((error: unknown) => app.logger.error(error));
    registerImportRoutes(router, { importer, roles, auth });
    const limiter = createSendRateLimiter({
      clock,
      rate: () => must(settings, "settings").read()["messaging.max_send_rate"],
    });
    settings.onUpdate((next, current) => {
      if (next["messaging.max_send_rate"] !== current["messaging.max_send_rate"]) {
        limiter.wake();
      }
    });
    emailer = createEmailer({
      clock,
      limiter,
      settings: () => {
        const current = must(settings, "settings").read();
        return { smtp: current.smtp, rootUrl: current["app.root_url"] };
      },
      copyAllowed: (address) =>
        !addressBlocklisted(must(subscriberStore, "subscriberStore"), address),
      // Past every loop's and route's own check: nothing reaches SMTP from a held install (D67).
      refuse: () => refuseWhileHeld(db),
    });
    mediaStore = createMediaStore(db, clock);
    const media = mediaStore;
    const files = createFilesystem(directory, () => {
      const current = must(settings, "settings").read();
      return {
        uploadPath: current["upload.filesystem.upload_path"],
        uploadUri: current["upload.filesystem.upload_uri"],
      };
    });
    // A database that names a directory it must not serve from refuses media, not the server:
    // the reason is logged here, and each media operation refuses with it (D64).
    await files.sweep().catch((error: unknown) => app.logger.error(error));
    registerSettingsRoutes(
      router,
      settings,
      auth,
      createSMTPTest(settings, emailer, app.i18n, renderer),
      uploadPathCheck(directory, media),
    );
    const marketing = () => marketingSettings(must(settings, "settings").read());
    const pages = () => publicSettings(must(settings, "settings").read());
    // Each limit is the process's one table for its kind; this project's peers are its own in it.
    const limit = (name: keyof ReturnType<typeof publicSettings>["rateLimits"]) =>
      budgets.limit(name, {
        slug: options.slug,
        limit: () => pages().rateLimits[name],
        page: pages,
        clientAddress,
      });
    const limits = {
      subscribe: limit("subscribe"),
      optin: limit("optin"),
      privacy: limit("privacy"),
    };
    // Mail providers post one-click unsubscribes from shared addresses, hence its higher default.
    const unsubscribeLimit = limit("unsubscribe");
    runnerStore = createRunnerStore(db);
    sends = createSends({
      db,
      clock,
      subscribers: subscriberStore,
      rootUrl: () => must(settings, "settings").read()["app.root_url"],
      ended: webhookEffects.sendEnded,
      marketingPolicy: createMarketingPolicy({
        subscribers: subscriberStore,
        lists,
        settings: marketing,
        campaignDeliveries: runnerStore,
      }),
      stepLabels: (ids) => must(sequences, "sequences").stepLabels(ids),
      templateNames: (ids) => must(templates, "templates").names(ids),
    });
    notifier = createAdminNotifier({
      sends,
      renderer,
      logger: app.logger,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          notifyEmails: current["app.notify_emails"],
          fromEmail: current["app.from_email"][0] ?? "",
          rootUrl: current["app.root_url"],
          logoUrl: current["app.logo_url"],
          siteName: current["app.site_name"],
          siteUrl: current["app.site_url"],
          accent: current["appearance.brand.accent"],
          font: current["appearance.brand.font"],
          header: current["appearance.brand.header"],
        };
      },
    });
    tracking = createTracking(db, clock);
    subscriberTracking = createSubscriberTracking(db);
    registerSendRoutes(router, sends, auth, roles);
    registerWebhookRoutes(router, { webhooks, auth });
    outbox = createOutbox({ db, clock, logger: app.logger, sends, emailer });
    const attachments = createAttachments(media, files);
    const embedImages = createEmbeds(media, app.logger);
    registerTxRoutes(router, {
      auth,
      sends,
      outbox,
      subscribers: subscriberStore,
      templates,
      renderer,
      lists,
      policy: () => {
        const current = must(settings, "settings").read();
        return {
          // listmonk getDefaultFromEmail: the first configured address.
          fromEmail: current["app.from_email"][0] ?? "",
          domainAllowlist: current["privacy.domain_allowlist"],
          domainBlocklist: current["privacy.domain_blocklist"],
        };
      },
      marketing: { settings: marketing, tracking },
      attachments,
      embedImages,
      gate: budgets.attachments,
    });
    // B123 (D126): the export and wipe of a paired subscriber. The mail module is made below, and
    // a request is answered only after startup, so its getter reads it then.
    const privacy = createPrivacy({
      db,
      subscribers: subscriberStore,
      mail: () => must(mail, "mail"),
      page: pages,
    });
    registerUnsubscribeRoutes(router, {
      db,
      sends,
      subscribers: subscriberStore,
      tracking,
      settings: marketing,
      effects: enrollments.unsubscribeEffects,
      page: pages,
      limit: unsubscribeLimit,
      privacy,
      privacyLimit: limits.privacy,
    });
    registerMediaRoutes(router, {
      store: media,
      files,
      auth,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          provider: current["upload.provider"],
          extensions: current["upload.extensions"],
          rootUrl: current["app.root_url"],
        };
      },
    });
    campaignStore = createCampaignStore(db, clock, {
      templateExists: (id) => must(templates, "templates").get(id) !== null,
      defaultTemplate: () => must(templates, "templates").getDefault()?.id ?? null,
      listName: (id) => must(lists, "lists").name(id),
      mediaFilename: (id) => media.filename(id),
    });
    const campaignSettings = () => {
      const current = must(settings, "settings").read();
      return {
        // listmonk getDefaultFromEmail: the first configured address.
        fromEmail: current["app.from_email"][0] ?? "",
        rootUrl: current["app.root_url"],
        siteName: current["app.site_name"],
        brand: {
          logoUrl: current["app.logo_url"],
          siteName: current["app.site_name"],
          siteUrl: current["app.site_url"],
          accent: current["appearance.brand.accent"],
          font: current["appearance.brand.font"],
          header: current["appearance.brand.header"],
        },
        messengers: [
          "email",
          ...(current.smtp as Array<{ enabled: boolean; name: string }>)
            .filter((s) => s.enabled && s.name)
            .map((s) => s.name),
        ],
        unsubscribeHeader: current["privacy.unsubscribe_header"],
        allowBlocklist: current["privacy.allow_blocklist"],
        disableTracking: current["privacy.disable_tracking"],
        individualTracking: current["privacy.individual_tracking"],
      };
    };
    const testSends = createTestSends(db, clock);
    registerCampaignRoutes(router, {
      testSends,
      store: campaignStore,
      templates,
      renderer,
      roles,
      auth,
      lists,
      subscribers: subscriberStore,
      emailer,
      settings: campaignSettings,
      page: pages,
      attachments,
      embedImages,
      notify: notifier,
      // The runner is created after these routes (below), so the route reads it when called.
      wakeRunner: () => runner?.wake(),
    });
    registerCampaignPublicRoutes(router, {
      db,
      store: campaignStore,
      subscribers: subscriberStore,
      tracking,
      settings: campaignSettings,
      effects: enrollments.unsubscribeEffects,
      page: pages,
      limit: unsubscribeLimit,
      privacy,
      privacyLimit: limits.privacy,
    });
    const campaignsByUuid = campaignStore;
    bounces = createBounceStore(db, clock, {
      subscribers: () => must(subscriberStore, "subscriberStore"),
      sendTarget: (uuid) => must(sends, "sends").bounceTarget(uuid),
      campaignID: (uuid) => campaignsByUuid.byUuid(uuid)?.id ?? null,
      recorded: webhookEffects.bounceRecorded,
      actions: () => must(settings, "settings").read()["bounce.actions"],
      testSend: (messageId) => testSends.find(messageId),
    });
    registerBounceRoutes(router, {
      db,
      clock,
      store: bounces,
      page: pages,
      logger: app.logger,
      subscribers: subscriberStore,
      roles,
      auth,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          enabled: current["bounce.enabled"],
          webhooksEnabled: current["bounce.webhooks_enabled"],
          ses: current["bounce.ses_enabled"],
          sesTopics: current["bounce.ses_topic_arns"],
        };
      },
      // Providers post from shared addresses too, with a budget of their own. A large campaign's
      // bounces arrive from SNS as one POST each; a 429 there is a lost bounce once SNS stops
      // retrying, so this budget is 20 times the unsubscribe default, or the unsubscribe setting when that is larger.
      limit: budgets.limit("bounce", {
        slug: options.slug,
        // Never below the 6,000 it is now, and an operator's higher unsubscribe setting still
        // raises it (read at each request, like the public forms).
        limit: () => Math.max(budgets.bounceWebhookPerMinute, pages().rateLimits.unsubscribe),
        page: pages,
        clientAddress,
      }),
    });
    recipients = createCampaignRecipients(db);
    const templateStore = templates;
    runner = createCampaignRunner({
      db,
      clock,
      logger: app.logger,
      store: runnerStore,
      campaigns: campaignStore,
      recipients,
      lists,
      templates: {
        get: (id) => templateStore.get(id),
        getDefault: () => templateStore.getDefault(),
      },
      renderer,
      tracking,
      emailer,
      attachments,
      embedImages,
      settings: () => {
        const current = must(settings, "settings").read();
        const campaign = campaignSettings();
        return {
          batchSize: current["app.batch_size"],
          concurrency: current["app.concurrency"],
          messageRate: current["app.message_rate"],
          maxSendErrors: current["app.max_send_errors"],
          slidingWindow: current["app.message_sliding_window"],
          slidingWindowDuration: current["app.message_sliding_window_duration"],
          slidingWindowRate: current["app.message_sliding_window_rate"],
          rootUrl: campaign.rootUrl,
          messengers: campaign.messengers,
          unsubscribeHeader: campaign.unsubscribeHeader,
          disableTracking: campaign.disableTracking,
          individualTracking: campaign.individualTracking,
          brand: campaign.brand,
        };
      },
      notify: notifier,
    });
    events = createEventStore(db, subscriberStore, {
      emailAllowed: (email) => {
        const current = must(settings, "settings").read();
        return allowedDomain(
          email,
          current["privacy.domain_allowlist"],
          current["privacy.domain_blocklist"],
        );
      },
      exitThenTrigger: enrollments.exitThenTrigger,
      i18n: app.i18n,
    });
    registerEventRoutes(router, events, auth, roles);
    mail = createSubscriberMail({
      subscribers: subscriberStore,
      sends,
      campaigns: campaignStore,
      tracking,
      events,
      bounces,
      renderer,
      i18n: app.i18n,
      clock,
      logger: app.logger,
      settings: pages,
    });
    signups = createSignupMail({ db, clock, logger: app.logger, mail });
    const captchaOptions = () => must(settings, "settings").read()["security.captcha"];
    registerPublicRoutes(router, {
      db,
      lists,
      subscribers: subscriberStore,
      mail,
      settings: pages,
      captcha: budgets.captcha(captchaOptions),
      altchaComplexity: () => captchaOptions().altcha.complexity,
      limits,
      clientAddress,
    });
    registerArchiveRoutes(router, {
      store: campaignStore,
      subscribers: subscriberStore,
      templates,
      renderer,
      settings: pages,
      publicImages: createPublicImages(media, (name) =>
        files.url(must(settings, "settings").read()["app.root_url"], name),
      ),
    });
    sequences = createSequenceStore(db, clock, {
      templates,
      lists,
      enrollments,
    });
    registerSequenceRoutes(router, {
      testSends,
      sequences,
      enrollments,
      subscribers: subscriberStore,
      events,
      sends,
      templates,
      renderer,
      emailer,
      tracking,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          fromEmail: current["app.from_email"][0] ?? "",
          marketing: marketing(),
          domainAllowlist: current["privacy.domain_allowlist"],
          domainBlocklist: current["privacy.domain_blocklist"],
        };
      },
      roles,
      auth,
    });
    purge = createPurge({
      db,
      clock,
      logger: app.logger,
      purges: [
        users.purgeSessions,
        webhooks.purge,
        webhooks.expireSecrets,
        createSendCompaction(db),
        testSends.purge,
        createEventPurge(events),
      ],
    });
    conditions = createConditionEvaluator({ readonly, runner: queryRunner });
    scheduler = createScheduler({
      db,
      clock,
      logger: app.logger,
      enrollments,
      sends,
      subscribers: subscriberStore,
      templates,
      events,
      renderer,
      tracking,
      conditions,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          fromEmail: current["app.from_email"][0] ?? "",
          marketing: marketing(),
        };
      },
    });
    enrollments.onDue(() => must(scheduler, "scheduler").wake());
    deliveries = createWebhookDelivery({
      db,
      clock,
      logger: app.logger,
      webhooks,
      blockPrivate: () => must(settings, "settings").read()["webhooks.block_private_addresses"],
    });
    registerAnalyticsRoutes(router, {
      reader: analyticsReader,
      summaries,
      campaigns: campaignStore,
      roles,
      auth,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          individualTracking: current["privacy.individual_tracking"],
          cacheSlowQueries: current["app.cache_slow_queries"],
        };
      },
    });
    analyticsPurge = createAnalyticsPurge(db, readonly);
    maintenance = registerMaintenanceRoutes(router, {
      subscribers: subscriberStore,
      analytics: analyticsPurge,
      logs,
      auth,
      clock,
      keepOpen: (request) => serverRef.server?.timeout(request, 0),
      individualTracking: () => must(settings, "settings").read()["privacy.individual_tracking"],
    });
    registerAdminRoutes(router, {
      auth,
      roles,
      renderer,
      logger: app.logger,
      send: (message) => must(emailer, "emailer").push(message, { priority: "outbox" }),
      site: () => {
        const current = pages();
        return {
          siteName: current.siteName,
          faviconUrl: current.faviconUrl,
          rootUrl: current.rootUrl,
          googleFonts: googleFontUrl(current.font) !== "",
          cacheSlowQueries: must(settings, "settings").read()["app.cache_slow_queries"],
          disableTracking: must(settings, "settings").read()["privacy.disable_tracking"],
          individualTracking: must(settings, "settings").read()["privacy.individual_tracking"],
          fromEmails: must(settings, "settings").read()["app.from_email"],
          messengers: campaignSettings().messengers,
          publicSubscription: current.subscriptionPage,
          trustedUrls: current.trustedUrls,
          captcha: current.captcha,
          customCss: must(settings, "settings").read()["appearance.admin.custom_css"],
          customJs: must(settings, "settings").read()["appearance.admin.custom_js"],
        };
      },
      settings: pages,
    });
    registerOpenApiRoutes(router, auth);
    registerMcpRoutes(router, {
      auth,
      router,
    });
    summaryRefresh = createSummaryRefresh({
      clock,
      logger: app.logger,
      summaries,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          enabled: current["app.cache_slow_queries"],
          interval: current["app.cache_slow_queries_interval"],
        };
      },
    });
    return {
      app,
      db,
      router,
      attach(server: ProjectServer) {
        serverRef.server = server;
      },
      start(fail: (failure?: unknown) => void) {
        // The loops are created above and start here, in the order they were wired, once the
        // server listens. A start that throws fails the project with the rest.
        // These starts run in the same synchronous turn as the bind (main()): no await may sit
        // between them. Each start recovers its in-flight rows (sends, runner leases, webhook
        // deliveries) before the first request is handled, and a request handled earlier could
        // claim a row that recovery then marks interrupted.
        void must(outbox, "outbox").done.catch(() => fail(new Error("Outbox failed")));
        void must(signups, "signups").done.catch(() => fail(new Error("Opt-in mail failed")));
        void must(deliveries, "deliveries").done.catch(() =>
          fail(new Error("Webhook delivery failed")),
        );
        void must(purge, "purge").done.catch(() => fail(new Error("Retention failed")));
        void must(scheduler, "scheduler").done.catch(() =>
          fail(new Error("Sequence scheduler failed")),
        );
        void must(runner, "runner").done.catch(() => fail(new Error("Campaign runner failed")));
        void must(summaryRefresh, "summaryRefresh").done.catch(() =>
          fail(new Error("Summary refresh failed")),
        );
        try {
          must(outbox, "outbox").start();
          must(runner, "runner").start();
          must(signups, "signups").start();
          must(purge, "purge").start();
          must(scheduler, "scheduler").start();
          must(deliveries, "deliveries").start();
          must(summaryRefresh, "summaryRefresh").start();
        } catch (error) {
          fail(error);
        }
      },
      stop() {
        // An import stops at its next batch and uploads end, so nothing new reaches the writer.
        const importStop = must(importer, "importer").close();
        const maintenanceStop = must(maintenance, "maintenance").close();
        // Stop campaign and sequence claims first. The campaign batch in flight finishes or
        // is abandoned by the emailer's drain deadline; its unsent rest returns to the cursor.
        const runnerStop = must(runner, "runner").stop();
        const schedulerStop = must(scheduler, "scheduler").stop();
        const outboxStop = must(outbox, "outbox").stop();
        const purgeStop = must(purge, "purge").stop();
        const signupStop = must(signups, "signups").stop();
        const deliveryStop = must(deliveries, "deliveries").stop();
        const summaryStop = must(summaryRefresh, "summaryRefresh").stop();
        const readerClose = must(analyticsReader, "analyticsReader").close();
        const messagingClose = must(emailer, "emailer").close();
        return [
          importStop,
          maintenanceStop,
          runnerStop,
          schedulerStop,
          outboxStop,
          purgeStop,
          signupStop,
          deliveryStop,
          summaryStop,
          readerClose,
          messagingClose,
        ];
      },
      close: closeAll,
      syncAdmin(account: AdminAccount) {
        must(users, "users").syncCopy(account);
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
