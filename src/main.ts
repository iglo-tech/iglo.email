// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { createApp, createErrorLogger } from "@/app";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { helpText, parseBootstrap, versionText } from "@/config/bootstrap";
import { createClientAddress } from "@/server/client-address";
import type { Router } from "@/server/router";
import { startServer } from "@/server/server";
import { createRouter } from "@/server/server";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import {
  childArgument,
  createQueryRunner,
  openReadOnly,
  runQueryChild,
} from "@/subscribers/query-runner";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { resetPasswordHelp, runResetPassword } from "@/users/cli";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";
import { createSettings } from "@/settings/store";
import { sessionDuration } from "@/settings/duration";
import { registerSettingsRoutes } from "@/settings/routes";
import { refuseWhileHeld, restoreHold } from "@/settings/hold";
import { createEmailer } from "@/messaging/email";
import { createSMTPTest } from "@/messaging/test";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { createSendAnonymizer, createUnlinkedSends } from "@/messaging/anonymize";
import { startOutbox } from "@/messaging/outbox";
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
import { startEventRetention } from "@/events/retention";
import { createConditionEvaluator } from "@/conditions/evaluate";
import { startScheduler } from "@/scheduler/scheduler";
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignRoutes } from "@/campaigns/routes";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createImporter } from "@/subscribers/import/importer";
import { registerImportRoutes } from "@/subscribers/import/routes";
import { backupHelp, runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";
import { createAttachments } from "@/media/attachments";
import { createFilesystem } from "@/media/filesystem";
import { createEmbeds, createPublicImages } from "@/media/embed";
import { registerMediaRoutes, uploadPathCheck } from "@/media/routes";
import { createMediaStore } from "@/media/store";
import { createRunnerStore } from "@/campaigns/runner/store";
import { startCampaignRunner } from "@/campaigns/runner/runner";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import { registerArchiveRoutes } from "@/public/archive";
import { createSubscriberMail, startSignupMail, type SubscriberMail } from "@/public/mail";
import { rateLimited } from "@/public/rate-limit";
import { registerPublicRoutes } from "@/public/routes";
import { publicSettings } from "@/public/settings";
import { createBounceStore } from "@/bounces/store";
import { registerBounceRoutes } from "@/bounces/routes";
import { startWebhookDelivery } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";
import {
  analyticsChildArgument,
  createAnalyticsReader,
  runAnalyticsChild,
} from "@/analytics/reader";
import { createAnalyticsPurge } from "@/analytics/purge";
import { createSubscriberTracking } from "@/analytics/subscriber";
import { registerAnalyticsRoutes } from "@/analytics/routes";
import { registerAdminRoutes } from "@/admin/routes";
import { createLogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { createSummaries, startSummaryRefresh } from "@/analytics/summaries";
import { registerOpenApiRoutes } from "@/openapi/routes";

/** `inspect` sees the composed router before anything listens; a test may throw to stop there. */
export async function main(inspect?: (router: Router) => void): Promise<void> {
  // The compiled executable re-runs itself to evaluate raw subscriber SQL in a killable process.
  if (process.argv[2] === childArgument) return runQueryChild();
  if (process.argv[2] === analyticsChildArgument) return runAnalyticsChild();
  if (process.argv[2] === flushChildArgument) return runFlushChild();
  if (process.argv[2] === "backup") return runBackup(process.argv.slice(3), process.env);
  if (process.argv[2] === "reset-password")
    return runResetPassword(process.argv.slice(3), process.env);
  const bootstrap = parseBootstrap(process.argv.slice(2), process.env);
  if (bootstrap.help) {
    process.stdout.write(helpText + backupHelp + resetPasswordHelp);
    return;
  }
  if (bootstrap.version) {
    process.stdout.write(versionText);
    return;
  }

  const clock = createRealClock();
  const db = openDatabase(bootstrap.config.dataDir);
  let lists: ReturnType<typeof createListReferences> | undefined;
  let listStore: ReturnType<typeof createListStore> | undefined;
  let subscriberStore: ReturnType<typeof createSubscriberStore> | undefined;
  let counts: ReturnType<typeof createListCounts> | undefined;
  let readonly: ReturnType<typeof openReadOnly> | undefined;
  let queryRunner: ReturnType<typeof createQueryRunner> | undefined;
  let subscriberQuery: ReturnType<typeof createSubscriberQuery> | undefined;
  let campaigns: ReturnType<typeof createCampaignListReferences> | undefined;
  let roles: ReturnType<typeof createRoles> | undefined;
  let users: ReturnType<typeof createUserStore> | undefined;
  let settings: ReturnType<typeof createSettings> | undefined;
  let emailer: ReturnType<typeof createEmailer> | undefined;
  let sends: ReturnType<typeof createSends> | undefined;
  let templateReferences: ReturnType<typeof createCampaignTemplateReferences> | undefined;
  let templates: ReturnType<typeof createTemplateStore> | undefined;
  let outbox: ReturnType<typeof startOutbox> | undefined;
  let tracking: ReturnType<typeof createTracking> | undefined;
  let subscriberTracking: ReturnType<typeof createSubscriberTracking> | undefined;
  let events: ReturnType<typeof createEventStore> | undefined;
  let retention: ReturnType<typeof startEventRetention> | undefined;
  let enrollments: ReturnType<typeof createEnrollments> | undefined;
  let sequences: ReturnType<typeof createSequenceStore> | undefined;
  let conditions: ReturnType<typeof createConditionEvaluator> | undefined;
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  let campaignStore: ReturnType<typeof createCampaignStore> | undefined;
  let mediaStore: ReturnType<typeof createMediaStore> | undefined;
  let runnerStore: ReturnType<typeof createRunnerStore> | undefined;
  let recipients: ReturnType<typeof createCampaignRecipients> | undefined;
  let runner: ReturnType<typeof startCampaignRunner> | undefined;
  let mail: SubscriberMail | undefined;
  let signups: ReturnType<typeof startSignupMail> | undefined;
  let webhooks: ReturnType<typeof createWebhookStore> | undefined;
  let bounces: ReturnType<typeof createBounceStore> | undefined;
  let deliveries: ReturnType<typeof startWebhookDelivery> | undefined;
  let analyticsReader: ReturnType<typeof createAnalyticsReader> | undefined;
  let summaries: ReturnType<typeof createSummaries> | undefined;
  let summaryRefresh: ReturnType<typeof startSummaryRefresh> | undefined;
  let analyticsPurge: ReturnType<typeof createAnalyticsPurge> | undefined;
  let maintenance: ReturnType<typeof registerMaintenanceRoutes> | undefined;
  let importer: ReturnType<typeof createImporter> | undefined;
  try {
    runMigrations(db, bootstrap.config.dataDir, clock, productionMigrations);
    lists = createListReferences(db);
    roles = createRoles(db, lists);
    settings = createSettings(db, clock, bootstrap.config.rootUrl, roles);
    counts = createListCounts(db);
    enrollments = createEnrollments(db, clock);
    webhooks = createWebhookStore(db, clock);
    const webhookEffects = createWebhookEffects(webhooks, () => subscriberStore!);
    const anonymizeSends = createSendAnonymizer(db);
    const unlinkedSends = createUnlinkedSends(db);
    const subscriberEffects = {
      ...enrollments.subscriberEffects,
      ...webhookEffects.subscriberEffects,
      deleting(deleted: { id: bigint; email: string }[], wipe?: boolean) {
        bounces!.deleteForSends(unlinkedSends(deleted.map(({ email }) => email)));
        anonymizeSends(deleted);
        webhookEffects.deleting(deleted, wipe);
      },
    };
    subscriberStore = createSubscriberStore(db, clock, lists, subscriberEffects);
    readonly = openReadOnly(db.filename);
    queryRunner = createQueryRunner({
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
    analyticsReader = createAnalyticsReader({ path: db.filename });
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
          (settings!.read()["app.cache_slow_queries"] ? cachedSummaries.listCounts() : null) ??
          liveCounts.all(),
      },
      campaigns,
    );
    users = createUserStore(db, clock, roles);
    const clientAddress = createClientAddress(() => settings!.read()["security.trusted_proxies"]);
    const auth = await createAuthentication(users, roles, clock, bootstrap.config.rootUrl, {
      ...defaultAuthPolicy,
      clientAddress,
      get sessionDurationMs() {
        return sessionDuration(
          settings!.read()["security.session_duration"],
          clock.now().getTime(),
        );
      },
    });
    await bootstrapAdmin(users, auth, bootstrap.config.initialAdmin);
    const logs = createLogBuffer(clock);
    const app = createApp({
      bootstrap: bootstrap.config,
      clock,
      db,
      logger: createErrorLogger(logs),
      i18n: createTranslation(),
    });
    const renderer = createRenderer(clock, app.i18n);
    templateReferences = createCampaignTemplateReferences(db);
    templates = createTemplateStore(db, clock, renderer, templateReferences);
    templates.initialize();
    const router = createRouter(() => restoreHold(db));
    registerTemplateRoutes(router, templates, renderer, auth);
    registerUserRoutes(router, users, roles, auth);
    registerListRoutes(router, listStore, roles, auth);
    registerSubscriberRoutes(
      router,
      subscriberStore,
      roles,
      auth,
      () => {
        const current = settings!.read();
        return {
          "privacy.domain_allowlist": current["privacy.domain_allowlist"],
          "privacy.domain_blocklist": current["privacy.domain_blocklist"],
        };
      },
      {
        afterAdminWrite: (row, listIds) => mail!.afterAdminWrite(row, listIds),
        send: (row) => {
          mail!.optin(row);
        },
      },
      {
        events: (id, page, perPage) => events!.page(id, page, perPage),
        enrollments: (id, page, perPage) => enrollments!.list({ subscriberId: id, page, perPage }),
        sends: (id, page, perPage) => sends!.list({ subscriberId: id, page, perPage }),
      },
      {
        activity: (id) => subscriberTracking!.activity(id),
        clearActivity: (id, type) => subscriberTracking!.clear(id, type),
        exportSections: (row) => mail!.exportSections(row),
      },
    );
    registerSubscriberQueryRoutes(router, subscriberQuery, subscriberStore, roles, auth);
    const touchLists = listStore.touch;
    importer = createImporter({
      dataDir: bootstrap.config.dataDir,
      clock,
      logger: app.logger,
      i18n: app.i18n,
      store: subscriberStore,
      touchLists,
      domainPolicy: () => {
        const current = settings!.read();
        return {
          allow: current["privacy.domain_allowlist"],
          block: current["privacy.domain_blocklist"],
        };
      },
    });
    await importer.sweep().catch((error) => app.logger.error(error));
    registerImportRoutes(router, { importer, roles, auth });
    emailer = createEmailer({
      clock,
      settings: () => {
        const current = settings!.read();
        return { smtp: current.smtp, rootUrl: current["app.root_url"] };
      },
      copyAllowed: (address) => !addressBlocklisted(subscriberStore!, address),
      // Past every loop's and route's own check: nothing reaches SMTP from a held install (D67).
      refuse: () => refuseWhileHeld(db),
    });
    mediaStore = createMediaStore(db, clock);
    const media = mediaStore;
    const files = createFilesystem(bootstrap.config.dataDir, () => {
      const current = settings!.read();
      return {
        uploadPath: current["upload.filesystem.upload_path"],
        uploadUri: current["upload.filesystem.upload_uri"],
      };
    });
    // A database that names a directory it must not serve from refuses media, not the server:
    // the reason is logged here, and each media operation refuses with it (D64).
    await files.sweep().catch((error) => app.logger.error(error));
    registerSettingsRoutes(
      router,
      settings,
      auth,
      createSMTPTest(settings, emailer, app.i18n, renderer),
      uploadPathCheck(bootstrap.config.dataDir, media),
    );
    const marketing = () => marketingSettings(settings!.read());
    const pages = () => publicSettings(settings!.read());
    const limit = (name: keyof ReturnType<typeof publicSettings>["rateLimits"]) =>
      rateLimited(
        clock,
        {
          get limit() {
            return pages().rateLimits[name];
          },
          windowMs: 60_000,
          maxPeers: 10_000,
        },
        () => pages().siteName,
        clientAddress,
      );
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
      rootUrl: () => settings!.read()["app.root_url"],
      ended: webhookEffects.sendEnded,
      marketingPolicy: createMarketingPolicy({
        subscribers: subscriberStore,
        lists,
        settings: marketing,
        campaignDeliveries: runnerStore,
      }),
    });
    tracking = createTracking(db, clock);
    subscriberTracking = createSubscriberTracking(db);
    registerSendRoutes(router, sends, auth);
    registerWebhookRoutes(router, { webhooks, auth });
    outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
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
        const current = settings!.read();
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
    });
    registerMediaRoutes(router, {
      store: media,
      files,
      auth,
      settings: () => {
        const current = settings!.read();
        return {
          provider: current["upload.provider"],
          extensions: current["upload.extensions"],
          rootUrl: current["app.root_url"],
        };
      },
    });
    campaignStore = createCampaignStore(db, clock, {
      templateExists: (id) => templates!.get(id) !== null,
      defaultTemplate: () => templates!.getDefault()?.id ?? null,
      listName: (id) => lists!.name(id),
      mediaFilename: (id) => media.filename(id),
    });
    const campaignSettings = () => {
      const current = settings!.read();
      return {
        // listmonk getDefaultFromEmail: the first configured address.
        fromEmail: current["app.from_email"][0] ?? "",
        rootUrl: current["app.root_url"],
        siteName: current["app.site_name"],
        messengers: [
          "email",
          ...(current.smtp as { enabled: boolean; name: string }[])
            .filter((s) => s.enabled && s.name)
            .map((s) => s.name),
        ],
        unsubscribeHeader: current["privacy.unsubscribe_header"],
        allowBlocklist: current["privacy.allow_blocklist"],
        disableTracking: current["privacy.disable_tracking"],
        individualTracking: current["privacy.individual_tracking"],
      };
    };
    registerCampaignRoutes(router, {
      store: campaignStore,
      templates,
      renderer,
      roles,
      auth,
      lists,
      subscribers: subscriberStore,
      tracking,
      emailer,
      settings: campaignSettings,
      attachments,
      embedImages,
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
    });
    const campaignsByUuid = campaignStore;
    bounces = createBounceStore(db, clock, {
      subscribers: () => subscriberStore!,
      sendTarget: (uuid) => sends!.bounceTarget(uuid),
      campaignID: (uuid) => campaignsByUuid.byUuid(uuid)?.id ?? null,
      recorded: webhookEffects.bounceRecorded,
      actions: () => settings!.read()["bounce.actions"],
    });
    registerBounceRoutes(router, {
      db,
      clock,
      store: bounces,
      subscribers: subscriberStore,
      roles,
      auth,
      settings: () => {
        const current = settings!.read();
        return {
          enabled: current["bounce.enabled"],
          webhooksEnabled: current["bounce.webhooks_enabled"],
          mailgun: current["bounce.mailgun"],
        };
      },
      // Providers post from shared addresses too, with a budget of their own.
      limit: limit("unsubscribe"),
    });
    recipients = createCampaignRecipients(db);
    const templateStore = templates;
    runner = startCampaignRunner({
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
        const current = settings!.read();
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
        };
      },
    });
    events = createEventStore(db, subscriberStore, {
      emailAllowed: (email) => {
        const current = settings!.read();
        return allowedDomain(
          email,
          current["privacy.domain_allowlist"],
          current["privacy.domain_blocklist"],
        );
      },
      exitThenTrigger: enrollments.exitThenTrigger,
    });
    registerEventRoutes(router, events, auth);
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
    signups = startSignupMail({ db, clock, logger: app.logger, mail });
    registerPublicRoutes(router, {
      db,
      lists,
      subscribers: subscriberStore,
      mail,
      settings: pages,
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
        files.url(settings!.read()["app.root_url"], name),
      ),
    });
    sequences = createSequenceStore(db, clock, {
      templates,
      lists,
      enrollments,
    });
    registerSequenceRoutes(router, {
      sequences,
      enrollments,
      subscribers: subscriberStore,
      events,
      sends,
      roles,
      auth,
    });
    retention = startEventRetention({ db, clock, logger: app.logger, events });
    conditions = createConditionEvaluator({ readonly, runner: queryRunner });
    scheduler = startScheduler({
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
        const current = settings!.read();
        return {
          fromEmail: current["app.from_email"][0] ?? "",
          marketing: marketing(),
        };
      },
    });
    enrollments.onDue(() => scheduler!.wake());
    deliveries = startWebhookDelivery({
      db,
      clock,
      logger: app.logger,
      webhooks,
      blockPrivate: () => settings!.read()["webhooks.block_private_addresses"],
    });
    registerAnalyticsRoutes(router, {
      reader: analyticsReader,
      summaries,
      campaigns: campaignStore,
      roles,
      auth,
      settings: () => {
        const current = settings!.read();
        return {
          individualTracking: current["privacy.individual_tracking"],
          cacheSlowQueries: current["app.cache_slow_queries"],
        };
      },
    });
    analyticsPurge = createAnalyticsPurge(db, readonly);
    let server: ReturnType<typeof startServer> | undefined;
    maintenance = registerMaintenanceRoutes(router, {
      subscribers: subscriberStore,
      analytics: analyticsPurge,
      logs,
      auth,
      clock,
      keepOpen: (request) => server?.timeout(request, 0),
      individualTracking: () => settings!.read()["privacy.individual_tracking"],
    });
    registerAdminRoutes(router, {
      auth,
      roles,
      renderer,
      logger: app.logger,
      send: (message) => emailer!.push(message),
      site: () => {
        const current = pages();
        return {
          siteName: current.siteName,
          faviconUrl: current.faviconUrl,
          rootUrl: current.rootUrl,
          lang: settings!.read()["app.lang"],
          cacheSlowQueries: settings!.read()["app.cache_slow_queries"],
          disableTracking: settings!.read()["privacy.disable_tracking"],
          individualTracking: settings!.read()["privacy.individual_tracking"],
          fromEmails: settings!.read()["app.from_email"],
          messengers: campaignSettings().messengers,
          publicSubscription: current.subscriptionPage,
          trustedUrls: current.trustedUrls,
          customCss: settings!.read()["appearance.admin.custom_css"],
          customJs: settings!.read()["appearance.admin.custom_js"],
        };
      },
      settings: pages,
    });
    registerOpenApiRoutes(router, auth);
    summaryRefresh = startSummaryRefresh({
      clock,
      logger: app.logger,
      summaries,
      settings: () => {
        const current = settings!.read();
        return {
          enabled: current["app.cache_slow_queries"],
          interval: current["app.cache_slow_queries_interval"],
        };
      },
    });
    inspect?.(router);
    server = startServer(app, router);
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const shutdown = (failure?: unknown) => {
        if (closing) return;
        closing = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        // An import stops at its next batch and uploads end, so nothing new reaches the writer.
        const importStop = importer!.close();
        const maintenanceStop = maintenance!.close();
        // Stop campaign and sequence claims first. The campaign batch in flight finishes or
        // is abandoned by the emailer's drain deadline; its unsent rest returns to the cursor.
        const runnerStop = runner!.stop();
        const schedulerStop = scheduler!.stop();
        const outboxStop = outbox!.stop();
        const retentionStop = retention!.stop();
        const signupStop = signups!.stop();
        const deliveryStop = deliveries!.stop();
        const summaryStop = summaryRefresh!.stop();
        const readerClose = analyticsReader!.close();
        const messagingClose = emailer!.close();
        const httpStop = listening.stop();
        Promise.allSettled([
          importStop,
          maintenanceStop,
          runnerStop,
          schedulerStop,
          outboxStop,
          retentionStop,
          signupStop,
          deliveryStop,
          summaryStop,
          readerClose,
          messagingClose,
          httpStop,
        ]).then((results) => {
          const error = failure ?? results.find((result) => result.status === "rejected");
          if (error)
            reject(
              error instanceof Error
                ? error
                : error && typeof error === "object" && "reason" in error
                  ? error.reason
                  : new Error("Outbox stopped"),
            );
          else resolve();
        });
      };
      const onSignal = () => shutdown();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      void outbox!.done.catch(() => shutdown(new Error("Outbox failed")));
      void signups!.done.catch(() => shutdown(new Error("Opt-in mail failed")));
      void deliveries!.done.catch(() => shutdown(new Error("Webhook delivery failed")));
      void retention!.done.catch(() => shutdown(new Error("Event retention failed")));
      void scheduler!.done.catch(() => shutdown(new Error("Sequence scheduler failed")));
      void runner!.done.catch(() => shutdown(new Error("Campaign runner failed")));
      void summaryRefresh!.done.catch(() => shutdown(new Error("Summary refresh failed")));
    });
  } finally {
    enrollments?.onDue(() => {});
    await importer?.close();
    await maintenance?.close();
    const running = runner?.stop();
    const scheduling = scheduler?.stop();
    const stopped = outbox?.stop();
    const purging = retention?.stop();
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
    await purging?.catch(() => {});
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
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Failed to start server");
    process.exitCode = 1;
  });
