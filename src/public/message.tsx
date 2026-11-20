// Adapted from listmonk static/public/templates/message.html and cmd/handlers.go at 6fcd95f.
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import { PublicShell, type PageSite } from "@/public/layout";
import { assetVersion } from "@/server/asset-manifest";

/** The public 404 with the site's branding (B121). */
export function publicNotFound(i18n: Translation, method: string, site: PageSite): Response {
  if (method === "HEAD")
    return new Response(null, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  const title = `404 - ${i18n.T("globals.terms.notFound")}`;
  const body = render(
    <PublicShell
      title={title}
      site={site}
      assetVersion={assetVersion}
      poweredBy={i18n.T("public.poweredBy")}
      archiveTitle={i18n.T("public.archiveTitle")}
    >
      <h2>{title}</h2>
      <div></div>
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

/** listmonk's public `message` page (makeMsgTpl): a title heading and one message. */
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
      poweredBy={i18n.T("public.poweredBy")}
      archiveTitle={i18n.T("public.archiveTitle")}
    >
      <h2>{page.title}</h2>
      <div>{page.message}</div>
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: page.status,
    headers: { "Content-Type": "text/html; charset=UTF-8", ...headers },
  });
}
