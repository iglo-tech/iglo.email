// A migrated synthetic database for condition tests, with the in-memory model the reference
// evaluator reads. Rows are generated data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionEvaluator } from "@/conditions/evaluate";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createQueryRunner, openReadOnly } from "@/subscribers/query-runner";
import { TestClock } from "@/test/server/fixture";

export interface ModelEvent {
  name: string;
  data: Record<string, unknown>;
  occurredAt: string;
}
export interface ModelSubscriber {
  id: bigint;
  status: "enabled" | "disabled" | "blocklisted";
  attribs: Record<string, unknown>;
  lists: { list: number; status: "unconfirmed" | "confirmed" | "unsubscribed" }[];
  events: ModelEvent[];
}

export async function conditionsFixture(
  options: { timeoutMs?: number; memoryBytes?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "iglo-conditions-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const readonly = openReadOnly(db.filename);
  const runner = createQueryRunner({
    path: db.filename,
    timeoutMs: options.timeoutMs ?? 5_000,
    concurrency: 2,
    ...(options.memoryBytes ? { memoryBytes: options.memoryBytes } : {}),
  });
  const evaluator = createConditionEvaluator({ readonly, runner });
  const subscribers: ModelSubscriber[] = [];
  let serial = 0;
  const lists: number[] = [];

  const addList = (name: string) => {
    const row = db
      .query("INSERT INTO lists (uuid, name, type) VALUES (?, ?, 'private') RETURNING id")
      .get(crypto.randomUUID(), name) as { id: bigint };
    lists.push(Number(row.id));
    return Number(row.id);
  };
  const addSubscriber = (
    input: Partial<Omit<ModelSubscriber, "id">> & { attribsJSON?: string } = {},
  ): ModelSubscriber => {
    serial++;
    const attribsJSON = input.attribsJSON ?? JSON.stringify(input.attribs ?? {});
    const row = db
      .query(
        "INSERT INTO subscribers (uuid, email, name, attribs, status) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get(
        crypto.randomUUID(),
        `s${serial}@example.test`,
        `S ${serial}`,
        attribsJSON,
        input.status ?? "enabled",
      ) as { id: bigint };
    const subscriber: ModelSubscriber = {
      id: row.id,
      status: input.status ?? "enabled",
      attribs: JSON.parse(attribsJSON) as Record<string, unknown>,
      lists: [],
      events: [],
    };
    for (const m of input.lists ?? []) addMembership(subscriber, m.list, m.status);
    for (const e of input.events ?? []) addEvent(subscriber, e.name, e.data, e.occurredAt);
    subscribers.push(subscriber);
    return subscriber;
  };
  const addMembership = (
    subscriber: ModelSubscriber,
    list: number,
    status: ModelSubscriber["lists"][number]["status"],
  ) => {
    db.query("INSERT INTO subscriber_lists (subscriber_id, list_id, status) VALUES (?, ?, ?)").run(
      subscriber.id,
      list,
      status,
    );
    subscriber.lists.push({ list, status });
  };
  const addEvent = (
    subscriber: ModelSubscriber,
    name: string,
    data: Record<string, unknown>,
    occurredAt: string,
  ) => {
    db.query(
      "INSERT INTO events (subscriber_id, name, data, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(subscriber.id, name, JSON.stringify(data), occurredAt, occurredAt);
    subscriber.events.push({ name, data, occurredAt });
  };
  return {
    db,
    readonly,
    runner,
    evaluator,
    clock,
    subscribers,
    lists,
    addList,
    addSubscriber,
    addMembership,
    addEvent,
    async close() {
      evaluator.close();
      await runner.close();
      readonly.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type ConditionsFixture = Awaited<ReturnType<typeof conditionsFixture>>;
