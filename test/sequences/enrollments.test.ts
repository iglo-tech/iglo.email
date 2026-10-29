// Triggers, exits, reentry and the enrollments API from docs/design/05-sequences.md
// (Events API steps 2-3, Sequence definition) and 04-sending.md#unsubscribe, through
// POST /api/subscriber-events, /api/enrollments, the subscriber API and the public
// unsubscribe endpoint.
import { afterEach, expect, test } from "bun:test";
import { sequencesFixture, type SequencesFixture } from "@/test/sequences/fixture";

const fixtures: SequencesFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await sequencesFixture();
  fixtures.push(f);
  return f;
}
const day = 86_400_000;

async function sequence(f: SequencesFixture, extra: object = {}, status = "active") {
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "Onboarding",
    status,
    trigger: { event: "order_paid" },
    exit_on: ["subscription_created"],
    reentry: "never",
    steps: [
      { wait: "PT1H", kind: "transactional", template_id: tx },
      { wait: "P3D", kind: "transactional", template_id: tx },
    ],
    ...extra,
  });
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  return created.body.data as { id: number; steps: { id: number }[] };
}
const enrollments = async (f: SequencesFixture, query = "") =>
  (await f.json(`/api/enrollments${query}`)).body.data.results as Record<string, any>[];
const paid = (email: string, extra: object = {}) => ({
  subscriber: { email },
  name: "order_paid",
  ...extra,
});

test("a matching event starts an enrollment at the first step, due occurred_at + wait", async () => {
  const f = await open();
  const seq = await sequence(f);
  const draft = await sequence(f, {}, "draft");
  const paused = await sequence(f, {}, "active");
  await f.json(`/api/sequences/${paused.id}/status`, "PUT", { status: "paused" });
  const occurred = new Date(f.clock.now().getTime() - 2 * day).toISOString();
  const r = await f.event(paid("ana@example.test", { occurred_at: occurred }));
  expect(r.status).toBe(200);
  const [enrollment, ...rest] = await enrollments(f);
  expect(rest).toEqual([]);
  expect(r.body.data.enrollments).toEqual({
    started: [{ id: enrollment!.id, sequence_id: seq.id }],
    ended: [],
  });
  const now = f.clock.now().toISOString();
  expect(enrollment).toEqual({
    id: expect.any(Number),
    sequence_id: seq.id,
    subscriber_id: r.body.data.subscriber_id,
    trigger_event_id: r.body.data.event_id,
    step_id: seq.steps[0]!.id,
    due_at: new Date(Date.parse(occurred) + 3_600_000).toISOString(),
    status: "active",
    exit_reason: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  });
  expect((await f.json(`/api/enrollments/${enrollment!.id}`)).body.data).toEqual(enrollment);
  expect(draft.id).not.toBe(seq.id);
  // Other event names and events older than 7 days start nothing.
  expect((await f.event({ ...paid("bo@example.test"), name: "other" })).body.data.enrollments)
    .toEqual({ started: [], ended: [] });
  const old = new Date(f.clock.now().getTime() - 7 * day - 1).toISOString();
  expect((await f.event(paid("cy@example.test", { occurred_at: old }))).body.data.enrollments)
    .toEqual({ started: [], ended: [] });
  // Batch events trigger the same way.
  const batch = await f.json("/api/subscriber-events/batch", "POST", {
    events: [paid("d1@example.test"), paid("d2@example.test")],
  });
  expect(batch.body.data.results.map((x: any) => x.enrollments.started.length)).toEqual([1, 1]);
  expect(await enrollments(f, `?sequence_id=${seq.id}`)).toHaveLength(3);
  expect(await enrollments(f, `?sequence_id=${draft.id}`)).toHaveLength(0);
  expect(await enrollments(f, `?sequence_id=${paused.id}`)).toHaveLength(0);
});

