// D53 native send-log routes; listmonk has no corresponding endpoints.
import type { Sends, SendFilter } from "@/messaging/sends";
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { getID, hasID } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { readBody } from "@/users/input";

export function registerSendRoutes(router: Router, sends: Sends, auth: Authentication) {
  router.route(
    "GET",
    "/api/sends",
    (context) => {
      const params = context.url.searchParams;
      function positive(key: string, limit: bigint): bigint | undefined {
        const values = params.getAll(key);
        if (!values.length) return undefined;
        if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]!) || values[0]!.length > 19)
          throw new HttpError(400);
        const value = BigInt(values[0]!);
        if (value > limit) throw new HttpError(400);
        return value;
      }
      function choice(key: string, allowed: string[]): string | undefined {
        const values = params.getAll(key);
        if (!values.length) return undefined;
        if (values.length !== 1 || !allowed.includes(values[0]!)) throw new HttpError(400);
        return values[0];
      }
      const filter: SendFilter = {
        page: Number(positive("page", 1000000n) ?? 1n),
        perPage: Number(positive("per_page", 100n) ?? 20n),
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
        subscriberId = positive("subscriber_id", 9223372036854775807n),
        listId = positive("list_id", 9223372036854775807n);
      if (status !== undefined) filter.status = status;
      if (kind !== undefined) filter.kind = kind;
      if (source !== undefined) filter.source = source;
      if (subscriberId !== undefined) filter.subscriberId = subscriberId;
      if (listId !== undefined) filter.listId = listId;
      return ok(sends.list(filter));
    },
    auth.middleware("sends:get"),
  );
  router.route(
    "GET",
    "/api/sends/:id",
    (context) => {
      const row = sends.get(BigInt(getID(context)));
      if (!row) throw new HttpError(404);
      return ok(row);
    },
    auth.middleware("sends:get"),
    hasID,
  );
  router.route(
    "POST",
    "/api/sends/:id/resend",
    async (context) => {
      const body = await readBody(context.request);
      if (
        body &&
        context.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new HttpError(415);
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
        )
          throw new HttpError(400);
      }
      return ok(
        sends.resend(BigInt(getID(context)), () => auth.revalidate(context, "sends:manage")),
      );
    },
    auth.middleware("sends:manage"),
    hasID,
  );
}
