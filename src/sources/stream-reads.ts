// Native (15-external-sources sections 4 and 9, D171): the PocketBase adapter's part of the
// realtime stream: the topic strings, the realtime subscription, catch-up pages on `created` (events)
// or `updated` (users) in `(stamp, id)` keyset order, and the mapping of a realtime message's record.
// src/sources/pocketbase.ts builds it with its own reads, so a stream read signs in, confirms an
// empty answer and bounds a body as every adapter read does.
import { dateLiteral, fieldName, parseSourceDate, textLiteral } from "@/sources/filter";
import { isSourceObject, member, sourceJson } from "@/sources/json";
import type { SourceObject } from "@/sources/json";
import { isSourceError, SourceError } from "@/sources/source";
import type { CallOptions, SourceEvent } from "@/sources/source";
import { SettingsMismatch } from "@/sources/stream-record";
import type { CatchUpQuery, StreamItem, StreamKind, StreamSource } from "@/sources/stream-record";

/** PocketBase refuses a subscription string longer than this (measured, 0.40.5). */
export const TOPIC_LIMIT = 2500;
/** PocketBase refuses more subscriptions than this on one client (measured, 0.40.5). */
export const TOPICS_PER_CLIENT = 1000;
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** What the adapter lends the stream's reads. */
export interface StreamReadParts {
  events: {
    collection: string;
    user: string;
    name: string;
    data: string;
    occurredAt: string;
    key: string;
  };
  users: { collection: string; leavingFilter: string };
  eventOf(record: SourceObject): SourceEvent;
  /**
   * One page of a collection (an empty or short page confirmed), or `null` past the body limit;
   * `fields` limits each record to those fields.
   */
  page(
    collection: string,
    params: { filter: string; sort: string; perPage: number; fields?: Array<string> },
    call: CallOptions,
  ): Promise<ReadonlyArray<SourceObject> | null>;
  /** `POST /api/realtime` with the body, as the service account, confirmed. */
  realtime(body: string, call: CallOptions): Promise<void>;
}

const topic = (collection: string, filter: string) =>
  `${collection}/*?options=${encodeURIComponent(JSON.stringify({ query: { filter } }))}`;

/** B155b (D177): why a record is terminal although the source answered. */
const UNKEYED = "The source record's id is not 1 to 100 letters, digits, _ or -";
const TOO_LARGE = "The source record is larger than the response limit";
const UNREADABLE =
  "The source record cannot be read: its JSON nests deeper than 64 levels or is not JSON";

/**
 * The ID of a record, or a permanent failure for a page with no ID at all (not a PocketBase
 * record: the settings name the wrong collection). An ID the stream does not key is the record's
 * own fault: its item is terminal.
 */
function idOf(record: SourceObject): string {
  const id = member(record, "id");
  if (typeof id !== "string" || !id) {
    throw new SourceError("permanent", "A source record has no id");
  }
  return id;
}

function stampOf(record: SourceObject, field: "created" | "updated"): Date {
  const stamp = parseSourceDate(member(record, field));
  if (!stamp) {
    throw new SourceError("permanent", `The source's records have no ${field} date`);
  }
  return stamp;
}

const stampField = (kind: StreamKind) => (kind === "event" ? "created" : "updated");

/** A record the stream cannot act on, keyed by its ID and stamp: terminal, and the stream goes on. */
function terminal(kind: StreamKind, record: SourceObject, error: string): StreamItem {
  return { kind, id: idOf(record), stamp: stampOf(record, stampField(kind)), record: null, error };
}

function userItem(record: SourceObject): StreamItem {
  const id = idOf(record);
  if (!idPattern.test(id)) {
    return terminal("user", record, UNKEYED);
  }
  const updated = stampOf(record, "updated");
  return { kind: "user", id, stamp: updated, record: { id, updated, fields: record } };
}

/** A page the source answered with a body the adapter refused to read (not JSON, too deep). */
const unreadable = (error: unknown) =>
  isSourceError(error) &&
  error.kind === "permanent" &&
  error.status !== undefined &&
  error.status >= 200 &&
  error.status < 300;

