// Adapted from listmonk static/public/templates/index.html at 6fcd95f.
import type { Child } from "@/jsx/render";

export interface PublicShellProps {
  readonly title: string;
  readonly siteName: string;
  readonly assetVersion: string;
  readonly poweredBy: string;
  readonly children?: Child;
}
export function PublicShell({
  title,
  siteName,
  assetVersion,
  poweredBy,
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
        <meta name="description" content="" />
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1" />
        <link
          href={`/public/static/style.css?v=${assetVersion}`}
          rel="stylesheet"
          type="text/css"
        />
        <link href={`/public/static/favicon.png?v=${assetVersion}`} rel="icon" type="image/png" />
      </head>
      <body>
        <div class="container wrap">
          <header class="header">
            <div class="logo">
              <img src={`/public/static/logo.svg?v=${assetVersion}`} alt={siteName} />
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
