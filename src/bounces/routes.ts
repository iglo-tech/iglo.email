// Adapted from listmonk cmd/bounce.go, cmd/subscribers.go (GetSubscriberBounces,
// DeleteSubscriberBounces) and the bounce routes of cmd/handlers.go at 6fcd95f.
// Upstream registers the webhook routes at startup; here settings apply live.
import type { Database } from "bun:sqlite";
import type { BounceStore, BounceEvent, BounceType } from "@/bounces/store";
import { bounceTypes, reUUID } from "@/bounces/store";
import type { SesSettings } from "@/bounces/ses-route";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import type { PageSite } from "@/public/layout";
import { publicNotFound } from "@/public/message";
import { parseBool } from "@/public/form";
import type { Roles } from "@/roles/roles";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import { sanitizeEmail } from "@/subscribers/email";
import type { SubscriberStore } from "@/subscribers/store";
import type { Authentication } from "@/users/auth";
import { readBodyBytes } from "@/users/input";

const reRFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** The instance keys a project's bounce routes read (B139: `bounce.*` is the instance's). */
export type BounceSettings = Pick<SesSettings, "enabled" | "webhooksEnabled">;
// Go strconv.Atoi, ignoring its error.
const atoi = (value: string | null) => {
  if (!value || !/^[+-]?\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
};
/** parseStringIDs: every value a positive integer, or null. */
function parseIDs(values: Array<string>): Array<bigint> | null {
  const ids: Array<bigint> = [];
  for (const value of values) {
    if (!/^[+-]?\d+$/.test(value)) {
      return null;
    }
    const id = BigInt(value);
    if (id < 1n || id > 9_223_372_036_854_775_807n) {
      return null;
    }
    ids.push(id);
  }
  return ids;
}
/**
 * The documented `meta` is an escaped JSON string; `meta` is a JSON object in this schema, so
 * the string's object is stored and any other value is kept under `value`.
 */
export function bounceMeta(value: unknown): string {
  if (value === undefined || value === null) {
    return "{}";
  }
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      /* Plain text. */
    }
  }
  return JSON.stringify(
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value },
  );
}

const invalidID = (c: RequestContext) =>
  new HttpError(400, c.app.i18n.T("globals.messages.invalidID"));
const invalidField = (c: RequestContext, name: string) =>
  new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFields", "name", name));
const invalidData = (c: RequestContext) =>
  new HttpError(400, c.app.i18n.T("globals.messages.invalidData"));
const unknownService = (c: RequestContext) =>
  new HttpError(400, c.app.i18n.T("bounces.unknownService"));
const unavailable = (c: RequestContext) =>
  new HttpError(503, c.app.i18n.T("globals.messages.internalError"));
// A type outside the enum fails upstream's cast with a 500: here it matches nothing.
const typeFilter = (value: string) =>
  value && !(bounceTypes as ReadonlyArray<string>).includes(value) ? "none" : value;
