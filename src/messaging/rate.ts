// Account-wide send-rate limiter for SES (D92).
import type { Clock } from "@/clock";

export type SendPriority = "outbox" | "campaign";

export interface SendRateLimiterOptions {
  clock: Clock;
  rate: () => number;
}

interface Waiter {
  priority: SendPriority;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal | undefined;
  cleanup?: () => void;
}

export interface SendRateLimiter {
  acquire(priority?: SendPriority, signal?: AbortSignal): Promise<void>;
  stop(): void;
  wake(): void;
}

export function createSendRateLimiter(options: SendRateLimiterOptions): SendRateLimiter {
  const { clock } = options;
  const outboxWaiters: Waiter[] = [];
  const campaignWaiters: Waiter[] = [];
  let stopped = false;
  let sleepController: AbortController | null = null;
  let nextAvailableAt = 0;
  let pumping = false;

  function scheduleNextWake(delay: number): void {
    if (stopped || sleepController) return;
    const controller = new AbortController();
    sleepController = controller;

    void clock.sleep(delay, controller.signal).then(
      () => {
        if (sleepController === controller) {
          sleepController = null;
          pump();
        }
      },
      () => {
        if (sleepController === controller) {
          sleepController = null;
        }
      },
    );
  }

  function pump(): void {
    if (stopped || pumping) return;
    pumping = true;
    try {
      while (outboxWaiters.length > 0 || campaignWaiters.length > 0) {
        if (stopped) break;
        const currentRate = options.rate();
        const now = clock.now().getTime();

        if (currentRate <= 0) {
          const waiter =
            outboxWaiters.length > 0 ? outboxWaiters.shift()! : campaignWaiters.shift()!;
          waiter.cleanup?.();
          waiter.resolve();
          continue;
        }

        const interval = 1000 / currentRate;
        if (nextAvailableAt < now) {
          nextAvailableAt = now;
        }

        if (nextAvailableAt <= now) {
          const waiter =
            outboxWaiters.length > 0 ? outboxWaiters.shift()! : campaignWaiters.shift()!;
          waiter.cleanup?.();
          nextAvailableAt += interval;
          waiter.resolve();
        } else {
          const delay = Math.max(1, Math.ceil(nextAvailableAt - now));
          scheduleNextWake(delay);
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function acquire(priority: SendPriority = "outbox", signal?: AbortSignal): Promise<void> {
    if (stopped || signal?.aborted) {
      return Promise.reject(signal?.reason ?? new Error("Rate limiter stopped"));
    }

    const currentRate = options.rate();
    const now = clock.now().getTime();

    if (currentRate <= 0) {
      return Promise.resolve();
    }

    const interval = 1000 / currentRate;
    const noWaiters =
      outboxWaiters.length === 0 && (priority === "outbox" || campaignWaiters.length === 0);

    if (noWaiters) {
      if (nextAvailableAt < now) {
        nextAvailableAt = now;
      }
      if (nextAvailableAt <= now) {
        nextAvailableAt += interval;
        return Promise.resolve();
      }
    }

    return new Promise<void>((resolve, reject) => {
      let waiter: Waiter;

      const abortHandler = () => {
        if (priority === "outbox") {
          const idx = outboxWaiters.indexOf(waiter);
          if (idx >= 0) outboxWaiters.splice(idx, 1);
        } else {
          const idx = campaignWaiters.indexOf(waiter);
          if (idx >= 0) campaignWaiters.splice(idx, 1);
        }
        waiter.cleanup?.();
        reject(signal?.reason ?? new Error("Aborted"));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      waiter = {
        priority,
        resolve,
        reject,
        signal,
        cleanup: () => {
          if (signal) {
            signal.removeEventListener("abort", abortHandler);
          }
        },
      };

      if (priority === "outbox") {
        outboxWaiters.push(waiter);
      } else {
        campaignWaiters.push(waiter);
      }

      pump();
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;

    if (sleepController) {
      sleepController.abort();
      sleepController = null;
    }

    const err = new Error("Rate limiter stopped");
    while (outboxWaiters.length > 0) {
      const waiter = outboxWaiters.shift()!;
      waiter.cleanup?.();
      waiter.reject(err);
    }
    while (campaignWaiters.length > 0) {
      const waiter = campaignWaiters.shift()!;
      waiter.cleanup?.();
      waiter.reject(err);
    }
  }

  function wake(): void {
    if (sleepController) {
      sleepController.abort();
      sleepController = null;
    }
    pump();
  }

  return { acquire, stop, wake };
}
