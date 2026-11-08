// B37: One shared send-rate cap for SES (D92).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createSubscriberStore } from "@/subscribers/store";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { createEmailer } from "@/messaging/email";
import { createSMTPTest } from "@/messaging/test";
import { HttpError } from "@/server/response";
import { createSendRateLimiter } from "@/messaging/rate";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { createTemplateStore } from "@/templates/store";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { registerTxRoutes } from "@/tx/routes";
import { createAttachments } from "@/media/attachments";
import { createEmbeds } from "@/media/embed";
import { createFilesystem } from "@/media/filesystem";
import { createMediaStore } from "@/media/store";
import { createSettings } from "@/settings/store";
import { registerSettingsRoutes } from "@/settings/routes";
import { registerCampaignRoutes } from "@/campaigns/routes";
import { createCampaignStore } from "@/campaigns/store";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import { createRunnerStore } from "@/campaigns/runner/store";
import { createCampaignRunnerRegistry, startCampaignRunner } from "@/campaigns/runner/runner";
import { createMarketingPolicy } from "@/unsubscribe/policy";
import { createTracking } from "@/unsubscribe/tracking";
import { createEnrollments } from "@/sequences/enrollments";
import { createSequenceStore } from "@/sequences/store";
import { registerSequenceRoutes } from "@/sequences/routes";
import { createEventStore } from "@/events/store";
import { allowedDomain } from "@/subscribers/email";
import { startScheduler } from "@/scheduler/scheduler";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";

const admin = { user: "rate-admin", password: "rate-admin-password" };
const root = "http://fixture.test";

