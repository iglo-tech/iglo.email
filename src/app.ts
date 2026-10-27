// Application composition is adapted from listmonk's cmd/main.go App.
import type { Clock } from "@/clock";
import type { Database } from "bun:sqlite";
import type { BootstrapConfig } from "@/config/bootstrap";
import type { Translation } from "@/i18n/i18n";

export interface ErrorLogger {
  error(error: unknown): void;
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

export function createErrorLogger(): ErrorLogger {
  return { error: (error) => console.error("Unexpected request error:", error) };
}
