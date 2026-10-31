// Application composition is adapted from listmonk's cmd/main.go App.
import type { Clock } from "@/clock";
import type { Database } from "bun:sqlite";
import type { BootstrapConfig } from "@/config/bootstrap";
import type { Translation } from "@/i18n/i18n";
import type { SafeMessage } from "@/maintenance/log-buffer";

export interface ErrorLogger {
  /** `safe` is what a `settings:get` reader may see of this error; stderr keeps all of it. */
  error(error: unknown, safe?: SafeMessage): void;
}

export interface App {
  readonly bootstrap: BootstrapConfig;
  readonly clock: Clock;
  readonly db: Database;
  readonly logger: ErrorLogger;
  readonly i18n: Translation;
}

export function createApp(dependencies: App): App {
  return { ...dependencies };
}

/** `buffer` keeps a line with no error text for GET /api/logs; the process's stderr keeps it all. */
export function createErrorLogger(buffer?: {
  add(error: unknown, safe?: SafeMessage): void;
}): ErrorLogger {
  return {
    error(error, safe) {
      console.error("Unexpected request error:", error);
      buffer?.add(error, safe);
    },
  };
}
