// Campaign unsubscribe page, one-click unsubscribe, view pixel and tracked-link redirect,
// adapted from listmonk cmd/public.go (SubscriptionPage, SubscriptionPrefs, LinkRedirect,
// RegisterCampaignView), cmd/handlers.go (hasUUID, hasSub, noIndex) and
// queries/subscribers.sql (unsubscribe-by-campaign) at 6fcd95f. Preferences management
// (manage=true), view in browser and the archive are later public pages (M2.5).
import type { Database } from "bun:sqlite";
import { deflateSync, crc32 } from "node:zlib";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import { PublicShell } from "@/public/layout";
import { publicMessage } from "@/public/message";
import type { RequestContext } from "@/server/context";
import { assetVersion } from "@/server/asset-manifest";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";
import type { Tracking } from "@/unsubscribe/tracking";
import { readBodyBytes } from "@/users/input";
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
/** Go strconv.ParseBool, with Echo's empty-value-is-false form binding. */
function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (value === true) return true;
  if (typeof value !== "string") return undefined;
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false;
  return undefined;
}
/** Bounded form: browsers and RFC 8058 senders post url-encoded or multipart forms. */
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
        return value === null ? undefined : typeof value === "string" ? value : 0;
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

export function registerCampaignPublicRoutes(
  router: Router,
  deps: {
    db: Database;
    store: CampaignStore;
    subscribers: SubscriberStore;
    tracking: Tracking;
    settings: () => PublicCampaignSettings;
    effects: UnsubscribeEffects;
  },
) {
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
    const settings = deps.settings();
    const body = render(
      <PublicShell
        title={t.T("public.unsubscribeTitle")}
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
  router.route("POST", "/subscription/:campUUID/:subUUID", async (context) => {
    const t = context.app.i18n;
    const bad = invalidUUID(context, "campUUID", "subUUID");
    if (bad) return bad;
    if (!subscriber(context)) return noSubscriber(t);
    let form: { blocklist: boolean; manage: boolean };
    try {
      form = await readForm(context.request);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return page(t, 400, t.T("globals.terms.error"), t.T("globals.messages.invalidData"));
    }
    const blocklist = deps.settings().allowBlocklist && form.blocklist;
    if (form.manage && !blocklist)
      return page(t, 400, t.T("globals.terms.error"), t.T("public.invalidFeature"));
    writeTransaction(deps.db, () => {
      // Re-read inside the write: unsubscribe from the campaign's lists, or blocklist.
      const sub = subscriber(context);
      if (!sub) return;
      const campaign = deps.store.byUuid(context.params.campUUID!.toLowerCase());
      const lists = campaign && campaign.uuid !== dummyUUID ? deps.store.listIds(campaign.id) : [];
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
  });

  router.route("GET", "/campaign/:campUUID/:subUUID/px.png", (context) => {
    const bad = invalidUUID(context, "campUUID", "subUUID");
    if (bad) return bad;
    const settings = deps.settings();
    const campUuid = context.params.campUUID!.toLowerCase();
    const subUuid = context.params.subUUID!.toLowerCase();
    // Preview hits use the dummy UUID and are never recorded.
    if (!settings.disableTracking && campUuid !== dummyUUID && subUuid !== dummyUUID) {
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
