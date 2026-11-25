// A project's sending activity in three counts, for the instance Projects page (14-projects
// section 13; B143a, D157). Native: listmonk has no instance. Read-only aggregates over the sends,
// campaigns and campaign deliveries, as this module's dashboard counts are; counts only, never a
// row, so the instance learns nothing else of the project.
import type { Database } from "bun:sqlite";

export interface ProjectActivity {
  /** Marketing sends waiting in the outbox (`queued`). */
  readonly queuedMarketing: number;
  /** Campaigns with the status `running`. */
  readonly runningCampaigns: number;
  /**
   * Sends started (and since delivered) and campaign messages delivered at or after `since`. A send
   * counts from its last attempt, as the capacity forecast counts it.
   */
  readonly sent: number;
}

const count = (row: { total: bigint } | null) => Number(row?.total ?? 0n);

export function createProjectActivity(db: Database) {
  const queued = db.query<{ total: bigint }, []>(
    "SELECT count(*) AS total FROM sends WHERE status = 'queued' AND kind = 'marketing'",
  );
  const running = db.query<{ total: bigint }, []>(
    "SELECT count(*) AS total FROM campaigns WHERE status = 'running'",
  );
  // A sent row counts from its start, its last attempt (`sent_at` for a row without one), as the
  // capacity forecast counts it against SES's 24-hour quota (D162). The condition is the start-time
  // index's own expression, so SQLite reads only the window's entries of idx_sends_started, not
  // every sent row in history (B149a, D164; docs/perf/projects-B149a.md).
  const sends = db.query<{ total: bigint }, [string]>(
    "SELECT count(*) AS total FROM sends WHERE status = 'sent' AND coalesce(attempted_at, sent_at) >= ?1",
  );
  // A campaign whose message was delivered since then was updated since then (its sent count), so
  // the deliveries are read by campaign through their primary key, not by a scan of every delivery.
  const deliveries = db.query<{ total: bigint }, [string]>(
    `SELECT count(*) AS total FROM campaign_deliveries
     WHERE campaign_id IN (SELECT id FROM campaigns WHERE updated_at >= ?1)
       AND status = 'sent' AND at >= ?1`,
  );
  return {
    read(since: Date): ProjectActivity {
      const at = since.toISOString();
      return {
        queuedMarketing: count(queued.get()),
        runningCampaigns: count(running.get()),
        sent: count(sends.get(at)) + count(deliveries.get(at)),
      };
    },
    close(): void {
      for (const statement of [queued, running, sends, deliveries]) {
        statement.finalize();
      }
    },
  };
}
