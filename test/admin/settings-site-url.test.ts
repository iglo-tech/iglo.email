// B126 (D123): app.site_url, the operator's own site, through the settings API. It is empty by
// default, takes an absolute http(s) URL under the root URL rules (D107), and a rejected value
// changes nothing and does not echo a credential. Public boundaries only: the settings API.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";
import { readJson } from "@/test/read-body";

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

async function siteUrl(): Promise<unknown> {
  const res = await get(f, "/api/settings", cookie);
  expect(res.status).toBe(200);
  return (await readJson<{ data: Record<string, unknown> }>(res)).data["app.site_url"];
}

test("app.site_url is empty by default and takes an absolute http(s) URL", async () => {
  expect(await siteUrl()).toBe("");
  const saved = await api(
    f,
    cookie,
    "/api/settings/app.site_url",
    "PUT",
    "https://brand.example.test/",
  );
  expect(saved.status).toBe(200);
  expect(await siteUrl()).toBe("https://brand.example.test/");
});

test("app.site_url takes a query string, such as a homepage's tracking parameter", async () => {
  const saved = await api(
    f,
    cookie,
    "/api/settings/app.site_url",
    "PUT",
    "https://brand.example.test/?utm_source=email",
  );
  expect(saved.status).toBe(200);
  expect(await siteUrl()).toBe("https://brand.example.test/?utm_source=email");
  await api(f, cookie, "/api/settings/app.site_url", "PUT", "https://brand.example.test/");
});

test("a rejected app.site_url names the site URL, not the root URL, and keeps the stored value", async () => {
  const kept = "https://brand.example.test/";
  for (const value of [
    "https://brand.example.test/#top",
    "https://brand.example.test/\u0001",
    "ftp://brand.example.test/",
  ]) {
    const refused = await api(f, cookie, "/api/settings/app.site_url", "PUT", value);
    expect(refused.status).toBe(400);
    const message = (await readJson<{ message: string }>(refused)).message;
    expect(message).toContain("site URL");
    expect(message).not.toContain("root URL");
    expect(message).not.toContain("root-url");
  }
  expect(await siteUrl()).toBe(kept);
});

test("a rejected app.site_url names the fix, keeps the stored value and echoes no credential", async () => {
  const kept = "https://brand.example.test/";
  const bare = await api(f, cookie, "/api/settings/app.site_url", "PUT", "brand.example.test");
  expect(bare.status).toBe(400);
  expect((await readJson<{ message: string }>(bare)).message).toContain(
    "such as https://brand.example.test",
  );

  const scheme = await api(
    f,
    cookie,
    "/api/settings/app.site_url",
    "PUT",
    "ftp://brand.example.test/",
  );
  expect(scheme.status).toBe(400);

  const secret = await api(
    f,
    cookie,
    "/api/settings/app.site_url",
    "PUT",
    "https://user:pass@brand.example.test/",
  );
  expect(secret.status).toBe(400);
  expect(await secret.text()).not.toContain("pass@");

  // A value that is not a string is refused by the settings API, not by a crash.
  const number = await api(f, cookie, "/api/settings/app.site_url", "PUT", 123);
  expect(number.status).toBe(400);

  expect(await siteUrl()).toBe(kept);
});
