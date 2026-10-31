// Adapted from listmonk internal/core/analytics.go and internal/core/campaigns.go
// (DeleteCampaignViews, DeleteCampaignLinkClicks, ExportCampaignViews, ExportCampaignLinkClicks)
// at 6fcd95f. The writes are on the server's connection and the export reads on the read-only one.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import exportSql from "@/analytics/export.sql" with { type: "text" };
import purgeSql from "@/analytics/purge.sql" with { type: "text" };

export type AnalyticsKind = "views" | "clicks";
/** Where a walk of the date index stands: the last row seen. */
export interface Position {
  at: string;
  id: bigint;
}
export interface ExportRow {
  id: bigint;
  created_at: string;
  campaign_id: bigint | null;
  campaign_uuid: string;
  campaign_name: string;
  subscriber_id: bigint;
  subscriber_uuid: string;
  email: string;
  subscriber_name: string;
  url?: string | null;
}
/** Rows one batch or export page looks at (docs/perf/M4.6-maintenance.md). */
export const PURGE_PAGE = 500;
export const EXPORT_PAGE = 1000;
export const startPosition: Position = { at: "", id: 0n };

export function createAnalyticsPurge(db: Database, readonly: Database) {
  const prepare = (table: string) =>
    prepareNamedQueries(db, [
      { name: `analytics/purge/${table}`, sql: purgeSql.replaceAll("%table%", table) },
    ]);
  const purges = { views: prepare("campaign_views"), clicks: prepare("link_clicks") };
  const exports = prepareNamedQueries(readonly, [{ name: "analytics/export", sql: exportSql }]);
  return {
    /** One batch of rows older than `before`. `null` when none are left. */
    purge(kind: AnalyticsKind, before: string, position: Position): Position | null {
      return writeTransaction(db, () => {
        const q = purges[kind];
        const page = q
          .get("purge-page")
          .all(before, position.at, position.id, PURGE_PAGE) as (Position & {
          created_at: string;
          hit: number;
        })[];
        const last = page.at(-1);
        if (!last) return null;
        const ids = page.filter((row) => row.hit).map((row) => row.id);
        if (ids.length) q.get("purge-delete").run(`[${ids.join(",")}]`);
        return { at: last.created_at, id: last.id };
      });
    },
    /** One page in date order; rows of sends are for the caller to leave out. */
    exportPage(kind: AnalyticsKind, since: string, position: Position) {
      return exports
        .get(`export-${kind}`)
        .all(since, position.at, position.id, EXPORT_PAGE) as ExportRow[];
    },
    close() {
      purges.views.close();
      purges.clicks.close();
      exports.close();
    },
  };
}
export type AnalyticsPurge = ReturnType<typeof createAnalyticsPurge>;
