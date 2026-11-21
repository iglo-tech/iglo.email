// Adapted from listmonk static/public/templates/message.html and cmd/handlers.go at 6fcd95f.
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import { PublicShell, siteText, type PageSite } from "@/public/layout";
import { assetVersion } from "@/server/asset-manifest";

/**
 * "Back to <site name>" when the operator has set a site URL (B126, D123), else nothing. Every page
 * of the public routes shows it, so no result, error or missing page is a dead end.
 */
export function backLink(i18n: Translation, site: PageSite) {
  if (!site.siteUrl) return null;
  return (
    <p>
      <a href={site.siteUrl}>{siteText(i18n.T("public.backToSite"), site.siteName)}</a>
    </p>
  );
}

/** The public 404 with the site's branding (B121), titled "Page not found" (B126, D123). */
export function publicNotFound(i18n: Translation, method: string, site: PageSite): Response {
  if (method === "HEAD")
    return new Response(null, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  const title = i18n.T("public.pageNotFound");
  const body = render(
    <PublicShell
      title={title}
      site={site}
      assetVersion={assetVersion}
      archiveTitle={i18n.T("public.archiveTitle")}
    >
      <h2>{title}</h2>
      <div></div>
      {backLink(i18n, site)}
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

/**
 * listmonk's public `message` page (makeMsgTpl): a title heading and one message, with the back link
 * when the site URL is set.
 */
export function publicMessage(
  i18n: Translation,
  page: { status: number; title: string; message: string; site: PageSite },
  headers: Record<string, string> = {},
): Response {
  const body = render(
    <PublicShell
      title={page.title}
      site={page.site}
      assetVersion={assetVersion}
      archiveTitle={i18n.T("public.archiveTitle")}
    >
      <h2>{page.title}</h2>
      <div>{page.message}</div>
      {backLink(i18n, page.site)}
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: page.status,
    headers: { "Content-Type": "text/html; charset=UTF-8", ...headers },
  });
}
