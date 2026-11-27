// Native (15-external-sources section 1, D169, D170): the `ExternalSource` interface. Sequence and
// subscriber code reads a project's source through it and never through PocketBase details;
// PocketBase (src/sources/pocketbase.ts) is its one adapter (D89). B150b adds `subscribe` and
// `catchUp` to the adapter for the realtime stream.
//
// Rules every operation keeps:
// - It is a network call: never call one inside a SQLite transaction.
// - It takes an `AbortSignal` and a time limit per request (on the injected clock). A caller's
//   abort rejects with the signal's reason; the time limit is a transient `SourceError`.
// - A failure is a `SourceError`, transient (retry later) or permanent (a configuration problem a
//   retry cannot fix). An error never reads as "absent", "zero" or "false".
// - A response body is read up to a fixed size; a larger one is a permanent failure.
// - "Absent" answers (`null`, 0, false, a short last page) are confirmed: PocketBase treats an
//   invalid token as a guest and answers a rule-protected read with an empty list or a 404, so the
//   adapter checks its token after such an answer and repeats the read once after signing in again.

import type { SourceJson, SourceObject } from "@/sources/json";

/** A JSON scalar an event predicate compares with: text, a finite number or a boolean. */
export type SourceScalar = string | number | boolean;

export type SourceErrorKind = "transient" | "permanent";

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    /** The HTTP status the source answered, when it answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** Whether a caught value is a `SourceError` (by its name: errors cross no realm here). */
export const isSourceError = (error: unknown): error is SourceError =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "SourceError" &&
  "kind" in error;

/**
 * B166 (D194): a permanent failure that is one record's own, not the settings': a single record's
 * answer over the response limit, an answer whose JSON nests deeper than the limit (on a page, one of
 * its records), or a mapped field of the record that is not of its type. A body that is not JSON at
 * all (a proxy's, maintenance or sign-in page) is never one: it is the configuration's. The adapter
 * raises it (src/sources/pocketbase.ts), and the stream narrows a page to the record it names
 * (src/sources/stream-reads.ts).
 */
export class RecordUnreadable extends SourceError {
  readonly recordUnreadable = true;
}
export const isRecordUnreadable = (error: unknown): error is RecordUnreadable =>
  isSourceError(error) && "recordUnreadable" in error && error.recordUnreadable === true;

/** Per call: the caller's signal and each request's time limit (default `DEFAULT_TIMEOUT_MS`). */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** An events record, with the mapped fields under their iglo.email names. */
export interface SourceEvent {
  id: string;
  /** The user's ID: a subscriber's `external_id`. */
  user: string;
  name: string;
  /** The record's JSON data, as PocketBase returns it (any JSON value; `null` when empty). */
  data: SourceJson;
  occurredAt: Date;
  /** The idempotency key; "" without a mapped key field or a value. */
  key: string;
  /** When PocketBase created the record. */
  created: Date;
}

/** What `scan` returns for each record: always `id` and `occurredAt`, other fields on request. */
export type ScannedEvent = Pick<SourceEvent, "id" | "occurredAt"> &
  Partial<Pick<SourceEvent, "user" | "name" | "data" | "key">>;
export type ScanField = "user" | "name" | "data" | "key";

/** The recipients-view row of one user. */
export interface SourceRecipient {
  id: string;
  email: string;
  /** "" when the view has no name or the mapping names no field. */
  name: string;
  /** The opt-out field's value; false without a mapped field. */
  optOut: boolean;
  /** Every field of the row, for the `recipient` condition kind (not stored). */
  fields: SourceObject;
}

/**
 * Which events records an operation reads. Every part narrows: `user` (the relation equals),
 * `names` (the name is one of them), `after` (occurredAt strictly after), `through` (occurredAt at
 * or before) and `data` (each `data.<path>` equals the value). PocketBase compares JSON loosely
 * (spec section 9), so a caller that needs strict types re-checks `data` on the rows it reads.
 */
export interface EventQuery {
  user?: string;
  names?: ReadonlyArray<string>;
  after?: Date;
  through?: Date;
  /**
   * Keys are paths inside `data` (`plan`, `order.total`), without a `data.` prefix. A narrowing
   * only: the adapter may leave a part out (one past PocketBase's filter limit, B166), so a caller
   * checks `data` again on the rows it reads (src/conditions/source.ts does).
   */
  data?: Readonly<Record<string, SourceScalar>>;
}

export interface ExternalSource {
  /** The recipients-view row of the user, or `null` when the view has no such user. */
  recipient(externalId: string, options?: CallOptions): Promise<SourceRecipient | null>;
  /** One events record, or `null` when there is none with that ID. */
  record(id: string, options?: CallOptions): Promise<SourceEvent | null>;
  /** The newest matching events record by `(occurredAt, id)`, or `null`. */
  latest(query: EventQuery, options?: CallOptions): Promise<SourceEvent | null>;
  /** How many records match, counting no further than `upTo` (at most `AGGREGATE_SCAN_LIMIT`). */
  count(query: EventQuery, upTo: number, options?: CallOptions): Promise<number>;
  /** Whether any record matches. */
  exists(query: EventQuery, options?: CallOptions): Promise<boolean>;
  /**
   * The matching records in pages, oldest first by `(occurredAt, id)` (keyset paging, `skipTotal`),
   * stopping after `limit` records. Each page holds at most `PAGE_LIMIT` records. Stop iterating
   * to stop reading.
   */
  scan(
    query: EventQuery,
    fields: ReadonlyArray<ScanField>,
    limit: number,
    options?: CallOptions,
  ): AsyncGenerator<ReadonlyArray<ScannedEvent>, void, void>;
}

/** PocketBase caps `perPage` at 1000 (spec section 9). */
export const PAGE_LIMIT = 1000;
/** The default time limit of one request. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The most records `count` and `scan` read in one call. */
export const SCAN_LIMIT = 100_000;
