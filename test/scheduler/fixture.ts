// In-process production owners wired as src/main.ts does, with the sequence scheduler, a fake
// clock and a loopback SMTP sink. The scheduler's injected clock is observed so a test can wait
// for one complete pass (an idle sleep) without sleeping in real time.
import { fixturePageSite } from "@/test/public/site";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import type { ErrorLogger } from "@/app";
import type { SnsFetch } from "@/bounces/ses";
import { createLogBuffer } from "@/maintenance/log-buffer";
import { createTestSends } from "@/messaging/test-sends";
import { wireNotices } from "@/test/messaging/notice-fixture";
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
import { allowedDomain } from "@/subscribers/email";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { createEventStore } from "@/events/store";
import { registerEventRoutes } from "@/events/routes";
import { createConditionEvaluator } from "@/conditions/evaluate";
import type { ConditionEvaluator } from "@/conditions/evaluate";
import { createEnrollments } from "@/sequences/enrollments";
import { createSequenceStore } from "@/sequences/store";
import { registerSequenceRoutes } from "@/sequences/routes";
import { startScheduler, SCHEDULER_INTERVAL_MS } from "@/scheduler/scheduler";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { createMarketingPolicy } from "@/unsubscribe/policy";
import type { MarketingSettings } from "@/unsubscribe/policy";
import { createPrivacy } from "@/public/privacy";
import { registerUnsubscribeRoutes } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";

export const admin = {
  user: "fixture-admin",
  password: "fixture-admin-password",
};
export const minute = 60_000;
export const hour = 3_600_000;
export const day = 86_400_000;

