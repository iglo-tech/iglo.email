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
    const server = startServer(app, router);
    await new Promise<void>((resolve, reject) => {
      const shutdown = () => {
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
        const messagingClose = emailer!.close();
        Promise.all([messagingClose, server.stop()]).then(() => resolve(), reject);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  } finally {
    await emailer?.close();
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
