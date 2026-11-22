// Native subscriber event store (docs/design/05-sequences.md#events-api,
// 03-data-model.md#events); no upstream source. The events module owns `events` SQL;
// subscriber rows are read and written through the subscriber owner.
import type { Database } from "bun:sqlite";
import { must } from "@/invariant";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { createEventAggregates } from "@/events/aggregate";
import type { EventInput } from "@/events/input";
import type { Translation } from "@/i18n/i18n";
import type { ErrorCode } from "@/server/error-codes";
import { HttpError } from "@/server/response";
import type { ErrorDetails } from "@/server/response";
import type { Scope, SubscriberStore } from "@/subscribers/store";
import sql from "@/events/store.sql" with { type: "text" };

/** Events that occurred longer than this before they were received never start sequences. */
export const TRIGGER_WINDOW_MS = 7 * 86_400_000;
/** Most single-event requests that share one group-commit transaction. */
const MAX_GROUP = 500;

export interface RecordedEvent {
  id: bigint;
  subscriberId: bigint;
  name: string;
  /** The event's `data` object as stored JSON text. */
  data: string;
  /** The subscriber's status after the upsert. */
  subscriberStatus: string;
  occurredAt: string;
  receivedAt: string;
  /** False for events older than TRIGGER_WINDOW_MS when received. */
  triggerEligible: boolean;
  /**
   * Whether a suppression names the subscriber (B124, D125), read on demand: only a marketing
   * sequence's start asks, so an event with no such sequence does not look one up.
   */
  suppressed(): boolean;
}
export interface Enrollments {
  started: Array<unknown>;
  ended: Array<unknown>;
  /**
   * Sequences the event would have started but cannot, with the reason (B116, D131): a
   * blocklisted subscriber's start (`subscriber_blocklisted`), a suppressed person's marketing
   * start (`suppressed`). Stored with the event, so the subscriber's timeline shows it.
   */
  skipped: Array<unknown>;
}
/**
 * The subscriber an event names, as the grant check (D99) sees it before the event writes: the
 * lists it has a membership on, of any status. `null` where there is nothing to check: the event
 * creates the subscriber, or it grants nothing.
 */
export interface ExistingSubscriber {
  lists: Array<bigint>;
}
/**
 * The authorization of one event: called once the subscriber it names is known, inside the
 * event's write transaction, before anything is written. A refusal (HttpError) fails the event
 * alone and writes nothing. It returns the caller's list manage scope, which decides whether an event
 * may claim a subscriber on lists the caller does not manage, and whether a conflict may name the
 * holder's external ID (D129).
 */
export type Authorize = (existing: ExistingSubscriber | null) => Scope;
/** An item without an authorization has no list scope: a conflict names no holder. */
const NO_SCOPE: Scope = { all: false, ids: [] };
/**
 * What a grant did to one list (D99): `added` is a new confirmed membership. `suppressed` (B124,
 * D125) is a person whose self-wipe still stands: nothing is granted, and only their own
 * confirmation through a public form ends it.
 */
export type GrantResult = "added" | "member" | "unsubscribed" | "blocklisted" | "suppressed";
export interface Grant {
  list_id: number;
  result: GrantResult;
}
/**
 * The sequence step of event processing, run inside the event's write transaction:
 * end the subscriber's enrollments whose `exit_on` names the event, then start the
 * sequences it triggers (only when `triggerEligible`). Returns the enrollments it changed.
 */
export type ExitThenTrigger = (event: RecordedEvent) => Enrollments;
/** No sequences: no event starts or ends an enrollment. */
export const noSequences: ExitThenTrigger = () => ({ started: [], ended: [], skipped: [] });

export const triggerEligible = (occurredAt: string, receivedAt: string) =>
  Date.parse(occurredAt) >= Date.parse(receivedAt) - TRIGGER_WINDOW_MS;

export interface EventRow {
  id: bigint;
  subscriber_id: bigint;
  name: string;
  data: string;
  occurred_at: string;
  created_at: string;
  idempotency_key: string | null;
}
export type EventResult =
  | {
      status: 200;
      event_id: number | object;
      subscriber_id: number | object;
      enrollments: Enrollments;
      grants: Array<Grant>;
    }
  | ({ status: number; message: string; code: ErrorCode } & ErrorDetails);