test("trigger.where filters on event data and the subscriber after the event's upsert", async () => {
  const f = await open();
  const data = await sequence(f, {
    trigger: { event: "order_paid", where: { "data.product": "prepaid", "data.n": 2 } },
  });
  const attr = await sequence(f, {
    trigger: {
      event: "order_paid",
      where: {
        all: [
          { attr: "plan", op: "eq", value: "subscription" },
          { event: "order_paid", count: { gte: 2 } },
        ],
      },
    },
  });
  const started = async (body: object) =>
    ((await f.event(body)).body.data.enrollments.started as { sequence_id: number }[]).map(
      (s) => s.sequence_id,
    );
  expect(await started(paid("a@example.test", { data: { product: "prepaid", n: 2 } }))).toEqual([
    data.id,
  ]);
  expect(await started(paid("b@example.test", { data: { product: "prepaid", n: "2" } }))).toEqual(
    [],
  );
  expect(await started(paid("c@example.test", { data: { product: "prepaid" } }))).toEqual([]);
  // The attribute merged by this very event, and this event itself, are visible.
  expect(
    await started({
      ...paid("e@example.test"),
      subscriber: { email: "e@example.test", attribs: { plan: "subscription" } },
    }),
  ).toEqual([]);
  expect(
    await started({
      ...paid("e@example.test"),
      subscriber: { email: "e@example.test", attribs: { plan: "subscription" } },
    }),
  ).toEqual([attr.id]);
});

test("exit_on events end active enrollments before triggers, which can restart them", async () => {
  const f = await open();
  const exits = await sequence(f, { exit_on: ["subscription_created", "refund"] });
  const restart = await sequence(f, {
    trigger: { event: "subscription_created" },
    exit_on: ["subscription_created"],
    reentry: "after_exit",
  });
  const first = await f.event(paid("x@example.test"));
  const subscriber = first.body.data.subscriber_id;
  const created = await f.event({ subscriber: { email: "x@example.test" }, name: "subscription_created" });
  const exitedId = first.body.data.enrollments.started[0].id;
  const startedRestart = created.body.data.enrollments.started;
  expect(created.body.data.enrollments).toEqual({
    started: [{ id: expect.any(Number), sequence_id: restart.id }],
    ended: [{ id: exitedId, sequence_id: exits.id, exit_reason: "event:subscription_created" }],
  });
  const ended = (await f.json(`/api/enrollments/${exitedId}`)).body.data;
  expect(ended).toMatchObject({
    status: "exited",
    exit_reason: "event:subscription_created",
    step_id: null,
    due_at: null,
    finished_at: f.clock.now().toISOString(),
  });
  // The same event exits the running restart enrollment and starts a new one.
  f.clock.advance(1000);
  const again = await f.event({ subscriber: { email: "x@example.test" }, name: "subscription_created" });
  expect(again.body.data.enrollments).toEqual({
    started: [{ id: expect.any(Number), sequence_id: restart.id }],
    ended: [
      { id: startedRestart[0].id, sequence_id: restart.id, exit_reason: "event:subscription_created" },
    ],
  });
  const active = await enrollments(f, `?subscriber_id=${subscriber}&status=active`);
  expect(active.map((e) => e.sequence_id)).toEqual([restart.id]);
  // Exits apply only to active sequences.
  await f.json(`/api/sequences/${exits.id}/status`, "PUT", { status: "paused" });
  await f.event(paid("y@example.test"));
  const paused = await f.event({ subscriber: { email: "y@example.test" }, name: "refund" });
  expect(paused.body.data.enrollments.ended).toEqual([]);
});

