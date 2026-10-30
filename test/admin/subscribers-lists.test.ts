import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, get, login, userWith, type Fixture } from "@/test/admin/support";
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
    ["/admin/subscribers", "subscribers", 'data-testid="btn-advanced-search"'],
    ["/admin/subscribers/new", "subscribers", 'name="email"'],
    ["/admin/subscribers/lists/7", "subscribers", 'data-testid="btn-remove-filter"'],
    ["/admin/subscribers/7", "subscribers", 'role="tablist"'],
    ["/admin/subscribers/7/edit", "subscribers", 'name="attribs"'],
    ["/admin/subscribers/7/lists", "subscribers", 'data-testid="btn-manage"'],
    ["/admin/subscribers/7/bounces", "subscribers", "bounce-row"],
    ["/admin/lists", "lists", 'data-sort-field="subscriber_count"'],
    ["/admin/lists/new", "lists", 'name="optin"'],
    ["/admin/lists/7", "lists", 'data-testid="btn-analytics"'],
    ["/admin/lists/7/edit", "lists", 'name="tags"'],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
  }
});

test("sort links toggle their order and drop the page; the sidebar follows the status", async () => {
  const html = await (
    await get(f, "/admin/lists?status=archived&page=3&order_by=name&order=asc", cookie)
  ).text();
  expect(html).toContain(
    'href="/admin/lists?status=archived&amp;order_by=name&amp;order=desc" data-sort-field="name" data-sorted="asc"',
  );
  expect(html).toContain('href="/admin/lists?status=archived&amp;order_by=type&amp;order=asc"');
  expect(html).toContain('href="/admin/lists?status=archived" aria-current="page"');
});

test("the query string is escaped in hidden fields, values, badges and links", async () => {
  const value = `"><script>window.pwned=1</script>{{7*7}}`;
  const q = encodeURIComponent(value);
  for (const path of [
    `/admin/subscribers?search=${q}&status=${q}&subscription_status=${q}&extra=${q}`,
    `/admin/lists?query=${q}&type=${q}&optin=${q}&tag=${q}&extra=${q}`,
  ]) {
    const html = await (await get(f, path, cookie)).text();
    expect(html).not.toContain("<script>window.pwned");
    expect(html).toContain("&lt;script&gt;window.pwned=1&lt;/script&gt;");
    expect(html).toContain('type="hidden" name="extra"');
  }
});

test("a malformed ID is the admin error page", async () => {
  for (const path of [
    "/admin/subscribers/abc",
    "/admin/subscribers/0/edit",
    "/admin/subscribers/lists/abc",
    "/admin/lists/abc",
  ]) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("invalid ID");
  }
});

test("each route asks for its endpoint's permissions, and controls follow them", async () => {
  const none = await userWith(f, cookie, "no-subscribers", ["campaigns:get"]);
  expect((await get(f, "/admin/subscribers", none)).status).toBe(403);
  expect((await get(f, "/admin/subscribers/7", none)).status).toBe(403);
  expect((await get(f, "/admin/subscribers/new", none)).status).toBe(403);
  expect((await get(f, "/admin/lists/new", none)).status).toBe(403);
  // A user holds no list until a list role or lists:get_all grants it.
  expect((await get(f, "/admin/lists", none)).status).toBe(200);
  expect((await get(f, "/admin/lists/7", none)).status).toBe(403);
  expect((await get(f, "/admin/lists/7/edit", none)).status).toBe(403);

  const reader = await userWith(f, cookie, "reader", ["subscribers:get"]);
  const listing = await (await get(f, "/admin/subscribers", reader)).text();
  expect(listing).toContain('data-testid="btn-export-subscribers"');
  for (const control of [
    "btn-new",
    "btn-edit",
    "btn-delete",
    "btn-manage-lists",
    "btn-manage-blocklist",
    "btn-delete-subscribers",
  ])
    expect(listing).not.toContain(`data-testid="${control}"`);
  expect(listing).not.toContain("/bounces`");
  expect((await get(f, "/admin/subscribers/new", reader)).status).toBe(403);
  expect((await get(f, "/admin/subscribers/lists/7", reader)).status).toBe(403);
  // Upstream needs both a subscriber read and bounces:get here.
  expect((await get(f, "/admin/subscribers/7/bounces", reader)).status).toBe(403);
  const edit = await (await get(f, "/admin/subscribers/7/edit", reader)).text();
  expect(edit).not.toContain('data-testid="btn-save"');
  const lists = await (await get(f, "/admin/subscribers/7/lists", reader)).text();
  expect(lists).not.toContain('data-testid="btn-manage"');
  expect(lists).not.toContain('data-testid="btn-delete-sub"');

  const index = await (await get(f, "/admin/lists", reader)).text();
  expect(index).not.toContain('data-testid="btn-new"');
  expect(index).not.toContain('data-testid="btn-campaign"');
  expect(index).toContain('"manage_lists":""');
  expect(await (await get(f, "/admin/lists", cookie)).text()).toContain('"manage_lists":"all"');
});
