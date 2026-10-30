// Adapted from listmonk static/public/templates/index.html at 6fcd95f.
import type { Child } from "@/jsx/render";

/** The site settings the shell links to; pages without them show the plain header. */
export interface ShellSite {
  readonly rootUrl: string;
  readonly logoUrl: string;
  readonly faviconUrl: string;
  readonly subscriptionPage: boolean;
  readonly archive: boolean;
}
export interface PublicShellProps {
  readonly title: string;
  readonly description?: string;
  readonly site?: ShellSite;
  readonly siteName: string;
  readonly assetVersion: string;
  readonly poweredBy: string;
  readonly archiveTitle?: string;
  readonly children?: Child;
}
export function PublicShell({
  title,
  description = "",
  site,
  siteName,
  assetVersion,
  poweredBy,
  archiveTitle,
  children,
}: PublicShellProps) {
  if (!/^[a-f0-9]{10}$/.test(assetVersion)) throw new TypeError("Invalid asset version");
  return (
    <html>
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <title>
          {title} - {siteName}
        </title>
        <meta name="description" content={description} />
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1" />
        {site?.archive ? (
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
        {site ? (
          <>
            <link href={`/public/custom.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
            <script src={`/public/custom.js?v=${assetVersion}`} async defer></script>
          </>
        ) : null}
        {site?.faviconUrl ? (
          <link rel="icon" href={site.faviconUrl} type="image/x-icon" />
        ) : (
          <link href={`/public/static/favicon.png?v=${assetVersion}`} rel="icon" type="image/png" />
        )}
      </head>
      <body>
        <div class="container wrap">
          <header class="header">
            <div class="logo">
              {site ? (
                <a href={site.subscriptionPage ? `${site.rootUrl}/subscription/form` : ""}>
                  <img
                    src={site.logoUrl || `/public/static/logo.svg?v=${assetVersion}`}
                    alt={siteName}
                  />
                </a>
              ) : (
                <img src={`/public/static/logo.svg?v=${assetVersion}`} alt={siteName} />
              )}
            </div>
          </header>
          {children}
        </div>
        <footer class="container">
          {poweredBy}{" "}
          <a target="_blank" rel="noreferrer" href="https://iglo.email">
            iglo.email
          </a>
          . Based on{" "}
          <a target="_blank" rel="noreferrer" href="https://listmonk.app">
            listmonk
          </a>
          .
        </footer>
      </body>
    </html>
  );
}
