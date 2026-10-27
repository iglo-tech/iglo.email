// Routing and middleware boundaries are adapted from listmonk's cmd/handlers.go.
import type { App } from "@/app";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { errorResponse, HttpError } from "@/server/response";

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
      try {
        params[segment.name] = decodeURIComponent(part);
      } catch {
        return undefined;
      }
    }
  }
  return params;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly middleware: Middleware[] = [];

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

  async handle(app: App, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname === "/" ? [] : url.pathname.slice(1).split("/");
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
    const context: RequestContext = { app, request, url, params };
    const fallback: Handler = () => {
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "404 unknown endpoint");
      // Rendering the upstream HTML 404 page is deferred to the public-page task.
      if (request.method === "HEAD")
        return new Response(null, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      return new Response("Not Found", { status: 404 });
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
