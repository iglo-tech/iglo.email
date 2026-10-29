// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { createApp, createErrorLogger } from "@/app";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { helpText, parseBootstrap } from "@/config/bootstrap";
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
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";
import { createSettings } from "@/settings/store";
import { sessionDuration } from "@/settings/duration";
import { registerSettingsRoutes } from "@/settings/routes";
import { createEmailer } from "@/messaging/email";
import { createSMTPTest } from "@/messaging/test";
import { addressBlocklisted, createSends } from "@/messaging/sends";
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
import { startEventRetention } from "@/events/retention";

async function main(): Promise<void> {
  // The compiled executable re-runs itself to evaluate raw subscriber SQL in a killable process.
  if (process.argv[2] === childArgument) return runQueryChild();
  const bootstrap = parseBootstrap(process.argv.slice(2), process.env);
  if (bootstrap.help) {
    process.stdout.write(helpText);
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
  let events: ReturnType<typeof createEventStore> | undefined;
  let retention: ReturnType<typeof startEventRetention> | undefined;
  try {
    runMigrations(db, bootstrap.config.dataDir, clock, productionMigrations);
    lists = createListReferences(db);
    roles = createRoles(db, lists);
    settings = createSettings(db, clock, bootstrap.config.rootUrl, roles);
    counts = createListCounts(db);
    subscriberStore = createSubscriberStore(db, clock, lists);
    readonly = openReadOnly(db.filename);
    queryRunner = createQueryRunner({ path: db.filename, timeoutMs: 10_000, concurrency: 2 });
    subscriberQuery = createSubscriberQuery({ db, readonly, clock, runner: queryRunner });
    campaigns = createCampaignListReferences(db);
    listStore = createListStore(db, clock, counts, campaigns);
    users = createUserStore(db, clock, roles);
    const auth = await createAuthentication(users, roles, clock, bootstrap.config.rootUrl, {
      ...defaultAuthPolicy,
      get sessionDurationMs() {
        return sessionDuration(
          settings!.read()["security.session_duration"],
          clock.now().getTime(),
        );
      },
    });
    await bootstrapAdmin(users, auth, bootstrap.config.initialAdmin);
    const app = createApp({
      bootstrap: bootstrap.config,
      clock,
      db,
      logger: createErrorLogger(),
      i18n: createTranslation(),
    });
    const renderer = createRenderer(clock, app.i18n);
    templateReferences = createCampaignTemplateReferences(db);
    templates = createTemplateStore(db, clock, renderer, templateReferences, app.logger);
    templates.initialize();
    const router = createRouter();
    registerTemplateRoutes(router, templates, renderer, auth);
    registerUserRoutes(router, users, roles, auth);
    registerListRoutes(router, listStore, roles, auth);
    registerSubscriberRoutes(router, subscriberStore, roles, auth, () => {
      const current = settings!.read();
      return {
        "privacy.domain_allowlist": current["privacy.domain_allowlist"],
        "privacy.domain_blocklist": current["privacy.domain_blocklist"],
      };
    });
    registerSubscriberQueryRoutes(router, subscriberQuery, subscriberStore, roles, auth);
    emailer = createEmailer({
      clock,
      settings: () => {
        const current = settings!.read();
        return { smtp: current.smtp, rootUrl: current["app.root_url"] };
      },
      copyAllowed: (address) => !addressBlocklisted(subscriberStore!, address),
    });
    registerSettingsRoutes(
      router,
      settings,
      auth,
      createSMTPTest(settings, emailer, app.i18n, renderer),
    );
    const marketing = () => marketingSettings(settings!.read());
    sends = createSends({
      db,
      clock,
      subscribers: subscriberStore,
      rootUrl: () => settings!.read()["app.root_url"],
      marketingPolicy: createMarketingPolicy({
        subscribers: subscriberStore,
        lists,
        settings: marketing,
      }),
    });
    tracking = createTracking(db, clock);
    registerSendRoutes(router, sends, auth);
    outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
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
    });
    registerUnsubscribeRoutes(router, {
      db,
      sends,
      subscribers: subscriberStore,
      tracking,
      settings: marketing,
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
    });
    registerEventRoutes(router, events, auth);
    retention = startEventRetention({ db, clock, logger: app.logger, events });
    const server = startServer(app, router);
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const shutdown = (failure?: unknown) => {
        if (closing) return;
        closing = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        const outboxStop = outbox!.stop();
        const retentionStop = retention!.stop();
        const messagingClose = emailer!.close();
        const httpStop = server.stop();
        Promise.allSettled([outboxStop, retentionStop, messagingClose, httpStop]).then(
          (results) => {
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
          },
        );
      };
      const onSignal = () => shutdown();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      void outbox!.done.catch(() => shutdown(new Error("Outbox failed")));
      void retention!.done.catch(() => shutdown(new Error("Event retention failed")));
    });
  } finally {
    const stopped = outbox?.stop();
    const purging = retention?.stop();
    await emailer?.close();
    await queryRunner?.close();
    await stopped?.catch(() => {});
    await purging?.catch(() => {});
    events?.close();
    sends?.close();
    tracking?.close();
    templates?.close();
    templateReferences?.close();
    settings?.close();
    users?.close();
    listStore?.close();
    subscriberQuery?.close();
    readonly?.close();
    subscriberStore?.close();
    campaigns?.close();
    counts?.close();
    roles?.close();
    lists?.close();
    db.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start server");
  process.exitCode = 1;
});
