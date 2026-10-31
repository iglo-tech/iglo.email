// Adapted from listmonk cmd/maintenance.go and cmd/settings.go (GetLogs) at 6fcd95f. Upstream runs
// each delete as one statement. Here a delete is many short transactions, with the event loop
// free between them, because the server's one thread also serves pixels, sends and loops
// (docs/perf/M4.6-maintenance.md; the differences are in 07-api-and-ui.md).
import {
  startPosition,
  type AnalyticsKind,
  type AnalyticsPurge,
  type ExportRow,
  type Position,
} from "@/analytics/purge";
import type { Clock } from "@/clock";
import type { LogBuffer } from "@/maintenance/log-buffer";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { csvRecord } from "@/subscribers/export";
import type { MaintenanceType, SubscriberStore } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";

const PERMISSION = "settings:maintain";
const MAX_EXPORTS = 2;
const FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Go's time.Parse(time.RFC3339, ...), as the stored text form. */
function rfc3339(text: string | null): string | null {
  const match = FORMAT.exec(text ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = "", zone] = match as unknown as string[];
  const day = new Date(0);
  day.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  if (day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${fraction.slice(0, 4)}${zone}`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
const seconds = (stored: string) => `${stored.slice(0, 19)}Z`;

export function registerMaintenanceRoutes(
  router: Router,
  deps: {
    subscribers: SubscriberStore;
    analytics: AnalyticsPurge;
    logs: LogBuffer;
    auth: Authentication;
    clock: Clock;
    /** Keeps the HTTP server from closing this request as idle while the work goes on. */
    keepOpen(request: Request): void;
    individualTracking(): boolean;
  },
) {
  const { subscribers, analytics, logs, auth, clock, keepOpen, individualTracking } = deps;
  const invalidData = (c: RequestContext) =>
    new HttpError(400, c.app.i18n.T("globals.messages.invalidData"));
  const parsed = (c: RequestContext, name: string) => {
    const value = rfc3339(c.url.searchParams.get(name));
    if (value === null) throw invalidData(c);
    return value;
  };
  let running: Promise<unknown> | undefined;
  let closed = false;
  let exporting = 0;
  /**
   * One operation at a time, in batches: `step` runs one and returns how many rows it removed, or
   * null at the end. Each await hands the thread to whatever else is waiting. A client that goes
   * away leaves the work running; it holds what it has done, and a repeat continues from there.
   */
  const operation = async (
    c: RequestContext,
    step: () => number | null,
    prepare: () => Promise<void> = async () => {},
  ) => {
    if (running) throw new HttpError(429, "A maintenance operation is already running.");
    keepOpen(c.request);
    const run = (async () => {
      await prepare();
      let total = 0;
      for (;;) {
        if (closed) throw new HttpError(503, "The server is shutting down.");
        const removed = step();
        if (removed === null) return total;
        total += removed;
        await clock.sleep(0);
      }
    })();
    running = run;
    try {
      return await run;
    } finally {
      running = undefined;
    }
  };

  /**
   * Walks the whole selection first, when a webhook wants its size: the bulk budget (D61) is
   * refused before any write, as for every other bulk action. `admitBulk` asks for the size only
   * if a webhook is listening.
   */
  const admitDelete = async (type: MaintenanceType) => {
    let wanted = false;
    subscribers.admitBulk("delete", () => {
      wanted = true;
      return 0;
    });
    if (!wanted) return;
    let selected = 0;
    let after = 0n;
    for (;;) {
      const page = subscribers.maintenancePage(type, after);
      const last = page.at(-1);
      if (!last) break;
      selected += page.filter((row) => row.hit).length;
      after = last.id;
      if (closed) throw new HttpError(503, "The server is shutting down.");
      await clock.sleep(0);
    }
    subscribers.admitBulk("delete", () => selected);
  };

  const gcSubscribers: Handler = async (c) => {
    const type = c.params.type;
    if (type !== "orphan" && type !== "blocklisted") throw invalidData(c);
    let after = 0n;
    let spent = 0;
    const count = await operation(
      c,
      () => {
        const batch = subscribers.maintenanceRemove(type, after, spent);
        if (!batch) return null;
        after = batch.last;
        spent += batch.removed;
        return batch.removed;
      },
      () => admitDelete(type),
    );
    return ok({ count });
  };

  const gcSubscriptions: Handler = async (c) => {
    const before = parsed(c, "before_date");
    let after = 0n;
    const count = await operation(c, () => {
      const batch = subscribers.removeUnconfirmed(after, before);
      if (!batch) return null;
      after = batch.last;
      return batch.removed;
    });
    return ok({ count });
  };

  const gcAnalytics: Handler = async (c) => {
    const before = parsed(c, "before_date");
    const type = c.params.type;
    if (type !== "all" && type !== "views" && type !== "clicks") throw invalidData(c);
    const kinds: AnalyticsKind[] = type === "all" ? ["views", "clicks"] : [type];
    let position = startPosition;
    await operation(c, () => {
      const kind = kinds[0];
      if (!kind) return null;
      const next = analytics.purge(kind, before, position);
      if (next) position = next;
      else {
        kinds.shift();
        position = startPosition;
      }
      return 0;
    });
    return ok(true);
  };

  const exportCSV: Handler = (c) => {
    const since = parsed(c, "since");
    const type = c.params.type;
    if (type !== "views" && type !== "clicks") throw invalidData(c);
    if (exporting >= MAX_EXPORTS) throw new HttpError(429, "Too many exports in progress.");
    const text = new TextEncoder();
    const columns = [
      "campaign_id",
      "campaign_uuid",
      "campaign_name",
      "subscriber_id",
      "subscriber_uuid",
      "email",
      "subscriber_name",
      ...(type === "clicks" ? ["url"] : []),
      "created_at",
    ];
    const record = (row: ExportRow, attributed: boolean) =>
      csvRecord([
        String(row.campaign_id),
        row.campaign_uuid,
        row.campaign_name,
        attributed ? String(row.subscriber_id) : "0",
        attributed ? row.subscriber_uuid : "",
        attributed ? row.email : "",
        attributed ? row.subscriber_name : "",
        ...(type === "clicks" ? [row.url ?? ""] : []),
        seconds(row.created_at),
      ]);
    let position: Position = startPosition;
    let started = false;
    let released = false;
    const release = () => {
      if (!released) exporting--;
      released = true;
    };
    exporting++;
    const body = new ReadableStream<Uint8Array>({
      // One page per read of the client's: a slow client holds a page, not the table.
      async pull(controller) {
        try {
          for (;;) {
            const page = analytics.exportPage(type, since, position);
            const last = page.at(-1);
            if (!last) {
              release();
              controller.close();
              return;
            }
            position = { at: last.created_at, id: last.id };
            const rows = page.filter((row) => row.campaign_id !== null);
            if (!rows.length) {
              await clock.sleep(0);
              continue;
            }
            const attributed = individualTracking();
            const lines = rows.map((row) => record(row, attributed)).join("");
            controller.enqueue(text.encode(started ? lines : csvRecord(columns) + lines));
            started = true;
            // A pull that only enqueues is called again before any socket is served.
            await clock.sleep(0);
            return;
          }
        } catch (error) {
          // Headers are sent: end the stream with an error, as upstream stops writing.
          release();
          c.app.logger.error(error);
          controller.error(error);
        }
      },
      cancel: release,
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename=campaign_${type}.csv`,
        "Cache-Control": "no-cache",
      },
    });
  };

  router.route("GET", "/api/logs", () => ok(logs.lines()), auth.middleware("settings:get"));
  router.route(
    "DELETE",
    "/api/maintenance/subscribers/:type",
    gcSubscribers,
    auth.middleware(PERMISSION),
  );
  router.route(
    "DELETE",
    "/api/maintenance/analytics/:type",
    gcAnalytics,
    auth.middleware(PERMISSION),
  );
  router.route(
    "GET",
    "/api/maintenance/analytics/:type/export",
    exportCSV,
    auth.middleware(PERMISSION),
  );
  router.route(
    "DELETE",
    "/api/maintenance/subscriptions/unconfirmed",
    gcSubscriptions,
    auth.middleware(PERMISSION),
  );
  return {
    /** Stops a running operation at its next batch and waits for it. */
    async close() {
      closed = true;
      await running?.catch(() => {});
    },
  };
}
