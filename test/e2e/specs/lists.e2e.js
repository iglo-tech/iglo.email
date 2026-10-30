// Adapted from listmonk tests/specs/lists.spec.js at 6fcd95f. Each group makes its own lists and
// reaches them through a run tag, where upstream resets the database; list counts and rows arrive
// from the API after the page, which Playwright's assertions wait for.
import { expect } from "@playwright/test";
import { api, confirm, login, openMenu, test, unique } from "../helpers.js";

const LISTS = "/admin/lists";

function listRow(page, name) {
  const rows = page.getByTestId("list-row");
  return name ? rows.filter({ hasText: name }) : rows;
}

function rowIDs(page) {
  return page.getByTestId("list-row").evaluateAll((els) => els.map((el) => Number(el.dataset.id)));
}

async function fillListForm(scope, { name, type, optin, tag, description } = {}) {
  await scope.locator('input[name="name"]').fill(name);
  await scope.locator('select[name="type"]').selectOption(type);
  await scope.locator('select[name="optin"]').selectOption(optin);
  if (tag) {
    const input = scope.locator('input[name="tags"]');
    await input.fill(tag);
    await input.press("Enter");
  }
  await scope.locator('textarea[name="description"]').fill(description);
}

async function withListAPI(page, method, action) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/lists(\/|\?|$)/.test(r.url()) && r.request().method() === method,
    ),
    action(),
  ]);
  expect(res.ok()).toBeTruthy();
}

async function makeList(page, overrides) {
  const created = await api(page, "/api/lists", "POST", {
    type: "private",
    optin: "single",
    ...overrides,
  });
  expect(created.status).toBe(200);
  return created.body.data;
}

async function allListIDs(page) {
  const ids = [];
  for (const status of ["active", "archived"]) {
    const { body } = await api(page, `/api/lists?status=${status}&per_page=100`);
    ids.push(...(body.data.results ?? []).map((l) => l.id));
  }
  return ids.sort((a, b) => a - b);
}

test.describe.configure({ mode: "serial" });

