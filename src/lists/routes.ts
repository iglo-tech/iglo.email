// Adapted from listmonk cmd/lists.go and cmd/handlers.go at 6fcd95f.
import type { ListFilter, ListStore } from "@/lists/store";
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { listInput } from "@/lists/input";

function principal(context: RequestContext) {
  if (!context.identity) throw new Error("Authenticated identity required");
  return context.identity;
}
function permitted(
  context: RequestContext,
  roles: Roles,
  permission: "list:get" | "list:manage",
  ids: bigint[],
) {
  const identity = principal(context);
  if (!roles.canList(identity.role, identity.user.list_role_id, permission, ids))
    throw new HttpError(403, "permission denied");
}
function scope(context: RequestContext, roles: Roles, permission: "list:get" | "list:manage") {
  const identity = principal(context);
  return roles.listScope(identity.role, identity.user.list_role_id, permission);
}
function validate(context: RequestContext, type: string, optin: string, status: string) {
  for (const [name, value, allowed] of [
    ["type", type, ["public", "private"]],
    ["optin", optin, ["single", "double"]],
    ["status", status, ["active", "archived"]],
  ] as const)
    if (value && !(allowed as readonly string[]).includes(value))
      throw new HttpError(400, context.app.i18n.Ts("globals.messages.invalidFields", "name", name));
}
function numeric(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}
function first(params: URLSearchParams, key: string): string {
  return (
    params
      .getAll(key)
      .map((value) => value.trim())
      .find(Boolean) ?? ""
  );
}
function filter(
  context: RequestContext,
  params: URLSearchParams,
  defaultStatus: string,
  deletion = false,
): ListFilter {
  // Upstream DeleteLists uses raw first URL values and all raw tags, while
  // collection makeQuery trims fields and discards empty tag values.
  const field = (key: string) => (deletion ? (params.get(key) ?? "") : first(params, key));
  const result = {
    query: field("query").trim(),
    type: field("type"),
    optin: field("optin"),
    status: field("status") || defaultStatus,
    tags: deletion
      ? params.getAll("tag")
      : params
          .getAll("tag")
          .map((v) => v.trim())
          .filter(Boolean),
  };
  validate(context, result.type, result.optin, result.status);
  return result;
}
export function registerListRoutes(
  router: Router,
  store: ListStore,
  roles: Roles,
  auth: Authentication,
) {
  const collection: Handler = (context) => {
    const params = context.url.searchParams;
    const f = filter(context, params, "active");
    const minimal = first(params, "minimal") === "true";
    let page = numeric(first(params, "page"));
    if (page < 1) page = 1;
    const perRaw = first(params, "per_page");
    let perPage = perRaw === "all" ? -1 : numeric(perRaw);
    perPage = perPage < 0 ? 0 : perPage < 1 ? 20 : perPage;
    const result = store.query(
      f,
      scope(context, roles, "list:get"),
      minimal,
      first(params, "order_by"),
      first(params, "order"),
      page,
      perPage,
    );
    if (minimal && !result.total) return ok([]);
    return ok({
      results: result.results,
      search: "",
      query: f.query,
      total: result.total,
      per_page: minimal ? result.total : perPage,
      page: minimal ? 1 : page,
    });
  };
  const missing = (context: RequestContext): never => {
    throw new HttpError(
      400,
      context.app.i18n.Ts("globals.messages.notFound", "name", "{globals.terms.list}"),
    );
  };
  const get: Handler = (context) => {
    const id = BigInt(getID(context));
    permitted(context, roles, "list:get", [id]);
    return ok(store.get(id) ?? missing(context));
  };
  const create: Handler = async (context) => {
    const value = await listInput(context);
    auth.revalidate(context, "lists:manage_all");
    return ok(store.create(value));
  };
  const update: Handler = async (context) => {
    const id = BigInt(getID(context));
    permitted(context, roles, "list:manage", [id]);
    const value = await listInput(context);
    auth.revalidate(context);
    permitted(context, roles, "list:manage", [id]);
    return ok(store.update(id, value) ?? missing(context));
  };
  const removeOne: Handler = (context) => {
    const id = BigInt(getID(context));
    permitted(context, roles, "list:manage", [id]);
    store.remove(
      [id],
      { query: "", type: "", optin: "", status: "", tags: [] },
      { all: true, ids: [] },
    );
    return ok(true);
  };
  const removeMany: Handler = (context) => {
    // Pinned Go ParseForm does not consume URL-encoded DELETE bodies.
    const params = context.url.searchParams;
    const raw = context.url.searchParams.getAll("id");
    const ids: bigint[] = [];
    for (const value of raw) {
      let reason = "";
      if (!/^[+-]?\d+$/.test(value))
        reason = `strconv.Atoi: parsing ${JSON.stringify(value)}: invalid syntax`;
      else {
        const id = BigInt(value);
        if (id < -9223372036854775808n || id > 9223372036854775807n)
          reason = `strconv.Atoi: parsing ${JSON.stringify(value)}: value out of range`;
        else if (id < 1n) reason = `${id} is not a valid ID`;
        else ids.push(id);
      }
      if (reason)
        throw new HttpError(
          400,
          context.app.i18n.Ts("globals.messages.errorInvalidIDs", "error", reason),
        );
    }
    const f = ids.length
      ? { query: "", type: "", optin: "", status: "", tags: [] }
      : filter(context, params, "", true);
    if (!ids.length && !f.query && params.get("all") !== "true")
      throw new HttpError(
        400,
        context.app.i18n.Ts("globals.messages.errorInvalidIDs", "error", "id or query required"),
      );
    auth.revalidate(context);
    if (ids.length) permitted(context, roles, "list:manage", ids);
    store.remove(ids, f, scope(context, roles, "list:manage"));
    return ok(true);
  };
  router.route("GET", "/api/lists", collection, auth.middleware());
  router.route("GET", "/api/lists/:id", get, auth.middleware(), hasID);
  router.route("POST", "/api/lists", create, auth.middleware("lists:manage_all"));
  router.route("PUT", "/api/lists/:id", update, auth.middleware(), hasID);
  router.route("DELETE", "/api/lists/:id", removeOne, auth.middleware(), hasID);
  router.route("DELETE", "/api/lists", removeMany, auth.middleware());
}
