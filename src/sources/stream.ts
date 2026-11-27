// Native (15-external-sources sections 3 and 4, D169 amended, D171): a project's realtime stream
// from its source. One connection at a time: connect (`PB_CONNECT`), keep a marker per topic,
// subscribe, and buffer what arrives; catch up each topic from its marker minus the lookback in
// `(stamp, id)` keyset pages, skipping what the dedupe table holds; then drain the buffer and go on
// live. Every record goes to the `RecordHandler`, one at a time; a marker moves only after its
// records are committed. A reset or close at any point is routine: reconnect and catch up again.
// Attention is written only after `ATTENTION_AFTER_MS` of failing to get live, or once per cause
// of a permanent refusal (again only after a session got live). A record lacking a configured
// field is such a refusal: nothing is consumed. A record the handler fails on goes to the retry
// queue, which a loop on the injected clock works through without ever holding the stream up;
// terminal records write one line per cause until a record is handled again.
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { createLoop } from "@/loops/loop";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { Guard, SourceTransport } from "@/sources/connect";
import { sourceDate } from "@/sources/filter";
import { member } from "@/sources/json";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { openRealtime, safeJson } from "@/sources/realtime";
import type { RealtimeOptions, SseMessage } from "@/sources/realtime";
import { must } from "@/invariant";
import { isSourceError, PAGE_LIMIT, SourceError } from "@/sources/source";
import { isSettingsMismatch } from "@/sources/stream-record";
import type {
  RecordCommit,
  RecordHandler,
  StreamItem,
  StreamKind,
  StreamSource,
} from "@/sources/stream-record";
import { createStreamStore } from "@/sources/stream-store";
import type { RetryClaim } from "@/sources/stream-store";

/** A catch-up reads from each marker minus this, for commits that land out of order. */
export const LOOKBACK_MS = 15_000;
/** Failing to get live for this long writes one attention line. */
export const ATTENTION_AFTER_MS = 15 * 60_000;
/** Reconnect waits: after a routine close, and the cap of the doubling after failures. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 60_000;
/** After a permanent refusal, the next try (the settings may have been fixed). */
export const REFUSED_RETRY_MS = 5 * 60_000;
/** How often the subscribed names are compared with the sequences and rules. */
export const TOPIC_CHECK_MS = 15_000;
/** The most buffered message text (UTF-16 units) while catching up; past it, catch up again. */
export const BUFFER_LIMIT = 4 * 1024 * 1024;
/** Retry queue: backoff bounds, the window after which a record is terminal, and terminal rows' life. */
export const RETRY_MIN_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
export const RETRY_WINDOW_MS = 72 * 3_600_000;
export const TERMINAL_KEEP_MS = 30 * 24 * 3_600_000;
const RETRY_INTERVAL_MS = 15_000;
const RETRY_LEASE_MS = 5 * 60_000;
const RETRY_BATCH = 20;

const CANNOT_CONNECT: SafeMessage = "Source stream cannot connect: retrying";
const REFUSED: SafeMessage = "Source stream refused by the source: check the source settings";
const TERMINAL: SafeMessage = "Source record failed for good: see the stream's retry queue";

export type StreamState = "stopped" | "idle" | "connecting" | "catching-up" | "live" | "waiting";

export interface SourceStreamOptions {
  db: Database;
  clock: Clock;
  logger: Pick<ErrorLogger, "attention" | "error">;
  /** The source's settings (a changed source is a new stream). */
  config: PocketBaseConfig;
  guard: Guard;
  transport?: SourceTransport | undefined;
  /** The adapter's stream part (`createPocketBaseSource(...).stream`). */
  source: StreamSource;
  handler: RecordHandler;
  /** The event names to subscribe to, read at each connection and each check (src/sources/stream-names.ts). */
  names: () => ReadonlyArray<string>;
  /** Limits a test may lower; the defaults are the production values. */
  tuning?: Partial<{
    lookbackMs: number;
    pageSize: number;
    bufferLimit: number;
    idleMs: number;
    maxAgeMs: number;
    maxLine: number;
  }>;
}

