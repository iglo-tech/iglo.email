// The Content-Security-Policy of admin pages (D71). Not ported: listmonk sets none.
import type { Middleware } from "@/server/context";

/** The settings the policy reads. */
export interface PolicySite {
  readonly rootUrl: string;
  readonly faviconUrl: string;
}

// Hostnames may hold `;` and `,`, which would end a directive, so only plain ones are named.
const plainOrigin = /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/;

function origin(value: string): string | undefined {
  const parsed = URL.parse(value)?.origin;
  return parsed && plainOrigin.test(parsed) ? parsed : undefined;
}

/**
 * `origins` are operator settings an image may come from: media URLs start with the root URL, which
 * need not be the address the admin is reached at, and the favicon can be anywhere.
 */
export function adminPolicy(options: {
  origins: readonly string[];
  remoteImages?: boolean;
}): string {
  const named = options.origins.map(origin).filter((value) => value !== undefined);
  const images = options.remoteImages ? ["http:", "https:"] : [...new Set(named)];
  return [
    "default-src 'none'",
    "script-src 'self'",
    // A body keeps its style attributes in the editor, and a preview written to an srcdoc inherits
    // this policy, so its <style> needs this as well. No authored <style> reaches this page (D66).
    "style-src 'self' 'unsafe-inline'",
    `img-src ${["'self'", "data:", "blob:", ...images].join(" ")}`,
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** One seam, so a page, error or login screen under /admin cannot leave without a policy. */
export function adminPolicyHeader(site: () => PolicySite): Middleware {
  return async (context, next) => {
    const response = await next();
    const { pathname } = context.url;
    if (
      (pathname === "/admin" || pathname.startsWith("/admin/")) &&
      response.headers.get("Content-Type")?.startsWith("text/html") &&
      !response.headers.has("Content-Security-Policy")
    ) {
      const { rootUrl, faviconUrl } = site();
      response.headers.set(
        "Content-Security-Policy",
        adminPolicy({ origins: [rootUrl, faviconUrl] }),
      );
    }
    return response;
  };
}
