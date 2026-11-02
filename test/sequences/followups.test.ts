// B5: rescheduling waiting enrollments after a wait changes, and live condition validation
// (docs/design/05-sequences.md#editing-and-rescheduling), through the HTTP API.
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
const hour = 3_600_000;

async function make(f: SequencesFixture) {
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "Follow",
    status: "active",
    trigger: { event: "order_paid" },
    exit_on: [],
    reentry: "never",
    steps: [
      { wait: "PT1H", kind: "transactional", template_id: tx },
      { wait: "P3D", kind: "transactional", template_id: tx },
    ],
  });
  expect(created.status).toBe(200);
  return {
    tx,
    seq: created.body.data as {
      id: number;
      steps: { id: number; wait: string }[];
    },
  };
}
const setWait = async (
  f: SequencesFixture,
  seq: Awaited<ReturnType<typeof make>>,
  wait: string,
) => {
  const full = (await f.json(`/api/sequences/${seq.seq.id}`)).body.data;
  full.steps[0].wait = wait;
  delete full.status;
  const saved = await f.json(`/api/sequences/${seq.seq.id}`, "PUT", full);
  expect(saved.status).toBe(200);
};
const dues = async (f: SequencesFixture) =>
  Object.fromEntries(
    ((await f.json("/api/enrollments")).body.data.results as Record<string, any>[]).map((e) => [
      e.subscriber_id,
      e.due_at as string,
    ]),
  );
const reschedule = (f: SequencesFixture, s: Awaited<ReturnType<typeof make>>, headers?: any) =>
  f.json(
    `/api/sequences/${s.seq.id}/steps/${s.seq.steps[0]!.id}/reschedule`,
    "POST",
    undefined,
    headers,
  );

test("a changed wait applies only on request: longer, then shorter, from the step's start", async () => {
  const f = await open();
  const s = await make(f);
  const a = await f.subscriber("a@example.test");
  await f.json("/api/enrollments", "POST", {
    sequence_id: s.seq.id,
    subscriber_id: a,
  });
  const start = f.clock.now().getTime();
  await setWait(f, s, "PT5H");
  expect((await dues(f))[a]).toBe(new Date(start + hour).toISOString());
  f.clock.advance(30 * 60_000);
  const longer = await reschedule(f, s);
  expect(longer.body.data).toEqual({ changed: 1 });
  expect((await dues(f))[a]).toBe(new Date(start + 5 * hour).toISOString());
  await setWait(f, s, "PT30M");
  expect((await reschedule(f, s)).body.data).toEqual({ changed: 1 });
  expect((await dues(f))[a]).toBe(new Date(start + 30 * 60_000).toISOString());
  // Nothing left to change.
  expect((await reschedule(f, s)).body.data).toEqual({ changed: 0 });
  // A due time in the past is "due now"; it stays in the past and nothing was sent.
  expect(f.sink.messages?.length ?? 0).toBe(0);
});

test("leased enrollments are untouched, and a test enrollment keeps its 1-minute cap", async () => {
  const f = await open();
  const s = await make(f);
  const a = await f.subscriber("claimed@example.test");
  const b = await f.subscriber("test@example.test");
  const c = await f.subscriber("plain@example.test");
  await f.json("/api/enrollments", "POST", {
    sequence_id: s.seq.id,
    subscriber_id: a,
  });
  await f.json("/api/enrollments", "POST", {
    sequence_id: s.seq.id,
    subscriber_id: c,
  });
  await f.json("/api/enrollments", "POST", {
    sequence_id: s.seq.id,
    subscriber_id: b,
    test: true,
  });
  const lease = new Date(f.clock.now().getTime() + 5 * 60_000).toISOString();
  f.db.run("UPDATE enrollments SET claimed_until = ? WHERE subscriber_id = ?", [lease, a]);
  const before = await dues(f);
  await setWait(f, s, "PT10H");
  expect((await reschedule(f, s)).body.data).toEqual({ changed: 1 });
  const after = await dues(f);
  expect(after[a]).toBe(before[a]);
  expect(after[b]).toBe(before[b]);
  expect(after[c]).toBe(new Date(Date.parse(before[c]!) - hour + 10 * hour).toISOString());
  // The cap holds for a test even with a longer wait.
  expect(Date.parse(after[b]!) - f.clock.now().getTime()).toBeLessThanOrEqual(60_000);
});

