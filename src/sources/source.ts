// Native (15-external-sources section 1, D169, D170, D187, D188): the connector-neutral types. Sequence,
// subscriber, scheduler and campaign code reads a project's source through `ExternalSource` and
// never through a connector's details; the stream, the record handler and Test connection use the
// rest of `ConnectorSource`. A connector (src/sources/connectors.ts lists them) implements it:
// PocketBase's is src/sources/pocketbase.ts. `SourceConfig` is the settings every connector reads.
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

import type { Clock } from "@/clock";
import type { Guard, SourceTransport } from "@/sources/connect";
import type { SourceJson, SourceObject } from "@/sources/json";
import type { StreamSource } from "@/sources/stream-record";

/** A JSON scalar an event predicate compares with: text, a finite number or a boolean. */
export type SourceScalar = string | number | boolean;

/**
 * How a failure is classified (D188): `transient` (retry later), `permanent` (a configuration
 * problem a retry cannot fix) or `notFound` (the source cannot have the record asked for: an ID
 * outside its format, such as an `external_id` pushed events set before the project moved to a
 * source). A `notFound` failure is permanent for retrying; `isPermanent` covers both.
 */
export type SourceErrorKind = "transient" | "permanent" | "notFound";

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

/** A failure a retry cannot fix: `permanent` or `notFound`. */
export const isPermanent = (error: unknown): error is SourceError =>
  isSourceError(error) && error.kind !== "transient";

/** B155d (D179), D188: the source cannot have the record asked for (refused before any request). */
export const isNotFound = (error: unknown): error is SourceError =>
  isSourceError(error) && error.kind === "notFound";

/**
 * B166 (D194): the service account's sign-in or token check refused for good (a wrong or rotated
 * password, a removed account or auth collection, a page that is not JSON). A connector raises it
 * whatever the status was (PocketBase answers a refused sign-in with a `400`, as a refused filter),
 * so the mark, not the status, tells a caller the settings are at fault.
 */
export class AuthRefused extends SourceError {
  readonly authRefused = true;
}
export const isAuthRefused = (error: unknown): error is AuthRefused =>
  isSourceError(error) && "authRefused" in error && error.authRefused === true;

/**
 * B166 (D194): a permanent failure that is one record's own, not the settings': a single record's
 * answer over the response limit, an answer whose JSON nests deeper than the limit (on a page, one of
 * its records), or a mapped field of the record that is not of its type. A body that is not JSON at
 * all (a proxy's, maintenance or sign-in page) is never one: it is the configuration's. The adapter
 * raises it (src/sources/pocketbase.ts), and the stream narrows a page to the record it names
 * (src/sources/pocketbase-stream.ts).
 */
export class RecordUnreadable extends SourceError {
  readonly recordUnreadable = true;
}
export const isRecordUnreadable = (error: unknown): error is RecordUnreadable =>
  isSourceError(error) && "recordUnreadable" in error && error.recordUnreadable === true;

/**
 * B166 (D194): a query the connector cannot write as a filter (a value too long, a number out of
 * range, a data path the source cannot name, too many names). It is the query's own fault, a
 * condition's, not the source settings': a caller never waits for the settings to fix it.
 */
export class UnfitQuery extends SourceError {
  readonly unfitQuery = true;
  constructor(message: string) {
    super("permanent", message);
  }
}
export const isUnfitQuery = (error: unknown): error is UnfitQuery =>
  isSourceError(error) && "unfitQuery" in error && error.unfitQuery === true;

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

/**
 * The source settings every connector reads (D188): src/sources/settings.ts builds it from the
 * project's `source.*` keys. The grant rules are read on their own (`storedGrantRules`), so a rule
 * change resubscribes the stream instead of restarting it.
 */
export interface SourceConfig {
  /** The base URL, without a trailing slash. */
  url: string;
  /** The service account: its auth collection, identity and password. */
  authCollection: string;
  identity: string;
  password: string;
  events: {
    collection: string;
    user: string;
    name: string;
    data: string;
    occurredAt: string;
    /** "" when the collection has no idempotency key field. */
    key: string;
  };
  recipients: {
    collection: string;
    email: string;
    /** "" when the view has no name field. */
    name: string;
    /** "" when the view has no opt-out field. */
    optOut: string;
  };
  users: {
    /** "" when no users collection is watched for leaving. */
    collection: string;
    leavingFilter: string;
  };
}

/** One step of Test connection. */
export interface CheckStep {
  /** `auth`, `recipients`, `events` or `users`. */
  step: string;
  ok: boolean;
  message: string;
  /** Mapped fields the collection does not have. */
  missing: Array<string>;
}
export interface CheckReport {
  ok: boolean;
  steps: Array<CheckStep>;
}

/** What a connector's `create` receives: the settings, the clock and the network policy. */
export interface ConnectorOptions {
  config: SourceConfig;
  clock: Clock;
  guard: Guard;
  /** A test's observed transport; production uses `fetch`. */
  transport?: SourceTransport | undefined;
}

/** What the stream and the record handler need of a connector beyond reading. */
export interface ConnectorSource extends ExternalSource {
  /** The realtime stream's part: topics, subscriptions, catch-up pages and re-reads. */
  readonly stream: StreamSource;
  /**
   * B166 (D194): one probe of the events collection naming every mapped field and no condition,
   * reading no record: it resolves when the settings read, and fails as the settings fail.
   */
  eventsSchema(call?: CallOptions): Promise<void>;
}

/** What a connector's settings validator is told of a save. */
export interface ConnectorSave {
  /** The normalized settings. */
  config: SourceConfig;
  /** The save changes `source.users`, or turns the source on (B171, D199: check the topic then). */
  usersChanged: boolean;
}

/** One entry of the connector list (src/sources/connectors.ts, D188). */
export interface Connector {
  /** The name the settings page and the validation messages show. */
  readonly displayName: string;
  /** An example of the source URL, for the URL's validation message. */
  readonly exampleUrl: string;
  /** The connector's reader, stream part and schema probe on these settings. */
  create(options: ConnectorOptions): ConnectorSource;
  /** Test connection (section 2): signs in and checks each collection, reporting each step. */
  check(options: ConnectorOptions): Promise<CheckReport>;
  /** The connector's own rules on a save, after the shared ones; throws a 400 to refuse it. */
  validate(save: ConnectorSave, fail: (message: string) => never): void;
}

/** PocketBase caps `perPage` at 1000 (spec section 9). */
export const PAGE_LIMIT = 1000;
/** The default time limit of one request. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The most records `count` and `scan` read in one call. */
export const SCAN_LIMIT = 100_000;
