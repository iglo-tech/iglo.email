// Unsubscribe URL, List-Unsubscribe headers and tracking for one send, adapted from
// listmonk internal/manager/manager.go (TemplateFuncs, trackLink, message headers) and
// cmd/init.go URL formats at 6fcd95f. Sends use /m/:sendUUID URLs (07-api-and-ui.md).
import type { SendKind } from "@/messaging/sends";
import type { RenderTracking } from "@/templates/renderer";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";

export interface PreparedLinks {
  /** `unsubscribe_url` for a send to a subscriber, marketing or transactional (D126, r1); null otherwise. */
  unsubscribeUrl: string | null;
  /** RFC 8058 headers when `privacy.unsubscribe_header` is on. */
  headers: Record<string, string>;
  tracking: RenderTracking | undefined;
}
export const unsubscribePath = (sendUuid: string, subscriberUuid: string) =>
  `/m/${sendUuid}/unsubscribe/${subscriberUuid}`;
export const linkPath = (sendUuid: string, linkUuid: string) => `/m/${sendUuid}/link/${linkUuid}`;

/** One producer request: a settings snapshot and a shared link registration cache. */
export function messageLinks(settings: MarketingSettings, tracking: Tracking) {
  const root = settings.rootUrl.replace(/\/+$/, "");
  const links = new Map<string, string | null>();
  return (send: { uuid: string; kind: SendKind; subscriberUuid: string | null }): PreparedLinks => {
    // D126 (r1): a transactional send's links pair it through its own journal row, as a marketing send's do.
    const unsubscribeUrl = send.subscriberUuid
      ? `${root}${unsubscribePath(send.uuid, send.subscriberUuid)}`
      : null;
    // The RFC 8058 one-click headers are for marketing mail only.
    const headers: Record<string, string> =
      send.kind === "marketing" && unsubscribeUrl && settings.unsubscribeHeader
        ? {
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
          }
        : {};
    return {
      unsubscribeUrl,
      headers,
      tracking: settings.disableTracking
        ? undefined
        : {
            view: `${root}/m/${send.uuid}/px.png`,
            link(url) {
              let uuid = links.get(url);
              if (uuid === undefined) {
                uuid = tracking.link(url);
                links.set(url, uuid);
              }
              return uuid ? `${root}${linkPath(send.uuid, uuid)}` : url;
            },
          },
    };
  };
}
