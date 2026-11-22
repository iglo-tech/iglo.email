// Native webhook configuration API (docs/design/07-api-and-ui.md). Every route needs
// `webhooks:manage`; writes are revalidated inside their write transaction.
import { writeTransaction } from "@/db/transaction";
import { parseJson, readBounded } from "@/events/input";
import type { RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { Authentication } from "@/users/auth";
import { generateSecret, MAX_WEBHOOKS, webhookEvents } from "@/webhooks/store";
import type { WebhookInput, WebhookStore } from "@/webhooks/store";

const MANAGE = "webhooks:manage";
const BODY_BYTES = 16 * 1024;
const MAX_URL = 2048;
const MIN_SECRET = 16;
const MAX_SECRET = 256;
/** A rotation's old secret signs this long unless the body says otherwise (D130). */
const DEFAULT_OVERLAP_HOURS = 24;
const MAX_OVERLAP_HOURS = 168;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (c: RequestContext, name: string) =>
  new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFields", "name", name));
const body = async (c: RequestContext) => {
  const value = parseJson(c.request, await readBounded(c.request, BODY_BYTES));
  if (!isObject(value)) {
    throw invalid(c, "body");
  }
  return value;
};
const validUrl = (c: RequestContext, value: unknown) => {
  // The URL parser drops tabs and newlines, so the raw text is checked too.
  if (
    typeof value !== "string" ||
    value.length > MAX_URL ||
    // oxlint-disable-next-line no-control-regex
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid(c, "url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(c, "url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw invalid(c, "url");
  }
  return value;
};
const validEvents = (c: RequestContext, value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (event): event is string =>
        typeof event === "string" && webhookEvents.some((name) => name === event),
    )
  ) {
    throw invalid(c, "events");
  }
  return [...new Set(value)];
};
/**
 * The optional body of a rotation: nothing, or a JSON object whose only key is `overlap_hours`. The
 * new secret is generated here, so a supplied `secret` is refused, as PUT refuses it (D130).
 */
const rotation = async (c: RequestContext) => {
  const bytes = await readBounded(c.request, BODY_BYTES);
  if (!bytes.length) {
    return {};
  }
  const value = parseJson(c.request, bytes);
  if (!isObject(value)) {
    throw invalid(c, "body");
  }
  const unknown = Object.keys(value).find((key) => key !== "overlap_hours");
  if (unknown !== undefined) {
    throw invalid(c, unknown);
  }
  return value;
};
const validOverlap = (c: RequestContext, value: unknown) => {
  if (value === undefined) {
    return DEFAULT_OVERLAP_HOURS;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_OVERLAP_HOURS
  ) {
    throw invalid(c, "overlap_hours");
  }
  return value;
};
const validEnabled = (c: RequestContext, value: unknown) => {
  if (typeof value !== "boolean") {
    throw invalid(c, "enabled");
  }
  return value;
};
const paging = (c: RequestContext) => {
  const value = (name: string, fallback: number, max: number) => {
    const values = c.url.searchParams.getAll(name);
    if (!values.length) {
      return fallback;
    }
    const first = values[0];
    const number = first !== undefined && /^[1-9]\d{0,6}$/.test(first) ? Number(first) : 0;
    if (values.length > 1 || number < 1 || number > max) {
      throw invalid(c, name);
    }
    return number;
  };
  return { page: value("page", 1, 1_000_000), perPage: value("per_page", 20, 100) };
};
export function registerWebhookRoutes(
  router: Router,
  deps: { webhooks: WebhookStore; auth: Authentication },
) {
  const { webhooks, auth } = deps;
  const exists = (id: bigint) => {
    if (!webhooks.get(id)) {
      throw new HttpError(404, "Webhook not found");
    }
  };

  router.route(
    "GET",
    "/api/webhooks",
    (c) => {
      const { page, perPage } = paging(c);
      return ok(webhooks.list(page, perPage));
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "POST",
    "/api/webhooks",
    async (c) => {
      const value = await body(c);
      const input: WebhookInput = {
        url: validUrl(c, value.url),
        events: validEvents(c, value.events),
        enabled: value.enabled === undefined ? true : validEnabled(c, value.enabled),
      };
      const supplied = value.secret;
      if (
        supplied !== undefined &&
        (typeof supplied !== "string" ||
          Buffer.byteLength(supplied) < MIN_SECRET ||
          Buffer.byteLength(supplied) > MAX_SECRET)
      ) {
        throw invalid(c, "secret");
      }
      const secret = supplied ?? generateSecret();
      const created = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return webhooks.create(input, secret);
      });
      if (!created) {
        throw new HttpError(400, `At most ${MAX_WEBHOOKS} webhooks can be configured.`);
      }
      // The only response that holds the secret.
      return ok(created);
    },
    auth.middleware(MANAGE),
  );
  router.route(
    "PUT",
    "/api/webhooks/:id",
    async (c) => {
      const id = BigInt(getID(c));
      const value = await body(c);
      // A secret is changed by its own route (rotate-secret, D130); here it would be ignored.
      if (value.secret !== undefined) {
        throw invalid(c, "secret");
      }
      const url = value.url === undefined ? undefined : validUrl(c, value.url),
        events = value.events === undefined ? undefined : validEvents(c, value.events),
        enabled = value.enabled === undefined ? undefined : validEnabled(c, value.enabled);
      const updated = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        const current = webhooks.get(id);
        if (!current) {
          throw new HttpError(404, "Webhook not found");
        }
        return webhooks.update(id, {
          url: url ?? current.url,
          events: events ?? current.events,
          enabled: enabled ?? current.enabled,
        });
      });
      return ok(updated);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "POST",
    "/api/webhooks/:id/rotate-secret",
    async (c) => {
      const id = BigInt(getID(c));
      const value = await rotation(c);
      const overlapHours = validOverlap(c, value.overlap_hours);
      const secret = generateSecret();
      const rotated = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return webhooks.rotate(id, secret, overlapHours);
      });
      if (!rotated) {
        throw new HttpError(404, "Webhook not found");
      }
      // The only other answer that holds a secret is the one that creates the webhook.
      return ok({ ...rotated, secret });
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "DELETE",
    "/api/webhooks/:id",
    (c) => {
      const id = BigInt(getID(c));
      const removed = writeTransaction(c.app.db, () => {
        auth.revalidate(c, MANAGE);
        return webhooks.remove(id);
      });
      if (!removed) {
        throw new HttpError(404, "Webhook not found");
      }
      return ok(true);
    },
    auth.middleware(MANAGE),
    hasID,
  );
  router.route(
    "GET",
    "/api/webhooks/:id/deliveries",
    (c) => {
      const id = BigInt(getID(c));
      const { page, perPage } = paging(c);
      exists(id);
      // Payloads stay out: this permission does not imply access to subscribers.
      return ok(webhooks.deliveries(id, page, perPage));
    },
    auth.middleware(MANAGE),
    hasID,
  );
}
