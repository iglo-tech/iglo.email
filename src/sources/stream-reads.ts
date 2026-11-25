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
  /** One page of a collection (an empty or short page confirmed), or `null` past the body limit. */
  page(
    collection: string,
    params: { filter: string; sort: string; perPage: number },
    call: CallOptions,
  ): Promise<ReadonlyArray<SourceObject> | null>;
  /** `POST /api/realtime` with the body, as the service account, confirmed. */
  realtime(body: string, call: CallOptions): Promise<void>;
}

const topic = (collection: string, filter: string) =>
  `${collection}/*?options=${encodeURIComponent(JSON.stringify({ query: { filter } }))}`;

/** The ID of a record, or a permanent failure for a page the stream cannot key. */
function idOf(record: SourceObject): string {
  const id = member(record, "id");
  if (typeof id !== "string" || !idPattern.test(id)) {
    throw new SourceError("permanent", "A source record has no usable id");
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

function userItem(record: SourceObject): StreamItem {
  const id = idOf(record);
  const updated = stampOf(record, "updated");
  return { kind: "user", id, stamp: updated, record: { id, updated, fields: record } };
}

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

  /** Reads one page, and again in smaller pages while it is too large to read. */
  async function read(kind: StreamKind, filter: string, perPage: number, call: CallOptions) {
    const collection = kind === "event" ? ev.collection : users;
    const sort = kind === "event" ? "created,id" : "updated,id";
    for (let size = perPage; ; size = Math.max(1, Math.floor(size / 4))) {
      const items = await parts.page(collection, { filter, sort, perPage: size }, call);
      if (items) {
        return { items: items.map((record) => itemOf(kind, record)), more: items.length === size };
      }
      if (size === 1) {
        throw new SourceError("permanent", "A source record is larger than the response limit");
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
      const { items } = await read(kind, filter, 1, call);
      return items[0] ?? null;
    },
  };
}
