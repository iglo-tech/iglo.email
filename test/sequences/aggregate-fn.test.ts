// An aggregate's `fn` (docs/design/05-sequences.md#aggregates, D100): absent means `count`, while
// `null` and any non-string are refused with 400 naming the field and writing nothing (D103).
// Through /api/sequences on create and on a step update.
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

const refusal = (path: string) => new RegExp(`^Invalid fields: ${path.replaceAll(".", "\\.")}`);

test("D103: an absent fn is count, and an explicit count is stored as given", async () => {
  const f = await open();
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "Absent fn",
    trigger: { event: "order_paid" },
    steps: [
      {
        wait: "P1D",
        kind: "transactional",
        template_id: tx,
        aggregates: { a: { event: "download_finished" }, b: { event: "x", fn: "count" } },
      },
    ],
  });
  expect(created.status).toBe(200);
  expect(created.body.data.steps[0].aggregates).toEqual({
    a: { event: "download_finished", fn: "count" },
    b: { event: "x", fn: "count" },
  });
});

test("D103: a null or non-string fn is refused on create with its field named and nothing written", async () => {
  const f = await open();
  const tx = await f.template();
  const withFn = (fn: unknown) => ({
    name: "Null fn",
    trigger: { event: "order_paid" },
    steps: [
      {
        wait: "P1D",
        kind: "transactional",
        template_id: tx,
        aggregates: { n: { event: "download_finished", fn } },
      },
    ],
  });
  for (const fn of [null, 1, true, [], {}, "COUNT", ""]) {
    const r = await f.json("/api/sequences", "POST", withFn(fn));
    expect({ fn, status: r.status }).toEqual({ fn, status: 400 });
    expect(r.body.message).toMatch(refusal("steps.0.aggregates.n.fn"));
  }
  expect(f.count("sequences")).toBe(0);
});

test("D103: a null fn on a step update is refused and the stored aggregate is unchanged", async () => {
  const f = await open();
  const tx = await f.template();
  const created = await f.json("/api/sequences", "POST", {
    name: "Update fn",
    trigger: { event: "order_paid" },
    steps: [
      {
        wait: "P1D",
        kind: "transactional",
        template_id: tx,
        aggregates: { items: { event: "download_finished", fn: "sum", field: "data.items" } },
      },
    ],
  });
  expect(created.status).toBe(200);
  const id = created.body.data.id as number;
  const stored = created.body.data.steps[0].aggregates;
  const full = (await f.json(`/api/sequences/${id}`)).body.data;
  delete full.status;
  full.steps[0].aggregates = {
    items: { event: "download_finished", fn: null, field: "data.items" },
  };
  const refused = await f.json(`/api/sequences/${id}`, "PUT", full);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(refusal("steps.0.aggregates.items.fn"));
  const read = await f.json(`/api/sequences/${id}`);
  expect(read.body.data.steps[0].aggregates).toEqual(stored);
  // An absent fn on the same update is still the default, count, which needs no field.
  full.steps[0].aggregates = { items: { event: "download_finished" } };
  const defaulted = await f.json(`/api/sequences/${id}`, "PUT", full);
  expect(defaulted.status).toBe(200);
  expect(defaulted.body.data.steps[0].aggregates).toEqual({
    items: { event: "download_finished", fn: "count" },
  });
});
