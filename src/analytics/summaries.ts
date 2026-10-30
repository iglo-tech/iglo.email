// Replaces listmonk's materialized views and their refresh in internal/core/core.go and
// cmd/init.go (initCron) at 6fcd95f. As upstream, app.cache_slow_queries chooses: off reads
// live, on reads these rows until the cron interval refreshes them. A refresh computes in a
// reader child and only its last step, one short transaction, holds the write lock.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { AnalyticsReader } from "@/analytics/reader";
import { dueBetween } from "@/analytics/schedule";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { startLoop } from "@/loops/loop";
import type { ListCounts } from "@/subscribers/list-counts";
import sql from "@/analytics/summaries.sql" with { type: "text" };

export type SummaryName = "dashboard_counts" | "dashboard_charts" | "list_stats";
const names: SummaryName[] = ["dashboard_counts", "dashboard_charts", "list_stats"];

export function createSummaries(db: Database, clock: Clock, reader: AnalyticsReader) {
  const q = prepareNamedQueries(db, [{ name: "analytics/summaries", sql }]);
  let running: Promise<void> | undefined;
  const get = (name: SummaryName) =>
    (q.get("get-summary").get(name) as { data: string } | null)?.data ?? null;
  const refresh = async () => {
    const { data } = JSON.parse(await reader.read("summary")) as {
      data: Record<SummaryName, unknown>;
    };
    const at = clock.now().toISOString();
    writeTransaction(db, () => {
      for (const name of names) q.get("upsert-summary").run(name, JSON.stringify(data[name]), at);
    });
  };
  return {
    /** Concurrent callers share one child. */
    refresh(): Promise<void> {
      return (running ??= refresh().finally(() => (running = undefined)));
    },
    missing: () => names.some((name) => get(name) === null),
    /** The stored view, computed on first use after caching was turned on. */
    async read(name: SummaryName): Promise<unknown> {
      if (get(name) === null) await this.refresh();
      return JSON.parse(get(name)!);
    },
    /** Turning caching off forgets the rows, so turning it on again never shows old ones. */
    clear: () => void q.get("clear-summaries").run(),
    /** The list counters for GET /api/lists; null falls back to the live count. */
    listCounts(): ReturnType<ListCounts["all"]> | null {
      const data = get("list_stats");
      if (data === null) return null;
      return new Map(
        Object.entries(JSON.parse(data) as Record<string, Record<string, number>>).map(
          ([id, counts]) => [BigInt(id), counts],
        ),
      );
    },
    close: () => q.close(),
  };
}
export type Summaries = ReturnType<typeof createSummaries>;

/** The app.cache_slow_queries cron job, checked once a minute in the maintenance loop. */
export function startSummaryRefresh(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  summaries: Summaries;
  settings: () => { enabled: boolean; interval: string };
  intervalMs?: number;
}) {
  let checked = options.clock.now();
  return startLoop<true>({
    db: options.db,
    clock: options.clock,
    logger: options.logger,
    intervalMs: options.intervalMs ?? 60_000,
    leaseMs: 1,
    batchSize: 1,
    claim(now) {
      const { enabled, interval } = options.settings();
      const after = checked;
      checked = now;
      if (!enabled) {
        options.summaries.clear();
        return [];
      }
      return options.summaries.missing() || dueBetween(interval, after, now) ? [true] : [];
    },
    async process() {
      try {
        await options.summaries.refresh();
      } catch (error) {
        // The next interval tries again; a failed refresh keeps the previous numbers.
        options.logger.error(error);
      }
    },
  });
}