test("reentry never, after_exit and always", async () => {
  const f = await open();
  const never = await sequence(f, { reentry: "never" });
  const afterExit = await sequence(f, { reentry: "after_exit" });
  const always = await sequence(f, { reentry: "always" });
  const send = async (name = "order_paid") =>
    (await f.event({ subscriber: { email: "r@example.test" }, name })).body.data.enrollments;
  const ids = (list: { sequence_id: number }[]) => list.map((e) => e.sequence_id).sort();
  const first = await send();
  expect(ids(first.started)).toEqual([never.id, afterExit.id, always.id].sort());
  // While running: never and after_exit do nothing; always replaces the running one.
  const second = await send();
  expect(ids(second.started)).toEqual([always.id]);
  const replaced = first.started.find((e: any) => e.sequence_id === always.id);
  expect(second.ended).toEqual([
    { id: replaced.id, sequence_id: always.id, exit_reason: "event:order_paid" },
  ]);
  // After an exit: never stays out forever, after_exit starts again.
  await send("subscription_created");
  const third = await send();
  expect(ids(third.started)).toEqual([afterExit.id, always.id].sort());
  const all = await enrollments(f, "?per_page=100");
  expect(all.filter((e) => e.status === "active").map((e) => e.sequence_id).sort()).toEqual(
    [afterExit.id, always.id].sort(),
  );
  expect(all.filter((e) => e.sequence_id === never.id)).toHaveLength(1);
});

test("a repeated idempotency key replays the first {started, ended} and changes nothing", async () => {
  const f = await open();
  const seq = await sequence(f, { reentry: "always" });
  const body = paid("k@example.test", { idempotency_key: "evt_1" });
  const first = await f.event(body);
  expect(first.body.data.enrollments.started).toHaveLength(1);
  const second = await f.event({ ...paid("k@example.test"), idempotency_key: "evt_2" });
  expect(second.body.data.enrollments.ended).toHaveLength(1);
  const before = await enrollments(f);
  f.clock.advance(1000);
  expect(await f.event(body)).toEqual(first);
  expect(await f.event({ ...paid("k@example.test"), idempotency_key: "evt_2" })).toEqual(second);
  expect(await enrollments(f)).toEqual(before);
  // Without changes there is nothing to replay but the empty result.
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "paused" });
  const quiet = paid("k@example.test", { idempotency_key: "evt_3" });
  expect((await f.event(quiet)).body.data.enrollments).toEqual({ started: [], ended: [] });
  expect((await f.event(quiet)).body.data.enrollments).toEqual({ started: [], ended: [] });
});

test("blocklisted subscribers are never enrolled; blocklisting exits every active enrollment", async () => {
  const f = await open();
  const a = await sequence(f);
  const b = await sequence(f, { trigger: { event: "signup" } });
  const id = (await f.event(paid("bl@example.test"))).body.data.subscriber_id;
  await f.event({ subscriber: { email: "bl@example.test" }, name: "signup" });
  const other = (await f.event(paid("keep@example.test"))).body.data.subscriber_id;
  expect(await enrollments(f, "?status=active")).toHaveLength(3);
  expect((await f.json(`/api/subscribers/${id}/blocklist`, "PUT")).status).toBe(200);
  const exited = await enrollments(f, `?subscriber_id=${id}`);
  expect(exited.map((e) => [e.sequence_id, e.status, e.exit_reason]).sort()).toEqual(
    [
      [a.id, "exited", "blocklisted"],
      [b.id, "exited", "blocklisted"],
    ].sort(),
  );
  expect(await enrollments(f, `?subscriber_id=${other}&status=active`)).toHaveLength(1);
  // Blocklisted subscribers are not enrolled by events or manually.
  const c = await sequence(f, { trigger: { event: "later" }, reentry: "always" });
  const r = await f.event({ subscriber: { email: "bl@example.test" }, name: "later" });
  expect(r.body.data.enrollments.started).toEqual([]);
  const manual = await f.json("/api/enrollments", "POST", { sequence_id: c.id, subscriber_id: id });
  expect(manual.status).toBe(409);

  // Bulk, by-query and status-update blocklisting do the same, atomically with the change.
  const ids: number[] = [];
  for (const email of ["q1@example.test", "q2@example.test", "q3@example.test"])
    ids.push((await f.event(paid(email))).body.data.subscriber_id);
  expect(
    (await f.json("/api/subscribers/blocklist", "PUT", { ids: [ids[0]] })).status,
  ).toBe(200);
  expect(
    (
      await f.json("/api/subscribers/query/blocklist", "PUT", {
        query: "subscribers.email = 'q2@example.test'",
      })
    ).status,
  ).toBe(200);
  const s3 = (await f.json(`/api/subscribers/${ids[2]}`)).body.data;
  expect(
    (
      await f.json(`/api/subscribers/${ids[2]}`, "PUT", {
        email: s3.email,
        name: s3.name,
        status: "blocklisted",
      })
    ).status,
  ).toBe(200);
  for (const s of ids) {
    const [e] = await enrollments(f, `?subscriber_id=${s}`);
    expect([e!.status, e!.exit_reason]).toEqual(["exited", "blocklisted"]);
  }
});

