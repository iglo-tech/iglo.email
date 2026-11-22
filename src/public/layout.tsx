// Adapted from listmonk static/public/templates/index.html at 6fcd95f. B126 (D123): the shell
// carries no product credit, and its logo links to the operator's own site when one is set. B129
// (D127): the brand (accent, font, header) is set on the document element as custom properties.
import type { Child } from "@/jsx/render";
import {
  defaultAccent,
  focusColour,
  fontStack,
  googleFontUrl,
  headerMode,
  onAccentText,
} from "@/public/brand";
import type { BrandHeader } from "@/public/brand";

/** The site settings the shell links to. */
export interface ShellSite {
  readonly rootUrl: string;
  readonly logoUrl: string;
  readonly faviconUrl: string;
  readonly subscriptionPage: boolean;
  readonly archive: boolean;
  /** The operator's own site (`app.site_url`, B126), or empty. */
  readonly siteUrl: string;
  /** The brand (B129): the accent colour (hex, or empty for the built-in blue), the font and the header. */
  readonly accent: string;
  readonly font: string;
  readonly header: BrandHeader;
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
  if (site.siteUrl) {
    return site.siteUrl;
  }
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
  if (!/^[a-f0-9]{10}$/.test(assetVersion)) {
    throw new TypeError("Invalid asset version");
  }
  const siteName = site.siteName;
  // The brand values are validated when saved (D127), so they go into the style attribute as they are.
  const accent = site.accent || defaultAccent;
  const fontUrl = googleFontUrl(site.font);
  const mode = headerMode(site.header, site.logoUrl !== "");
  // A logo is shown only when one is set (headerMode), so no bundled image ever stands in for it. The
  // name beside a logo says it already, so the image has no alt text then (B129 review, N2).
  const brand = (
    <>
      {mode !== "name" ? (
        <img src={site.logoUrl} alt={mode === "logo_and_name" ? "" : siteName} />
      ) : null}
      {mode !== "logo" ? <span class="site-name">{siteName}</span> : null}
    </>
  );
  const href = logoHref(site);
  return (
    <html
      class={site.accent ? "branded" : undefined}
      style={`--brand-accent: ${accent}; --brand-focus: ${focusColour(site.accent)}; --brand-on-accent: ${onAccentText(site.accent)}; --brand-font: ${fontStack(site.font)};`}
    >
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
        {fontUrl ? <link rel="stylesheet" href={fontUrl} /> : null}
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
            <div class="logo">{href ? <a href={href}>{brand}</a> : brand}</div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
