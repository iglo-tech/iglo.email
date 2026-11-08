// B40 (D89): the admin settings page has no control for a key nothing reads, and saving the page
// keeps those values. Public boundaries only: the rendered page and the settings API.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

async function settings(): Promise<Record<string, any>> {
  const res = await get(f, "/api/settings", cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, any> }).data;
}

// The page sends each masked secret back empty, which the API reads as "keep" (settings.js onSubmit).
function unmasked(value: unknown): unknown {
  if (typeof value === "string") return /^•+$/.test(value) ? "" : value;
  if (Array.isArray(value)) return value.map(unmasked);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmasked(item)]));
  return value;
}

test("1. the settings page shows no control for a key nothing reads, and no unavailable card", async () => {
  const html = await (await get(f, "/admin/settings", cookie)).text();

  const removed = [
    "upload.s3.",
    "form.messengers",
    "app.check_updates",
    "max_msg_retries",
    "msg_retry_delay",
    "app.lang",
    "data-unavailable",
    "Not available",
    "Messengers",
  ];
  expect(removed.filter((name) => html.includes(name))).toEqual([]);

  // upload.provider stays, read-only: the media routes refuse uploads unless it is "filesystem".
  expect(html).toMatch(/<input[^>]*name="upload\.provider"[^>]*readonly/);
});

test("2. a save from the settings page keeps the values of the keys that have no control", async () => {
  await api(f, cookie, "/api/settings/upload.s3.bucket", "PUT", "b40-bucket");
  await api(f, cookie, "/api/settings/upload.s3.aws_default_region", "PUT", "eu-west-1");
  await api(f, cookie, "/api/settings/upload.s3.aws_secret_access_key", "PUT", "b40-secret");
  await api(f, cookie, "/api/settings/app.lang", "PUT", "de");
  const messengers = await api(f, cookie, "/api/settings/messengers", "PUT", [
    { name: "postback", root_url: "http://messenger.test", enabled: true, password: "m-secret" },
  ]);
  expect(messengers.status).toBe(200);
  const smtp = (await settings())["smtp"] as Record<string, unknown>[];
  expect(smtp.length).toBeGreaterThan(0);
  smtp[0]!["max_msg_retries"] = 7;
  smtp[0]!["msg_retry_delay"] = "3s";
  expect((await api(f, cookie, "/api/settings/smtp", "PUT", smtp)).status).toBe(200);

  const before = await settings();
  expect(before["upload.s3.bucket"]).toBe("b40-bucket");
  expect(before["app.lang"]).toBe("de");

  // The page's own request: the whole object it read, with the shown fields edited (none here).
  const saved = await api(f, cookie, "/api/settings", "PUT", unmasked(before));
  expect(saved.status).toBe(200);

  const after = await settings();
  for (const key of [
    "upload.provider",
    "upload.s3.url",
    "upload.s3.bucket",
    "upload.s3.aws_default_region",
    "upload.s3.aws_secret_access_key",
    "app.lang",
    "app.check_updates",
    "messengers",
  ])
    expect({ key, value: after[key] }).toEqual({ key, value: before[key] });
  expect(after["app.check_updates"]).toBe(false);
  expect(after["smtp"]).toEqual(before["smtp"]);
  expect(after["smtp"][0].max_msg_retries).toBe(7);
  expect(after["smtp"][0].msg_retry_delay).toBe("3s");
});
