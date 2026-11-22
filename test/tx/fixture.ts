// In-process production owners for POST /api/tx, with a loopback SMTP sink.
import { fixturePageSite } from "@/test/public/site";
import type { JsonObject } from "@/test/json-object";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { personalPageHeaders } from "@/public/headers";
import { createSubscriberMail } from "@/public/mail";
import type { SubscriberMail } from "@/public/mail";
import { createPrivacy } from "@/public/privacy";
import { registerPublicRoutes } from "@/public/routes";
import { publicSettings as toPublicSettings } from "@/public/settings";
import { createSettings } from "@/settings/store";
import type { SettingsStore } from "@/settings/store";
import { registerSettingsRoutes } from "@/settings/routes";
import type { Middleware } from "@/server/context";
import { createListReferences } from "@/lists/references";
import { createListStore } from "@/lists/store";
import { registerListRoutes } from "@/lists/routes";
import { createListCounts } from "@/subscribers/list-counts";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { createSubscriberStore, noSubscriberEffects } from "@/subscribers/store";
import type { SubscriberEffects } from "@/subscribers/store";
import { createSubscriberQuery } from "@/subscribers/query";
import { registerSubscriberQueryRoutes } from "@/subscribers/query-routes";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { registerSubscriberRoutes } from "@/subscribers/routes";
import { createRoles } from "@/roles/roles";
import { createRouter } from "@/server/server";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserStore } from "@/users/store";
import { registerUserRoutes } from "@/users/routes";
import { createEmailer } from "@/messaging/email";
import { addressBlocklisted, createSends } from "@/messaging/sends";
import { createSendAnonymizer, createUnlinkedSends } from "@/messaging/anonymize";
import { startOutbox } from "@/messaging/outbox";
import { registerSendRoutes } from "@/messaging/routes";
import { createTemplateStore } from "@/templates/store";
import type { PageOptions } from "@/public/preferences";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { registerTxRoutes } from "@/tx/routes";
import type { TxPolicy } from "@/tx/routes";
import { createAttachments } from "@/media/attachments";
import { createEmbeds } from "@/media/embed";
import { createFilesystem } from "@/media/filesystem";
import { registerMediaRoutes } from "@/media/routes";
import { createMediaStore } from "@/media/store";
import type { Clock } from "@/clock";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { createMarketingPolicy } from "@/unsubscribe/policy";
import type { MarketingSettings } from "@/unsubscribe/policy";
import { registerUnsubscribeRoutes } from "@/unsubscribe/routes";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";
import { createTracking } from "@/unsubscribe/tracking";
import { registerBounceRoutes } from "@/bounces/routes";
import { createTestSends } from "@/messaging/test-sends";
import { createSnsClient } from "@/bounces/ses";
import type { SnsFetch } from "@/bounces/ses";

const refuseNetwork: SnsFetch = () => Promise.reject(new Error("no network in tests"));
import { createBounceStore } from "@/bounces/store";
import type { BounceAction } from "@/bounces/store";
import { startWebhookDelivery } from "@/webhooks/delivery";
import type { WebhookTransport } from "@/webhooks/delivery";
import { createWebhookEffects } from "@/webhooks/effects";
import { registerWebhookRoutes } from "@/webhooks/routes";
import { createWebhookStore } from "@/webhooks/store";
import type { Captcha } from "@/captcha/captcha";
import { asBody } from "@/test/read-body";

const open: Middleware = (_context, next) => next();

export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

/** A fixture without a subscriber mail: a privacy action on its routes is a bug in the test. */
function unwiredMail(): never {
  throw new Error("this fixture wires no subscriber mail");
}

