// Native subscriber events API (docs/design/05-sequences.md#events-api,
// 07-api-and-ui.md); no upstream endpoint.
import type { RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import {
  BATCH_BODY_BYTES,
  batchItems,
  EventInputError,
  eventInput,
  parseJson,
  readBounded,
  SINGLE_BODY_BYTES,
  type EventInput,
} from "@/events/input";
import type { EventStore, EventResult } from "@/events/store";
import type { Authentication } from "@/users/auth";

const PERMISSION = "subscriber_events:create";
/** Concurrent batch bodies being read and parsed, bounding request memory. */
const MAX_BATCHES_IN_FLIGHT = 4;
/** Single-event requests admitted until their commit settles; excess requests get 429. */
export const MAX_SINGLES_IN_FLIGHT = 1000;

export function registerEventRoutes(router: Router, store: EventStore, auth: Authentication) {
  const invalid = (c: RequestContext, field: string) =>
    new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFields", "name", field));
  const item = (c: RequestContext, value: unknown): EventInput | HttpError => {
    try {
      return eventInput(value);
    } catch (error) {
      if (error instanceof EventInputError) return invalid(c, error.field);
      throw error;
    }
  };
  const respond = (r: EventResult) => {
    if (r.status !== 200) throw new HttpError(r.status, "message" in r ? r.message : "");
    const { status: _status, ...data } = r as Extract<EventResult, { status: 200 }>;
    return ok(data);
  };
  let singles = 0;
  router.route(
    "POST",
    "/api/subscriber-events",
    async (c) => {
      const receivedAt = c.app.clock.now();
      // Reserve before reading the body so overload is shed instead of buffered.
      if (singles >= MAX_SINGLES_IN_FLIGHT) throw new HttpError(429, "Too many requests");
      singles++;
      try {
        const body = await readBounded(c.request, SINGLE_BODY_BYTES);
        const input = item(c, parseJson(c.request, body));
        if (input instanceof HttpError) throw input;
        return respond(await store.submit(input, receivedAt, () => auth.revalidate(c, PERMISSION)));
      } finally {
        singles--;
      }
    },
    auth.middleware(PERMISSION),
  );
  let batches = 0;
  router.route(
    "POST",
    "/api/subscriber-events/batch",
    async (c) => {
      const receivedAt = c.app.clock.now();
      if (batches >= MAX_BATCHES_IN_FLIGHT) throw new HttpError(429, "Too many requests");
      batches++;
      let items: Array<EventInput | HttpError>;
      try {
        const body = parseJson(c.request, await readBounded(c.request, BATCH_BODY_BYTES));
        let values: unknown[];
        try {
          values = batchItems(body);
        } catch (error) {
          if (error instanceof EventInputError) throw invalid(c, error.field);
          throw error;
        }
        items = values.map((value) => item(c, value));
      } finally {
        batches--;
      }
      const results = store.recordBatch(items, receivedAt, () => auth.revalidate(c, PERMISSION));
      return ok({ results });
    },
    auth.middleware(PERMISSION),
  );
}
