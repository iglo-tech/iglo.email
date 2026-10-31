// Adapted from listmonk internal/buflog/buflog.go at 6fcd95f. Upstream's buffer takes every line of
// the process log; this one holds what the app logs as errors, after redact(), because
// `settings:get` reads it and that permission is not an administrator's.
import type { Clock } from "@/clock";

/** Upstream's bufLog size. */
export const MAX_LOG_LINES = 5000;
/** Longest stored message, after redaction, so that a cut never reveals a redacted value. */
const MAX_LINE = 500;

// Order matters: a URL can hold an address, and a quoted value can hold anything.
const rules: [RegExp, string][] = [
  [/\p{Cc}+/gu, " "],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  [/"[^"]*"|'[^']*'|`[^`]*`/g, "[quoted]"],
  [/[^\s@<>()[\],;:]+@[^\s@<>()[\],;:]+/g, "[address]"],
  [
    /\b(authorization|basic|bearer|token)\b[\s:=]+(?:(?:basic|bearer|token)\s+)?\S+/gi,
    "$1 [secret]",
  ],
  [/\b(password|passwd|pwd|secret|api[_-]?key|credentials?)\b[\s:=]+\S+/gi, "$1 [secret]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]"],
  [/(?:\b[0-9a-f]{1,4})?(?:::?[0-9a-f]{1,4}){2,7}\b(?:::)?/gi, "[ip]"],
  [/\b[A-Za-z0-9+/_-]{24,}={0,2}/g, "[secret]"],
];

/**
 * What of a logged error may be shown to a `settings:get` reader. Only the message: a stack or a
 * cause adds no fact an operator can act on here, and stderr still has them. A logged message can
 * quote a subscriber, an SMTP reply or a request, so anything with the shape of an address, a
 * URL, a credential, a client address or quoted input goes.
 */
export function redact(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : "Non-error value logged";
  return rules
    .reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
    .trim()
    .slice(0, MAX_LINE);
}

const stamp = (at: Date) => {
  const iso = at.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "/")} ${iso.slice(11, 23)}000`;
};

export function createLogBuffer(clock: Clock, maxLines = MAX_LOG_LINES) {
  let lines: string[] = [];
  return {
    /** A line in upstream's log format, with `*` for its source file. */
    add(error: unknown) {
      if (lines.length >= maxLines * 2) lines = lines.slice(-maxLines + 1);
      lines.push(`${stamp(clock.now())} *: ${redact(error)}`);
    },
    lines: () => lines.slice(-maxLines),
  };
}
export type LogBuffer = ReturnType<typeof createLogBuffer>;
