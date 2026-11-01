// Native send journal retention (D70); listmonk keeps no message bodies.
import type { Database } from "bun:sqlite";
import { linkPath } from "@/unsubscribe/message";

/** A finished send keeps its prepared message this long after it was created. */
export const SEND_BODY_RETENTION_MS = 30 * 86_400_000;
/** Payload bytes one pass reads, past its row limit: a row can hold 8 MiB. */
const PASS_BYTES = 4 * 1024 * 1024;
const BATCH = 50;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The tracked link paths of one send's message, which is all an old redirect reads. */
function linksIn(uuid: string, bodies: (string | null)[]) {
  const pattern = new RegExp(linkPath(uuid, UUID), "g");
  const links = new Set<string>();
  for (const body of bodies)
    if (typeof body === "string")
      for (const [link] of Buffer.from(body, "base64").toString("latin1").matchAll(pattern))
        links.add(link);
  return links.size ? [...links].join("\n") : null;
}

/**
 * Replace the prepared message of finished sends past retention with its tracked link paths,
 * inside the caller's write transaction: at most `limit` rows, and at most 50 since each one reads
 * a message. The row, and so every lookup and
 * count over it, stays. A `failed` or `unknown` row can no longer be resent afterwards.
 */
export function createSendCompaction(db: Database) {
  return (now: Date, limit: number) => {
    const before = new Date(now.getTime() - SEND_BODY_RETENTION_MS);
    const rows = db
      .query<{ id: bigint; uuid: string; bytes: bigint }, [string, number]>(
        `SELECT id, uuid, octet_length(payload) AS bytes
           FROM sends INDEXED BY idx_sends_compactable
           WHERE payload IS NOT NULL AND status IN ('sent', 'failed', 'skipped', 'unknown')
             AND created_at < ? ORDER BY created_at LIMIT ?`,
      )
      .all(before.toISOString(), Math.min(limit, BATCH));
    const compacted: bigint[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += Number(row.bytes);
      if (compacted.length && bytes > PASS_BYTES) break;
      const { body, alt } = db
        .query<{ body: string | null; alt: string | null }, [bigint]>(
          "SELECT json_extract(payload, '$.message.body') AS body, json_extract(payload, '$.message.altBody') AS alt FROM sends WHERE id = ?",
        )
        .get(row.id)!;
      db.run("UPDATE sends SET payload = NULL, tracked_links = ? WHERE id = ?", [
        linksIn(row.uuid, [body, alt]),
        row.id,
      ]);
      compacted.push(row.id);
    }
    return compacted;
  };
}
