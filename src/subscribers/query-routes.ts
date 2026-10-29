// Adapted from listmonk cmd/subscribers.go (QuerySubscribers, ExportSubscribers,
// DeleteSubscribersByQuery, BlocklistSubscribersByQuery, ManageSubscriberListsByQuery,
// filterListQueryByPerm, maskRestrictedSubLists), internal/auth/models.go
// (GetPermittedListIDs, GetPermittedLists, FilterListsByPerm) and cmd/handlers.go at 6fcd95f.
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { readBodyBytes } from "@/users/input";
import type { Authentication } from "@/users/auth";
import type { Identity } from "@/users/models";
import { exportHeader, exportRecord } from "@/subscribers/export";
import {
  checkFragment,
  formatSQLExp,
  subscriberStatuses,
  subscriptionStatuses,
  type SubscriberFilter,
} from "@/subscribers/query-filter";
import { RunnerError } from "@/subscribers/query-runner";
import type { SubscriberQuery } from "@/subscribers/query";
import type { Scope, SubscriberStore } from "@/subscribers/store";

interface Types {
  get: boolean;
  manage: boolean;
}
const MANAGE: Types = { get: false, manage: true },
  ANY: Types = { get: true, manage: true };
const NONE = [-1n];
/** Pages above this many rows count as large selections. */
const LARGE_PAGE = 1000;
const throwTooMany = (): never => {
  throw new HttpError(429, "Too many large subscriber selections in progress.");
};
const max = 9223372036854775807n,
  min = -9223372036854775808n;

