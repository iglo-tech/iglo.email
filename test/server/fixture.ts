import { createApp } from "@/app";
import type { Clock } from "@/clock";
import type { Translation } from "@/i18n/i18n";
import { createTranslation } from "@/i18n/i18n";
import type { Middleware } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import { createRouter, startServer } from "@/server/server";
import { bindJSON, getID, hasID, strHasLen } from "@/server/validation";

interface Sleeper {
  due: number;
  resolve(): void;
  reject(reason: unknown): void;
  signal: AbortSignal | undefined;
  abort(): void;
}

export class TestClock implements Clock {
  private time = Date.parse("2026-01-02T03:04:05Z");
  private sleepers = new Set<Sleeper>();
  private scheduled: (() => void)[] = [];

  now(): Date {
    return new Date(this.time);
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = {
        due: this.time + milliseconds,
        resolve,
        reject,
        signal,
        abort: () => {
          this.sleepers.delete(sleeper);
          signal?.removeEventListener("abort", sleeper.abort);
          reject(signal?.reason);
        },
      };
      this.sleepers.add(sleeper);
      signal?.addEventListener("abort", sleeper.abort, { once: true });
      for (const notify of this.scheduled.splice(0)) notify();
    });
  }

  whenSleeping(count = 1): Promise<void> {
    if (this.sleepers.size >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const notify = () => {
        if (this.sleepers.size >= count) resolve();
        else this.scheduled.push(notify);
      };
      this.scheduled.push(notify);
    });
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const sleeper of this.sleepers) {
      if (sleeper.due <= this.time) {
        this.sleepers.delete(sleeper);
        sleeper.signal?.removeEventListener("abort", sleeper.abort);
        sleeper.resolve();
      }
    }
  }
}

function wrapper(name: string): Middleware {
  return async (_context, next) => {
    const response = await next();
    response.headers.set("X-Order", `${name}(${response.headers.get("X-Order") ?? "handler"})`);
    return response;
  };
}

export function startFixture(options: { clock?: Clock; i18n?: Translation } = {}) {
  const errors: unknown[] = [];
  const clock = options.clock ?? new TestClock();
  const i18n = options.i18n ?? createTranslation();
  const app = createApp({
    bootstrap: {
      host: "127.0.0.1",
      port: 0,
      dataDir: ".",
      rootUrl: "http://fixture.test",
      initialAdmin: { user: "private-admin", password: "private-password" },
    },
    clock,
    i18n,
    logger: { error: (error) => errors.push(error) },
  });
  const router = createRouter();
  router.use(wrapper("outer"), wrapper("inner"));
  router.route("GET", "/fixture/items/:item", ({ params, url }) =>
    ok({ item: params.item, query: url.searchParams.get("q") }),
  );
  router.route("GET", "/fixture/items/special", () => ok("static"));
  router.route("GET", "/fixture/middleware", () => ok("handler"), wrapper("route"));
  router.route(
    "GET",
    "/fixture/short",
    () => {
      throw new Error("unreachable");
    },
    () => ok("short"),
  );
  router.route("GET", "/fixture/handler-error", () => {
    throw new HttpError(400, "from handler");
  });
  router.route(
    "GET",
    "/fixture/middleware-error",
    () => ok("unreachable"),
    async () => {
      await Promise.resolve();
      throw new HttpError(400, "from middleware");
    },
  );
  router.route("GET", "/fixture/unexpected", async () => {
    await Promise.resolve();
    throw new Error("private detail private-password");
  });
  router.route(
    "GET",
    "/fixture/unexpected-middleware",
    () => ok("unreachable"),
    async () => {
      await Promise.resolve();
      throw new Error("middleware secret");
    },
  );
  router.route(
    "GET",
    "/fixture/id/:id",
    (context) => {
      const id = getID(context);
      return ok(typeof id === "bigint" ? id.toString() : id);
    },
    hasID,
  );
  router.route("POST", "/fixture/input", async (context) => {
    const input = await bindJSON(context.request);
    if (
      typeof input !== "object" ||
      input === null ||
      !("value" in input) ||
      typeof input.value !== "string" ||
      !strHasLen(input.value, 1, 2000)
    ) {
      throw new HttpError(400, context.app.i18n.T("globals.messages.invalidName"));
    }
    return ok(input.value);
  });
  router.route("GET", "/fixture/field/:field", ({ app, params }) => {
    throw new HttpError(400, app.i18n.Ts("globals.messages.invalidFields", "name", params.field!));
  });
  router.route("GET", "/fixture/locale", ({ app }) =>
    ok({
      code: app.i18n.code,
      name: app.i18n.name,
      message: app.i18n.T("globals.messages.invalidName"),
    }),
  );
  router.route("GET", "/fixture/escape", () => ok("<>&\u2028\u2029"));
  router.route("GET", "/fixture/translations", ({ app, url }) =>
    ok({
      name: app.i18n.name,
      code: app.i18n.code,
      englishFallback: app.i18n.T("fixture.fallback"),
      missing: app.i18n.T("fixture.missing"),
      singular: app.i18n.T("fixture.count"),
      count: app.i18n.Tc("fixture.count", Number(url.searchParams.get("count"))),
      multi: app.i18n.Tc("fixture.multi", 2),
      substituted: app.i18n.Ts("fixture.message", "name", "{fixture.reference}"),
      missingReference: app.i18n.Ts("fixture.message", "name", "{fixture.absent}"),
      cycle: app.i18n.Ts("fixture.message", "name", "{fixture.cycle}"),
      invalidArguments: app.i18n.Ts("fixture.message", "name"),
    }),
  );
  router.route("GET", "/fixture/clock/:id", async (context) => {
    await context.app.clock.sleep(100);
    return ok({
      id: context.params.id,
      time: context.app.clock.now().toISOString(),
      label: context.app.i18n.T("fixture.label"),
    });
  });
  router.route("GET", "/fixture/abort/:when", async ({ app, params }) => {
    const controller = new AbortController();
    if (params.when === "before") controller.abort();
    const completion = app.clock.sleep(60_000, controller.signal);
    if (params.when === "after") controller.abort();
    try {
      await completion;
      return ok("completed");
    } catch (error) {
      return ok(error instanceof Error ? error.name : "rejected");
    }
  });
  const server = startServer(app, router);
  return { server, errors, clock, origin: `http://127.0.0.1:${server.port}` };
}
