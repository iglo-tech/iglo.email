// Native (14-projects section 7, B145a): the narrow per-project counts the instance's capacity
// forecast reads. listmonk has no forecast. Counts and `send_at` only, never rows or names, so the
// instance never sees another project's campaigns (invariant 1).
import type { Database } from "bun:sqlite";
import type { CampaignAudience, CampaignRecipients } from "@/subscribers/campaign-recipients";
import type { StartCounts } from "@/messaging/capacity";

/** One campaign the forecast plans for: its ID in this project, when it starts, how many it sends. */
export interface PlannedCampaign {
  readonly id: number;
  readonly status: "scheduled" | "running";
  /** The scheduled start (ISO), or null. */
  readonly sendAt: string | null;
  /** A scheduled campaign's audience now; a running one's recipients still to go. */
  readonly recipients: number;
}

interface PlanRow {
  id: bigint;
  status: string;
  send_at: string | null;
  type: string | null;
  to_send: bigint;
  sent: bigint;
}

const COLUMNS = "id, status, send_at, type, to_send, sent";

export function createPlannedCampaigns(
  db: Database,
  deps: {
    readonly recipients: Pick<CampaignRecipients, "measure">;
    /** A list's opt-in type, or null for a list that is gone (the runner's audience rule). */
    readonly listOptin: (id: bigint) => string | null;
  },
) {
  const plannedRows = db.prepare<PlanRow, []>(
    `SELECT ${COLUMNS} FROM campaigns WHERE status IN ('scheduled', 'running') ORDER BY id`,
  );
  const oneRow = db.prepare<PlanRow, [bigint]>(`SELECT ${COLUMNS} FROM campaigns WHERE id = ?`);
  const listIds = db.prepare<{ list_id: bigint }, [bigint]>(
    "SELECT list_id FROM campaign_lists WHERE campaign_id = ? AND list_id IS NOT NULL ORDER BY id",
  );
  // A campaign's `updated_at` moves with every batch it claims and sends, so a campaign untouched
  // since ?1 has no delivery after it either, and only the others' deliveries are read.
  const startsSince = db.prepare<
    { day: number | bigint; window: number | bigint | null },
    [string, string]
  >(
    `SELECT COUNT(*) AS day, SUM(at > ?2) AS window FROM campaign_deliveries
     WHERE campaign_id IN (SELECT id FROM campaigns WHERE status = 'running' OR updated_at > ?1)
       AND at > ?1 AND status IN ('claimed', 'sent', 'unknown')`,
  );
  /** The audience the runner measures at its start: the campaign's lists that still exist. */
  const audience = (row: PlanRow): CampaignAudience => {
    const lists: Array<CampaignAudience["lists"][number]> = [];
    for (const { list_id: id } of listIds.all(row.id)) {
      const optin = deps.listOptin(id);
      if (optin !== null) {
        lists.push({ id, optin });
      }
    }
    return { lists, type: row.type === "optin" ? "optin" : "regular" };
  };
  /** As the runner counts: a running campaign's to_send less what it sent; else its audience now. */
  const count = (row: PlanRow): number =>
    row.status === "running"
      ? Math.max(0, Number(row.to_send) - Number(row.sent))
      : Number(deps.recipients.measure(audience(row)).count);
  return {
    /** Every scheduled and running campaign, counted the way the runner counts them. */
    planned(): Array<PlannedCampaign> {
      return plannedRows.all().map((row) => ({
        id: Number(row.id),
        status: row.status === "running" ? "running" : "scheduled",
        sendAt: row.send_at,
        recipients: count(row),
      }));
    },
    /** One campaign's recipients and send time, or null when there is no such campaign. */
    campaign(id: bigint): { recipients: number; sendAt: string | null } | null {
      const row = oneRow.get(id);
      return row ? { recipients: count(row), sendAt: row.send_at } : null;
    },
    /** This project's campaign messages that started after `day` and after `from` (ISO), in one scan. */
    starts(day: string, from: string): StartCounts {
      const row = startsSince.get(day, from);
      return { day: Number(row?.day ?? 0), window: Number(row?.window ?? 0) };
    },
    close(): void {
      for (const statement of [plannedRows, oneRow, listIds, startsSince]) {
        statement.finalize();
      }
    },
  };
}
export type PlannedCampaigns = ReturnType<typeof createPlannedCampaigns>;
