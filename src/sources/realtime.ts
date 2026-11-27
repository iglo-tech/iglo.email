// Native (15-external-sources section 4, D169 amended, D171): a `fetch`-based client for
// PocketBase's realtime stream (Bun has no `EventSource`). `GET /api/realtime` through the
// private-address guard, the first message (`PB_CONNECT`) names the client, then each message is
// parsed as server-sent events with bounded lines. The connection is closed by the client after
// `idleMs` without a byte (PocketBase closes an idle one after 5 minutes, so a silent connection
// is a dead one) and after `maxAgeMs` (PocketBase's forced close at 30 minutes), both on the
// injected clock. A close at any point is routine: the stream reconnects and catches up.
import type { Clock } from "@/clock";
import { guardedFetch, refusedMessage } from "@/sources/connect";
import type { Guard, SourceTransport } from "@/sources/connect";
import { isSourceObject, member, sourceJson } from "@/sources/json";
import { SourceError } from "@/sources/source";

/** PocketBase closes a connection after 5 idle minutes; a little longer means it is gone. */
export const IDLE_MS = 5 * 60_000 + 30_000;
/** PocketBase closes every connection after 30 minutes. */
export const MAX_AGE_MS = 30 * 60_000;
/** The time `PB_CONNECT` may take after the request. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** The longest line kept (in UTF-16 units); a longer message is reported as oversized. */
export const MAX_LINE = 1024 * 1024;

/** One server-sent event. `oversized` when a line was over the limit and its data was dropped. */
export interface SseMessage {
  event: string;
  data: string;
  oversized: boolean;
}

export interface RealtimeOptions {
  /** The source's base URL, without a trailing slash. */
  url: string;
  guard: Guard;
  transport?: SourceTransport | undefined;
  clock: Clock;
  signal: AbortSignal;
  idleMs?: number;
  maxAgeMs?: number;
  connectTimeoutMs?: number;
  maxLine?: number;
}

export interface RealtimeConnection {
  readonly clientId: string;
  /** The source's `Date` at connection: its clock, to start a new topic's marker at. */
  readonly sourceNow: Date | null;
  /**
   * The messages after `PB_CONNECT`. It ends when the source closes the stream, and throws a
   * transient `SourceError` when the client closed it (idle, age, a reset).
   */
  readonly messages: AsyncGenerator<SseMessage, void, void>;
  close(): void;
}

/**
 * Parses server-sent events from a byte stream. A line longer than `maxLine` is dropped up to its
 * end, and its message is yielded with `oversized`, so a huge message never sits in memory.
 */
export async function* sseMessages(
  chunks: AsyncIterable<Uint8Array>,
  maxLine: number,
  onBytes: () => void = () => {},
): AsyncGenerator<SseMessage, void, void> {
  const decoder = new TextDecoder();
  let pending = "";
  let dropping = false;
  let event = "";
  let data: Array<string> = [];
  let oversized = false;
  /** The current message's data, in UTF-16 units. */
  let size = 0;
  function* line(text: string): Generator<SseMessage, void, void> {
    const clean = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (clean === "") {
      if (data.length || oversized || event) {
        yield { event: event || "message", data: data.join("\n"), oversized };
      }
      event = "";
      data = [];
      oversized = false;
      size = 0;
      return;
    }
    if (clean.startsWith(":")) {
      return;
    }
    const colon = clean.indexOf(":");
    const field = colon < 0 ? clean : clean.slice(0, colon);
    let value = colon < 0 ? "" : clean.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data" && !oversized) {
      // A message's data lines together are bounded as one line is.
      size += value.length + 1;
      if (size > maxLine) {
        data = [];
        oversized = true;
      } else {
        data.push(value);
      }
    }
  }
  const take = function* (text: string): Generator<SseMessage, void, void> {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) {
        break;
      }
      const part = text.slice(start, end);
      start = end + 1;
      if (dropping) {
        dropping = false;
        pending = "";
        continue;
      }
      const whole = pending + part;
      pending = "";
      if (whole.length > maxLine) {
        oversized = true;
        data = [];
        continue;
      }
      yield* line(whole);
    }
    const rest = text.slice(start);
    if (dropping) {
      return;
    }
    if (pending.length + rest.length > maxLine) {
      // The line is over the limit: drop it up to its end, and mark its message.
      pending = "";
      dropping = true;
      oversized = true;
      data = [];
      return;
    }
    pending += rest;
  };
  for await (const chunk of chunks) {
    onBytes();
    yield* take(decoder.decode(chunk, { stream: true }));
  }
  yield* take(decoder.decode());
}

