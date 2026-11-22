// Adapted from listmonk internal/core/subscribers.go, internal/core/subscriptions.go and queries/subscribers.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { trimSpace } from "@/lists/store";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { must } from "@/invariant";
import type { ListReferences } from "@/lists/references";
import type { SubscriberInput } from "@/subscribers/input";
import { HttpError } from "@/server/response";
import { titleWords } from "@/subscribers/unicode-title";
import { emailHash, externalHash } from "@/subscribers/suppression";
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
export const nameFromEmail = (email: string) =>
  must(email.split("@")[0], "email local part")
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
  blocklisted(ids: Array<bigint>): void;
  /** The subscribers' memberships of `listIds` are now unsubscribed. */
  unsubscribed(ids: Array<bigint>, listIds: Array<bigint>): void;
  /** The subscribers are about to be deleted (D25: messaging anonymizes their sends). */
  deleting?(subscribers: Array<{ id: bigint; email: string }>, wipe?: boolean): void;
  /**
   * Consent that really changed, after the write: `blocklisted` when the subscriber was not
   * blocklisted before, `listIds` for memberships that were not unsubscribed before. Unlike the
   * effects above it stays silent on repeats, so a replayed request queues no webhook.
   */
  changed?(change: { id: bigint; blocklisted: boolean; listIds: Array<bigint> }): void;
  /** Set-based `changed` for these subscribers, called before the write it reports. */
  blocklisting?(ids: Array<bigint>): void;
  unsubscribing?(ids: Array<bigint>, listIds: Array<bigint>): void;
  /** May refuse a bulk action, by throwing, before its first write. */
  admitBulk?(action: BulkAction, selected: () => number): void;
  /** The same for one batch of an import: adds what it will queue to `spent`, or refuses it. */
  admitImportBatch?(spent: BulkSpend, batch: { unsubscribed: number; blocklisted: number }): void;
  /** The same for one batch of a maintenance delete of `selected` subscribers. */
  admitDeleteBatch?(spent: BulkSpend, selected: number): void;
}
/** A row of a CSV import, validated. `attribs` is JSON. */
export interface ImportRow {
  email: string;
  name: string;
  attribs: string;
}
/** Webhook deliveries an action of many batches has queued so far. */
export interface BulkSpend {
  deliveries: number;
}
export interface ImportSubscribe {
  listIds: Array<bigint>;
  status: string;
  overwriteUserInfo: boolean;
  overwriteStatus: boolean;
}
/** What a maintenance delete selects. */
export type MaintenanceType = "orphan" | "blocklisted";
interface MaintenanceRow {
  id: bigint;
  hit: number;
}
/**
 * Rows one maintenance batch looks at, and of those, how many it removes: what bounds its write
 * (docs/perf/M4.6-maintenance.md). A subscriber costs far more than a membership.
 */
export const MAINTENANCE_PAGE = 2000;
export const MAINTENANCE_SUBSCRIBERS = 100;
export const MAINTENANCE_MEMBERSHIPS = 500;
/** The first `limit` hits of a page, and where the next batch starts. */
function maintenanceBatch(page: Array<MaintenanceRow>, limit: number) {
  const last = page.at(-1);
  if (!last) {
    return null;
  }
  const ids = page
    .filter((row) => row.hit)
    .slice(0, limit)
    .map((row) => row.id);
  return { ids, last: ids.length === limit ? must(ids.at(-1), "batch end") : last.id };
}
/** A bulk action that can queue webhooks. */
export type BulkAction = "delete" | "blocklist" | "unsubscribe";
export const noSubscriberEffects: SubscriberEffects = {
  blocklisted() {},
  unsubscribed() {},
};
export interface Scope {
  all: boolean;
  ids: Array<bigint>;
}
/**
 * Whether a caller with `scope` may manage a subscriber on these lists: one of them is in its scope,
 * as an event's grant and PUT's check require (D99). A subscriber on no list is out of reach unless
 * the scope covers every list.
 */
const managesHolder = (lists: Array<bigint>, scope: Scope) =>
  scope.all || lists.some((list) => scope.ids.includes(list));
const externalTaken = () =>
  new HttpError(409, "External ID already exists", {}, "external_id_conflict");
