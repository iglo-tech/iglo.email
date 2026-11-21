// Application composition is adapted from listmonk's cmd/main.go App.
import type { Clock } from "@/clock";
import type { Database } from "bun:sqlite";
import type { BootstrapConfig } from "@/config/bootstrap";
import type { Translation } from "@/i18n/i18n";
import type { LogBuffer, SafeMessage } from "@/maintenance/log-buffer";

export interface ErrorLogger {
  /** An unexpected error: its stack goes to stderr; the log buffer keeps only its class. */
  error(error: unknown): void;
  /**
   * An attention line: something that needs a person to look, not an exception. Stderr gets
   * `message` as one plain line; the log buffer keeps only `safe`, a fixed text.
   */
  attention(message: string, safe: SafeMessage): void;
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
export function createErrorLogger(buffer?: Pick<LogBuffer, "add" | "attention">): ErrorLogger {
  return {
    error(error) {
      console.error("Unexpected request error:", error);
      buffer?.add(error);
    },
    attention(message, safe) {
      // One line: a line break in a recipient's or a provider's text would make a second one.
      console.error(message.replaceAll(/[\r\n]+/g, " "));
      buffer?.attention(safe);
    },
  };
}
