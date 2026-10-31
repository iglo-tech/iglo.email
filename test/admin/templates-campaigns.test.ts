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
    ["/admin/templates", "templates", 'data-sort-field="type"'],
    ["/admin/templates/new", "templates", 'name="subject"'],
    ["/admin/templates/1", "templates", 'data-testid="btn-preview"'],
    ["/admin/campaigns", "campaigns", 'popovertarget="camp-timestamp-sort"'],
    ["/admin/campaigns/new", "campaign", 'id="campaign-from-emails"'],
    ["/admin/campaigns/7", "campaign", "<richtext-editor"],
    ["/admin/campaigns/7/attachments", "campaign", 'id="campaign-test"'],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
  }
});

test("the sidebar follows the screen", async () => {
  for (const [path, href] of [
    ["/admin/campaigns", "/admin/campaigns"],
    ["/admin/campaigns/new", "/admin/campaigns/new"],
    ["/admin/templates/new", "/admin/templates"],
  ] as const) {
    const html = await (await get(f, path, cookie)).text();
    expect(html).toContain(`href="${href}" aria-current="page"`);
  }
});

test("upstream's content tab paths arrive at the tab", async () => {
  for (const tab of ["content", "attribs", "archive"]) {
    const response = await get(f, `/admin/campaigns/7/${tab}`, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/admin/campaigns/7#tab=${tab}`);
  }
});

test("a preview frame allows nothing, and an editor comes only from the embedded assets", async () => {
  for (const path of ["/admin/templates", "/admin/templates/1", "/admin/campaigns/7"]) {
    const html = await (await get(f, path, cookie)).text();
    expect(html).toMatch(/<iframe[^>]* sandbox=""/);
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("allow-same-origin");
    for (const [, src] of html.matchAll(/<script[^>]* src="([^"]+)"/g))
      if (!src!.startsWith("/admin/custom.js?")) expect(src).toStartWith("/admin/static/");
  }
});

test("the query string and settings are escaped in hidden fields, values, badges and links", async () => {
  const value = `"><script>window.pwned=1</script>{{7*7}}`;
  const q = encodeURIComponent(value);
  for (const path of [
    `/admin/campaigns?query=${q}&status=${q}&type=${q}&tag=${q}&extra=${q}`,
    `/admin/campaigns?order_by=${q}&order=${q}`,
    `/admin/templates?query=${q}&type=${q}&extra=${q}`,
  ]) {
    const html = await (await get(f, path, cookie)).text();
    expect(html).not.toContain("<script>window.pwned");
    expect(html).toContain("&lt;script&gt;window.pwned=1&lt;/script&gt;");
  }
  const form = await (await get(f, "/admin/campaigns/new", cookie)).text();
  expect(form).toContain('value="Fixture &lt;fixture@example.test&gt;"');
  expect(form).toContain('"from_emails":["Fixture \\u003cfixture@example.test\\u003e"');
});

test("a malformed ID is the admin error page", async () => {
  for (const path of [
    "/admin/campaigns/abc",
    "/admin/campaigns/0/content",
    "/admin/templates/abc",
  ]) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid ID");
  }
});

test("each route asks for its endpoint's permissions", async () => {
  const none = await userWith(f, cookie, "no-campaigns", ["subscribers:get"]);
  for (const path of [
    "/admin/campaigns",
    "/admin/campaigns/new",
    "/admin/campaigns/7",
    "/admin/campaigns/7/content",
    "/admin/templates",
    "/admin/templates/new",
    "/admin/templates/1",
  ])
    expect((await get(f, path, none)).status).toBe(403);

  for (const [name, permission] of [
    ["get", "campaigns:get"],
    ["get-all", "campaigns:get_all"],
  ] as const) {
    const reader = await userWith(f, cookie, `camp-${name}`, [permission]);
    const index = await get(f, "/admin/campaigns", reader);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect((await get(f, "/admin/campaigns/7", reader)).status).toBe(200);
    expect((await get(f, "/admin/campaigns/new", reader)).status).toBe(403);
    expect(html).not.toContain('href="/admin/campaigns/new"');
    expect(html).not.toContain("onChangeStatus");
    expect(html).not.toContain("onClone");
    expect(html).not.toContain("onDeleteSelected");
    expect(html).not.toContain("analyticsLink");
    const form = await (await get(f, "/admin/campaigns/7", reader)).text();
    expect(form).not.toContain("onTest");
    expect(form).not.toContain("onStart");
    expect(form).not.toContain('x-on:click="onSave"');
  }

  for (const [name, permission] of [
    ["manage", "campaigns:manage"],
    ["manage-all", "campaigns:manage_all"],
  ] as const) {
    const manager = await userWith(f, cookie, `camp-${name}`, ["campaigns:get", permission]);
    expect((await get(f, "/admin/campaigns/new", manager)).status).toBe(200);
    const html = await (await get(f, "/admin/campaigns", manager)).text();
    expect(html).toContain("onClone");
    expect(html).not.toContain("onChangeStatus");
    expect(html).toContain(
      name === "manage-all" ? '"manage_campaigns":"all"' : '"manage_campaigns":""',
    );
    expect(await (await get(f, "/admin/campaigns/7", manager)).text()).not.toContain("onStart");
  }

  const sender = await userWith(f, cookie, "camp-send", ["campaigns:get", "campaigns:send"]);
  const index = await (await get(f, "/admin/campaigns", sender)).text();
  expect(index).toContain("onChangeStatus");
  expect(index).toContain('"can_send":true');
  expect(await (await get(f, "/admin/campaigns/7", sender)).text()).toContain("onStart");

  const editor = await userWith(f, cookie, "tpl-reader", ["templates:get"]);
  expect((await get(f, "/admin/templates/new", editor)).status).toBe(403);
  const templates = await (await get(f, "/admin/templates", editor)).text();
  expect(templates).not.toContain('data-testid="btn-new"');
  expect(templates).not.toContain("onClone");
  expect(templates).not.toContain("onDelete");
  expect(await (await get(f, "/admin/templates/1", editor)).text()).not.toContain("btn-save");
});

test("a logged-out page asks for the session first", async () => {
  const response = await get(f, "/admin/campaigns/7/content");
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("/admin/login?next=");
});
