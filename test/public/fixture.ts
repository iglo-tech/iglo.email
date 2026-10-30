// The tx fixture (journal, outbox, loopback SMTP sink, fake clock) with the public pages,
// campaign public routes and archive on top, wired as src/main.ts does.
import { createCampaignStore } from "@/campaigns/store";
import { registerCampaignPublicRoutes } from "@/campaigns/public";
import { createEventStore } from "@/events/store";
import { registerArchiveRoutes } from "@/public/archive";
import { createSubscriberMail, startSignupMail } from "@/public/mail";
import { rateLimited } from "@/public/rate-limit";
import { registerPublicRoutes } from "@/public/routes";
import { publicSettings, type PublicSettings } from "@/public/settings";
import { createRoles } from "@/roles/roles";
import { createSettings } from "@/settings/store";
import { txFixture } from "@/test/tx/fixture";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";

const form = { "content-type": "application/x-www-form-urlencoded" };

export async function publicFixture() {
  const calls: { inTransaction: boolean; listIds: bigint[] }[] = [];
  let failEffect = false;
  const effects: UnsubscribeEffects = {
    unsubscribed(event) {
      calls.push({ inTransaction: f.db.inTransaction, listIds: event.listIds });
      if (failEffect) throw new Error("effect failed");
    },
  };
  const overrides: Partial<PublicSettings> = {};
  let settings = (): PublicSettings => {
    throw new Error("unset");
  };
  const f = await txFixture({ effects, page: () => settings() });
  const { router, lists, subscribers, tracking, renderer, templates } = f.owners;
  const roles = createRoles(f.db, lists);
  const store = createSettings(f.db, f.clock, "http://fixture.test", roles);
  settings = () => ({
    ...publicSettings(store.read()),
    fromEmail: "Fixture <noreply@fixture.test>",
    ...overrides,
  });
  const campaigns = createCampaignStore(f.db, f.clock, {
    templateExists: (id) => templates.get(id) !== null,
    defaultTemplate: () => templates.getDefault()?.id ?? null,
    listName: (id) => lists.name(id),
  });
  const events = createEventStore(f.db, subscribers, {
    emailAllowed: () => true,
    exitThenTrigger: () => ({ started: [], ended: [] }),
  });
  const mail = createSubscriberMail({
    subscribers,
    sends: f.sends,
    campaigns,
    tracking,
    events,
    renderer,
    i18n: f.app.i18n,
    clock: f.clock,
    logger: f.app.logger,
    settings,
  });
  const signups = startSignupMail({ db: f.db, clock: f.clock, logger: f.app.logger, mail });
  const limit = (limit: number) =>
    rateLimited(f.clock, { limit, windowMs: 60_000, maxPeers: 100 }, () => "Fixture");
  registerPublicRoutes(router, {
    db: f.db,
    lists,
    subscribers,
    mail,
    settings,
    limits: { subscribe: limit(5), optin: limit(5), privacy: limit(5) },
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
  });
  registerArchiveRoutes(router, { store: campaigns, subscribers, templates, renderer, settings });
  const peer = (path: string, address: string, init: RequestInit = {}) =>
    router.handle(f.app, new Request(`http://fixture.test${path}`, init), address);
  const post = (path: string, body = "", address = "192.0.2.1") =>
    peer(path, address, { method: "POST", headers: form, body });
  let peers = 0;
  return {
    ...f,
    settings,
    overrides,
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
      (await f.json("/api/lists", "POST", { name, type, optin })).body.data as {
        id: number;
        uuid: string;
      },
    status: async (id: number, list: number) =>
      (await f.json(`/api/subscribers/${id}`)).body.data.lists.find(
        (item: { id: number }) => item.id === list,
      )?.subscription_status as string | undefined,
    mailTo: (address: string) => f.sink.messages.filter((m) => m.to.includes(address)),
    async drain() {
      // The outbox also polls on the clock; a wake during its previous batch waits for that.
      for (let i = 0; i < 200 && (mail.queued() > 0 || (await pending(f))); i++) {
        f.clock.advance(1000);
        await Bun.sleep(5);
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
const pending = async (f: { db: { query(sql: string): { get(): unknown } } }) =>
  (
    f.db.query("SELECT count(*) AS n FROM sends WHERE status IN ('queued', 'sending')").get() as {
      n: bigint;
    }
  ).n > 0n;
export type PublicFixture = Awaited<ReturnType<typeof publicFixture>>;
