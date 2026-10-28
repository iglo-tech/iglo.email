// Adapted from listmonk cmd/subscribers.go and cmd/handlers.go at 6fcd95f.
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import { trimSpace } from "@/lists/store";
import { sanitizeEmail } from "@/subscribers/email";
import { subscriberInput, validExternal, type SubscriberInput } from "@/subscribers/input";
import type { SubscriberStore, Scope } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";

export function registerSubscriberRoutes(
  router: Router,
  store: SubscriberStore,
  roles: Roles,
  auth: Authentication,
) {
  const identity = (c: RequestContext) => {
    if (!c.identity) throw new Error("Identity required");
    return c.identity;
  };
  const scope = (c: RequestContext, kind: "get" | "manage"): Scope => {
    const i = identity(c);
    const get = roles.listScope(i.role, i.user.list_role_id, "list:get"),
      manage = roles.listScope(i.role, i.user.list_role_id, "list:manage");
    if (kind === "manage") return manage;
    if (get.all || manage.all) return { all: true, ids: [] };
    return get.ids.length ? get : manage;
  };
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
        throw new HttpError(403, "permission denied");
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
        throw new HttpError(403, "permission denied");
    }
  };
  const email = (value: string) => {
    const result = sanitizeEmail(value);
    if (result === undefined) throw new HttpError(400, "Invalid email.");
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
    if (creating) {
      input.name = trimSpace(input.name ?? "");
      if (!input.name)
        input.name = (input.email ?? "")
          .split("@")[0]!
          .replaceAll(".", " ")
          .split(/\s+/)
          .map((word) =>
            [...new Intl.Segmenter("und", { granularity: "word" }).segment(word)]
              .map((part) =>
                part.isWordLike
                  ? part.segment.replace(/\p{L}/u, (letter) => {
                      const upper = Array.from(letter.toUpperCase());
                      return (upper[0] ?? "") + upper.slice(1).join("").toLowerCase();
                    })
                  : part.segment,
              )
              .join(""),
          )
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
    return store.transaction(() => {
      listPermission(c, input.lists);
      const row = store.create(
        input as SubscriberInput & { email: string; name: string },
        scope(c, "manage"),
      );
      return ok(store.project(row, maskScope(c)));
    });
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
      return store.transaction(() => {
        if (externalKey !== undefined && store.external(externalKey)?.id !== id)
          throw new HttpError(400, "Subscriber not found");
        allowed(c, [id], "manage");
        listPermission(c, input.lists);
        const row = store.update(required(c, id, external), input, patch, scope(c, "manage"));
        return ok(store.project(row, maskScope(c)));
      });
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
    if (!values.length) throw new HttpError(400);
    const ids = values.map((v) => {
      if (!/^[+-]?\d+$/.test(v)) throw new HttpError(400);
      const n = BigInt(v);
      if (n < 1n || n > 9223372036854775807n) throw new HttpError(400);
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
    const i = identity(c);
    if (!roles.can(i.role, "subscribers:get") && !roles.can(i.role, "subscribers:get_all"))
      throw new HttpError(403, "permission denied");
    return get(false)(c);
  };
  const canExternal: Handler = (c) => {
    const i = identity(c);
    if (!roles.can(i.role, "subscribers:get") && !roles.can(i.role, "subscribers:get_all"))
      throw new HttpError(403, "permission denied");
    return get(true)(c);
  };
  router.route("POST", "/api/subscribers", create, auth.middleware("subscribers:manage"));
  router.route("GET", "/api/subscribers/:id", canGet, auth.middleware(), hasID);
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
