import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login, userWith, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

test("each screen arrives with its module and upstream's markup", async () => {
  for (const [path, script, marker] of [
    ["/admin/settings", "settings", 'x-data="settingsView"'],
    ["/admin/users", "users", 'data-testid="btn-new"'],
    ["/admin/users/new", "users", 'name="user_role"'],
    ["/admin/users/1", "users", 'x-data="userForm"'],
    ["/admin/users/roles", "roles", 'x-data="rolesView"'],
    ["/admin/users/roles/new", "roles", 'value="subscribers:sql_query"'],
    ["/admin/users/roles/lists", "roles", 'x-data="rolesView"'],
    ["/admin/users/roles/lists/new", "roles", 'data-testid="btn-add-list"'],
    ["/admin/user/profile", "profile", 'name="password2"'],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
  }
});

test("a screen holds no value from the settings, only what its module reads masked", async () => {
  const marker = "stored-secret-value";
  await api(f, cookie, "/api/settings/upload.s3.aws_secret_access_key", "PUT", marker);
  const html = await (await get(f, "/admin/settings", cookie)).text();
  expect(html).not.toContain(marker);
});

test("each route asks for its endpoint's permission, and the navigation does not grant it", async () => {
  const none = await userWith(f, cookie, "admin-nothing", ["lists:get_all"]);
  for (const [path, permission] of [
    ["/admin/settings", "settings:get"],
    ["/admin/users", "users:get"],
    ["/admin/users/new", "users:manage"],
    ["/admin/users/1", "users:get"],
    ["/admin/users/roles", "roles:get"],
    ["/admin/users/roles/new", "roles:manage"],
    ["/admin/users/roles/1", "roles:get"],
    ["/admin/users/roles/lists", "roles:get"],
    ["/admin/users/roles/lists/new", "roles:manage"],
    ["/admin/users/roles/lists/2", "roles:get"],
  ] as const) {
    const denied = await get(f, path, none);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain(permission);
  }
  const viewer = await userWith(f, cookie, "admin-viewer", ["users:get", "roles:get"]);
  expect((await get(f, "/admin/users/new", viewer)).status).toBe(403);
  expect((await get(f, "/admin/users/roles/new", viewer)).status).toBe(403);
  const list = await (await get(f, "/admin/users", viewer)).text();
  expect(list).not.toContain('data-testid="btn-new"');
  expect((await get(f, "/admin/user/profile", none)).status).toBe(200);
});

test("an ID the page cannot use answers as upstream does", async () => {
  expect((await get(f, "/admin/users/abc", cookie)).status).toBe(400);
  expect((await get(f, "/admin/users/roles/999999", cookie)).status).toBe(404);
  expect((await get(f, "/admin/users/roles/lists/999999", cookie)).status).toBe(404);
});

test("every permission the API takes has a box", async () => {
  const html = await (await get(f, "/admin/users/roles/new", cookie)).text();
  const boxes = [...html.matchAll(/type="checkbox" value="([a-z_]+:[a-z_]+)"/g)].map((m) => m[1]!);
  for (const value of ["subscriber_events:create", "sends:manage", "webhooks:manage", "tx:send"])
    expect(boxes).toContain(value);
  const response = await api(f, cookie, "/api/roles/users", "POST", {
    name: "every box",
    permissions: boxes,
  });
  expect(response.status).toBe(200);
});

test("stored names are escaped where the server writes them", async () => {
  const hostile = '<img src=x onerror="pwned()">';
  const created = await api(f, cookie, "/api/roles/users", "POST", {
    name: hostile,
    permissions: ["lists:get_all"],
  });
  const { data } = (await created.json()) as { data: { id: number } };
  for (const path of [
    `/admin/users/roles/${data.id}`,
    "/admin/users/new",
    `/admin/users?user_role_id=${data.id}`,
  ]) {
    const html = await (await get(f, path, cookie)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  }
});

test("custom admin assets need a session and answer as authored", async () => {
  const css = "body { color: red; } /* </style> */";
  await api(f, cookie, "/api/settings/appearance.admin.custom_css", "PUT", css);
  const anonymous = await get(f, "/admin/custom.css");
  expect(anonymous.status).toBe(307);
  const response = await get(f, "/admin/custom.css", cookie);
  expect(response.headers.get("content-type")).toContain("text/css");
  expect(await response.text()).toBe(css);
  const page = await (await get(f, "/admin", cookie)).text();
  expect(page).toContain("/admin/custom.css?v=");
  expect(page).toContain("/admin/custom.js?v=");
  expect(page).not.toContain("color: red");
  for (const path of ["/admin/login", "/admin/forgot"]) {
    const html = await (await get(f, path)).text();
    expect(html).not.toContain("/admin/custom.");
  }
});
