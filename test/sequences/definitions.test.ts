// Sequence definitions API from docs/design/05-sequences.md#sequence-definition and
// 07-api-and-ui.md, through /api/sequences and the permission model.
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

async function base(f: SequencesFixture) {
  const tx = await f.template();
  const news = await f.list("news");
  const definition = {
    name: "Prepaid onboarding",
    trigger: { event: "order_paid", where: { "data.product": "prepaid" } },
    exit_on: ["subscription_created"],
    reentry: "never",
    list_id: news,
    steps: [
      { wait: "PT0S", kind: "transactional", template_id: tx },
      {
        wait: "P3D",
        kind: "marketing",
        template_id: tx,
        condition: { not: { event: "download_finished", since: "trigger" } },
        on_false: "exit",
      },
    ],
  };
  return { tx, news, definition };
}

test("create, read, list, update with stable step IDs, and delete", async () => {
  const f = await open();
  const { tx, news, definition } = await base(f);
  const now = f.clock.now().toISOString();
  const created = await f.json("/api/sequences", "POST", definition);
  expect(created.status).toBe(200);
  const seq = created.body.data;
  expect(seq).toMatchObject({
    id: expect.any(Number),
    uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    name: "Prepaid onboarding",
    status: "draft",
    trigger: { event: "order_paid", where: { "data.product": "prepaid" } },
    exit_on: ["subscription_created"],
    reentry: "never",
    list_id: news,
    created_at: now,
    updated_at: now,
    active_enrollments: 0,
  });
  expect(seq.steps).toEqual([
    {
      id: expect.any(Number),
      uuid: expect.any(String),
      position: 0,
      wait: "PT0S",
      kind: "transactional",
      template_id: tx,
      subject: null,
      condition: null,
      on_false: "exit",
      cap_policy: "defer",
      max_late: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: expect.any(Number),
      uuid: expect.any(String),
      position: 1,
      wait: "P3D",
      kind: "marketing",
      template_id: tx,
      subject: null,
      condition: { not: { event: "download_finished", since: "trigger" } },
      on_false: "exit",
      cap_policy: "defer",
      max_late: "P2D",
      created_at: now,
      updated_at: now,
    },
  ]);
  expect((await f.json(`/api/sequences/${seq.id}`)).body.data).toEqual(seq);
  const listed = await f.json("/api/sequences");
  expect(listed.status).toBe(200);
  const { steps: _steps, ...summary } = seq;
  expect(listed.body.data).toEqual({ results: [summary], total: 1, page: 1, per_page: 20 });

  // Reorder, edit one step, drop one, add one: kept steps keep IDs, the dropped one is deleted.
  f.clock.advance(1000);
  const [first, second] = seq.steps;
  const updated = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    ...definition,
    name: "Renamed",
    steps: [
      { id: second.id, wait: "P1D", kind: "marketing", template_id: tx, max_late: null },
      { wait: "PT1H", kind: "transactional", template_id: tx, subject: "Override" },
    ],
  });
  expect(updated.status).toBe(200);
  expect(updated.body.data.name).toBe("Renamed");
  expect(updated.body.data.updated_at).toBe(f.clock.now().toISOString());
  expect(updated.body.data.steps.map((s: any) => [s.id, s.position, s.wait, s.max_late])).toEqual([
    [second.id, 0, "P1D", null],
    [expect.any(Number), 1, "PT1H", null],
  ]);
  expect(updated.body.data.steps[1].id).not.toBe(first.id);
  expect(updated.body.data.steps[1].subject).toBe("Override");
  // The removed step still exists, marked deleted; it is never reused or revived.
  const row = f.db.query("SELECT status FROM sequence_steps WHERE id = ?").get(first.id) as {
    status: string;
  };
  expect(row.status).toBe("deleted");
  const revive = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    ...definition,
    steps: [{ id: first.id, wait: "PT0S", kind: "transactional", template_id: tx }],
  });
  expect(revive.status).toBe(400);

  // Another sequence's step ID is refused; nothing changes.
  const other = (await f.json("/api/sequences", "POST", definition)).body.data;
  const foreign = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    ...definition,
    steps: [{ id: other.steps[0].id, wait: "PT0S", kind: "transactional", template_id: tx }],
  });
  expect(foreign.status).toBe(400);
  expect((await f.json(`/api/sequences/${seq.id}`)).body.data).toEqual(updated.body.data);

  expect((await f.json(`/api/sequences/${seq.id}`, "DELETE")).status).toBe(200);
  expect((await f.json(`/api/sequences/${seq.id}`)).status).toBe(404);
  expect((await f.json(`/api/sequences/${seq.id}`, "DELETE")).status).toBe(404);
  expect((await f.json(`/api/sequences/${seq.id}`, "PUT", definition)).status).toBe(404);
  expect(f.count("sequences")).toBe(1);
});