export async function txFixture(
  options: {
    reject?: () => boolean;
    policy?: Partial<TxPolicy>;
    clock?: Clock;
    emailHeaders?: Array<Record<string, string>>;
    marketing?: Partial<MarketingSettings>;
    effects?: UnsubscribeEffects;
    page?: () => PageOptions;
    /** The subscriber mail of the privacy routes (B123); unset, a privacy action here throws. */
    mail?: () => Pick<SubscriberMail, "exportData">;
    /** Wire the production webhook owners, with this transport. */
    webhooks?: WebhookTransport;
    /** The provider route's rate limit, with `webhooks`. */
    bounceLimit?: Middleware;
    /** The network for the SES route; the default would reach AWS. */
    snsFetch?: SnsFetch;
    /** The emailer's last gate before a pool, as in production (the restore hold). */
    refuse?: () => void;
    /**
     * Holds each synchronous dispatch, as a stalled SMTP server does. It runs after the journal
     * commit and before the dispatch claims its rows, so the outbox loop may claim and send them
     * first; production calls the dispatch with no gap. Tests must not assume the dispatch sent it.
     */
    beforeDispatch?: () => Promise<void>;
    /** The sink keeps no message text (memory measurements). */
    discardData?: boolean;
    /** An existing data directory (an older build's database); migrated on open, removed on close. */
    persisted?: { dataDir: string };
    /** The attachment budget of `POST /api/tx`. */
    limits?: { maxBytes?: number; maxSends?: number; waitMs?: number; maxOvertakes?: number };
  } = {},
) {
  const sink = await startSink({
    ...(options.reject ? { reject: options.reject } : {}),
    ...(options.discardData ? { discardData: true } : {}),
  });
  const directory = options.persisted?.dataDir ?? mkdtempSync(join(tmpdir(), "iglo-tx-"));
  const testClock = new TestClock();
  const clock = options.clock ?? testClock;
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const errors: Array<unknown> = [];
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
    logger: {
      error: (error) => errors.push(error),
      attention: (message) => errors.push(new Error(message)),
    },
  });
  let bounces: ReturnType<typeof createBounceStore> | undefined;
  let settingsStore: SettingsStore | undefined;
  const lists = createListReferences(db),
    counts = createListCounts(db),
    campaigns = createCampaignListReferences(db),
    listStore = createListStore(db, clock, counts, campaigns),
    webhooks = options.webhooks ? createWebhookStore(db, clock) : undefined,
    webhookEffects = webhooks && createWebhookEffects(webhooks, () => subscribers),
    anonymize = createSendAnonymizer(db),
    unlinkedSends = createUnlinkedSends(db),
    subscriberEffects: SubscriberEffects = {
      ...noSubscriberEffects,
      ...webhookEffects?.subscriberEffects,
      deleting(deleted, wipe) {
        bounces?.deleteForSends(unlinkedSends(deleted.map(({ email }) => email)));
        anonymize(deleted);
        webhookEffects?.deleting(deleted, wipe);
      },
    },
    subscribers: ReturnType<typeof createSubscriberStore> = createSubscriberStore(
      db,
      clock,
      lists,
      subscriberEffects,
    ),
    readonly = webhooks && openReadOnly(db.filename),
    runner =
      webhooks && createQueryRunner({ path: db.filename, timeoutMs: 10_000, concurrency: 2 }),
    subscriberQuery =
      readonly &&
      runner &&
      createSubscriberQuery({ db, readonly, clock, runner, effects: subscriberEffects }),
    roles = createRoles(db, lists),
    users = createUserStore(db, clock, roles);
  const auth = await createAuthentication(
    users,
    roles,
    clock,
    "http://fixture.test",
    defaultAuthPolicy,
  );
  await bootstrapAdmin(users, auth, admin);
  const session = await auth.login(admin.user, admin.password);
  if (!session || !("id" in session)) {
    throw new Error("fixture login failed");
  }
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
          email_headers: options.emailHeaders ?? [],
          from_addresses: [],
        },
      ],
    }),
    copyAllowed: (address) => !addressBlocklisted(subscribers, address),
    ...(options.refuse ? { refuse: options.refuse } : {}),
  });
  // Production marketing settings defaults (settings/defaults.ts), mutable per test.
  const marketing: MarketingSettings = {
    rootUrl: "http://fixture.test",
    siteName: "Fixture list",
    minInterval: "P7D",
    unsubscribeHeader: true,
    allowBlocklist: true,
    individualTracking: false,
    disableTracking: false,
    ...options.marketing,
  };
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    ...(webhookEffects ? { ended: webhookEffects.sendEnded } : {}),
    marketingPolicy: createMarketingPolicy({ subscribers, lists, settings: () => marketing }),
    templateNames: (ids) => templates.names(ids),
  });
  const tracking = createTracking(db, clock);
  let outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
  const router = createRouter();
  // As src/main.ts: the personal public pages' headers (B125).
  router.use(personalPageHeaders);
  registerUserRoutes(router, users, roles, auth, fixturePageSite);
  registerListRoutes(router, listStore, roles, auth);
  registerSubscriberRoutes(router, subscribers, roles, auth);
  if (subscriberQuery) {
    registerSubscriberQueryRoutes(router, subscriberQuery, subscribers, roles, auth);
  }
  registerTemplateRoutes(router, templates, renderer, auth, () => pageOptions());
  registerSendRoutes(router, sends, auth);
  if (webhooks) {
    registerWebhookRoutes(router, { webhooks, auth });
  }
  // The one settings source, as in src/main.ts: the bounce routes read the store, so a `bounce.*`
  // write through the API or `setBounce` reaches them at once.
  if (webhooks) {
    settingsStore = createSettings(db, clock, "http://fixture.test", roles);
    // Fresh fixtures run with bounces on. A migrated database keeps the rules it was given.
    settingsStore.update((current) => ({
      ...current,
      "bounce.enabled": true,
      "bounce.webhooks_enabled": true,
      "bounce.ses_enabled": true,
      "bounce.ses_topic_arns": ["arn:aws:sns:*:123456789012:*"],
      ...(options.persisted
        ? {}
        : {
            "bounce.actions": {
              soft: { count: 2, action: "none" },
              hard: { count: 1, action: "blocklist" },
              complaint: { count: 1, action: "delete" },
            },
          }),
    }));
    const testSends = createTestSends(db, clock);
    bounces = createBounceStore(db, clock, {
      subscribers: () => subscribers,
      sendTarget: (uuid) => sends.bounceTarget(uuid),
      campaignID: () => null,
      recorded: webhookEffects!.bounceRecorded,
      actions: () => asBody<Record<string, BounceAction>>(settingsStore!.read()["bounce.actions"]),
      testSend: (messageId) => testSends.find(messageId),
    });
    registerBounceRoutes(router, {
      db,
      clock,
      store: bounces,
      page: () => pageOptions(),
      subscribers,
      roles,
      auth,
      logger: app.logger,
      settings: () => {
        const current = settingsStore!.read();
        return {
          enabled: current["bounce.enabled"],
          webhooksEnabled: current["bounce.webhooks_enabled"],
          ses: current["bounce.ses_enabled"],
          sesTopics: current["bounce.ses_topic_arns"],
        };
      },
      limit: options.bounceLimit ?? ((_context, next) => next()),
      sns: createSnsClient({ clock, fetch: options.snsFetch ?? refuseNetwork }),
    });
  }
  const media = createMediaStore(db, clock);
  const files = createFilesystem(directory, () => ({
    uploadPath: "uploads",
    uploadUri: "/uploads",
  }));
  registerMediaRoutes(router, {
    store: media,
    files,
    auth,
    settings: () => ({
      provider: "filesystem",
      extensions: ["*"],
      rootUrl: "http://fixture.test",
    }),
  });
  registerTxRoutes(router, {
    auth,
    sends,
    outbox: {
      dispatch: (ids: Array<bigint>) =>
        options.beforeDispatch
          ? options.beforeDispatch().then(() => outbox.dispatch(ids))
          : outbox.dispatch(ids),
    },
    subscribers,
    templates,
    renderer,
    lists,
    attachments: createAttachments(media, files),
    embedImages: createEmbeds(media, app.logger),
    policy: () => ({
      fromEmail: "Fixture <noreply@fixture.test>",
      domainAllowlist: [],
      domainBlocklist: [],
      ...options.policy,
    }),
    marketing: { settings: () => marketing, tracking },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  // The public pages' site options (B121): the fixture's site, unless a test gives its own.
  const pageOptions = (): PageOptions =>
    options.page?.() ?? {
      rootUrl: marketing.rootUrl,
      logoUrl: "",
      faviconUrl: "",
      subscriptionPage: false,
      archive: false,
      siteUrl: "",
      accent: "",
      font: "system-sans",
      header: "auto",
      siteName: marketing.siteName,
      allowBlocklist: marketing.allowBlocklist,
      allowPreferences: false,
      allowExport: false,
      allowWipe: false,
    };
  // The subscriber mail, made with the public routes below when `webhooks` is set.
  let subscriberMail: SubscriberMail | undefined;
  registerUnsubscribeRoutes(router, {
    db,
    sends,
    subscribers,
    tracking,
    settings: () => marketing,
    ...(options.effects ? { effects: options.effects } : {}),
    page: pageOptions,
    privacy: createPrivacy({
      db,
      subscribers,
      mail: options.mail ?? (() => subscriberMail ?? unwiredMail()),
      // Export and wipe are on unless the fixture's page options turn them off (its default does not).
      page: () => ({
        ...pageOptions(),
        allowExport: options.page ? pageOptions().allowExport : true,
        allowWipe: options.page ? pageOptions().allowWipe : true,
      }),
    }),
  });
  if (webhooks) {
    registerSettingsRoutes(router, settingsStore!, auth);
    const getPublicSettings = () => ({
      ...toPublicSettings(settingsStore!.read()),
      fromEmail: "Fixture <noreply@fixture.test>",
    });
    subscriberMail = createSubscriberMail({
      subscribers,
      sends,
      campaigns: { subscriberViews: () => [] },
      tracking,
      events: { list: () => [] },
      bounces: bounces ?? { forExport: () => [] },
      renderer,
      i18n: app.i18n,
      clock: testClock,
      logger: app.logger,
      settings: getPublicSettings,
    });
    registerPublicRoutes(router, {
      db,
      lists,
      subscribers,
      mail: subscriberMail,
      settings: getPublicSettings,
      captcha: asBody<Captcha>({}),
      altchaComplexity: () => 0,
      limits: { subscribe: open, optin: open },
      clientAddress: () => "127.0.0.1",
    });
  }
  const blockPrivate = { value: false };
  const startDelivery = () =>
    webhooks
      ? startWebhookDelivery({
          db,
          clock,
          logger: app.logger,
          webhooks,
          blockPrivate: () => blockPrivate.value,
          transport: options.webhooks!,
        })
      : undefined;
  let delivery = startDelivery();
  // The loop's zero-length yields need no time to pass, only a turn of the injected clock.
  const pump = webhooks ? setInterval(() => testClock.advance(0), 1) : undefined;
  const sessionHeaders = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
  const request = (path: string, init: RequestInit = {}) =>
    router.handle(app, new Request(`http://fixture.test${path}`, init));
  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = sessionHeaders,
  ) => {
    const response = await request(path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const tx = (body: unknown, headers: Record<string, string> = sessionHeaders) =>
    json("/api/tx", "POST", body, headers);
  const template = async (body: string, subject = "Subject {{ data.order }}", type = "tx") => {
    const created = await json("/api/templates", "POST", { name: "fixture", type, subject, body });
    if (created.status !== 200) {
      throw new Error(`template ${created.status}`);
    }
    return asBody<number>(created.body.data.id);
  };
  const subscriber = async (email: string, name = "Fixture Person", extra: JsonObject = {}) => {
    const created = await json("/api/subscribers", "POST", { email, name, ...extra });
    if (created.status !== 200) {
      throw new Error(`subscriber ${created.status}`);
    }
    return asBody<number>(created.body.data.id);
  };
  /**
   * B123 (D126): the path of a subscriber's privacy action through a marketing send of theirs,
   * made as any marketing send is (POST /api/tx). The send's UUID pairs them with the action.
   */
  const privacyPath = async (subscriberId: number, action: "export" | "wipe") => {
    const list = await json("/api/lists", "POST", {
      name: `paired ${subscriberId} ${action}`,
      type: "public",
      optin: "single",
    });
    if (list.status !== 200) {
      throw new Error(`list ${list.status}`);
    }
    const sent = await json("/api/tx", "POST", {
      subscriber_id: subscriberId,
      template_id: await template("<p>Paired</p>", "Paired"),
      kind: "marketing",
      list_id: list.body.data.id,
    });
    if (sent.status !== 200) {
      throw new Error(`send ${sent.status}`);
    }
    const send = asBody<string>(
      (await json(`/api/sends/${sent.body.data.sends[0].id}`)).body.data.uuid,
    );
    const who = asBody<string>((await json(`/api/subscribers/${subscriberId}`)).body.data.uuid);
    // B126 (D123): a wipe deletes only when confirmed; the bare POST answers its confirmation page.
    return `/m/${send}/${action}/${who}${action === "wipe" ? "?confirm=true" : ""}`;
  };
  return {
    privacyPath,
    app,
    db,
    clock: testClock,
    auth,
    session,
    sessionHeaders,
    sink,
    directory,
    errors,
    request,
    json,
    tx,
    template,
    subscriber,
    sends,
    emailer,
    marketing,
    owners: {
      router,
      lists,
      subscribers,
      tracking,
      renderer,
      templates,
      roles,
      users,
      media,
      files,
    },
    get outbox() {
      return outbox;
    },
    /** Stop delivery so queued rows stay queued, as during downtime. */
    stopOutbox: () => outbox.stop(),
    /** A fresh outbox over the same journal, as after a process restart. */
    restartOutbox() {
      outbox = startOutbox({ db, clock, logger: app.logger, sends, emailer });
    },
    webhooks,
    bounces,
    /** Change `bounce.*` settings in the store the bounce routes read (no separate copy). */
    setBounce(changes: Record<string, unknown>) {
      settingsStore!.update((current) => ({ ...current, ...changes }));
    },
    /** Change one rule of `bounce.actions`: `soft`, `hard` or `complaint`. */
    setBounceAction(kind: "soft" | "hard" | "complaint", rule: BounceAction) {
      settingsStore!.update((current) => ({
        ...current,
        "bounce.actions": { ...current["bounce.actions"], [kind]: rule },
      }));
    },
    blockPrivate,
    /** Move the injected clock, then let the delivery loop see it without its idle poll. */
    advanceWebhooks(milliseconds: number) {
      testClock.advance(milliseconds);
      delivery?.wake();
    },
    /** Stop the loop and drop what it knew; a held attempt's row keeps only its lease. */
    async crashWebhooks() {
      await delivery?.halt();
    },
    /** A fresh loop over the same rows, as after a process restart. */
    /** Resolves when this start's check of refused targets has ended (B125 r2). */
    startWebhooks() {
      delivery = startDelivery();
      return delivery?.checked;
    },
    count: () => Number(asBody<{ n: bigint }>(db.query("SELECT count(*) AS n FROM sends").get()).n),
    settings: settingsStore,
    mailTo: (address: string) => sink.messages.filter((m) => m.to.includes(address)),
    async drain() {
      for (
        let i = 0;
        i < 200 &&
        asBody<{ n: bigint }>(
          db.query("SELECT count(*) AS n FROM sends WHERE status IN ('queued', 'sending')").get(),
        ).n > 0n;
        i++
      ) {
        testClock.advance(1000);
        await Bun.sleep(5);
      }
    },
    async close() {
      await delivery?.halt();
      clearInterval(pump);
      settingsStore?.close();
      bounces?.close();
      webhooks?.close();
      const stopped = outbox.stop();
      await emailer.close();
      await stopped;
      media.close();
      sends.close();
      tracking.close();
      templates.close();
      templateReferences.close();
      users.close();
      roles.close();
      subscriberQuery?.close();
      await runner?.close();
      readonly?.close();
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
export type TxFixture = Awaited<ReturnType<typeof txFixture>>;