/** Why a session ended on purpose. */
const REFRESH = Symbol("refresh");

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const digest = (parts: ReadonlyArray<string>) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

/** Messages received while the stream catches up or handles a record, bounded by their text. */
function createBuffer(limit: number) {
  let queue: Array<SseMessage> = [];
  let head = 0;
  let size = 0;
  let overflowed = false;
  let ended = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  return {
    push(message: SseMessage) {
      const cost = message.data.length + message.event.length;
      if (message.oversized || size + cost > limit) {
        // Past the limit: drop what is held and catch up again; the source still has every record.
        queue = [];
        head = 0;
        size = 0;
        overflowed = true;
      } else {
        queue.push(message);
        size += cost;
      }
      notify();
    },
    end(error?: unknown) {
      ended = true;
      if (error !== undefined) {
        failure = { error };
      }
      notify();
    },
    /** The next message, "overflow" when some were dropped, "end" when the connection ended. */
    async next(signal: AbortSignal): Promise<SseMessage | "overflow" | "end"> {
      for (;;) {
        signal.throwIfAborted();
        if (overflowed) {
          overflowed = false;
          return "overflow";
        }
        if (head < queue.length) {
          const message = must(queue[head], "buffered message");
          head++;
          size -= message.data.length + message.event.length;
          if (head > 1024 && head * 2 > queue.length) {
            queue = queue.slice(head);
            head = 0;
          }
          return message;
        }
        if (ended) {
          if (failure) {
            throw failure.error;
          }
          return "end";
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            signal.removeEventListener("abort", done);
            resolve();
          };
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
      }
    },
  };
}

