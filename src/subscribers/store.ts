// Adapted from listmonk internal/core/subscribers.go, internal/core/subscriptions.go and queries/subscribers.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { trimSpace } from "@/lists/store";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { ListReferences } from "@/lists/references";
import type { SubscriberInput } from "@/subscribers/input";
import { HttpError } from "@/server/response";
import { titleWords } from "@/subscribers/unicode-title";
import sql from "@/subscribers/store.sql" with { type: "text" };

interface Row {
  id: bigint;
  uuid: string;
  email: string;
  name: string;
  status: string;
  attribs: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}
interface Membership {
  subscriber_id: bigint;
  list_id: bigint;
  status: string;
  meta: string;
  created_at: string;
  updated_at: string;
}
/**
 * The subscriber part of a subscriber event (docs/design/05-sequences.md#events-api), after
 * field validation: `email` is sanitized, `external_id` passed validExternal, `name` is
 * trimmed and `attribs` holds top-level replacements where `null` removes a key.
 */
export interface EventSubscriber {
  external_id?: string;
  email?: string;
  name?: string;
  attribs?: Record<string, unknown>;
}
/** Largest merged attribute JSON an event may produce, unless it already was larger. */
export const EVENT_ATTRIBS_BYTES = 64 * 1024;
// The create default from routes.ts validate: title-cased words of the local part.
const nameFromEmail = (email: string) =>
  email
    .split("@")[0]!
    .replaceAll(".", " ")
    .split(/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/)
    .filter(Boolean)
    .map(titleWords)
    .join(" ");
/**
 * Consent effects of subscriber writes, called inside the caller's write transaction
 * (docs/design/04-sending.md#unsubscribe). M5.3 ends the affected sequence enrollments.
 */
