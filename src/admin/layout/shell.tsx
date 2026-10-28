// Adapted from listmonk static/admin/views/base.html and partials/sidebar.html at 6fcd95f.
import type { Translation } from "@/i18n/i18n";
import { raw, render, type Child } from "@/jsx/render";

type JSONValue =
  | string
  | number
  | boolean
  | null
  | readonly JSONValue[]
  | { readonly [name: string]: JSONValue };
export interface NavigationLink {
  readonly label: string;
  readonly href: string;
}
export interface AdminShellProps {
  readonly title: string;
  readonly siteName: string;
  readonly assetVersion: string;
  readonly i18n: Translation;
  readonly translationKeys?: readonly string[];
  readonly config: Readonly<Record<string, JSONValue>>;
  readonly navigation?: readonly NavigationLink[];
  readonly profile?: { readonly name: string };
  readonly children?: Child;
}

function scriptJSON(value: JSONValue): string {
  const seen = new Set<object>();
  function validate(item: JSONValue): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || seen.has(item)) throw new TypeError("Invalid bootstrap JSON");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("Invalid bootstrap JSON");
    seen.add(item);
    for (const child of Object.values(item)) validate(child);
    seen.delete(item);
  }
  validate(value);
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function localLink(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    [...value].some(
      (character) =>
        character === "\\" || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    throw new TypeError("Navigation must use a local URL");
  return value;
}
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.style.colorScheme=t;}catch(e){}})();`;

function AdminShell(props: AdminShellProps) {
  const { title, siteName, assetVersion, i18n, config, navigation, profile, children } = props;
  if (!/^[a-f0-9]{10}$/.test(assetVersion)) throw new TypeError("Invalid asset version");
  const keys = new Set([
    "globals.buttons.ok",
    "globals.buttons.cancel",
    "globals.messages.confirm",
    ...(props.translationKeys ?? []),
  ]);
  const translations = Object.fromEntries([...keys].map((key) => [key, i18n.T(key)]));
  const bootstrap = `window._LM_I18N=${scriptJSON(translations)};window._LM_CONFIG=${scriptJSON(config)};`;
  const base = `/admin/static`;
  return (
    <html>
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <title>
          {title} - {siteName}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <script>{raw(themeScript)}</script>
        <link
          rel="preload"
          href={`${base}/fonts/Geist-Variable.woff2`}
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link href={`${base}/oat.min.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
        <link href={`${base}/style.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
        <link href={`${base}/favicon.png?v=${assetVersion}`} rel="icon" type="image/png" />
        <script>{raw(bootstrap)}</script>
      </head>
      <body x-data="adminApp">
        <div id="app" data-sidebar-layout="">
          <aside data-sidebar="">
            <header class="sidebar-branding">
              <img src={`${base}/logo.svg?v=${assetVersion}`} alt={siteName} />
            </header>
            {navigation && (
              <nav>
                {navigation.map((item) => (
                  <a href={localLink(item.href)}>{item.label}</a>
                ))}
              </nav>
            )}
            <footer id="footer"></footer>
          </aside>
          <main>
            <header class="main-bar">
              <div class="mobile-branding">
                <button
                  data-sidebar-toggle=""
                  type="button"
                  aria-label="Toggle sidebar menu"
                  class="small"
                >
                  ☰
                </button>
                <img src={`${base}/favicon.png?v=${assetVersion}`} alt={siteName} />
              </div>
              {profile && (
                <ot-dropdown>
                  <button
                    popovertarget="user-menu"
                    type="button"
                    class="user-nav-button ghost small user-trigger"
                  >
                    <span class="avatar">
                      <span class="avatar-label user-label">{profile.name}</span>
                    </span>
                  </button>
                  <menu popover="" id="user-menu">
                    <div class="theme-switch" role="group" aria-label="Theme">
                      {(["auto", "light", "dark"] as const).map((mode) => (
                        <button
                          type="button"
                          class="ghost small"
                          title={mode}
                          {...{
                            "@click": `setTheme('${mode}')`,
                            ":aria-pressed": `theme === '${mode}'`,
                          }}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </menu>
                </ot-dropdown>
              )}
            </header>
            <div class="container">{children}</div>
          </main>
        </div>
        <template id="confirm-dialog-template">
          <dialog class="confirm-dialog">
            <div class="dialog-card content">
              <section class="dialog-body">
                <div data-field="">
                  <p data-confirm-message=""></p>
                </div>
              </section>
              <footer class="dialog-foot align-right">
                <button type="button" autofocus data-variant="primary" data-confirm-ok="">
                  {i18n.T("globals.buttons.ok")}
                </button>
                <button type="button" class="outline" data-confirm-cancel="">
                  {i18n.T("globals.buttons.cancel")}
                </button>
              </footer>
            </div>
          </dialog>
        </template>
        <script type="module" src={`${base}/js/main.js?v=${assetVersion}`} defer></script>
      </body>
    </html>
  );
}
export function renderAdminShell(props: AdminShellProps): string {
  return `<!DOCTYPE html>${render(<AdminShell {...props} />)}`;
}
