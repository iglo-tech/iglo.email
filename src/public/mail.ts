// Subscriber notifications adapted from listmonk cmd/subscribers.go (makeOptinNotifyHook,
// exportSubscriberData), cmd/public.go (SelfExportSubscriberData) and
// internal/core/subscribers.go (sendOptinConfirmation) at 6fcd95f. Both mails are
// transactional outbox sends enqueued after the subscriber write commits, never SMTP calls.
import type { ErrorLogger } from "@/app";
import { dummyUUID, nameChunk } from "@/campaigns/render";
import type { CampaignStore } from "@/campaigns/store";
import type { Clock } from "@/clock";
import type { EventRow } from "@/events/store";
import type { Translation } from "@/i18n/i18n";
import type { Sends } from "@/messaging/sends";
import { safeLogo } from "@/messaging/test";
import { createThrottle } from "@/public/rate-limit";
import type { PublicSettings } from "@/public/settings";
import type { SubscriberStore } from "@/subscribers/store";
import { systemTemplates } from "@/templates/builtins";
import type { TemplateRenderer } from "@/templates/renderer";
import type { Tracking } from "@/unsubscribe/tracking";

type Subscriber = NonNullable<ReturnType<SubscriberStore["get"]>>;
/** One opt-in mail per address in this window, whichever lists are pending. */
const optinThrottleTTL = 10 * 60_000;
const optinThrottleCap = 5000;
/** Native export sections stay well inside the outbox attachment limit. */
const exportRows = 1000;
const exportEventBytes = 2 * 1024 * 1024;

