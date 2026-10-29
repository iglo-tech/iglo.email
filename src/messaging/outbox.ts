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
          options.logger.error(new Error("Outbox deadline failed"));
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
  const done = Promise.race([loop.done, timerFailure]);
  void done.catch(() => {});
  return {
    done,
    stop() {
      stopped = true;
      deadline?.abort();
      options.sends.onWake(() => {});
      return loop.stop();
    },
  };
}