export interface SubscriberEffects {
  /** The subscribers are now blocklisted. */
  blocklisted(ids: bigint[]): void;
  /** The subscribers' memberships of `listIds` are now unsubscribed. */
  unsubscribed(ids: bigint[], listIds: bigint[]): void;
}
export const noSubscriberEffects: SubscriberEffects = {
  blocklisted() {},
  unsubscribed() {},
};
export interface Scope {
  all: boolean;
  ids: bigint[];
}
const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
export function createSubscriberStore(
  db: Database,
  clock: Clock,
  lists: ListReferences,
  effects: SubscriberEffects = noSubscriberEffects,
) {
  const q = prepareNamedQueries(db, [{ name: "subscribers/store", sql }]);
  const get = (id: bigint) => q.get("subscriber-by-id").get(id) as Row | null;
  const memberships = (id: bigint) => q.get("subscriber-memberships").all(id) as Membership[];
  const project = (row: Row, scope: Scope) => ({
    id: numberID(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    uuid: row.uuid,
    email: row.email,
    name: row.name,
    attribs: JSON.parse(row.attribs),
    status: row.status,
    external_id: row.external_id,
    lists: memberships(row.id).map((m) => {
      const list = lists.subscriberMetadata(m.list_id);
      if (!list) throw new Error("Missing list");
      const value: Record<string, unknown> = {
        subscription_status: m.status,
        subscription_created_at: m.created_at,
        subscription_updated_at: m.updated_at,
        subscription_meta: JSON.parse(m.meta),
        ...list,
        id: numberID(m.list_id),
      };
      if (!scope.all && !scope.ids.includes(m.list_id)) {
        value.name = "*Unknown";
        value.restricted = true;
        delete value.description;
      }
      return value;
    }),
  });
  const external = (key: string) => q.get("subscriber-by-external").get(key) as Row | null;
  const byEmail = (email: string) => q.get("subscriber-by-email").get(email) as Row | null;
  const conflict = (error: unknown): never => {
    if (error instanceof Error && error.message.includes("subscribers.external_id"))
      throw new HttpError(409, "External ID already exists");
    if (error instanceof Error && error.message.includes("subscribers.email"))
      throw new HttpError(409, "E-mail already exists.");
    throw error;
  };
  const permittedLists = (requested: bigint[], scope: Scope) =>
    requested.filter((id) => scope.all || scope.ids.includes(id));
  const replace = (
    id: bigint,
    requested: bigint[],
    scope: Scope,
    status: string,
    preconfirm: boolean,
    now: string,
  ) => {
    const resolved = [
      ...new Set(requested.filter((list) => lists.subscriberMetadata(list) !== null)),
    ];
    for (const m of memberships(id))
      if ((scope.all || scope.ids.includes(m.list_id)) && !resolved.includes(m.list_id))
        q.get("membership-delete").run(id, m.list_id);
    for (const list of resolved) {
      const previous = memberships(id).find((m) => m.list_id === list);
      const target =
        status === "blocklisted"
          ? "unsubscribed"
          : previous?.status === "confirmed" || previous?.status === "unsubscribed"
            ? previous.status
            : preconfirm
              ? "confirmed"
              : "unconfirmed";
      if (previous) q.get("membership-status").run(target, id, list);
      else q.get("membership-insert").run(id, list, target, now, now);
    }
  };
  return {
    get,
    external,
    byEmail,
    memberships,
    project,
    transaction(fn: () => Response): Response {
      return writeTransaction(db, fn);
    },
    create(input: SubscriberInput & { email: string; name: string }, scope: Scope) {
      const now = clock.now().toISOString(),
        status = input.status || "enabled";
      if (input.external_id != null && external(input.external_id))
        throw new HttpError(409, "External ID already exists");
      try {
        const row = q
          .get("subscriber-insert")
          .get(
            crypto.randomUUID(),
            input.email,
            input.name,
            status,
            JSON.stringify(input.attribs ?? {}),
            input.external_id ?? null,
            now,
            now,
          ) as { id: bigint };
        replace(
          row.id,
          permittedLists(input.lists ?? [], scope),
          scope,
          status,
          input.preconfirm_subscriptions ?? false,
          now,
        );
        return get(row.id)!;
      } catch (error) {
        return conflict(error);
      }
    },
    update(row: Row, input: SubscriberInput, patch: boolean, scope: Scope) {
      const now = clock.now().toISOString();
      const email = input.email || row.email,
        name = (input.name === undefined ? undefined : trimSpace(input.name)) || row.name,
        status = input.status || row.status;
      const attrs = patch
        ? input.attribs === undefined
          ? JSON.parse(row.attribs)
          : input.attribs === null
            ? {}
            : {
                ...(input.attribsReset ? {} : JSON.parse(row.attribs)),
                ...input.attribs,
              }
        : (input.attribs ?? {});
      if (input.external_id != null) {
        const existing = external(input.external_id);
        if (existing && existing.id !== row.id)
          throw new HttpError(409, "External ID already exists");
      }
      try {
        q.get("subscriber-update").run(
          email,
          name,
          status,
          JSON.stringify(attrs),
          input.external_id === undefined ? row.external_id : input.external_id,
          now,
          row.id,
        );
        if (!patch || (input.lists !== undefined && input.lists !== null))
          replace(
            row.id,
            permittedLists(input.lists ?? [], scope),
            scope,
            patch ? (input.status ?? row.status) : (input.status ?? ""),
            input.preconfirm_subscriptions ?? false,
            now,
          );
      } catch (error) {
        return conflict(error);
      }
      if (status === "blocklisted") effects.blocklisted([row.id]);
      return get(row.id)!;
    },
    remove(ids: bigint[]) {
      for (const id of ids) q.get("subscriber-delete").run(id);
    },
    blocklist(ids: bigint[]) {
      const now = clock.now().toISOString();
      for (const id of ids) {
        q.get("subscriber-blocklist").run(now, id);
        q.get("membership-blocklist").run(now, id);
      }
      effects.blocklisted(ids);
    },
    action(ids: bigint[], listIDs: bigint[], action: string, status: string) {
      const now = clock.now().toISOString();
      for (const id of new Set(ids))
        for (const list of new Set(listIDs)) {
          const existing = memberships(id).find((m) => m.list_id === list);
          if (action === "add") {
            if (!existing)
              q.get("membership-insert").run(id, list, status || "unconfirmed", now, now);
            else if (status) q.get("membership-status").run(status, id, list);
            if (status === "unsubscribed") effects.unsubscribed([id], [list]);
          } else if (action === "remove") q.get("membership-delete").run(id, list);
          else if (action === "unsubscribe") {
            if (existing) q.get("membership-update").run("unsubscribed", now, id, list);
            // An absent membership stays absent, but the consent action still ends the
            // list's enrollments.
            effects.unsubscribed([id], [list]);
          }
        }
    },
    /** Event lookup: by `external_id`, then by `email`. Read-only; the caller holds the write. */
    resolveForEvent(input: EventSubscriber): Row | null {
      return (
        (input.external_id === undefined ? null : external(input.external_id)) ??
        (input.email === undefined ? null : byEmail(input.email))
      );
    },
    /**
     * Create or update the subscriber an event names, inside the caller's write transaction.
     * Every conflict is detected before the single write, so a rejection writes nothing.
     * `emailAllowed` is the privacy domain policy for a new or changed address.
     */
    upsertForEvent(
      row: Row | null,
      input: EventSubscriber,
      emailAllowed: (email: string) => boolean,
    ): Row {
      const now = clock.now().toISOString();
      const merge = (current: Record<string, unknown>) => {
        const merged = new Map(Object.entries(current));
        for (const [key, value] of Object.entries(input.attribs ?? {}))
          if (value === null) merged.delete(key);
          else merged.set(key, value);
        return JSON.stringify(Object.fromEntries(merged));
      };
      const bounded = (attribs: string, previous: number) => {
        if (Buffer.byteLength(attribs) > Math.max(EVENT_ATTRIBS_BYTES, previous))
          throw new HttpError(400, "Invalid attributes.");
        return attribs;
      };
      const blocked = () => new HttpError(400, "The e-mail domain is blocklisted.");
      if (!row) {
        if (input.email === undefined) throw new HttpError(404, "Subscriber not found");
        if (!emailAllowed(input.email)) throw blocked();
        const attribs = bounded(merge({}), 0);
        try {
          const created = q
            .get("subscriber-insert")
            .get(
              crypto.randomUUID(),
              input.email,
              input.name || nameFromEmail(input.email),
              "enabled",
              attribs,
              input.external_id ?? null,
              now,
              now,
            ) as { id: bigint };
          return get(created.id)!;
        } catch (error) {
          return conflict(error);
        }
      }
      let changed = false;
      let externalID = row.external_id;
      if (input.external_id !== undefined && input.external_id !== row.external_id) {
        // Found by email: link a new external ID, but never re-point an existing one.
        if (row.external_id !== null || external(input.external_id))
          throw new HttpError(409, "External ID and e-mail belong to different subscribers.");
        externalID = input.external_id;
        changed = true;
      }
      let email = row.email;
      if (input.email !== undefined && input.email !== row.email) {
        // The same address in another ASCII case is not a change.
        const owner = byEmail(input.email);
        if (owner && owner.id !== row.id) throw new HttpError(409, "E-mail already exists.");
        if (!owner) {
          if (!emailAllowed(input.email)) throw blocked();
          email = input.email;
          changed = true;
        }
      }
      const name = input.name || row.name;
      if (name !== row.name) changed = true;
      let attribs = row.attribs;
      if (input.attribs !== undefined) {
        attribs = bounded(merge(JSON.parse(row.attribs)), Buffer.byteLength(row.attribs));
        if (attribs !== row.attribs) changed = true;
      }
      if (!changed) return row;
      try {
        q.get("subscriber-update").run(email, name, row.status, attribs, externalID, now, row.id);
      } catch (error) {
        return conflict(error);
      }
      return get(row.id)!;
    },
    byUuid: (uuid: string) => q.get("subscriber-by-uuid").get(uuid) as Row | null,
    membership: (id: bigint, list: bigint) =>
      q.get("membership-get").get(id, list) as Membership | null,
    /**
     * Public unsubscribe, adapted from listmonk's unsubscribe-by-campaign query: mark the
     * list (or with `blocklist`, every list) unsubscribed and optionally blocklist the
     * subscriber. Returns the list IDs whose status changed. The caller holds the write.
     */
    unsubscribe(id: bigint, list: bigint, blocklist: boolean): bigint[] {
      const now = clock.now().toISOString();
      // Like upstream, the subscriber's status change does not touch updated_at.
      if (blocklist) q.get("subscriber-blocklist-only").run(id);
      const rows = (
        blocklist
          ? q.get("membership-unsubscribe-all").all(now, id)
          : q.get("membership-unsubscribe-list").all(now, id, list)
      ) as { list_id: bigint }[];
      return rows.map((row) => row.list_id);
    },
    close: () => q.close(),
  };
}
export type SubscriberStore = ReturnType<typeof createSubscriberStore>;