test.describe("Lists", () => {
  const run = unique("run");
  const here = `${LISTS}?tag=${run}`;
  const defaultList = `Default ${run}`;
  const optinList = `Optin ${run}`;
  let seeded = false;

  test.beforeEach(async ({ page }) => {
    await login(page);
    if (seeded) return;
    seeded = true;
    const first = await makeList(page, { name: defaultList, tags: [run, "test"] });
    const second = await makeList(page, {
      name: optinList,
      type: "public",
      optin: "double",
      tags: [run, "test"],
    });
    for (const [prefix, list] of [
      ["john", first],
      ["anon", second],
    ]) {
      const sub = await api(page, "/api/subscribers", "POST", {
        email: `${prefix}-${run}@example.com`,
        name: prefix,
        status: "enabled",
        lists: [list.id],
      });
      expect(sub.status).toBe(200);
    }
  });

  test("shows the lists and their subscriber counts", async ({ page }) => {
    await page.goto(here);

    await expect(listRow(page)).toHaveCount(2);
    await expect(listRow(page, defaultList).locator(".subscriber-total")).toContainText("1");
    await expect(listRow(page, optinList).locator(".subscriber-total")).toContainText("1");

    await expect(listRow(page, defaultList)).toContainText("Private");
    await expect(listRow(page, defaultList)).toContainText("Single opt-in");
    await expect(listRow(page, optinList)).toContainText("Public");
    await expect(listRow(page, optinList)).toContainText("Double opt-in");
  });

  // M4.3 ports the campaign form this link opens; the pre-selection is its case.
  test("links a list to a new campaign", async ({ page }) => {
    await page.goto(here);
    const row = listRow(page, defaultList);
    await openMenu(row);
    await expect(row.getByTestId("btn-campaign")).toHaveAttribute(
      "href",
      /\/admin\/campaigns\/new\?list_id=\d+$/,
    );
  });

  test("creates an opt-in campaign for a double opt-in list", async ({ page }) => {
    await page.goto(here);
    const row = listRow(page, optinList);
    await openMenu(row);
    await row.getByTestId("btn-send-optin-campaign").click();
    await confirm(page);

    await page.waitForURL(/\/admin\/campaigns\/\d+/);
    expect(page.url()).toContain("#tab=content");
  });

  test("shows the subscribers of each list", async ({ page }) => {
    const cases = [
      { list: defaultList, email: `john-${run}@example.com` },
      { list: optinList, email: `anon-${run}@example.com` },
    ];

    for (const c of cases) {
      await page.goto(here);
      await listRow(page, c.list).locator(".subscriber-total").click();

      await expect(page).toHaveURL(/\/admin\/subscribers\/lists\/\d+/);
      await expect(page.getByTestId("sub-row")).toHaveCount(1);
      await expect(page.locator("td.email")).toContainText(c.email);
    }
  });

  test("edits the lists", async ({ page }) => {
    await page.goto(here);
    await expect(listRow(page)).toHaveCount(2);
    const ids = await rowIDs(page);

    for (const [n, id] of ids.entries()) {
      await page.goto(`${LISTS}/${id}`);
      await page.getByRole("tab", { name: "Edit", exact: true }).click();
      await fillListForm(page, {
        name: `list-${run}-${n}`,
        type: "public",
        optin: "double",
        tag: `tag${n}`,
        description: `desc${n}`,
      });
      await withListAPI(page, "PUT", () => page.getByTestId("btn-save").click());
      await page.waitForEvent("load");
    }

    await page.goto(here);
    for (let n = 0; n < ids.length; n += 1) {
      const row = listRow(page, `list-${run}-${n}`);
      await expect(row).toContainText("Public");
      await expect(row).toContainText("Double opt-in");
      await expect(row).toContainText("#test");
      await expect(row).toContainText(`#tag${n}`);
    }

    for (const [n, id] of ids.entries()) {
      await page.goto(`${LISTS}/${id}`);
      await page.getByRole("tab", { name: "Edit", exact: true }).click();
      await expect(page.locator('textarea[name="description"]')).toHaveValue(`desc${n}`);
    }
  });

  test("deletes the lists", async ({ page }) => {
    await page.goto(here);
    await expect(listRow(page)).toHaveCount(2);

    let count = await listRow(page).count();
    while (count > 0) {
      const row = listRow(page).first();
      await openMenu(row);
      await row.getByTestId("btn-delete").click();
      await withListAPI(page, "DELETE", () => confirm(page));

      count -= 1;
      await expect(listRow(page)).toHaveCount(count);
    }

    await expect(page.locator(".empty-state")).toBeVisible();
  });
});