test("every definition field is validated and a rejection writes nothing", async () => {
  const f = await open();
  const { tx, news, definition } = await base(f);
  const campaign = await f.template("campaign");
  const step = definition.steps[0]!;
  const withStep = (extra: object) => ({ ...definition, steps: [{ ...step, ...extra }] });
  const deep = (n: number): object => (n ? { not: deep(n - 1) } : { attr: "a", op: "exists" });
  const cases: Array<[string, unknown]> = [
    ["no name", { ...definition, name: "" }],
    ["blank name", { ...definition, name: "   " }],
    ["long name", { ...definition, name: "x".repeat(201) }],
    ["control in name", { ...definition, name: "a\u0000b" }],
    ["name type", { ...definition, name: 5 }],
    ["status", { ...definition, status: "running" }],
    ["no trigger", { ...definition, trigger: undefined }],
    ["trigger type", { ...definition, trigger: "order_paid" }],
    ["trigger event", { ...definition, trigger: { event: "" } }],
    ["trigger event control", { ...definition, trigger: { event: "a\nb" } }],
    ["trigger event long", { ...definition, trigger: { event: "x".repeat(201) } }],
    ["trigger extra", { ...definition, trigger: { event: "a", other: 1 } }],
    ["where data path", { ...definition, trigger: { event: "a", where: { "data.": 1 } } }],
    ["where empty", { ...definition, trigger: { event: "a", where: {} } }],
    ["where value", { ...definition, trigger: { event: "a", where: { "data.x": [1] } } }],
    ["where unsafe", { ...definition, trigger: { event: "a", where: { "data.x": 2 ** 53 } } }],
    ["where mixed", { ...definition, trigger: { event: "a", where: { "data.x": 1, attr: "p" } } }],
    ["where condition", { ...definition, trigger: { event: "a", where: { attr: "p", op: "x" } } }],
    ["where deep", { ...definition, trigger: { event: "a", where: deep(12) } }],
    ["where sql", { ...definition, trigger: { event: "a", where: { sql: "1=1" } } }],
    [
      "where nested sql",
      { ...definition, trigger: { event: "a", where: { any: [{ attr: "a", op: "exists" }, { sql: "1=1" }] } } },
    ],
    ["exit_on type", { ...definition, exit_on: "subscription_created" }],
    ["exit_on item", { ...definition, exit_on: [""] }],
    ["exit_on many", { ...definition, exit_on: Array.from({ length: 21 }, (_, i) => `e${i}`) }],
    ["reentry", { ...definition, reentry: "sometimes" }],
    ["list_id missing for marketing", { ...definition, list_id: null }],
    ["list_id unknown", { ...definition, list_id: news + 100 }],
    ["list_id type", { ...definition, list_id: "1" }],
    ["steps type", { ...definition, steps: {} }],
    ["steps many", { ...definition, steps: Array.from({ length: 51 }, () => step) }],
    ["step type", { ...definition, steps: [5] }],
    ["wait missing", withStep({ wait: undefined })],
    ["wait months", withStep({ wait: "P1M" })],
    ["wait fraction", withStep({ wait: "PT0.5S" })],
    ["wait huge", withStep({ wait: "P36601D" })],
    ["kind", withStep({ kind: "newsletter" })],
    ["template missing", withStep({ template_id: undefined })],
    ["template unknown", withStep({ template_id: tx + 1000 })],
    ["template campaign", withStep({ template_id: campaign })],
    ["template type", withStep({ template_id: "1" })],
    ["subject type", withStep({ subject: 5 })],
    ["subject long", withStep({ subject: "x".repeat(2049) })],
    ["condition", withStep({ condition: { attr: "plan", op: "like", value: "x" } })],
    ["condition deep", withStep({ condition: deep(12) })],
    ["on_false", withStep({ on_false: "retry" })],
    ["cap_policy", withStep({ cap_policy: "drop" })],
    ["max_late", withStep({ max_late: "P1Y" })],
    ["step id", withStep({ id: 999 })],
    ["step id type", withStep({ id: "1" })],
    ["activate without steps", { ...definition, status: "active", steps: [] }],
  ];
  for (const [label, body] of cases) {
    const r = await f.json("/api/sequences", "POST", body);
    if (r.status !== 400) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
    expect(typeof r.body.message).toBe("string");
  }
  // Duplicate step IDs on update.
  const seq = (await f.json("/api/sequences", "POST", definition)).body.data;
  const dup = await f.json(`/api/sequences/${seq.id}`, "PUT", {
    ...definition,
    steps: [
      { ...step, id: seq.steps[0].id },
      { ...step, id: seq.steps[0].id },
    ],
  });
  expect(dup.status).toBe(400);
  expect(f.count("sequences")).toBe(1);
  expect(f.count("sequence_steps")).toBe(2);
  // Malformed bodies.
  expect((await f.json("/api/sequences", "POST", "{")).status).toBe(400);
  expect((await f.json("/api/sequences", "POST", "[]")).status).toBe(400);
  const plain = await f.request("/api/sequences", {
    method: "POST",
    headers: { ...f.sessionHeaders, "content-type": "text/plain" },
    body: JSON.stringify(definition),
  });
  expect(plain.status).toBe(415);
  const huge = await f.json("/api/sequences", "POST", {
    ...definition,
    name: "x",
    pad: "y".repeat(300_000),
  });
  expect(huge.status).toBe(413);
  expect(f.count("sequences")).toBe(1);
  // A valid definition without list_id and only transactional steps is fine.
  const ok = await f.json("/api/sequences", "POST", {
    ...definition,
    list_id: null,
    steps: [step],
  });
  expect(ok.status).toBe(200);
  expect(ok.body.data.list_id).toBeNull();
  // Condition-language trigger filters are accepted.
  const where = await f.json("/api/sequences", "POST", {
    ...definition,
    trigger: { event: "a", where: { all: [{ attr: "plan", op: "eq", value: "pro" }] } },
  });
  expect(where.status).toBe(200);
});

