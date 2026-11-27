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
import type { InstanceSettingsReader } from "@/settings/instance";
import { sessionDuration } from "@/settings/duration";
import { registerSettingsRoutes } from "@/settings/routes";
import type { CustomCode, CustomCodeChange } from "@/settings/routes";
import { bindKey } from "@/settings/validate";
import { registerSourceRoutes, sourceGuard, sourceListsCheck } from "@/sources/routes";
import { createSourceProvider } from "@/sources/project";
import { createSendTimeLookup } from "@/sources/send-time";
import { createSourceRecords, storedGrantRules } from "@/sources/records-stream";
import type { SourceRecords } from "@/sources/records-stream";
import { sourceConfig } from "@/sources/settings";
import { refuseWhileHeld, restoreHold } from "@/settings/hold";
import type { Dispatcher, Sender } from "@/messaging/dispatcher";
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
import { createPlannedCampaigns } from "@/campaigns/planned";
import type { PlannedCampaigns } from "@/campaigns/planned";
import type { CapacityAnswer, CapacitySource, Candidate } from "@/messaging/capacity";
import { registerArchiveRoutes } from "@/public/archive";
import { googleFontUrl } from "@/public/brand";
import type { PageSite } from "@/public/layout";
import { createSubscriberMail, createSignupMail } from "@/public/mail";
import type { SubscriberMail } from "@/public/mail";
import { createPrivacy } from "@/public/privacy";
import { personalPageHeaders } from "@/public/headers";
import { registerPublicRoutes } from "@/public/routes";
import { publicSettings } from "@/public/settings";
import { createBounceStore } from "@/bounces/store";
import { registerBounceRoutes } from "@/bounces/routes";
import { createSesProject } from "@/bounces/ses-route";
import type { SesProject } from "@/bounces/ses-route";
import { createWebhookDelivery } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";
import type { AnalyticsReader } from "@/analytics/reader";
import { createAnalyticsPurge } from "@/analytics/purge";
import { createSubscriberTracking } from "@/analytics/subscriber";
import { registerAnalyticsRoutes } from "@/analytics/routes";
import { registerAdminRoutes } from "@/admin/routes";
import { createProjectActivity } from "@/analytics/activity";
import type { ProjectActivity } from "@/analytics/activity";
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
   * The instance settings (B139, D154): the one configuration every project reads, and its change
   * notifications. A project holds no copy of an instance key (invariant 5).
   */
  readonly settings: InstanceSettingsReader;
  /**
   * The instance's one dispatcher (B141, 14-projects section 7): its SMTP pools and start schedule
   * are every project's. A project gets a sender from it and never builds an emailer of its own.
   */
  readonly dispatcher: Dispatcher;
  /** `--root-url`: the instance host, which the Settings page links to (B139). */
  readonly instanceRootUrl: string;
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
  /**
   * The served projects' slugs and names, for the header's switcher (B143a, D157). Only the
   * admin's copy sees it, since the admin is the one account that is in every project.
   */
  readonly projects?: () => ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  /**
   * The instance's capacity forecast (B145a): `GET /api/sending/capacity` on this project's host
   * asks it with this project's own source. Without it (a fixture) the route is not served.
   */
  readonly capacity?: {
    forecast(source: CapacitySource, candidate: Candidate | null): Promise<CapacityAnswer>;
  };
  /**
   * Whether a request error is an expected one the log leaves out (B155a, D176): the instance's
   * bounded HTTP stop cuts the requests still running and has already said so in one line.
   */
  readonly expectedError?: (error: unknown) => boolean;
}

