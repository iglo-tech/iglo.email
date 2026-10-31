// The maintenance case is adapted from listmonk tests/specs/settings.spec.js at 6fcd95f; upstream has
// no analytics or logs spec. Each test makes its own data, so nothing relies on an empty database:
// the deletes leave other tests' subscribers alone only if those have lists, which they do here
// by running serially. Differences beside the cases, with their rows in 07-api-and-ui.md.
import { expect } from "@playwright/test";
import { PASSWORD, api, confirm, createUser, login, logout, test, unique } from "../helpers.js";

async function ok(page, path, method = "GET", body = undefined) {
  const res = await api(page, path, method, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}
const makeList = (page, optin = "single") =>
  ok(page, "/api/lists", "POST", { name: unique("maintenance"), type: "private", optin });
const makeSub = (page, lists, status = "enabled") =>
  ok(page, "/api/subscribers", "POST", {
    email: `${unique("maintenance")}@example.com`,
    name: "Maintenance",
    status,
    lists,
  });
const exists = async (page, id) => (await api(page, `/api/subscribers/${id}`)).status === 200;

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("deletes orphan and blocklisted subscribers", async ({ page }) => {
  const list = await makeList(page);
  const member = await makeSub(page, [list.id]);
  const blocked = await makeSub(page, [list.id], "blocklisted");
  const orphan = await makeSub(page, []);
  await page.goto("/admin/settings/maintenance");
  const subscribers = page.getByRole("group", { name: "Subscribers", exact: true });
  for (const type of ["blocklisted", "orphan"]) {
    await subscribers.getByRole("combobox", { name: "Data", exact: true }).selectOption(type);
    await subscribers.getByRole("button", { name: "Delete", exact: true }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/maintenance/subscribers/${type}`)),
      confirm(page),
    ]);
    expect(res.ok()).toBeTruthy();
    await expect(page.locator("ot-toast, .toast, [role=status]").first()).toContainText("deleted");
    expect(await exists(page, blocked.id)).toBe(false);
    expect(await exists(page, orphan.id)).toBe(type !== "orphan");
    expect(await exists(page, member.id)).toBe(true);
  }
});

test("deletes unconfirmed opt-ins older than a date", async ({ page }) => {
  const single = await makeList(page);
  const double = await makeList(page, "double");
  const waiting = await makeSub(page, [single.id, double.id]);
  await page.goto("/admin/settings/maintenance");
  const box = page.getByRole("group", { name: "Subscriptions", exact: true });
  await box.locator("input[type=date]").fill("2099-01-01");
  await box.getByRole("button", { name: "Delete", exact: true }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/maintenance/subscriptions/unconfirmed")),
    confirm(page),
  ]);
  const lists = (await ok(page, `/api/subscribers/${waiting.id}`)).lists.map((l) => l.id);
  expect(lists).toEqual([single.id]);
});

test("the export link follows the type and the date, and a bad date is refused", async ({
  page,
}) => {
  await page.goto("/admin/settings/maintenance");
  const box = page.getByRole("group", { name: "Analytics", exact: true });
  await box.locator("select").nth(1).selectOption("clicks");
  await box.locator("input[type=date]").nth(1).fill("2026-01-02");
  const href = await box.getByRole("link", { name: "Export" }).getAttribute("href");
  expect(href).toBe(
    `/api/maintenance/analytics/clicks/export?since=${encodeURIComponent("2026-01-02T00:00:00.000Z")}`,
  );
  const exported = await page.request.get(href);
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-disposition"]).toBe(
    "attachment; filename=campaign_clicks.csv",
  );
  const bad = await api(
    page,
    "/api/maintenance/subscriptions/unconfirmed?before_date=invalid",
    "DELETE",
  );
  expect(bad.status).toBe(400);
});

test("over the webhook budget the page shows the API's message and deletes nothing", async ({
  page,
}) => {
  // The route refuses before any write, so the fake answer stands for a real 400 here; the
  // production contract covers the real one, on 50,001 subscribers.
  await page.route("**/api/maintenance/subscribers/orphan", (route) =>
    route.fulfill({ status: 400, json: { message: "This action would queue too many." } }),
  );
  await page.goto("/admin/settings/maintenance");
  const box = page.getByRole("group", { name: "Subscribers", exact: true });
  await expect(box).toContainText("webhook deliveries");
  await box.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm(page);
  await expect(page.locator("body")).toContainText("This action would queue too many.");
});

test("the screens need their permissions", async ({ page }) => {
  const reader = await createUser(page, ["settings:get"]);
  await logout(page);
  await login(page, reader.username, PASSWORD);
  await page.goto("/admin/settings/logs");
  await expect(page.locator(".logs .page-title")).toHaveText("Logs");
  const denied = await page.goto("/admin/settings/maintenance");
  expect(denied.status()).toBe(403);
});

test("logs show as text and a refused read shows its message", async ({ page }) => {
  await page.route("**/api/logs", (route) =>
    route.fulfill({
      json: {
        data: [
          "2026/01/02 03:04:05.000000 *: <img src=x onerror=window.pwned=1> error sending",
          "not a parsed line",
        ],
      },
    }),
  );
  await page.goto("/admin/settings/logs");
  const lines = page.locator(".log-view .line");
  await expect(lines).toHaveCount(2);
  await expect(lines.first().locator(".timestamp")).toHaveText("2026/01/02 03:04:05.000000");
  await expect(lines.first().locator(".log-message")).toContainText("<img src=x");
  await expect(lines.first().locator(".log-message")).toHaveClass(/error/);
  await expect(page.locator(".log-view img")).toHaveCount(0);
  await page.unroute("**/api/logs");
  await page.route("**/api/logs", (route) =>
    route.fulfill({ status: 403, json: { message: "permission denied" } }),
  );
  await page.reload();
  await expect(page.getByTestId("error")).toHaveText("permission denied");
});

test("a real failure shows what failed, without what a campaign held", async ({ page }) => {
  const list = await makeList(page);
  const subscriber = await makeSub(page, [list.id]);
  const input = {
    name: unique("embeds"),
    subject: "S",
    lists: [list.id],
    type: "regular",
    content_type: "richtext",
    messenger: "email",
    body: '<img data-embed src="Ada%20Lovelace.png">',
    from_email: "Fixture <noreply@example.test>",
  };
  const campaign = await ok(page, "/api/campaigns", "POST", input);
  await ok(page, `/api/campaigns/${campaign.id}/test`, "POST", {
    ...input,
    subscribers: [subscriber.email],
  });
  await page.goto("/admin/settings/logs");
  await expect(page.getByTestId("logs-help")).toContainText("full error");
  await expect(page.locator(".log-view .line").last().locator(".log-message")).toHaveText(
    "inline image not embedded: no such media (Error)",
  );
  await expect(page.locator(".log-view")).not.toContainText("Lovelace");
});

test("an empty log says so", async ({ page }) => {
  await page.route("**/api/logs", (route) => route.fulfill({ json: { data: [] } }));
  await page.goto("/admin/settings/logs");
  await expect(page.getByTestId("no-logs")).toBeVisible();
});

async function makeCampaign(page, listID) {
  return ok(page, "/api/campaigns", "POST", {
    name: `<img src=x onerror=window.pwned=1> ${unique("analytics")}`,
    subject: "Analytics",
    lists: [listID],
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Body",
  });
}

test("campaign analytics reads its charts, with a real view", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const list = await makeList(page);
  const sub = await makeSub(page, [list.id]);
  const campaign = await makeCampaign(page, list.id);
  await page.request.get(`/campaign/${campaign.uuid}/${sub.uuid}/px.png`);
  await page.goto(`/admin/campaigns/analytics?id=${campaign.id}&from=2020-01-01&to=2099-01-01`);
  const views = page.getByTestId("chart-views");
  await expect(views.locator(".title")).toContainText("(1)");
  await expect(views.locator("canvas").first()).toBeVisible();
  await expect(views).toContainText(campaign.name);
  await expect(views.getByTestId("legend-count")).toHaveText("1");
  await expect(page.locator("ot-taginput .badge")).toContainText(campaign.name);
  await expect(page.getByTestId("chart-clicks")).toContainText("Nothing here");
  await expect(page.getByTestId("chart-subscriptions")).toHaveCount(0);
  await expect(page.locator(".analytics img")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("list analytics has the subscription chart, and a preset keeps the selection", async ({
  page,
}) => {
  const list = await makeList(page);
  await makeSub(page, [list.id]);
  await page.goto(`/admin/lists/analytics?id=${list.id}&from=2020-01-01&to=2099-01-01`);
  await expect(page.getByTestId("chart-subscriptions").locator(".title")).toContainText("(1)");
  await page.locator('[popovertarget="analytics-dates"]').click();
  await Promise.all([
    page.waitForURL(/interval=/),
    page.getByRole("menuitem", { name: "24 Hours" }).click(),
  ]);
  expect(new URL(page.url()).searchParams.getAll("id")).toEqual([String(list.id)]);
  await expect(page.getByTestId("chart-subscriptions").locator(".title")).toContainText("(1)");
});

test("a month preset counts from today, when the rounded end falls in the next month", async ({
  page,
}) => {
  const list = await makeList(page);
  await page.clock.setFixedTime(new Date("2026-10-31T23:59:30Z"));
  await page.goto(`/admin/lists/analytics?id=${list.id}`);
  await page.locator('[popovertarget="analytics-dates"]').click();
  await Promise.all([
    page.waitForURL(/interval=/),
    page.getByRole("menuitem", { name: "6 Months" }).click(),
  ]);
  const query = new URL(page.url()).searchParams;
  expect(query.get("from")).toMatch(/^2026-04-30T23:59/);
  expect(query.get("to")).toMatch(/^2026-11-01T00:00/);
});

for (const [status, message] of [
  [429, "Too many analytics reads in progress."],
  [422, "Analytics result too large. Narrow the range, the IDs or the interval."],
  [500, "Error fetching Analytics"],
]) {
  test(`a ${status} from the reader shows in its chart`, async ({ page }) => {
    const list = await makeList(page);
    const campaign = await makeCampaign(page, list.id);
    await page.route("**/api/campaigns/analytics/views*", (route) =>
      route.fulfill({ status, json: { message } }),
    );
    await page.goto(`/admin/campaigns/analytics?id=${campaign.id}`);
    await expect(page.getByTestId("chart-views").getByRole("alert")).toHaveText(message);
    await expect(page.getByTestId("chart-clicks").getByRole("alert")).toBeHidden();
  });
}

test("the selector suggests from the API and a missing item shows its message", async ({
  page,
}) => {
  const list = await makeList(page);
  const campaign = await makeCampaign(page, list.id);
  await page.goto("/admin/campaigns/analytics");
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled();
  const input = page.getByTestId("items");
  await input.click();
  await input.pressSequentially(campaign.name.slice(-12));
  await expect(page.locator("#analytics-items option").first()).toContainText(`#${campaign.id}:`);
  await page.goto("/admin/campaigns/analytics?id=999999999");
  await expect(page.getByTestId("error")).not.toBeEmpty();
  expect((await page.goto("/admin/campaigns/analytics?id=x")).status()).toBe(400);
});
