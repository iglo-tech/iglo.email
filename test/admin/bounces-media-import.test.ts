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
    ["/admin/subscribers/bounces", "bounces", 'x-data="bouncesView"'],
    ["/admin/campaigns/media", "media", 'x-data="mediaView(&#39;manage&#39;)"'],
    ["/admin/subscribers/import", "import", 'data-testid="btn-upload"'],
    ["/admin/lists/forms", "forms", 'x-data="formsView"'],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
    expect(html).toContain("data-sidebar-layout");
  }
});

test("the media fragment is the gallery alone, behind the same check", async () => {
  const response = await get(f, "/admin/campaigns/media/fragment", cookie);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('x-data="mediaView(&#39;picker&#39;)"');
  expect(html).toContain('action="/admin/campaigns/media/fragment"');
  expect(html).toContain("/admin/static/js/views/media.js?v=");
  expect(html).not.toContain("data-sidebar-layout");
  expect(html).not.toContain("user-menu");

  const anonymous = await get(f, "/admin/campaigns/media/fragment");
  expect(anonymous.status).toBe(307);
});

test("a filter in the URL arrives escaped", async () => {
  const hostile = `"><img src=x onerror=alert(1)>`;
  const query = encodeURIComponent(hostile);
  const bounces = await get(f, `/admin/subscribers/bounces?source=${query}&type=${query}`, cookie);
  const media = await get(f, `/admin/campaigns/media?query=${query}`, cookie);
  for (const html of [await bounces.text(), await media.text()]) {
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  }
});

test("each route asks for its endpoint's permission, and the navigation does not grant it", async () => {
  const none = await userWith(f, cookie, "m45-nothing", ["lists:get_all"]);
  for (const [path, permission] of [
    ["/admin/subscribers/bounces", "bounces:get"],
    ["/admin/campaigns/media", "media:get"],
    ["/admin/campaigns/media/fragment", "media:get"],
    ["/admin/subscribers/import", "subscribers:import"],
  ] as const) {
    const denied = await get(f, path, none);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain(permission);
  }
  // Upstream's forms page asks for a session; /api/lists applies the list scope.
  expect((await get(f, "/admin/lists/forms", none)).status).toBe(200);
});

test("the controls of a manage permission are not sent without it", async () => {
  const viewer = await userWith(f, cookie, "m45-viewer", ["bounces:get", "media:get"]);
  const bounces = await (await get(f, "/admin/subscribers/bounces", viewer)).text();
  expect(bounces).not.toContain('data-testid="btn-delete"');
  expect(bounces).not.toContain('data-testid="btn-manage-blocklist"');
  const media = await (await get(f, "/admin/campaigns/media", viewer)).text();
  expect(media).not.toContain('data-testid="btn-upload-menu"');
  expect(media).not.toContain('data-testid="btn-delete"');
  expect(media).toContain('data-testid="btn-copy-url"');
});
