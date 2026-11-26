// B150b (15-external-sources section 4, D171): a project's realtime stream on a fresh database
// with every migration, against a PocketBase harness instance, with a recording `RecordHandler`
// that can fail on chosen records. The stream runs on a `TestClock`; `until` advances it only
// while the stream waits to reconnect, so no request's own time limit is reached by a test.
// B153: a retry attempt runs with the clock still. `retryAfter` moves the clock, then waits for
// the attempt's re-read to answer, never for the claim alone: moved while an attempt was in flight,
// the clock fired its request time limit and put its next due time past the test's next step.
// B154: every move of the clock (`until`, `advance`, `retryAfter`) waits until no source request
// is in flight and the stream is not connecting, so no request's time limit is reached by a move.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import type { Guard } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { SourceError } from "@/sources/source";
import type { SourceEvent } from "@/sources/source";
import { createSourceStream } from "@/sources/stream";
import type { SourceStreamOptions } from "@/sources/stream";
import type { RecordCommit, RecordHandler, SourceUser } from "@/sources/stream-record";
import { TestClock } from "@/test/server/fixture";

export const openGuard: Guard = { blockPrivate: () => false, privateHosts: () => [] };

/** One handler call that committed. */
export interface Handled {
  kind: "event" | "user";
  id: string;
  name: string;
}

/**
 * A recording handler: `fail` maps a record ID to the failures it throws, oldest first; `hold`
 * maps a record ID to a promise the handler waits for first (a slow handler).
 */
export function recordingHandler(db: Database) {
  const handled: Array<Handled> = [];
  const attempts = new Map<string, number>();
  const fail = new Map<string, Array<"transient" | "permanent">>();
  const hold = new Map<string, Promise<void>>();
  const run = async (id: string, write: () => Handled, commit: RecordCommit) => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    await hold.get(id);
    const failure = fail.get(id)?.shift();
    if (failure) {
      throw new SourceError(failure, `test handler failed ${failure}ly`);
    }
    // The handler contract: source reads first (none here), then one write transaction that
    // includes the stream's dedupe entry.
    const entry = writeTransaction(db, () => {
      commit.write();
      return write();
    });
    handled.push(entry);
  };
  const handler: RecordHandler = {
    event(record: SourceEvent, commit) {
      return run(record.id, () => ({ kind: "event", id: record.id, name: record.name }), commit);
    },
    userLeft(record: SourceUser, commit) {
      return run(record.id, () => ({ kind: "user", id: record.id, name: "" }), commit);
    },
  };
  return { handler, handled, attempts, fail, hold };
}

export interface StreamFixtureOptions {
  config: PocketBaseConfig;
  names: () => ReadonlyArray<string>;
  tuning?: SourceStreamOptions["tuning"];
  /** An existing data directory (a restart); a new one otherwise. */
  dir?: string;
  clock?: TestClock;
  /** The adapter's response limit (a record past it, without writing megabytes). */
  maxResponseBytes?: number;
}