test("a large waiting set is done in batches and sends nothing", async () => {
  const f = await open();
  const s = await make(f);
  const now = f.clock.now().toISOString();
  const total = 1300;
  f.db.run("BEGIN");
  for (let i = 0; i < total; i++) {
    f.db.run("INSERT INTO subscribers (uuid, email, name, status) VALUES (?, ?, 'x', 'enabled')", [
      crypto.randomUUID(),
      `bulk${i}@example.test`,
    ]);
  }
  f.db.run(
    `INSERT INTO enrollments (sequence_id, subscriber_id, step_id, due_at, status, created_at, updated_at, test)
     SELECT ?, id, ?, ?, 'active', ?, ?, 0 FROM subscribers WHERE email LIKE 'bulk%'`,
    [s.seq.id, s.seq.steps[0]!.id, new Date(Date.parse(now) + hour).toISOString(), now, now],
  );
  f.db.run("COMMIT");
  await setWait(f, s, "PT2H");
  const res = await reschedule(f, s);
  expect(res.body.data).toEqual({ changed: total });
  const row = f.db
    .query("SELECT count(*) AS n FROM enrollments WHERE due_at = ?")
    .get(new Date(Date.parse(now) + 2 * hour).toISOString()) as { n: bigint };
  expect(Number(row.n)).toBe(total);
  expect(Number((f.db.query("SELECT count(*) AS n FROM sends").get() as any).n)).toBe(0);
});

test("reschedule needs sequences:manage and a real active step", async () => {
  const f = await open();
  const s = await make(f);
  const reader = await f.apiUser(["sequences:get"]);
  expect((await reschedule(f, s, reader)).status).toBe(403);
  const missing = await f.json(`/api/sequences/${s.seq.id}/steps/99999/reschedule`, "POST");
  expect(missing.status).toBe(404);
  const bad = await f.json(`/api/sequences/${s.seq.id}/steps/abc/reschedule`, "POST");
  expect(bad.status).toBe(400);
});

test("condition validation returns a save's errors and writes nothing", async () => {
  const f = await open();
  const s = await make(f);
  const validate = (condition: unknown, headers?: any) =>
    f.json("/api/conditions/validate", "POST", { condition }, headers);
  const good = await validate({ attr: "status", op: "eq", value: "enabled" });
  expect(good.body.data).toEqual({ ok: true, errors: [] });
  const bad = await validate({ attr: "status", op: "nope", value: "x" });
  expect(bad.status).toBe(200);
  expect(bad.body.data.ok).toBe(false);
  // The same error a save reports.
  const full = (await f.json(`/api/sequences/${s.seq.id}`)).body.data;
  full.steps[0].condition = { attr: "status", op: "nope", value: "x" };
  delete full.status;
  const saved = await f.json(`/api/sequences/${s.seq.id}`, "PUT", full);
  expect(saved.status).toBe(400);
  expect(saved.body.message).toContain(
    bad.body.data.errors[0].field.replace("condition", "steps.0.condition"),
  );
  // Raw SQL keeps its permission gate.
  const manager = await f.apiUser(["sequences:manage"]);
  const sql = await validate({ sql: "subscribers.id > 0" }, manager);
  expect(sql.body.data.ok).toBe(false);
  expect((await validate({ sql: "subscribers.id > 0" })).body.data.ok).toBe(true);
  const reader = await f.apiUser(["sequences:get"]);
  expect((await validate({ all: [] }, reader)).status).toBe(403);
  const huge = await f.json("/api/conditions/validate", "POST", {
    condition: { all: [] },
    pad: "x".repeat(70_000),
  });
  expect(huge.status).toBeGreaterThanOrEqual(400);
  expect(f.count("sequences")).toBe(1);
});
