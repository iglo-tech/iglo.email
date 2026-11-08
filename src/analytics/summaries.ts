// Replaces listmonk's materialized views and their refresh in internal/core/core.go and
// cmd/init.go (initCron) at 6fcd95f. As upstream, app.cache_slow_queries chooses: off reads
// live, on reads these rows until the cron interval refreshes them. A refresh computes in a
// reader child and only its last step, one short transaction, holds the write lock.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import { ReaderError, type AnalyticsReader } from "@/analytics/reader";
import { createSchedule, type Schedule } from "@/analytics/schedule";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
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
    const { data } = JSON.parse(new TextDecoder().decode(await reader.read("summary", []))) as {
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
    clear: () => writeTransaction(db, () => void q.get("clear-summaries").run()),
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

/** Longest sleep, which is how soon a changed setting takes effect. */
const CHECK_MS = 60_000;

/** Create and start, for callers that refresh at once. The server creates, then starts (B52). */
export function startSummaryRefresh(options: SummaryRefreshOptions) {
  const refresh = createSummaryRefresh(options);
  refresh.start();
  return refresh;
}

export interface SummaryRefreshOptions {
  clock: Clock;
  logger: ErrorLogger;
  summaries: Summaries;
  settings: () => { enabled: boolean; interval: string };
}

/**
 * The app.cache_slow_queries cron job. It sleeps to the schedule's next due time, so it does
 * not use src/loops/loop.ts, whose interval is fixed and whose claims are write transactions:
 * @every can be one second, and there is no work row to lease. A setting or a refresh that
 * fails is logged and keeps the stored rows; neither stops the server.
 *
 * Creating it runs nothing; `start` runs the first check, after the port is bound (B52).
 */
export function createSummaryRefresh(options: SummaryRefreshOptions) {
  const { clock, logger, summaries } = options;
  const controller = new AbortController();
  // Nothing runs until `start`; `done` settles when the job ends, or at once if stopped first.
  let started = false;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // The caller can await `done` later without an interim unhandled rejection.
  void done.catch(() => undefined);
  let current: { interval: string; schedule: Schedule } | undefined;
  let refused: string | undefined;
  const schedule = (interval: string, now: Date) => {
    if (current?.interval === interval) return current.schedule;
    current = undefined;
    try {
      current = { interval, schedule: createSchedule(interval, now) };
      refused = undefined;
      return current.schedule;
    } catch (error) {
      // Logged once per value: it stays wrong until someone changes the setting.
      if (refused !== interval) logger.error(error);
      refused = interval;
      return undefined;
    }
  };
  const refresh = async () => {
    try {
      await summaries.refresh();
    } catch (error) {
      // The next due time tries again; a failed refresh keeps the previous numbers.
      if (!(error instanceof ReaderError && error.kind === "closed")) logger.error(error);
    }
  };
  /** One check; returns how long to sleep. */
  const check = async () => {
    const now = clock.now();
    const { enabled, interval } = options.settings();
    if (!enabled) {
      current = undefined;
      refused = undefined;
      summaries.clear();
      return CHECK_MS;
    }
    const due = schedule(interval, now);
    if (due?.due(now) || summaries.missing()) await refresh();
    return due ? Math.min(CHECK_MS, Math.max(0, due.delay(clock.now()))) : CHECK_MS;
  };
  const run = async () => {
    while (!controller.signal.aborted) {
      let wait = CHECK_MS;
      try {
        wait = await check();
      } catch (error) {
        logger.error(error);
      }
      try {
        await clock.sleep(wait, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    }
  };
  return {
    done,
    start() {
      if (started || controller.signal.aborted) return;
      started = true;
      run().then(finish, fail);
    },
    stop() {
      controller.abort();
      if (!started) finish();
      return done;
    },
  };
}