test("max_late defaults to P2D for marketing and no limit for transactional", async () => {
  const f = await open();
  const { tx, definition } = await base(f);
  const r = await f.json("/api/sequences", "POST", {
    ...definition,
    steps: [
      { wait: "PT0S", kind: "marketing", template_id: tx },
      { wait: "PT0S", kind: "marketing", template_id: tx, max_late: null },
      { wait: "PT0S", kind: "marketing", template_id: tx, max_late: "PT6H" },
      { wait: "PT0S", kind: "transactional", template_id: tx },
      { wait: "PT0S", kind: "transactional", template_id: tx, max_late: "P1D" },
    ],
  });
  expect(r.status).toBe(200);
  expect(r.body.data.steps.map((s: { max_late: string | null }) => s.max_late)).toEqual([
    "P2D",
    null,
    "PT6H",
    null,
    "P1D",
  ]);
});

test("sql conditions need subscribers:sql_query; sequences permissions are enforced", async () => {
  const f = await open();
  const { tx, news, definition } = await base(f);
  const sqlStep = {
    ...definition,
    steps: [
      {
        wait: "PT0S",
        kind: "transactional",
        template_id: tx,
        condition: { sql: "subscribers.attribs->>'$.credits' < 100" },
      },
    ],
  };
  const manager = await f.apiUser(["sequences:manage", "sequences:get", "lists:get_all"]);
  const sqlManager = await f.apiUser([
    "sequences:manage",
    "sequences:get",
    "lists:get_all",
    "subscribers:sql_query",
  ]);
  const reader = await f.apiUser(["sequences:get"]);
  const writerOnly = await f.apiUser(["sequences:manage", "lists:get_all"]);
  const none = await f.apiUser(["subscribers:get_all"]);
  const denied = await f.json("/api/sequences", "POST", sqlStep, manager);
  expect(denied.status).toBe(400);
  expect(denied.body.message).toContain("sql");
  const allowed = await f.json("/api/sequences", "POST", sqlStep, sqlManager);
  expect(allowed.status).toBe(200);
  const id = allowed.body.data.id;
  // Resaving a definition with someone else's sql needs the permission too.
  expect((await f.json(`/api/sequences/${id}`, "PUT", sqlStep, manager)).status).toBe(400);

  expect((await f.json(`/api/sequences/${id}`, "GET", undefined, reader)).status).toBe(200);
  expect((await f.json("/api/sequences", "GET", undefined, reader)).status).toBe(200);
  for (const [path, method, body] of [
    ["/api/sequences", "POST", definition],
    [`/api/sequences/${id}`, "PUT", definition],
    [`/api/sequences/${id}/status`, "PUT", { status: "active" }],
    [`/api/sequences/${id}`, "DELETE", undefined],
  ] as const) {
    expect((await f.json(path, method, body, reader)).status).toBe(403);
    expect((await f.json(path, method, body, none)).status).toBe(403);
  }
  expect((await f.json(`/api/sequences/${id}`, "GET", undefined, writerOnly)).status).toBe(403);
  expect((await f.json(`/api/sequences/${id}`, "GET", undefined, none)).status).toBe(403);
  expect((await f.json(`/api/sequences/${id}`, "GET", undefined, {})).status).toBe(403);
  // A list the caller cannot see cannot be the sequence's permission list.
  const scoped = await f.apiUser(["sequences:manage"], [{ id: news, permissions: ["list:get"] }]);
  const hidden = await f.list("hidden");
  expect((await f.json("/api/sequences", "POST", definition, scoped)).status).toBe(200);
  expect(
    (await f.json("/api/sequences", "POST", { ...definition, list_id: hidden }, scoped)).status,
  ).toBe(400);
  // Session writes need the CSRF token.
  const { "x-csrf-token": _csrf, ...noCsrf } = f.sessionHeaders;
  expect((await f.json("/api/sequences", "POST", definition, noCsrf)).status).toBe(403);
  expect(f.count("sequences")).toBe(2);
});

