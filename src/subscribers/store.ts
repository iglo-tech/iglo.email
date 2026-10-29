// Adapted from listmonk internal/core/subscribers.go, internal/core/subscriptions.go and queries/subscribers.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { trimSpace } from "@/lists/store";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { ListReferences } from "@/lists/references";
import type { SubscriberInput } from "@/subscribers/input";
import { HttpError } from "@/server/response";
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
export interface Scope {
  all: boolean;
  ids: bigint[];
}
const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
export function createSubscriberStore(db: Database, clock: Clock, lists: ListReferences) {
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
            : { ...(input.attribsReset ? {} : JSON.parse(row.attribs)), ...input.attribs }
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
        return get(row.id)!;
      } catch (error) {
        return conflict(error);
      }
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
          } else if (action === "remove") q.get("membership-delete").run(id, list);
          else if (action === "unsubscribe" && existing)
            q.get("membership-update").run("unsubscribed", now, id, list);
        }
    },
    close: () => q.close(),
  };
}
export type SubscriberStore = ReturnType<typeof createSubscriberStore>;