test("unsubscribing exits enrollments of sequences tied to those lists only", async () => {
  const f = await open();
  const tx = await f.template();
  const news = await f.list("news");
  const promo = await f.list("promo");
  const marketing = (list: number, event: string) =>
    sequence(f, {
      trigger: { event },
      list_id: list,
      steps: [{ wait: "P1D", kind: "marketing", template_id: tx }],
    });
  const onNews = await marketing(news, "go");
  const onPromo = await marketing(promo, "go");
  const plain = await sequence(f, { trigger: { event: "go" } });
  const start = async (email: string) => {
    const id = await f.subscriber(email, { lists: [news, promo] });
    await f.event({ subscriber: { email }, name: "go" });
    return id;
  };
  const states = async (id: number) =>
    Object.fromEntries(
      (await enrollments(f, `?subscriber_id=${id}`)).map((e) => [
        e.sequence_id,
        `${e.status}:${e.exit_reason}`,
      ]),
    );
  // Admin unsubscribe action.
  const one = await start("u1@example.test");
  expect(
    (
      await f.json("/api/subscribers/lists", "PUT", {
        ids: [one],
        action: "unsubscribe",
        target_list_ids: [news],
      })
    ).status,
  ).toBe(200);
  expect(await states(one)).toEqual({
    [onNews.id]: "exited:unsubscribed",
    [onPromo.id]: "active:null",
    [plain.id]: "active:null",
  });
  // By-query list unsubscribe.
  const two = await start("u2@example.test");
  expect(
    (
      await f.json("/api/subscribers/query/lists", "PUT", {
        query: "subscribers.email = 'u2@example.test'",
        action: "unsubscribe",
        target_list_ids: [promo],
      })
    ).status,
  ).toBe(200);
  expect(await states(two)).toMatchObject({
    [onNews.id]: "active:null",
    [onPromo.id]: "exited:unsubscribed",
  });
  // The public unsubscribe link of a marketing send for the news list.
  const three = await start("u3@example.test");
  const uuid = (await f.json(`/api/subscribers/${three}`)).body.data.uuid;
  const sent = await f.json("/api/tx", "POST", {
    subscriber_id: three,
    template_id: tx,
    kind: "marketing",
    list_id: news,
  });
  expect(sent.status).toBe(200);
  const sendUuid = sent.body.data.sends[0].uuid;
  const unsub = await f.request(`/m/${sendUuid}/unsubscribe/${uuid}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(unsub.status).toBe(200);
  expect(await states(three)).toEqual({
    [onNews.id]: "exited:unsubscribed",
    [onPromo.id]: "active:null",
    [plain.id]: "active:null",
  });
  // Unsubscribing with blocklist ends every active enrollment as blocklisted.
  const four = await start("u4@example.test");
  const uuid4 = (await f.json(`/api/subscribers/${four}`)).body.data.uuid;
  const sent4 = await f.json("/api/tx", "POST", {
    subscriber_id: four,
    template_id: tx,
    kind: "marketing",
    list_id: promo,
  });
  const block = await f.request(`/m/${sent4.body.data.sends[0].uuid}/unsubscribe/${uuid4}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "blocklist=true",
  });
  expect(block.status).toBe(200);
  expect(Object.values(await states(four))).toEqual([
    "exited:blocklisted",
    "exited:blocklisted",
    "exited:blocklisted",
  ]);
});