export async function schedulerFixture(
  options: { sinkReject?: (to: string) => boolean; snsFetch?: SnsFetch } = {},
) {
  const sink = await startSink(options.sinkReject ? { reject: options.sinkReject } : {});
  const directory = mkdtempSync(join(tmpdir(), "iglo-scheduler-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: Array<unknown> = [];
  // The log buffer keeps what GET /api/logs shows (B108); the error list is what stderr would hold.
  const logs = createLogBuffer(clock);
  const logger: ErrorLogger = {
    error(error) {
      errors.push(error);
      logs.add(error);
    },
    attention(message, safe) {
      errors.push(new Error(message));
      logs.attention(safe);
    },
  };
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
    logger,
  });
  const enrollments = createEnrollments(db, clock);
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    subscribers = createSubscriberStore(db, clock, lists, enrollments.subscriberEffects),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const readonly = openReadOnly(db.filename);
  const runner = createQueryRunner({
    path: db.filename,
    timeoutMs: 10_000,
    concurrency: 2,
  });
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, admin);
  // Tests advance the clock by days; a fresh session replaces one that expired.
  const login = async () => {
    const session = await auth.login(admin.user, admin.password);
    if (!session || !("id" in session)) {
      throw new Error("fixture login failed");
    }
    return { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  };
  let sessionHeaders = await login();
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
          email_headers: [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
  });
  const marketing: MarketingSettings = {
    rootUrl: "http://fixture.test",
    siteName: "Fixture list",
    minInterval: "",
    unsubscribeHeader: true,
    allowBlocklist: true,
    individualTracking: false,
    disableTracking: false,
  };
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    marketingPolicy: createMarketingPolicy({
      subscribers,
      lists,
      settings: () => marketing,
    }),
  });
  const tracking = createTracking(db, clock);
  const testSends = createTestSends(db, clock);
  const outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const events = createEventStore(db, subscribers, {
    emailAllowed: (email) => allowedDomain(email, [], []),
    exitThenTrigger: enrollments.exitThenTrigger,
    i18n: app.i18n,
  });
  const sequences = createSequenceStore(db, clock, {
    templates,
    lists,
    enrollments,
  });
  const conditions = createConditionEvaluator({ readonly, runner });
  // A test may act while a condition is being evaluated (an admin edit racing the scheduler),
  // or answer in its place (a slow query timing out), by setting `f.onCondition`.
  type Evaluate = ConditionEvaluator["evaluate"];
  let onCondition:
    | ((
        context: Parameters<Evaluate>[1],
        evaluate: () => ReturnType<Evaluate>,
      ) => ReturnType<Evaluate>)
    | null = null;
  const observed: Pick<ConditionEvaluator, "evaluate"> = {
    evaluate: (condition, context) =>
      onCondition
        ? onCondition(context, () => conditions.evaluate(condition, context))
        : conditions.evaluate(condition, context),
  };

  // Count the scheduler's idle sleeps: one marks the end of a complete pass.
  let passes = 0;
  const schedulerClock: Clock = {
    now: () => clock.now(),
    sleep(ms, signal) {
      if (ms === SCHEDULER_INTERVAL_MS) {
        passes++;
      }
      return clock.sleep(ms, signal);
    },
  };
  const scheduler = startScheduler({
    db,
    clock: schedulerClock,
    logger: app.logger,
    enrollments,
    sends,
    subscribers,
    templates,
    events,
    renderer,
    tracking,
    conditions: observed,
    settings: () => ({
      fromEmail: "Fixture <noreply@fixture.test>",
      marketing,
    }),
  });
  enrollments.onDue(() => scheduler.wake());
  let stopped = false;
  scheduler.done.then(
    () => (stopped = true),
    () => (stopped = true),
  );

  const router = createRouter();
  registerUserRoutes(router, users, roles, auth, fixturePageSite);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth, undefined, undefined, {
    events: (id, page, perPage) => events.page(id, page, perPage),
    enrollments: (id, page, perPage) => enrollments.list({ subscriberId: id, page, perPage }),
    sends: (id, page, perPage) => sends.list({ subscriberId: id, page, perPage }),
  });
  registerTemplateRoutes(router, templates, renderer, auth);
  registerSendRoutes(router, sends, auth);
  registerUnsubscribeRoutes(router, {
    db,
    sends,
    subscribers,
    tracking,
    settings: () => marketing,
    effects: enrollments.unsubscribeEffects,
    page: () => ({
      siteName: marketing.siteName,
      rootUrl: marketing.rootUrl,
      logoUrl: "",
      faviconUrl: "",
      subscriptionPage: false,
      archive: false,
      siteUrl: "",
      allowBlocklist: marketing.allowBlocklist,
      allowPreferences: false,
      allowExport: false,
      allowWipe: false,
    }),
    // B124 (D125): a paired self-wipe is real here, so its suppression can be tested through HTTP.
    // Export is not wired: its mail is the public fixture's concern.
    privacy: createPrivacy({
      db,
      subscribers,
      mail: () => {
        throw new Error("this fixture sends no subscriber data mail");
      },
      page: () => ({
        siteName: marketing.siteName,
        rootUrl: marketing.rootUrl,
        logoUrl: "",
        faviconUrl: "",
        subscriptionPage: false,
        archive: false,
        siteUrl: "",
        allowBlocklist: marketing.allowBlocklist,
        allowPreferences: false,
        allowExport: false,
        allowWipe: true,
      }),
    }),
  });
  registerEventRoutes(router, events, auth, roles);
  registerSequenceRoutes(router, {
    sequences,
    enrollments,
    subscribers,
    events,
    sends,
    templates,
    renderer,
    emailer,
    tracking,
    testSends,
    settings: () => ({
      fromEmail: "Fixture <noreply@fixture.test>",
      marketing,
      domainAllowlist: [],
      domainBlocklist: [],
    }),
    roles,
    auth,
  });
  const notices = wireNotices(router, {
    db,
    clock,
    subscribers,
    sendTarget: (uuid) => sends.bounceTarget(uuid),
    roles,
    auth,
    testSends,
    snsFetch: options.snsFetch ?? (() => Promise.reject(new Error("no network in tests"))),
    logs,
    logger,
  });

  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`http://fixture.test${path}`, init));
  const json = async (path: string, method = "GET", body?: unknown) => {
    let result = await call(path, method, body);
    if (result.status === 403 && result.body?.message === "invalid session") {
      sessionHeaders = await login();
      result = await call(path, method, body);
    }
    return result;
  };
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await request(path, {
      method,
      headers: {
        ...sessionHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  /** An API user with exactly `permissions`, and list grants like `{ id, permissions }`. */
  const apiUser = async (name: string, permissions: Array<string>, lists?: Array<object>) => {
    const role = await json("/api/roles/users", "POST", { name, permissions });
    if (role.status !== 200) {
      throw new Error(`role ${JSON.stringify(role.body)}`);
    }
    const listRole = lists && (await json("/api/roles/lists", "POST", { name, lists }));
    if (listRole && listRole.status !== 200) {
      throw new Error(`list role ${JSON.stringify(listRole.body)}`);
    }
    const user = await json("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
      ...(listRole ? { list_role_id: listRole.body.data.id } : {}),
    });
    if (user.status !== 200) {
      throw new Error(`user ${JSON.stringify(user.body)}`);
    }
    const authorization = `Basic ${btoa(`${name}:${user.body.data.password}`)}`;
    return async (path: string) => {
      const response = await request(path, { headers: { authorization } });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
  };
  /** Yield to I/O, releasing zero-length clock sleeps, until `check` holds. */
  async function until(check: () => boolean | Promise<boolean>, label = "condition") {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}`);
      }
      clock.advance(0);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  /** Advance the clock (or wake the scheduler when 0) and wait for one complete pass. */
  async function pass(ms = SCHEDULER_INTERVAL_MS) {
    await until(() => passes > 0, "scheduler start");
    const before = passes;
    if (ms) {
      clock.advance(ms);
    } else {
      scheduler.wake();
    }
    // A stopped scheduler ends the wait, so a test can assert that it is still running.
    await until(() => passes > before || stopped, "scheduler pass");
  }
  const template = async (body = "<p>{{ subscriber.name }}</p>", subject = "Hello") => {
    const created = await json("/api/templates", "POST", {
      name: "fixture tx",
      type: "tx",
      subject,
      body,
    });
    if (created.status !== 200) {
      throw new Error(`template ${JSON.stringify(created.body)}`);
    }
    return asBody<number>(created.body.data.id);
  };
  const list = async (name: string, optin = "single") => {
    const created = await json("/api/lists", "POST", { name, type: "public", optin });
    return asBody<number>(created.body.data.id);
  };
  const subscriber = async (email: string, extra: JsonObject = {}) => {
    const created = await json("/api/subscribers", "POST", {
      email,
      name: "Fixture",
      ...extra,
    });
    if (created.status !== 200) {
      throw new Error(`subscriber ${JSON.stringify(created.body)}`);
    }
    return asBody<number>(created.body.data.id);
  };
  const sequence = async (definition: JsonObject) => {
    const created = await json("/api/sequences", "POST", {
      name: "Onboarding",
      status: "active",
      trigger: { event: "order_paid" },
      reentry: "always",
      ...definition,
    });
    if (created.status !== 200) {
      throw new Error(JSON.stringify(created.body));
    }
    return asBody<{ id: number; steps: Array<{ id: number }> } & Record<string, any>>(
      created.body.data,
    );
  };
  const event = async (email: string, name = "order_paid", extra: JsonObject = {}) => {
    const r = await json("/api/subscriber-events", "POST", {
      subscriber: { email, name: "Ana" },
      name,
      ...extra,
    });
    if (r.status !== 200) {
      throw new Error(JSON.stringify(r.body));
    }
    return asBody<{
      subscriber_id: number;
      enrollments: { started: Array<{ id: number }> };
    }>(r.body.data);
  };
  const enrollment = async (id: number) =>
    asBody<Record<string, any>>((await json(`/api/enrollments/${id}`)).body.data);
  type SendRow = {
    status: string;
    skip_reason: string | null;
    step_id: number | null;
    enrollment_id: number | null;
    subscriber_id: number;
    source: string;
    uuid: string;
    sent_at: string;
    [field: string]: unknown;
  };
  const sendLog = async (query = "") => {
    const r = await json(`/api/sends?per_page=100${query}`);
    if (r.status !== 200) {
      throw new Error(`send log ${r.status} ${JSON.stringify(r.body)}`);
    }
    return asBody<{ results: Array<SendRow> }>(r.body.data).results.slice().reverse();
  };
  return {
    app,
    db,
    clock,
    sink,
    errors,
    logs,
    testSends,
    marketing,
    scheduler,
    request,
    json,
    apiUser,
    until,
    pass,
    template,
    list,
    subscriber,
    sequence,
    event,
    enrollment,
    sendLog,
    /** Whether the scheduler loop has ended (it only ends on close or a loop failure). */
    get stopped() {
      return stopped;
    },
    set onCondition(hook: typeof onCondition) {
      onCondition = hook;
    },
    async close() {
      const stoppedScheduler = scheduler.stop();
      const stopped = outbox.stop();
      await stoppedScheduler.catch(() => {});
      await emailer.close();
      await stopped;
      await runner.close();
      conditions.close();
      sequences.close();
      notices.close();
      enrollments.close();
      events.close();
      readonly.close();
      sends.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
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
export type SchedulerFixture = Awaited<ReturnType<typeof schedulerFixture>>;
