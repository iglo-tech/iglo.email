// A clock is injected so application time and delays can be controlled by callers.
export interface Clock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export function createRealClock(): Clock {
  return {
    now: () => new Date(),
    sleep(milliseconds, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, milliseconds);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