test("manual enroll respects reentry unless forced; cancel ends with manual", async () => {
  const f = await open();
  const never = await sequence(f, { reentry: "never" });
  const always = await sequence(f, { reentry: "always" });
  const draft = await sequence(f, {}, "draft");
  const id = await f.subscriber("m@example.test");
  const enroll = (body: object) => f.json("/api/enrollments", "POST", body);
  const first = await enroll({ sequence_id: never.id, subscriber_id: id });
  expect(first.status).toBe(200);
  expect(first.body.data).toMatchObject({
    sequence_id: never.id,
    subscriber_id: id,
    trigger_event_id: null,
    step_id: never.steps[0]!.id,
    due_at: new Date(f.clock.now().getTime() + 3_600_000).toISOString(),
    status: "active",
  });
  expect((await enroll({ sequence_id: never.id, subscriber_id: id })).status).toBe(409);
  const cancel = await f.json(`/api/enrollments/${first.body.data.id}`, "DELETE");
  expect(cancel.status).toBe(200);
  expect(cancel.body.data).toMatchObject({
    status: "canceled",
    exit_reason: "manual",
    step_id: null,
    due_at: null,
    finished_at: f.clock.now().toISOString(),
  });
  expect((await f.json(`/api/enrollments/${first.body.data.id}`, "DELETE")).status).toBe(409);
  expect((await enroll({ sequence_id: never.id, subscriber_id: id })).status).toBe(409);
  const forced = await enroll({ sequence_id: never.id, subscriber_id: id, force: true });
  expect(forced.status).toBe(200);
  // Forcing over a running enrollment replaces it.
  const forced2 = await enroll({ sequence_id: never.id, subscriber_id: id, force: true });
  expect(forced2.status).toBe(200);
  expect((await f.json(`/api/enrollments/${forced.body.data.id}`)).body.data).toMatchObject({
    status: "canceled",
    exit_reason: "manual",
  });
  const a1 = await enroll({ sequence_id: always.id, subscriber_id: id });
  const a2 = await enroll({ sequence_id: always.id, subscriber_id: id });
  expect([a1.status, a2.status]).toEqual([200, 200]);
  expect((await f.json(`/api/enrollments/${a1.body.data.id}`)).body.data.status).toBe("canceled");
  // Unknown or inactive targets and malformed input.
  expect((await enroll({ sequence_id: draft.id, subscriber_id: id })).status).toBe(409);
  expect((await enroll({ sequence_id: 9999, subscriber_id: id })).status).toBe(404);
  expect((await enroll({ sequence_id: never.id, subscriber_id: 9999 })).status).toBe(404);
  for (const bad of [
    {},
    { sequence_id: "1", subscriber_id: id },
    { sequence_id: never.id, subscriber_id: -1 },
    { sequence_id: never.id, subscriber_id: id, force: "yes" },
    { sequence_id: 1.5, subscriber_id: id },
  ])
    expect((await enroll(bad)).status).toBe(400);
  expect((await f.json("/api/enrollments", "POST", "[1]")).status).toBe(400);
  expect((await f.json("/api/enrollments/9999")).status).toBe(404);
  expect((await f.json("/api/enrollments/9999", "DELETE")).status).toBe(404);
  expect((await f.json("/api/enrollments/x")).status).toBe(400);
  expect(
    (await enrollments(f, `?subscriber_id=${id}&status=active`)).map((e) => e.sequence_id).sort(),
  ).toEqual([never.id, always.id].sort());
});

