// Routing and middleware boundaries are adapted from listmonk's cmd/handlers.go.
// Path selection follows Echo v5.4.0 router.go and Go 1.27.2 net/url.setPath;
// malformed path escapes follow Go's net/http/server.go transport rejection.
import type { App } from "@/app";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { errorResponse, HttpError } from "@/server/response";
import { assetResponse } from "@/server/assets";
import { publicNotFound } from "@/public/message";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type Segment = { name: string } | { literal: string };
interface Route {
  readonly method: Method;
  readonly path: string;
  readonly segments: Segment[];
  readonly handler: Handler;
  readonly middleware: Middleware[];
}

function segments(path: string): Segment[] {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
    throw new Error("Invalid route path");
  const names = new Set<string>();
  return path === "/"
    ? []
    : path
        .slice(1)
        .split("/")
        .map((part) => {
          if (part.startsWith(":")) {
            const name = part.slice(1);
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name))
              throw new Error("Invalid route parameter");
            names.add(name);
            return { name };
          }
          return { literal: part };
        });
}

function precedence(a: Route, b: Route): number {
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  for (let i = 0; i < a.segments.length; i++) {
    const left = a.segments[i]!;
    const right = b.segments[i]!;
    if ("literal" in left !== "literal" in right) return "literal" in left ? -1 : 1;
  }
  return 0;
}

function routingPath(path: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return path;
  }
  // Go retains RawPath only when the spelling differs from its default escape.
  // Echo prefers that original path and does not further unescape parameters.
  const escaped = encodeURI(decoded).replace(
    /[!'()*?#]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return escaped === path ? decoded : path;
}

function match(route: Route, parts: string[]): Record<string, string> | undefined {
  if (parts.length !== route.segments.length) return undefined;
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    const segment = route.segments[i]!;
    const part = parts[i]!;
    if ("literal" in segment) {
      if (part !== segment.literal) return undefined;
    } else {
      if (!part) return undefined;
      params[segment.name] = part;
    }
  }
  return params;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly middleware: Middleware[] = [];
  private readonly missing: { prefix: string; handler: Handler }[] = [];

  /** Echo's RouteNotFound: answers unmatched paths under a prefix, instead of the public 404. */
  notFound(prefix: string, handler: Handler): void {
    this.missing.push({ prefix, handler });
  }

  /** Every registered route, in no particular order. Read-only: the document's coverage test. */
  list(): readonly { method: string; path: string }[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  use(...middleware: Middleware[]): void {
    this.middleware.push(...middleware);
  }

  route(method: Method, path: string, handler: Handler, ...middleware: Middleware[]): void {
    const route = { method, path, segments: segments(path), handler, middleware };
    if (
      this.routes.some(
        (item) =>
          item.method === method &&
          item.segments.length === route.segments.length &&
          item.segments.every((part, i) => {
            const other = route.segments[i]!;
            return "name" in part
              ? "name" in other
              : "literal" in other && part.literal === other.literal;
          }),
      )
    )
      throw new Error(`Duplicate route: ${method} ${path}`);
    this.routes.push(route);
    this.routes.sort(precedence);
  }

  async handle(app: App, request: Request, peerAddress = "unknown"): Promise<Response> {
    const url = new URL(request.url);
    const path = routingPath(url.pathname);
    if (path === undefined)
      return new Response("400 Bad Request", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    const parts = path === "/" ? [] : path.slice(1).split("/");
    let selected: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const found = match(route, parts);
      if (found) {
        selected = route;
        params = found;
        break;
      }
    }
    const context: RequestContext = { app, request, url, params, peerAddress };
    const fallback: Handler = () => {
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "404 unknown endpoint");
      const asset = assetResponse(url.pathname, request.method);
      if (asset) return asset;
      const missing = this.missing.find(({ prefix }) => url.pathname.startsWith(prefix));
      return missing ? missing.handler(context) : publicNotFound(app.i18n, request.method);
    };
    const chain = [...this.middleware, ...(selected?.middleware ?? [])];
    const handler = selected?.handler ?? fallback;
    const dispatch = (index: number): Promise<Response> => {
      const middleware = chain[index];
      return Promise.resolve().then(() =>
        middleware ? middleware(context, () => dispatch(index + 1)) : handler(context),
      );
    };
    try {
      return await dispatch(0);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error, request.method);
      app.logger.error(error);
      return errorResponse(new HttpError(500), request.method);
    }
  }
}
