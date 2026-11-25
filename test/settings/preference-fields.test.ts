// B149d (D167): `privacy.preference_fields` takes whole numbers for `min` and `max`, as the OpenAPI
// document declares them (integer). The settings binder refuses any other number before the field
// rules run, and the field rules refuse it too. Public boundary: PUT /api/settings and
// PUT /api/settings/<key> with the admin's session.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { admin, api, get, login } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { readJson } from "@/test/read-body";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeEach(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterEach(() => f.close());

const key = "privacy.preference_fields";
const save = (fields: unknown) => api(f, cookie, `/api/settings/${key}`, "PUT", fields);
const settings = async () => {
  const response = await get(f, "/api/settings", cookie);
  expect(response.status).toBe(200);
  return (await readJson<{ data: Record<string, unknown> }>(response)).data;
};
const field = (type: string, min: unknown, max: unknown) => ({
  key: "age",
  label: "Age",
  type,
  editable: true,
  required: false,
  min,
  max,
  options: [],
});

test("min and max are whole numbers: a fraction or a huge value is a 400 and nothing is written", async () => {
  const valid = [field("number", 13, 120)];
  expect((await save(valid)).status).toBe(200);
  const before = (await settings())[key];
  expect(before).toEqual(valid);
  for (const [type, min, max] of [
    ["number", 1.5, 120],
    ["number", 13, 120.25],
    ["number", 1e308, null],
    ["number", null, -1e300],
    ["text", 0.5, 40],
  ] as const) {
    const refused = await save([field(type, min, max)]);
    expect({ type, min, max, status: refused.status }).toEqual({ type, min, max, status: 400 });
    expect((await settings())[key]).toEqual(before);
  }
  // The full write binds the same way; the body as read is accepted first.
  const body = await settings();
  expect((await api(f, cookie, "/api/settings", "PUT", body)).status).toBe(200);
  const refused = await api(f, cookie, "/api/settings", "PUT", {
    ...body,
    [key]: [field("number", 2.5, null)],
  });
  expect(refused.status).toBe(400);
  expect((await settings())[key]).toEqual(before);
  // Negative whole numbers stay valid for a number's range.
  expect((await save([field("number", -40, -1)])).status).toBe(200);
});
