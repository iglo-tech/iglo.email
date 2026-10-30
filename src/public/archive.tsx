// View in browser and the public archive, adapted from listmonk cmd/public.go
// (ViewCampaignMessage), cmd/archive.go, gorilla/feeds RSS output and
// static/public/templates/archive.html at 6fcd95f. Pages render without tracking, so a GET
// changes nothing; archive pages use only the campaign's sample subscriber.
import { archiveSubscriber, compileCampaign, type CampaignSubscriber } from "@/campaigns/render";
import { writable } from "@/campaigns/routes";
import type { CampaignRow, CampaignStore } from "@/campaigns/store";
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import { PublicShell } from "@/public/layout";
import { publicMessage, publicNotFound } from "@/public/message";
import { noIndex, uuidPattern } from "@/public/routes";
import type { PublicSettings } from "@/public/settings";
import { assetVersion } from "@/server/asset-manifest";
import type { RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import type { SubscriberStore } from "@/subscribers/store";
import { RenderCapacityError, type TemplateRenderer } from "@/templates/renderer";
import type { TemplateStore } from "@/templates/store";

/** Campaign HTML runs without scripts on the public origin. */
const pageHeaders = {
  "Content-Type": "text/html; charset=UTF-8",
  "Content-Security-Policy":
    "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
};
const defaultPerPage = 20;
const maxPerPage = 50;
const number = (value: string | null) => {
  const parsed = /^[+-]?\d+$/.test(value ?? "") ? Number(value) : 0;
  return Number.isSafeInteger(parsed) ? parsed : 0;
};
/** The paginator's bounds, without per_page=all: an anonymous page renders at most 50. */
function pagination(url: URL) {
  const page = Math.max(number(url.searchParams.get("page")), 1);
  let perPage = number(url.searchParams.get("per_page"));
  if (perPage < 1) perPage = defaultPerPage;
  perPage = Math.min(perPage, maxPerPage);
  return { page, perPage, offset: Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER) };
}
const xml = (value: string) =>
  value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]/gu, "")
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cdata = (value: string) =>
  `<![CDATA[${value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]/gu, "")
    .replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
const rssDate = (value: string) => {
  const [day, date, month, year, time] = new Date(value).toUTCString().split(" ");
  return `${day} ${date} ${month} ${year} ${time} +0000`;
};

export function registerArchiveRoutes(
  router: Router,
  deps: {
    store: CampaignStore;
    subscribers: SubscriberStore;
    templates: Pick<TemplateStore, "get" | "getDefault">;
    renderer: TemplateRenderer;
    settings: () => PublicSettings;
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
      { status, title, message: text, siteName: settings.siteName, site: settings },
      headers,
    );
  };
  const notFound = (t: Translation, headers = {}) =>
    message(t, 404, t.T("globals.terms.notFound"), t.T("public.campaignNotFound"), headers);
  const fetchFailed = (t: Translation, error: unknown, headers = {}) =>
    error instanceof RenderCapacityError
      ? message(t, 429, t.T("globals.terms.error"), t.T("public.errorFetchingCampaign"), headers)
      : message(t, 500, t.T("globals.terms.error"), t.T("public.errorFetchingCampaign"), headers);
  const templateBody = (id: bigint | null) =>
    (id === null ? undefined : deps.templates.get(id)?.body) ??
    deps.templates.getDefault()?.body ??
    "";
  const renderMessage = (row: CampaignRow, templateId: bigint | null, sub: CampaignSubscriber) => {
    const root = deps.settings().rootUrl;
    return compileCampaign(deps.renderer, {
      ...writable(row),
      uuid: row.uuid,
      templateBody: templateBody(templateId),
    }).render(sub, {
      rootUrl: root,
      unsubscribeUrl: `${root}/subscription/${row.uuid}/${sub.uuid}`,
    });
  };
  const archiveMessage = (row: CampaignRow) =>
    renderMessage(row, row.archive_template_id, archiveSubscriber(JSON.parse(row.archive_meta)));
  const entries = (limit: number, offset: number, content: boolean) => {
    const { ids, total } = deps.store.archived(limit, offset);
    const root = deps.settings().rootUrl;
    const results = ids.map((id) => {
      const row = deps.store.get(id)!;
      const rendered = content || /\{[{%]/.test(row.subject) ? archiveMessage(row) : null;
      return {
        uuid: row.uuid,
        subject: rendered?.subject ?? row.subject,
        content: content ? rendered!.body : "",
        created_at: row.created_at,
        send_at: row.send_at,
        url: `${root}/archive/${encodeURIComponent(row.archive_slug ?? row.uuid)}`,
      };
    });
    return { results, total };
  };
  const enabled = () => deps.settings().archive;
  /** The upstream routes exist only with the archive enabled. */
  const hidden = (context: RequestContext) => publicNotFound(context.app.i18n, "GET");

  router.route("GET", "/campaign/:campUUID/:subUUID", (context) => {
    const t = context.app.i18n;
    const { campUUID = "", subUUID = "" } = context.params;
    if (!uuidPattern.test(campUUID) || !uuidPattern.test(subUUID))
      return message(
        t,
        400,
        t.T("globals.terms.error"),
        t.T("globals.messages.invalidUUID"),
        noIndex,
      );
    const found = deps.store.byUuid(campUUID.toLowerCase());
    const row = found && deps.store.get(found.id);
    if (!row) return notFound(t, noIndex);
    const sub = deps.subscribers.byUuid(subUUID.toLowerCase());
    if (!sub)
      return message(
        t,
        404,
        t.T("globals.terms.notFound"),
        t.T("public.errorFetchingEmail"),
        noIndex,
      );
    try {
      const { body } = renderMessage(row, row.template_id, {
        uuid: sub.uuid,
        email: sub.email,
        name: sub.name,
        attribs: JSON.parse(sub.attribs),
        external_id: sub.external_id ?? "",
      });
      return new Response(body, { headers: { ...pageHeaders, ...noIndex } });
    } catch (error) {
      context.app.logger.error(error);
      return fetchFailed(t, error, noIndex);
    }
  });

  router.route("GET", "/api/public/archive", (context) => {
    if (!enabled()) throw new HttpError(404, "404 unknown endpoint");
    const t = context.app.i18n;
    const { page, perPage, offset } = pagination(context.url);
    let found: ReturnType<typeof entries>;
    try {
      found = entries(perPage, offset, false);
    } catch (error) {
      context.app.logger.error(error);
      throw new HttpError(500, t.T("public.errorFetchingCampaign"));
    }
    const empty = !found.results.length;
    return ok({
      results: found.results,
      search: "",
      query: "",
      total: found.total,
      per_page: empty ? 0 : perPage,
      page: empty ? 0 : page,
    });
  });

  router.route("GET", "/archive.xml", (context) => {
    if (!enabled()) return hidden(context);
    const t = context.app.i18n;
    const settings = deps.settings();
    const { perPage, offset } = pagination(context.url);
    let items: string;
    try {
      items = entries(perPage, offset, settings.rssContent)
        .results.map(
          (item) => `    <item>
      <title>${xml(item.subject)}</title>
      <link>${xml(item.url)}</link>
      <description></description>
      <content:encoded>${cdata(item.content)}</content:encoded>
      <pubDate>${rssDate(item.send_at ?? item.created_at ?? "")}</pubDate>
    </item>
