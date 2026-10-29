// Public unsubscribe page, one-click unsubscribe, view pixel and tracked-link redirect for
// sends. Adapted from listmonk cmd/public.go (SubscriptionPage, SubscriptionPrefs,
// LinkRedirect, RegisterCampaignView), cmd/handlers.go (hasUUID, hasSub, noIndex) and
// static/public/templates/subscription.html at 6fcd95f, scoped to the send's list.
import type { Database } from "bun:sqlite";
import { deflateSync, crc32 } from "node:zlib";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import type { Sends } from "@/messaging/sends";
import { PublicShell } from "@/public/layout";
import { publicMessage } from "@/public/message";
import type { RequestContext } from "@/server/context";
import { assetVersion } from "@/server/asset-manifest";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import { readBodyBytes } from "@/users/input";
import { linkPath } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";

/**
 * Effects of an unsubscribe request, called inside its write transaction on every POST,
 * including repeats. `listId` is the requested send's list; `listIds` are the memberships
 * whose status changed. M5 cancels active enrollments in sequences tied to `listId` and
 * `listIds` (exit_reason `unsubscribed`) and M2.6 queues `subscriber.unsubscribed` /
 * `subscriber.blocklisted` webhooks here.
 */
export interface UnsubscribeEffects {
  unsubscribed(event: {
    subscriberId: bigint;
    listId: bigint;
    listIds: bigint[];
    blocklisted: boolean;
  }): void;
}
const noEffects: UnsubscribeEffects = { unsubscribed() {} };

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const noIndex = { "X-Robots-Tag": "noindex" };

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

/** Go strconv.ParseBool, with Echo's empty-value-is-false form binding. */
function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === "" || value === false) return false;
  if (value === true) return true;
  if (typeof value !== "string") return undefined;
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false;
  return undefined;
}