async function createRateHarness(initialSettings: Record<string, unknown> = {}) {
  const clock = new TestClock();
  const sink = await startSink({ clock });
  const directory = mkdtempSync(join(tmpdir(), "iglo-send-rate-"));
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: unknown[] = [];

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
    logger: { error: (e) => errors.push(e) },
  });

  const lists = createListReferences(db);
  const counts = createListCounts(db);
  const campaignListRefs = createCampaignListReferences(db);
  const listStore = createListStore(db, clock, counts, campaignListRefs);
  const enrollments = createEnrollments(db, clock);
  const subscribers = createSubscriberStore(db, clock, lists, enrollments.subscriberEffects);
  const roles = createRoles(db, lists);
  const users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(users, roles, clock, root, defaultAuthPolicy);
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) throw new Error("login failed");

  const media = createMediaStore(db, clock);
  const files = createFilesystem(directory, () => ({
    uploadPath: "uploads",
    uploadUri: "/uploads",
  }));
  const attachments = createAttachments(media, files);
  const embedImages = createEmbeds(media, app.logger);
  const renderer = createRenderer(clock, app.i18n);
  const templateRefs = createCampaignTemplateReferences(db);
  const templates = createTemplateStore(db, clock, renderer, templateRefs);
  templates.initialize();

  const settingsStore = createSettings(db, clock, root, roles);
  // Set SMTP to point to loopback sink:
  settingsStore.update((s) => {
    s.smtp = [
      {
        name: "",
        enabled: true,
        exclude_from_default: false,
        host: "127.0.0.1",
        port: sink.port,
        hello_hostname: "fixture.test",
        max_conns: 10,
        idle_timeout: "2s",
        wait_timeout: "2s",
        auth_protocol: "none",
        username: "",
        tls_type: "none",
        tls_skip_verify: false,
        email_headers: [],
        from_addresses: [],
      },
    ];
    for (const [k, v] of Object.entries(initialSettings)) {
      s[k] = v;
    }
    return s;
  });

  // Wiring matching src/main.ts: one settings listener for the process, which wakes whichever
  // limiter is current (restart() replaces the limiter, not the listener).
  let limiter = createSendRateLimiter({
    clock,
    rate: () => settingsStore.read()["messaging.max_send_rate"],
  });
  settingsStore.onUpdate((next, current) => {
    if (next["messaging.max_send_rate"] !== current["messaging.max_send_rate"]) {
      limiter.wake();
    }
  });
  let emailer = createEmailer({
    clock,
    limiter,
    settings: () => {
      const current = settingsStore.read();
      return { smtp: current.smtp, rootUrl: current["app.root_url"] };
    },
    copyAllowed: (addr) => !addressBlocklisted(subscribers, addr),
  });

  const marketing = () => ({
    rootUrl: root,
    siteName: "Fixture",
    minInterval: "P7D",
    unsubscribeHeader: true,
    allowBlocklist: true,
    individualTracking: false,
    disableTracking: false,
  });

  const runnerStore = createRunnerStore(db);
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => root,
    marketingPolicy: createMarketingPolicy({
      subscribers,
      lists,
      settings: marketing,
      campaignDeliveries: runnerStore,
    }),
  });

  const tracking = createTracking(db, clock);
  let outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const router = createRouter();
  registerSettingsRoutes(router, settingsStore, auth);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  registerTemplateRoutes(router, templates, renderer, auth);

  registerTxRoutes(router, {
    auth,
    sends,
    outbox: {
      dispatch: (ids: bigint[]) => outbox.dispatch(ids),
    },
    subscribers,
    templates,
    renderer,
    lists,
    policy: () => ({
      fromEmail: "noreply@fixture.test",
      domainAllowlist: [],
      domainBlocklist: [],
    }),
    marketing: { settings: marketing, tracking },
    attachments,
    embedImages,
  });

  const campaignStore = createCampaignStore(db, clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
    mediaFilename: (id) => media.filename(id),
  });

  const campaignSettings = () => {
    const current = settingsStore.read();
    return {
      fromEmail: current["app.from_email"][0] ?? "noreply@fixture.test",
      rootUrl: root,
      siteName: "Fixture",
      messengers: ["email", "sink"],
      unsubscribeHeader: true,
      allowBlocklist: true,
      disableTracking: false,
      individualTracking: false,
    };
  };

  registerCampaignRoutes(router, {
    store: campaignStore,
    templates,
    renderer,
    roles,
    auth,
    lists,
    subscribers,
    tracking,
    emailer: {
      push: (m: any, opt: any) => emailer.push(m, opt),
    },
    settings: campaignSettings,
    attachments,
    embedImages,
  });

  const recipients = createCampaignRecipients(db);
  const runnerRegistry = createCampaignRunnerRegistry();
  const campaignRunnerSettings = () => {
    const current = settingsStore.read();
    return {
      batchSize: current["app.batch_size"] ?? 1000,
      concurrency: current["app.concurrency"] ?? 10,
      messageRate: current["app.message_rate"] ?? 1000,
      maxSendErrors: current["app.max_send_errors"] ?? 1000,
      slidingWindow: false,
      slidingWindowDuration: "1h",
      slidingWindowRate: 10000,
      rootUrl: root,
      messengers: ["email", "sink"],
      unsubscribeHeader: true,
      disableTracking: false,
      individualTracking: false,
    };
  };
  let runner = startCampaignRunner({
    db,
    clock,
    logger: app.logger,
    registry: runnerRegistry,
    store: runnerStore,
    campaigns: campaignStore,
    recipients,
    lists,
    templates: {
      get: (id) => templates.get(id),
      getDefault: () => templates.getDefault(),
    },
    renderer,
    tracking,
    emailer,
    attachments,
    embedImages,
    settings: campaignRunnerSettings,
    leaseMs: 30_000,
  });

  const events = createEventStore(db, subscribers, {
    emailAllowed: (email) => allowedDomain(email, [], []),
    exitThenTrigger: enrollments.exitThenTrigger,
  });

  const sequences = createSequenceStore(db, clock, {
    templates,
    lists,
    enrollments,
  });

  registerSequenceRoutes(router, {
    sequences,
    enrollments,
    subscribers,
    events,
    sends,
    roles,
    auth,
  });

  const scheduler = startScheduler({
    db,
    clock,
    logger: app.logger,
    enrollments,
    sends,
    subscribers,
    templates,
    events,
    renderer,
    tracking,
    conditions: { evaluate: async () => ({ ok: true, value: true }) },
    settings: () => ({
      fromEmail: "noreply@fixture.test",
      marketing: marketing(),
    }),
  });
  enrollments.onDue(() => scheduler.wake());

  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };

  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`${root}${path}`, init));

  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = sessionHeaders,
  ) => {
    const res = await request(path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : {
            body:
              typeof body === "string"
                ? body
                : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
          }),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, body: data, headers: res.headers };
  };

  const template = async (body = "<p>Tx</p>", subject = "Subject", type = "tx") => {
    const created = await json("/api/templates", "POST", {
      name: `fixture-${type}-${crypto.randomUUID().slice(0, 6)}`,
      type,
      subject,
      body,
    });
    if (created.status !== 200)
      throw new Error(`template ${created.status}: ${JSON.stringify(created.body)}`);
    return created.body.data.id as number;
  };

  const drive = async (done: () => boolean | Promise<boolean>, step = 50, limit = 20_000) => {
    for (let i = 0; i < limit; i++) {
      for (let j = 0; j < 3; j++) await Bun.sleep(0);
      if (await done()) return;
      clock.advance(step);
    }
    throw new Error("drive timed out");
  };

  return {
    app,
    renderer,
    clock,
    sink,
    db,
    directory,
    settingsStore,
    get emailer() {
      return emailer;
    },
    get outbox() {
      return outbox;
    },
    get runner() {
      return runner;
    },
    scheduler,
    subscribers,
    lists,
    templates,
    campaignStore,
    sequences,
    enrollments,
    sends,
    json,
    drive,
    template,
    restart() {
      limiter = createSendRateLimiter({
        clock,
        rate: () => settingsStore.read()["messaging.max_send_rate"],
      });
      emailer = createEmailer({
        clock,
        limiter,
        settings: () => {
          const current = settingsStore.read();
          return { smtp: current.smtp, rootUrl: current["app.root_url"] };
        },
        copyAllowed: (addr) => !addressBlocklisted(subscribers, addr),
      });
      outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
      runner = startCampaignRunner({
        db,
        clock,
        logger: app.logger,
        registry: runnerRegistry,
        store: runnerStore,
        campaigns: campaignStore,
        recipients,
        lists,
        templates: {
          get: (id) => templates.get(id),
          getDefault: () => templates.getDefault(),
        },
        renderer,
        tracking,
        emailer,
        attachments,
        embedImages,
        settings: campaignRunnerSettings,
        leaseMs: 30_000,
      });
      return { emailer, outbox, runner };
    },
    async close() {
      scheduler.stop();
      runner.stop();
      const outboxStopped = outbox.stop();
      await emailer.close();
      await outboxStopped;
      settingsStore.close();
      db.close(true);
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("B37: send rate cap", () => {
  // Test 1: With messaging.max_send_rate = 5, a campaign to 50 subscribers plus 20 transactional
  // POST /api/tx sends started at the same time: in every one-second window of injected-clock time,
  // the sink receives at most 5 messages. Everything is eventually delivered.
  test("1. paces campaign and tx sends together under max_send_rate = 5", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 5,
      "app.concurrency": 5,
      "app.message_rate": 100,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "test-list", type: "public" });
      const listId = listRes.body.data.id;

      // 50 subscribers for campaign
      for (let i = 0; i < 50; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `sub-${i}@example.test`,
          name: `Sub ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }

      // Default template
      const defaultTemplate = h.templates.getDefault()!;
      const txTemplateId = await h.template();

      // Create campaign
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Rate Campaign",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Campaign body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;

      // Warm up the pool socket so connection establishment doesn't add an initial phase shift
      const warmup = await h.json("/api/tx", "POST", {
        subscriber_email: "warmup@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });
      await h.drive(() => h.sink.messages.length === 1, 10, 50);
      await warmup;
      h.sink.messages.length = 0;
      h.clock.advance(1000);

      // Start campaign
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // Start 20 transactional sends
      const txPromises = [];
      for (let i = 0; i < 20; i++) {
        txPromises.push(
          h.json("/api/tx", "POST", {
            subscriber_email: `tx-${i}@example.test`,
            template_id: txTemplateId,
            data: {},
            messenger: "email",
          }),
        );
      }

      // Drive clock until all 70 messages are delivered to the sink
      await h.drive(() => h.sink.messages.length === 70, 50, 2000);
      await Promise.all(txPromises);

      expect(h.sink.messages.length).toBe(70);

      // Verify pacing: in every one-second window of injected-clock time, at most 5 messages arrived
      const times = h.sink.messages.map((m) => m.at!).sort((a, b) => a - b);
      for (const t of times) {
        const inWindow = times.filter((u) => u >= t && u < t + 1000).length;
        expect(inWindow).toBeLessThanOrEqual(5);
      }
    } finally {
      await h.close();
    }
  });

  // Blocker 1: Limiter wait does not count toward the 60 s push cutoff:
  // at messaging.max_send_rate = 1, run a campaign to 10 subscribers plus 70 concurrent POST /api/tx,
  // and advance the clock until everything is done. Every row and delivery ends sent, none failed,
  // and the sink receives every message.
  test("1b. limiter wait does not count toward 60 s cutoff: cap 1 with outbox and campaign load", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 1,
      "app.concurrency": 5,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "cutoff-list", type: "public" });
      const listId = listRes.body.data.id;

      for (let i = 0; i < 10; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `cutoff-sub-${i}@example.test`,
          name: `Cutoff ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }

      const defaultTemplate = h.templates.getDefault()!;
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Cutoff Campaign",
        subject: "Cutoff Subject",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Cutoff Body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      const txTemplateId = await h.template();
      const txPromises = [];
      for (let i = 0; i < 70; i++) {
        txPromises.push(
          h.json("/api/tx", "POST", {
            subscriber_email: `cutoff-tx-${i}@example.test`,
            template_id: txTemplateId,
            data: {},
            messenger: "email",
          }),
        );
      }

      // 80 messages total at 1/s = ~80 seconds of clock time
      await h.drive(() => h.sink.messages.length === 80, 50, 4000);
      await Promise.all(txPromises);

      expect(h.sink.messages.length).toBe(80);

      // Verify no row in sends is failed
      const sendsRows = h.db
        .query<{ status: string; count: number }, any>(
          "SELECT status, count(*) as count FROM sends GROUP BY status",
        )
        .all();
      for (const row of sendsRows) {
        expect(row.status).not.toBe("failed");
      }
      const sentSends = h.db
        .query<{ count: number }, any>("SELECT count(*) as count FROM sends WHERE status = 'sent'")
        .get()!.count;
      expect(Number(sentSends)).toBe(70);

      // Verify no delivery in campaign_deliveries is failed
      const campDeliveries = h.db
        .query<{ status: string; count: number }, any>(
          "SELECT status, count(*) as count FROM campaign_deliveries WHERE campaign_id = ? GROUP BY status",
        )
        .all(campId);
      for (const row of campDeliveries) {
        expect(row.status).not.toBe("failed");
      }
      const sentDeliveries = h.db
        .query<{ count: number }, any>(
          "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'sent'",
        )
        .get(campId)!.count;
      expect(Number(sentDeliveries)).toBe(10);
    } finally {
      await h.close();
    }
  });

  // Test 2: Priority: while a campaign to many subscribers is waiting on the cap,
  // a transactional send is accepted by the sink within 1 s of injected time.
  test("2. outbox sends have priority over waiting campaign sends", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 2,
      "app.concurrency": 5,
      "app.message_rate": 100,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "prio-list", type: "public" });
      const listId = listRes.body.data.id;

      for (let i = 0; i < 30; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `prio-${i}@example.test`,
          name: `Prio ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }

      const defaultTemplate = h.templates.getDefault()!;
      const txTemplateId = await h.template();
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Prio Campaign",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // Let campaign fill the initial window (2 messages sent at t=0)
      await h.drive(() => h.sink.messages.length >= 2, 20, 100);

      const startTxTime = h.clock.now().getTime();
      // Now a transactional send is dispatched while campaign messages are waiting
      const txPromise = h.json("/api/tx", "POST", {
        subscriber_email: "urgent@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });

      // Drive clock until transactional message arrives
      await h.drive(
        () => h.sink.messages.some((m) => m.to.includes("urgent@example.test")),
        50,
        500,
      );
      await txPromise;

      const txMsg = h.sink.messages.find((m) => m.to.includes("urgent@example.test"))!;
      expect(txMsg).toBeDefined();
      expect(txMsg.at! - startTxTime).toBeLessThanOrEqual(1000);
    } finally {
      await h.close();
    }
  });

  // Test 3: A sequence step is paced by the same cap (the outbox marketing kind).
  test("3. sequence steps are paced by the same cap", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 3,
      "app.concurrency": 5,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "seq-list", type: "public" });
      const listId = listRes.body.data.id;
      const txTemplateId = await h.template();

      const seqRes = await h.json("/api/sequences", "POST", {
        name: "Welcome",
        trigger: { event: "signup" },
        exit_on: [],
        reentry: "never",
        list_id: listId,
        steps: [
          {
            wait: "PT0S",
            kind: "marketing",
            template_id: txTemplateId,
          },
        ],
      });
      const seqId = seqRes.body.data.id;
      await h.json(`/api/sequences/${seqId}/status`, "PUT", { status: "active" });

      // Create 15 subscribers and enroll them
      for (let i = 0; i < 15; i++) {
        const subRes = await h.json("/api/subscribers", "POST", {
          email: `seq-${i}@example.test`,
          name: `Seq ${i}`,
          status: "enabled",
          lists: [listId],
        });
        const subId = subRes.body.data.id;
        await h.json("/api/enrollments", "POST", {
          sequence_id: seqId,
          subscriber_id: subId,
        });
      }
      h.scheduler.wake();

      // Drive until all 15 sequence step emails arrive
      await h.drive(() => h.sink.messages.length === 15, 50, 1000);
      expect(h.sink.messages.length).toBe(15);

      // Verify pacing
      const times = h.sink.messages.map((m) => m.at!).sort((a, b) => a - b);
      for (const t of times) {
        const inWindow = times.filter((u) => u >= t && u < t + 1000).length;
        expect(inWindow).toBeLessThanOrEqual(3);
      }
    } finally {
      await h.close();
    }
  });

  // Test 4: 0 means no cap: the same load finishes without waiting on the limiter.
  test("4. 0 means no cap: sends finish without limiter wait", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 0,
      "app.concurrency": 10,
    });
    try {
      const txTemplateId = await h.template();
      const startTime = h.clock.now().getTime();

      const txPromises = [];
      for (let i = 0; i < 10; i++) {
        txPromises.push(
          h.json("/api/tx", "POST", {
            subscriber_email: `nocap-${i}@example.test`,
            template_id: txTemplateId,
            data: {},
            messenger: "email",
          }),
        );
      }

      await h.drive(() => h.sink.messages.length === 10, 10, 50);
      await Promise.all(txPromises);

      // With no cap, all messages finish without waiting on the limiter (all under 1 second)
      const maxElapsed = Math.max(...h.sink.messages.map((m) => m.at!)) - startTime;
      expect(maxElapsed).toBeLessThan(1000);
    } finally {
      await h.close();
    }
  });

  // Test 5: A settings change takes effect: lowering the rate mid-campaign slows the following sends,
  // and raising it speeds them up.
  test("5. settings change applies to next wait mid-campaign", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 10,
      "app.concurrency": 10,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "dyn-list", type: "public" });
      const listId = listRes.body.data.id;

      for (let i = 0; i < 40; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `dyn-${i}@example.test`,
          name: `Dyn ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }

      const defaultTemplate = h.templates.getDefault()!;
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Dyn Campaign",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // First window at 10/s
      await h.drive(() => h.sink.messages.length >= 10, 50, 100);

      // Lower rate to 2/s
      await h.json("/api/settings/messaging.max_send_rate", "PUT", 2);

      // Advance by 1 second: at 2/s, only 2 more messages should arrive
      const countBefore = h.sink.messages.length;
      h.clock.advance(1000);
      await h.drive(() => h.sink.messages.length >= countBefore + 2, 50, 50);
      expect(h.sink.messages.length).toBe(countBefore + 2);

      // Now raise rate back to 10/s: delivery speeds back up
      await h.json("/api/settings/messaging.max_send_rate", "PUT", 10);
      const countBeforeRaise = h.sink.messages.length;
      h.clock.advance(1000);
      await h.drive(() => h.sink.messages.length >= countBeforeRaise + 10, 50, 50);
      expect(h.sink.messages.length).toBe(countBeforeRaise + 10);
    } finally {
      await h.close();
    }
  });

  test("5b. raising messaging.max_send_rate speeds up sends without waiting out old interval", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 1,
    });
    try {
      const txTemplateId = await h.template();

      const startMs = h.clock.now().getTime();
      // Send first message at t=0
      const p1 = h.json("/api/tx", "POST", {
        subscriber_email: "wake-1@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });
      await h.drive(() => h.sink.messages.length === 1, 10, 50);
      await p1;

      // Send second message; at rate 1, it waits for t=1000
      const p2 = h.json("/api/tx", "POST", {
        subscriber_email: "wake-2@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });
      await new Promise<void>((r) => setImmediate(r));

      // Advance by 100ms (t=100)
      h.clock.advance(100);
      for (let j = 0; j < 3; j++) await Bun.sleep(0);
      expect(h.sink.messages.length).toBe(1);

      // Raise rate to 10/s (interval 100ms). Since 100ms has elapsed since first send,
      // message 2 should be granted immediately on wake without waiting until t=1000
      await h.json("/api/settings/messaging.max_send_rate", "PUT", 10);

      await h.drive(() => h.sink.messages.length === 2, 10, 50);
      await p2;

      expect(h.sink.messages.length).toBe(2);
      expect(h.sink.messages[1]!.to).toContain("wake-2@example.test");
      expect(h.clock.now().getTime() - startMs).toBeLessThan(500);
    } finally {
      await h.close();
    }
  });

  test("4b. a second settings update listener is refused instead of replacing the first", async () => {
    const h = await createRateHarness();
    try {
      expect(() => h.settingsStore.onUpdate(() => {})).toThrow();
    } finally {
      await h.close();
    }
  });

  test("5c. lowering the rate applies to the very next grant, not the old interval", async () => {
    const clock = new TestClock();
    let rate = 14;
    const limiter = createSendRateLimiter({ clock, rate: () => rate });
    await limiter.acquire("outbox");

    // Lower to 1/s just after a grant. The next grant must wait a full second; the old 71 ms
    // slot must not carry it, which would put two starts in one second under the new rate.
    rate = 1;
    limiter.wake();
    let granted = false;
    const next = limiter.acquire("outbox").then(() => {
      granted = true;
    });
    clock.advance(100);
    for (let j = 0; j < 5; j++) await Bun.sleep(0);
    expect(granted).toBe(false);

    clock.advance(900);
    await next;
    expect(granted).toBe(true);
    limiter.stop();
  });

  test("7c. emailer closed while a campaign batch waits: no recipient of that batch ends failed", async () => {
    const h = await createRateHarness({ "messaging.max_send_rate": 1, "app.concurrency": 5 });
    try {
      const listRes = await h.json("/api/lists", "POST", { name: "closing-list", type: "public" });
      const listId = listRes.body.data.id;
      for (let i = 0; i < 6; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `closing-${i}@example.test`,
          name: `Closing ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Closing Campaign",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Body</p>",
        template_id: h.templates.getDefault()!.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // One recipient holds the only token; the rest of the batch waits in the limiter.
      await h.drive(() => h.sink.messages.length === 1, 10, 100);

      // The emailer closes while the runner is alive. The batch's waiting recipients are refused and
      // handed back, and the rest of the batch never starts. Time passes, as the paced workers and
      // scans would take it, and the runner stops only at the end.
      await h.emailer.close();
      for (let i = 0; i < 12; i++) {
        h.clock.advance(1000);
        for (let j = 0; j < 5; j++) await Bun.sleep(0);
      }
      await h.runner.stop();

      const deliveries = h.db
        .query<{ status: string; n: number }, any>(
          "SELECT status, count(*) AS n FROM campaign_deliveries WHERE campaign_id = ? GROUP BY status",
        )
        .all(campId);
      expect(deliveries.find((d) => d.status === "failed")).toBeUndefined();
      expect(Number(deliveries.find((d) => d.status === "sent")?.n)).toBe(1);
      expect(h.sink.messages.length).toBe(1);
    } finally {
      await h.close();
    }
  });

  test("8. SMTP settings test waits a bounded time for the send-rate cap, then fails clearly", async () => {
    const h = await createRateHarness({ "messaging.max_send_rate": 1 });
    try {
      const txTemplateId = await h.template();
      // Fifteen sends queue ahead of the test message: at 1/s they hold the cap for about 15 s.
      const queued = Array.from({ length: 15 }, (_, i) =>
        h.json("/api/tx", "POST", {
          subscriber_email: `queued-${i}@example.test`,
          template_id: txTemplateId,
          data: {},
          messenger: "email",
        }),
      );
      await h.drive(() => h.sink.messages.length >= 1, 10, 50);

      const smtpTest = createSMTPTest(h.settingsStore, h.emailer, h.app.i18n, h.renderer);
      const server = h.settingsStore.read().smtp[0]!;
      let failure: unknown;
      let finished = false;
      const attempt = smtpTest({ ...server, email: "admin@example.test" }, () => {})
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          finished = true;
        });
      await h.drive(() => finished, 100, 300);
      await attempt;

      // The bound is 10 s of injected time: the test is not sent, and the error names the cap.
      expect(failure).toBeInstanceOf(HttpError);
      expect((failure as HttpError).status).toBe(503);
      expect((failure as HttpError).message).toContain("send-rate");
      expect(h.sink.messages.some((m) => m.to.includes("admin@example.test"))).toBe(false);

      await h.drive(() => h.sink.messages.length === 15, 100, 300);
      await Promise.all(queued);
    } finally {
      await h.close();
    }
  });

  // Test 6: Settings API: GET shows the default 14, PUT validates (negative, non-integer and too large give 400),
  // and a listmonk-style full PUT without the key keeps it (native key).
  test("6. Settings API manages messaging.max_send_rate", async () => {
    const h = await createRateHarness();
    try {
      // GET shows default 14
      const getRes = await h.json("/api/settings");
      expect(getRes.status).toBe(200);
      expect(getRes.body.data["messaging.max_send_rate"]).toBe(14);

      // PUT negative gives 400
      const negRes = await h.json("/api/settings/messaging.max_send_rate", "PUT", -1);
      expect(negRes.status).toBe(400);

      // PUT non-integer gives 400
      const floatRes = await h.json("/api/settings/messaging.max_send_rate", "PUT", 2.5);
      expect(floatRes.status).toBe(400);

      // PUT too large (> 10000) gives 400
      const bigRes = await h.json("/api/settings/messaging.max_send_rate", "PUT", 10001);
      expect(bigRes.status).toBe(400);

      // PUT valid 25 succeeds
      const putRes = await h.json("/api/settings/messaging.max_send_rate", "PUT", 25);
      expect(putRes.status).toBe(200);

      const checkRes = await h.json("/api/settings");
      expect(checkRes.body.data["messaging.max_send_rate"]).toBe(25);

      // Full listmonk-style PUT without the key keeps it
      const current = checkRes.body.data;
      const withoutKey = { ...current };
      delete withoutKey["messaging.max_send_rate"];

      const fullPutRes = await h.json("/api/settings", "PUT", withoutKey);
      expect(fullPutRes.status).toBe(200);

      const afterFull = await h.json("/api/settings");
      expect(afterFull.body.data["messaging.max_send_rate"]).toBe(25);
    } finally {
      await h.close();
    }
  });

  // Test 7: Shutdown during a wait stops cleanly. No message is sent after stop,
  // waiting outbox rows return to queued (attempts-1) and waiting campaign deliveries are unclaimed.
  // After restart, each is sent exactly once.
  test("7. shutdown during a wait stops cleanly and preserves unstarted work", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 1,
      "app.concurrency": 2,
    });
    try {
      const txTemplateId = await h.template();

      // Push first message (takes the 1 available slot)
      const p1 = h.json("/api/tx", "POST", {
        subscriber_email: "msg-1@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });
      await h.drive(() => h.sink.messages.length === 1, 10, 50);
      await p1;

      // Push second message (must wait for next token)
      const p2 = h.json("/api/tx", "POST", {
        subscriber_email: "msg-2@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });

      // Let p2 queue in the limiter
      await new Promise<void>((r) => setImmediate(r));

      // Close emailer while p2 is waiting
      await h.emailer.close();
      await p2;

      // Assert row 2 is queued (not failed), attempts 0
      const row2 = h.db
        .query<{ status: string; attempts: number }, any>(
          "SELECT status, attempts FROM sends WHERE to_email = 'msg-2@example.test'",
        )
        .get();
      expect(row2?.status).toBe("queued");
      expect(Number(row2?.attempts)).toBe(0);

      // Stop outbox and restart
      await h.outbox.stop();
      h.restart();

      // Message 2 is sent on restart
      await h.drive(
        () =>
          h.sink.messages.length === 2 &&
          h.db
            .query<{ status: string }, any>(
              "SELECT status FROM sends WHERE to_email = 'msg-2@example.test'",
            )
            .get()?.status === "sent",
        50,
        200,
      );

      const row2After = h.db
        .query<{ status: string; attempts: number }, any>(
          "SELECT status, attempts FROM sends WHERE to_email = 'msg-2@example.test'",
        )
        .get();
      expect(row2After?.status).toBe("sent");
      expect(Number(row2After?.attempts)).toBe(1);
      expect(h.sink.messages.length).toBe(2);

      // Now campaign delivery:
      const listRes = await h.json("/api/lists", "POST", {
        name: "camp-stop-list",
        type: "public",
      });
      const listId = listRes.body.data.id;
      for (let i = 0; i < 2; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `camp-stop-${i}@example.test`,
          name: `Stop ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }
      const defaultTemplate = h.templates.getDefault()!;
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Camp Stop",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // First delivery is sent (sink count reaches 3)
      await h.drive(() => h.sink.messages.length === 3, 50, 100);

      // Stop emailer & runner while delivery 2 is waiting
      await h.emailer.close();
      await h.runner.stop();

      // Delivery 2 was never pushed so it must not be failed
      const failedDeliveries = h.db
        .query<{ count: number }, any>(
          "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'failed'",
        )
        .get(campId)!.count;
      expect(Number(failedDeliveries)).toBe(0);

      // Restart components
      h.restart();
      h.runner.wake();

      // Delivery 2 is sent after restart (sink reaches 4)
      await h.drive(
        () =>
          h.sink.messages.length === 4 &&
          Number(
            h.db
              .query<{ count: number }, any>(
                "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'sent'",
              )
              .get(campId)?.count,
          ) === 2,
        50,
        200,
      );

      const sentDeliveries = h.db
        .query<{ count: number }, any>(
          "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'sent'",
        )
        .get(campId)!.count;
      expect(Number(sentDeliveries)).toBe(2);
    } finally {
      await h.close();
    }
  });

  test("7b. main shutdown order (runner, outbox, emailer stopping together) preserves waiters", async () => {
    const h = await createRateHarness({
      "messaging.max_send_rate": 1,
      "app.concurrency": 2,
    });
    try {
      const listRes = await h.json("/api/lists", "POST", {
        name: "main-stop-list",
        type: "public",
      });
      const listId = listRes.body.data.id;
      for (let i = 0; i < 2; i++) {
        await h.json("/api/subscribers", "POST", {
          email: `main-stop-${i}@example.test`,
          name: `Main ${i}`,
          lists: [listId],
          status: "enabled",
        });
      }
      const defaultTemplate = h.templates.getDefault()!;
      const campRes = await h.json("/api/campaigns", "POST", {
        name: "Main Stop Camp",
        subject: "Hello",
        lists: [listId],
        type: "regular",
        content_type: "richtext",
        body: "<p>Body</p>",
        template_id: defaultTemplate.id,
        messenger: "email",
      });
      const campId = campRes.body.data.id;
      await h.json(`/api/campaigns/${campId}/status`, "PUT", { status: "running" });
      h.runner.wake();

      // Campaign delivery 1 sent
      await h.drive(() => h.sink.messages.length === 1, 50, 100);

      // Queue tx message that waits behind limiter
      const txTemplateId = await h.template();
      const txPromise = h.json("/api/tx", "POST", {
        subscriber_email: "main-tx-wait@example.test",
        template_id: txTemplateId,
        data: {},
        messenger: "email",
      });
      await new Promise<void>((r) => setImmediate(r));

      // Main shutdown order: runner, outbox, emailer stop concurrently
      await Promise.allSettled([h.runner.stop(), h.outbox.stop(), h.emailer.close()]);
      await txPromise;

      // Tx row is queued, attempts 0
      const txRow = h.db
        .query<{ status: string; attempts: number }, any>(
          "SELECT status, attempts FROM sends WHERE to_email = 'main-tx-wait@example.test'",
        )
        .get();
      expect(txRow?.status).toBe("queued");
      expect(Number(txRow?.attempts)).toBe(0);

      // Campaign delivery 2 is not failed
      const failedDeliveries = h.db
        .query<{ count: number }, any>(
          "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'failed'",
        )
        .get(campId)!.count;
      expect(Number(failedDeliveries)).toBe(0);

      // Restart
      h.restart();
      h.runner.wake();

      // Messages finish sending (1 camp + 1 tx + 1 camp = 3 total)
      await h.drive(() => h.sink.messages.length === 3, 50, 300);

      const txRowAfter = h.db
        .query<{ status: string; attempts: number }, any>(
          "SELECT status, attempts FROM sends WHERE to_email = 'main-tx-wait@example.test'",
        )
        .get();
      expect(txRowAfter?.status).toBe("sent");
      expect(Number(txRowAfter?.attempts)).toBe(1);

      const sentDeliveries = h.db
        .query<{ count: number }, any>(
          "SELECT count(*) as count FROM campaign_deliveries WHERE campaign_id = ? AND status = 'sent'",
        )
        .get(campId)!.count;
      expect(Number(sentDeliveries)).toBe(2);
    } finally {
      await h.close();
    }
  });
});
