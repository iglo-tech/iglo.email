// Request-local context is separated from the app dependencies in cmd/main.go.
import type { App } from "@/app";
import type { Identity } from "@/users/models";

export interface RequestContext {
  readonly app: App;
  readonly request: Request;
  readonly url: URL;
  // Preserve the default Go/Echo path spelling, without extra parameter unescaping.
  readonly params: Readonly<Record<string, string>>;
  readonly peerAddress: string;
  identity?: Identity;
  id?: number | bigint;
}

export type Handler = (context: RequestContext) => Response | Promise<Response>;
export type Middleware = (
  context: RequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;
