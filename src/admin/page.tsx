// Adapted from listmonk cmd/views.go (adminView, adminPage, renderAdminError) and
// static/admin/views/message.html at 6fcd95f. A view is one function from a checked request to
// a page; see src/admin/routes.ts for how one is added.
import { STATUS_CODES } from "node:http";
import { renderAdminShell } from "@/admin/layout/shell";
import { sidebar } from "@/admin/layout/sidebar";
import { render, type Child } from "@/jsx/render";
import type { Roles } from "@/roles/roles";
import { assetVersion } from "@/server/asset-manifest";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { Authentication } from "@/users/auth";
import type { Identity } from "@/users/models";

type ConfigValue = string | number | boolean | null;

/** The settings every admin page reads for each request. */
export interface AdminSite {
  readonly siteName: string;
  readonly faviconUrl: string;
  readonly rootUrl: string;
  readonly lang: string;
  readonly cacheSlowQueries: boolean;
}
export interface AdminPage {
  readonly title: string;
  /** Selects the sidebar entry: `dashboard`, or `<group>.<entry>` as upstream. */
  readonly pageId: string;
  readonly body: Child;
  readonly status?: number;
  /** Module under assets/admin/js/views, without its extension. */
  readonly script?: string;
  /** Keys that module reads through `i18n.t`. */
  readonly translationKeys?: readonly string[];
  /** Added to `window._LM_CONFIG` for that module. */
  readonly config?: Readonly<Record<string, ConfigValue>>;
}
export interface AdminRequest {
  readonly context: RequestContext;
  readonly identity: Identity;
  readonly site: AdminSite;
  /** True for any of the permissions; a trailing `*` matches a prefix, as upstream's `Can`. */
  can(...permissions: string[]): boolean;
  /** The lists this user holds a list permission on. */
  listScope(permission: "list:get" | "list:manage"): { all: boolean; ids: bigint[] };
}
export type AdminView = (request: AdminRequest) => AdminPage | Promise<AdminPage>;

const htmlHeaders = { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" };

function adminMessage(status: number, title: string, description: string, home: string): Response {
  const base = "/admin/static";
  const body = render(
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="color-scheme" content="light dark" />
        <link href={`${base}/oat.min.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
        <link href={`${base}/style.css?v=${assetVersion}`} rel="stylesheet" type="text/css" />
      </head>
      <body>
        <main class="container mt-8">
          <div class="row">
            <article class="card col-6 offset-3">
              <header>
                <h1>{title}</h1>
              </header>
              <div>{description}</div>
              <footer class="mt-6">
                <a class="button" href="/admin">
                  ← {home}
                </a>
              </footer>
            </article>
          </div>
        </main>
      </body>
    </html>,
  );
  return new Response(`<!DOCTYPE html>${body}`, { status, headers: htmlHeaders });
}

export function createAdminPages(deps: {
  auth: Authentication;
  roles: Roles;
  site: () => AdminSite;
}) {
  const { auth, roles, site } = deps;
  const has = (identity: Identity, permissions: string[]) =>
    permissions.some((permission) =>
      permission.endsWith("*")
        ? identity.role.id === 1n ||
          identity.role.permissions.some((held) => held.startsWith(permission.slice(0, -1)))
        : roles.can(identity.role, permission),
    );
  /** renderAdminError. */
  const failure = (context: RequestContext, error: unknown): Response => {
    const known = error instanceof HttpError;
    if (!known) context.app.logger.error(error);
    const status = known ? error.status : 500;
    if (context.request.method === "HEAD") return new Response(null, { status });
    const message = (known && error.message) || STATUS_CODES[status] || "";
    const home = context.app.i18n.T("globals.terms.dashboard");
    return adminMessage(status, "Error", message, home);
  };
  /**
   * adminPage: the session check, then the optional permission check (any one of them), then the
   * view. A page request without a session goes to login and comes back afterwards.
   */
  const adminPage =
    (view: AdminView, ...permissions: string[]): Handler =>
    async (context) => {
      const started = performance.now();
      let identity: Identity;
      try {
        identity = auth.authorize(context);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        const next = new URLSearchParams({ next: context.url.pathname + context.url.search });
        return new Response(null, {
          status: 307,
          headers: { Location: `/admin/login?${next}`, "Cache-Control": "no-store" },
        });
      }
      context.identity = identity;
      const i18n = context.app.i18n;
      try {
        if (permissions.length && !has(identity, permissions))
          throw new HttpError(
            403,
            i18n.Ts("globals.messages.permissionDenied", "name", permissions.join(", ")),
          );
        const can = (...wanted: string[]) => has(identity, wanted);
        const current = site();
        const listScope: AdminRequest["listScope"] = (permission) =>
          roles.listScope(identity.role, identity.user.list_role_id, permission);
        const page = await view({ context, identity, site: current, can, listScope });
        const html = renderAdminShell({
          title: page.title,
          siteName: current.siteName,
          assetVersion,
          i18n,
          ...(page.translationKeys ? { translationKeys: page.translationKeys } : {}),
          config: { root_url: current.rootUrl, lang: current.lang, ...page.config },
          navigation: sidebar(page.pageId, i18n, can, context.app.clock.now()),
          profile: { name: identity.user.username },
          ...(current.faviconUrl ? { faviconUrl: current.faviconUrl } : {}),
          ...(page.script ? { script: page.script } : {}),
          duration: `${Math.round(performance.now() - started)}ms`,
          children: page.body,
        });
        return new Response(html, { status: page.status ?? 200, headers: htmlHeaders });
      } catch (error) {
        return failure(context, error);
      }
    };
  return { adminPage };
}
