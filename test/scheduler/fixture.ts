// In-process production owners wired as src/main.ts does, with the sequence scheduler, a fake
// clock and a loopback SMTP sink. The scheduler's injected clock is observed so a test can wait
// for one complete pass (an idle sleep) without sleeping in real time.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
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
import {
  createConditionEvaluator,
  type ConditionEvaluator,
} from "@/conditions/evaluate";
import { createEnrollments } from "@/sequences/enrollments";
import { createSequenceStore } from "@/sequences/store";
import { registerSequenceRoutes } from "@/sequences/routes";
import { startScheduler, SCHEDULER_INTERVAL_MS } from "@/scheduler/scheduler";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import {
  createMarketingPolicy,
  type MarketingSettings,
} from "@/unsubscribe/policy";
import { registerUnsubscribeRoutes } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";

export const admin = {
  user: "fixture-admin",
  password: "fixture-admin-password",
};
export const minute = 60_000;
export const hour = 3_600_000;
export const day = 86_400_000;

export async function schedulerFixture() {
  const sink = await startSink({});
  const directory = mkdtempSync(join(tmpdir(), "iglo-scheduler-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: unknown[] = [];
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
    logger: { error: (error) => errors.push(error) },
  });
  const enrollments = createEnrollments(db, clock);
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    subscribers = createSubscriberStore(
      db,
      clock,
      lists,
      enrollments.subscriberEffects,
    ),
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
    if (!session || !("id" in session)) throw new Error("fixture login failed");
    return { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  };
  let sessionHeaders = await login();
  const renderer = createRenderer(clock, app.i18n);
  const templateReferences = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(
    db,
    clock,
    renderer,
    templateReferences,
    app.logger,
  );
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
  const outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const events = createEventStore(db, subscribers, {
    emailAllowed: (email) => allowedDomain(email, [], []),
    exitThenTrigger: enrollments.exitThenTrigger,
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
      if (ms === SCHEDULER_INTERVAL_MS) passes++;
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
  registerUserRoutes(router, users, roles, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth);
  registerSendRoutes(router, sends, auth);
  registerUnsubscribeRoutes(router, {
    db,
    sends,
    subscribers,
    tracking,
    settings: () => marketing,
    effects: enrollments.unsubscribeEffects,
  });
  registerEventRoutes(router, events, auth);
  registerSequenceRoutes(router, {
    sequences,
    enrollments,
    subscribers,
    roles,
    auth,
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
  /** Yield to I/O, releasing zero-length clock sleeps, until `check` holds. */
  async function until(
    check: () => boolean | Promise<boolean>,
    label = "condition",
  ) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${label}`);
      clock.advance(0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  /** Advance the clock (or wake the scheduler when 0) and wait for one complete pass. */
  async function pass(ms = SCHEDULER_INTERVAL_MS) {
    await until(() => passes > 0, "scheduler start");
    const before = passes;
    if (ms) clock.advance(ms);
    else scheduler.wake();
    // A stopped scheduler ends the wait, so a test can assert that it is still running.
    await until(() => passes > before || stopped, "scheduler pass");
  }
  const template = async (
    body = "<p>{{ subscriber.name }}</p>",
    subject = "Hello",
  ) => {
    const created = await json("/api/templates", "POST", {
      name: "fixture tx",
      type: "tx",
      subject,
      body,
    });
    if (created.status !== 200)
      throw new Error(`template ${JSON.stringify(created.body)}`);
    return created.body.data.id as number;
  };
  const list = async (name: string, optin = "single") =>
    (await json("/api/lists", "POST", { name, type: "public", optin })).body
      .data.id as number;
  const subscriber = async (email: string, extra: object = {}) => {
    const created = await json("/api/subscribers", "POST", {
      email,
      name: "Fixture",
      ...extra,
    });
    if (created.status !== 200)
      throw new Error(`subscriber ${JSON.stringify(created.body)}`);
    return created.body.data.id as number;
  };
  const sequence = async (definition: object) => {
    const created = await json("/api/sequences", "POST", {
      name: "Onboarding",
      status: "active",
      trigger: { event: "order_paid" },
      reentry: "always",
      ...definition,
    });
    if (created.status !== 200) throw new Error(JSON.stringify(created.body));
    return created.body.data as {
      id: number;
      steps: { id: number }[];
    } & Record<string, any>;
  };
  const event = async (
    email: string,
    name = "order_paid",
    extra: object = {},
  ) => {
    const r = await json("/api/subscriber-events", "POST", {
      subscriber: { email, name: "Ana" },
      name,
      ...extra,
    });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.data as {
      subscriber_id: number;
      enrollments: { started: { id: number }[] };
    };
  };
  const enrollment = async (id: number) =>
    (await json(`/api/enrollments/${id}`)).body.data as Record<string, any>;
  const sendLog = async (query = "") => {
    const r = await json(`/api/sends?per_page=100${query}`);
    if (r.status !== 200)
      throw new Error(`send log ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body.data.results as Record<string, any>[]).slice().reverse();
  };
  return {
    app,
    db,
    clock,
    sink,
    errors,
    marketing,
    scheduler,
    request,
    json,
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
