// Native outbox: claim and recovery are journal-owned, SMTP is outside writes.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import type { ErrorLogger } from "@/app";
import type { Claimed, Sends } from "@/messaging/sends";
import type { createEmailer } from "@/messaging/email";
import { startLoop } from "@/loops/loop";

// A marketing send has exactly one SMTP recipient, its admitted subscriber.
const copies = (row: { kind: string }) => ({ copies: row.kind !== "marketing" });
/** Rows claimed per commit; their SMTP calls run in parallel on the pool. */
const batchSize = 10;

export function startOutbox(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  sends: Sends;
  emailer: ReturnType<typeof createEmailer>;
}) {
  options.sends.recover();
  let deadline: AbortController | undefined;
  let stopped = false;
  let failTimer!: (error: Error) => void;
  const timerFailure = new Promise<never>((_resolve, reject) => {
    failTimer = reject;
  });
  void timerFailure.catch(() => {});
  const arm = () => {
    deadline?.abort();
    deadline = undefined;
    const due = options.sends.nextDue();
    if (!due || stopped) return;
    const delay = Math.max(0, Date.parse(due) - options.clock.now().getTime());
    const controller = new AbortController();
    deadline = controller;
    void options.clock.sleep(delay, controller.signal).then(
      () => {
        if (deadline === controller) {
          deadline = undefined;
          loop.wake();
        }
      },
      () => {
        if (!controller.signal.aborted) {
          try {
            options.logger.error(new Error("Outbox deadline failed"));
          } catch {
            /* Preserve deadline failure. */
          }
          failTimer(new Error("Outbox deadline failed"));
          void loop.stop();
        }
      },
    );
  };
  const loop = startLoop({
    db: options.db,
    clock: options.clock,
    logger: { error: () => options.logger.error(new Error("Outbox failed")) },
    intervalMs: 1000,
    leaseMs: 60000,
    batchSize: 1,
    // One loop item is a batch: its claims and admissions committed together before SMTP.
    claim: (now, lease) => {
      const batch = options.sends.claimBatch(now, lease, batchSize);
      return batch.length ? [batch] : [];
    },
    async process(batch) {
      await deliver(batch);
      arm();
    },
  });
  /**
   * Push every admitted message of a committed batch and journal all outcomes in one commit.
   * A push that rejects leaves its row `sending` (recovered as `unknown`) and fails the caller.
   */
  async function deliver(batch: Claimed[]) {
    const pending = batch.flatMap(({ row, message }) =>
      message ? [{ row, result: options.emailer.push(message, copies(row)).result }] : [],
    );
    const settled = await Promise.allSettled(pending.map((p) => p.result));
    options.sends.finishAll(
      settled.flatMap((s, i) =>
        s.status === "fulfilled" ? [{ row: pending[i]!.row, outcome: s.value }] : [],
      ),
    );
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
  }
  options.sends.onWake(() => {
    loop.wake();
    arm();
  });
  arm();
  const inflight = new Set<Promise<void>>();
  const done = Promise.race([loop.done, timerFailure]);
  void done.catch(() => {});
  return {
    done,
    /**
     * Send specific just-committed queued rows now and resolve after their outcomes
     * are journaled. Call synchronously after the enqueue commit so the loop cannot
     * claim them first; a row it did claim is left to the loop. Retry deadlines and
     * unclaimed rows stay with the loop.
     */
    dispatch(ids: bigint[]): Promise<void> {
      if (stopped) return Promise.resolve();
      const now = options.clock.now();
      const lease = new Date(now.getTime() + 60000);
      const batch = options.sends.claimQueued(ids, now, lease);
      const all = deliver(batch).then(
        () => arm(),
        () => options.logger.error(new Error("Outbox dispatch failed")),
      );
      inflight.add(all);
      void all.finally(() => inflight.delete(all));
      return all;
    },
    async stop() {
      stopped = true;
      deadline?.abort();
      options.sends.onWake(() => {});
      try {
        await loop.stop();
      } finally {
        await Promise.allSettled(inflight);
      }
    },
  };
}
