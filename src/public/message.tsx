// Adapted from listmonk static/public/templates/message.html and cmd/handlers.go at 6fcd95f.
import type { Translation } from "@/i18n/i18n";
import { render } from "@/jsx/render";
import { PublicShell, type ShellSite } from "@/public/layout";
import { assetVersion } from "@/server/asset-manifest";

export function publicNotFound(i18n: Translation, method: string): Response {
  if (method === "HEAD")
    return new Response(null, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  const title = `404 - ${i18n.T("globals.terms.notFound")}`;
  const body = render(
    <PublicShell
      title={title}
      siteName="iglo.email"
      assetVersion={assetVersion}
      poweredBy={i18n.T("public.poweredBy")}
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
  page: { status: number; title: string; message: string; siteName: string; site?: ShellSite },
  headers: Record<string, string> = {},
): Response {
  const body = render(
    <PublicShell
      title={page.title}
      siteName={page.siteName}
      assetVersion={assetVersion}
      poweredBy={i18n.T("public.poweredBy")}
      archiveTitle={i18n.T("public.archiveTitle")}
      {...(page.site ? { site: page.site } : {})}
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
