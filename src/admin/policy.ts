// The Content-Security-Policy of admin pages (D71). Not ported: listmonk sets none.
import type { Middleware } from "@/server/context";

/** The settings the policy reads. */
export interface PolicySite {
  readonly rootUrl: string;
  readonly faviconUrl: string;
  /** The brand font is a Google Fonts family (B129, D127): the sign-in pages may load its stylesheet. */
  readonly googleFonts?: boolean;
}

// Hostnames may hold `;` and `,`, which would end a directive, so only plain ones are named.
const plainOrigin = /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/;

/** The Google Fonts stylesheet and file hosts, named only for a brand font from that service (B129). */
const googleStyles = "https://fonts.googleapis.com";
const googleFiles = "https://fonts.gstatic.com";

function origin(value: string): string | undefined {
  const parsed = URL.parse(value)?.origin;
  return parsed && plainOrigin.test(parsed) ? parsed : undefined;
}

/**
 * `origins` are operator settings an image may come from: media URLs start with the root URL, which
 * need not be the address the admin is reached at, and the favicon can be anywhere.
 */
export function adminPolicy(options: {
  origins: ReadonlyArray<string>;
  remoteImages?: boolean;
  googleFonts?: boolean;
}): string {
  const named = options.origins.map(origin).filter((value) => value !== undefined);
  const images = options.remoteImages ? ["http:", "https:"] : [...new Set(named)];
  // Only a brand font set to a Google family adds the two font hosts (B129, D127).
  const styles = ["'self'", "'unsafe-inline'", ...(options.googleFonts ? [googleStyles] : [])];
  const fonts = ["'self'", ...(options.googleFonts ? [googleFiles] : [])];
  return [
    "default-src 'none'",
    "script-src 'self'",
    // A body keeps its style attributes in the editor, and a preview written to an srcdoc inherits
    // this policy, so its <style> needs this as well. No authored <style> reaches this page (D66).
    `style-src ${styles.join(" ")}`,
    `img-src ${["'self'", "data:", "blob:", ...images].join(" ")}`,
    `font-src ${fonts.join(" ")}`,
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * The admin pages that render the public shell, so the only ones that load the brand font (B129,
 * D127, review N6). Every other admin page keeps the policy without the Google hosts.
 */
const signInPaths = new Set([
  "/admin/login",
  "/admin/login/twofa",
  "/admin/forgot",
  "/admin/reset",
]);

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
      const { rootUrl, faviconUrl, googleFonts } = site();
      response.headers.set(
        "Content-Security-Policy",
        adminPolicy({
          origins: [rootUrl, faviconUrl],
          googleFonts: googleFonts === true && signInPaths.has(pathname),
        }),
      );
    }
    return response;
  };
}