test.describe("Lists: filters and sorting", () => {
  const run = unique("run");
  const here = `${LISTS}?tag=${run}`;
  const name = (type, optin, n) => `${run}-${type}-${optin}-${n}`;
  let ids = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("adds new lists of every type/opt-in combination", async ({ page }) => {
    const combos = [
      { type: "private", optin: "single" },
      { type: "private", optin: "double" },
      { type: "public", optin: "single" },
      { type: "public", optin: "double" },
    ];

    for (const [n, c] of combos.entries()) {
      await page.goto(LISTS);
      await page.getByTestId("btn-new").click();

      await expect(page).toHaveURL(/\/admin\/lists\/new$/);
      const form = page.locator("section.lists form");
      await fillListForm(form, {
        name: name(c.type, c.optin, n),
        type: c.type,
        optin: c.optin,
        tag: run,
        description: `desc-${c.type}-${n}`,
      });
      await form.locator('input[name="tags"]').fill(`tag${n}${run}`);
      await form.locator('input[name="tags"]').press("Enter");
      await withListAPI(page, "POST", () => form.getByTestId("btn-save").click());
      await expect(page).toHaveURL(/\/admin\/lists\/\d+$/);
      await expect(
        page.getByRole("heading", { name: name(c.type, c.optin, n), exact: true }),
      ).toBeVisible();
      ids.push(Number(page.url().split("/").pop()));
      await page.goto(here);

      const row = listRow(page, name(c.type, c.optin, n));
      await expect(row).toBeVisible();
      await expect(row).toContainText(c.type === "private" ? "Private" : "Public");
      await expect(row).toContainText(c.optin === "single" ? "Single opt-in" : "Double opt-in");
    }
  });

  test("searches lists by name", async ({ page }) => {
    await page.goto(LISTS);

    await page.getByTestId("query").fill(name("public", "single", 2));
    await page.getByTestId("query").press("Enter");

    await expect(listRow(page)).toHaveCount(1);
    await expect(listRow(page)).toContainText(name("public", "single", 2));
  });

  const removeFilter = (page, text) =>
    page.locator(".filter-tag").filter({ hasText: text }).getByTestId("btn-remove-filter").click();

  test("filters lists by type", async ({ page }) => {
    await page.goto(here);

    // Upstream's row link holds this filter alone; the run tag stays in the URL here.
    await page.goto(`${here}&type=private`);
    await expect(listRow(page)).toHaveCount(2);
    await expect(listRow(page, name("private", "single", 0))).toBeVisible();
    await expect(listRow(page, name("private", "double", 1))).toBeVisible();

    await expect(page.locator(".page-heading")).toContainText("Private");
    await removeFilter(page, "Private");
    await expect(listRow(page)).toHaveCount(4);
  });

  test("a row's type and opt-in badges link to their filter", async ({ page }) => {
    await page.goto(here);
    const row = listRow(page, name("private", "single", 0));
    await expect(row.locator('a[href*="type="]')).toHaveAttribute("href", /[?&]type=private/);
    await expect(row.locator('a[href*="optin="]')).toHaveAttribute("href", /[?&]optin=single/);
  });

  test("filters lists by opt-in", async ({ page }) => {
    await page.goto(`${here}&optin=single`);

    await expect(listRow(page)).toHaveCount(2);
    await expect(listRow(page, name("private", "single", 0))).toBeVisible();
    await expect(listRow(page, name("public", "single", 2))).toBeVisible();

    await expect(page.locator(".page-heading")).toContainText("Single opt-in");
    await removeFilter(page, "Single opt-in");
    await expect(listRow(page)).toHaveCount(4);
  });

  test("filters lists by tag", async ({ page }) => {
    await page.goto(LISTS);
    await page.goto(here);

    await listRow(page, name("private", "single", 0))
      .locator(`a[href*="tag=tag0${run}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`[?&]tag=tag0${run}`));

    await expect(listRow(page)).toHaveCount(1);
    await expect(listRow(page, name("private", "single", 0))).toBeVisible();

    await expect(page.locator(".page-heading")).toContainText(`#${run}`);
    await page.goto(here);
    await expect(listRow(page)).toHaveCount(4);
  });

  test("filters lists by multiple criteria", async ({ page }) => {
    await page.goto(`${here}&type=public&optin=double`);

    await expect(listRow(page)).toHaveCount(1);
    await expect(listRow(page, name("public", "double", 3))).toBeVisible();

    await expect(page.locator(".page-heading")).toContainText("Public");
    await expect(page.locator(".page-heading")).toContainText("Double opt-in");
  });

  test("sorts lists by column", async ({ page }) => {
    await page.goto(here);
    await expect(listRow(page)).toHaveCount(4);
    const [a, b, c, d] = ids;

    const clickSort = async (field, expected) => {
      await page.locator(`a[data-sort-field="${field}"]`).click();
      await expect.poll(() => rowIDs(page)).toEqual(expected);
    };

    // Names sort as private-double, private-single, public-double, public-single.
    await clickSort("name", [b, a, d, c]);
    await clickSort("name", [c, d, a, b]);

    // As upstream, "type" is not a sort field: the listing falls back to created_at.
    await clickSort("type", [a, b, c, d]);
    await clickSort("type", [d, c, b, a]);

    await clickSort("created_at", [a, b, c, d]);
    await clickSort("created_at", [d, c, b, a]);
  });

  test("lists public lists on the public subscription form", async ({ page }) => {
    await page.goto("/subscription/form");

    const items = page.locator("ul.lists li");
    await expect(items.filter({ hasText: name("public", "single", 2) })).toContainText(
      "desc-public-2",
    );
    await expect(items.filter({ hasText: name("public", "double", 3) })).toContainText(
      "desc-public-3",
    );
    await expect(items.filter({ hasText: name("private", "single", 0) })).toHaveCount(0);
  });

  test("bulk deletes lists", async ({ page }) => {
    for (let i = 0; i < 30; i += 1) {
      await makeList(page, { name: `bulk-${run}-${i}`, type: "public", tags: [`bulk${run}`] });
    }

    await page.goto(`${LISTS}?tag=bulk${run}`);
    await expect(listRow(page)).toHaveCount(20);
    await page.locator('thead input[type="checkbox"]').check();
    await page.getByTestId("btn-bulk-actions").click();
    await page.getByTestId("select-all-lists").click();
    await withListAPI(page, "DELETE", async () => {
      await page.getByTestId("btn-delete-lists").click();
      await confirm(page);
    });
    await expect(page.locator(".empty-state")).toBeVisible();

    for (let i = 0; i < 5; i += 1) {
      await makeList(page, { name: `again-${run}-${i}`, type: "public", tags: [`bulk${run}`] });
    }

    await page.goto(`${LISTS}?tag=bulk${run}`);
    await expect(listRow(page)).toHaveCount(5);
    await page.locator('thead input[type="checkbox"]').check();
    await page.getByTestId("btn-bulk-actions").click();
    await withListAPI(page, "DELETE", async () => {
      await page.getByTestId("btn-delete-lists").click();
      await confirm(page);
    });
    await expect(page.locator(".empty-state")).toBeVisible();
  });
});

test.describe("Lists: filtered bulk deletion", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const { filter, unrelated } of [
    { filter: "", unrelated: [{ status: "archived" }] },
    { filter: "tag=target", unrelated: [{ tags: ["other"] }] },
    { filter: "type=private", unrelated: [{ type: "public" }] },
    { filter: "optin=single", unrelated: [{ optin: "double" }] },
    { filter: "status=archived", unrelated: [{ status: "active" }] },
    { filter: "query=Bulk", unrelated: [{ name: "Other" }] },
    {
      filter: "query=Bulk&tag=target&tag=news&type=private&optin=single",
      unrelated: [
        { name: "Other" },
        { tags: ["target"] },
        { type: "public" },
        { optin: "double" },
        { status: "archived" },
      ],
    },
  ]) {
    test(`preserves unrelated lists when deleting all with ${filter || "default active status"}`, async ({
      page,
    }) => {
      // Every list goes first, as upstream's reset: the "all" selection spans the database.
      expect((await api(page, "/api/lists?all=true", "DELETE")).status).toBe(200);
      expect((await api(page, "/api/lists?all=true&status=archived", "DELETE")).status).toBe(200);
      const preserved = [];
      for (const overrides of [...unrelated, ...Array.from({ length: 22 }, () => ({}))]) {
        const list = await makeList(page, {
          name: "Bulk list",
          status: filter === "status=archived" ? "archived" : "active",
          tags: ["target", "news"],
          ...overrides,
        });
        if (Object.keys(overrides).length) preserved.push(list.id);
      }
      await page.goto(`${LISTS}?${filter}`);
      await page.locator("thead input[type=checkbox]").check();
      await page.getByTestId("btn-bulk-actions").click();
      await page.getByTestId("select-all-lists").click();
      await withListAPI(page, "DELETE", async () => {
        await page.getByTestId("btn-delete-lists").click();
        await confirm(page);
      });
      await expect(page.locator(".empty-state")).toBeVisible();
      expect(await allListIDs(page)).toEqual(preserved.sort((a, b) => a - b));
    });
  }
});