const numberID = (id: bigint) =>
  id <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
const json = (ids: Array<bigint>) => `[${ids.join(",")}]`;
const permittedLists = (requested: Array<bigint>, scope: Scope) =>
  requested.filter((id) => scope.all || scope.ids.includes(id));
const conflict = (error: unknown): never => {
  if (error instanceof Error && error.message.includes("subscribers.external_id")) {
    throw externalTaken();
  }
  if (error instanceof Error && error.message.includes("subscribers.email")) {
    throw new HttpError(409, "E-mail already exists.", {}, "email_conflict");
  }
  throw error;
};
const bounded = (attribs: string, previous: number) => {
  if (Buffer.byteLength(attribs) > Math.max(EVENT_ATTRIBS_BYTES, previous)) {
    throw new HttpError(400, "Invalid attributes.");
  }
  return attribs;
};
const blocked = () => new HttpError(400, "The e-mail domain is blocklisted.");
export function createSubscriberStore(
  db: Database,
  clock: Clock,
  lists: ListReferences,
  effects: SubscriberEffects = noSubscriberEffects,
) {
  const q = prepareNamedQueries(db, [{ name: "subscribers/store", sql }]);
  const get = (id: bigint) => q.get("subscriber-by-id").get(id) as Row | null;
  const memberships = (id: bigint) => q.get("subscriber-memberships").all(id) as Array<Membership>;
  /** The memberships with their list's metadata; a membership whose list is gone is left out. */
  const subscriptions = (id: bigint) =>
    memberships(id).flatMap((m) => {
      const list = lists.subscriberMetadata(m.list_id);
      return list ? [{ ...list, listId: m.list_id, subscriptionStatus: m.status }] : [];
    });
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
      if (!list) {
        throw new Error("Missing list");
      }
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
  const subscribedLists = (id: bigint) =>
    memberships(id)
      .filter((m) => m.status !== "unsubscribed")
      .map((m) => m.list_id);
  const consentChanged = (id: bigint, blocklisted: boolean, listIds: Array<bigint>) => {
    if (blocklisted || listIds.length) {
      effects.changed?.({ id, blocklisted, listIds });
    }
  };
  const webhookData = (name: string, ...args: Array<string | number | null>) =>
    (q.get(name).get(...args) as { data: string }).data;
  const external = (key: string) => q.get("subscriber-by-external").get(key) as Row | null;
  const byEmail = (email: string) => q.get("subscriber-by-email").get(email) as Row | null;
  /**
   * The 409 for an address another subscriber holds (D129). It names the holder's external ID only
   * where the caller manages the holder, so a scoped caller learns nothing of a subscriber it cannot
   * see; a holder without an external ID is never named. The lists are read only for this error.
   */
  const addressConflict = (holder: Row, scope: Scope, message: string) =>
    new HttpError(
      409,
      message,
      {},
      "email_conflict",
      holder.external_id !== null &&
        managesHolder(
          memberships(holder.id).map((m) => m.list_id),
          scope,
        )
        ? { conflict: { external_id: holder.external_id } }
        : {},
    );
  // B124 (D125): suppressions are matched and written with the database's own secret.
  const secret = () => (q.get("suppression-secret").get() as { secret: Uint8Array }).secret;
  const suppressionKeys = (subscriber: { email: string; external_id: string | null }) => {
    const key = secret();
    return [
      emailHash(key, subscriber.email),
      subscriber.external_id === null ? null : externalHash(key, subscriber.external_id),
    ] as const;
  };
  /** Whether a suppression names this subscriber's address or external ID (D125). */
  const suppressedBy = (subscriber: { email: string; external_id: string | null }) =>
    q.get("suppression-match").get(...suppressionKeys(subscriber)) !== null;
  /** A self-wipe's suppression: keyed hashes and the list IDs, written before the rows go. */
  const suppress = (row: Row) => {
    const lists = memberships(row.id).map((m) => Number(m.list_id));
    q.get("suppression-insert").run(
      ...suppressionKeys(row),
      JSON.stringify(lists),
      clock.now().toISOString(),
    );
  };
  const replace = (
    id: bigint,
    requested: Array<bigint>,
    scope: Scope,
    status: string,
    preconfirm: boolean,
    now: string,
  ) => {
    const resolved = [
      ...new Set(requested.filter((list) => lists.subscriberMetadata(list) !== null)),
    ];
    for (const m of memberships(id)) {
      if ((scope.all || scope.ids.includes(m.list_id)) && !resolved.includes(m.list_id)) {
        q.get("membership-delete").run(id, m.list_id);
      }
    }
    for (const list of resolved) {
      const previous = memberships(id).find((m) => m.list_id === list);
      // D81: a blocklisted subscriber's existing rows end in blockOne, which stamps them.
      if (status === "blocklisted" && previous) {
        continue;
      }
      const target =
        status === "blocklisted"
          ? "unsubscribed"
          : previous?.status === "confirmed" || previous?.status === "unsubscribed"
            ? previous.status
            : preconfirm
              ? "confirmed"
              : "unconfirmed";
      if (previous) {
        q.get("membership-status").run(target, id, list);
      } else {
        q.get("membership-insert").run(id, list, target, now, now);
      }
    }
  };
  const importUnsubscribing = (
    emails: Array<string>,
    options: Pick<ImportSubscribe, "listIds" | "status">,
  ) => {
    const row = q
      .get("import-unsubscribing")
      .get(
        JSON.stringify(emails),
        json(options.listIds),
        options.status === "unsubscribed" ? 1 : 0,
      ) as { n: bigint };
    return Number(row.n);
  };
  /**
   * D81: the one way a subscriber becomes blocklisted. Every membership ends unsubscribed, and the
   * membership `updated_at` is stamped once for each row that really changed. Returns those lists.
   */
  const blockOne = (id: bigint, now: string): Array<bigint> => {
    q.get("subscriber-blocklist").run(now, id);
    const rows = q.get("membership-unsubscribe-all").all(now, id) as Array<{
      list_id: bigint;
    }>;
    return rows.map((row) => row.list_id);
  };
  const blocklist = (ids: Array<bigint>) => {
    effects.admitBulk?.("blocklist", () => new Set(ids).size);
    effects.blocklisting?.(ids);
    const now = clock.now().toISOString();
    for (const id of ids) {
      blockOne(id, now);
    }
    effects.blocklisted(ids);
  };
  const store = {
    get,
    external,
    byEmail,
    memberships,
    project,
    /** The addresses of those of `ids` with a membership in `scope`, in one query. */
    readable(ids: Array<bigint>, scope: Scope) {
      const rows = q
        .get("subscribers-readable")
        .all(`[${ids.join(",")}]`, scope.all, `[${scope.ids.join(",")}]`) as Array<
        Pick<Row, "id" | "email">
      >;
      return new Map(rows.map((row) => [row.id, row.email]));
    },
    transaction<F extends () => object>(
      fn: F & (Extract<ReturnType<F>, PromiseLike<unknown>> extends never ? unknown : never),
    ): ReturnType<F> {
      return writeTransaction(db, fn);
    },
    create(input: SubscriberInput & { email: string; name: string }, scope: Scope) {
      const now = clock.now().toISOString(),
        status = input.status || "enabled";
      if (
        input.external_id !== null &&
        input.external_id !== undefined &&
        external(input.external_id)
      ) {
        throw externalTaken();
      }
      const holder = byEmail(input.email);
      if (holder) {
        throw addressConflict(holder, scope, "E-mail already exists.");
      }
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
        // B124 (D125): a suppressed address gets no list from a create, however it asks.
        const requested = permittedLists(input.lists ?? [], scope);
        replace(
          row.id,
          requested.length &&
            suppressedBy({ email: input.email, external_id: input.external_id ?? null })
            ? []
            : requested,
          scope,
          status,
          input.preconfirm_subscriptions ?? false,
          now,
        );
        consentChanged(row.id, status === "blocklisted", []);
        return must(get(row.id), "subscriber row");
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
      if (input.external_id !== null && input.external_id !== undefined) {
        const existing = external(input.external_id);
        if (existing && existing.id !== row.id) {
          throw externalTaken();
        }
      }
      const holder = byEmail(email);
      if (holder && holder.id !== row.id) {
        throw addressConflict(holder, scope, "E-mail already exists.");
      }
      const subscribed = subscribedLists(row.id);
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
        if (!patch || (input.lists !== undefined && input.lists !== null)) {
          replace(
            row.id,
            permittedLists(input.lists ?? [], scope),
            scope,
            status,
            input.preconfirm_subscriptions ?? false,
            now,
          );
        }
        if (status === "blocklisted") {
          blockOne(row.id, now);
        }
      } catch (error) {
        return conflict(error);
      }
      if (status === "blocklisted") {
        effects.blocklisted([row.id]);
      }
      const remaining = new Map(memberships(row.id).map((m) => [m.list_id, m.status]));
      consentChanged(
        row.id,
        status === "blocklisted" && row.status !== "blocklisted",
        subscribed.filter((list) => remaining.get(list) === "unsubscribed"),
      );
      return must(get(row.id), "subscriber row");
    },
    /**
     * `wipe` is the subscriber's own request (D61): it also leaves a suppression of marketing
     * consent (B124, D125), written before the rows it names go.
     */
    remove(ids: Array<bigint>, { wipe = false } = {}) {
      effects.admitBulk?.("delete", () => new Set(ids).size);
      const deleted = ids.flatMap((id) => get(id) ?? []);
      effects.deleting?.(deleted, wipe);
      if (wipe) {
        for (const row of deleted) {
          suppress(row);
        }
      }
      for (const id of ids) {
        q.get("subscriber-delete").run(id);
      }
    },
    /** Whether a suppression names this subscriber's address or external ID (B124, D125). */
    suppressed: suppressedBy,
    /** The suppressions of one address, removed on an operator's explicit request. Their count. */
    unsuppress(email: string): number {
      return Number(q.get("suppression-clear").run(emailHash(secret(), email), null).changes);
    },
    blocklist,
    action(ids: Array<bigint>, listIDs: Array<bigint>, action: string, status: string) {
      if (action === "unsubscribe" || (action === "add" && status === "unsubscribed")) {
        effects.admitBulk?.("unsubscribe", () => new Set(ids).size);
        effects.unsubscribing?.(ids, listIDs);
      }
      const now = clock.now().toISOString();
      for (const id of new Set(ids)) {
        for (const list of new Set(listIDs)) {
          const existing = memberships(id).find((m) => m.list_id === list);
          if (action === "add") {
            // D81: whatever the status, a blocklisted subscriber's membership is unsubscribed.
            const target = get(id)?.status === "blocklisted" ? "unsubscribed" : status;
            if (!existing) {
              q.get("membership-insert").run(id, list, target || "unconfirmed", now, now);
            } else if (target === "unsubscribed" && !status) {
              q.get("membership-force-unsubscribe").run(now, id, list);
            } else if (target) {
              q.get("membership-status").run(target, id, list);
            }
            if (target === "unsubscribed") {
              effects.unsubscribed([id], [list]);
            }
          } else if (action === "remove") {
            q.get("membership-delete").run(id, list);
          } else if (action === "unsubscribe") {
            if (existing) {
              q.get("membership-update").run("unsubscribed", now, id, list);
            }
            // An absent membership stays absent, but the consent action still ends the
            // list's enrollments.
            effects.unsubscribed([id], [list]);
          }
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
     * The 409 that refuses an event before it writes, when its address belongs to another subscriber
     * (D129); null when the event may write. `found` is what `resolveForEvent` returned. The event
     * may write when it names no address, the address is free, or it is `found`'s own with the
     * event's external ID. When `found` holds the address with no external ID, the event claims it,
     * and `upsertForEvent` links the external ID. The claim is allowed when the holder is on no list
     * (an e-mail-only event creates such a holder, so the events-only role can claim it), or when the
     * caller manages one of its lists. Any other holder is a conflict, which names the holder only to
     * a caller that manages it.
     */
    eventConflict(input: EventSubscriber, found: Row | null, scope: Scope): HttpError | null {
      if (input.email === undefined || input.external_id === undefined) {
        return null;
      }
      const holder = byEmail(input.email);
      if (!holder) {
        return null;
      }
      if (found?.id !== holder.id) {
        return addressConflict(holder, scope, "E-mail already exists.");
      }
      if (found.external_id === input.external_id) {
        return null;
      }
      if (found.external_id === null) {
        const lists = memberships(holder.id).map((m) => m.list_id);
        if (lists.length === 0 || managesHolder(lists, scope)) {
          return null;
        }
        return addressConflict(holder, scope, "E-mail already exists.");
      }
      return addressConflict(
        holder,
        scope,
        "External ID and e-mail belong to different subscribers.",
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
        for (const [key, value] of Object.entries(input.attribs ?? {})) {
          if (value === null) {
            merged.delete(key);
          } else {
            merged.set(key, value);
          }
        }
        return JSON.stringify(Object.fromEntries(merged));
      };
      if (!row) {
        if (input.email === undefined) {
          throw new HttpError(404, "Subscriber not found");
        }
        if (!emailAllowed(input.email)) {
          throw blocked();
        }
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
          return must(get(created.id), "subscriber row");
        } catch (error) {
          return conflict(error);
        }
      }
      let changed = false;
      let externalID = row.external_id;
      if (input.external_id !== undefined && input.external_id !== row.external_id) {
        // Found by email: link a new external ID, but never re-point an existing one.
        if (row.external_id !== null || external(input.external_id)) {
          throw new HttpError(
            409,
            "External ID and e-mail belong to different subscribers.",
            {},
            "email_conflict",
          );
        }
        externalID = input.external_id;
        changed = true;
      }
      let email = row.email;
      if (input.email !== undefined && input.email !== row.email) {
        // The same address in another ASCII case is not a change.
        const owner = byEmail(input.email);
        if (owner && owner.id !== row.id) {
          throw new HttpError(409, "E-mail already exists.", {}, "email_conflict");
        }
        if (!owner) {
          if (!emailAllowed(input.email)) {
            throw blocked();
          }
          email = input.email;
          changed = true;
        }
      }
      const name = input.name || row.name;
      if (name !== row.name) {
        changed = true;
      }
      let attribs = row.attribs;
      if (input.attribs !== undefined) {
        attribs = bounded(merge(JSON.parse(row.attribs)), Buffer.byteLength(row.attribs));
        if (attribs !== row.attribs) {
          changed = true;
        }
      }
      if (!changed) {
        return row;
      }
      try {
        q.get("subscriber-update").run(email, name, row.status, attribs, externalID, now, row.id);
      } catch (error) {
        return conflict(error);
      }
      return must(get(row.id), "subscriber row");
    },
    byUuid: (uuid: string) => q.get("subscriber-by-uuid").get(uuid) as Row | null,
    /**
     * Public signup, adapted from insert-subscriber and update-subscriber-with-lists with
     * allow-resubscribe: a new address is created enabled; an existing one keeps its profile.
     * Confirmed memberships stay, others restart unconfirmed, and a blocklisted subscriber's
     * memberships are unsubscribed. The caller holds the write.
     */
    publicSubscribe(input: { email: string; name: string }, listIds: Array<bigint>): Row {
      const now = clock.now().toISOString();
      let row = byEmail(input.email);
      if (row) {
        q.get("subscriber-touch").run(now, row.id);
      } else {
        const created = q
          .get("subscriber-insert")
          .get(crypto.randomUUID(), input.email, input.name, "enabled", "{}", null, now, now) as {
          id: bigint;
        };
        row = must(get(created.id), "subscriber row");
      }
      // B124 (D125): a suppressed address joins double opt-in lists only. Its opt-in mail is the
      // person's own confirmation, and confirming clears the suppression (`confirmOptin`).
      const wanted =
        listIds.length && suppressedBy(row)
          ? listIds.filter((list) => lists.subscriberMetadata(list)?.optin === "double")
          : listIds;
      for (const list of wanted) {
        const previous = q.get("membership-get").get(row.id, list) as Membership | null;
        const status =
          row.status === "blocklisted"
            ? "unsubscribed"
            : previous?.status === "confirmed"
              ? "confirmed"
              : "unconfirmed";
        if (previous) {
          q.get("membership-status").run(status, row.id, list);
        } else {
          q.get("membership-insert").run(row.id, list, status, now, now);
        }
      }
      return row;
    },
    /** The subscriber's unconfirmed lists in list order (get-subscriber-lists). */
    unconfirmedLists(id: bigint) {
      return memberships(id)
        .filter((m) => m.status === "unconfirmed")
        .map((m) => lists.subscriberMetadata(m.list_id))
        .filter((list) => list !== null)
        .sort((a, b) => a.id - b.id);
    },
    /**
     * Every membership with its list's name, type and status, whatever the list's type (B126, D123).
     * A link's already-unsubscribed check reads these, because a private list is the normal case for
     * a sequence's or a transactional send's link.
     */
    allSubscriptions: subscriptions,
    /** The memberships public pages may show: the ones on public lists, whatever their status. */
    visibleSubscriptions(id: bigint) {
      return subscriptions(id).filter((list) => list.type !== "private");
    },
    /** Adapted from export-subscriber-data: private list names stay hidden. */
    exportSubscriptions(id: bigint) {
      return memberships(id).flatMap((m) => {
        const list = lists.subscriberMetadata(m.list_id);
        if (!list) {
          return [];
        }
        return [
          {
            subscription_status: m.status,
            name: list.type === "private" ? "Private list" : list.name,
            type: list.type,
            created_at: m.created_at,
          },
        ];
      });
    },
    /** Confirm unconfirmed memberships only: never reverses an unsubscribe. */
    confirmOptin(id: bigint, listIds: Array<bigint>, meta: Record<string, string>) {
      const now = clock.now().toISOString();
      let confirmed = 0;
      for (const list of listIds) {
        confirmed += Number(
          q.get("membership-confirm").run(JSON.stringify(meta), now, id, list).changes,
        );
      }
      // B124 (D125): the person confirmed by their own mail, so the suppression no longer applies.
      const row = confirmed > 0 ? get(id) : null;
      if (row) {
        const [email, external] = suppressionKeys(row);
        q.get("suppression-clear").run(email, external);
      }
    },
    rename(id: bigint, name: string) {
      q.get("subscriber-rename").run(name, clock.now().toISOString(), id);
    },
    /** Adapted from unsubscribe-by-campaign with unsubAllUnconfirmed. Returns changed lists. */
    unsubscribeUnconfirmed(id: bigint): Array<bigint> {
      const rows = q.get("membership-unsubscribe-unconfirmed").all(clock.now().toISOString(), id);
      const changed = (rows as Array<{ list_id: bigint }>).map((row) => row.list_id);
      consentChanged(id, false, changed);
      return changed;
    },
    /**
     * A transactional link's cancel (B126, D123 item 8): ends the unconfirmed memberships of double
     * opt-in lists only. An unconfirmed single opt-in membership is active and stays. Returns changed lists.
     */
    unsubscribeDoubleOptinPending(id: bigint): Array<bigint> {
      const rows = q
        .get("membership-unsubscribe-double-pending")
        .all(clock.now().toISOString(), id);
      const changed = (rows as Array<{ list_id: bigint }>).map((row) => row.list_id);
      consentChanged(id, false, changed);
      return changed;
    },
    membership: (id: bigint, list: bigint) =>
      q.get("membership-get").get(id, list) as Membership | null,
    /**
     * Whether an event may grant consent on `list` (D99): the list exists and is single opt-in.
     * A double opt-in list asks the subscriber to confirm by mail, which a grant cannot replace.
     */
    grantable(list: bigint): boolean {
      const meta = lists.subscriberMetadata(list);
      return meta !== null && meta.optin === "single";
    },
    /**
     * Insert a confirmed membership of `list` when the subscriber has none (D99). An existing
     * membership of any status is left alone. Returns true when it inserted one. The caller
     * holds the write, and an ordinary add with status `confirmed` has no other side effect.
     */
    insertConfirmedIfAbsent(id: bigint, list: bigint): boolean {
      const now = clock.now().toISOString();
      return q.get("membership-insert").run(id, list, "confirmed", now, now).changes === 1;
    },
    /**
     * Public unsubscribe, adapted from listmonk's unsubscribe-by-campaign query: mark the list
     * unsubscribed. Returns the list IDs whose status changed. The caller holds the write.
     */
    unsubscribe(id: bigint, list: bigint): Array<bigint> {
      const changed = (
        q.get("membership-unsubscribe-list").all(clock.now().toISOString(), id, list) as Array<{
          list_id: bigint;
        }>
      ).map((row) => row.list_id);
      consentChanged(id, false, changed);
      return changed;
    },
    /**
     * The public "Unsubscribe from all mailing lists" (B130, D128): every membership not already
     * unsubscribed ends, and a marketing suppression (B124, D125) is written unless one already names
     * this subscriber. The status stays: this is not the admin blocklist, so transactional mail and
     * transactional sequence steps keep flowing. A marketing sequence step ends at its next due time,
     * as the scheduler's consent check ends it. Webhooks are those of an unsubscribe. The caller holds
     * the write.
     */
    unsubscribeAll(id: bigint): void {
      const row = get(id);
      if (!row) {
        return;
      }
      if (!suppressedBy(row)) {
        suppress(row);
      }
      const changed = (
        q.get("membership-unsubscribe-all").all(clock.now().toISOString(), id) as Array<{
          list_id: bigint;
        }>
      ).map((membership) => membership.list_id);
      consentChanged(id, false, changed);
    },
    /**
     * record-bounce's block1. Unlike upstream it also unsubscribes every membership (D81), so
     * un-blocklisting never resumes mail. The caller holds the write.
     */
    bounceBlocklist(id: bigint) {
      const changed = blockOne(id, clock.now().toISOString());
      effects.blocklisted([id]);
      consentChanged(id, true, changed);
    },
    /**
     * record-bounce's block2: every list, keeping the status. Unlike upstream it stamps the
     * membership, which says when consent changed (07). The caller holds the write.
     */
    bounceUnsubscribe(id: bigint) {
      const rows = q.get("membership-unsubscribe-all").all(clock.now().toISOString(), id);
      const changed = (rows as Array<{ list_id: bigint }>).map((row) => row.list_id);
      if (changed.length) {
        effects.unsubscribed([id], changed);
      }
      consentChanged(id, false, changed);
    },
    /** JSON arrays of webhook data, read in one statement before the write they describe. */
    webhookUnsubscribed: (ids: Array<bigint>, lists: Array<bigint> | null) =>
      webhookData("webhook-unsubscribed", json(ids), lists && json(lists)),
    webhookBlocklisted: (ids: Array<bigint>) => webhookData("webhook-blocklisted", json(ids)),
    /**
     * One batch of an import in its own transaction, row by row in file order like
     * upsert-subscriber. A blocklisted subscriber stays so and is unsubscribed from new lists, and
     * a membership's status changes only with `overwriteStatus`. Ending one takes the same path
     * as an API write, so it exits enrollments and queues the webhook in this transaction. The
     * batch is admitted first, against what memberships and webhooks are now.
     */
    importSubscribe(rows: Array<ImportRow>, options: ImportSubscribe, spent: BulkSpend) {
      writeTransaction(db, () => {
        if (options.overwriteStatus) {
          effects.admitImportBatch?.(spent, {
            unsubscribed: importUnsubscribing(
              rows.map((row) => row.email),
              options,
            ),
            blocklisted: 0,
          });
        }
        const now = clock.now().toISOString();
        for (const row of rows) {
          const existing = byEmail(row.email);
          if (existing && options.overwriteUserInfo) {
            q.get("subscriber-import-update").run(row.name, row.attribs, now, existing.id);
          } else if (existing) {
            q.get("subscriber-touch").run(now, existing.id);
          }
          const id =
            existing?.id ??
            (
              q
                .get("subscriber-insert")
                .get(
                  crypto.randomUUID(),
                  row.email,
                  row.name,
                  "enabled",
                  row.attribs,
                  null,
                  now,
                  now,
                ) as { id: bigint }
            ).id;
          const target = existing?.status === "blocklisted" ? "unsubscribed" : options.status;
          // B124 (D125): a suppressed address takes no consent from an import; its row is still imported.
          // Unsubscribing needs no consent, so an import that unsubscribes applies to it as to anyone.
          const listIds =
            options.listIds.length &&
            target !== "unsubscribed" &&
            suppressedBy({ email: row.email, external_id: existing?.external_id ?? null })
              ? []
              : options.listIds;
          const ended: Array<bigint> = [];
          const changed: Array<bigint> = [];
          for (const list of listIds) {
            const previous = existing
              ? (q.get("membership-get").get(id, list) as Membership)
              : null;
            if (!previous) {
              q.get("membership-insert").run(id, list, target, now, now);
            } else {
              q.get("membership-update").run(
                options.overwriteStatus ? target : previous.status,
                now,
                id,
                list,
              );
            }
            if (target !== "unsubscribed" || (previous && !options.overwriteStatus)) {
              continue;
            }
            ended.push(list);
            if (previous && previous.status !== "unsubscribed") {
              changed.push(list);
            }
          }
          if (ended.length) {
            effects.unsubscribed([id], ended);
          }
          consentChanged(id, false, changed);
        }
      });
    },
    /** One batch of a blocklist import: new addresses are created and all go through `blocklist`. */
    importBlocklist(rows: Array<ImportRow>, spent: BulkSpend) {
      writeTransaction(db, () => {
        const emails = [...new Set(rows.map((row) => row.email))];
        const known = q.get("import-blocklisting").get(JSON.stringify(emails)) as {
          known: bigint;
          enabled: bigint;
          members: bigint;
        };
        effects.admitImportBatch?.(spent, {
          unsubscribed: Number(known.members),
          blocklisted: emails.length - Number(known.known) + Number(known.enabled),
        });
        const now = clock.now().toISOString();
        blocklist(
          rows.map(
            (row) =>
              (
                byEmail(row.email) ??
                (q
                  .get("subscriber-insert")
                  .get(
                    crypto.randomUUID(),
                    row.email,
                    row.name,
                    "enabled",
                    row.attribs,
                    null,
                    now,
                    now,
                  ) as { id: bigint })
              ).id,
          ),
        );
      });
    },
    /** Of these addresses, the subscribers `importSubscribe` with `overwriteStatus` would unsubscribe. */
    importUnsubscribing,
    /** The budget of a bulk action (D61), for an import that counted its subscribers. */
    admitImport(action: BulkAction, selected: number) {
      effects.admitBulk?.(action, () => selected);
    },
    /** The same, for a selection counted only if a webhook wants it. */
    admitBulk(action: BulkAction, selected: () => number) {
      effects.admitBulk?.(action, selected);
    },
    webhookDeleted: (ids: Array<bigint>) => webhookData("webhook-deleted", json(ids)),
    /** A bounded page of a maintenance delete after the row `after`, in row order. */
    maintenancePage(type: MaintenanceType, after: bigint) {
      return q.get(`maintenance-${type}`).all(after, MAINTENANCE_PAGE) as Array<MaintenanceRow>;
    },
    /**
     * One batch of a maintenance delete, through `remove`. `null` when none are left. It is
     * admitted first, against what the batches before it queued and what webhooks are now.
     */
    maintenanceRemove(type: MaintenanceType, after: bigint, spent: BulkSpend) {
      return writeTransaction(db, () => {
        const page = q
          .get(`maintenance-${type}`)
          .all(after, MAINTENANCE_PAGE) as Array<MaintenanceRow>;
        const batch = maintenanceBatch(page, MAINTENANCE_SUBSCRIBERS);
        if (!batch) {
          return null;
        }
        if (batch.ids.length) {
          effects.admitDeleteBatch?.(spent, batch.ids.length);
          store.remove(batch.ids);
        }
        return { last: batch.last, removed: batch.ids.length };
      });
    },
    /** A batch of delete-unconfirmed-subscriptions: no consent existed, so no webhook either. */
    removeUnconfirmed(after: bigint, before: string) {
      return writeTransaction(db, () => {
        const page = q
          .get("maintenance-unconfirmed")
          .all(after, MAINTENANCE_PAGE, before) as Array<MaintenanceRow>;
        const batch = maintenanceBatch(page, MAINTENANCE_MEMBERSHIPS);
        if (!batch) {
          return null;
        }
        if (batch.ids.length) {
          q.get("maintenance-unconfirmed-delete").run(json(batch.ids));
        }
        return { last: batch.last, removed: batch.ids.length };
      });
    },
    close: () => q.close(),
  };
  return store;
}
export type SubscriberStore = ReturnType<typeof createSubscriberStore>;