// Go strings.TrimSpace.
const trimSpace = (value: string) =>
  value.replace(
    /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
// Go strconv.Atoi for page values: anything else is 0.
function atoi(value: string | null): number {
  if (!value || !/^[+-]?\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}
// listmonk getQueryInts: empty values are skipped, other values must be int64.
function queryInts(params: URLSearchParams, name: string): bigint[] | undefined {
  const out: bigint[] = [];
  for (const value of params.getAll(name)) {
    if (value === "") continue;
    if (!/^[+-]?\d+$/.test(value)) return undefined;
    const n = BigInt(value);
    if (n < min || n > max) return undefined;
    out.push(n);
  }
  return out;
}

interface QueryInput {
  search: string;
  query: string;
  list_ids: bigint[];
  target_list_ids: bigint[];
  action: string;
  status: string;
  subscription_status: string;
  subscriber_status: string;
  all: boolean;
}
const stringFields = [
  "search",
  "query",
  "action",
  "status",
  "subscription_status",
  "subscriber_status",
];
const listFields = ["list_ids", "target_list_ids"];

/** listmonk subQueryReq bound from a JSON body; other bodies bind no fields. */
async function queryInput(c: RequestContext): Promise<QueryInput> {
  const out: QueryInput = {
    search: "",
    query: "",
    list_ids: [],
    target_list_ids: [],
    action: "",
    status: "",
    subscription_status: "",
    subscriber_status: "",
    all: false,
  };
  const body = await readBodyBytes(c.request);
  const type = c.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!body.length || type !== "application/json") return out;
  let document: unknown;
  try {
    document = JSON.parse(body.toString("utf8"), (_key, value, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      const source = context?.source ?? "";
      return /^-?\d+$/.test(source) ? BigInt(source) : value;
    });
  } catch {
    throw new HttpError(400);
  }
  if (document === null) return out;
  if (typeof document !== "object" || Array.isArray(document)) throw new HttpError(400);
  const record = out as unknown as Record<string, unknown>;
  // encoding/json matches field names case-insensitively.
  for (const [rawKey, value] of Object.entries(document)) {
    const key = rawKey.toLowerCase();
    if (stringFields.includes(key)) {
      if (value === null) continue;
      if (typeof value !== "string") throw new HttpError(400);
      record[key] = value.toWellFormed();
    } else if (listFields.includes(key)) {
      if (value === null) {
        record[key] = [];
        continue;
      }
      if (!Array.isArray(value)) throw new HttpError(400);
      record[key] = value.map((item) => {
        if (item === null) return 0n;
        if (typeof item !== "bigint" || item < min || item > max) throw new HttpError(400);
        return item;
      });
    } else if (key === "all") {
      if (value === null) continue;
      if (typeof value !== "boolean") throw new HttpError(400);
      out.all = value;
    }
  }
  return out;
}

export function registerSubscriberQueryRoutes(
  router: Router,
  query: SubscriberQuery,
  store: SubscriberStore,
  roles: Roles,
  auth: Authentication,
) {
  const identity = (c: RequestContext) => {
    if (!c.identity) throw new Error("Identity required");
    return c.identity;
  };
  const listIDs = (i: Identity, permission: "list:get" | "list:manage") =>
    roles.listScope(i.role, i.user.list_role_id, permission);
  // FilterListsByPerm: with both types only per-list get permissions count, as upstream.
  const filterLists = (i: Identity, types: Types, ids: bigint[]) => {
    if (types.get && listIDs(i, "list:get").all) return ids;
    if (types.manage && listIDs(i, "list:manage").all) return ids;
    const allowed = listIDs(i, types.get ? "list:get" : "list:manage").ids;
    return ids.filter((id) => allowed.includes(id));
  };
  // GetPermittedListIDs: null is every subscriber; [-1] matches none.
  const permittedLists = (i: Identity, types: Types, requested: bigint[]): bigint[] | null => {
    if (requested.length) {
      const ids = filterLists(i, types, requested);
      return ids.length ? ids : NONE;
    }
    if (types.get && roles.can(i.role, "subscribers:get_all")) return null;
    const get = listIDs(i, "list:get"),
      manage = listIDs(i, "list:manage");
    if ((types.get && get.all) || (types.manage && manage.all)) return null;
    const ids = types.get && get.ids.length ? get.ids : types.manage ? manage.ids : [];
    return ids.length ? ids : NONE;
  };
  const maskScope = (i: Identity): Scope => {
    const a = listIDs(i, "list:get"),
      b = listIDs(i, "list:manage");
    return { all: a.all || b.all, ids: [...a.ids, ...b.ids] };
  };
  const canRead = (c: RequestContext) => {
    const i = identity(c);
    if (!roles.can(i.role, "subscribers:get") && !roles.can(i.role, "subscribers:get_all"))
      throw new HttpError(403, "permission denied");
    return i;
  };
  const sqlPermission = (c: RequestContext, fragment: string) => {
    if (fragment && !roles.can(identity(c).role, "subscribers:sql_query"))
      throw new HttpError(
        403,
        c.app.i18n.Ts("globals.messages.permissionDenied", "name", "subscribers:sql_query"),
      );
  };
  const preparing = (c: RequestContext, error: string) =>
    new HttpError(400, c.app.i18n.Ts("subscribers.errorPreparingQuery", "error", error));
  // The checks upstream's database casts and dry run perform before running a query.
  const validate = (c: RequestContext, filter: SubscriberFilter) => {
    for (const [type, value, allowed] of [
      ["subscription_status", filter.subscriptionStatus, [...subscriptionStatuses, "none"]],
      ["subscriber_status", filter.subscriberStatus, subscriberStatuses],
    ] as const)
      if (value && !allowed.includes(value))
        throw preparing(c, `invalid input value for enum ${type}: "${value}"`);
    const problem = filter.fragment ? checkFragment(filter.fragment) : undefined;
    if (problem) throw preparing(c, problem);
  };
  // Upstream returns 400 when preparing a query fails and 500 when running it fails.
  const fetching = (c: RequestContext, error: unknown): never => {
    if (error instanceof HttpError) throw error;
    if (error instanceof RunnerError && error.kind === "busy")
      throw new HttpError(429, "Too many subscriber queries in progress.");
    if (error instanceof RunnerError && error.kind === "query") throw preparing(c, error.message);
    throw new HttpError(
      500,
      c.app.i18n.Ts(
        "globals.messages.errorFetching",
        "name",
        "{globals.terms.subscribers}",
        "error",
        error instanceof Error ? error.message : "unknown error",
      ),
    );
  };
  const readFilter = (c: RequestContext, i: Identity): SubscriberFilter => {
    const params = c.url.searchParams;
    let lists: bigint[] = [];
    if (params.has("list_id")) {
      const ids = queryInts(params, "list_id");
      if (!ids) throw new HttpError(400, c.app.i18n.T("globals.messages.invalidID"));
      lists = ids;
    }
    const filter = {
      lists: permittedLists(i, ANY, lists),
      fragment: formatSQLExp(params.get("query") ?? ""),
      search: trimSpace(params.get("search") ?? ""),
      subscriptionStatus: params.get("subscription_status") ?? "",
      subscriberStatus: params.get("status") ?? "",
    };
    return filter;
  };

  const encode = (value: unknown) =>
    JSON.stringify(value)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");

  const list: Handler = async (c) => {
    const i = canRead(c);
    const filter = readFilter(c, i);
    sqlPermission(c, filter.fragment);
    validate(c, filter);
    const params = c.url.searchParams;
    let perPage = atoi(params.get("per_page"));
    if (params.get("per_page") === "all") perPage = -1;
    perPage = perPage < 0 ? 0 : perPage < 1 ? 20 : perPage;
    const page = Math.max(1, atoi(params.get("page")));
    // per_page=all, negative and oversized pages hold every selected ID until streamed.
    let release = () => {};
    if (perPage === 0 || perPage > LARGE_PAGE) release = query.admitLarge() ?? throwTooMany();
    let result: { total: number; ids: bigint[] };
    try {
      result = await query.page(
        filter,
        params.get("order_by") ?? "",
        params.get("order") ?? "",
        Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER),
        perPage,
      );
    } catch (error) {
      release();
      return fetching(c, error);
    }
    const scope = maskScope(i);
    const tail = encode({
      search: filter.search,
      query: filter.fragment,
      total: result.total,
      per_page: perPage,
      page,
    }).slice(1);
    // As upstream: no matches is [], a page past the end is null.
    if (!result.total || !result.ids.length) {
      release();
      return new Response(`{"data":{"results":${result.total ? "null" : "[]"},${tail}}\n`, {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Stream large pages (per_page=all) in bounded batches of projected rows.
    let next = 0;
    const text = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= result.ids.length) {
          controller.enqueue(text.encode(`],${tail}}\n`));
          controller.close();
          release();
          return;
        }
        const parts: string[] = [];
        for (const id of result.ids.slice(next, next + 200)) {
          const row = store.get(id);
          if (row) parts.push(encode(store.project(row, scope)));
        }
        const prefix = next === 0 ? '{"data":{"results":[' : parts.length ? "," : "";
        next += 200;
        controller.enqueue(text.encode(prefix + parts.join(",")));
      },
      cancel: release,
    });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  };

  const exportCSV: Handler = async (c) => {
    const i = canRead(c);
    const filter = readFilter(c, i);
    const only = queryInts(c.url.searchParams, "id");
    if (!only) throw new HttpError(400, c.app.i18n.T("globals.messages.invalidID"));
    sqlPermission(c, filter.fragment);
    validate(c, filter);
    const admitted = query.admitLarge() ?? throwTooMany();
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = () => {
      admitted();
      void batches.return(undefined);
    };
    // A raw query that times out while the reader is paused ends the response at once.
    const batches = query.ids(filter, only, (error) => {
      try {
        output?.error(error);
      } catch {
        /* already closed */
      }
      if (output) finish();
    });
    try {
      await batches.next();
    } catch (error) {
      finish();
      return fetching(c, error);
    }
    const text = new TextEncoder();
    let started = false;
    const csv = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(text.encode(exportHeader));
          return;
        }
        try {
          const item = await batches.next();
          if (item.done) {
            controller.close();
            finish();
            return;
          }
          const rows = query.exportRows(item.value);
          if (rows.length) controller.enqueue(text.encode(rows.map(exportRecord).join("")));
        } catch (error) {
          // Headers are sent: end the stream with an error, as upstream stops writing.
          controller.error(error);
          finish();
        }
      },
      cancel: finish,
    });
    const gzip = (c.request.headers.get("accept-encoding") ?? "").includes("gzip");
    return new Response(
      gzip
        ? csv.pipeThrough(
            new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
          )
        : csv,
      {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=subscribers.csv",
          "Content-Transfer-Encoding": "binary",
          "Cache-Control": "no-cache",
          Vary: "Accept-Encoding",
          ...(gzip ? { "Content-Encoding": "gzip" } : {}),
        },
      },
    );
  };

  type Action = (input: QueryInput, ids: bigint[], targets: bigint[]) => void;
  const bulk =
    (kind: "delete" | "blocklist" | "lists"): Handler =>
    async (c) => {
      const input = await queryInput(c);
      if (kind === "lists" && !input.target_list_ids.length)
        throw new HttpError(400, c.app.i18n.T("subscribers.errorNoListsGiven"));
      const search = trimSpace(input.search),
        fragment = formatSQLExp(input.query);
      if (!input.all && !search && !fragment)
        throw new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFields", "name", "query"));
      sqlPermission(c, fragment);
      let act: Action;
      if (kind === "delete") act = (_input, ids) => query.remove(ids);
      else if (kind === "blocklist") act = (_input, ids) => query.blocklist(ids);
      else if (input.action === "add") {
        if (input.status && !subscriptionStatuses.includes(input.status))
          throw new HttpError(
            400,
            c.app.i18n.Ts("globals.messages.invalidFields", "name", "status"),
          );
        act = (value, ids, targets) => query.addLists(ids, targets, value.status);
      } else if (input.action === "remove")
        act = (_input, ids, targets) => query.removeLists(ids, targets);
      else if (input.action === "unsubscribe")
        act = (_input, ids, targets) => query.unsubscribeLists(ids, targets);
      else throw new HttpError(400, c.app.i18n.T("globals.messages.invalidAction"));
      auth.revalidate(c, "subscribers:manage");
      sqlPermission(c, fragment);
      const select = (i: Identity): SubscriberFilter => ({
        lists: permittedLists(i, MANAGE, input.list_ids),
        fragment,
        search,
        subscriptionStatus: input.subscription_status,
        subscriberStatus: input.subscriber_status,
      });
      // As upstream's core: a failed selection or write is the operation's error.
      const failed = (e: unknown): never => {
        if (e instanceof HttpError) throw e;
        if (e instanceof RunnerError && e.kind === "busy")
          throw new HttpError(429, "Too many subscriber queries in progress.");
        const error = e instanceof Error ? e.message : "unknown error",
          name = "{globals.terms.subscribers}";
        throw new HttpError(
          500,
          kind === "delete"
            ? c.app.i18n.Ts("globals.messages.errorDeleting", "name", name, "error", error)
            : kind === "blocklist"
              ? c.app.i18n.Ts("subscribers.errorBlocklisting", "error", error)
              : c.app.i18n.Ts("globals.messages.errorUpdating", "name", name, "error", error),
        );
      };
      validate(c, select(identity(c)));
      // A raw selection holds its candidate IDs until the write transaction ends.
      const release = fragment ? (query.admitLarge() ?? throwTooMany()) : () => {};
      try {
        let candidates: bigint[] | null = null;
        if (fragment) {
          candidates = [];
          try {
            for await (const ids of query.ids(select(identity(c)))) candidates.push(...ids);
          } catch (e) {
            return failed(e);
          }
          // The selection awaited a child process: confirm the caller still holds every grant.
          auth.revalidate(c, "subscribers:manage");
          sqlPermission(c, fragment);
        }
        try {
          query.transaction(() => {
            const i = identity(c);
            const targets = filterLists(i, MANAGE, input.target_list_ids);
            query.apply(select(i), candidates, (ids) => act(input, ids, targets));
          });
        } catch (e) {
          return failed(e);
        }
      } finally {
        release();
      }
      return ok(true);
    };

  router.route("GET", "/api/subscribers", list, auth.middleware());
  router.route("GET", "/api/subscribers/export", exportCSV, auth.middleware());
  router.route(
    "POST",
    "/api/subscribers/query/delete",
    bulk("delete"),
    auth.middleware("subscribers:manage"),
  );
  router.route(
    "PUT",
    "/api/subscribers/query/blocklist",
    bulk("blocklist"),
    auth.middleware("subscribers:manage"),
  );
  router.route(
    "PUT",
    "/api/subscribers/query/lists",
    bulk("lists"),
    auth.middleware("subscribers:manage"),
  );
}
