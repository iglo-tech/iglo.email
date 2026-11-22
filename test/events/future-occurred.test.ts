// D124: an event whose occurred_at is more than 15 minutes ahead of the server clock is refused
// with 400 "Invalid fields: occurred_at", single and per batch item, and writes nothing (its
// idempotency key is not consumed). Within the skew it is accepted as given. Through HTTP, with the
// injected clock.
import { afterEach, expect, test } from "bun:test";
import { eventsFixture } from "@/test/events/fixture";
import type { EventsFixture } from "@/test/events/fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";

const fixtures: Array<EventsFixture> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close();
  }
});
async function open() {
  const f = await eventsFixture();
  fixtures.push(f);
  return f;
}
const minute = 60_000;
const event = (email: string, extra: JsonObject = {}) => ({
  subscriber: { email },
  name: "order_paid",
  ...extra,
});
const ahead = (f: EventsFixture, milliseconds: number) =>
  new Date(f.clock.now().getTime() + milliseconds).toISOString();
const refusal = { status: 400, message: "Invalid fields: occurred_at", code: "invalid_fields" };

test("an event 14 minutes and exactly 15 minutes ahead is accepted as given", async () => {
  const f = await open();
  for (const [email, at] of [
    ["fourteen@example.test", ahead(f, 14 * minute)],
    ["fifteen@example.test", ahead(f, 15 * minute)],
  ] as const) {
    const r = await f.post(event(email, { occurred_at: at }));
    expect(r.status).toBe(200);
    const stored = f.events.list(BigInt(r.body.data.subscriber_id));
    expect(stored.map((row) => row.occurred_at)).toEqual([at]);
  }
});

test("an event 16 minutes ahead is refused with 400, writes nothing and keeps its idempotency key", async () => {
  const f = await open();
  const refused = await f.post(
    event("sixteen@example.test", {
      occurred_at: ahead(f, 16 * minute),
      idempotency_key: "future-key",
    }),
  );
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ message: refusal.message, code: refusal.code });
  // Nothing was written: no subscriber and no event.
  expect(f.count("subscribers")).toBe(0);
  expect(f.count("events")).toBe(0);

  // The same key with a valid time is a first request, not a replay of the refusal.
  const now = f.clock.now().toISOString();
  const accepted = await f.post(
    event("sixteen@example.test", { occurred_at: now, idempotency_key: "future-key" }),
  );
  expect(accepted.status).toBe(200);
  const stored = f.events.list(BigInt(accepted.body.data.subscriber_id));
  expect(stored.map((row) => row.occurred_at)).toEqual([now]);
});

test("a batch refuses only its too-far-ahead item and writes the others", async () => {
  const f = await open();
  const near = ahead(f, 14 * minute);
  const far = ahead(f, 15 * minute + 1);
  const r = await f.batch({
    events: [
      event("batch-near@example.test", { occurred_at: near }),
      event("batch-far@example.test", { occurred_at: far }),
      event("batch-now@example.test"),
    ],
  });
  expect(r.status).toBe(200);
  const [first, second, third] = asBody<Array<JsonObject>>(r.body.data.results);
  expect(first).toMatchObject({ status: 200 });
  expect(second).toMatchObject(refusal);
  expect(third).toMatchObject({ status: 200 });

  expect(f.count("subscribers")).toBe(2);
  expect(f.count("events")).toBe(2);
  const nearId = BigInt(asBody<number>(first!.subscriber_id));
  expect(f.events.list(nearId).map((row) => row.occurred_at)).toEqual([near]);
});
