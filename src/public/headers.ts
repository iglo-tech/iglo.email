// Hardening headers of personal public pages (B125). Upstream sends none. One middleware on the
// router, not one call per route, so a route added under these paths cannot miss them: every HTML
// answer under /m/, /subscription/ and /campaign/ gets them, the 404, 429 and error answers included,
// except the signup form, which is frameable (see `frameable`).
// Campaign and archive pages keep the Content-Security-Policy they set; frame-ancestors joins it.
import type { Middleware, RequestContext } from "@/server/context";
import { errorResponse, HttpError } from "@/server/response";

const personalPaths = ["/m/", "/subscription/", "/campaign/"];
/**
 * The signup form shows no subscriber data, and embedding it is legitimate (B125 revision, D122):
 * its answers keep the caching and referrer headers, and no frame headers.
 */
const frameable = new Set(["/subscription/form"]);
const frameAncestors = /(^|;)\s*frame-ancestors\s/i;

/** The router's error answer, here so a thrown error keeps these headers (as publicCors does). */
function failure(context: RequestContext, error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error, context.request.method);
  context.app.logger.error(error);
  return errorResponse(new HttpError(500), context.request.method);
}

export const personalPageHeaders: Middleware = async (context, next) => {
  const response = await next().catch((error: unknown) => failure(context, error));
  const { pathname } = context.url;
  if (!personalPaths.some((prefix) => pathname.startsWith(prefix))) return response;
  if (!response.headers.get("Content-Type")?.startsWith("text/html")) return response;
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (frameable.has(pathname)) return response;
  response.headers.set("X-Frame-Options", "DENY");
  const policy = response.headers.get("Content-Security-Policy");
  if (!policy) response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  else if (!frameAncestors.test(policy))
    response.headers.set("Content-Security-Policy", `${policy}; frame-ancestors 'none'`);
  return response;
};
