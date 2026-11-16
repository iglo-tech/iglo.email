// Native subscriber event store (docs/design/05-sequences.md#events-api,
// 03-data-model.md#events); no upstream source. The events module owns `events` SQL;
// subscriber rows are read and written through the subscriber owner.
import type { Database } from "bun:sqlite";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { EventInput } from "@/events/input";
import type { Translation } from "@/i18n/i18n";
import { HttpError } from "@/server/response";
import type { SubscriberStore } from "@/subscribers/store";
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
}
export interface Enrollments {
  started: unknown[];
  ended: unknown[];
}
/**
 * The subscriber an event names, as the grant check (D99) sees it before the event writes: the
 * lists it has a membership on, of any status. `null` where there is nothing to check: the event
 * creates the subscriber, or it grants nothing.
 */
export interface ExistingSubscriber {
  lists: bigint[];
}
/**
 * The authorization of one event: called once the subscriber it names is known, inside the
 * event's write transaction, before anything is written. A refusal (HttpError) fails the event
 * alone and writes nothing.
 */
export type Authorize = (existing: ExistingSubscriber | null) => void;
/** What a grant did to one list (D99): `added` is a new confirmed membership. */
export type GrantResult = "added" | "member" | "unsubscribed" | "blocklisted";
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
export const noSequences: ExitThenTrigger = () => ({ started: [], ended: [] });

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
      grants: Grant[];
    }
  | { status: number; message: string };

const rawJSON = (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON;
const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : rawJSON(id.toString());

/**
 * What the first request under an idempotency key did, as stored in `events.enrollments`:
 * `{started, ended, grants}`. A row written before grants existed has no `grants`.
 */
function storedOutcome(text: string | null): { enrollments: Enrollments; grants: Grant[] } {
  if (text === null) return { enrollments: { started: [], ended: [] }, grants: [] };
  // Integers beyond 2^53 in enrollments stay exact.
  const stored = JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source
      ? rawJSON(context.source)
      : value,
  ) as Partial<Enrollments> & { grants?: Grant[] };
  return {
    enrollments: { started: stored.started ?? [], ended: stored.ended ?? [] },
    grants: stored.grants ?? [],
  };
}