export function createSubscriberMail(deps: {
  subscribers: SubscriberStore;
  sends: Sends;
  campaigns: Pick<CampaignStore, "subscriberViews">;
  tracking: Pick<Tracking, "subscriberClicks">;
  events: { list(subscriberId: bigint, limit: number): EventRow[] };
  renderer: TemplateRenderer;
  i18n: Translation;
  clock: Clock;
  logger: ErrorLogger;
  settings: () => PublicSettings;
}) {
  const t = deps.i18n;
  const throttle = createThrottle(deps.clock, optinThrottleTTL, optinThrottleCap);
  const enqueue = (
    sub: Subscriber,
    settings: PublicSettings,
    subject: string,
    html: string,
    extra: {
      headers?: Record<string, string>;
      attachments?: { name: string; content: Uint8Array; contentType: string }[];
    },
  ) =>
    deps.sends.enqueueRequest({
      sends: [
        {
          subscriberUuid: sub.uuid,
          send: {
            source: "tx",
            kind: "transactional",
            subscriberId: sub.id,
            message: {
              from: settings.fromEmail,
              to: [sub.email],
              subject,
              contentType: "html",
              body: Buffer.from(html),
              ...extra,
            },
          },
        },
      ],
    });
  /** makeOptinNotifyHook: returns the number of double opt-in lists awaiting confirmation. */
  function optin(sub: Subscriber, listIds: bigint[] = []): number {
    const wanted = new Set(listIds.map(Number));
    const lists = deps.subscribers
      .unconfirmedLists(sub.id)
      .filter((list) => list.optin === "double" && (!wanted.size || wanted.has(list.id)));
    if (!lists.length) return 0;
    const settings = deps.settings();
    const query = new URLSearchParams(lists.map((list) => ["l", list.uuid]));
    const unsubscribeUrl = `${settings.rootUrl}/subscription/${dummyUUID}/${sub.uuid}`;
    const html = deps.renderer.renderSync({
      body: systemTemplates.subscriberOptin,
      mode: "html",
      data: JSON.stringify({
        subscriber: { first_name: nameChunk(sub.name, false) },
        lists: lists.map((list) => ({ name: list.name, type: list.type })),
        optin_url: `${settings.rootUrl}/subscription/optin/${sub.uuid}?${query}`,
        manage_url: `${unsubscribeUrl}?manage=true`,
        logo_url: safeLogo(settings.logoUrl),
      }),
    }).body;
    enqueue(sub, settings, t.T("globals.buttons.confirmSubscription"), html, {
      headers: {
        "X-Listmonk-Subscriber": sub.uuid,
        ...(settings.unsubscribeHeader
          ? {
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
            }
          : {}),
      },
    });
    return lists.length;
  }
  /** Upstream ignores hook failures here: the subscriber write stays. */
  const quietly = (run: () => void) => {
    try {
      run();
    } catch (error) {
      deps.logger.error(error);
    }
  };
  return {
    optin,
    /** InsertSubscriber/UpdateSubscriberWithLists from the admin API. */
    afterAdminWrite(sub: Subscriber, listIds: bigint[]) {
      if (deps.settings().sendOptin) quietly(() => optin(sub, listIds));
    },
    /** sendOptinConfirmation for public signups: one mail per address in the window. */
    afterPublicSignup(sub: Subscriber) {
      if (!deps.settings().sendOptin) return;
      const pending = deps.subscribers
        .unconfirmedLists(sub.id)
        .filter((list) => list.optin === "double")
        .map((list) => list.id);
      if (!pending.length) return;
      if (throttle(sub.email.trim().toLowerCase())) quietly(() => optin(sub, pending.map(BigInt)));
    },
    /** SelfExportSubscriberData: the file goes to the subscriber, never into the response. */
    exportData(sub: Subscriber) {
      const settings = deps.settings();
      const allowed = new Set(settings.exportable);
      const views = allowed.has("campaign_views");
      const clicks = allowed.has("link_clicks");
      const data = {
        profile: allowed.has("profile")
          ? [
              {
                id: Number(sub.id),
                uuid: sub.uuid,
                email: sub.email,
                name: sub.name,
                attribs: JSON.parse(sub.attribs),
                status: sub.status,
                created_at: sub.created_at,
                updated_at: sub.updated_at,
              },
            ]
          : undefined,
        subscriptions: allowed.has("subscriptions")
          ? deps.subscribers.exportSubscriptions(sub.id)
          : undefined,
        campaign_views: views ? deps.campaigns.subscriberViews(sub.id) : undefined,
        link_clicks: clicks ? deps.tracking.subscriberClicks(sub.id) : undefined,
        // Native sections, with the activity they sit beside (07-api-and-ui.md).
        sends: views
          ? deps.sends
              .list({ page: 1, perPage: exportRows, subscriberId: sub.id })
              .results.map((send) => ({
                uuid: send.uuid,
                source: send.source,
                kind: send.kind,
                status: send.status,
                skip_reason: send.skip_reason,
                to_email: send.to_email,
                created_at: send.created_at,
                sent_at: send.sent_at,
              }))
          : undefined,
        events: clicks ? boundedEvents(deps.events.list(sub.id, exportRows)) : undefined,
      };
      const html = deps.renderer.renderSync({
        body: systemTemplates.subscriberData,
        mode: "html",
        data: JSON.stringify({ logo_url: safeLogo(settings.logoUrl) }),
      }).body;
      enqueue(sub, settings, t.T("email.data.title"), html, {
        attachments: [
          {
            name: "data.json",
            content: Buffer.from(JSON.stringify(data, null, 2)),
            contentType: "application/json",
          },
        ],
      });
    },
  };
}
export type SubscriberMail = ReturnType<typeof createSubscriberMail>;

function boundedEvents(rows: EventRow[]) {
  let bytes = 0;
  const out: { name: string; data: unknown; occurred_at: string }[] = [];
  for (const row of rows) {
    bytes += Buffer.byteLength(row.name) + Buffer.byteLength(row.data);
    if (bytes > exportEventBytes) break;
    out.push({ name: row.name, data: JSON.parse(row.data), occurred_at: row.occurred_at });
  }
  return out;
}
