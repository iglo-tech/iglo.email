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
import { createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";

async function main(): Promise<void> {
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
  let campaigns: ReturnType<typeof createCampaignListReferences> | undefined;
  let roles: ReturnType<typeof createRoles> | undefined;
  let users: ReturnType<typeof createUserStore> | undefined;
  let settings: ReturnType<typeof createSettings> | undefined;
  let emailer: ReturnType<typeof createEmailer> | undefined;
  let sends: ReturnType<typeof createSends> | undefined;
  let outbox: ReturnType<typeof startOutbox> | undefined;
  try {
    runMigrations(db, bootstrap.config.dataDir, clock, productionMigrations);
    lists = createListReferences(db);
    roles = createRoles(db, lists);
    settings = createSettings(db, clock, bootstrap.config.rootUrl, roles);
    counts = createListCounts(db);
    subscriberStore = createSubscriberStore(db, clock, lists);
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
    const router = createRouter();
    registerUserRoutes(router, users, roles, auth);
    registerListRoutes(router, listStore, roles, auth);
    registerSubscriberRoutes(router, subscriberStore, roles, auth, () => {
      const current = settings!.read();
      return {
        "privacy.domain_allowlist": current["privacy.domain_allowlist"],
        "privacy.domain_blocklist": current["privacy.domain_blocklist"],
      };
    });
    emailer = createEmailer({
      clock,
      settings: () => {
        const current = settings!.read();
        return { smtp: current.smtp, rootUrl: current["app.root_url"] };
      },
    });
    registerSettingsRoutes(router, settings, auth, createSMTPTest(settings, emailer, app.i18n));
    sends = createSends({
      db,
      clock,
      subscribers: subscriberStore,
      rootUrl: () => settings!.read()["app.root_url"],
    });
    registerSendRoutes(router, sends, auth);
    outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
    const server = startServer(app, router);
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const shutdown = (failure?: unknown) => {
        if (closing) return;
        closing = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        const outboxStop = outbox!.stop();
        const messagingClose = emailer!.close();
        const httpStop = server.stop();
        Promise.allSettled([outboxStop, messagingClose, httpStop]).then((results) => {
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
    });
  } finally {
    const stopped = outbox?.stop();
    await emailer?.close();
    await stopped?.catch(() => {});
    sends?.close();
    settings?.close();
    users?.close();
    listStore?.close();
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
