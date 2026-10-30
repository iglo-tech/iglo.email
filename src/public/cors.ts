// Public API CORS adapted from listmonk cmd/handlers.go (initHTTPHandlers, trustedURLsToCORSOrigins)
// and Echo v5.4.0 middleware/cors.go at 6fcd95f. Upstream applies it to every route; here it
// covers only the public API (docs/design/07-api-and-ui.md).
import type { RequestContext, Middleware } from "@/server/context";
import { errorResponse, HttpError } from "@/server/response";

const scope = "/api/public/";
const allowMethods = "GET,HEAD,PUT,PATCH,POST,DELETE";
const allowHeaders = "Origin,Content-Type,Accept,Authorization";

/** trustedURLsToCORSOrigins: the unique scheme and host of each URL, and `*` if present. */
function trustedOrigins(urls: string[]): string[] {
  const origins = urls.flatMap((url) => {
    if (url === "*") return [url];
    const parts = /^(https?):\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(url);
    return parts ? [`${parts[1]!.toLowerCase()}://${parts[2]}`] : [];
  });
  return [...new Set(origins)];
}

/** The router's error answer, here so an error response keeps its CORS headers. */
function failure(context: RequestContext, error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error, context.request.method);
  context.app.logger.error(error);
  return errorResponse(new HttpError(500), context.request.method);
}

export function publicCors(settings: () => { trustedUrls: string[] }): Middleware {
  return async (context, next) => {
    if (!context.url.pathname.startsWith(scope)) return next();
    const origins = trustedOrigins(settings().trustedUrls);
    if (!origins.length) return next();
    const { headers, method } = context.request;
    const origin = headers.get("origin");
    const allowed = !origin
      ? undefined
      : origins.includes("*")
        ? "*"
        : origins.find((item) => item.toLowerCase() === origin.toLowerCase());
    if (method === "OPTIONS" && origin && headers.get("access-control-request-method"))
      return new Response(null, {
        status: 204,
        headers: allowed
          ? {
              Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
              "Access-Control-Allow-Origin": allowed,
              "Access-Control-Allow-Methods": allowMethods,
              "Access-Control-Allow-Headers": allowHeaders,
            }
          : { Vary: "Origin" },
      });
    const response = await next().catch((error: unknown) => failure(context, error));
    response.headers.append("Vary", "Origin");
    if (allowed) response.headers.set("Access-Control-Allow-Origin", allowed);
    return response;
  };
}