test("status changes, activation checks, archive and delete rules", async () => {
  const f = await open();
  const { definition } = await base(f);
  const seq = (await f.json("/api/sequences", "POST", definition)).body.data;
  const status = (value: unknown) => f.json(`/api/sequences/${seq.id}/status`, "PUT", value);
  for (const bad of [{ status: "running" }, { status: 1 }, {}, "x"])
    expect((await status(bad)).status).toBe(400);
  for (const next of ["active", "paused", "active", "archived", "draft"]) {
    const r = await status({ status: next });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe(next);
  }
  expect((await f.json("/api/sequences/999/status", "PUT", { status: "active" })).status).toBe(
    404,
  );
  expect((await f.json("/api/sequences/abc")).status).toBe(400);
  expect((await f.json("/api/sequences/99999999999999999999")).status).toBe(400);
  // An empty draft can be saved but not activated.
  const empty = (await f.json("/api/sequences", "POST", { ...definition, steps: [] })).body.data;
  expect(empty.steps).toEqual([]);
  expect(
    (await f.json(`/api/sequences/${empty.id}/status`, "PUT", { status: "active" })).status,
  ).toBe(400);
  // A sequence with enrollments cannot be deleted; archive it instead.
  await status({ status: "active" });
  const subscriber = await f.subscriber("one@example.test");
  expect(
    (await f.json("/api/enrollments", "POST", { sequence_id: seq.id, subscriber_id: subscriber }))
      .status,
  ).toBe(200);
  expect((await f.json(`/api/sequences/${seq.id}`, "DELETE")).status).toBe(409);
  const list = await f.json("/api/sequences?status=active");
  expect(list.body.data.results.map((s: { id: number }) => s.id)).toEqual([seq.id]);
  expect(list.body.data.results[0].active_enrollments).toBe(1);
  expect((await f.json("/api/sequences?status=nope")).status).toBe(400);
  expect((await f.json("/api/sequences?per_page=101")).status).toBe(400);
  const paged = await f.json("/api/sequences?per_page=1&page=2");
  expect(paged.body.data).toMatchObject({ total: 2, page: 2, per_page: 1 });
  expect(paged.body.data.results.map((s: { id: number }) => s.id)).toEqual([seq.id]);
});