/** What one project is wired from: its identity, its directory, its root URL and its seed. */
export interface ProjectOptions {
  readonly slug: string;
  /** The project's name in the registry, which the MCP instructions name (B145a); the slug if none. */
  readonly name?: string;
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

/** The SES route's narrow view of a project: mine or not mine, record, and its public page. */
export interface ProjectSes extends SesProject {
  /** The branding of the route's 404 and 429 pages. */
  page(): PageSite;
  /** Bounces a minute this project's settings allow the provider's route. */
  bounceLimit(): number;
}

/** A wired project. main() binds `router` on `app`, then calls start(), then stop() and close(). */
export interface Project {
  readonly app: App;
  readonly db: Database;
  readonly router: Router;
  /** This project's counts for the instance's capacity forecast (B145a). */
  readonly capacity: CapacitySource;
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
  /**
   * Stops this project's sending at once, as stop() does later (a delete, D157): its slot requests
   * and unused slots go back, a push waiting for its start ends not-started (its claim is handed
   * back), and no new request is answered. Resolves when the pushes in SMTP flight have settled, or
   * after the sender's 5 s close deadline. stop() and close() then reuse the same close.
   */
  stopSending(): Promise<void>;
  /** Closes every store and the database. main() calls it last, after the lock is still held. */
  close(): Promise<void>;
  /** What the instance's SES route reaches of this project (B142). */
  readonly ses: ProjectSes;
  /** Writes the instance admin account into this project's copy (B140). */
  syncAdmin(account: AdminAccount): void;
  /**
   * Sends the SMTP test mail of the instance settings page through this project's sender, with its
   * default from address and brand (B139, D154). Only the primary project's is used.
   */
  smtpTest(body: unknown, revalidate: () => void): Promise<void>;
  /** This project's log lines, as its `GET /api/logs` serves them (the instance Logs page). */
  logs(): ReadonlyArray<string>;
  /** Counts only, for the instance Projects page (B143a): queued, running, sent since `since`. */
  activity(since: Date): ProjectActivity;
  /** The public custom CSS and JS (D201), as the instance's appearance route reads them. */
  customCode(): CustomCode;
  /** The instance's write of them (D201): the only one, a project's settings API refuses it. */
  setCustomCode(change: CustomCodeChange): void;
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
  let activity: ReturnType<typeof createProjectActivity> | undefined;
  let logs: ReturnType<typeof createLogBuffer> | undefined;
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
  let sender: Sender | undefined;
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
  let sourceRecords: SourceRecords | undefined;
  let campaignStore: ReturnType<typeof createCampaignStore> | undefined;
  let mediaStore: ReturnType<typeof createMediaStore> | undefined;
  let runnerStore: ReturnType<typeof createRunnerStore> | undefined;
  let recipients: ReturnType<typeof createCampaignRecipients> | undefined;
  let planned: PlannedCampaigns | undefined;
  let runner: ReturnType<typeof createCampaignRunner> | undefined;
  let mail: SubscriberMail | undefined;
  let signups: ReturnType<typeof createSignupMail> | undefined;
  let webhooks: ReturnType<typeof createWebhookStore> | undefined;
  let bounces: ReturnType<typeof createBounceStore> | undefined;
  let deliveries: ReturnType<typeof createWebhookDelivery> | undefined;
  let ses: ProjectSes | undefined;
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
  /** This project's counts for the instance's forecast (B145a): counts and send times, no rows. */
  const source: CapacitySource = {
    starts: (day, from) => ({
      campaign: must(planned, "planned").starts(day, from),
      other: must(sends, "sends").starts(day, from),
    }),
    planned: () => must(planned, "planned").planned(),
  };
  // The finally body of the composition: every store that exists is closed, the database last.
  // A wiring failure runs it before the error propagates, so nothing that was opened stays open.
  const closeAll: () => Promise<void> = async () => {
    enrollments?.onDue(() => {});
    // D173: the source stream writes subscribers and enrollments, so it stops before any store.
    await sourceRecords?.stop();
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
    const closing = sender?.close();
    await running?.catch(() => {});
    await closing;
    await queryRunner?.close();
    conditions?.close();
    await stopped?.catch(() => {});
    await retaining?.catch(() => {});
    await signing?.catch(() => {});
    // D201: an opt-in or data mail still making its text part (an admin write's, too) is queued
    // before any store closes, so none is lost or written after close.
    await mail?.settled();
    await delivering?.catch(() => {});
    await summarizing?.catch(() => {});
    summaries?.close();
    analyticsPurge?.close();
    bounces?.close();
    webhooks?.close();
    sequences?.close();
    planned?.close();
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
    activity?.close();
    roles?.close();
    lists?.close();
    db.close(true);
  };
  try {
    runMigrations(db, directory, clock, productionMigrations, options.snapshots);
    lists = createListReferences(db);
    roles = createRoles(db, lists);
    settings = createSettings(db, clock, rootUrl, services.settings);
    counts = createListCounts(db);
    activity = createProjectActivity(db);
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
    const buffer = createLogBuffer(clock);
    logs = buffer;
    const logger = createSourceLogger(options.slug, buffer, services.expectedError);
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
    // The per-push context the instance's one emailer receives from this project (B141).
    sender = services.dispatcher.sender({
      rootUrl: () => must(settings, "settings").read()["app.root_url"],
      copyAllowed: (address) =>
        !addressBlocklisted(must(subscriberStore, "subscriberStore"), address),
      // Past every loop's and route's own check: nothing reaches SMTP from a held project (D67).
      refuse: () => refuseWhileHeld(db),
    });
    const emailer = sender;
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
    const smtpTest = createSMTPTest(settings, emailer, app.i18n, renderer);
    const uploadCheck = uploadPathCheck(directory, media);
    const grantCheck = sourceListsCheck({ name: (id) => must(lists, "lists").name(id) });
    registerSettingsRoutes(router, settings, auth, smtpTest, (next, current) => {
      uploadCheck(next, current);
      grantCheck(next, current);
    });
    registerSourceRoutes(router, {
      settings,
      auth,
      clock,
      stream: () => sourceRecords?.stream() ?? null,
    });
    // D172: one adapter per configured source, shared by the sequence routes and the scheduler.
    const projectSettings = settings;
    const externalSource = createSourceProvider({
      settings: () => projectSettings.read(),
      clock,
      guard: sourceGuard(() => projectSettings.read()),
    });
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
    outbox = createOutbox({ db, clock, logger: app.logger, sends, sender });
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
      campaignStatusChanged: (id) => runner?.statusChanged(id),
      // The forecast is the instance's; this project gives its own counts (B145a).
      capacity: services.capacity && {
        forecast: (candidate) => must(services.capacity, "capacity").forecast(source, candidate),
        campaign: (id) => must(planned, "planned").campaign(id),
      },
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
      subscribers: subscriberStore,
      roles,
      auth,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          enabled: current["bounce.enabled"],
          webhooksEnabled: current["bounce.webhooks_enabled"],
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
    // The instance's SES route reaches this project only through these (B142, D156).
    const sesProject = createSesProject({ db, store: bounces, logger: app.logger });
    ses = {
      ...sesProject,
      page: pages,
      bounceLimit: () => Math.max(budgets.bounceWebhookPerMinute, pages().rateLimits.unsubscribe),
    };
    recipients = createCampaignRecipients(db);
    const measured = recipients;
    planned = createPlannedCampaigns(db, {
      recipients: measured,
      listOptin: (id) => must(lists, "lists").subscriberMetadata(id)?.optin ?? null,
    });
    const templateStore = templates;
    // D174: source-linked recipients' fresh address and name at send time, for campaigns and steps.
    const sendTime = createSendTimeLookup({
      db,
      source: externalSource,
      subscribers: subscriberStore,
      enrollments,
      emailAllowed: (email) => {
        const current = must(settings, "settings").read();
        return allowedDomain(
          email,
          current["privacy.domain_allowlist"],
          current["privacy.domain_blocklist"],
        );
      },
    });
    runner = createCampaignRunner({
      sendTime,
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
      sender,
      attachments,
      embedImages,
      settings: () => {
        const current = must(settings, "settings").read();
        const campaign = campaignSettings();
        return {
          maxSendErrors: current["app.max_send_errors"],
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
      sourceConfigured: () => externalSource() !== null,
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
      source: externalSource,
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
      source: externalSource,
      sendTime,
      settings: () => {
        const current = must(settings, "settings").read();
        return {
          fromEmail: current["app.from_email"][0] ?? "",
          marketing: marketing(),
        };
      },
    });
    enrollments.onDue(() => must(scheduler, "scheduler").wake());
    // D173: the project's source stream with the record handler, started with the other loops.
    const recordSettings = projectSettings;
    sourceRecords = createSourceRecords({
      db,
      clock,
      logger: app.logger,
      config: () => sourceConfig(recordSettings.read()),
      grantRules: () => storedGrantRules(recordSettings.read()),
      guard: sourceGuard(() => recordSettings.read()),
      subscribers: subscriberStore,
      enrollments,
      emailAllowed: (email) => {
        const current = recordSettings.read();
        return allowedDomain(
          email,
          current["privacy.domain_allowlist"],
          current["privacy.domain_blocklist"],
        );
      },
    });
    const records = sourceRecords;
    // A saved setting (a source, a grant rule, the private hosts) is compared at once.
    recordSettings.onUpdate(
      () => void records.refresh().catch((error: unknown) => app.logger.error(error)),
    );
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
      logs: buffer,
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
      send: (message) => must(sender, "sender").push(message),
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
          instanceUrl: services.instanceRootUrl,
          switcher: services.projects && {
            current: options.slug,
            projects: services.projects(),
          },
        };
      },
      settings: pages,
    });
    registerOpenApiRoutes(router, auth);
    registerMcpRoutes(router, {
      auth,
      router,
      // B170 (D198): the registry's current name, read on each `initialize`.
      project: () =>
        services.projects?.().find((entry) => entry.slug === options.slug)?.name ??
        options.name ??
        options.slug,
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
      capacity: source,
      ses: must(ses, "ses"),
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
          must(sourceRecords, "sourceRecords").start();
        } catch (error) {
          fail(error);
        }
      },
      stop() {
        // An import stops at its next batch and uploads end, so nothing new reaches the writer.
        const importStop = must(importer, "importer").close();
        // D173: no new source record reaches the writer either.
        const recordsStop = must(sourceRecords, "sourceRecords").stop();
        const maintenanceStop = must(maintenance, "maintenance").close();
        // Stop campaign and sequence claims first, and this project's sending with them: its
        // requests and unused slots go back, a push still waiting for its start ends not-started
        // (its claim is handed back), and the pushes in SMTP flight drain under their deadlines.
        const runnerStop = must(runner, "runner").stop();
        const schedulerStop = must(scheduler, "scheduler").stop();
        const outboxStop = must(outbox, "outbox").stop();
        const purgeStop = must(purge, "purge").stop();
        const signupStop = must(signups, "signups").stop();
        const deliveryStop = must(deliveries, "deliveries").stop();
        const summaryStop = must(summaryRefresh, "summaryRefresh").stop();
        const readerClose = must(analyticsReader, "analyticsReader").close();
        const messagingClose = must(sender, "sender").close();
        return [
          importStop,
          recordsStop,
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
      stopSending: () => must(sender, "sender").close(),
      close: closeAll,
      syncAdmin(account: AdminAccount) {
        must(users, "users").syncCopy(account);
      },
      smtpTest(body: unknown, revalidate: () => void) {
        refuseWhileHeld(db);
        return smtpTest(body, revalidate);
      },
      logs: () => must(logs, "logs").lines(),
      activity: (since: Date) => must(activity, "activity").read(since),
      /** The public custom CSS and JS (D201): stored here, written only through the instance. */
      customCode: (): CustomCode => {
        const current = must(settings, "settings").read();
        return {
          css: String(current["appearance.public.custom_css"]),
          js: String(current["appearance.public.custom_js"]),
        };
      },
      /** The instance's write of the public custom CSS and JS (D201); a field left out keeps its value. */
      setCustomCode(change: CustomCodeChange): void {
        must(settings, "settings").update((current) => {
          let next = current;
          if (change.css !== undefined) {
            next = bindKey(next, "appearance.public.custom_css", change.css);
          }
          if (change.js !== undefined) {
            next = bindKey(next, "appearance.public.custom_js", change.js);
          }
          return next;
        });
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
