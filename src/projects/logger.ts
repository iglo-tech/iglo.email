// Stderr lines per project (14-projects section 9; D151). Native. The same two kinds of line as
// createErrorLogger (src/app.ts), each prefixed with the project's slug or `instance`, so one
// process's stderr says where every line came from.
import type { ErrorLogger } from "@/app";
import type { InstanceLogBuffer, LogBuffer } from "@/maintenance/log-buffer";

/** `[<slug>] ` or `[instance] `: the prefix of every stderr line. */
export function logPrefix(source: string): string {
  return `[${source}] `;
}

/**
 * `buffer` is the project's own: GET /api/logs on its host shows only its lines. An error
 * `expected` accepts is left out: one the instance has already reported (B155a, D176).
 */
export function createSourceLogger(
  source: string,
  buffer?: Pick<LogBuffer, "add" | "attention">,
  expected?: (error: unknown) => boolean,
): ErrorLogger {
  const prefix = logPrefix(source);
  return {
    error(error) {
      if (expected?.(error)) {
        return;
      }
      console.error(`${prefix}Unexpected request error:`, error);
      buffer?.add(error);
    },
    attention(message, safe) {
      // One line: a line break in a recipient's or a provider's text would make a second one.
      console.error(prefix + message.replaceAll(/[\r\n]+/g, " "));
      buffer?.attention(safe);
    },
  };
}

/**
 * An instance line on stderr only. The instance's own lines also go to its buffer through
 * createInstanceLogger; this is for a module that is given no logger (the instance settings).
 */
export function instanceAttention(message: string): void {
  console.error(logPrefix("instance") + message.replaceAll(/[\r\n]+/g, " "));
}

/**
 * The instance's logger (B143a, D157): stderr as before, and the instance buffer the instance Logs
 * page shows, with each attention line's whole text (only the instance admin reads it).
 */
export function createInstanceLogger(buffer: InstanceLogBuffer) {
  const prefix = logPrefix("instance");
  const attention = (message: string) => {
    instanceAttention(message);
    buffer.attention(message);
  };
  const logger: ErrorLogger = {
    error(error) {
      console.error(`${prefix}Unexpected request error:`, error);
      buffer.add(error);
    },
    attention: (message) => attention(message),
  };
  return { logger, attention };
}
