// The tx fixture (journal, outbox, loopback SMTP sink, fake clock) with the public pages,
// campaign public routes and archive on top, wired as src/main.ts does.
import { createRunnerStore } from "@/campaigns/runner/store";
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createEventStore } from "@/events/store";
import { createPublicImages } from "@/media/embed";
import { registerArchiveRoutes } from "@/public/archive";
import { createSubscriberMail, startSignupMail } from "@/public/mail";
import { rateLimited } from "@/public/rate-limit";
import { registerPublicRoutes } from "@/public/routes";
import { createCaptcha } from "@/captcha/captcha";
import { createPrivacy } from "@/public/privacy";
import { publicSettings } from "@/public/settings";
import type { PublicSettings } from "@/public/settings";
import { createRoles } from "@/roles/roles";
import { createClientAddress } from "@/server/client-address";
import { createFixtureSettings } from "@/test/settings/instance-fixture";
import { txFixture } from "@/test/tx/fixture";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";
import { asBody } from "@/test/read-body";

const unsetSettings = (): PublicSettings => {
  throw new Error("unset");
};

const form = { "content-type": "application/x-www-form-urlencoded" };

export async function publicFixture() {
  const calls: Array<{ inTransaction: boolean; listIds: Array<bigint> }> = [];
  let failEffect = false;
  const effects: UnsubscribeEffects = {
    unsubscribed(event) {
      calls.push({ inTransaction: f.db.inTransaction, listIds: event.listIds });
      if (failEffect) {
        throw new Error("effect failed");
      }
    },
    // The public "all lists" option (B130) is recorded as a call that names no list.
    unsubscribedAll() {
      calls.push({ inTransaction: f.db.inTransaction, listIds: [] });
      if (failEffect) {
        throw new Error("effect failed");
      }
    },
  };
  const overrides: Partial<PublicSettings> = {};
  let settings = unsetSettings;
  // The tx fixture mounts the `/m/` routes, so they take this fixture's subscriber mail (B123).
  const f = await txFixture({ effects, page: () => settings(), mail: () => mail });
  const { router, lists, subscribers, tracking, renderer, templates, media, files } = f.owners;
  const roles = createRoles(f.db, lists);
  const store = createFixtureSettings(f.db, f.clock, "http://fixture.test");
  settings = () => ({
    ...publicSettings(store.read()),
    fromEmail: "Fixture <noreply@fixture.test>",
    ...overrides,
  });
  const campaigns = createCampaignStore(f.db, f.clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
    mediaFilename: () => null,
  });
  const events = createEventStore(f.db, subscribers, {
    emailAllowed: () => true,
    exitThenTrigger: () => ({ started: [], ended: [], skipped: [] }),
    i18n: f.app.i18n,
  });
  const mail = createSubscriberMail({
    subscribers,
    sends: f.sends,
    bounces: { forExport: () => [] },
    campaigns,
    tracking,
    events,
    renderer,
    i18n: f.app.i18n,
    clock: f.clock,
    logger: f.app.logger,
    settings,
  });
  const signups = startSignupMail({
    db: f.db,
    clock: f.clock,
    logger: f.app.logger,
    mail,
  });
  const clientAddress = createClientAddress(() => settings().trustedProxies, f.app.logger);
  const limit = (limit: number) =>
    rateLimited(f.clock, { limit, windowMs: 60_000, maxPeers: 100 }, settings, clientAddress);
  const hcaptcha = { url: "http://127.0.0.1:1/siteverify" };
  const captchaOptions = (): any => store.read()["security.captcha"];
  const captcha = await createCaptcha({
    clock: f.clock,
    options: captchaOptions,
    get hcaptchaUrl() {
      return hcaptcha.url;
    },
    maxUsed: 50,
  });
  registerPublicRoutes(router, {
    db: f.db,
    lists,
    subscribers,
    mail,
    settings,
    captcha,
    altchaComplexity: () => asBody<number>(captchaOptions().altcha.complexity),
    limits: { subscribe: limit(5), optin: limit(5) },
    clientAddress,
  });
  registerCampaignPublicRoutes(router, {
    db: f.db,
    store: campaigns,
    subscribers,
    tracking,
    settings: () => ({
      ...settings(),
      disableTracking: false,
      individualTracking: false,
    }),
    effects,
    page: settings,
    limit: limit(5),
    privacy: createPrivacy({ db: f.db, subscribers, mail: () => mail, page: settings }),
    privacyLimit: limit(5),
  });
  registerArchiveRoutes(router, {
    store: campaigns,
    subscribers,
    templates,
    renderer,
    settings,
    publicImages: createPublicImages(media, (name) => files.url(settings().rootUrl, name)),
  });
  const peer = (path: string, address: string, init: RequestInit = {}) =>
    router.handle(f.app, new Request(`http://fixture.test${path}`, init), address);
  const post = (path: string, body = "", address = "192.0.2.1") =>
    peer(path, address, { method: "POST", headers: form, body });
  let peers = 0;
  return {
    ...f,
    settings,
    /**
     * A campaign the runner has delivered to each of these subscribers: the pairing D126 gives
     * their privacy paths and their blocklist. Its UUID.
     */
    deliveredCampaign(subscribers: Array<number>, lists: Array<number> = []): string {
      const campaign = campaigns.create(
        {
          type: "regular",
          name: "Weekly",
          subject: "Weekly",
          from_email: "Fixture <noreply@fixture.test>",
          body: "<p>Hello</p>",
          body_source: null,
          altbody: null,
          content_type: "html",
          send_at: null,
          headers: [],
          attribs: {},
          tags: [],
          messenger: "email",
          template_id: null,
          archive: false,
          archive_slug: null,
          archive_template_id: null,
          archive_meta: {},
        },
        lists.map(BigInt),
        [],
      );
      const runner = createRunnerStore(f.db);
      const now = f.clock.now().toISOString();
      for (const id of subscribers) {
        if (!runner.claim(campaign.id, BigInt(id), now)) {
          throw new Error("delivery not claimed");
        }
      }
      return campaign.uuid;
    },
    store,
    overrides,
    hcaptcha,
    campaigns,
    mail,
    calls,
    failEffects: (value: boolean) => {
      failEffect = value;
    },
    peer,
    post,
    /** Each call a new peer, so behavior tests stay under the limits. */
    fresh: (path: string, body = "") => post(path, body, `198.51.100.${++peers}`),
    list: async (name: string, type = "public", optin = "single") =>
      asBody<{ id: number; uuid: string }>(
        (await f.json("/api/lists", "POST", { name, type, optin })).body.data,
      ),
    status: async (id: number, list: number) =>
      asBody<Array<{ id: number; subscription_status: string }>>(
        (await f.json(`/api/subscribers/${id}`)).body.data.lists,
      ).find((item) => item.id === list)?.subscription_status,
    mailTo: (address: string) => f.sink.messages.filter((m) => m.to.includes(address)),
    /**
     * Advances the injected clock a second per step, at most 200 steps, while mail is queued or a
     * send is open. The bound is in injected time, so every host sees the same window: a send that
     * never settles uses all 200 steps. A send that settles also takes real time: each step yields
     * 5 ms so the outbox and SMTP I/O can run, so a settling drain is bounded by its steps and by
     * that real time. Fails by name unless exactly `expectOpen` (default 0) mail or sends are still
     * open at the end, so a send left open cannot pass a no-mail check.
     */
    async drain(expectOpen = 0) {
      // The outbox also polls on the clock; a wake during its previous batch waits for that.
      let open = mail.queued() + openSends(f);
      for (let i = 0; i < 200 && open > 0; i++) {
        f.clock.advance(1000);
        await Bun.sleep(5);
        open = mail.queued() + openSends(f);
      }
      if (open !== expectOpen) {
        throw new Error(
          `drain: ${open} mail or send still queued or sending after 200 steps (expected ${expectOpen})`,
        );
      }
    },
    async close() {
      await signups.stop();
      campaigns.close();
      events.close();
      store.close();
      roles.close();
      await f.close();
    },
  };
}
const openSends = (f: { db: { query(sql: string): { get(): unknown } } }) =>
  Number(
    asBody<{ n: bigint }>(
      f.db.query("SELECT count(*) AS n FROM sends WHERE status IN ('queued', 'sending')").get(),
    ).n,
  );
export type PublicFixture = Awaited<ReturnType<typeof publicFixture>>;
