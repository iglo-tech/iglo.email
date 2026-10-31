// Adapted from listmonk internal/buflog/buflog.go at 6fcd95f. Upstream's buffer takes every line of
// the process log. `settings:get` reads this one and is not an administrator, and no filter over
// free text is both complete and cheap, so the buffer never looks at the text of an error: a line
// is the time, a fixed message and the error's class. Whoever runs the host has the whole error on
// the process's stderr.
import type { Clock } from "@/clock";

/** Upstream's bufLog size. */
export const MAX_LOG_LINES = 5000;
/** Longest class name stored. */
const MAX_CLASS = 64;
/** The line of an error whose logger marked no message. */
const UNMARKED = "unexpected error";

/**
 * All a `settings:get` reader can be told beyond the class of an error. Each is a constant that
 * names no request, campaign, recipient or exception: a logger passes one of these or nothing.
 */
const SAFE_MESSAGES = [
  "campaign claims abandoned after the runner stopped: resend manually if needed",
  "campaign subscriber changed after its claim: message not sent",
  "error count limit reached: campaign paused",
  "error fetching campaign attachments: campaign paused",
  "error processing campaign",
  "error rendering campaign message",
  "error sending campaign message",
  "inline image not embedded: no such media",
  "Opt-in mail failed",
  "Opt-in mail queue is full",
  "Outbox deadline failed",
  "Outbox dispatch failed",
  "Outbox failed",
  "Password reset mail not sent",
  "Sequence condition failed: retrying later",
  "Sequence decision failed: retrying later",
  "Sequence scheduler failed",
  "Sequence step could not be rendered: skipped",
  "Sequence step has no transactional template: skipped",
  "unknown messenger on campaign: campaign cancelled",
  "Webhook deliveries are failing",
  "Webhook delivery failed",
] as const;
export type SafeMessage = (typeof SAFE_MESSAGES)[number];
const safeMessages = new Set<string>(SAFE_MESSAGES);

const className = (error: unknown) =>
  error instanceof Error ? error.constructor.name.slice(0, MAX_CLASS) : "not an Error";

const stamp = (at: Date) => {
  const iso = at.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "/")} ${iso.slice(11, 23)}000`;
};

export function createLogBuffer(clock: Clock, maxLines = MAX_LOG_LINES) {
  let lines: string[] = [];
  return {
    /** A line in upstream's log format, with `*` for its source file. */
    add(error: unknown, safe?: SafeMessage) {
      if (lines.length >= maxLines * 2) lines = lines.slice(-maxLines + 1);
      const message = safe !== undefined && safeMessages.has(safe) ? safe : UNMARKED;
      lines.push(`${stamp(clock.now())} *: ${message} (${className(error)})`);
    },
    lines: () => lines.slice(-maxLines),
  };
}
export type LogBuffer = ReturnType<typeof createLogBuffer>;
