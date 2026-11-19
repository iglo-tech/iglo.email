// Native (B108, D114): the Message-ID of each step and campaign test send, so a bounce or complaint
// of a test is named in the log. A test is not a send (D105): nothing here is counted, resent or
// listed as a send. Records last seven days and the retention loop removes them (D70).
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";

/** How long a test's record can name a bounce or complaint of it. */
export const TEST_SEND_RETENTION_MS = 7 * 86_400_000;

export type Id = bigint | number;

/**
 * What a notice of a test send names: the test's kind and its IDs. No address is kept (D114): the
 * recipient a notice names is the notice's own, and the record is matched by Message-ID alone.
 */
export interface TestSendRecord {
  kind: "campaign" | "sequence_step";
  campaign_id: Id | null;
  sequence_id: Id | null;
  step_id: Id | null;
}
export interface TestSendEntry extends TestSendRecord {
  /** The Message-ID the message is sent with, chosen before it is handed to the emailer. */
  messageId: string;
}

/** Message-IDs compare without their angle brackets and in lower case. */
export function normalizeMessageId(value: string) {
  return value
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .toLowerCase();
}

export function createTestSends(db: Database, clock: Clock) {
  const insert = db.query(
    `INSERT INTO test_sends (message_id, kind, campaign_id, sequence_id, step_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const lookup = db.query<TestSendRecord, [string, string]>(
    `SELECT kind, campaign_id, sequence_id, step_id FROM test_sends
     WHERE message_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`,
  );
  return {
    /**
     * Inside the caller's write transaction, and before any of the messages is handed to the
     * emailer: a write that fails sends nothing, and a sent message always has its record.
     */
    record(entries: TestSendEntry[]) {
      const at = clock.now().toISOString();
      for (const entry of entries)
        insert.run(
          normalizeMessageId(entry.messageId),
          entry.kind,
          entry.campaign_id,
          entry.sequence_id,
          entry.step_id,
          at,
        );
    },
    /** The test a Message-ID names inside the window, or null. */
    find(messageId: string): TestSendRecord | null {
      const key = normalizeMessageId(messageId);
      if (!key) return null;
      const since = new Date(clock.now().getTime() - TEST_SEND_RETENTION_MS).toISOString();
      return lookup.get(key, since) ?? null;
    },
    /** One retention pass inside the loop's write transaction: at most `limit` records past the window. */
    purge(now: Date, limit: number): Id[] {
      const before = new Date(now.getTime() - TEST_SEND_RETENTION_MS).toISOString();
      return db
        .query<{ id: bigint }, [string, number]>(
          `DELETE FROM test_sends WHERE id IN (
             SELECT id FROM test_sends WHERE created_at < ? ORDER BY created_at LIMIT ?
           ) RETURNING id`,
        )
        .all(before, limit)
        .map((row) => row.id);
    },
  };
}
export type TestSends = ReturnType<typeof createTestSends>;
