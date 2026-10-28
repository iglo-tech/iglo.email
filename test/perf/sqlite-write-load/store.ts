// Synthetic selection/progress informed by listmonk schema.sql, queries/campaigns.sql,
// internal/manager/manager.go and internal/manager/pipe.go;
// cursor reservation before simulated processing follows docs/design/04-sending.md.
// FTS5 and events are new SQLite design fixtures, not upstream query ports.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "@/db/connection";
import { writeTransaction } from "@/db/transaction";
import { schema } from "@/test/perf/sqlite-write-load/schema";

export interface SyntheticEvent {
  subscriber: number;
  key: string;
  sequence: number;
  occurredAt?: string;
}
export type SubscriberOperation = "insert" | "update" | "delete";
export interface Mutation {
  operation: SubscriberOperation;
  id: number;
  name?: string;
  email?: string;
}
export type TransactionObserver = (kind: string, size: number, milliseconds: number) => void;
const timestamp = "2026-01-02T03:04:05.000Z";

export class SpikeStore {
  private readonly db: Database;
  observer: TransactionObserver | undefined;
  constructor(private readonly directory: string) {
    this.db = openDatabase(directory);
    this.db.run(schema);
  }
  private write<T>(kind: string, size: number, fn: () => T): T {
    const started = performance.now();
    try {
      let result!: T;
      writeTransaction(this.db, () => {
        result = fn();
      });
      return result;
    } finally {
      this.observer?.(kind, size, performance.now() - started);
    }
  }
  seed(count: number) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid seed size");
    const insert = this.db.prepare(
      "INSERT INTO spike_subscribers(id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    try {
      for (let first = 1; first <= count; first += 500) {
        this.write("seed", Math.min(500, count - first + 1), () => {
          for (let id = first; id < Math.min(first + 500, count + 1); id++)
            insert.run(
              id,
              `subscriber${id}@example.test`,
              `Subscriber ${id}`,
              timestamp,
              timestamp,
            );
        });
      }
      this.write("seed", 1, () =>
        this.db.run("INSERT INTO spike_campaigns(id, max_subscriber_id) VALUES (1, ?)", [count]),
      );
    } finally {
      insert.finalize();
    }
  }
  reserve(count: number): number[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid reservation size");
    return this.write("reservation", count, () => {
      const rows = this.db
        .query<{ id: bigint }, [number]>(
          "SELECT id FROM spike_subscribers WHERE id > (SELECT last_subscriber_id FROM spike_campaigns WHERE id=1) AND id <= (SELECT max_subscriber_id FROM spike_campaigns WHERE id=1) AND status != 'blocklisted' ORDER BY id LIMIT ?",
        )
        .all(count);
      if (rows.length)
        this.db.run("UPDATE spike_campaigns SET last_subscriber_id = ? WHERE id=1", [
          rows.at(-1)!.id,
        ]);
      return rows.map((row) => Number(row.id));
    });
  }
  process(count: number) {
    const inTransaction = this.db.inTransaction;
    if (inTransaction) throw new Error("Processing must be outside a transaction");
    this.write("progress", count, () => {
      const result = this.db.run(
        "UPDATE spike_campaigns SET sent=sent+? WHERE id=1 AND sent+? <= last_subscriber_id",
        [count, count],
      );
      if (result.changes !== 1) throw new Error("Progress exceeds reservation");
    });
    return { sent: this.campaign().sent, inTransaction };
  }
  events(events: SyntheticEvent[]) {
    this.write("events", events.length, () => {
      const insert = this.db.prepare(
        "INSERT INTO spike_events(subscriber_id,name,data,occurred_at,created_at,idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
      );
      try {
        for (const event of events) {
          const date = event.occurredAt ?? timestamp;
          const payload = JSON.stringify({
            order: event.sequence,
            amount: 12345,
            currency: "USD",
            source: "synthetic",
          });
          insert.run(event.subscriber, "order_paid", payload, date, date, event.key);
        }
      } finally {
        insert.finalize();
      }
    });
  }
  mutate(operations: Mutation[], rollback = false) {
    try {
      this.write("subscriber", operations.length, () => {
        for (const item of operations) {
          if (item.operation === "insert")
            this.db.run(
              "INSERT INTO spike_subscribers(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)",
              [item.id, item.name!, item.email!, timestamp, timestamp],
            );
          else if (item.operation === "update")
            this.db.run("UPDATE spike_subscribers SET name=?, email=?, updated_at=? WHERE id=?", [
              item.name!,
              item.email!,
              timestamp,
              item.id,
            ]);
          else this.db.run("DELETE FROM spike_subscribers WHERE id=?", [item.id]);
        }
        if (rollback) throw new Error("synthetic rollback");
      });
    } catch (error) {
      if (!(rollback && error instanceof Error && error.message === "synthetic rollback"))
        throw error;
    }
  }
  disableTriggers() {
    this.db.run(
      "DROP TRIGGER spike_subscribers_ai; DROP TRIGGER spike_subscribers_au; DROP TRIGGER spike_subscribers_ad",
    );
  }
  search(term: string) {
    return this.db
      .query<{ rowid: bigint }, [string]>(
        "SELECT rowid FROM spike_subscribers_fts WHERE spike_subscribers_fts MATCH ? ORDER BY rowid",
      )
      .all(term)
      .map((r) => Number(r.rowid));
  }
  private campaign() {
    const row = this.db
      .query<{ last_subscriber_id: bigint; sent: bigint }, []>(
        "SELECT last_subscriber_id, sent FROM spike_campaigns WHERE id=1",
      )
      .get();
    return { cursor: Number(row?.last_subscriber_id ?? 0), sent: Number(row?.sent ?? 0) };
  }
  status() {
    const scalar = (sql: string) =>
      Object.values(this.db.query<Record<string, unknown>, []>(sql).get() ?? {})[0];
    const eventCounts = this.db
      .query<{ count: bigint; distinct_count: bigint }, []>(
        "SELECT count(*) AS count, count(DISTINCT subscriber_id || ':' || idempotency_key) AS distinct_count FROM spike_events",
      )
      .get()!;
    return {
      journal: scalar("PRAGMA journal_mode"),
      foreignKeys: String(scalar("PRAGMA foreign_keys")),
      synchronous: String(scalar("PRAGMA synchronous")),
      timeout: String(scalar("PRAGMA busy_timeout")),
      safeInteger: String(scalar("SELECT 9223372036854775807 AS n")),
      ...this.campaign(),
      events: Number(eventCounts.count),
      distinctEvents: Number(eventCounts.distinct_count),
      integrity: scalar("PRAGMA integrity_check"),
      foreignKeyErrors: this.db.query("PRAGMA foreign_key_check").all().length,
    };
  }
  verifyFts() {
    this.write("fts-check", 1, () =>
      this.db.run(
        "INSERT INTO spike_subscribers_fts(spike_subscribers_fts, rank) VALUES ('integrity-check', 1)",
      ),
    );
  }
  checkpoint() {
    return this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  }
  sizes() {
    const size = (name: string) =>
      existsSync(join(this.directory, name)) ? statSync(join(this.directory, name)).size : 0;
    return { databaseBytes: size("iglo-email.db"), walBytes: size("iglo-email.db-wal") };
  }
  sqliteVersion() {
    return this.db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()!
      .version;
  }
  close() {
    this.db.close(true);
  }
}
