// Adapted from listmonk internal/buflog/buflog.go at 6fcd95f. Upstream's buffer takes every line of
// the process log. `settings:get` reads this one and is not an administrator, and no filter over
// free text is both complete and cheap, so the buffer never looks at the text of an error: a line
// is the time and either a fixed message (an attention line, which is a message, not an exception)
// or the error's class (an unexpected error). Whoever runs the host has the whole text on the
// process's stderr.
import type { Clock } from "@/clock";

/** Upstream's bufLog size. */
export const MAX_LOG_LINES = 5000;
/** Longest class name stored. */
const MAX_CLASS = 64;
/** The text of an unexpected error's line, and of an attention mark that is not in the list. */
const UNEXPECTED = "unexpected error";

/**
 * All a `settings:get` reader can be told of an attention line. Each is a constant that names no
 * request, campaign, recipient or exception: a logger passes one of these with its message.
 */
const SAFE_MESSAGES = [
  "A test send bounced",
  "A test send got a complaint",
  "Admin notification address is not valid: skipped",
  "Admin notifications not sent: app.from_email is not valid",
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
  "Sequence aggregates failed: retrying later",
  "Sequence step has an aggregate past its limit: skipped",
  "Sequence decision failed: retrying later",
  "Sequence scheduler failed",
  "Sequence step could not be rendered: skipped",
  "Sequence step has no transactional template: skipped",
  "Test send not delivered: the server error output names the recipient and stage",
  "unknown messenger on campaign: campaign cancelled",
  "Webhook deliveries are failing",
  "Webhook delivery failed",
  "X-Forwarded-For from an untrusted peer ignored: see security.trusted_proxies",
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
  const push = (text: string) => {
    if (lines.length >= maxLines * 2) lines = lines.slice(-maxLines + 1);
    lines.push(`${stamp(clock.now())} *: ${text}`);
  };
  return {
    /** An unexpected error's line, in upstream's log format with `*` for its source file. */
    add(error: unknown) {
      push(`${UNEXPECTED} (${className(error)})`);
    },
    /** An attention line: its fixed text and nothing else. A mark outside the list reads as unexpected. */
    attention(safe: SafeMessage) {
      push(safeMessages.has(safe) ? safe : UNEXPECTED);
    },
    lines: () => lines.slice(-maxLines),
  };
}
export type LogBuffer = ReturnType<typeof createLogBuffer>;