/** Opens a realtime connection and reads its `PB_CONNECT`. */
export async function openRealtime(options: RealtimeOptions): Promise<RealtimeConnection> {
  const { clock } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const connection = new AbortController();
  const signal = AbortSignal.any([options.signal, connection.signal]);
  /** Ends the connection with a transient reason (the client's own close). */
  const end = (reason: string) => {
    if (!connection.signal.aborted) {
      connection.abort(new SourceError("transient", reason));
    }
  };
  const timers = new AbortController();
  signal.addEventListener("abort", () => timers.abort(), { once: true });
  const lost = (error: unknown): SourceError => {
    options.signal.throwIfAborted();
    if (connection.signal.aborted && connection.signal.reason instanceof SourceError) {
      return connection.signal.reason;
    }
    return new SourceError("transient", `The realtime stream is unreachable: ${String(error)}`);
  };
  const url = new URL("api/realtime", options.url.endsWith("/") ? options.url : `${options.url}/`);
  const headers = new Headers({
    Accept: "text/event-stream",
    "Cache-Control": "no-store",
    "User-Agent": "iglo.email",
  });
  // The connect deadline: PB_CONNECT must arrive in time.
  const connecting = new AbortController();
  timers.signal.addEventListener("abort", () => connecting.abort(), { once: true });
  void clock.sleep(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, connecting.signal).then(
    () => end("The realtime stream did not connect in time"),
    () => {},
  );
  let response: Response;
  try {
    // B166 (D194): a resolver cannot be cancelled, so the request races the signal (the connect
    // deadline, a stop, a settings switch), as the adapter's requests do. A response that comes
    // after the race was lost has its body cancelled.
    const pending = guardedFetch(
      url,
      { method: "GET", headers, signal },
      options.guard,
      options.transport ?? {},
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
      } else {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
    });
    aborted.catch(() => {});
    void pending.then(
      (late) => {
        if (signal.aborted && "status" in late) {
          void late.body?.cancel().catch(() => {});
        }
      },
      () => {},
    );
    const outcome = await Promise.race([pending, aborted]);
    if (!("status" in outcome)) {
      timers.abort();
      throw new SourceError("permanent", refusedMessage(outcome.refused));
    }
    response = outcome;
  } catch (error) {
    timers.abort();
    if (error instanceof SourceError) {
      throw error;
    }
    throw lost(error);
  }
  if (response.status !== 200 || !response.body) {
    timers.abort();
    void response.body?.cancel().catch(() => {});
    const kind = response.status === 429 || response.status >= 500 ? "transient" : "permanent";
    throw new SourceError(
      kind,
      `The source refused the realtime stream: ${response.status}`,
      response.status,
    );
  }
  const date = response.headers.get("date");
  const sourceNow = date && Number.isFinite(Date.parse(date)) ? new Date(Date.parse(date)) : null;
  let lastByte = clock.now().getTime();
  const opened = lastByte;
  const body = response.body;
  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    const reader = body.getReader();
    const aborted = new Promise<never>((_resolve, reject) => {
      // A caller's abort rejects with its reason (`lost` throws it), the client's own close with
      // its transient reason.
      const fail = () => {
        try {
          reject(lost(signal.reason));
        } catch (error) {
          reject(error);
        }
      };
      if (signal.aborted) {
        fail();
      } else {
        signal.addEventListener("abort", fail, { once: true });
      }
    });
    aborted.catch(() => {});
    try {
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await Promise.race([reader.read(), aborted]);
        } catch (error) {
          throw error instanceof SourceError ? error : lost(error);
        }
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
  const parsed = sseMessages(chunks(), options.maxLine ?? MAX_LINE, () => {
    lastByte = clock.now().getTime();
  });
  // PB_CONNECT first.
  let first: IteratorResult<SseMessage, void>;
  try {
    first = await parsed.next();
  } catch (error) {
    timers.abort();
    connection.abort();
    throw error instanceof SourceError ? error : lost(error);
  }
  const payload = first.done ? undefined : safeJson(first.value.data);
  const clientId = member(payload, "clientId");
  if (
    first.done ||
    first.value.event !== "PB_CONNECT" ||
    typeof clientId !== "string" ||
    !clientId
  ) {
    timers.abort();
    connection.abort();
    throw new SourceError("transient", "The realtime stream did not start with PB_CONNECT");
  }
  connecting.abort();
  // The idle and age watchdogs, on the injected clock.
  void (async () => {
    try {
      for (;;) {
        const now = clock.now().getTime();
        const idleLeft = lastByte + idleMs - now;
        const ageLeft = opened + maxAgeMs - now;
        if (ageLeft <= 0) {
          end("The realtime connection reached its age limit");
          return;
        }
        if (idleLeft <= 0) {
          end("The realtime connection was idle too long");
          return;
        }
        await clock.sleep(Math.min(idleLeft, ageLeft), timers.signal);
      }
    } catch {
      /* The connection ended. */
    }
  })();
  return {
    clientId,
    sourceNow,
    messages: parsed,
    close() {
      timers.abort();
      if (!connection.signal.aborted) {
        connection.abort(new SourceError("transient", "The realtime connection was closed"));
      }
    },
  };
}

/** A message's JSON, or `undefined` when it is not JSON. */
export function safeJson(text: string) {
  try {
    const value = sourceJson(JSON.parse(text));
    return isSourceObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