/** Savepoint cleanup failed: no member of the group may be reported individually. */
class TransactionLost extends Error {
  constructor(cause: unknown) {
    super("Event transaction lost", { cause });
  }
}

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
  const exitThenTrigger = options.exitThenTrigger ?? noSequences;
  const result = (
    id: bigint,
    subscriberId: bigint,
    outcome: { enrollments: Enrollments; grants: Grant[] },
  ): EventResult => ({
    status: 200,
    event_id: numberID(id),
    subscriber_id: numberID(subscriberId),
    enrollments: outcome.enrollments,
    grants: outcome.grants,
  });
  /**
   * One grant (D99) after the subscriber upsert. A blocklisted subscriber gets nothing; a
   * missing membership is inserted confirmed, and any existing one is left as it is.
   */
  function grant(subscriber: Subscriber, list: bigint): Grant {
    const listId = Number(list);
    if (subscriber.status === "blocklisted") return { list_id: listId, result: "blocklisted" };
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
  function record(input: EventInput, receivedAt: string, found: Subscriber | null): EventResult {
    if (found && input.idempotencyKey !== undefined) {
      const previous = q.get("event-by-key").get(found.id, input.idempotencyKey) as
        | (Pick<EventRow, "id" | "subscriber_id"> & {
            enrollments: string | null;
          })
        | null;
      // Replay what the first request started, ended and granted; never recompute it.
      if (previous)
        return result(previous.id, previous.subscriber_id, storedOutcome(previous.enrollments));
    }
    // Refused before any write: the grant is checked against the lists as they are now.
    for (const list of input.grantLists)
      if (!subscribers.grantable(list))
        throw new HttpError(
          400,
          options.i18n.Ts("globals.messages.invalidFields", "name", "subscriber.grant_lists"),
        );
    const subscriber = subscribers.upsertForEvent(found, input.subscriber, options.emailAllowed);
    const grants = input.grantLists.map((list) => grant(subscriber, list));
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
    });
    if (
      input.idempotencyKey !== undefined &&
      (enrollments.started.length || enrollments.ended.length || grants.length)
    )
      q.get("event-enrollments").run(JSON.stringify({ ...enrollments, grants }), inserted.id);
    return result(inserted.id, subscriber.id, { enrollments, grants });
  }
  /** One item in its own savepoint: a rejection rolls back only this item's writes. */
  function item(input: EventInput, at: string, authorize?: Authorize): EventResult {
    db.run("SAVEPOINT event_item");
    try {
      const found = subscribers.resolveForEvent(input.subscriber);
      authorize?.(existing(found, input));
      const recorded = record(input, at, found);
      db.run("RELEASE event_item");
      return recorded;
    } catch (error) {
      try {
        db.run("ROLLBACK TO event_item");
        db.run("RELEASE event_item");
      } catch (cleanup) {
        // The savepoint or the transaction itself is gone, so this item's writes cannot be
        // isolated. Abort the whole transaction rather than report a partial outcome.
        throw new TransactionLost(cleanup);
      }
      if (error instanceof HttpError) return { status: error.status, message: error.message };
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
  const queue: Pending[] = [];
  let scheduled = false;
  type Outcome = { result: EventResult } | { failure: unknown };
  function flush() {
    scheduled = false;
    const entries = queue.splice(0, MAX_GROUP);
    if (queue.length) schedule();
    let outcomes: Outcome[];
    try {
      // item() has already rolled back its own savepoint when it throws, so an unexpected
      // error fails only that member and the others still commit.
      outcomes = writeTransaction(db, () =>
        entries.map((e): Outcome => {
          try {
            return { result: item(e.input, e.at, e.authorize) };
          } catch (failure) {
            if (failure instanceof TransactionLost || !db.inTransaction) throw failure;
            return { failure };
          }
        }),
      );
    } catch (error) {
      // A shared BEGIN/COMMIT failure: nothing committed. Fail every member once and
      // leave any retry to the caller; never replay their callbacks (D19).
      for (const entry of entries) entry.reject(error);
      return;
    }
    entries.forEach((entry, i) => {
      const outcome = outcomes[i]!;
      if ("result" in outcome) entry.resolve(outcome.result);
      else entry.reject(outcome.failure);
    });
  }
  function schedule() {
    if (scheduled) return;
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
      authorizeItem: (input: EventInput, existing: ExistingSubscriber | null) => void,
    ): EventResult[] {
      const at = receivedAt.toISOString();
      return writeTransaction(db, () => {
        authorize();
        return items.map((value) =>
          value instanceof HttpError
            ? { status: value.status, message: value.message }
            : item(value, at, (existing) => authorizeItem(value, existing)),
        );
      });
    },
    /** One event, for sequence template data (the enrollment's trigger). */
    get(id: bigint): EventRow | null {
      return q.get("event-by-id").get(id) as EventRow | null;
    },
    /** A subscriber's events in ID order, at most `limit`. */
    list(subscriberId: bigint, limit = 1000): EventRow[] {
      return q.get("events-by-subscriber").all(subscriberId, limit) as EventRow[];
    },
    /** One page of a subscriber's events, newest first, for the admin screens. */
    page(subscriberId: bigint, page: number, perPage: number) {
      const rows = q
        .get("events-page")
        .all(subscriberId, perPage, (page - 1) * perPage) as EventRow[];
      const total = (q.get("events-count").get(subscriberId) as { n: bigint }).n;
      return {
        results: rows.map((row) => ({
          id: numberID(row.id),
          name: row.name,
          data: JSON.parse(row.data) as unknown,
          occurred_at: row.occurred_at,
          created_at: row.created_at,
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
    purge(receivedBefore: Date, window: number): bigint[] {
      return (
        q.get("events-purge").all(window, receivedBefore.toISOString()) as {
          id: bigint;
        }[]
      ).map((row) => row.id);
    },
    close: () => q.close(),
  };
}
export type EventStore = ReturnType<typeof createEventStore>;
type Subscriber = ReturnType<SubscriberStore["upsertForEvent"]>;
