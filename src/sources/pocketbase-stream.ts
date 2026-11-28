// Native (15-external-sources sections 4 and 9, D171, D188): the PocketBase connector's part of the
// realtime stream: the realtime connection, the topic strings, the realtime subscription, catch-up
// pages on `created` (events) or `updated` (users) in `(stamp, id)` keyset order, and the mapping of
// a realtime message's record.
// src/sources/pocketbase.ts builds it with its own reads, so a stream read signs in, confirms an
// empty answer and bounds a body as every adapter read does.
import { dateLiteral, fieldName, parseSourceDate, textLiteral } from "@/sources/pocketbase-filter";
import { openRealtime, safeJson } from "@/sources/pocketbase-realtime";
import type { RealtimeOptions } from "@/sources/pocketbase-realtime";
import { isSourceObject, member, sourceJson } from "@/sources/json";
import type { SourceObject } from "@/sources/json";
import { isRecordUnreadable, isSourceError, SourceError } from "@/sources/source";
import type { CallOptions, SourceEvent } from "@/sources/source";
import { SettingsMismatch } from "@/sources/stream-record";
import type { CatchUpQuery, StreamItem, StreamKind, StreamSource } from "@/sources/stream-record";

/** PocketBase refuses a subscription string longer than this (measured, 0.40.5). */
export const TOPIC_LIMIT = 2500;
/** PocketBase refuses more subscriptions than this on one client (measured, 0.40.5). */
export const TOPICS_PER_CLIENT = 1000;
/** PocketBase refuses a filter longer than this many bytes (measured, 0.40.5: D194). */
const FILTER_LIMIT = 3500;
/**
 * B168 (D196): the room a catch-up filter keeps for what is added to it after chunking: the keyset
 * condition (two dates and an ID prefix of up to 255 UTF-16 units, at most 3 UTF-8 bytes each,
 * escaped: about 850 bytes) and the confirming read's `id =` clause (an ID of up to 100 ASCII
 * characters: about 120 bytes).
 */
