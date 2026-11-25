// B150b (15-external-sources section 4, D171): a project's realtime stream on a fresh database
// with every migration, against a PocketBase harness instance, with a recording `RecordHandler`
// that can fail on chosen records. The stream runs on a `TestClock`; `until` advances it only
// while the stream waits to reconnect, so no request's own time limit is reached by a test.
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

/** A recording handler: `fail` maps a record ID to the failures it throws, oldest first. */
export function recordingHandler(db: Database) {
  const handled: Array<Handled> = [];
  const attempts = new Map<string, number>();
  const fail = new Map<string, Array<"transient" | "permanent">>();
  const run = (id: string, write: () => Handled, commit: RecordCommit) => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
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
    async event(record: SourceEvent, commit) {
      run(record.id, () => ({ kind: "event", id: record.id, name: record.name }), commit);
    },
    async userLeft(record: SourceUser, commit) {
      run(record.id, () => ({ kind: "user", id: record.id, name: "" }), commit);
    },
  };
  return { handler, handled, attempts, fail };
}

export interface StreamFixtureOptions {
  config: PocketBaseConfig;
  names: () => ReadonlyArray<string>;
  tuning?: SourceStreamOptions["tuning"];
  /** An existing data directory (a restart); a new one otherwise. */
  dir?: string;
  clock?: TestClock;
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
    transport: {
      fetch: (input: URL, init: RequestInit) => {
        requests.push(`${init.method ?? "GET"} ${input.pathname}${input.search}`);
        return fetch(input, init);
      },
    },
  });
  const recorder = recordingHandler(db);
  const stream = createSourceStream({
    db,
    clock,
    logger: {
      attention: (message) => attention.push(message),
      error: (error) => errors.push(error),
    },
    config: options.config,
    guard: openGuard,
    source: adapter.stream,
    handler: recorder.handler,
    names: options.names,
    ...(options.tuning ? { tuning: options.tuning } : {}),
  });
  stream.start();

  /**
   * Waits (real time, at most `timeoutMs`) until `check` holds. While the stream waits to
   * reconnect, the clock moves on by the wait, so a reconnect needs no real second.
   */
  async function until(check: () => boolean, what: string, timeoutMs = 20_000, stepMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what} (stream ${JSON.stringify(stream.state())})`);
      }
      if (stream.state().state === "waiting") {
        clock.advance(stepMs);
      }
      await Bun.sleep(10);
    }
  }
  const live = (what = "the stream to be live") =>
    until(() => stream.state().state === "live", what);

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
