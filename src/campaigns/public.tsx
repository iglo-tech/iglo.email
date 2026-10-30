// Campaign unsubscribe page, one-click unsubscribe, view pixel and tracked-link redirect,
// adapted from listmonk cmd/public.go (SubscriptionPage, SubscriptionPrefs, LinkRedirect,
// RegisterCampaignView), cmd/handlers.go (hasUUID, hasSub, noIndex) and
// queries/subscribers.sql (unsubscribe-by-campaign) at 6fcd95f. Preferences management
// and the page itself are src/public/preferences.tsx; view in browser and the archive are
// src/public/archive.tsx.
import type { Database } from "bun:sqlite";
import { deflateSync, crc32 } from "node:zlib";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { parseBool, readPreferences, type PreferenceForm } from "@/public/form";
import { publicMessage } from "@/public/message";
import { savePreferences, subscriptionPage, type PageOptions } from "@/public/preferences";
import type { Middleware, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";
import type { Tracking } from "@/unsubscribe/tracking";
import { dummyUUID } from "@/campaigns/render";
import type { CampaignStore } from "@/campaigns/store";

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const noIndex = { "X-Robots-Tag": "noindex" };
export interface PublicCampaignSettings {
  siteName: string;
  allowBlocklist: boolean;
  disableTracking: boolean;
  individualTracking: boolean;
}

/** Go image/png encoding of a transparent 1x1 RGBA image, as listmonk's pixelPNG. */
function transparentPixel(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(5))),
    chunk("IEND", new Uint8Array()),
  ]);
}
export function registerCampaignPublicRoutes(
  router: Router,
  deps: {
    db: Database;
    store: CampaignStore;
    subscribers: SubscriberStore;
    tracking: Tracking;
    settings: () => PublicCampaignSettings;
    effects: UnsubscribeEffects;
    /** Public page settings; without them only the plain unsubscribe page shows. */
    page?: () => PageOptions;
    limit?: Middleware;
  },
) {
  const limit = deps.limit ? [deps.limit] : [];
  const options = (): PageOptions =>
    deps.page?.() ?? {
      siteName: deps.settings().siteName,
      allowBlocklist: deps.settings().allowBlocklist,
      allowPreferences: false,
      allowExport: false,
      allowWipe: false,
    };
  const pixel = transparentPixel();
  const page = (
    i18n: Translation,
    status: number,
    title: string,
    message: string,
    headers: Record<string, string> = {},
  ) => publicMessage(i18n, { status, title, message, siteName: deps.settings().siteName }, headers);
  const invalidUUID = (context: RequestContext, ...names: string[]) =>
    names.some((name) => !uuidPattern.test(context.params[name] ?? ""))
      ? page(
          context.app.i18n,
          400,
          context.app.i18n.T("globals.terms.error"),
          context.app.i18n.T("globals.messages.invalidUUID"),
          noIndex,
        )
      : null;
  /** hasSub: an unknown subscriber is a 404 page. */
  const subscriber = (context: RequestContext) =>
    deps.subscribers.byUuid(context.params.subUUID!.toLowerCase());
  const noSubscriber = (t: Translation) =>
    page(
      t,
      404,
      t.T("globals.terms.notFound"),
      t.Ts("globals.messages.notFound", "name", t.T("globals.terms.subscriber")),
      noIndex,
    );

  router.route("GET", "/subscription/:campUUID/:subUUID", (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "campUUID", "subUUID");
    if (bad) return bad;
    const sub = subscriber(context);
    if (!sub) return noSubscriber(t);
    if (sub.status === "blocklisted")
      return page(t, 200, t.T("public.noSubTitle"), t.T("public.blocklisted"), noIndex);
    const manage = parseBool(context.url.searchParams.get("manage")) === true;
    return subscriptionPage(t, deps.subscribers, sub, options(), manage, noIndex);
  });

  // RFC 8058 one-click and the page form: no login, CSRF token or CAPTCHA.
  router.route(
    "POST",
    "/subscription/:campUUID/:subUUID",
    async (context) => {
      const t = context.app.i18n;
      const bad = invalidUUID(context, "campUUID", "subUUID");
      if (bad) return bad;
      if (!subscriber(context)) return noSubscriber(t);
      let form: PreferenceForm;
      try {
        form = await readPreferences(context.request);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidData"));
      }
      const blocklist = deps.settings().allowBlocklist && form.blocklist;
      const campUuid = context.params.campUUID!.toLowerCase();
      if (form.manage && !blocklist)
        return (
          savePreferences({ ...deps, effects: deps.effects }, t, options(), form, () =>
            subscriber(context),
          ) ?? noSubscriber(t)
        );
      writeTransaction(deps.db, () => {
        // Re-read inside the write: unsubscribe from the campaign's lists, or blocklist.
        const sub = subscriber(context);
        if (!sub) return;
        // The dummy campaign is the opt-in mail's link: end every unconfirmed subscription.
        if (campUuid === dummyUUID && !blocklist) {
          const changed = deps.subscribers.unsubscribeUnconfirmed(sub.id);
          for (const list of changed)
            deps.effects.unsubscribed({
              subscriberId: sub.id,
              listId: list,
              listIds: [list],
              blocklisted: false,
            });
          return;
        }
        const campaign = deps.store.byUuid(campUuid);
        const lists =
          campaign && campaign.uuid !== dummyUUID ? deps.store.listIds(campaign.id) : [];
        if (blocklist) {
          const changed = deps.subscribers.unsubscribe(sub.id, lists[0] ?? 0n, true);
          deps.effects.unsubscribed({
            subscriberId: sub.id,
            listId: lists[0] ?? 0n,
            listIds: changed,
            blocklisted: true,
          });
          return;
        }
        for (const list of lists) {
          const changed = deps.subscribers.unsubscribe(sub.id, list, false);
          deps.effects.unsubscribed({
            subscriberId: sub.id,
            listId: list,
            listIds: changed,
            blocklisted: false,
          });
        }
      });
      return page(t, 200, t.T("globals.terms.unsubscribed"), t.T("public.unsubbedInfo"));
    },
    ...limit,
  );

  router.route("GET", "/campaign/:campUUID/:subUUID/px.png", (context) => {
    const bad = invalidUUID(context, "campUUID", "subUUID");
    if (bad) return bad;
    const settings = deps.settings();
    const campUuid = context.params.campUUID!.toLowerCase();
    const subUuid = context.params.subUUID!.toLowerCase();
    // Preview hits use the dummy campaign and are never recorded. Without individual tracking
    // every emitted pixel names the dummy subscriber and counts as an anonymous view.
    if (
      !settings.disableTracking &&
      campUuid !== dummyUUID &&
      (!settings.individualTracking || subUuid !== dummyUUID)
    ) {
      const campaign = deps.store.byUuid(campUuid);
      if (campaign)
        try {
          const sub = settings.individualTracking ? deps.subscribers.byUuid(subUuid) : null;
          deps.store.registerView(campaign.id, sub?.id ?? null);
        } catch (error) {
          // listmonk always answers with the pixel and logs a registration failure.
          context.app.logger.error(error);
        }
    }
    return new Response(Uint8Array.from(pixel), {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "no-cache", ...noIndex },
    });
  });

  router.route("GET", "/link/:linkUUID/:campUUID/:subUUID", (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "linkUUID", "campUUID", "subUUID");
    if (bad) return bad;
    const link = deps.tracking.get(context.params.linkUUID!.toLowerCase());
    const settings = deps.settings();
    const invalid = () =>
      page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidLink"), noIndex);
    if (!link) return invalid();
    const campaign = deps.store.byUuid(context.params.campUUID!.toLowerCase());
    if (!settings.disableTracking && !campaign) return invalid();
    // Only links this campaign's content registered redirect, so a URL registered by another
    // send can't use the campaign domain as an open redirect (a deliberate difference).
    if (!campaign || !deps.store.hasLink(campaign.id, link.id))
      return page(
        t,
        404,
        t.T("globals.terms.notFound"),
        t.T("globals.messages.invalidLink"),
        noIndex,
      );
    if (!settings.disableTracking) {
      // RegisterCampaignLinkClick: the subscriber is optional.
      const sub = settings.individualTracking
        ? deps.subscribers.byUuid(context.params.subUUID!.toLowerCase())
        : null;
      deps.store.registerClick(campaign.id, link.id, sub?.id ?? null);
    }
    return new Response(null, { status: 307, headers: { Location: link.url, ...noIndex } });
  });
}