const rawJSON = (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON;
const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : rawJSON(id.toString());

interface StoredOutcome {
  enrollments: Enrollments;
  grants: Array<Grant>;
}
/**
 * What the first request under an idempotency key did, as stored in `events.enrollments`:
 * `{started, ended, grants, skipped}`. A row written before grants existed has no `grants`, and
 * one written before B116 has no `skipped`.
 */
function storedOutcome(text: string | null): StoredOutcome {
  if (text === null) {
    return { enrollments: { started: [], ended: [], skipped: [] }, grants: [] };
  }
  // Integers beyond 2^53 in enrollments stay exact.
  const stored = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source
      ? rawJSON(context.source)
      : value,
  ) as Partial<Enrollments> & { grants?: Array<Grant> };
  return {
    enrollments: {
      started: stored.started ?? [],
      ended: stored.ended ?? [],
      skipped: stored.skipped ?? [],
    },
    grants: stored.grants ?? [],
  };
}

/** Savepoint cleanup failed: no member of the group may be reported individually. */
class TransactionLost extends Error {
  constructor(cause: unknown) {
    super("Event transaction lost", { cause });
  }
}

const result = (
  id: bigint,
  subscriberId: bigint,
  outcome: { enrollments: Enrollments; grants: Array<Grant> },
): EventResult => ({
  status: 200,
  event_id: numberID(id),
  subscriber_id: numberID(subscriberId),
  enrollments: outcome.enrollments,
  grants: outcome.grants,
});
export function createEventStore(
  db: Database,
  subscribers: SubscriberStore,
  options: {
    emailAllowed: (email: string) => boolean;
    exitThenTrigger?: ExitThenTrigger;
    i18n: Translation;
  },
) {
  const q = prepareNamedQueries(db, [{ name: "events/store", sql }]);
  const aggregates = createEventAggregates(db);
  const exitThenTrigger = options.exitThenTrigger ?? noSequences;
  /**
   * One grant (D99) after the subscriber upsert. A blocklisted subscriber gets nothing; a
   * missing membership is inserted confirmed, and any existing one is left as it is.
   */
  function grant(subscriber: Subscriber, list: bigint, suppressed: boolean): Grant {
    const listId = Number(list);
    if (subscriber.status === "blocklisted") {
      return { list_id: listId, result: "blocklisted" };
    }
    if (suppressed) {
      return { list_id: listId, result: "suppressed" };
    }
    const previous = subscribers.membership(subscriber.id, list);
    if (!previous) {
      subscribers.insertConfirmedIfAbsent(subscriber.id, list);
      return { list_id: listId, result: "added" };
    }
    return {
      list_id: listId,
      result: previous.status === "unsubscribed" ? "unsubscribed" : "member",
    };
  }
  /** The grant check's view of the event's subscriber (see `ExistingSubscriber`). */
  const existing = (found: Subscriber | null, input: EventInput): ExistingSubscriber | null =>
    found && input.grantLists.length
      ? { lists: subscribers.memberships(found.id).map((m) => m.list_id) }
      : null;
  /** Steps 1-3 of the design's processing order. The caller holds the write transaction. */
  function record(
    input: EventInput,
    receivedAt: string,
    found: Subscriber | null,
    scope: Scope,
  ): EventResult {
    if (found && input.idempotencyKey !== undefined) {
      const previous = q.get("event-by-key").get(found.id, input.idempotencyKey) as
        | (Pick<EventRow, "id" | "subscriber_id"> & {
            enrollments: string | null;
          })
        | null;
      // Replay what the first request started, ended and granted; never recompute it.
      if (previous) {
        return result(previous.id, previous.subscriber_id, storedOutcome(previous.enrollments));
      }
    }
    // Refused before any write: the grant is checked against the lists as they are now.
    for (const list of input.grantLists) {
      if (!subscribers.grantable(list)) {
        throw new HttpError(
          400,
          options.i18n.Ts("globals.messages.invalidFields", "name", "subscriber.grant_lists"),
        );
      }
    }
    // D129: an address another subscriber holds is claimed or refused before anything is written.
    const conflict = subscribers.eventConflict(input.subscriber, found, scope);
    if (conflict) {
      throw conflict;
    }
    const subscriber = subscribers.upsertForEvent(found, input.subscriber, options.emailAllowed);
    // B124 (D125): read once, after the upsert, so the address and ID the event leaves are the ones checked.
    const suppressed = input.grantLists.length > 0 && subscribers.suppressed(subscriber);
    const grants = input.grantLists.map((list) => grant(subscriber, list, suppressed));
    const occurredAt = input.occurredAt ?? receivedAt;
    const inserted = q
      .get("event-insert")
      .get(
        subscriber.id,
        input.name,
        input.data,
        occurredAt,
        receivedAt,
        input.idempotencyKey ?? null,
      ) as { id: bigint };
    const enrollments = exitThenTrigger({
      id: inserted.id,
      subscriberId: subscriber.id,
      name: input.name,
      data: input.data,
      subscriberStatus: subscriber.status,
      occurredAt,
      receivedAt,
      triggerEligible: triggerEligible(occurredAt, receivedAt),
      suppressed: () => subscribers.suppressed(subscriber),
    });
    // An event's outcome is stored when a replay needs it (an idempotency key), and whenever a
    // sequence start was skipped, so the subscriber's timeline can name the reason (B116, D131).
    if (
      enrollments.skipped.length ||
      (input.idempotencyKey !== undefined &&
        (enrollments.started.length || enrollments.ended.length || grants.length))
    ) {
      q.get("event-enrollments").run(JSON.stringify({ ...enrollments, grants }), inserted.id);
    }
    return result(inserted.id, subscriber.id, { enrollments, grants });
  }
  /** One item in its own savepoint: a rejection rolls back only this item's writes. */
  function item(input: EventInput, at: string, authorize?: Authorize): EventResult {
    db.run("SAVEPOINT event_item");
    try {
      const found = subscribers.resolveForEvent(input.subscriber);
      const scope = authorize?.(existing(found, input)) ?? NO_SCOPE;
      const recorded = record(input, at, found, scope);
      db.run("RELEASE event_item");
      return recorded;
    } catch (error) {
      try {
        db.run("ROLLBACK TO event_item");
        db.run("RELEASE event_item");
      } catch (error_) {
        // The savepoint or the transaction itself is gone, so this item's writes cannot be
        // isolated. Abort the whole transaction rather than report a partial outcome.
        throw new TransactionLost(error_);
      }
      if (error instanceof HttpError) {
        return { status: error.status, message: error.message, code: error.code, ...error.details };
      }
      throw error;
    }
  }
  interface Pending {
    input: EventInput;
    at: string;
    authorize: Authorize;
    resolve: (result: EventResult) => void;
    reject: (error: unknown) => void;
  }
  const queue: Array<Pending> = [];
  let scheduled = false;
  type Outcome = { result: EventResult } | { failure: unknown };
  function flush() {
    scheduled = false;
    const entries = queue.splice(0, MAX_GROUP);
    if (queue.length) {
      schedule();
    }
    let outcomes: Array<Outcome>;
    try {
      // item() has already rolled back its own savepoint when it throws, so an unexpected
      // error fails only that member and the others still commit.
      outcomes = writeTransaction(db, () =>
        entries.map((e): Outcome => {
          try {
            return { result: item(e.input, e.at, e.authorize) };
          } catch (error) {
            if (error instanceof TransactionLost || !db.inTransaction) {
              throw error;
            }
            return { failure: error };
          }
        }),
      );
    } catch (error) {
      // A shared BEGIN/COMMIT failure: nothing committed. Fail every member once and
      // leave any retry to the caller; never replay their callbacks (D19).
      for (const entry of entries) {
        entry.reject(error);
      }
      return;
    }
    entries.forEach((entry, i) => {
      const outcome = must(outcomes[i], "outcome");
      if ("result" in outcome) {
        entry.resolve(outcome.result);
      } else {
        entry.reject(outcome.failure);
      }
    });
  }
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setImmediate(flush);
  }
  return {
    /**
     * Record one event atomically in a short write transaction and resolve after its commit.
     * Requests that arrive while a commit is in progress share the next transaction (group
     * commit), each in its own savepoint with its own authorization, so one fsync covers
     * them without coupling their results.
     */
    submit(input: EventInput, receivedAt: Date, authorize: Authorize): Promise<EventResult> {
      return new Promise((resolve, reject) => {
        queue.push({
          input,
          at: receivedAt.toISOString(),
          authorize,
          resolve,
          reject,
        });
        schedule();
      });
    },
    /**
     * A batch in one write transaction with per-item results. Each item runs in its own
     * savepoint, so a rejected item leaves no partial write and does not drop the others.
     * Pre-rejected items (invalid input) are passed through unchanged. `authorize` runs once
     * for the batch and `authorizeItem` for each item's grants (see `Authorize`); a refusal of
     * either is a per-item result, except the batch's own permission, which refuses the whole batch.
     * An unexpected error rolls back the whole batch.
     */
    recordBatch(
      items: ReadonlyArray<EventInput | HttpError>,
      receivedAt: Date,
      authorize: () => void,
      authorizeItem: (input: EventInput, existing: ExistingSubscriber | null) => Scope,
    ): Array<EventResult> {
      const at = receivedAt.toISOString();
      return writeTransaction(db, () => {
        authorize();
        return items.map((value): EventResult =>
          value instanceof HttpError
            ? { status: value.status, message: value.message, code: value.code, ...value.details }
            : item(value, at, (existing) => authorizeItem(value, existing)),
        );
      });
    },
    /**
     * The aggregates of one sequence step for one subscriber (`aggregates` in template data,
     * D100). Reads the committed events on the write connection, outside any transaction.
     */
    aggregate: aggregates.evaluate,
    /** One event, for sequence template data (the enrollment's trigger). */
    get(id: bigint): EventRow | null {
      return q.get("event-by-id").get(id) as EventRow | null;
    },
    /** The newest of a subscriber's events under one name, or null (the step preview's trigger, D105). */
    latest(subscriberId: bigint, name: string): EventRow | null {
      return q.get("event-latest-named").get(subscriberId, name) as EventRow | null;
    },
    /** A subscriber's events in ID order, at most `limit`. */
    list(subscriberId: bigint, limit = 1000): Array<EventRow> {
      return q.get("events-by-subscriber").all(subscriberId, limit) as Array<EventRow>;
    },
    /** One page of a subscriber's events, newest first, for the admin screens. */
    page(subscriberId: bigint, page: number, perPage: number) {
      const rows = q.get("events-page").all(subscriberId, perPage, (page - 1) * perPage) as Array<
        EventRow & {
          enrollments: string | null;
        }
      >;
      const total = (q.get("events-count").get(subscriberId) as { n: bigint }).n;
      return {
        results: rows.map((row) => ({
          id: numberID(row.id),
          name: row.name,
          data: JSON.parse(row.data) as unknown,
          occurred_at: row.occurred_at,
          created_at: row.created_at,
          // B116 (D131): the sequence starts this event was refused, with the reason for each.
          skipped: storedOutcome(row.enrollments).enrollments.skipped,
        })),
        total: numberID(total),
        page,
        per_page: perPage,
      };
    },
    /**
     * Delete expired events among the `window` oldest IDs. The caller holds the write
     * transaction. Returns the deleted IDs; none means the oldest window is current.
     */
    purge(receivedBefore: Date, window: number): Array<bigint> {
      return (
        q.get("events-purge").all(window, receivedBefore.toISOString()) as Array<{
          id: bigint;
        }>
      ).map((row) => row.id);
    },
    close: () => {
      aggregates.close();
      q.close();
    },
  };
}
export type EventStore = ReturnType<typeof createEventStore>;
type Subscriber = ReturnType<SubscriberStore["upsertForEvent"]>;