/** A stream on its own database; `close` stops it and removes the directory it made. */
export function startStream(options: StreamFixtureOptions) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "iglo-stream-"));
  const clock = options.clock ?? new TestClock();
  const db = openDatabase(dir);
  runMigrations(db, dir, clock, productionMigrations);
  const attention: Array<string> = [];
  const errors: Array<unknown> = [];
  const requests: Array<string> = [];
  const adapter = createPocketBaseSource({
    config: options.config,
    clock,
    guard: openGuard,
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    transport: {
      fetch: (input: URL, init: RequestInit) => {
        requests.push(`${init.method ?? "GET"} ${input.pathname}${input.search}`);
        return fetch(input, init);
      },
    },
  });
  const recorder = recordingHandler(db);
  // B153: the retry queue's re-reads that have answered (or failed). An attempt does nothing after
  // its re-read that waits on I/O (the recording handler does none), so once this count rises the
  // attempt's row is written: a test waits for it before moving the clock on.
  let rereads = 0;
  // B154: the source requests in flight. Each has a time limit on this clock, so the clock moves
  // only while this is zero and the stream is not connecting (the connect deadline is on the clock
  // too): moved under a request, it fired that limit, a failed subscribe wrote the stream's own
  // "cannot connect" line, and that line took the place a test expected a record's line in.
  let inFlight = 0;
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight++;
    return work.finally(() => {
      inFlight--;
    });
  };
  const source: typeof adapter.stream = {
    ...adapter.stream,
    subscribe: (...args) => track(adapter.stream.subscribe(...args)),
    catchUp: (...args) => track(adapter.stream.catchUp(...args)),
    reread: (...args) =>
      track(adapter.stream.reread(...args)).finally(() => {
        rereads++;
      }),
  };
  /** No source request is in flight and the stream is not connecting: the clock may move. */
  const quiet = () => inFlight === 0 && stream.state().state !== "connecting";
  const stream = createSourceStream({
    db,
    clock,
    logger: {
      attention: (message) => attention.push(message),
      error: (error) => errors.push(error),
    },
    config: options.config,
    guard: openGuard,
    source,
    handler: recorder.handler,
    names: options.names,
    ...(options.tuning ? { tuning: options.tuning } : {}),
  });
  stream.start();

  /**
   * Waits (real time, at most `timeoutMs`) until `check` holds. While the stream waits to
   * reconnect, with no source request in flight, the clock moves on by the wait, so a reconnect
   * needs no real second.
   */
  async function until(check: () => boolean, what: string, timeoutMs = 20_000, stepMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what} (stream ${JSON.stringify(stream.state())})`);
      }
      if (stream.state().state === "waiting" && quiet()) {
        clock.advance(stepMs);
      }
      await Bun.sleep(10);
    }
  }
  const live = (what = "the stream to be live") =>
    until(() => stream.state().state === "live", what);

  /**
   * Waits (real time, at most `timeoutMs`) until `check` holds, with the clock still: for work in
   * flight (a retry attempt), whose request time limits and next due time the clock must not move
   * under (B153).
   */
  async function settle(check: () => boolean, what: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what} (stream ${JSON.stringify(stream.state())})`);
      }
      await Bun.sleep(10);
    }
  }

  /**
   * Moves the clock on by `ms`, wakes the retry queue and waits, with the clock still, until that
   * attempt has finished: its re-read answered and its row is written. Never while one is in
   * flight, so each attempt runs at one clock time (B153).
   */
  async function retryAfter(ms: number) {
    // B155b: a row must be due after the move, or the wait below can only time out with a generic
    // message. Checked before the move: once the clock moves, the queue's own timer may claim the
    // row (its next attempt time becomes the lease's end).
    const at = new Date(clock.now().getTime() + ms).toISOString();
    const waiting = stream.retries().filter((row) => row.terminal === 0n);
    if (!waiting.some((row) => row.next_attempt_at <= at)) {
      const due = waiting.map((row) => `${row.record_id} at ${row.next_attempt_at}`).join(", ");
      throw new Error(`no retry is due at ${at} (queued: ${due || "none"})`);
    }
    await advance(ms);
    const done = rereads;
    stream.wakeRetries();
    await settle(() => rereads > done && quiet(), "a retry to finish");
  }

  /**
   * Moves the clock on by `ms` once no source request is in flight and the stream is not
   * connecting (B154), so no request's time limit is reached by the move. The final check and
   * the move run in one synchronous step, as in `until`: a continuation that starts a request
   * after `settle` returns sends it back to waiting.
   */
  async function advance(ms: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      await settle(quiet, "the source requests in flight", Math.max(0, deadline - Date.now()));
      if (quiet()) {
        clock.advance(ms);
        return;
      }
    }
  }

  /** Handled event IDs (for "none lost, none twice"). */
  const eventIds = () =>
    recorder.handled.filter((entry) => entry.kind === "event").map((entry) => entry.id);

  return {
    dir,
    db,
    clock,
    stream,
    attention,
    errors,
    requests,
    ...recorder,
    eventIds,
    until,
    live,
    settle,
    retryAfter,
    advance,
    rereads: () => rereads,
    async stop() {
      await stream.stop();
      db.close();
    },
    async close() {
      await stream.stop();
      db.close();
      if (!options.dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
export type StreamFixture = ReturnType<typeof startStream>;