`,
        )
        .join("");
    } catch (error) {
      context.app.logger.error(error);
      throw new HttpError(500, t.T("public.errorFetchingCampaign"));
    }
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xml(settings.siteName)}</title>
    <link>${xml(settings.rootUrl)}</link>
    <description>${xml(t.T("public.archiveTitle"))}</description>
${items}  </channel>
</rss>`,
      { headers: { "Content-Type": "text/xml; charset=utf-8" } },
    );
  });

  router.route("GET", "/archive", (context) => {
    if (!enabled()) return hidden(context);
    const t = context.app.i18n;
    const settings = deps.settings();
    const { page, perPage, offset } = pagination(context.url);
    let found: ReturnType<typeof entries>;
    try {
      found = entries(perPage, offset, false);
    } catch (error) {
      context.app.logger.error(error);
      return fetchFailed(t, error);
    }
    const title = t.T("public.archiveTitle");
    const pages = Math.ceil(found.total / perPage);
    const first = Math.max(Math.min(page - 4, pages - 9), 1);
    const numbers = Array.from({ length: Math.min(pages - first + 1, 10) }, (_, i) => first + i);
    const body = render(
      <PublicShell
        title={title}
        description={title}
        siteName={settings.siteName}
        assetVersion={assetVersion}
        poweredBy={t.T("public.poweredBy")}
        archiveTitle={title}
        site={settings}
      >
        <section>
          <h2>{title}</h2>
          <ul class="archive">
            {found.results.map((item) => (
              <li>
                <a href={item.url}>{item.subject}</a>{" "}
                <span class="date">
                  {new Date(item.send_at ?? item.created_at ?? 0).toUTCString().slice(0, 16)}
                </span>
              </li>
            ))}
          </ul>
          {found.results.length ? null : t.T("public.archiveEmpty")}
          {settings.subscriptionPage ? (
            <div class="right">
              <a href={`${settings.rootUrl}/archive.xml`}>
                <img
                  src={`${settings.rootUrl}/public/static/rss.svg`}
                  alt="RSS"
                  class="feed"
                  width="16"
                  height="16"
                />
              </a>{" "}
              <a href={`${settings.rootUrl}/subscription/form`}>
                {t.T("globals.buttons.subscribe")}
              </a>
            </div>
          ) : null}
          {pages > 1 ? (
            <div class="pagination">
              {numbers.map((number) => (
                <a
                  class={number === page ? "pg-page pg-selected" : "pg-page"}
                  href={`?page=${number}&per_page=${perPage}`}
                >
                  {number}
                </a>
              ))}
            </div>
          ) : null}
        </section>
      </PublicShell>,
    );
    return new Response(`<!DOCTYPE html>${body}`, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  });

  router.route("GET", "/archive/latest", (context) => {
    if (!enabled()) return hidden(context);
    const t = context.app.i18n;
    try {
      const [latest] = entries(1, 0, true).results;
      if (!latest) return notFound(t);
      return new Response(latest.content, { headers: pageHeaders });
    } catch (error) {
      context.app.logger.error(error);
      return fetchFailed(t, error);
    }
  });

  router.route("GET", "/archive/:id", (context) => {
    if (!enabled()) return hidden(context);
    const t = context.app.i18n;
    const key = context.params.id!;
    const id = deps.store.archivedId(uuidPattern.test(key) ? key.toLowerCase() : key);
    const row = id === null ? null : deps.store.get(id);
    if (!row) return notFound(t);
    try {
      return new Response(archiveMessage(row).body, { headers: pageHeaders });
    } catch (error) {
      context.app.logger.error(error);
      return fetchFailed(t, error);
    }
  });
}
