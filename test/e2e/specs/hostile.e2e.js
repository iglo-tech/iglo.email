// Stored names and URL parameters render as text on every screen of M4.2. listmonk has no such
// spec at 6fcd95f; this reads each page in the browser, with an error and a marker in `window` as
// the proof that nothing ran.
import { expect } from "@playwright/test";
import { api, confirm, login, openMenu, test, unique } from "../helpers.js";

const hostile = (kind) =>
  `<img src=x onerror="window.pwned='${kind}'"> "'\` {{ 7*7 }} \${7*7} x-on:click="window.pwned=1" x-html=x @click=y ${unique(kind)}`;

test("hostile names render as text on every screen", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);

  const listName = hostile("list");
  const tag = `<b>${unique("tag")}</b>'"`;
  const description = hostile("description");
  const created = await api(page, "/api/lists", "POST", {
    name: listName,
    type: "public",
    optin: "double",
    tags: [tag],
    description,
  });
  expect(created.status).toBe(200);
  const list = created.body.data;
  const subName = hostile("subscriber");
  const email = `${unique("hostile")}@example.com`;
  const attribute = hostile("attribute");
  const sub = await api(page, "/api/subscribers", "POST", {
    email,
    name: subName,
    status: "enabled",
    lists: [list.id],
    attribs: { note: attribute },
  });
  expect(sub.status).toBe(200);
  const id = sub.body.data.id;

  const clean = async () => {
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    expect(
      await page.locator("section.subscribers img, section.lists img, section b").count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  };

  // The listing shows both names and the description as they are.
  await page.goto(`/admin/subscribers?search=${encodeURIComponent(email)}`);
  const row = page.getByTestId("sub-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator("td.name")).toHaveText(subName);
  await expect(row.locator(".lists a.avatar-label")).toHaveText(listName);
  await clean();

  await page.goto(`/admin/subscribers/lists/${list.id}`);
  await expect(page.locator(".page-heading .avatar-label")).toHaveText(listName);
  await clean();

  await page.goto(`/admin/subscribers/${id}`);
  await expect(page.locator(".activity strong").first()).toHaveText(subName);
  await clean();

  await page.goto(`/admin/subscribers/${id}/edit`);
  await expect(page.locator("input[name=name]")).toHaveValue(subName);
  expect(await page.locator("textarea[name=attribs]").inputValue()).toContain("window.pwned");
  await clean();

  await page.goto(`/admin/subscribers/${id}/lists`);
  await expect(page.locator(".subscriptions .avatar-label a")).toHaveText(listName);
  await clean();

  await page.goto(`/admin/subscribers/${id}/bounces`);
  await expect(page.getByRole("tab", { name: "Bounces" })).toHaveAttribute("aria-selected", "true");
  await clean();

  await page.goto(`/admin/lists?query=${encodeURIComponent(listName.slice(-14))}`);
  const listRow = page.getByTestId("list-row");
  await expect(listRow).toHaveCount(1);
  await expect(listRow.locator(".list-name .avatar-label a").first()).toHaveText(listName);
  await expect(listRow.locator(".description")).toHaveText(description);
  await expect(listRow.locator(`a[title$="${tag.replaceAll('"', '\\"')}"]`)).toHaveText(`#${tag}`);
  await clean();

  await page.goto(`/admin/lists/${list.id}`);
  await expect(page.getByRole("heading", { name: listName, exact: true })).toBeVisible();
  await clean();

  await page.goto(`/admin/lists/${list.id}/edit`);
  await expect(page.locator('input[name="name"]')).toHaveValue(listName);
  await expect(page.locator('textarea[name="description"]')).toHaveValue(description);
  await expect(page.locator("ot-taginput .badge")).toContainText(tag);
  await clean();

  // A row action carries the hostile name through a handler and into a confirmation.
  await page.goto(`/admin/lists?query=${encodeURIComponent(listName.slice(-14))}`);
  await openMenu(listRow);
  await listRow.getByTestId("btn-delete").click();
  await confirm(page);
  await expect(page.locator(".toast")).toContainText(listName);
  await clean();
});

test("hostile URL parameters stay in their attributes", async ({ page }) => {
  await login(page);
  const value = `"><img src=x onerror="window.pwned=1">{{7*7}}`;
  const q = encodeURIComponent(value);
  for (const path of [
    `/admin/subscribers?search=${q}&status=${q}&subscription_status=${q}&order_by=${q}&extra=${q}`,
    `/admin/lists?query=${q}&type=${q}&optin=${q}&tag=${q}&order_by=${q}&extra=${q}`,
  ]) {
    await page.goto(path);
    await expect(page.locator(".page-heading")).toContainText(value);
    expect(await page.locator("section img").count()).toBe(0);
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  }
});
