// B108 (D114): the SES bounce route (the instance's since B142, here with this fixture as its one
// project), the maintenance route that reads the log buffer, and the bounce store, wired onto a
// fixture's router for the tests of a test send's notice. Every provider action is on, so a bounce that was recorded would blocklist its subscriber, which the tests check
// did not happen. Time is the fixture's injected clock; the network is the injected SNS fetch.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import { createAnalyticsPurge } from "@/analytics/purge";
import type { Clock } from "@/clock";
import { createSnsClient } from "@/bounces/ses";
import type { SnsFetch } from "@/bounces/ses";
import { registerBounceRoutes } from "@/bounces/routes";
import { createSesProject, registerSesRoute } from "@/bounces/ses-route";
import type { PageSite } from "@/public/layout";
import { createBounceStore } from "@/bounces/store";
import type { Roles } from "@/roles/roles";
import type { BounceTarget } from "@/messaging/sends";
import type { TestSends } from "@/messaging/test-sends";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import type { LogBuffer } from "@/maintenance/log-buffer";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";
import { TOPIC } from "@/test/bounces/ses-fixture";

const page = (): PageSite => ({
  siteName: "Fixture",
  rootUrl: "http://fixture.test",
  logoUrl: "",
  faviconUrl: "",
  subscriptionPage: false,
  archive: false,
  siteUrl: "",
  accent: "",
  font: "system-sans",
  header: "auto",
});

export function wireNotices(
  router: Router,
  deps: {
    db: Database;
    clock: Clock;
    subscribers: SubscriberStore;
    sendTarget: (uuid: string) => BounceTarget | null;
    roles: Roles;
    auth: Authentication;
    testSends: TestSends;
    snsFetch: SnsFetch;
    logs: LogBuffer;
    logger: ErrorLogger;
  },
) {
  const { db, clock, subscribers, roles, auth, testSends, logs } = deps;
  const store = createBounceStore(db, clock, {
    subscribers: () => subscribers,
    sendTarget: deps.sendTarget,
    campaignID: () => null,
    recorded: () => {},
    actions: () => ({
      soft: { count: 1, action: "blocklist" },
      hard: { count: 1, action: "blocklist" },
      complaint: { count: 1, action: "unsubscribe" },
    }),
    testSend: (messageId) => testSends.find(messageId),
  });
  const analytics = createAnalyticsPurge(db, db);
  registerBounceRoutes(router, {
    db,
    clock,
    store,
    subscribers,
    roles,
    auth,
    settings: () => ({ enabled: true, webhooksEnabled: true }),
    page,
    limit: (_context, next) => next(),
  });
  // The instance's SES route (B142), with this fixture's database as its only project.
  const sesProject = createSesProject({ db, store, logger: deps.logger });
  registerSesRoute(router, {
    clock,
    settings: () => ({ enabled: true, webhooksEnabled: true, ses: true, sesTopics: [TOPIC] }),
    page,
    limit: (_context, next) => next(),
    sns: createSnsClient({ clock, fetch: deps.snsFetch }),
    projects: () => [sesProject],
    logger: deps.logger,
  });
  registerMaintenanceRoutes(router, {
    subscribers,
    analytics,
    logs,
    auth,
    clock,
    keepOpen: () => {},
    individualTracking: () => false,
  });
  return {
    store,
    close() {
      analytics.close();
      store.close();
    },
  };
}
