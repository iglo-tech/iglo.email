// New SQLite FTS5 isolation workload; no corresponding upstream FTS5 implementation.
import assert from "node:assert/strict";
import { join } from "node:path";
import { SpikeStore, type Mutation } from "@/test/perf/sqlite-write-load/store";

export function runFtsIsolation(
  root: string,
  triggers: boolean,
  repetition: number,
  subscribers: number,
  cycles: number,
) {
  const runDir = join(root, `fts-${triggers ? "enabled" : "disabled"}-${repetition}`);
  let store = new SpikeStore(runDir);
  const seedStarted = performance.now();
  store.seed(subscribers);
  const seedMs = performance.now() - seedStarted;
  if (!triggers) store.disableTriggers();
  const transactionMs: number[] = [];
  let attemptedOperations = 0;
  store.observer = (_kind, size, ms) => {
    attemptedOperations += size;
    transactionMs.push(ms);
  };
  const started = performance.now();
  let rolledBackCycles = 0;
  for (let first = 0; first < cycles; first += 25) {
    const operations: Mutation[] = [];
    const count = Math.min(25, cycles - first);
    for (let offset = 0; offset < count; offset++) {
      const id = subscribers + first + offset + 1;
      operations.push(
        { operation: "insert", id, name: `Churn original ${id}`, email: `churn${id}@example.test` },
        {
          operation: "update",
          id,
          name: `Churn changed ${id}`,
          email: `updated${id}@example.test`,
        },
        { operation: "delete", id },
      );
    }
    if (first % 250 === 0) {
      store.mutate(operations, true);
      rolledBackCycles += count;
    }
    store.mutate(operations);
  }
  const elapsedMs = performance.now() - started;
  store.observer = undefined;
  assert.equal(attemptedOperations, (cycles + rolledBackCycles) * 3);
  assert.deepEqual(store.search("churn"), []);
  store.verifyFts();
  const status = store.status();
  assert.equal(status.integrity, "ok");
  assert.equal(status.foreignKeyErrors, 0);
  const sizesBeforeCheckpoint = store.sizes();
  const checkpointStarted = performance.now();
  const checkpoint = store.checkpoint();
  const checkpointMs = performance.now() - checkpointStarted;
  const sizesAfterCheckpoint = store.sizes();
  store.close();
  store = new SpikeStore(runDir);
  assert.deepEqual(store.status(), status);
  store.verifyFts();
  store.close();
  const sorted = [...transactionMs].sort((a, b) => a - b);
  const percentile = (n: number) => sorted[Math.ceil(sorted.length * n) - 1]!;
  return {
    kind: "fts-isolation",
    run: "comparison",
    triggers,
    repetition,
    seedMs,
    cycles,
    rolledBackCycles,
    attemptedOperations,
    transactionCount: transactionMs.length,
    elapsedMs,
    transactionMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: percentile(1),
    },
    sizesBeforeCheckpoint,
    sizesAfterCheckpoint,
    checkpoint,
    checkpointMs,
    status,
  };
}
