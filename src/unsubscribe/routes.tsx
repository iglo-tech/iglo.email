// Public unsubscribe page, one-click unsubscribe, view pixel and tracked-link redirect for
// sends. Adapted from listmonk cmd/public.go (SubscriptionPage, SubscriptionPrefs,
// LinkRedirect, RegisterCampaignView), cmd/handlers.go (hasUUID, hasSub, noIndex) and
// static/public/templates/subscription.html at 6fcd95f, scoped to the send's list.
import type { Database } from "bun:sqlite";
import { deflateSync, crc32 } from "node:zlib";
import { dummyUUID } from "@/campaigns/render";
import { writeTransaction } from "@/db/transaction";
import { must } from "@/invariant";
import type { Translation } from "@/i18n/i18n";
import type { Sends } from "@/messaging/sends";
import { parseBool, readPreferences } from "@/public/form";
import type { PreferenceForm } from "@/public/form";
import { publicMessage } from "@/public/message";
import { savePreferences, subscriptionPage } from "@/public/preferences";
import type { PageMode, PageOptions } from "@/public/preferences";
import type { Privacy } from "@/public/privacy";
import type { Middleware, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import { linkPath } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";

/**
 * Effects of an unsubscribe request, called inside its write transaction on every POST,
 * including repeats. `listId` is the requested send's list; `listIds` are the memberships
 * whose status changed. M5 cancels active enrollments in sequences tied to `listId` and
 * `listIds` (exit_reason `unsubscribed`). Webhooks queue from the subscriber store's `changed`
 * effect, which only sees real changes.
 */
export interface UnsubscribeEffects {
  unsubscribed(event: {
    subscriberId: bigint;
    listId: bigint;
    listIds: Array<bigint>;
    blocklisted: boolean;
  }): void;
}
const noEffects: UnsubscribeEffects = { unsubscribed() {} };

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const noIndex = { "X-Robots-Tag": "noindex" };

const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** Go image/png encoding of a transparent 1x1 RGBA image, as listmonk's pixelPNG. */
function transparentPixel(): Uint8Array {
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

export function registerUnsubscribeRoutes(
  router: Router,
  deps: {
    db: Database;
    sends: Sends;
    subscribers: SubscriberStore;
    tracking: Tracking;
    settings: () => MarketingSettings;
    effects?: UnsubscribeEffects;
    /** The site's branding and privacy options, read for each page (B121). */
    page: () => PageOptions;
    limit?: Middleware;
    /** The export and wipe answers of a send's subscriber (B123, D126). */
    privacy: Privacy;
    privacyLimit?: Middleware;
  },
) {
  const effects = deps.effects ?? noEffects;
  const limit = deps.limit ? [deps.limit] : [];
  const privacyLimit = deps.privacyLimit ? [deps.privacyLimit] : [];
  const options = deps.page;
  const pixel = transparentPixel();
  // B121: every page of these routes is the branded public page, from the same site settings.
  const page = (
    i18n: Translation,
    status: number,
    title: string,
    message: string,
    headers: Record<string, string> = {},
  ) => {
    const site = options();
    return publicMessage(i18n, { status, title, message, site }, headers);
  };
  const invalidUUID = (context: RequestContext, ...names: Array<string>) =>
    names.some((name) => !uuidPattern.test(context.params[name] ?? ""))
      ? page(
          context.app.i18n,
          400,
          context.app.i18n.T("globals.terms.error"),
          context.app.i18n.T("public.linkNotValid"),
        )
      : null;
  /**
   * The send and its current subscriber, when both UUIDs belong together (D126, r1): a marketing send
   * to a list, or a transactional send, which pairs through the journal like any other send. Only the
   * marketing variant may blocklist or wipe; both variants reach export (B126 r2, D123 item 8).
   */
  const pairedSend = (sendUuid: string, subscriberUuid: string) => {
    const send = deps.sends.byUuid(sendUuid.toLowerCase());
    if (!send || send.subscriber_id === null) {
      return null;
    }
    const subscriber = deps.subscribers.get(send.subscriber_id);
    if (!subscriber || subscriber.uuid !== subscriberUuid.toLowerCase()) {
      return null;
    }
    if (send.kind === "marketing" && send.list_id !== null) {
      return { marketing: true as const, send, list: send.list_id, subscriber };
    }
    if (send.kind === "transactional") {
      return { marketing: false as const, send, subscriber };
    }
    return null;
  };
  /** The marketing send and its subscriber: the only pairing that blocklists or reaches privacy. */
  const target = (sendUuid: string, subscriberUuid: string) => {
    const found = pairedSend(sendUuid, subscriberUuid);
    return found?.marketing ? found : null;
  };
  const notFound = (i18n: Translation, headers: Record<string, string> = {}) =>
    page(i18n, 404, i18n.T("globals.terms.notFound"), i18n.T("public.errorFetchingEmail"), headers);
  /**
   * D116: a test send's unsubscribe and manage links name the placeholder send UUID, which no send
   * has. Its page reads and writes nothing, so it does not look up the subscriber either.
   */
  const testSendPage = (i18n: Translation) =>
    page(i18n, 200, i18n.T("public.testSendTitle"), i18n.T("public.testSendInfo"), noIndex);

  router.route("GET", "/m/:sendUUID/unsubscribe/:subUUID", (context) => {
    const t = context.app.i18n;
    if (context.params.sendUUID === dummyUUID) {
      return testSendPage(t);
    }
    const bad = invalidUUID(context, "sendUUID", "subUUID");
    if (bad) {
      return bad;
    }
    const found = pairedSend(
      must(context.params.sendUUID, "send UUID"),
      must(context.params.subUUID, "subscriber UUID"),
    );
    if (!found) {
      return notFound(t, noIndex);
    }
    if (found.subscriber.status === "blocklisted") {
      return page(t, 200, t.T("public.noSubTitle"), t.T("public.blocklisted"), noIndex);
    }
    const manage = parseBool(context.url.searchParams.get("manage")) === true;
    // B123 (D126): the page's forms post to this send's paired routes.
    const base = `/m/${must(context.params.sendUUID, "send UUID").toLowerCase()}`;
    // B126 (D123): a marketing link covers its send's list and may blocklist; a transactional link
    // reads its subscriber's memberships instead, and has no blocklist (D126, r1).
    const mode: PageMode = found.marketing
      ? { kind: "paired", base, blocklist: true, privacy: true, lists: [found.list] }
      : { kind: "transactional", base };
    return subscriptionPage(
      t,
      deps.subscribers,
      found.subscriber,
      options(),
      manage,
      noIndex,
      mode,
    );
  });

  // RFC 8058 one-click and the page form: no login, CSRF token or CAPTCHA.
  router.route(
    "POST",
    "/m/:sendUUID/unsubscribe/:subUUID",
    async (context) => {
      const t = context.app.i18n;
      // D116: a mail client's one-click POST to a test send changes nothing and answers the page.
      if (context.params.sendUUID === dummyUUID) {
        return testSendPage(t);
      }
      const bad = invalidUUID(context, "sendUUID", "subUUID");
      if (bad) {
        return bad;
      }
      const sendUuid = must(context.params.sendUUID, "send UUID");
      const subUuid = must(context.params.subUUID, "subscriber UUID");
      if (!pairedSend(sendUuid, subUuid)) {
        return notFound(t);
      }
      let form: PreferenceForm;
      try {
        form = await readPreferences(context.request);
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidData"));
      }
      const blocklist = deps.settings().allowBlocklist && form.blocklist;
      // D126 (r1): only a marketing send may blocklist; a transactional send's page cannot.
      if (blocklist && !target(sendUuid, subUuid)) {
        return notFound(t);
      }
      if (form.manage && !blocklist) {
        return (
          savePreferences(
            { db: deps.db, subscribers: deps.subscribers, effects },
            t,
            options(),
            form,
            () => pairedSend(sendUuid, subUuid)?.subscriber ?? null,
          ) ?? notFound(t)
        );
      }
      const outcome = writeTransaction(deps.db, () => {
        // Re-read inside the write so a concurrent identity change cannot be unsubscribed.
        const found = pairedSend(sendUuid, subUuid);
        if (!found) {
          return null;
        }
        if (!found.marketing) {
          // A transactional send's form ends pending opt-ins only: the unconfirmed memberships of double
          // opt-in lists. An unconfirmed single opt-in membership is active, so this form never ends it (B126, D123 item 8).
          const changed = deps.subscribers.unsubscribeDoubleOptinPending(found.subscriber.id);
          for (const list of changed) {
            effects.unsubscribed({
              subscriberId: found.subscriber.id,
              listId: list,
              listIds: [list],
              blocklisted: false,
            });
          }
          return changed.length
            ? ({ kind: "cancelled", count: changed.length } as const)
            : ("unchanged" as const);
        }
        const listIds = deps.subscribers.unsubscribe(found.subscriber.id, found.list, blocklist);
        effects.unsubscribed({
          subscriberId: found.subscriber.id,
          listId: found.list,
          listIds,
          blocklisted: blocklist,
        });
        return "unsubscribed" as const;
      });
      if (!outcome) {
        return notFound(t);
      }
      // B126 (D123): nothing was pending, so the answer is the page the link shows now (already or confirmed).
      if (outcome === "unchanged") {
        const found = pairedSend(sendUuid, subUuid);
        if (!found) {
          return notFound(t);
        }
        return subscriptionPage(t, deps.subscribers, found.subscriber, options(), false, noIndex, {
          kind: "transactional",
          base: `/m/${sendUuid.toLowerCase()}`,
        });
      }
      if (typeof outcome === "object") {
        return publicMessage(t, {
          status: 200,
          title: t.T("globals.messages.done"),
          message: t.T(
            outcome.count > 1 ? "public.pendingCancelledMany" : "public.pendingCancelled",
          ),
          site: options(),
        });
      }
      return publicMessage(t, {
        status: 200,
        title: t.T("globals.terms.unsubscribed"),
        message: t.T("public.unsubbedInfo"),
        site: options(),
      });
    },
    ...limit,
  );

  // B123 (D126): the manage page's privacy forms. Only a subscriber this send paired is answered. Export
  // reaches a transactional send's pairing too, as its page offers it (B126, D123 item 8). Wipe does not:
  // a transactional send can carry Cc and Bcc copies, so only a marketing send's pairing may delete.
  const paired = (context: RequestContext) =>
    pairedSend(
      must(context.params.sendUUID, "send UUID"),
      must(context.params.subUUID, "subscriber UUID"),
    )?.subscriber ?? null;
  const pairedMarketing = (context: RequestContext) =>
    target(
      must(context.params.sendUUID, "send UUID"),
      must(context.params.subUUID, "subscriber UUID"),
    )?.subscriber ?? null;
  router.route(
    "POST",
    "/m/:sendUUID/export/:subUUID",
    (context) => {
      const bad = invalidUUID(context, "sendUUID", "subUUID");
      if (bad) {
        return bad;
      }
      return deps.privacy.export(context, () => paired(context)) ?? notFound(context.app.i18n);
    },
    ...privacyLimit,
  );
  router.route(
    "POST",
    "/m/:sendUUID/wipe/:subUUID",
    (context) => {
      const bad = invalidUUID(context, "sendUUID", "subUUID");
      if (bad) {
        return bad;
      }
      // B126 (D123): the confirmation's "Keep my data" returns to the page this send shows, with the manage
      // view only when preferences are on (the view is the only thing ?manage=true asks for).
      const manage = `/m/${must(context.params.sendUUID, "send UUID").toLowerCase()}/unsubscribe/${must(context.params.subUUID, "subscriber UUID").toLowerCase()}${options().allowPreferences ? "?manage=true" : ""}`;
      return (
        deps.privacy.wipe(context, () => pairedMarketing(context), manage) ??
        notFound(context.app.i18n)
      );
    },
    ...privacyLimit,
  );

  router.route("GET", "/m/:sendUUID/px.png", (context) => {
    const bad = invalidUUID(context, "sendUUID");
    if (bad) {
      return bad;
    }
    const settings = deps.settings();
    if (!settings.disableTracking) {
      const send = deps.sends.byUuid(must(context.params.sendUUID, "send UUID").toLowerCase());
      if (send) {
        try {
          deps.tracking.view(send.id, settings.individualTracking ? send.subscriber_id : null);
        } catch (error) {
          // listmonk always answers with the pixel and logs a registration failure.
          context.app.logger.error(error);
        }
      }
    }
    return new Response(Uint8Array.from(pixel), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache",
        ...noIndex,
      },
    });
  });

  router.route("GET", "/m/:sendUUID/link/:linkUUID", (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "sendUUID", "linkUUID");
    if (bad) {
      return bad;
    }
    const sendUuid = must(context.params.sendUUID, "send UUID").toLowerCase();
    const linkUuid = must(context.params.linkUUID, "link UUID").toLowerCase();
    const send = deps.sends.byUuid(sendUuid);
    const link = send ? deps.tracking.get(linkUuid) : null;
    // No open redirect: the link must have been rendered into this send's message.
    if (!send || !link || !deps.sends.bodyIncludes(send.id, linkPath(sendUuid, linkUuid))) {
      return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidLink"), noIndex);
    }
    const settings = deps.settings();
    if (!settings.disableTracking) {
      deps.tracking.click(
        send.id,
        link.id,
        settings.individualTracking ? send.subscriber_id : null,
      );
    }
    return new Response(null, {
      status: 307,
      headers: { Location: link.url, ...noIndex },
    });
  });
}
