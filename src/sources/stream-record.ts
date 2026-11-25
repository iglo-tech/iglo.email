// Native (15-external-sources section 4, D169, D171): what the realtime stream hands on and what
// it needs of the source. The stream (src/sources/stream.ts) receives records, skips the ones it
// has handled, and gives each one to a `RecordHandler`; B150d implements the handler.
import type { SourceObject } from "@/sources/json";
import { isSourceError, SourceError } from "@/sources/source";
import type { CallOptions, SourceEvent } from "@/sources/source";

/**
 * A record that lacks a field the source settings name (a misnamed or removed field): the
 * settings are wrong, not the record. It is a refusal of the whole stream: the stream stops at the
 * record without consuming it, writes one attention line, and tries again later, so fixing the
 * settings (or the source's schema) delivers every record. A retry keeps its row and waits. A
 * retry's re-read that the source refuses outright (a permanent error of the read itself) is one
 * too: the record is not at fault.
 */
export class SettingsMismatch extends SourceError {
  readonly settingsMismatch = true;
  constructor(message: string) {
    super("permanent", message);
  }
}

export const isSettingsMismatch = (error: unknown): error is SettingsMismatch =>
  isSourceError(error) && "settingsMismatch" in error && error.settingsMismatch === true;

/** The two kinds of record the stream receives: events `create`s and users matching the leaving filter. */
export type StreamKind = "event" | "user";

/** A users record that matches the leaving filter. */
export interface SourceUser {
  /** The user's ID: a subscriber's `external_id`. */
  id: string;
  /** When PocketBase last updated the record (the stream's stamp for users). */
  updated: Date;
  /** Every field of the record, as PocketBase returned it (not stored). */
  fields: SourceObject;
}

/**
 * A record with its kind, ID and stamp (`created` for events, `updated` for users). A record the
 * mapping cannot read although every configured field is there (a relation that is not one, an
 * `occurredAt` that is no date) has `record: null` and the reason: it goes to the retry queue as
 * terminal, and the stream goes on. A configured field missing is a `SettingsMismatch` instead.
 */
export type StreamItem = { id: string; stamp: Date } & (
  | { kind: "event"; record: SourceEvent }
  | { kind: "user"; record: SourceUser }
  | { kind: StreamKind; record: null; error: string }
);

/**
 * The stream's part of a handler's write. Call `write()` inside the handler's one write
 * transaction (the subscriber upsert, grants, exit-then-trigger): it records the record as
 * handled, so a later catch-up or retry skips it. It throws when the record was handled already
 * (or a retry lost its claim), which rolls the handler's transaction back.
 */
export interface RecordCommit {
  write(): void;
}

/**
 * What a record does (B150d). Each method first does its source reads, then one SQLite write
 * transaction that includes `commit.write()`. A method that has nothing to write may return
 * without calling it; the stream then writes the entry itself. A thrown transient `SourceError`
 * (or any other error) puts the record in the retry queue with nothing written; a permanent one
 * makes it terminal at once. Calls may overlap: the stream and the retry queue each call it,
 * one record at a time each.
 */
export interface RecordHandler {
  /** An events record PocketBase created, named by a subscribed trigger, exit or grant. */
  event(record: SourceEvent, commit: RecordCommit, signal: AbortSignal): Promise<void>;
  /** A users record that matches the leaving filter. */
  userLeft(record: SourceUser, commit: RecordCommit, signal: AbortSignal): Promise<void>;
}

/** Which records a catch-up page reads: one or more lower bounds, and a keyset position. */
export interface CatchUpQuery {
  kind: StreamKind;
  /**
   * Events: groups of names, each read from its own bound (`created` at or after `from`). Users:
   * one group with no names (`updated` at or after `from`, matching the leaving filter).
   */
  groups: ReadonlyArray<{ names: ReadonlyArray<string>; from: Date }>;
  /** Only records strictly after this `(stamp, id)`. */
  after?: { stamp: Date; id: string } | undefined;
  perPage: number;
}

/** What the stream needs of the adapter (the PocketBase adapter's `stream`). */
export interface StreamSource {
  /**
   * The realtime topics for these event names: several past PocketBase's length limit, each with
   * the names it holds (a catch-up reads the same groups).
   */
  eventTopics(names: ReadonlyArray<string>): Array<{ topic: string; names: Array<string> }>;
  /** The users topic, or `null` without a watched users collection. */
  usersTopic(): string | null;
  /** Sets a realtime client's subscriptions, authenticated as the service account. */
  subscribe(
    clientId: string,
    subscriptions: ReadonlyArray<string>,
    call?: CallOptions,
  ): Promise<void>;
  /**
   * One catch-up page, oldest first by `(stamp, id)`; `more` when the page was full (a page too
   * large to read is read again in smaller pages, so it may hold fewer than `perPage`).
   */
  catchUp(
    query: CatchUpQuery,
    call?: CallOptions,
  ): Promise<{ items: Array<StreamItem>; more: boolean }>;
  /** A realtime message's record as an item, or `null` for a record the stream does not act on. */
  item(kind: StreamKind, action: string, record: unknown): StreamItem | null;
  /**
   * One record again, for the retry queue: `null` when it is gone (or no longer leaving). A
   * permanent error of the read itself is a `SettingsMismatch`; a record over the response limit
   * stays a plain permanent error.
   */
  reread(kind: StreamKind, id: string, call?: CallOptions): Promise<StreamItem | null>;
}
