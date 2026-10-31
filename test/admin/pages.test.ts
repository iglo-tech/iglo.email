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

test("a page request without a session goes to login and names its way back", async () => {
  for (const [path, next] of [
    ["/admin", "%2Fadmin"],
    ["/admin/lists?status=archived", "%2Fadmin%2Flists%3Fstatus%3Darchived"],
    ["/admin/no-such-view", "%2Fadmin%2Fno-such-view"],
  ] as const) {
    const response = await get(f, path);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/admin/login?next=${next}`);
  }
  const stale = await get(f, "/admin", `session=${"x".repeat(43)}`);
  expect(stale.status).toBe(307);
});

test("the dashboard renders the upstream shell without caching", async () => {
  const response = await get(f, "/admin", cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  const html = await response.text();
  expect(html).toStartWith("<!DOCTYPE html>");
  expect(html).toContain("<title>Dashboard - ");
  expect(html).toContain('x-data="dashboardView"');
  expect(html).toContain("/admin/static/js/views/dashboard.js?v=");
  expect(html).toContain('href="/admin/user/profile"');
  expect(html).toContain('<a href="/admin" aria-current="page">');
  expect(html).toContain('data-testid="system"');
  for (const key of ["Uptime", "App memory", "CPU cores"]) expect(html).toContain(key);
  expect(html).toContain('"globals.terms.draft":"Draft"');
});

test("navigation is filtered by permission and a denied view says why", async () => {
  const everything = await (await get(f, "/admin", cookie)).text();
  for (const path of ["/admin/subscribers", "/admin/users", "/admin/settings/maintenance"])
    expect(everything).toContain(`href="${path}"`);
  const limited = await userWith(f, cookie, "limited-nav", ["campaigns:get"]);
  const page = await (await get(f, "/admin", limited)).text();
  const html = page.slice(page.indexOf("<nav>"), page.indexOf("</nav>"));
  expect(html).toContain('href="/admin/campaigns"');
  expect(html).not.toContain('href="/admin/campaigns/new"');
  expect(html).not.toContain('href="/admin/subscribers"');
  expect(html).not.toContain('href="/admin/users"');
  expect(html).not.toContain('href="/admin/settings');
  const denied = await get(f, "/admin/settings", limited);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain("settings:get");
  expect((await get(f, "/admin/lists/analytics", limited)).status).toBe(501);
});

test("every navigation link answers, and an unported one says so", async () => {
  const html = await (await get(f, "/admin", cookie)).text();
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  const links = [...nav.matchAll(/href="(\/admin[^"]*)"/g)].map((match) => match[1]!);
  expect(links.length).toBeGreaterThan(15);
  for (const link of links) {
    const response = await get(f, link.replaceAll("&amp;", "&"), cookie);
    expect([200, 501]).toContain(response.status);
    if (response.status === 501) expect(await response.text()).toContain("not available yet");
  }
});

test("an unknown admin path is the admin error page, and assets still resolve", async () => {
  const missing = await get(f, "/admin/no-such-view", cookie);
  expect(missing.status).toBe(404);
  const html = await missing.text();
  expect(html).toContain("404 page not found");
  expect(html).toContain("/admin/static/oat.min.css");
  expect((await get(f, "/admin/static/style.css")).status).toBe(200);
  expect((await get(f, "/not-admin")).status).toBe(404);
  expect(await (await get(f, "/not-admin")).text()).not.toContain("404 page not found");
});

test("a stored site name reaches the page escaped", async () => {
  const settings = (await (await get(f, "/api/settings", cookie)).json()) as {
    data: Record<string, unknown>;
  };
  const hostile = '</title><script>globalThis.injected=1</script>"';
  const saved = await api(f, cookie, "/api/settings", "PUT", {
    ...settings.data,
    "app.site_name": hostile,
  });
  expect(saved.status).toBe(200);
  const html = await (await get(f, "/admin", cookie)).text();
  expect(html).not.toContain("<script>globalThis.injected");
  expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
});

test("a path that only begins like /admin is not an admin path", async () => {
  const response = await get(f, "/administrator", cookie);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("404 page not found");
});

test("the profile page offers a session user the second factor", async () => {
  const html = await (await get(f, "/admin/user/profile", cookie)).text();
  expect(html).toContain('x-data="profileView"');
  expect(html).toContain("Enable 2FA for additional security");
  expect(html).toContain('"user_id":"1"');
});
