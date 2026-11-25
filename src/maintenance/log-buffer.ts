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
  "An SES notice matched no project",
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
  "Sequence enrollment ended: the source could not be read",
  "Sequence aggregates failed: retrying later",
  "Sequence step has an aggregate past its limit: skipped",
  "Sequence decision failed: retrying later",
  "Sequence scheduler failed",
  "Sequence step could not be rendered: skipped",
  "Sequence step has no transactional template: skipped",
  "Source record failed for good: see the stream's retry queue",
  "Source stream cannot connect: retrying",
  "Source stream refused by the source: check the source settings",
  "Test send not delivered: the server error output names the recipient and stage",
  "unknown messenger on campaign: campaign cancelled",
  "A webhook target is refused by the private-address block",
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

/** Upstream's ring: at most `maxLines` kept, trimmed in steps so a push is amortized O(1). */
function createLines(clock: Clock, maxLines: number) {
  let lines: Array<string> = [];
  const push = (text: string) => {
    if (lines.length >= maxLines * 2) {
      lines = lines.slice(-maxLines + 1);
    }
    lines.push(`${stamp(clock.now())} *: ${text}`);
  };
  return { push, lines: () => lines.slice(-maxLines) };
}

export function createLogBuffer(clock: Clock, maxLines = MAX_LOG_LINES) {
  const { push, lines } = createLines(clock, maxLines);
  return {
    /** An unexpected error's line, in upstream's log format with `*` for its source file. */
    add(error: unknown) {
      push(`${UNEXPECTED} (${className(error)})`);
    },
    /** An attention line: its fixed text and nothing else. A mark outside the list reads as unexpected. */
    attention(safe: SafeMessage) {
      push(safeMessages.has(safe) ? safe : UNEXPECTED);
    },
    lines,
  };
}
export type LogBuffer = ReturnType<typeof createLogBuffer>;

/** Longest instance line kept; stderr has the whole text. */
const MAX_INSTANCE_TEXT = 1000;

/**
 * The instance's own lines (14-projects section 9; B143a, D157): the instance's attention lines
 * with their text, since only the instance admin reads them (the instance Logs page), and an
 * unexpected error as its class, as in a project's buffer.
 */
export function createInstanceLogBuffer(clock: Clock, maxLines = MAX_LOG_LINES) {
  const { push, lines } = createLines(clock, maxLines);
  return {
    add(error: unknown) {
      push(`${UNEXPECTED} (${className(error)})`);
    },
    attention(message: string) {
      push(message.replaceAll(/[\r\n]+/g, " ").slice(0, MAX_INSTANCE_TEXT));
    },
    lines,
  };
}
export type InstanceLogBuffer = ReturnType<typeof createInstanceLogBuffer>;

export interface LabelledLine {
  /** `instance` or a project's slug. */
  readonly source: string;
  readonly line: string;
}

/** The stamp every line starts with: `YYYY/MM/DD HH:MM:SS.ffffff`. */
const STAMP_LENGTH = 26;

/**
 * The instance Logs page's lines (B143a): every source's lines labelled by it, in time order (a
 * stable sort, so one source's lines keep their order), the newest `maxLines` of them, as bounded
 * as one buffer.
 */
export function mergeLogs(
  sources: ReadonlyArray<{ readonly source: string; readonly lines: ReadonlyArray<string> }>,
  maxLines = MAX_LOG_LINES,
): Array<LabelledLine> {
  const all = sources.flatMap(({ source, lines }) => lines.map((line) => ({ source, line })));
  all.sort((a, b) => {
    const left = a.line.slice(0, STAMP_LENGTH);
    const right = b.line.slice(0, STAMP_LENGTH);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return all.slice(-maxLines);
}
