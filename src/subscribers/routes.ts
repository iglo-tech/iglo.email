// Adapted from listmonk cmd/subscribers.go and cmd/handlers.go at 6fcd95f.
import { refuseWhileHeld } from "@/settings/hold";
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import { trimSpace } from "@/lists/store";
import { allowedDomain, sanitizeEmail } from "@/subscribers/email";
import { titleWords } from "@/subscribers/unicode-title";
import {
  subscriberInput,
  validExternal,
  validAttributes,
  type SubscriberInput,
} from "@/subscribers/input";
import type { SubscriberStore, Scope } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";

type SubscriberRow = NonNullable<ReturnType<SubscriberStore["get"]>>;
type Reader = NonNullable<RequestContext["identity"]>;

/** One page of what a subscriber did or received, from the module that owns it. */
type ActivityPage = (id: bigint, page: number, perPage: number) => unknown;
export interface SubscriberActivity {
  events: ActivityPage;
  enrollments: ActivityPage;
  sends: ActivityPage;
}

const canRead = (roles: Roles, identity: Reader) =>
  roles.can(identity.role, "subscribers:get") || roles.can(identity.role, "subscribers:get_all");
const listScope = (roles: Roles, i: Reader, kind: "get" | "manage"): Scope => {
  const get = roles.listScope(i.role, i.user.list_role_id, "list:get"),
    manage = roles.listScope(i.role, i.user.list_role_id, "list:manage");
  if (kind === "manage") return manage;
  if (get.all || manage.all) return { all: true, ids: [] };
  return get.ids.length ? get : manage;
};
/**
 * GET /api/subscribers/:id's rule for a bounded page of IDs, for routes that show a subscriber
 * they do not own: the address of each one this reader could open, and no others.
 */
export const readableSubscribers = (
  roles: Roles,
  store: Pick<SubscriberStore, "readable">,
  reader: Reader,
  ids: bigint[],
) =>
  canRead(roles, reader)
    ? store.readable(ids, listScope(roles, reader, "get"))
    : new Map<bigint, string>();