const campaignFilter = (c: RequestContext) => {
  const raw = c.url.searchParams.get("campaign_id");
  if (!raw) {
    return 0;
  }
  const id = /^[+-]?\d+$/.test(raw) ? Number(raw) : 0;
  if (id < 1) {
    throw invalidID(c);
  }
  return id;
};
export function registerBounceRoutes(
  router: Router,
  deps: {
    db: Database;
    clock: Clock;
    store: BounceStore;
    subscribers: Pick<SubscriberStore, "get" | "memberships">;
    roles: Roles;
    auth: Authentication;
    settings: () => BounceSettings;
    /** The site's branding, for the public 404 when webhooks are off (B121). */
    page: () => PageSite;
    /** The public rate limit for the provider's route. */
    limit: Middleware;
  },
) {
  const { db, clock, store, subscribers, roles, auth, settings, page } = deps;

  /** Upstream has no route at all without `bounce.webhooks_enabled`. */
  const webhooksEnabled: Middleware = (c, next) =>
    settings().webhooksEnabled ? next() : publicNotFound(c.app.i18n, c.request.method, page());

  /** hasSubPerm: a subscriber who exists must be on a permitted list. */
  const subscriberPermission = (c: RequestContext, id: bigint | number, kind: "get" | "manage") => {
    const i = c.identity;
    if (!i) {
      throw new Error("Identity required");
    }
    const get = roles.listScope(i.role, i.user.list_role_id, "list:get"),
      manage = roles.listScope(i.role, i.user.list_role_id, "list:manage");
    const scope =
      kind === "manage"
        ? manage
        : get.all || manage.all
          ? { all: true, ids: [] }
          : get.ids.length
            ? get
            : manage;
    if (scope.all || !subscribers.get(BigInt(id))) {
      return;
    }
    if (!subscribers.memberships(BigInt(id)).some((m) => scope.ids.includes(m.list_id))) {
      throw new HttpError(
        403,
        c.app.i18n.Ts("globals.messages.permissionDenied", "name", `subscriber: ${id}`),
      );
    }
  };
  const collection: Handler = (c) => {
    const params = c.url.searchParams;
    let page = atoi(params.get("page"));
    if (page < 1) {
      page = 1;
    }
    const rawPer = params.get("per_page");
    let perPage = rawPer === "all" ? 0 : atoi(rawPer);
    if (rawPer !== "all" && perPage < 1) {
      perPage = 20;
    }
    const { results, total } = store.query({
      campaignId: atoi(params.get("campaign_id")),
      source: params.get("source") ?? "",
      type: typeFilter(params.get("type") ?? ""),
      orderBy: params.get("order_by") ?? "",
      order: params.get("order") ?? "",
      offset: perPage ? Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER) : 0,
      limit: perPage,
    });
    if (!results.length) {
      return ok({ results: [], search: "", query: "", total: 0, per_page: 0, page: 0 });
    }
    return ok({
      results,
      search: "",
      query: "",
      total,
      per_page: perPage,
      page: perPage ? page : 1,
    });
  };
  const one: Handler = (c) => {
    const found = store.get(getID(c));
    if (!found) {
      throw new HttpError(
        400,
        c.app.i18n.Ts("globals.messages.notFound", "name", "{globals.terms.bounce}"),
        {},
        "not_found",
      );
    }
    return ok(found);
  };
  const remove: Handler = (c) => {
    const params = c.url.searchParams;
    let all = parseBool(params.get("all") ?? "") ?? false;
    const raw = params.getAll("id");
    let ids: Array<bigint> = [];
    if (!all || raw.length) {
      const parsed = parseIDs(raw);
      if (!parsed?.length) {
        throw invalidID(c);
      }
      ids = parsed;
      all = false;
    }
    const campaignId = campaignFilter(c);
    const source = params.get("source") ?? "",
      type = typeFilter(params.get("type") ?? "");
    writeTransaction(db, () => {
      if (all) {
        store.deleteFiltered(campaignId, source, type);
      } else {
        store.deleteIDs(ids);
      }
    });
    return ok(true);
  };
  const removeOne: Handler = (c) => {
    const id = getID(c);
    writeTransaction(db, () => store.deleteIDs([id]));
    return ok(true);
  };
  const blocklist: Handler = (c) => {
    const params = c.url.searchParams;
    const ids = parseIDs(params.getAll("id"));
    if (!ids) {
      throw invalidID(c);
    }
    const campaignId = campaignFilter(c);
    const source = params.get("source") ?? "",
      type = typeFilter(params.get("type") ?? "");
    writeTransaction(db, () => store.blocklist(ids, campaignId, source, type));
    return ok(true);
  };
  const ofSubscriber: Handler = (c) => {
    const id = getID(c);
    subscriberPermission(c, id, "get");
    return ok(store.query({ subscriberId: id, offset: 0, limit: 1000 }).results);
  };
  const removeOfSubscriber: Handler = (c) => {
    const id = getID(c);
    subscriberPermission(c, id, "manage");
    writeTransaction(db, () => store.deleteBySubscriber(id));
    return ok(true);
  };

  /** validateBounceFields, over what Go's decoder accepts for models.Bounce. */
  const nativeEvent = (c: RequestContext, value: unknown): BounceEvent => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidData(c);
    }
    const body = value as Record<string, unknown>;
    const text = (key: string) => {
      const field = body[key] ?? "";
      if (typeof field !== "string" || field.includes("\0")) {
        throw invalidData(c);
      }
      return field;
    };
    const email = text("email"),
      subscriberUuid = text("subscriber_uuid"),
      sendUuid = text("send_uuid"),
      type = text("type"),
      createdAt = text("created_at");
    if (!email && !subscriberUuid && !sendUuid) {
      throw invalidField(c, "email / subscriber_uuid");
    }
    if (subscriberUuid && !reUUID.test(subscriberUuid)) {
      throw invalidField(c, "subscriber_uuid");
    }
    if (sendUuid && !reUUID.test(sendUuid)) {
      throw invalidField(c, "send_uuid");
    }
    const sanitized = email ? sanitizeEmail(email) : "";
    if (sanitized === undefined) {
      throw new HttpError(400, "Invalid email.");
    }
    if (!(bounceTypes as ReadonlyArray<string>).includes(type)) {
      throw invalidField(c, "type");
    }
    if (createdAt && (!reRFC3339.test(createdAt) || Number.isNaN(Date.parse(createdAt)))) {
      throw invalidData(c);
    }
    return {
      subscriberUuid: subscriberUuid.toLowerCase(),
      email: sanitized,
      campaignUuid: text("campaign_uuid").toLowerCase(),
      sendUuid: sendUuid.toLowerCase(),
      // Without a send the UUID or email is the caller's own claim, taken as upstream takes it.
      recipient: sendUuid ? sanitized : "",
      messageId: "",
      type: type as BounceType,
      source: text("source"),
      meta: bounceMeta(body.meta),
      bareMeta: "{}",
      bareSource: "api",
      createdAt: new Date(createdAt || clock.now()).toISOString(),
    };
  };
  const native: Handler = async (c) => {
    if (!settings().enabled) {
      throw unavailable(c);
    }
    const raw = (await readBodyBytes(c.request)).toString("utf-8");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw invalidData(c);
    }
    const event = nativeEvent(c, body);
    // Each accepted POST counts, as upstream: this API has no event identity to deduplicate.
    writeTransaction(db, () => store.record(event));
    return ok(true);
  };
  const service: Handler = (c) => {
    if (!settings().enabled) {
      throw unavailable(c);
    }
    // Amazon SES is the instance's route (B142, src/bounces/ses-route.ts): on a project's own host
    // it is a service this route does not know.
    throw unknownService(c);
  };
  router.route("GET", "/api/bounces", collection, auth.middleware("bounces:get"));
  router.route("PUT", "/api/bounces/blocklist", blocklist, auth.middleware("bounces:manage"));
  router.route("GET", "/api/bounces/:id", one, auth.middleware("bounces:get"), hasID);
  router.route("DELETE", "/api/bounces", remove, auth.middleware("bounces:manage"));
  router.route("DELETE", "/api/bounces/:id", removeOne, auth.middleware("bounces:manage"), hasID);
  router.route(
    "GET",
    "/api/subscribers/:id/bounces",
    ofSubscriber,
    auth.middleware("bounces:get"),
    hasID,
  );
  router.route(
    "DELETE",
    "/api/subscribers/:id/bounces",
    removeOfSubscriber,
    auth.middleware("bounces:manage"),
    hasID,
  );
  router.route(
    "POST",
    "/webhooks/bounce",
    native,
    webhooksEnabled,
    auth.middleware("webhooks:post_bounce"),
  );
  router.route("POST", "/webhooks/service/:service", service, webhooksEnabled, deps.limit);
}
