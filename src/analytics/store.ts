// Adapted from listmonk internal/core/analytics.go, internal/core/campaigns.go,
// internal/core/lists.go and internal/core/dashboard.go at 6fcd95f. Times are UTC, like the
// reference database's session, and stored created_at values order as text.
import type { Database } from "bun:sqlite";
import { projectCampaign } from "@/campaigns/routes";
import { createCampaignStore } from "@/campaigns/store";
import { createRealClock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { createListCounts } from "@/subscribers/list-counts";
import eventsSql from "@/analytics/events.sql" with { type: "text" };
import sql from "@/analytics/queries.sql" with { type: "text" };

export type Interval = "hour" | "day" | "week" | "month";
export type CountType =
  | "views"
  | "clicks"
  | "total_views"
  | "total_clicks"
  | "bounces"
  | "subscriptions"
  | "unsubscriptions";
export interface CountRow {
  list_id?: number;
  campaign_id: number;
  count: number;
  timestamp: string;
}
export interface Range {
  from: string;
  to: string;
}
type Row = {
  campaign_id?: bigint;
  list_id?: bigint;
  bucket: string;
  count: bigint;
};

/** dashboardCampaignCount. */
const DASHBOARD_CAMPAIGNS = 6;
const prefix = { hour: 13, day: 10, week: 10, month: 7 } as const;

/** The rest of DATE_TRUNC for a created_at cut to the interval's prefix. */
function period(bucket: string, interval: Interval): string {
  if (interval === "hour") return `${bucket}:00:00Z`;
  if (interval === "month") return `${bucket}-01T00:00:00Z`;
  if (interval === "day") return `${bucket}T00:00:00Z`;
  // A week starts on Monday.
  const day = new Date(`${bucket}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return `${day.toISOString().slice(0, 10)}T00:00:00Z`;
}
const idList = (ids: readonly string[]) => `[${ids.join(",")}]`;

/**
 * Finish rows that SQL ordered by bucket: several days of one week merge here, within a period
 * that holds at most one count per requested ID, so memory does not grow with the result.
 */
function* rows(found: Iterable<Row>, interval: Interval, list: boolean): Generator<CountRow> {
  const finish = (timestamp: string, counts: Map<bigint, number>) =>
    [...counts]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([owner, count]): CountRow =>
        list
          ? { list_id: Number(owner), campaign_id: 0, count, timestamp }
          : { campaign_id: Number(owner), count, timestamp },
      );
  let current: string | undefined;
  const counts = new Map<bigint, number>();
  for (const row of found) {
    const timestamp = period(row.bucket, interval);
    if (timestamp !== current) {
      if (current !== undefined) yield* finish(current, counts);
      current = timestamp;
      counts.clear();
    }
    const owner = list ? row.list_id! : row.campaign_id!;
    counts.set(owner, (counts.get(owner) ?? 0) + Number(row.count));
  }
  if (current !== undefined) yield* finish(current, counts);
}

export function createAnalyticsStore(db: Database) {
  const q = prepareNamedQueries(db, [{ name: "analytics", sql }]);
  const prepare = (table: string) =>
    prepareNamedQueries(db, [
      {
        name: `analytics/${table}`,
        sql: eventsSql.replaceAll("%table%", table),
      },
    ]);
  const events = {
    views: prepare("campaign_views"),
    clicks: prepare("link_clicks"),
    bounces: prepare("bounces"),
  };
  const eventRows = (
    resource: "campaign" | "list",
    type: CountType,
    ids: readonly string[],
    range: Range,
    interval: Interval,
  ) => {
    const source =
      type === "views" || type === "total_views"
        ? events.views
        : type === "clicks" || type === "total_clicks"
          ? events.clicks
          : events.bounces;
    const unique = type === "views" || type === "clicks";
    const statement = source.get(`${resource}-${unique ? "unique-" : ""}counts`);
    return statement.iterate(prefix[interval], idList(ids), range.from, range.to) as Iterable<Row>;
  };
  return {
    campaignCounts(type: CountType, ids: readonly string[], range: Range, interval: Interval) {
      return rows(eventRows("campaign", type, ids, range, interval), interval, false);
    },
    listCounts(type: CountType, ids: readonly string[], range: Range, interval: Interval) {
      if (type === "subscriptions" || type === "unsubscriptions") {
        const name = type === "subscriptions" ? "subscription" : "unsubscription";
        const found = q
          .get(`list-${name}-counts`)
          .iterate(prefix[interval], idList(ids), range.from, range.to) as Iterable<Row>;
        return rows(found, interval, true);
      }
      return rows(eventRows("list", type, ids, range, interval), interval, true);
    },
    /** Top 50 URLs. Individual tracking counts distinct known subscribers instead of clicks. */
    links(
      resource: "campaign" | "list",
      ids: readonly string[],
      range: Range,
      distinct: boolean,
    ): { url: string; count: number }[] {
      const found = q
        .get(`${resource}-link-${distinct ? "distinct-" : ""}counts`)
        .all(idList(ids), range.from, range.to) as {
        url: string;
        count: bigint;
      }[];
      return found.map((row) => ({ url: row.url, count: Number(row.count) }));
    },
    /** A send is one recipient, so unique counts are always available, by send. */
    sends(group: "template" | "step", range: Range) {
      const found = q
        .get(group === "template" ? "sends-by-template" : "sends-by-step")
        .all(range.from, range.to) as Record<string, bigint | string | null>[];
      return found.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" ? Number(value) : value,
          ]),
        ),
      );
    },
    /** Native: enrollments by status and sends by step, for one page of sequence IDs. */
    sequenceCounts(ids: string[]) {
      const list = `[${ids.join(",")}]`;
      const plain = (row: Record<string, bigint | string>) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" ? Number(value) : value,
          ]),
        );
      return {
        enrollments: (
          q.get("sequence-enrollment-counts").all(list) as Record<string, bigint | string>[]
        ).map(plain),
        steps: (q.get("sequence-step-counts").all(list) as Record<string, bigint>[]).map(plain),
      };
    },
    /** mat_dashboard_counts. SUM and subqueries over no rows stay JSON null. */
    dashboardCounts() {
      const subscribers = q.get("subscriber-status-counts").all() as {
        status: string;
        count: bigint;
      }[];
      const { count: orphans } = q.get("subscriber-orphan-count").get() as {
        count: bigint;
      };
      const lists = q.get("list-type-counts").get() as Record<string, bigint>;
      const campaigns = q.get("campaign-status-counts").all() as {
        status: string;
        count: bigint;
        sent: bigint;
      }[];
      const total = (values: bigint[]) =>
        values.length ? Number(values.reduce((sum, value) => sum + value, 0n)) : null;
      const blocklisted = subscribers.find((row) => row.status === "blocklisted");
      return {
        subscribers: {
          total: total(subscribers.map((row) => row.count)),
          blocklisted: blocklisted ? Number(blocklisted.count) : null,
          orphans: Number(orphans),
        },
        lists: {
          total: Number(lists.total),
          private: Number(lists.private),
          public: Number(lists.public),
          optin_single: Number(lists.optin_single),
          optin_double: Number(lists.optin_double),
        },
        campaigns: {
          total: total(campaigns.map((row) => row.count)) ?? 0,
          by_status: campaigns.length
            ? Object.fromEntries(campaigns.map((row) => [row.status, Number(row.count)]))
            : null,
        },
        messages: total(campaigns.map((row) => row.sent)),
      };
    },
    /** mat_dashboard_charts: the 31 days up to each table's newest campaign row. */
    dashboardCharts() {
      const days = (name: string) =>
        (q.get(name).all() as { count: bigint; date: string }[]).map((row) => ({
          count: Number(row.count),
          date: row.date,
        }));
      return {
        link_clicks: days("chart-clicks"),
        campaign_views: days("chart-views"),
      };
    },
    /**
     * getDashboardCampaigns: scheduled ones on top, the bodies stripped. Each row counts its
     * views, clicks and bounces, which at 1.5 million events holds a thread for 55 ms.
     */
    dashboardCampaigns(all: boolean, listIds: readonly string[]) {
      // Nothing here writes, so the store's clock and references are never reached.
      const campaigns = createCampaignStore(db, createRealClock(), {
        templateExists: () => false,
        defaultTemplate: () => null,
        listName: () => null,
        mediaFilename: () => null,
      });
      try {
        const scope = { all, ids: listIds.map(BigInt) };
        const newest = (statuses: string[], limit: number) =>
          campaigns.query(
            { query: "", statuses, tags: [], type: "" },
            scope,
            "created_at",
            "desc",
            0,
            limit,
          ).rows;
        const rows = newest(["scheduled"], DASHBOARD_CAMPAIGNS);
        const rest = DASHBOARD_CAMPAIGNS - rows.length;
        if (rest > 0)
          rows.push(...newest(["draft", "running", "paused", "finished", "cancelled"], rest));
        if (!rows.length) return null;
        return rows.map((row) => {
          const out = projectCampaign(row, true);
          out.body_source = null;
          return out;
        });
      } finally {
        campaigns.close();
      }
    },
    /** Every summary row, from one read snapshot. */
    summary() {
      const counts = createListCounts(db);
      try {
        return {
          dashboard_counts: this.dashboardCounts(),
          dashboard_charts: this.dashboardCharts(),
          list_stats: Object.fromEntries(counts.all()),
        };
      } finally {
        counts.close();
      }
    },
    close() {
      q.close();
      for (const queries of Object.values(events)) queries.close();
    },
  };
}
export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>;
