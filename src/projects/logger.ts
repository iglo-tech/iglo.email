// Stderr lines per project (14-projects section 9; D151). Native. The same two kinds of line as
// createErrorLogger (src/app.ts), each prefixed with the project's slug or `instance`, so one
// process's stderr says where every line came from.
import type { ErrorLogger } from "@/app";
import type { LogBuffer } from "@/maintenance/log-buffer";

/** `[<slug>] ` or `[instance] `: the prefix of every stderr line. */
export function logPrefix(source: string): string {
  return `[${source}] `;
}

/** `buffer` is the project's own: GET /api/logs on its host shows only its lines. */
export function createSourceLogger(
  source: string,
  buffer?: Pick<LogBuffer, "add" | "attention">,
): ErrorLogger {
  const prefix = logPrefix(source);
  return {
    error(error) {
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

/** An instance line has no buffer yet: the instance Logs page is B143's. */
export function instanceAttention(message: string): void {
  console.error(logPrefix("instance") + message.replaceAll(/[\r\n]+/g, " "));
}