export function streamReads(parts: StreamReadParts): StreamSource {
  const ev = parts.events;
  const users = parts.users.collection ? fieldName(parts.users.collection) : "";
  const leaving = parts.users.leavingFilter;
  /** The fields the settings name on an events record; one missing is a settings mismatch. */
  const configured = [ev.user, ev.name, ev.data, ev.occurredAt, ...(ev.key ? [ev.key] : [])];
  const nameIs = (name: string) => `${ev.name} = ${textLiteral(name)}`;
  const present = `${ev.occurredAt} != ''`;
  const build = (list: ReadonlyArray<string>) =>
    topic(ev.collection, `${present} && (${list.map(nameIs).join(" || ")})`);

  function eventItem(record: SourceObject): StreamItem {
    const id = idOf(record);
    if (!idPattern.test(id)) {
      return terminal("event", record, UNKEYED);
    }
    const stamp = stampOf(record, "created");
    for (const field of configured) {
      if (member(record, field) === undefined) {
        throw new SettingsMismatch(
          `The source's ${ev.collection} records have no field ${JSON.stringify(field)}`,
        );
      }
    }
    try {
      return { kind: "event", id, stamp, record: parts.eventOf(record) };
    } catch (error) {
      if (!isSourceError(error)) {
        throw error;
      }
      return { kind: "event", id, stamp, record: null, error: error.message };
    }
  }
  const itemOf = (kind: StreamKind, record: SourceObject) =>
    kind === "event" ? eventItem(record) : userItem(record);

  /**
   * Reads one page, and again in smaller pages while it is too large or too deep to read. With
   * `refusal`, a permanent error of the read itself (a `400` for a renamed filter field, a `404`
   * collection, a `403` lost access, a refused sign-in) is a `SettingsMismatch`: the source refuses
   * the read, the record is not at fault. A single record still unreadable alone (over the response
   * limit, nested deeper than the JSON limit) is read again for its ID and stamp only, and becomes a
   * terminal item (B155b, D177): one record never stalls a catch-up or a retry.
   */
  async function read(
    kind: StreamKind,
    filter: string,
    perPage: number,
    call: CallOptions,
    refusal = false,
  ) {
    const collection = kind === "event" ? ev.collection : users;
    const sort = `${stampField(kind)},id`;
    const refused = (error: unknown) =>
      refusal && isSourceError(error) && error.kind === "permanent"
        ? new SettingsMismatch(error.message)
        : error;
    for (let size = perPage; ; size = Math.max(1, Math.floor(size / 4))) {
      let items: ReadonlyArray<SourceObject> | null;
      let reason = TOO_LARGE;
      try {
        items = await parts.page(collection, { filter, sort, perPage: size }, call);
      } catch (error) {
        if (!unreadable(error)) {
          throw refused(error);
        }
        items = null;
        reason = UNREADABLE;
      }
      if (items) {
        return { items: items.map((record) => itemOf(kind, record)), more: items.length === size };
      }
      if (size === 1) {
        let keys: ReadonlyArray<SourceObject> | null;
        try {
          const fields = ["id", stampField(kind)];
          keys = await parts.page(collection, { filter, sort, perPage: 1, fields }, call);
        } catch (error) {
          throw refused(error);
        }
        const record = keys?.[0];
        if (!record) {
          // Gone between the two reads: the next catch-up or retry reads what is there then.
          throw new SourceError("transient", "A source record changed while it was read");
        }
        return { items: [terminal(kind, record, reason)], more: true };
      }
    }
  }

  return {
    eventTopics(names) {
      const topics: Array<{ topic: string; names: Array<string> }> = [];
      let chunk: Array<string> = [];
      let current = "";
      for (const name of names) {
        const next = build([...chunk, name]);
        if (next.length <= TOPIC_LIMIT) {
          chunk.push(name);
          current = next;
          continue;
        }
        if (!chunk.length) {
          throw new SourceError("permanent", `An event name is too long to subscribe to: ${name}`);
        }
        topics.push({ topic: current, names: chunk });
        chunk = [name];
        current = build(chunk);
        if (current.length > TOPIC_LIMIT) {
          throw new SourceError("permanent", `An event name is too long to subscribe to: ${name}`);
        }
      }
      if (chunk.length) {
        topics.push({ topic: current, names: chunk });
      }
      return topics;
    },
    usersTopic() {
      if (!users) {
        return null;
      }
      const subscription = topic(users, `(${leaving})`);
      if (subscription.length > TOPIC_LIMIT) {
        throw new SourceError("permanent", "The users leaving filter is too long to subscribe to");
      }
      return subscription;
    },
    async subscribe(clientId, subscriptions, call = {}) {
      if (subscriptions.length > TOPICS_PER_CLIENT) {
        throw new SourceError(
          "permanent",
          `The stream needs ${subscriptions.length} subscriptions; PocketBase takes ${TOPICS_PER_CLIENT}`,
        );
      }
      await parts.realtime(JSON.stringify({ clientId, subscriptions }), call);
    },
    catchUp(query: CatchUpQuery, call: CallOptions = {}) {
      const field = query.kind === "event" ? "created" : "updated";
      const groups = query.groups.map(({ names, from }) =>
        query.kind === "event"
          ? `((${names.map(nameIs).join(" || ")}) && created >= ${dateLiteral(from)})`
          : `updated >= ${dateLiteral(from)}`,
      );
      const clauses: Array<string> = [
        query.kind === "event" ? present : `(${leaving})`,
        `(${groups.join(" || ")})`,
      ];
      if (query.after) {
        const at = dateLiteral(query.after.stamp);
        const id = textLiteral(query.after.id);
        clauses.push(`(${field} > ${at} || (${field} = ${at} && id > ${id}))`);
      }
      return read(query.kind, clauses.join(" && "), query.perPage, call);
    },
    item(kind, action, record) {
      const value = sourceJson(record);
      if (!isSourceObject(value)) {
        return null;
      }
      if (
        kind === "event" ? action !== "create" : !["create", "update", "delete"].includes(action)
      ) {
        return null;
      }
      return itemOf(kind, value);
    },
    async reread(kind, id, call = {}) {
      if (!idPattern.test(id) || (kind === "user" && !users)) {
        return null;
      }
      const filter =
        kind === "event"
          ? `${present} && id = ${textLiteral(id)}`
          : `(${leaving}) && id = ${textLiteral(id)}`;
      const { items } = await read(kind, filter, 1, call, true);
      return items[0] ?? null;
    },
  };
}