export function createSourceStream(options: SourceStreamOptions) {
  const { db, clock, config, source, handler } = options;
  const tuning = options.tuning ?? {};
  const lookbackMs = tuning.lookbackMs ?? LOOKBACK_MS;
  const pageSize = tuning.pageSize ?? PAGE_LIMIT;
  const bufferLimit = tuning.bufferLimit ?? BUFFER_LIMIT;
  const store = createStreamStore(db);
  const stopping = new AbortController();
  const eventsId = digest([config.url, config.events.collection, config.events.name]);
  const usersId = digest([config.url, config.users.collection, config.users.leavingFilter]);
  const eventKey = (name: string) => `event:${eventsId}:${name}`;
  const userKey = `user:${usersId}`;
  /** Each retry row names its source by the same digest as the markers (D177). */
  const sources = { event: eventsId, user: usersId };
  // A new source ignores history: before either loop starts, the queue keeps only this source's
  // rows. Rows from before the queue named its source go to the source whose markers are kept.
  writeTransaction(db, () => {
    const topics = [...store.markers().keys()];
    store.keepSources(sources, {
      event: topics.some((topic) => topic.startsWith(`event:${eventsId}:`)),
      user: topics.includes(userKey),
    });
  });

  let state: StreamState = "stopped";
  let sessions = 0;
  /** The names the current connection subscribed to, one per line. */
  let subscribed: string | undefined;
  let current: AbortController | undefined;
  let waking: AbortController | undefined;
  let running: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;

  const attention = (safe: SafeMessage, detail: string) => {
    try {
      options.logger.attention(`${safe}: ${detail}`, safe);
    } catch {
      /* Logging never changes the stream. */
    }
  };
  /**
   * Record-level lines (a terminal record, a retry the settings refuse): one per kind and cause
   * until a record or retry of the same kind is handled again, so one wrong mapping or failing
   * handler never floods the log, and the other kind working does not reopen it (D177).
   */
  const recordWarned: Record<StreamKind, Set<string>> = { event: new Set(), user: new Set() };
  const recordAttention = (
    safe: SafeMessage,
    item: { kind: StreamKind; id: string },
    error: unknown,
  ) => {
    const cause = `${safe}\0${describe(error).replaceAll(item.id, "")}`;
    if (!recordWarned[item.kind].has(cause)) {
      recordWarned[item.kind].add(cause);
      attention(safe, `${item.kind} ${item.id}: ${describe(error)}`);
    }
  };
  const unexpected = (error: unknown) => {
    try {
      options.logger.error(error);
    } catch {
      /* Logging never changes the stream. */
    }
  };

  const namesNow = () => [...new Set(options.names())].sort();

  /**
   * Moves the markers of `keys` to `stamp` and prunes the dedupe entries the lookback can no longer
   * reach (in a transaction).
   */
  function moveMarkers(kind: StreamKind, keys: ReadonlyArray<string>, stamp: Date) {
    store.advance(keys, stamp);
    const prefix = kind === "event" ? "event:" : "user:";
    let oldest: string | undefined;
    for (const [topic, marker] of store.markers()) {
      if (topic.startsWith(prefix) && (oldest === undefined || marker < oldest)) {
        oldest = marker;
      }
    }
    if (oldest !== undefined) {
      const at = new Date(oldest.replace(" ", "T"));
      store.prune(kind, new Date(at.getTime() - 2 * lookbackMs));
    }
  }
  const advance = (kind: StreamKind, keys: ReadonlyArray<string>, stamp: Date) =>
    writeTransaction(db, () => moveMarkers(kind, keys, stamp));

  /** Queues a record the handler failed on, unless the handler committed it after all. */
  function queue(item: StreamItem, error: unknown, after: () => void) {
    const permanent = isSourceError(error) && error.kind === "permanent";
    const now = clock.now();
    const queued = writeTransaction(db, () => {
      after();
      if (store.seen(item.kind, item.id, item.stamp)) {
        return false;
      }
      store.enqueue(
        item.kind,
        sources[item.kind],
        item.id,
        item.stamp,
        now,
        new Date(now.getTime() + RETRY_MIN_MS),
        describe(error),
        permanent,
      );
      store.markSeen(item.kind, item.id, item.stamp);
      return true;
    });
    if (queued && permanent) {
      recordAttention(TERMINAL, item, error);
    }
    if (!isSourceError(error)) {
      unexpected(error);
    }
  }

  /**
   * Hands one record to the handler, unless it was handled already. `after` runs in the same
   * transaction as the record's dedupe entry (the live path's marker move, D177: one commit per
   * live record), or in one of its own when the record was handled before.
   */
  async function handle(item: StreamItem, after: () => void = () => {}) {
    if (store.seen(item.kind, item.id, item.stamp)) {
      writeTransaction(db, after);
      return;
    }
    if ("error" in item) {
      queue(item, new SourceError("permanent", item.error), after);
      return;
    }
    let committed = false;
    const commit: RecordCommit = {
      write: () => {
        store.markSeen(item.kind, item.id, item.stamp);
        after();
        committed = true;
      },
    };
    try {
      if (item.kind === "event") {
        await handler.event(item.record, commit, stopping.signal);
      } else {
        await handler.userLeft(item.record, commit, stopping.signal);
      }
    } catch (error) {
      // Stopping: nothing is marked, and the next start reads the record again.
      stopping.signal.throwIfAborted();
      // D173: the handler's own source reads found the settings wrong (a 400, 403 or 404 of the
      // recipients view): a refusal of the stream, as a record lacking a configured field is. The
      // session ends refused with nothing consumed and no marker moved; the retry queue waits.
      if (isSettingsMismatch(error)) {
        throw error;
      }
      queue(item, error, after);
      return;
    }
    recordWarned[item.kind].clear();
    if (!committed) {
      // The handler had nothing to write (or a retry handled the record meanwhile).
      writeTransaction(db, () => {
        if (!store.seen(item.kind, item.id, item.stamp)) {
          store.markSeen(item.kind, item.id, item.stamp);
        }
        after();
      });
    }
  }

  /** Catches one kind up over its groups, page by page; each page's records commit before the marker moves. */
  async function catchUpGroups(
    kind: StreamKind,
    groups: Array<{ names: Array<string>; from: Date }>,
    keys: ReadonlyArray<string>,
    signal: AbortSignal,
  ) {
    let after: { stamp: Date; id: string } | undefined;
    for (;;) {
      signal.throwIfAborted();
      const { items, more } = await source.catchUp(
        { kind, groups, after, perPage: pageSize },
        { signal },
      );
      for (const item of items) {
        signal.throwIfAborted();
        await handle(item);
      }
      const last = items.at(-1);
      if (last) {
        advance(kind, keys, last.stamp);
        after = { stamp: last.stamp, id: last.id };
      }
      if (!more || !last) {
        return;
      }
    }
  }

  const markerDate = (marker: string | undefined) => {
    const at = marker ? new Date(marker.replace(" ", "T")) : clock.now();
    return new Date(at.getTime() - lookbackMs);
  };

  async function catchUp(
    topics: ReadonlyArray<{ names: Array<string> }>,
    users: boolean,
    signal: AbortSignal,
  ) {
    const markers = store.markers();
    for (const { names } of topics) {
      // Names with the same marker share a bound; a newly subscribed name starts at its own.
      const byMarker = new Map<string, Array<string>>();
      for (const name of names) {
        const marker = markers.get(eventKey(name)) ?? "";
        byMarker.set(marker, [...(byMarker.get(marker) ?? []), name]);
      }
      const groups = [...byMarker].map(([marker, group]) => ({
        names: group,
        from: markerDate(marker),
      }));
      await catchUpGroups("event", groups, names.map(eventKey), signal);
    }
    if (users) {
      await catchUpGroups(
        "user",
        [{ names: [], from: markerDate(markers.get(userKey)) }],
        [userKey],
        signal,
      );
    }
  }

  /** One connection: connect, subscribe, catch up, then live until it closes or is refreshed. */
  async function session(
    names: Array<string>,
    signal: AbortSignal,
    reached: { connected: () => void; live: () => void },
  ) {
    state = "connecting";
    const topics = names.length ? source.eventTopics(names) : [];
    const usersTopic = source.usersTopic();
    const realtime: RealtimeOptions = {
      url: config.url,
      guard: options.guard,
      transport: options.transport,
      clock,
      signal,
    };
    if (tuning.idleMs) {
      realtime.idleMs = tuning.idleMs;
    }
    if (tuning.maxAgeMs) {
      realtime.maxAgeMs = tuning.maxAgeMs;
    }
    if (tuning.maxLine) {
      realtime.maxLine = tuning.maxLine;
    }
    const connection = await openRealtime(realtime);
    sessions++;
    const buffer = createBuffer(bufferLimit);
    try {
      const kinds = new Map<string, StreamKind>(topics.map(({ topic }) => [topic, "event"]));
      if (usersTopic) {
        kinds.set(usersTopic, "user");
      }
      const eventKeys = names.map(eventKey);
      // A topic first subscribed starts at the source's clock, so history is never replayed. Its
      // marker is set one lookback ahead, so its first catch-up reads from the connection's time
      // exactly: what commits later arrives live, since the subscription comes before the catch-up.
      const start = connection.sourceNow ?? clock.now();
      writeTransaction(db, () =>
        store.keepMarkers(
          [...eventKeys, ...(usersTopic ? [userKey] : [])],
          new Date(start.getTime() + lookbackMs),
        ),
      );
      void (async () => {
        try {
          for await (const message of connection.messages) {
            buffer.push(message);
          }
          buffer.end();
        } catch (error) {
          buffer.end(error);
        }
      })();
      await source.subscribe(connection.clientId, [...kinds.keys()], { signal });
      // A change of the sequences or rules ends this session, and the next subscribes anew.
      subscribed = names.join("\n");
      reached.connected();
      void (async () => {
        try {
          for (;;) {
            await clock.sleep(TOPIC_CHECK_MS, signal);
            if (namesNow().join("\n") !== subscribed && !signal.aborted) {
              current?.abort(REFRESH);
              return;
            }
          }
        } catch {
          /* The session ended. */
        }
      })();
      state = "catching-up";
      for (;;) {
        await catchUp(topics, usersTopic !== null, signal);
        state = "live";
        reached.live();
        let overflow = false;
        while (!overflow) {
          const next = await buffer.next(signal);
          if (next === "end") {
            return;
          }
          if (next === "overflow") {
            overflow = true;
            break;
          }
          const kind = kinds.get(next.event);
          if (!kind) {
            continue;
          }
          const payload = safeJson(next.data);
          if (payload === undefined) {
            // B155b (D177): a message of a subscribed topic the stream cannot read (its record
            // nests past the JSON limit). Caught up instead, so the catch-up's reads make it a
            // terminal record keyed by its ID, never a record lost without a line.
            overflow = true;
            break;
          }
          const action = member(payload, "action");
          const item = source.item(
            kind,
            typeof action === "string" ? action : "",
            member(payload, "record"),
          );
          if (!item) {
            continue;
          }
          const keys = kind === "event" ? eventKeys : [userKey];
          await handle(item, () => moveMarkers(kind, keys, item.stamp));
        }
        state = "catching-up";
      }
    } finally {
      connection.close();
    }
  }

  /** Sleeps `ms` on the injected clock; `refresh` and `stop` end it early. */
  async function pause(ms: number) {
    waking = new AbortController();
    const signal = AbortSignal.any([waking.signal, stopping.signal]);
    try {
      await clock.sleep(ms, signal);
    } catch {
      /* Woken. */
    } finally {
      waking = undefined;
    }
  }

  async function run() {
    // Failing to get live: since when, and the lines written. Both start over only when a session
    // gets live (caught up), not when it connects: a source that accepts the subscription and then
    // refuses every catch-up (a misnamed field) is still one refusal, written once.
    let failingSince: number | undefined;
    let warned = false;
    const refusals = new Set<string>();
    let delay = 0;
    while (!stopping.signal.aborted) {
      const session_ = new AbortController();
      current = session_;
      const signal = AbortSignal.any([session_.signal, stopping.signal]);
      let connected = false;
      try {
        const names = namesNow();
        if (!names.length && source.usersTopic() === null) {
          state = "idle";
          delay = 0;
          // B163 (D171, D191): no topic is subscribed, so no marker is kept; a name subscribed
          // again starts afresh instead of replaying what was created while it was not.
          if (store.markers().size) {
            writeTransaction(db, () => store.keepMarkers([], clock.now()));
          }
          await pause(TOPIC_CHECK_MS);
          continue;
        }
        await session(names, signal, {
          connected() {
            connected = true;
          },
          // Caught up: the failing clock and the warnings start over.
          live() {
            delay = 0;
            failingSince = undefined;
            warned = false;
            refusals.clear();
          },
        });
        delay = RECONNECT_MIN_MS;
      } catch (error) {
        if (stopping.signal.aborted) {
          break;
        }
        const permanent = isSourceError(error) && error.kind === "permanent";
        if (session_.signal.aborted && session_.signal.reason === REFRESH) {
          delay = 0;
        } else if (connected && !permanent) {
          // A reset or close after connecting (live or catching up) is routine: no attention.
          // The wait doubles until a session gets live, so a source failing every catch-up is
          // not asked again each second.
          if (!isSourceError(error)) {
            unexpected(error);
          }
          delay = Math.min(Math.max(RECONNECT_MIN_MS, delay * 2), RECONNECT_MAX_MS);
        } else {
          const now = clock.now().getTime();
          failingSince ??= now;
          if (permanent) {
            // Also a record lacking a configured field (`SettingsMismatch`): nothing is consumed
            // and no marker moved, so the try after the settings are fixed delivers it.
            if (!refusals.has(describe(error))) {
              refusals.add(describe(error));
              attention(REFUSED, describe(error));
            }
            delay = REFUSED_RETRY_MS;
          } else {
            if (!isSourceError(error)) {
              unexpected(error);
            }
            if (!warned && now - failingSince >= ATTENTION_AFTER_MS) {
              attention(CANNOT_CONNECT, describe(error));
              warned = true;
            }
            delay = Math.min(Math.max(RECONNECT_MIN_MS, delay * 2), RECONNECT_MAX_MS);
          }
        }
      } finally {
        current = undefined;
        session_.abort();
      }
      if (delay > 0 && !stopping.signal.aborted) {
        state = "waiting";
        await pause(delay);
      }
    }
    state = "stopped";
  }

  // The retry queue: due rows are claimed, read again from the source and handed to the handler.
  async function retry(claim: RetryClaim) {
    const kind = claim.kind;
    const finish = () =>
      writeTransaction(db, () => {
        try {
          store.done(claim);
        } catch {
          /* Handled or reclaimed meanwhile. */
        }
      });
    let error: unknown;
    try {
      const item = await source.reread(kind, claim.record_id, { signal: stopping.signal });
      if (!item || sourceDate(item.stamp) !== claim.stamp) {
        // Gone, no longer leaving, or a newer update that the stream handles itself.
        finish();
        return;
      }
      if ("error" in item) {
        throw new SourceError("permanent", item.error);
      }
      const commit: RecordCommit = { write: () => store.done(claim) };
      if (item.kind === "event") {
        await handler.event(item.record, commit, stopping.signal);
      } else {
        await handler.userLeft(item.record, commit, stopping.signal);
      }
      finish();
      recordWarned[kind].clear();
      return;
    } catch (error_) {
      error = error_;
    }
    if (stopping.signal.aborted) {
      return;
    }
    const now = clock.now();
    // A record lacking a configured field, or a re-read the source refuses (`reread` raises both as
    // `SettingsMismatch`), waits for the settings to be fixed, like the stream: never terminal, and
    // its 72-hour window starts again, so the wait does not use it up.
    const mismatch = isSettingsMismatch(error);
    const permanent = isSourceError(error) && error.kind === "permanent";
    const terminal =
      !mismatch &&
      (permanent || now.getTime() - Date.parse(claim.first_failed_at) >= RETRY_WINDOW_MS);
    const wait = Math.min(
      RETRY_MIN_MS * 2 ** Math.min(20, Number(claim.attempts) - 1),
      RETRY_MAX_MS,
    );
    const changed = writeTransaction(db, () =>
      store.failed(
        claim,
        terminal ? now : new Date(now.getTime() + wait),
        describe(error),
        terminal,
        mismatch ? now : undefined,
      ),
    );
    const record = { kind, id: claim.record_id };
    if (changed && terminal) {
      recordAttention(TERMINAL, record, error);
    } else if (changed && mismatch) {
      recordAttention(REFUSED, record, error);
    }
    if (!isSourceError(error)) {
      unexpected(error);
    }
  }
  const retries = createLoop<RetryClaim>({
    db,
    clock,
    logger: options.logger,
    intervalMs: RETRY_INTERVAL_MS,
    leaseMs: RETRY_LEASE_MS,
    batchSize: RETRY_BATCH,
    signal: stopping.signal,
    claim(now, leaseUntil, limit) {
      store.expire(new Date(now.getTime() - TERMINAL_KEEP_MS));
      return store.claim(now, leaseUntil, limit);
    },
    process: retry,
  });

  return {
    /** Starts the stream and the retry queue; call once, after the server is bound. */
    start() {
      if (running || stopping.signal.aborted) {
        return;
      }
      running = run();
      retries.start();
    },
    /** Re-reads the subscribed names now (a sequence or a rule changed): reconnects when they differ. */
    refresh() {
      waking?.abort();
      if (current && !current.signal.aborted && namesNow().join("\n") !== subscribed) {
        current.abort(REFRESH);
      }
    },
    /** Wakes the retry queue (a test after moving the clock). */
    wakeRetries: () => retries.wake(),
    /**
     * Stops both loops; a record being handled finishes or is read again at the next start. A
     * second call waits for the first.
     */
    stop() {
      stopped ??= (async () => {
        stopping.abort();
        await Promise.allSettled([running, retries.stop()]);
        store.close();
      })();
      return stopped;
    },
    /** Where the stream is, and how many connections it has made. */
    state: () => ({ state, sessions }),
    /** The retry queue, oldest first. */
    retries: (limit?: number) => store.retries(limit),
    /** The number of dedupe entries kept. */
    seenCount: () => store.seenCount(),
  };
}
export type SourceStream = ReturnType<typeof createSourceStream>;