test("enrollment list filters, paging and permissions", async () => {
  const f = await open();
  const a = await sequence(f, { reentry: "always" });
  for (let i = 0; i < 3; i++) await f.event(paid("p@example.test"));
  const all = await f.json("/api/enrollments?per_page=2");
  expect(all.body.data).toMatchObject({ total: 3, page: 1, per_page: 2 });
  expect(all.body.data.results).toHaveLength(2);
  expect(all.body.data.results[0].id).toBeGreaterThan(all.body.data.results[1].id);
  expect((await enrollments(f, "?status=exited&exit_reason=event:order_paid")).length).toBe(2);
  expect((await enrollments(f, `?sequence_id=${a.id}&status=active`)).length).toBe(1);
  for (const bad of [
    "?status=done",
    "?per_page=0",
    "?per_page=101",
    "?page=x",
    "?sequence_id=0",
    "?subscriber_id=-2",
    "?status=active&status=exited",
    `?exit_reason=${"x".repeat(300)}`,
  ])
    expect((await f.json(`/api/enrollments${bad}`)).status).toBe(400);
  const reader = await f.apiUser(["sequences:get"]);
  const none = await f.apiUser(["subscribers:get_all"]);
  const id = all.body.data.results[0].id;
  expect((await f.json("/api/enrollments", "GET", undefined, reader)).status).toBe(200);
  expect((await f.json(`/api/enrollments/${id}`, "GET", undefined, reader)).status).toBe(200);
  expect((await f.json("/api/enrollments", "GET", undefined, none)).status).toBe(403);
  const sub = all.body.data.results[0].subscriber_id;
  expect(
    (await f.json("/api/enrollments", "POST", { sequence_id: a.id, subscriber_id: sub }, reader))
      .status,
  ).toBe(403);
  expect((await f.json(`/api/enrollments/${id}`, "DELETE", undefined, reader)).status).toBe(403);
  expect((await f.json(`/api/enrollments/${id}`)).body.data.status).toBe("active");
});

test("concurrent triggers and manual enrolls never create two active enrollments", async () => {
  const f = await open();
  const always = await sequence(f, { reentry: "always" });
  const afterExit = await sequence(f, { reentry: "after_exit" });
  const id = await f.subscriber("race@example.test");
  const work: Promise<{ status: number }>[] = [];
  for (let i = 0; i < 20; i++) {
    work.push(f.event(paid("race@example.test")));
    work.push(f.json("/api/enrollments", "POST", { sequence_id: always.id, subscriber_id: id }));
    work.push(
      f.json("/api/enrollments", "POST", { sequence_id: afterExit.id, subscriber_id: id }),
    );
  }
  const statuses = (await Promise.all(work)).map((r) => r.status);
  expect(statuses.filter((s) => s !== 200 && s !== 409)).toEqual([]);
  const active = await enrollments(f, `?subscriber_id=${id}&status=active&per_page=100`);
  expect(active.map((e) => e.sequence_id).sort()).toEqual([always.id, afterExit.id].sort());
});

test("archiving exits active enrollments; archived sequences no longer trigger", async () => {
  const f = await open();
  const seq = await sequence(f, { reentry: "always" });
  const id = (await f.event(paid("arc@example.test"))).body.data.subscriber_id;
  const archived = await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "archived" });
  expect(archived.status).toBe(200);
  expect(archived.body.data.active_enrollments).toBe(0);
  const [e] = await enrollments(f, `?subscriber_id=${id}`);
  expect([e!.status, e!.exit_reason]).toEqual(["exited", "sequence_archived"]);
  expect((await f.event(paid("arc@example.test"))).body.data.enrollments.started).toEqual([]);
  // Archiving through a definition update does the same.
  await f.json(`/api/sequences/${seq.id}/status`, "PUT", { status: "active" });
  await f.event(paid("arc@example.test"));
  const def = (await f.json(`/api/sequences/${seq.id}`)).body.data;
  const put = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    ...def,
    status: "archived",
    steps: def.steps.map((s: any) => ({ ...s })),
  });
  expect(put.status).toBe(200);
  expect(await enrollments(f, "?status=active")).toEqual([]);
});

test("deleting a subscriber deletes its enrollments", async () => {
  const f = await open();
  const seq = await sequence(f);
  const id = (await f.event(paid("del@example.test"))).body.data.subscriber_id;
  const keep = (await f.event(paid("keep@example.test"))).body.data.subscriber_id;
  expect((await f.json(`/api/subscribers/${id}`, "DELETE")).status).toBe(200);
  const rest = await enrollments(f);
  expect(rest.map((e) => e.subscriber_id)).toEqual([keep]);
  // With no enrollments left at all the sequence may be deleted.
  await f.json(`/api/subscribers/${keep}`, "DELETE");
  expect((await f.json(`/api/sequences/${seq.id}`, "DELETE")).status).toBe(200);
});
