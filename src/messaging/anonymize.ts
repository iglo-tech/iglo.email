// Native send journal privacy (D25); listmonk has no retained send log to anonymize.
import type { Database } from "bun:sqlite";

/**
 * The `deleting` subscriber effect. Retained rows keep their counts, statuses and timings but
 * lose the address and the prepared message, in the deletion's transaction. A queued row is
 * cancelled. A row already `sending` settles by its outcome; a retry finds no payload and fails
 * without SMTP, and `failed` or `unknown` rows can no longer be resent. Send UUIDs and
 * idempotency keys stay, so a replayed producer request cannot send again.
 */
export function createSendAnonymizer(db: Database) {
  return (subscribers: { id: bigint; email: string }[]) => {
    if (!db.inTransaction)
      throw new Error("Sends are anonymized in the caller's transaction");
    if (!subscribers.length) return;
    db.query(
      `UPDATE sends SET
         status = CASE status WHEN 'queued' THEN 'skipped' ELSE status END,
         skip_reason = CASE status WHEN 'queued' THEN 'subscriber_unavailable' ELSE skip_reason END,
         next_attempt_at = NULL, to_email = '', payload = NULL
       WHERE id IN (
         SELECT id FROM sends WHERE subscriber_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))
         UNION ALL
         SELECT id FROM sends INDEXED BY idx_sends_unlinked_to WHERE subscriber_id IS NULL
           AND to_email COLLATE NOCASE IN (SELECT value FROM json_each(?2))
       )`,
    ).run(
      JSON.stringify(subscribers.map(({ id }) => String(id))),
      JSON.stringify(subscribers.map(({ email }) => email)),
    );
  };
}
