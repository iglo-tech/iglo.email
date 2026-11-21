// Adapted from listmonk static/public/templates/index.html at 6fcd95f. B126 (D123): the shell
// carries no product credit, and its logo links to the operator's own site when one is set.
import type { Child } from "@/jsx/render";

/** The site settings the shell links to. */
export interface ShellSite {
  readonly rootUrl: string;
  readonly logoUrl: string;
  readonly faviconUrl: string;
  readonly subscriptionPage: boolean;
  readonly archive: boolean;
  /** The operator's own site (`app.site_url`, B126), or empty. */
  readonly siteUrl: string;
}
/**
 * What every page shows of the site: its name and the shell settings above. Public, sign-in and
 * operator pages all take one getter of this (B121), so no page renders the unbranded shell.
 */
export type PageSite = ShellSite & { readonly siteName: string };
export interface PublicShellProps {
  readonly title: string;
  readonly description?: string;
  readonly site: PageSite;
  readonly assetVersion: string;
  readonly archiveTitle?: string;
  readonly children?: Child;
}

/**
 * A line of copy with the site's name in place of `{site}` (B126). The copy is trusted text, and the
 * name is not resolved as a translation key, so a name cannot pull in other copy. A function gives
 * the name as typed: a string replacement would read its `$&`, `$$` and `$1` patterns.
 */
export function siteText(text: string, siteName: string): string {
  return text.replaceAll("{site}", () => siteName);
}

/**
 * Where the header logo links: the operator's site when one is set, else the subscription page when
 * it is on, else nowhere. An empty href is never written (B126).
 */
export function logoHref(site: ShellSite): string {
  if (site.siteUrl) return site.siteUrl;
  return site.subscriptionPage ? `${site.rootUrl}/subscription/form` : "";
}

export function PublicShell({
  title,
  description = "",
  site,
  assetVersion,
  archiveTitle,
  children,
}: PublicShellProps) {
  if (!/^[a-f0-9]{10}$/.test(assetVersion)) throw new TypeError("Invalid asset version");
  const siteName = site.siteName;
  const logo = (
    <img src={site.logoUrl || `/public/static/logo.svg?v=${assetVersion}`} alt={siteName} />
  );
  const href = logoHref(site);
  return (
    <html>
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <title>
          {title} - {siteName}
        </title>
        <meta name="description" content={description} />
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1" />
        {site.archive ? (
          <link
            rel="alternate"
            type="application/rss+xml"
            title={`${archiveTitle ?? ""} - ${siteName}`}
            href={`${site.rootUrl}/archive.xml`}
          />
        ) : null}
        <link
          href={`/public/static/style.css?v=${assetVersion}`}
          rel="stylesheet"
          type="text/css"
        />
        <link href={`/public/custom.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
        <script src={`/public/custom.js?v=${assetVersion}`} async defer></script>
        {site.faviconUrl ? (
          <link rel="icon" href={site.faviconUrl} type="image/x-icon" />
        ) : (
          <link href={`/public/static/favicon.png?v=${assetVersion}`} rel="icon" type="image/png" />
        )}
      </head>
      <body>
        <div class="container wrap">
          <header class="header">
            <div class="logo">{href ? <a href={href}>{logo}</a> : logo}</div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