export function registerSubscriberRoutes(
  router: Router,
  store: SubscriberStore,
  roles: Roles,
  auth: Authentication,
  domainPolicy: () => {
    "privacy.domain_allowlist": string[];
    "privacy.domain_blocklist": string[];
  } = () => ({ "privacy.domain_allowlist": [], "privacy.domain_blocklist": [] }),
  optin?: {
    /** The automatic opt-in mail after an admin write; failures never undo the write. */
    afterAdminWrite(row: SubscriberRow, listIds: bigint[]): void;
    /** SubscriberSendOptin: enqueue now, throwing on failure. */
    send(row: SubscriberRow): void;
  },
  activity?: SubscriberActivity,
) {
  const identity = (c: RequestContext) => {
    if (!c.identity) throw new Error("Identity required");
    return c.identity;
  };
  const scope = (c: RequestContext, kind: "get" | "manage"): Scope =>
    listScope(roles, identity(c), kind);
  const maskScope = (c: RequestContext): Scope => {
    const i = identity(c);
    const a = roles.listScope(i.role, i.user.list_role_id, "list:get"),
      b = roles.listScope(i.role, i.user.list_role_id, "list:manage");
    return { all: a.all || b.all, ids: [...a.ids, ...b.ids] };
  };
  const allowed = (c: RequestContext, ids: bigint[], kind: "get" | "manage") => {
    const s = scope(c, kind);
    if (s.all) return;
    for (const id of ids)
      if (store.get(id) && !store.memberships(id).some((m) => s.ids.includes(m.list_id)))
        throw new HttpError(
          403,
          c.app.i18n.Ts("globals.messages.permissionDenied", "name", `subscriber: ${id}`),
        );
  };
  const required = (c: RequestContext, id: bigint, external = false) =>
    store.get(id) ??
    (() => {
      const name = external ? "{globals.terms.subscriber}" : `{globals.terms.subscriber} (${id}: )`;
      throw new HttpError(400, c.app.i18n.Ts("globals.messages.notFound", "name", name));
    })();
  const listPermission = (c: RequestContext, ids: bigint[] | null | undefined) => {
    if (ids?.length) {
      const s = scope(c, "manage");
      if (!s.all && !ids.some((id) => s.ids.includes(id)))
        throw new HttpError(
          403,
          c.app.i18n.Ts("globals.messages.permissionDenied", "name", "lists"),
        );
    }
  };
  const permitted = (c: RequestContext, ids: bigint[] | null | undefined) => {
    const s = scope(c, "manage");
    return (ids ?? []).filter((id) => s.all || s.ids.includes(id));
  };
  const email = (value: string) => {
    const result = sanitizeEmail(value);
    if (result === undefined) throw new HttpError(400, "Invalid email.");
    const policy = domainPolicy();
    if (
      !allowedDomain(result, policy["privacy.domain_allowlist"], policy["privacy.domain_blocklist"])
    )
      throw new HttpError(400, "The e-mail domain is blocklisted.");
    return result;
  };
  const validate = (
    c: RequestContext,
    input: SubscriberInput,
    creating: boolean,
    patch: boolean,
  ) => {
    if (input.status && !["enabled", "disabled", "blocklisted"].includes(input.status))
      throw new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFields", "name", "status"));
    if (creating && Buffer.byteLength(input.email ?? "") > 1000)
      throw new HttpError(400, "Invalid email.");
    if (creating || !patch || input.email !== undefined) input.email = email(input.email ?? "");
    if (!creating && input.name && Buffer.byteLength(input.name) > 2000)
      throw new HttpError(400, "Invalid name");
    if (input.name?.includes("\0")) throw new HttpError(400, "Invalid name");
    if (!validAttributes(input.attribs)) throw new HttpError(400, "Invalid attributes.");
    if (creating) {
      input.name = trimSpace(input.name ?? "");
      if (!input.name)
        input.name = (input.email ?? "")
          .split("@")[0]!
          .replaceAll(".", " ")
          .split(/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/)
          .filter(Boolean)
          .map(titleWords)
          .join(" ");
    }
  };
  const selector = (c: RequestContext) => {
    let value: string;
    if (c.url.pathname === "/api/subscribers/external") {
      const values = c.url.searchParams.getAll("external_id");
      if (values.length !== 1) throw new HttpError(400);
      value = values[0]!;
    } else {
      try {
        value = decodeURIComponent(c.url.pathname.slice("/api/subscribers/external/".length));
      } catch {
        throw new HttpError(400);
      }
    }
    if (!validExternal(value)) throw new HttpError(400);
    return value;
  };
  const resolve = (c: RequestContext, external: boolean) =>
    external ? store.external(selector(c))?.id : BigInt(getID(c));
  const get =
    (external: boolean): Handler =>
    (c) => {
      const id = resolve(c, external);
      if (id === undefined) throw new HttpError(400, "Subscriber not found");
      allowed(c, [id], "get");
      return ok(store.project(required(c, id, external), maskScope(c)));
    };
  const create: Handler = async (c) => {
    const input = await subscriberInput(c, "crud");
    validate(c, input, true, false);
    auth.revalidate(c, "subscribers:manage");
    let created: SubscriberRow;
    const response = store.transaction(() => {
      listPermission(c, input.lists);
      created = store.create(
        input as SubscriberInput & { email: string; name: string },
        scope(c, "manage"),
      );
      return ok(store.project(created, maskScope(c)));
    });
    if (!input.preconfirm_subscriptions)
      optin?.afterAdminWrite(created!, permitted(c, input.lists));
    return response;
  };
  const update =
    (patch: boolean, external: boolean): Handler =>
    async (c) => {
      const externalKey = external ? selector(c) : undefined;
      const id = externalKey === undefined ? BigInt(getID(c)) : store.external(externalKey)?.id;
      if (id === undefined) throw new HttpError(400, "Subscriber not found");
      if (patch || external) {
        allowed(c, [id], "manage");
        required(c, id, external);
      }
      const input = await subscriberInput(c, "crud");
      validate(c, input, false, patch);
      auth.revalidate(c, "subscribers:manage");
      let updated: SubscriberRow;
      const response = store.transaction(() => {
        if (externalKey !== undefined && store.external(externalKey)?.id !== id)
          throw new HttpError(400, "Subscriber not found");
        allowed(c, [id], "manage");
        listPermission(c, input.lists);
        updated = store.update(required(c, id, external), input, patch, scope(c, "manage"));
        return ok(store.project(updated, maskScope(c)));
      });
      if (!input.preconfirm_subscriptions && (!patch || input.lists?.length))
        optin?.afterAdminWrite(updated!, permitted(c, input.lists));
      return response;
    };
  const remove =
    (external: boolean): Handler =>
    (c) => {
      const id = resolve(c, external);
      if (id === undefined) throw new HttpError(400, "Subscriber not found");
      return store.transaction(() => {
        allowed(c, [id], "manage");
        if (external) required(c, id, true);
        store.remove([id]);
        return ok(true);
      });
    };
  const deleteMany: Handler = (c) => {
    const values = c.url.searchParams.getAll("id");
    const invalid = (error: string) =>
      new HttpError(400, c.app.i18n.Ts("globals.messages.errorInvalidIDs", "error", error));
    if (!values.length) throw invalid("ids");
    const ids = values.map((v) => {
      if (!/^[+-]?\d+$/.test(v)) throw new HttpError(400);
      const n = BigInt(v);
      if (n < -9223372036854775808n || n > 9223372036854775807n) throw new HttpError(400);
      if (n < 1n) throw invalid(`${n} is not a valid ID`);
      return n;
    });
    return store.transaction(() => {
      allowed(c, ids, "manage");
      store.remove(ids);
      return ok(true);
    });
  };
  const blockOne: Handler = (c) =>
    store.transaction(() => {
      const id = BigInt(getID(c));
      allowed(c, [id], "manage");
      store.blocklist([id]);
      return ok(true);
    });
  const blockMany: Handler = async (c) => {
    const input = await subscriberInput(c, "blocklist");
    if (!input.ids?.length)
      throw new HttpError(400, c.app.i18n.Ts("globals.messages.errorInvalidIDs", "error", "ids"));
    auth.revalidate(c, "subscribers:manage");
    return store.transaction(() => {
      allowed(c, input.ids!, "manage");
      store.blocklist(input.ids!);
      return ok(true);
    });
  };
  const action =
    (single: boolean): Handler =>
    async (c) => {
      const input = await subscriberInput(c, single ? "single-membership" : "membership");
      const ids = single ? [BigInt(getID(c))] : (input.ids ?? []);
      if (!ids.length) throw new HttpError(400, c.app.i18n.T("globals.messages.noIDs"));
      if (!input.target_list_ids?.length)
        throw new HttpError(400, c.app.i18n.T("subscribers.errorNoListsGiven"));
      auth.revalidate(c, "subscribers:manage");
      return store.transaction(() => {
        allowed(c, ids, "manage");
        listPermission(c, input.target_list_ids);
        const s = scope(c, "manage");
        const targets = input.target_list_ids!.filter((id) => s.all || s.ids.includes(id));
        if (!["add", "remove", "unsubscribe"].includes(input.action ?? ""))
          throw new HttpError(400, c.app.i18n.T("globals.messages.invalidAction"));
        if (
          input.action === "add" &&
          input.status &&
          !["confirmed", "unconfirmed", "unsubscribed"].includes(input.status)
        )
          throw new HttpError(
            400,
            c.app.i18n.Ts("globals.messages.invalidFields", "name", "status"),
          );
        store.action(ids, targets, input.action!, input.status ?? "");
        return ok(true);
      });
    };
  // GET accepts either subscriber read permission, as in listmonk.
  const canGet: Handler = (c) => {
    if (!canRead(roles, identity(c))) throw new HttpError(403, "permission denied");
    return get(false)(c);
  };
  const canExternal: Handler = (c) => {
    if (!canRead(roles, identity(c))) throw new HttpError(403, "permission denied");
    return get(true)(c);
  };
  router.route("POST", "/api/subscribers", create, auth.middleware("subscribers:manage"));
  if (optin)
    router.route(
      "POST",
      "/api/subscribers/:id/optin",
      (c) => {
        const id = BigInt(getID(c));
        allowed(c, [id], "manage");
        const row = required(c, id);
        refuseWhileHeld(c.app.db);
        try {
          optin.send(row);
        } catch (error) {
          c.app.logger.error(error);
          throw new HttpError(500, c.app.i18n.T("subscribers.errorSendingOptin"));
        }
        return ok(true);
      },
      auth.middleware("subscribers:manage"),
      hasID,
    );
  router.route("GET", "/api/subscribers/:id", canGet, auth.middleware(), hasID);
  if (activity) {
    // Native (07-api-and-ui.md): the subscriber's own check, then each record's permission.
    const paged =
      (read: ActivityPage, permission?: string): Handler =>
      (c) => {
        const i = identity(c);
        if (!canRead(roles, i)) throw new HttpError(403, "permission denied");
        if (permission && !roles.can(i.role, permission))
          throw new HttpError(403, "permission denied");
        const id = BigInt(getID(c));
        allowed(c, [id], "get");
        required(c, id);
        const number = (key: string, fallback: number, limit: number) => {
          const value = c.url.searchParams.get(key) ?? String(fallback);
          if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > limit) throw new HttpError(400);
          return Number(value);
        };
        return ok(read(id, number("page", 1, 1_000_000), number("per_page", 20, 100)));
      };
    const route = (path: string, handler: Handler) =>
      router.route("GET", `/api/subscribers/:id/${path}`, handler, auth.middleware(), hasID);
    route("subscriber-events", paged(activity.events));
    route("enrollments", paged(activity.enrollments, "sequences:get"));
    route("sends", paged(activity.sends, "sends:get"));
  }
  router.route(
    "PUT",
    "/api/subscribers/:id",
    update(false, false),
    auth.middleware("subscribers:manage"),
    hasID,
  );
  router.route(
    "PATCH",
    "/api/subscribers/:id",
    update(true, false),
    auth.middleware("subscribers:manage"),
    hasID,
  );
  router.route(
    "DELETE",
    "/api/subscribers/:id",
    remove(false),
    auth.middleware("subscribers:manage"),
    hasID,
  );
  router.route("DELETE", "/api/subscribers", deleteMany, auth.middleware("subscribers:manage"));
  router.route(
    "PUT",
    "/api/subscribers/:id/blocklist",
    blockOne,
    auth.middleware("subscribers:manage"),
    hasID,
  );
  router.route(
    "PUT",
    "/api/subscribers/blocklist",
    blockMany,
    auth.middleware("subscribers:manage"),
  );
  router.route(
    "PUT",
    "/api/subscribers/lists",
    action(false),
    auth.middleware("subscribers:manage"),
  );
  router.route(
    "PUT",
    "/api/subscribers/lists/:id",
    action(true),
    auth.middleware("subscribers:manage"),
    hasID,
  );
  for (const path of ["/api/subscribers/external", "/api/subscribers/external/:external_id"]) {
    router.route("GET", path, canExternal, auth.middleware());
    router.route("PUT", path, update(false, true), auth.middleware("subscribers:manage"));
    router.route("DELETE", path, remove(true), auth.middleware("subscribers:manage"));
  }
}
