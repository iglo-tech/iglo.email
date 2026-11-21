// A missing external-ID subscriber answers 404 on both selector forms (D101), while malformed,
// missing and duplicate selectors stay 400 and numeric IDs keep listmonk's 400 (D38, D39).
// Observed through the HTTP API of the production router, with nothing written on refusal.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}
const forms = (external: string) =>
  [
    `/api/subscribers/external/${encodeURIComponent(external)}`,
    `/api/subscribers/external?external_id=${encodeURIComponent(external)}`,
  ] as const;
const kept = { email: "kept@example.test", name: "Kept", external_id: "kept-1" };
async function seed(f: PublicFixture) {
  const created = await f.json("/api/subscribers", "POST", kept);
  expect(created.status).toBe(200);
  return created.body.data.id as number;
}
/** The refused writes created nothing: the address they named is still free. */
const freeAddress = async (f: PublicFixture) =>
  (await f.json("/api/subscribers", "POST", { email: "new@example.test", name: "New" })).status ===
  200;

test("D101: an absent external ID answers 404 on GET, PUT and DELETE, both forms", async () => {
  const f = await open();
  await seed(f);
  for (const path of forms("absent-1")) {
    const read = await f.json(path);
    expect([path, read.status, read.body.message]).toEqual([path, 404, "Subscriber not found."]);
    const write = await f.json(path, "PUT", { email: "new@example.test", name: "New" });
    expect([path, write.status, write.body.message]).toEqual([path, 404, "Subscriber not found."]);
    const removed = await f.json(path, "DELETE");
    expect([path, removed.status, removed.body.message]).toEqual([
      path,
      404,
      "Subscriber not found.",
    ]);
  }
  // Refusals write nothing: no subscriber was created, changed or deleted.
  expect(await freeAddress(f)).toBe(true);
  const still = await f.json("/api/subscribers/external/kept-1");
  expect(still.body.data).toMatchObject({ name: "Kept", email: kept.email });
});

test("D101: a malformed, missing or duplicate selector stays 400 with nothing written", async () => {
  const f = await open();
  await seed(f);
  for (const query of ["", "?external_id=", "?external_id=a&external_id=b"]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const r = await f.json(`/api/subscribers/external${query}`, method, {
        email: "new@example.test",
        name: "New",
        external_id: "kept-1",
      });
      expect([query, method, r.status]).toEqual([query, method, 400]);
    }
  }
  expect(await freeAddress(f)).toBe(true);
  expect((await f.json("/api/subscribers/external/kept-1")).body.data.name).toBe("Kept");
});

test("D101: numeric IDs keep listmonk's 400 for an absent subscriber", async () => {
  const f = await open();
  const r = await f.json("/api/subscribers/999999");
  expect([r.status, r.body.message]).toEqual([400, "Subscriber (999999: ) not found"]);
});

test("D101: a present external ID still answers 200 on both forms", async () => {
  const f = await open();
  const id = await seed(f);
  for (const path of forms("kept-1")) {
    const r = await f.json(path);
    expect([path, r.status, r.body.data.id]).toEqual([path, 200, id]);
  }
});
