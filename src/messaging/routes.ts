// D53 native send-log routes; listmonk has no corresponding endpoints.
import type { Sends, SendFilter } from "@/messaging/sends";
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { refuseWhileHeld } from "@/settings/hold";
import { getID, hasID } from "@/server/validation";
import type { Roles } from "@/roles/roles";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";
import type { Scope } from "@/subscribers/store";
import type { RequestContext } from "@/server/context";

/**
 * Which sends a reader may see (B117d, D139). A reader with no list role has the global send-journal grant
 * (D53), as before. A list-scoped reader sees the sends to subscribers on its lists, by the rule a
 * subscriber read applies: the list read permission, and the list permission of the manage grant when
 * that covers no list.
 */
function readerScope(roles: Roles, context: RequestContext): Scope {
  const identity = context.identity;
  if (!identity) {
    throw new Error("Identity required");
  }
  if (identity.user.list_role_id === null) {
    return { all: true, ids: [] };
  }
  const get = roles.listScope(identity.role, identity.user.list_role_id, "list:get"),
    manage = roles.listScope(identity.role, identity.user.list_role_id, "list:manage");
  if (get.all || manage.all) {
    return { all: true, ids: [] };
  }
  return get.ids.length ? get : manage;
}

/** The refusal for a send the reader's list scope does not cover, named as a subscriber's is (B117d). */
const outOfScope = (context: RequestContext, id: bigint) =>
  new HttpError(
    403,
    context.app.i18n.Ts("globals.messages.permissionDenied", "name", `send: ${id}`),
  );

export function registerSendRoutes(
  router: Router,
  sends: Sends,
  auth: Authentication,
  roles: Roles,
) {
  router.route(
    "GET",
    "/api/sends",
    (context) => {
      const params = context.url.searchParams;
      function positive(key: string, limit: bigint): bigint | undefined {
        const values = params.getAll(key);
        if (!values.length) {
          return undefined;
        }
        const single = values[0];
        if (
          values.length !== 1 ||
          single === undefined ||
          !/^[1-9]\d*$/.test(single) ||
          single.length > 19
        ) {
          throw new HttpError(400);
        }
        const value = BigInt(single);
        if (value > limit) {
          throw new HttpError(400);
        }
        return value;
      }
      function choice(key: string, allowed: Array<string>): string | undefined {
        const values = params.getAll(key);
        if (!values.length) {
          return undefined;
        }
        const single = values[0];
        if (values.length !== 1 || single === undefined || !allowed.includes(single)) {
          throw new HttpError(400);
        }
        return values[0];
      }
      const filter: SendFilter = {
        page: Number(positive("page", 1_000_000n) ?? 1n),
        perPage: Number(positive("per_page", 100n) ?? 20n),
        scope: readerScope(roles, context),
      };
      const status = choice("status", [
          "queued",
          "sending",
          "sent",
          "failed",
          "skipped",
          "unknown",
        ]),
        kind = choice("kind", ["transactional", "marketing"]),
        source = choice("source", ["tx", "sequence"]),
        subscriberId = positive("subscriber_id", 9_223_372_036_854_775_807n),
        listId = positive("list_id", 9_223_372_036_854_775_807n);
      if (status !== undefined) {
        filter.status = status;
      }
      if (kind !== undefined) {
        filter.kind = kind;
      }
      if (source !== undefined) {
        filter.source = source;
      }
      if (subscriberId !== undefined) {
        filter.subscriberId = subscriberId;
      }
      if (listId !== undefined) {
        filter.listId = listId;
      }
      return ok(sends.list(filter));
    },
    auth.middleware("sends:get"),
  );
  router.route(
    "GET",
    "/api/sends/:id",
    (context) => {
      const id = BigInt(getID(context));
      const row = sends.get(id, readerScope(roles, context));
      if (row === null) {
        throw new HttpError(404);
      }
      if (row === "forbidden") {
        throw outOfScope(context, id);
      }
      return ok(row);
    },
    auth.middleware("sends:get"),
    hasID,
  );
  router.route(
    "POST",
    "/api/sends/:id/resend",
    async (context) => {
      refuseWhileHeld(context.app.db);
      const body = await readBody(context.request);
      if (
        body &&
        context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      ) {
        throw new HttpError(415);
      }
      if (body) {
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          throw new HttpError(400);
        }
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length
        ) {
          throw new HttpError(400);
        }
      }
      const id = BigInt(getID(context));
      const result = sends.resend(
        id,
        () => auth.revalidate(context, "sends:manage"),
        readerScope(roles, context),
      );
      if (result === "forbidden") {
        throw outOfScope(context, id);
      }
      return ok(result);
    },
    auth.middleware("sends:manage"),
    hasID,
  );
}
