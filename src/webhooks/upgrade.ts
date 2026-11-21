// The private-target default's upgrade (B125, D122, lead decisions). Migration 24 turns a stored
// `webhooks.block_private_addresses = false` on, once. Two things belong to the upgrade here: a read
// taken before the migrations that says whether they will turn that value on, and the notice the
// first start after them gives, one attention line per enabled webhook whose target the block now
// refuses. The line names the webhook ID and the host, never the path, the query or the secret.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import { refusesTarget, type WebhookTransport } from "@/webhooks/delivery";

/** The schema version that the default's migration makes current (migrations/0024). */
const DEFAULT_SCHEMA = 24;
const key = "webhooks.block_private_addresses";
/** The log buffer's fixed text; the stderr line of each refused webhook names it. */
export const REFUSED_NOTICE = "A webhook target is refused by the private-address block";

/** Read before the migrations run: true when they will turn a stored false on. */
export function migrationTurnsOn(db: Database): boolean {
  const version = Number(
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version === 0 || version >= DEFAULT_SCHEMA) return false;
  const settings = db
    .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'settings'")
    .get();
  if (!settings) return false;
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row?.value === "false";
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** After the start, once: one attention line per enabled webhook whose target the block refuses. */
export async function noticeRefusedTargets(
  webhooks: { enabledTargets(): { id: number; url: string }[] },
  logger: ErrorLogger,
  transport: WebhookTransport = {},
): Promise<void> {
  for (const hook of webhooks.enabledTargets()) {
    const host = hostOf(hook.url);
    if (host === undefined || !(await refusesTarget(hook.url, transport))) continue;
    logger.attention(
      `Webhook ${hook.id} target ${host} is refused by webhooks.block_private_addresses (D122)`,
      REFUSED_NOTICE,
    );
  }
}
