// Native (15-external-sources section 4, D171, D173): a project's source stream with the record
// handler, as the server runs it. While the project has a configured source, one stream (with its
// own adapter, so one service-account token) subscribes to the names of active external sequences'
// triggers, active or paused external sequences' `exit_on` and the grant rules' events, plus the
// users topic. A change of the `source.*` settings stops the stream and starts one on the new
// settings (markers whose source, collection or filter changed are dropped by the stream itself);
// a change of the names resubscribes (the stream compares them every 15 s on the injected clock,
// and `refresh()` compares at once). The stream's test-only `tuning` is never passed here.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import type { Enrollments } from "@/sequences/enrollments";
import type { Settings } from "@/settings/validate";
import type { Guard, SourceTransport } from "@/sources/connect";
import { isSourceList, isSourceObject, member, sourceJson } from "@/sources/json";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { SourceScalar } from "@/sources/source";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { createRecordHandler } from "@/sources/records";
import type { RecordHandlerOptions } from "@/sources/records";
import type { GrantRule } from "@/sources/settings";
import { createSourceStream, TOPIC_CHECK_MS } from "@/sources/stream";
import type { SourceStream } from "@/sources/stream";

/**
 * The stored `source.grant_lists` rules (validated when saved, D170), read defensively: a rule
 * whose shape is not a rule's is left out.
 */
export function storedGrantRules(settings: Settings): Array<GrantRule> {
  const stored = sourceJson(settings["source.grant_lists"]);
  const rules: Array<GrantRule> = [];
  for (const rule of isSourceList(stored) ? stored : []) {
    const event = member(rule, "event");
    const where = member(rule, "where");
    const lists = member(rule, "lists");
    if (typeof event !== "string" || !event || !isSourceList(lists)) {
      continue;
    }
    const equalities: Record<string, SourceScalar> = {};
    let valid = where === undefined || isSourceObject(where);
    for (const [key, value] of isSourceObject(where) ? Object.entries(where) : []) {
      if (
        key.startsWith("data.") &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ) {
        Object.defineProperty(equalities, key, { value, enumerable: true });
      } else {
        valid = false;
      }
    }
    const ids = lists.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    if (valid && ids.length) {
      rules.push({ event, where: equalities, lists: ids });
    }
  }
  return rules;
}

export interface SourceRecordsOptions {
  db: Database;
  clock: Clock;
  logger: Pick<ErrorLogger, "attention" | "error">;
  /** The project's source settings, or null without a source; read at each check. */
  config: () => PocketBaseConfig | null;
  grantRules: () => ReadonlyArray<GrantRule>;
  guard: Guard;
  /** A test's observed transport; production uses `fetch`. */
  transport?: SourceTransport;
  subscribers: RecordHandlerOptions["subscribers"];
  enrollments: RecordHandlerOptions["enrollments"] & Pick<Enrollments, "externalEventNames">;
  emailAllowed: (email: string) => boolean;
  onOutcome?: RecordHandlerOptions["onOutcome"];
}

export function createSourceRecords(options: SourceRecordsOptions) {
  const { clock } = options;
  const stopping = new AbortController();
  let current: { key: string; stream: SourceStream } | null = null;
  /** Switches run one at a time: a stream stops before the next one starts. */
  let switching: Promise<void> = Promise.resolve();
  let running: Promise<void> | undefined;

  const names = () => {
    const all = new Set([
      ...options.enrollments.externalEventNames(),
      ...options.grantRules().map((rule) => rule.event),
    ]);
    return [...all].filter(Boolean).sort();
  };

  function open(config: PocketBaseConfig): SourceStream {
    const adapterOptions: Parameters<typeof createPocketBaseSource>[0] = {
      config,
      clock,
      guard: options.guard,
    };
    if (options.transport) {
      adapterOptions.transport = options.transport;
    }
    const adapter = createPocketBaseSource(adapterOptions);
    const handler: RecordHandlerOptions = {
      db: options.db,
      clock,
      logger: options.logger,
      source: adapter,
      grantRules: options.grantRules,
      subscribers: options.subscribers,
      enrollments: options.enrollments,
      emailAllowed: options.emailAllowed,
    };
    if (options.onOutcome) {
      handler.onOutcome = options.onOutcome;
    }
    return createSourceStream({
      db: options.db,
      clock,
      logger: options.logger,
      config,
      guard: options.guard,
      transport: options.transport,
      source: adapter.stream,
      handler: createRecordHandler(handler),
      names,
    });
  }

  /**
   * Compares the settings with the running stream's: starts, restarts or stops it. A failed switch
   * rejects its own caller only: the chain goes on, so the next settings change still applies and
   * `stop()` still stops the stream.
   */
  function sync(): Promise<void> {
    const next = switching.then(async () => {
      if (stopping.signal.aborted) {
        return;
      }
      const config = options.config();
      const key = config ? JSON.stringify(config) : "";
      if (current && current.key === key) {
        current.stream.refresh();
        return;
      }
      const previous = current;
      current = null;
      await previous?.stream.stop();
      if (config && !stopping.signal.aborted) {
        const stream = open(config);
        current = { key, stream };
        stream.start();
      }
    });
    switching = next.catch(() => {
      /* Reported to the caller of the failed switch. */
    });
    return next;
  }

  async function watch() {
    while (!stopping.signal.aborted) {
      try {
        await sync();
      } catch (error) {
        options.logger.error(error);
      }
      try {
        await clock.sleep(TOPIC_CHECK_MS, stopping.signal);
      } catch {
        /* Stopped. */
      }
    }
  }

  return {
    /** Starts watching the settings; call once, after the server is bound. */
    start() {
      running ??= watch();
    },
    /** The settings, a sequence or a grant rule changed: compare now. */
    refresh: () => sync(),
    /** Stops the stream and the watch; a record being handled finishes or is read again later. */
    async stop() {
      stopping.abort();
      await running;
      await switching;
      const last = current;
      current = null;
      await last?.stream.stop();
    },
    /** The running stream, or null without a source (tests read its state and retry queue). */
    stream: () => current?.stream ?? null,
  };
}
export type SourceRecords = ReturnType<typeof createSourceRecords>;
