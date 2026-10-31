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

test("each screen arrives with its module", async () => {
  for (const [path, script, marker] of [
    ["/admin/sequences", "sequences", 'x-data="sequencesView"'],
    ["/admin/sequences/new", "sequences", 'x-data="sequenceForm"'],
    ["/admin/sequences/7", "sequences", 'data-testid="btn-test-mode"'],
    ["/admin/sequences/enrollments", "enrollments", 'x-data="enrollmentsView"'],
    ["/admin/sequences/enrollments/7", "enrollments", 'data-testid="timeline"'],
    ["/admin/subscribers/7/events", "subscribers", "event-row"],
    ["/admin/subscribers/7/enrollments", "subscribers", "enrollment-row"],
    ["/admin/subscribers/7/sends", "subscribers", "send-row"],
  ] as const) {
    const response = await get(f, path, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`/admin/static/js/views/${script}.js?v=`);
    expect(html).toContain(marker);
  }
});

test("the test dialog says it sends real mail and what it needs", async () => {
  const html = await (await get(f, "/admin/sequences/7", cookie)).text();
  expect(html).toContain("sends real mail to this subscriber");
  expect(html).toContain("not blocklisted");
});

test("the timeline says why a step without a send is not listed", async () => {
  const html = await (await get(f, "/admin/sequences/enrollments/7", cookie)).text();
  expect(html).toContain("Only sends are recorded");
  expect(html).toContain("its outcome is unknown");
  expect(html).not.toContain("its condition was false");
});

test("each route asks for its endpoint's permission", async () => {
  const none = await userWith(f, cookie, "m55-nothing", ["lists:get_all"]);
  for (const path of [
    "/admin/sequences",
    "/admin/sequences/new",
    "/admin/sequences/7",
    "/admin/sequences/enrollments",
    "/admin/sequences/enrollments/7",
    "/admin/subscribers/7/events",
    "/admin/subscribers/7/enrollments",
    "/admin/subscribers/7/sends",
  ])
    expect((await get(f, path, none)).status).toBe(403);

  const reader = await userWith(f, cookie, "m55-reader", ["sequences:get"]);
  const screen = await get(f, "/admin/sequences", reader);
  expect(screen.status).toBe(200);
  const html = await screen.text();
  expect(html).toContain('href="/admin/sequences/enrollments"');
  expect(html).not.toContain('data-testid="btn-new"');
  expect((await get(f, "/admin/sequences/new", reader)).status).toBe(403);
  const editor = await (await get(f, "/admin/sequences/7", reader)).text();
  expect(editor).not.toContain('data-testid="btn-save"');
  expect(editor).not.toContain('data-testid="btn-test-mode"');

  // A subscriber reader reaches only the tabs its other permissions allow.
  const subscribers = await userWith(f, cookie, "m55-subs", ["subscribers:get_all"]);
  expect((await get(f, "/admin/subscribers/7/events", subscribers)).status).toBe(200);
  expect((await get(f, "/admin/subscribers/7/enrollments", subscribers)).status).toBe(403);
  expect((await get(f, "/admin/subscribers/7/sends", subscribers)).status).toBe(403);
  const tabs = await (await get(f, "/admin/subscribers/7", subscribers)).text();
  expect(tabs).toContain('href="/admin/subscribers/7/events"');
  expect(tabs).not.toContain('href="/admin/subscribers/7/sends"');
  // The navigation offers nothing without the permission.
  expect(tabs).not.toContain("/admin/sequences");
});

test("raw SQL examples appear only for those who may save them", async () => {
  const manager = await userWith(f, cookie, "m55-manager", ["sequences:get", "sequences:manage"]);
  expect(await (await get(f, "/admin/sequences/7", manager)).text()).toContain(
    "subscribers:sql_query permission",
  );
  expect(await (await get(f, "/admin/sequences/7", cookie)).text()).toContain("Raw SQL");
});

test("a filter in the URL arrives escaped", async () => {
  const hostile = encodeURIComponent(`"><img src=x onerror=alert(1)>`);
  const html = await (
    await get(f, `/admin/sequences?status=${hostile}&page=${hostile}`, cookie)
  ).text();
  expect(html).not.toContain("<img src=x");
  expect((await get(f, "/admin/sequences/enrollments/x", cookie)).status).toBe(400);
});
