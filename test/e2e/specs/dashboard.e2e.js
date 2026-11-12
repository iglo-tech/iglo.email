// listmonk has no dashboard spec at 6fcd95f; this follows views/dashboard.html, with its data
// made through the public API and read back from the screen.
import { expect } from "@playwright/test";
import { PASSWORD, api, login, logout, unique, test, signIn } from "../helpers.js";

const hostile = `<img src=x onerror="window.pwned=1"> ${unique("Launch")}`;

// The dashboard shows counts with thousands separators ("2,738"), and a server is shared by the
// spec files that run on it, so a count can pass 1000. The shown digits are compared with the
// API total, not the text: no locale-dependent formatting is used here.
async function expectShownCount(locator, total) {
  await expect
    .poll(async () => {
      const digits = ((await locator.textContent()) ?? "").replace(/\D/g, "");
      return digits === "" ? null : Number(digits);
    })
    .toBe(Number(total));
}

async function makeCampaign(page, name, listId) {
  const created = await api(page, "/api/campaigns", "POST", {
    name,
    subject: "Hello",
    lists: [listId],
    from_email: "e2e@example.test",
    content_type: "richtext",
    messenger: "email",
    type: "regular",
    body: "<p>Hello</p>",
  });
  expect(created.status).toBe(200);
  return created.body.data;
}

test.describe("Dashboard", () => {
  test("shows counts, charts, system stats and escaped campaign names", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page);
    const list = await api(page, "/api/lists", "POST", {
      name: unique("List"),
      type: "public",
      optin: "single",
    });
    expect(list.status).toBe(200);
    const campaign = await makeCampaign(page, hostile, list.body.data.id);

    const counts = (await api(page, "/api/dashboard/counts")).body.data;
    await page.goto("/admin");
    await expectShownCount(page.getByTestId("stat-lists"), counts.lists.total ?? 0);
    await expectShownCount(page.getByTestId("stat-subscribers"), counts.subscribers.total ?? 0);
    await expectShownCount(page.getByTestId("stat-campaigns"), counts.campaigns.total ?? 0);
    await expectShownCount(page.getByTestId("stat-messages"), counts.messages ?? 0);

    const row = page.getByTestId("campaign-row").filter({ hasText: hostile });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: hostile, exact: true }).last()).toHaveAttribute(
      "href",
      `/admin/campaigns/${campaign.id}`,
    );
    await expect(row.getByText("Draft")).toBeVisible();
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();

    // Earlier specs on this server may have recorded views (the order of spec files is not fixed),
    // so the screen is checked against what the charts API holds; the empty state has its own test.
    const charts = (await api(page, "/api/dashboard/charts")).body.data;
    const views = page.locator(".chart-box").nth(0);
    if (charts.campaign_views.some((day) => day.count > 0)) {
      await expect(views.locator("canvas")).toBeVisible();
      await expect(views.getByText("Nothing here")).toHaveCount(0);
    }
    const system = page.getByTestId("system");
    await expect(system.getByText("Uptime")).toBeVisible();
    await expect(system.getByText("CPU cores")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("empty charts show the empty state, whatever the server holds", async ({ page }) => {
    await signIn(page);
    // The charts API answers with no data: the state belongs to this test, at any stack count.
    await page.route("**/api/dashboard/charts", (route) =>
      route.fulfill({
        json: { data: { campaign_views: [], link_clicks: [] } },
      }),
    );
    await page.goto("/admin");
    await expect(page.locator(".chart-box").nth(0).getByText("Nothing here")).toBeVisible();
    await expect(page.locator(".chart-box").nth(1).getByText("Nothing here")).toBeVisible();
  });

  test("a scoped role sees only the campaigns of its lists", async ({ page }) => {
    await signIn(page);
    const mine = await api(page, "/api/lists", "POST", {
      name: unique("Mine"),
      type: "private",
      optin: "single",
    });
    const other = await api(page, "/api/lists", "POST", {
      name: unique("Other"),
      type: "private",
      optin: "single",
    });
    const visible = unique("Visible campaign");
    const hidden = unique("Hidden campaign");
    await makeCampaign(page, visible, mine.body.data.id);
    await makeCampaign(page, hidden, other.body.data.id);
    const listRole = await api(page, "/api/roles/lists", "POST", {
      name: unique("scope"),
      lists: [{ id: mine.body.data.id, permissions: ["list:get"] }],
    });
    expect(listRole.status).toBe(200);
    const role = await api(page, "/api/roles/users", "POST", {
      name: unique("viewer"),
      permissions: ["campaigns:get"],
    });
    const username = unique("viewer");
    const user = await api(page, "/api/users", "POST", {
      username,
      email: `${username}@example.test`,
      name: username,
      type: "user",
      status: "enabled",
      password_login: true,
      password: PASSWORD,
      password2: PASSWORD,
      user_role_id: role.body.data.id,
      list_role_id: listRole.body.data.id,
    });
    expect(user.status).toBe(200);
    await logout(page);

    await login(page, username, PASSWORD);
    await expect(page.getByTestId("campaign-row").filter({ hasText: visible })).toBeVisible();
    await expect(page.getByTestId("campaign-row").filter({ hasText: hidden })).toHaveCount(0);
    await expect(page.locator('a[title="Analytics"]')).toHaveCount(0);
  });

  test("a queued read leaves the page usable and a refused one is a message", async ({ page }) => {
    await signIn(page);
    let release;
    const queued = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/dashboard/counts", async (route) => {
      await queued;
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ message: "Too many analytics reads in progress." }),
      });
    });
    await page.route("**/api/dashboard/charts", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Analytics result too large. Narrow the range, the IDs or the interval.",
        }),
      }),
    );

    await page.goto("/admin");
    await expect(page.getByTestId("stat-lists")).toHaveText("-");
    await expect(page.locator('section[aria-busy="true"]')).toHaveCount(1);
    await expect(page.getByTestId("chartsError")).toHaveText(/Analytics result too large/);
    await expect(page.getByTestId("campaign-row").first()).toBeVisible();
    await expect(page.getByTestId("countsError")).toBeHidden();

    release();
    await expect(page.getByTestId("countsError")).toHaveText(
      "Too many analytics reads in progress.",
    );
    await expect(page.locator('section[aria-busy="true"]')).toHaveCount(0);
  });
});
