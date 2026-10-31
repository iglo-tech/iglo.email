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
    ["/admin/campaigns/analytics", "analytics", 'x-data="analyticsView"'],
    ["/admin/lists/analytics", "analytics", 'x-data="analyticsView"'],
    ["/admin/settings/logs", "logs", 'x-data="logsView"'],
    ["/admin/settings/maintenance", "maintenance", 'x-data="maintenanceView"'],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
    expect(html).toContain("data-sidebar-layout");
  }
});

test("charts follow the resource and the selection", async () => {
  const none = await (await get(f, "/admin/lists/analytics", cookie)).text();
  expect(none).not.toContain('data-testid="chart-views"');
  const lists = await (await get(f, "/admin/lists/analytics?id=1", cookie)).text();
  expect(lists).toContain('data-testid="chart-subscriptions"');
  expect(lists).toContain('data-testid="chart-views"');
  const campaigns = await (await get(f, "/admin/campaigns/analytics?id=1", cookie)).text();
  expect(campaigns).not.toContain('data-testid="chart-subscriptions"');
  expect(campaigns).toContain('data-testid="chart-links"');
  // List-only access keeps the list's charts away from campaign metrics.
  const lister = await userWith(f, cookie, "m46-lister", ["lists:get_all"]);
  const limited = await (await get(f, "/admin/lists/analytics?id=1", lister)).text();
  expect(limited).toContain('data-testid="chart-subscriptions"');
  expect(limited).not.toContain('data-testid="chart-views"');
});

test("a bad ID is a 400, and the query arrives escaped", async () => {
  expect((await get(f, "/admin/campaigns/analytics?id=x", cookie)).status).toBe(400);
  const hostile = encodeURIComponent(`"><img src=x onerror=alert(1)>`);
  const html = await (
    await get(f, `/admin/campaigns/analytics?id=1&interval=${hostile}&from=${hostile}`, cookie)
  ).text();
  expect(html).not.toContain("<img src=x");
});

test("each route asks for its endpoint's permission", async () => {
  const none = await userWith(f, cookie, "m46-nothing", ["lists:get_all"]);
  for (const path of [
    "/admin/campaigns/analytics",
    "/admin/settings/logs",
    "/admin/settings/maintenance",
  ])
    expect((await get(f, path, none)).status).toBe(403);
  const reader = await userWith(f, cookie, "m46-reader", ["settings:get"]);
  expect((await get(f, "/admin/settings/logs", reader)).status).toBe(200);
  expect((await get(f, "/admin/settings/maintenance", reader)).status).toBe(403);
  const maintainer = await userWith(f, cookie, "m46-maintainer", ["settings:maintain"]);
  expect((await get(f, "/admin/settings/maintenance", maintainer)).status).toBe(200);
});
