// Native outbox: claim and recovery are journal-owned, SMTP is outside writes.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import type { ErrorLogger } from "@/app";
import type { Sends } from "@/messaging/sends";
import type { createEmailer } from "@/messaging/email";
import { startLoop } from "@/loops/loop";

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
    claim: (now, lease) => options.sends.claim(now, lease),
    async process(row) {
      const message = options.sends.admit(row);
      if (!message) return;
      const outcome = await options.emailer.push(message).result;
      options.sends.finish(row, outcome);
      arm();
    },
  });
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
      const work: Promise<void>[] = [];
      for (const id of ids) {
        const row = options.sends.claimQueued(id, now, lease);
        if (!row) continue;
        const message = options.sends.admit(row);
        if (!message) continue;
        work.push(
          options.emailer.push(message).result.then((outcome) => {
            options.sends.finish(row, outcome);
            arm();
          }),
        );
      }
      const all = Promise.all(work).then(
        () => {},
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