/** Bounded form body: browsers and RFC 8058 senders post url-encoded or multipart forms. */
async function readForm(request: Request): Promise<{ blocklist: boolean; manage: boolean }> {
  const bytes = await readBodyBytes(request);
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let get: (name: string) => unknown = () => undefined;
  if (bytes.length) {
    if (media === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(bytes.toString("utf8"));
      get = (name) => form.get(name) ?? undefined;
    } else if (media === "multipart/form-data") {
      const form = await new Request("http://form.invalid", {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type")! },
        body: Uint8Array.from(bytes),
      }).formData();
      get = (name) => {
        const value = form.get(name);
        return value === null ? undefined : typeof value === "string" ? value : null;
      };
    } else if (media === "application/json") {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body");
      get = (name) => (value as Record<string, unknown>)[name];
    } else throw new Error("media");
  }
  const blocklist = parseBool(get("blocklist"));
  const manage = parseBool(get("manage"));
  if (blocklist === undefined || manage === undefined) throw new Error("bool");
  return { blocklist, manage };
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
  },
) {
  const effects = deps.effects ?? noEffects;
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
        )
      : null;
  /** The marketing send and its current subscriber, only when both UUIDs belong together. */
  const target = (sendUuid: string, subscriberUuid: string) => {
    const send = deps.sends.byUuid(sendUuid.toLowerCase());
    if (!send || send.kind !== "marketing" || send.list_id === null || send.subscriber_id === null)
      return null;
    const subscriber = deps.subscribers.get(send.subscriber_id);
    if (!subscriber || subscriber.uuid !== subscriberUuid.toLowerCase()) return null;
    return { send: { ...send, list_id: send.list_id }, subscriber };
  };
  const notFound = (i18n: Translation, headers: Record<string, string> = {}) =>
    page(i18n, 404, i18n.T("globals.terms.notFound"), i18n.T("public.errorFetchingEmail"), headers);

  router.route("GET", "/m/:sendUUID/unsubscribe/:subUUID", (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "sendUUID", "subUUID");
    if (bad) return bad;
    const found = target(context.params.sendUUID!, context.params.subUUID!);
    if (!found) return notFound(t, noIndex);
    if (found.subscriber.status === "blocklisted")
      return page(t, 200, t.T("public.noSubTitle"), t.T("public.blocklisted"), noIndex);
    const settings = deps.settings();
    const title = t.T("public.unsubscribeTitle");
    const body = render(
      <PublicShell
        title={title}
        siteName={settings.siteName}
        assetVersion={assetVersion}
        poweredBy={t.T("public.poweredBy")}
      >
        <section class="section">
          <h2>{t.T("globals.buttons.unsubscribe")}</h2>
          <form method="post" class="unsub-form">
            <div>
              <p>{t.T("public.unsubHelp")}</p>
              {settings.allowBlocklist ? (
                <>
                  <hr />
                  <p class="small">
                    <input id="privacy-blocklist" type="checkbox" name="blocklist" value="true" />{" "}
                    <label for="privacy-blocklist">{t.T("public.unsubFull")}</label>
                  </p>
                </>
              ) : null}
              <p>
                <button type="submit" class="button" id="btn-unsub">
                  {t.T("globals.buttons.unsubscribe")}
                </button>
              </p>
            </div>
          </form>
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8", ...noIndex },
    });
  });

  // RFC 8058 one-click and the page form: no login, CSRF token or CAPTCHA.
  router.route("POST", "/m/:sendUUID/unsubscribe/:subUUID", async (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "sendUUID", "subUUID");
    if (bad) return bad;
    if (!target(context.params.sendUUID!, context.params.subUUID!)) return notFound(t);
    let form: { blocklist: boolean; manage: boolean };
    try {
      form = await readForm(context.request);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidData"));
    }
    const blocklist = deps.settings().allowBlocklist && form.blocklist;
    // Preference management (manage=true) is the M2.5 preferences page.
    if (form.manage && !blocklist)
      return page(t, 400, t.T("globals.terms.error"), t.T("public.invalidFeature"));
    const done = writeTransaction(deps.db, () => {
      // Re-read inside the write so a concurrent identity change cannot be unsubscribed.
      const found = target(context.params.sendUUID!, context.params.subUUID!);
      if (!found) return false;
      const listIds = deps.subscribers.unsubscribe(
        found.subscriber.id,
        found.send.list_id,
        blocklist,
      );
      effects.unsubscribed({
        subscriberId: found.subscriber.id,
        listId: found.send.list_id,
        listIds,
        blocklisted: blocklist,
      });
      return true;
    });
    if (!done) return notFound(t);
    return page(t, 200, t.T("globals.terms.unsubscribed"), t.T("public.unsubbedInfo"));
  });

  router.route("GET", "/m/:sendUUID/px.png", (context) => {
    const bad = invalidUUID(context, "sendUUID");
    if (bad) return bad;
    const settings = deps.settings();
    if (!settings.disableTracking) {
      const send = deps.sends.byUuid(context.params.sendUUID!.toLowerCase());
      if (send)
        try {
          deps.tracking.view(send.id, settings.individualTracking ? send.subscriber_id : null);
        } catch (error) {
          // listmonk always answers with the pixel and logs a registration failure.
          context.app.logger.error(error);
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
    if (bad) return bad;
    const sendUuid = context.params.sendUUID!.toLowerCase();
    const linkUuid = context.params.linkUUID!.toLowerCase();
    const send = deps.sends.byUuid(sendUuid);
    const link = send ? deps.tracking.get(linkUuid) : null;
    // No open redirect: the link must have been rendered into this send's message.
    if (!send || !link || !deps.sends.bodyIncludes(send.id, linkPath(sendUuid, linkUuid)))
      return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidLink"), noIndex);
    const settings = deps.settings();
    if (!settings.disableTracking)
      deps.tracking.click(
        send.id,
        link.id,
        settings.individualTracking ? send.subscriber_id : null,
      );
    return new Response(null, {
      status: 307,
      headers: { Location: link.url, ...noIndex },
    });
  });
}
