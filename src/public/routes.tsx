// Public subscriber pages and APIs, adapted from listmonk cmd/public.go, cmd/handlers.go
// (public routes, hasUUID, hasSub, noIndex, serveCustomAppearance) and
// static/public/templates (optin.html, subscription-form.html) at 6fcd95f.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import type { ListReferences } from "@/lists/references";
import { trimSpace } from "@/lists/store";
import { publicCors } from "@/public/cors";
import { parseBool, readFields, type Fields } from "@/public/form";
import { PublicShell } from "@/public/layout";
import type { SubscriberMail } from "@/public/mail";
import { publicMessage } from "@/public/message";
import type { PublicSettings } from "@/public/settings";
import { assetVersion } from "@/server/asset-manifest";
import type { Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { allowedDomain, sanitizeEmail } from "@/subscribers/email";
import type { SubscriberStore } from "@/subscribers/store";

export const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const noIndex = { "X-Robots-Tag": "noindex" };
const stdInputMaxLen = 2000;

export interface PublicLimits {
  subscribe: Middleware;
  optin: Middleware;
  /** Export and wipe: mail and deletion a subscriber UUID can trigger. */
  privacy: Middleware;
}

export function registerPublicRoutes(
  router: Router,
  deps: {
    db: Database;
    lists: ListReferences;
    subscribers: SubscriberStore;
    mail: SubscriberMail;
    settings: () => PublicSettings;
    limits: PublicLimits;
    clientAddress: (context: RequestContext) => string;
  },
) {
  const message = (
    t: Translation,
    status: number,
    title: string,
    text: string,
    headers: Record<string, string> = {},
  ) => {
    const settings = deps.settings();
    return publicMessage(
      t,
      {
        status,
        title,
        message: text,
        siteName: settings.siteName,
        site: settings,
      },
      headers,
    );
  };
  const failed = (t: Translation, status: number, text: string, headers = {}) =>
    message(t, status, t.T("globals.terms.error"), text, headers);
  const html = (t: Translation, title: string, children: unknown, headers = {}, status = 200) => {
    const settings = deps.settings();
    const body = render(
      <PublicShell
        title={title}
        siteName={settings.siteName}
        assetVersion={assetVersion}
        poweredBy={t.T("public.poweredBy")}
        archiveTitle={t.T("public.archiveTitle")}
        site={settings}
      >
        {children as never}
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      status,
      headers: { "Content-Type": "text/html; charset=UTF-8", ...headers },
    });
  };
  /** hasUUID and hasSub. */
  const subscriber = (context: RequestContext, headers: Record<string, string> = {}) => {
    const t = context.app.i18n;
    const uuid = context.params.subUUID ?? "";
    if (!uuidPattern.test(uuid))
      return failed(t, 400, t.T("globals.messages.invalidUUID"), headers);
    return (
      deps.subscribers.byUuid(uuid.toLowerCase()) ??
      message(
        t,
        404,
        t.T("globals.terms.notFound"),
        t.Ts("globals.messages.notFound", "name", t.T("globals.terms.subscriber")),
        headers,
      )
    );
  };

  /** processSubForm. Returns has_optin; the answer never depends on stored subscribers. */
  function subscribe(t: Translation, fields: Fields): boolean {
    const settings = deps.settings();
    let uuids: string[];
    try {
      uuids = fields.list("l", "list_uuids");
    } catch {
      throw new HttpError(400, t.T("globals.messages.invalidData"));
    }
    const email = fields.get("email") ?? "";
    const rawName = fields.get("name") ?? "";
    if (typeof email !== "string" || typeof rawName !== "string")
      throw new HttpError(400, t.T("globals.messages.invalidData"));
    if (!uuids.length) throw new HttpError(400, t.T("public.noListsSelected"));
    if (Buffer.byteLength(email) > 1000)
      throw new HttpError(400, t.T("globals.messages.invalidEmail"));
    const address = sanitizeEmail(email);
    if (address === undefined) throw new HttpError(400, t.T("globals.messages.invalidEmail"));
    if (!allowedDomain(address, settings.domainAllowlist, settings.domainBlocklist))
      throw new HttpError(400, t.T("subscribers.domainBlocklisted"));
    let name = trimSpace(rawName);
    if (!name) name = address.split("@")[0]!;
    else if (Buffer.byteLength(name) > stdInputMaxLen || name.includes("\0"))
      throw new HttpError(400, t.T("globals.messages.invalidName"));
    if (uuids.some((uuid) => !uuidPattern.test(uuid)))
      throw new HttpError(400, t.T("globals.messages.invalidUUID"));
    const lists = deps.lists.byUuids(uuids.map((uuid) => uuid.toLowerCase()));
    if (lists.some((list) => list.type === "private"))
      throw new HttpError(400, t.T("globals.messages.invalidUUID"));
    const row = writeTransaction(deps.db, () =>
      deps.subscribers.publicSubscribe(
        { email: address, name },
        lists.map((list) => list.id),
      ),
    );
    // Every subscriber state takes this path; the conditional mail work runs later.
    deps.mail.acceptSignup(row.id);
    return settings.sendOptin && lists.some((list) => list.optin === "double");
  }

  router.use(publicCors(deps.settings));
  router.route("GET", "/api/public/lists", () =>
    Response.json(deps.lists.publicLists().map((list) => ({ uuid: list.uuid, name: list.name }))),
  );
  // ALTCHA is not implemented (07-api-and-ui.md): the same answer as with it disabled.
  router.route("GET", "/api/public/captcha/altcha", () => {
    throw new HttpError(404, "captcha not enabled");
  });
  router.route(
    "POST",
    "/api/public/subscription",
    async (context) => {
      const t = context.app.i18n;
      if (!deps.settings().subscriptionPage) throw new HttpError(400, t.T("public.invalidFeature"));
      let fields: Fields;
      try {
        fields = await readFields(context.request);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, t.T("globals.messages.invalidData"));
      }
      return ok({ has_optin: subscribe(t, fields) });
    },
    deps.limits.subscribe,
  );

  router.route("GET", "/subscription/form", (context) => {
    const t = context.app.i18n;
    const settings = deps.settings();
    if (!settings.subscriptionPage) return failed(t, 404, t.T("public.invalidFeature"));
    const lists = deps.lists.publicLists();
    if (!lists.length) return failed(t, 500, t.T("public.noListsAvailable"));
    const title = t.T("globals.buttons.subscribe");
    return html(
      t,
      title,
      <section>
        <h2>{title}</h2>
        <form method="post" action="" class="form">
          <div>
            <p>
              <label for="email">{t.T("globals.fields.email")}</label>
              <input
                id="email"
                name="email"
                required
                type="email"
                placeholder={t.T("globals.fields.email")}
                autofocus
              />
              <input name="nonce" class="nonce" value="" />
            </p>
            <p>
              <label for="name">{t.T("public.subName")}</label>
              <input id="name" name="name" type="text" placeholder={t.T("public.subName")} />
            </p>
            <ul class="lists">
              <h2>{t.T("globals.terms.lists")}</h2>
              {lists.map((list) => (
                <li>
                  <input checked id={`l-${list.uuid}`} type="checkbox" name="l" value={list.uuid} />{" "}
                  <label for={`l-${list.uuid}`}>{list.name}</label>
                  {list.description ? <p class="description">{list.description}</p> : null}
                </li>
              ))}
            </ul>
            <p>
              <button type="submit" class="button">
                {title}
              </button>
            </p>
            {settings.archive ? (
              <p class="right">
                <a href={`${settings.rootUrl}/archive`}>{t.T("public.archiveTitle")}</a>
              </p>
            ) : null}
          </div>
        </form>
      </section>,
    );
  });

  router.route(
    "POST",
    "/subscription/form",
    async (context) => {
      const t = context.app.i18n;
      const settings = deps.settings();
      if (!settings.subscriptionPage) throw new HttpError(404, t.T("public.invalidFeature"));
      let fields: Fields;
      try {
        fields = await readFields(context.request);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        return failed(t, 400, t.T("globals.messages.invalidData"));
      }
      const value = (name: string) => {
        const found = fields.get(name) ?? context.url.searchParams.get(name) ?? "";
        return typeof found === "string" ? found : "";
      };
      // If there's a nonce value, a bot could've filled the form.
      if (value("nonce")) throw new HttpError(502, t.T("public.invalidFeature"));
      // Captcha verification is not implemented: an enabled setting fails closed.
      if (settings.captcha) return failed(t, 400, t.T("public.invalidCaptcha"));
      let hasOptin: boolean;
      try {
        hasOptin = subscribe(t, fields);
      } catch (error) {
        if (error instanceof HttpError) return failed(t, error.status, error.message);
        throw error;
      }
      const next = trimSpace(value("next"));
      if (next && next !== "*" && settings.trustedUrls.includes(next))
        return new Response(null, { status: 303, headers: { Location: next } });
      return message(
        t,
        200,
        t.T("globals.buttons.subscribe"),
        t.T(hasOptin ? "public.subOptinPending" : "public.subConfirmed"),
      );
    },
    deps.limits.subscribe,
  );

  /** OptinPage. A GET only ever shows the page; confirming takes a POST. */
  const optin = async (context: RequestContext) => {
    const t = context.app.i18n;
    const post = context.request.method === "POST";
    const headers = post ? {} : noIndex;
    const sub = subscriber(context, headers);
    if (sub instanceof Response) return sub;
    let confirm = false;
    let uuids = context.url.searchParams.getAll("l");
    if (post) {
      try {
        const fields = await readFields(context.request);
        confirm =
          parseBool(fields.get("confirm") ?? context.url.searchParams.get("confirm")) === true;
        uuids = fields.list("l", "l");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        return failed(t, 400, t.T("globals.messages.invalidData"));
      }
    }
    if (uuids.some((uuid) => !uuidPattern.test(uuid)))
      return failed(t, 400, t.T("globals.messages.invalidUUID"), headers);
    const wanted = new Set(uuids.map((uuid) => uuid.toLowerCase()));
    const lists = deps.subscribers
      .unconfirmedLists(sub.id)
      .filter((list) => !wanted.size || wanted.has(list.uuid));
    if (!lists.length)
      return message(t, 200, t.T("public.noSubTitle"), t.T("public.noSubInfo"), headers);
    const settings = deps.settings();
    if (post && (confirm || !settings.showOptinPage)) {
      const meta: Record<string, string> = settings.recordOptinIp
        ? { optin_ip: deps.clientAddress(context) }
        : {};
      writeTransaction(deps.db, () =>
        deps.subscribers.confirmOptin(
          sub.id,
          lists.map((list) => BigInt(list.id)),
          meta,
        ),
      );
      return message(t, 200, t.T("globals.terms.confirmed"), t.T("public.subConfirmed"));
    }
    return html(
      t,
      t.T("globals.buttons.confirmSubscription"),
      <section>
        <h2>{t.T("globals.buttons.confirm")}</h2>
        <p>{t.T("public.confirmSubInfo")}</p>
        <form method="post" class="optin-form">
          <ul>
            {lists.map((list) => (
              <>
                <input type="hidden" name="l" value={list.uuid} />
                <li>{list.type === "public" ? list.name : t.T("public.subPrivateList")}</li>
              </>
            ))}
          </ul>
          <p>
            <input type="hidden" name="confirm" value="true" />
            <button type="submit" class="button" id="btn-unsub">
              {t.T("globals.buttons.confirmSubscription")}
            </button>
          </p>
        </form>
      </section>,
      headers,
    );
  };
  router.route("GET", "/subscription/optin/:subUUID", optin, deps.limits.optin);
  router.route("POST", "/subscription/optin/:subUUID", optin, deps.limits.optin);

  router.route(
    "POST",
    "/subscription/export/:subUUID",
    (context) => {
      const t = context.app.i18n;
      const sub = subscriber(context);
      if (sub instanceof Response) return sub;
      if (!deps.settings().allowExport) return failed(t, 400, t.T("public.invalidFeature"));
      try {
        deps.mail.exportData(sub);
      } catch (error) {
        context.app.logger.error(error);
        return failed(t, 500, t.T("public.errorProcessingRequest"));
      }
      return message(t, 200, t.T("public.dataSentTitle"), t.T("public.dataSent"));
    },
    deps.limits.privacy,
  );

  router.route(
    "POST",
    "/subscription/wipe/:subUUID",
    (context) => {
      const t = context.app.i18n;
      const sub = subscriber(context);
      if (sub instanceof Response) return sub;
      if (!deps.settings().allowWipe) return failed(t, 400, t.T("public.invalidFeature"));
      writeTransaction(deps.db, () => deps.subscribers.remove([sub.id]));
      return message(t, 200, t.T("public.dataRemovedTitle"), t.T("public.dataRemoved"));
    },
    deps.limits.privacy,
  );

  const appearance = (type: string, value: (settings: PublicSettings) => string) => () =>
    new Response(value(deps.settings()), {
      headers: { "Content-Type": `${type}; charset=utf-8` },
    });
  router.route(
    "GET",
    "/public/custom.css",
    appearance("text/css", (s) => s.customCss),
  );
  router.route(
    "GET",
    "/public/custom.js",
    appearance("application/javascript", (s) => s.customJs),
  );
}
