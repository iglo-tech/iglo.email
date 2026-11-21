// A manual or test enrollment of a subscriber the caller cannot read (D103) starts nothing, so the
// scheduler sends no mail for it, while the same caller's enrollment of a readable subscriber is
// delivered. Through the HTTP API, the real scheduler and the SMTP sink, on the injected clock.
import { afterEach, expect, test } from "bun:test";
import { minute, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";

const fixtures: Array<SchedulerFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}
const absent = { status: 404, body: { message: "Subscriber not found" } };

/** An API user that manages sequences and reads subscribers on one list. Returns its requests. */
async function scopedCaller(f: SchedulerFixture, list: number) {
  const role = await f.json("/api/roles/users", "POST", {
    name: "enroll-scope",
    permissions: ["sequences:manage", "subscribers:get"],
  });
  const listRole = await f.json("/api/roles/lists", "POST", {
    name: "enroll-scope-lists",
    lists: [{ id: list, permissions: ["list:get"] }],
  });
  const user = await f.json("/api/users", "POST", {
    username: "enroll-scope",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
    list_role_id: listRole.body.data.id,
  });
  if (user.status !== 200) {
    throw new Error(JSON.stringify(user.body));
  }
  const authorization = `Basic ${btoa(`enroll-scope:${user.body.data.password}`)}`;
  return async (path: string, body: unknown) => {
    const response = await f.request(path, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

test("D103: a refused enrollment sends no mail; the same caller's allowed one is delivered", async () => {
  const f = await open();
  const a = await f.list("a");
  const b = await f.list("b");
  const template = await f.template("<p>Hello {{ subscriber.name }}</p>", "Scoped hello");
  // Events are recorded before the sequence exists, so they start nothing.
  const onB = await f.subscriber("on-b@example.test", { lists: [b] });
  const paid = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: "on-b@example.test", name: "B" },
    name: "order_paid",
  });
  expect(paid.status).toBe(200);
  const sequence = await f.sequence({
    steps: [{ wait: "PT0S", kind: "transactional", template_id: template }],
  });
  const onA = await f.subscriber("on-a@example.test", { lists: [a] });
  const caller = await scopedCaller(f, a);
  const base = { sequence_id: sequence.id };

  const refused = [
    { subscriber_id: onB, test: true },
    { subscriber_id: onB },
    { subscriber_id: onB, test: true, trigger_event_id: paid.body.data.event_id },
  ];
  for (const body of refused) {
    expect(await caller("/api/enrollments", { ...base, ...body })).toEqual(absent);
  }

  // The scheduler is driven past every wait and due time; none of the refusals left a send.
  await f.pass(0);
  await f.pass(minute);
  expect(await f.sendLog()).toEqual([]);
  expect(f.sink.messages).toHaveLength(0);

  // The positive control: the same caller's enrollment of a subscriber on its list is delivered
  // by the same scheduler, so the empty result above is not a stalled pipeline.
  const allowed = await caller("/api/enrollments", { ...base, subscriber_id: onA, test: true });
  expect(allowed.status).toBe(200);
  await f.until(() => f.sink.messages.length === 1, "one delivery");
  expect(f.sink.messages[0]!.to).toEqual(["on-a@example.test"]);
  await f.pass(0);
  expect((await f.sendLog()).map((s) => s.subscriber_id)).toEqual([onA]);
  expect(f.sink.messages).toHaveLength(1);
});