const KEYSET_ROOM = 1000;
/** The most bytes of a catch-up filter before the keyset and the confirming read's clause. */
const CATCH_UP_LIMIT = FILTER_LIMIT - KEYSET_ROOM;
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** What the adapter lends the stream's reads. */
export interface StreamReadParts {
  /** The source's base URL, for the realtime connection. */
  url: string;
  /** The connector's display name, for messages (D190: PocketBase or iglo.base). */
  displayName: string;
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

/**
 * The users topic for a collection and its leaving filter, or `null` when the encoded topic is
 * longer than PocketBase takes. B171 (D199): the settings save and Test connection call this, so
 * a filter they accept is one the stream can subscribe to.
 */
export function leavingTopic(collection: string, leavingFilter: string): string | null {
  const subscription = topic(collection, `(${leavingFilter})`);
  return subscription.length > TOPIC_LIMIT ? null : subscription;
}

/** What the settings save and Test connection say of a leaving filter `leavingTopic` refuses. */
export const LEAVING_TOO_LONG = `the leaving filter is too long to subscribe to (its encoded realtime topic must fit ${TOPIC_LIMIT} characters; use fewer or shorter clauses)`;

/** B155b (D177): why a record is terminal although the source answered. */
const UNKEYED = "The source record's id is not 1 to 100 letters, digits, _ or -";
const TOO_LARGE = "The source record is larger than the response limit";
const UNREADABLE = "The source record cannot be read: its JSON nests deeper than 64 levels";

/**
 * The ID of a record, or a `SettingsMismatch` for a page with no ID at all (not a PocketBase
 * record: the settings name the wrong collection). An ID the stream does not key is the record's
 * own fault: its item is terminal.
 */
function idOf(record: SourceObject): string {
  const id = member(record, "id");
  if (typeof id !== "string" || !id) {
    throw new SettingsMismatch("A source record has no id");
  }
  return id;
}

/**
 * The stamp of a record, or a `SettingsMismatch` (B166, D194): a collection without `created` or
 * `updated` is not the one the settings mean, so a retry waits for them as a missing configured
 * field makes it wait, instead of turning terminal.
 */
function stampOf(record: SourceObject, field: "created" | "updated"): Date {
  const stamp = parseSourceDate(member(record, field));
  if (!stamp) {
    throw new SettingsMismatch(`The source's records have no ${field} date`);
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

/** The ID characters the stream store keeps of a record (`MAX_ID` in src/sources/stream-store.ts). */
const STORED_ID = 255;

/**
 * B155b (D177): the keyset condition past a record's ID. PocketBase caps no ID length (0.40.5 takes
 * a 5,000-character ID), and the filter refuses a value over 4,096 bytes, so an ID longer than the
 * store keeps (terminal: past the 100 characters the stream keys) never enters the filter: the
 * bound is its stored prefix followed by the highest code point. IDs sharing that prefix at the same
 * stamp are passed over with it, as the store's dedupe entry already counts them as one record.
 */
function pastId(id: string): string {
  if (id.length <= STORED_ID) {
    return `id > ${textLiteral(id)}`;
  }
  const cut = /[\uD800-\uDBFF]/.test(id[STORED_ID - 1] ?? "") ? STORED_ID - 1 : STORED_ID;
  return `id > ${textLiteral(`${id.slice(0, cut)}\u{10FFFF}`)}`;
}

/** A record gone between two reads: the next catch-up or retry reads what is there then. */
const gone = () => new SourceError("transient", "A source record changed while it was read");

/**
 * A page with a record whose JSON nests too deep (`RecordUnreadable`). B166 (D194): a page that is
 * not JSON at all is the configuration's failure, never narrowed to a record.
 */
const unreadable = isRecordUnreadable;

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
  /** A catch-up's filter before its keyset condition. */
  const baseFilter = (kind: StreamKind, groups: CatchUpQuery["groups"]) => {
    const bounds = groups.map(({ names, from }) =>
      kind === "event"
        ? `((${names.map(nameIs).join(" || ")}) && created >= ${dateLiteral(from)})`
        : `updated >= ${dateLiteral(from)}`,
    );
    return `${kind === "event" ? present : `(${leaving})`} && (${bounds.join(" || ")})`;
  };

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
   * limit, nested deeper than the JSON limit) is read again for its ID and stamp only, then once
   * more in full by that ID: still unreadable, it becomes a terminal item (B155b, D177), so one
   * record never stalls a catch-up or a retry; readable (the ID-only read met another record), it
   * is an ordinary item and the next page meets the unreadable one again.
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
      // Why this page could not be read: over the response limit (`null`), or a JSON failure.
      let cause = TOO_LARGE;
      try {
        items = await parts.page(collection, { filter, sort, perPage: size }, call);
      } catch (error) {
        if (!unreadable(error)) {
          throw refused(error);
        }
        items = null;
        cause = UNREADABLE;
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
        const key = keys?.[0];
        if (!key) {
          throw gone();
        }
        const id = idOf(key);
        if (!idPattern.test(id)) {
          // Terminal whether it reads or not, and an ID past the filter limit cannot be read alone.
          return { items: [terminal(kind, key, UNKEYED)], more: true };
        }
        // The ID-only read may have met another record, committed earlier in `(stamp, id)` order
        // between the two reads: that record is terminal only if it, read alone, is unreadable too.
        // D186 (amends D182): the line leads with the confirming read's cause, the only read known
        // to be of this record. The size-1 read's cause follows as context when it differs: either
        // the record changed between the two reads, or that read met another record at this
        // position in the page.
        const because = (again: string) =>
          again === cause
            ? again
            : `${again} (an earlier read at its position in the page: ${cause})`;
        let confirmed: ReadonlyArray<SourceObject> | null;
        try {
          confirmed = await parts.page(
            collection,
            { filter: `(${filter}) && id = ${textLiteral(id)}`, sort, perPage: 1 },
            call,
          );
        } catch (error) {
          if (!unreadable(error)) {
            throw refused(error);
          }
          return { items: [terminal(kind, key, because(UNREADABLE))], more: true };
        }
        if (!confirmed) {
          return { items: [terminal(kind, key, because(TOO_LARGE))], more: true };
        }
        const record = confirmed[0];
        if (!record) {
          throw gone();
        }
        return { items: [itemOf(kind, record)], more: true };
      }
    }
  }

  return {
    connect(request) {
      const options: RealtimeOptions = {
        url: parts.url,
        guard: request.guard,
        transport: request.transport,
        clock: request.clock,
        signal: request.signal,
      };
      if (request.idleMs) {
        options.idleMs = request.idleMs;
      }
      if (request.maxAgeMs) {
        options.maxAgeMs = request.maxAgeMs;
      }
      if (request.maxLine) {
        options.maxLine = request.maxLine;
      }
      return openRealtime(options);
    },
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
      const subscription = leavingTopic(users, leaving);
      if (subscription === null) {
        throw new SourceError("permanent", "The users leaving filter is too long to subscribe to");
      }
      return subscription;
    },
    async subscribe(clientId, subscriptions, call = {}) {
      if (subscriptions.length > TOPICS_PER_CLIENT) {
        throw new SourceError(
          "permanent",
          `The stream needs ${subscriptions.length} subscriptions; ${parts.displayName} takes ${TOPICS_PER_CLIENT}`,
        );
      }
      await parts.realtime(JSON.stringify({ clientId, subscriptions }), call);
    },
    catchUpChunks(groups) {
      // Names are added one at a time to the chunk's last group while it has the same bound; a
      // name that would take the filter past the limit starts the next chunk. A chunk always takes
      // its first name (one name too long for any chunk is refused when it is subscribed).
      const chunks: Array<Array<{ names: Array<string>; from: Date }>> = [];
      let chunk: Array<{ names: Array<string>; from: Date }> = [];
      for (const { names, from } of groups) {
        let opened = false;
        for (const name of names) {
          const last = chunk.at(-1);
          const candidate =
            opened && last
              ? [...chunk.slice(0, -1), { names: [...last.names, name], from }]
              : [...chunk, { names: [name], from }];
          if (chunk.length && Buffer.byteLength(baseFilter("event", candidate)) > CATCH_UP_LIMIT) {
            chunks.push(chunk);
            chunk = [{ names: [name], from }];
          } else {
            chunk = candidate;
          }
          opened = true;
        }
      }
      if (chunk.length) {
        chunks.push(chunk);
      }
      return chunks;
    },
    catchUp(query: CatchUpQuery, call: CallOptions = {}) {
      const field = query.kind === "event" ? "created" : "updated";
      const clauses: Array<string> = [baseFilter(query.kind, query.groups)];
      if (query.after) {
        const at = dateLiteral(query.after.stamp);
        clauses.push(`(${field} > ${at} || (${field} = ${at} && ${pastId(query.after.id)}))`);
      }
      return read(query.kind, clauses.join(" && "), query.perPage, call);
    },
    item(kind, data) {
      const payload = safeJson(data);
      if (payload === undefined) {
        return "unreadable";
      }
      const message = member(payload, "action");
      const action = typeof message === "string" ? message : "";
      const value = sourceJson(member(payload, "record"));
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
