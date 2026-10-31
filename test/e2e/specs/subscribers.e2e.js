// Adapted from listmonk tests/specs/subscribers.spec.js at 6fcd95f. `reset` empties the subscribers
// and lists through the API and makes the two lists and two subscribers upstream's resetDB seeds,
// with generated IDs. Mail goes to the sink. Rows arrive after the page, so totals are polled.
// Upstream's Domain blocklist group and its activity charts and stats have no screen here; see the
// PR. The advanced query cases use SQLite's dialect: subscribers.attribs ->> with no ::BOOLEAN.
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import {
  ORIGIN,
  api,
  confirm,
  login,
  mailFor,
  openMenu,
  selectList,
  test,
  unique,
} from "../helpers.js";

const SUBSCRIBERS = "/admin/subscribers";
const SUB_NAMES = { john: "john@example.com", anon: "anon@example.com" };

function subRow(page, text) {
  const rows = page.getByTestId("sub-row");
  return text ? rows.filter({ hasText: text }) : rows;
}

function subRowIDs(page) {
  return page.getByTestId("sub-row").evaluateAll((els) => els.map((el) => Number(el.dataset.id)));
}

// The (filtered) total the listing header shows, e.g. "Subscribers (47)".
const expectTotal = (page, n) =>
  expect(page.locator(".page-title")).toContainText(new RegExp(`\\(${n}\\)`));

async function data(result) {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.data;
}

async function reset(page) {
  for (const uri of ["/api/lists?all=true", "/api/lists?all=true&status=archived"])
    await data(await api(page, uri, "DELETE"));
  await data(await api(page, "/api/subscribers/query/delete", "POST", { all: true }));
  const list = (name, type, optin) =>
    api(page, "/api/lists", "POST", { name, type, optin, tags: ["test"] }).then(data);
  const defaultList = await list("Default list", "private", "single");
  const optinList = await list("Opt-in list", "public", "double");
  const subscriber = (email, name, lists, attribs) =>
    api(page, "/api/subscribers", "POST", {
      email,
      name,
      status: "enabled",
      lists,
      attribs,
    }).then(data);
  const john = await subscriber(SUB_NAMES.john, "John Doe", [defaultList.id], {
    city: "Bengaluru",
    good: true,
  });
  const anon = await subscriber(SUB_NAMES.anon, "Anon Doe", [optinList.id], {
    city: "Bengaluru",
    good: true,
  });
  return { LIST_DEFAULT: defaultList.id, LIST_OPTIN: optinList.id, JOHN: john.id, ANON: anon.id };
}

async function seedSubscribers(page, n, { prefix = "seed", lists = [], status = "enabled" } = {}) {
  for (let i = 0; i < n; i += 1) {
    await data(
      await api(page, "/api/subscribers", "POST", {
        email: `${prefix}${i}@example.com`,
        name: `${prefix} ${i}`,
        status,
        lists,
        attribs: { city: "Bengaluru", age: 20 + (i % 40) },
      }),
    );
  }
}

// Select rows and open the bulk-actions menu. With selectAll, promote the visible
// selection to the whole query (needs total > per-page for the button to render).
async function openBulkMenu(page, { selectAll = false } = {}) {
  await expect(subRow(page).first()).toBeVisible();
  await page.locator("thead input[type=checkbox]").check();
  await page.getByTestId("btn-bulk-actions").click();
  if (selectAll) {
    await page.getByTestId("select-all-subscribers").click();
  }
}

async function bulkManageLists(page, { action, lists, preconfirm = false, selectAll = false }) {
  await openBulkMenu(page, { selectAll });
  await page.getByTestId("btn-manage-lists").click();

  const dialog = page.locator("dialog[open]");
  await dialog.getByTestId(`check-list-${action}`).check();
  for (const l of lists) {
    await selectList(dialog, l);
  }
  if (preconfirm) {
    await dialog.getByTestId("preconfirm").check();
  }

  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/subscribers(\/query)?\/lists/.test(r.url()) && r.request().method() === "PUT",
    ),
    page.waitForEvent("load"),
    dialog.locator("button[type=submit]").click(),
  ]);
}

// Trigger a confirm-guarded bulk action and wait for its API call.
async function bulkConfirm(page, { testid, selectAll = false, match }) {
  await openBulkMenu(page, { selectAll });
  await page.getByTestId(testid).click();
  await Promise.all([page.waitForResponse(match), page.waitForEvent("load"), confirm(page)]);
}

async function exportSelection(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByTestId("btn-export-subscribers").click();
      await confirm(page);
    })(),
  ]);
  return download;
}

test.describe.configure({ mode: "serial" });

test.describe("Subscribers: listing, search & sort", () => {
  let seed;
  test.beforeEach(async ({ page }) => {
    await login(page);
    seed ??= await reset(page);
  });

  test("shows the two seeded subscribers", async ({ page }) => {
    await page.goto(SUBSCRIBERS);

    await expect(subRow(page)).toHaveCount(2);
    await expect(subRow(page, SUB_NAMES.john)).toBeVisible();
    await expect(subRow(page, SUB_NAMES.anon)).toBeVisible();
  });

  test("searches subscribers", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    const search = page.getByTestId("search");

    for (const c of [
      { q: "john", email: SUB_NAMES.john },
      { q: "anon", email: SUB_NAMES.anon },
    ]) {
      await search.fill(c.q);
      await search.press("Enter");
      await expect(subRow(page)).toHaveCount(1);
      await expect(subRow(page)).toContainText(c.email);
    }

    await search.fill("");
    await search.press("Enter");
    await expect(subRow(page)).toHaveCount(2);
  });

  test("runs advanced SQL queries", async ({ page }) => {
    const cases = [
      { sql: "subscribers.attribs->>'city'='Bengaluru'", count: 2 },
      { sql: `subscribers.attribs->>'city'='Bengaluru' AND id=${seed.JOHN}`, count: 1 },
      { sql: "subscribers.attribs->>'good' = 1 AND name like 'Anon%'", count: 1 },
    ];

    for (const c of cases) {
      await page.goto(SUBSCRIBERS);
      await page.getByTestId("btn-advanced-search").click();
      await page.getByTestId("query").fill(c.sql);
      await Promise.all([page.waitForURL(/query=/), page.getByTestId("btn-query").click()]);
      await expect(subRow(page)).toHaveCount(c.count);
    }
  });

  test("shows an API refusal of a query as a message", async ({ page }) => {
    await page.goto(`${SUBSCRIBERS}?query=${encodeURIComponent("no_such_column = 1")}`);
    await expect(page.getByTestId("error")).toContainText("Error preparing subscriber query");
    await expect(page.locator(".empty-state")).toBeHidden();
  });

  test("resets the advanced query editor", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await page.getByTestId("btn-advanced-search").click();

    const query = page.getByTestId("query");
    await query.fill("name LIKE '%x%'");
    await expect(page.getByTestId("btn-query-reset")).toBeEnabled();

    await page.getByTestId("btn-query-reset").click();
    await expect(query).toHaveValue("");
    await expect(page.getByTestId("btn-query-reset")).toBeDisabled();
  });

  test("sorts subscribers by every column", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await expect(subRow(page)).toHaveCount(2);

    const clickSort = async (field, expected) => {
      await page.locator(`a[data-sort-field="${field}"]`).click();
      await expect.poll(() => subRowIDs(page)).toEqual(expected);
    };
    const { JOHN, ANON } = seed;

    await clickSort("email", [ANON, JOHN]);
    await clickSort("email", [JOHN, ANON]);
    await clickSort("name", [ANON, JOHN]);
    await clickSort("name", [JOHN, ANON]);
    await clickSort("created_at", [JOHN, ANON]);
    await clickSort("created_at", [ANON, JOHN]);
    await clickSort("updated_at", [JOHN, ANON]);
    await clickSort("updated_at", [ANON, JOHN]);
  });

  test("exports subscribers via the API", async ({ page }) => {
    const cases = [
      { query: "", length: 3 },
      { query: "name LIKE '%anon%'", length: 2 },
      { query: "name like 'nope'", length: 1 },
    ];

    for (const c of cases) {
      const res = await page.request.get("/api/subscribers/export", { params: { query: c.query } });
      expect(res.ok()).toBeTruthy();
      const lines = (await res.text()).trim().split("\n");
      expect(lines).toHaveLength(c.length);
    }
  });
});

test.describe("Subscribers: create, edit & delete", () => {
  let seed;
  test.beforeEach(async ({ page }) => {
    await login(page);
    seed ??= await reset(page);
  });

  test("creates a subscriber on a list", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await page.getByTestId("btn-new").click();

    await expect(page).toHaveURL(/\/admin\/subscribers\/new$/);
    const form = page.locator("section.subscribers form");
    await form.locator("input[name=email]").fill("created@example.com");
    await form.locator("input[name=name]").fill("Created");
    await selectList(form, "Default list");
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/subscribers$/.test(r.url()) && r.request().method() === "POST",
      ),
      form.getByTestId("btn-save").click(),
    ]);
    // The page moves on to the list by itself; a goto during that move is aborted.
    await page.waitForURL(/\/admin\/subscribers$/);

    await page.goto(SUBSCRIBERS);
    const row = subRow(page, "created@example.com");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Default list");
    await expect(row.locator(".lists a.avatar-label")).toHaveText(["Default list"]);
  });

  test("creates a pre-confirmed subscriber on a double opt-in list", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await page.getByTestId("btn-new").click();

    await expect(page).toHaveURL(/\/admin\/subscribers\/new$/);
    const form = page.locator("section.subscribers form");
    await form.locator("input[name=email]").fill("confirmed@example.com");
    await form.locator("input[name=name]").fill("Confirmed");
    await selectList(form, "Opt-in list");
    await expect(form.getByTestId("preconfirm")).toBeEnabled();
    await form.getByTestId("preconfirm").check();
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/subscribers$/.test(r.url()) && r.request().method() === "POST",
      ),
      form.getByTestId("btn-save").click(),
    ]);

    await page.goto(SUBSCRIBERS);
    const row = subRow(page, "confirmed@example.com");
    await expect(row).toContainText("Opt-in list");
    await expect(
      row.getByRole("link", { name: "View Opt-in list: Confirmed", exact: true }),
    ).toBeVisible();
  });

  test("edits a subscriber and blocklists via the status field", async ({ page }) => {
    await page.goto(`${SUBSCRIBERS}/${seed.JOHN}/edit`);
    await page.locator("input[name=email]").fill("edited@example.com");
    await page.locator("input[name=name]").fill("Edited Name");
    await page.locator("select[name=status]").selectOption("blocklisted");
    await page
      .locator("textarea[name=attribs]")
      .fill('{"string": "hello", "ints": [1, 2, 3], "sub": {"bool": true}}');
    await Promise.all([page.waitForEvent("load"), page.getByTestId("btn-save").click()]);
    await expect(page.locator("input[name=email]")).toHaveValue("edited@example.com");
    await expect(page.locator("input[name=name]")).toHaveValue("Edited Name");
    await expect(page.locator("select[name=status]")).toHaveValue("blocklisted");
    const attribs = await page.locator("textarea[name=attribs]").inputValue();
    expect(attribs).toContain('"string": "hello"');
    expect(attribs).toContain('"bool": true');

    await page.goto(SUBSCRIBERS);
    await expect(subRow(page, "edited@example.com")).toHaveClass(/blocklisted/);
  });

  test("rejects invalid attribs JSON", async ({ page }) => {
    await page.goto(`${SUBSCRIBERS}/${seed.JOHN}/edit`);
    await page.locator("textarea[name=attribs]").fill("{ not valid json");
    await page.getByTestId("btn-save").click();

    await expect(page.locator(".toast")).toBeVisible();
    expect(page.url()).toContain(`${SUBSCRIBERS}/${seed.JOHN}/edit`);
  });

  test("shows a rejected save as a message", async ({ page }) => {
    await page.goto(`${SUBSCRIBERS}/${seed.ANON}/edit`);
    await page.locator("input[name=email]").fill("confirmed@example.com");
    await page.getByTestId("btn-save").click();

    await expect(page.locator(".toast")).toContainText("E-mail already exists");
    expect(page.url()).toContain(`${SUBSCRIBERS}/${seed.ANON}/edit`);
  });

  test("exposes a per-row data download link", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    const row = subRow(page, SUB_NAMES.anon);
    await openMenu(row);
    await expect(row.getByTestId("btn-download")).toHaveAttribute(
      "href",
      new RegExp(`/api/subscribers/${seed.ANON}/export$`),
    );
    const res = await page.request.get(`/api/subscribers/${seed.ANON}/export`);
    expect((await res.json()).profile[0].name).toBe(SUB_NAMES.anon);
  });

  test("deletes a subscriber from the row menu", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    const row = subRow(page, "created@example.com");
    await expect(row).toBeVisible();
    const before = await subRow(page).count();

    await openMenu(row);
    await row.getByTestId("btn-delete").click();
    await confirm(page);

    await expect(subRow(page)).toHaveCount(before - 1);
    await expect(subRow(page, "created@example.com")).toHaveCount(0);
  });
});

test.describe("Subscribers: filters & pagination", () => {
  let seed;
  test.beforeEach(async ({ page }) => {
    await login(page);
    if (seed) return;
    seed = await reset(page);
    // 25 on the Default list → 27 total, spanning two pages.
    await seedSubscribers(page, 25, { prefix: "pag", lists: [seed.LIST_DEFAULT] });
  });

  test("paginates the listing", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await expect(subRow(page)).toHaveCount(20);

    const nav = page.locator("nav.pagination");
    await expect(nav).toBeVisible();
    await Promise.all([page.waitForURL(/[?&]page=2/), nav.locator("a", { hasText: "2" }).click()]);

    await expect(subRow(page)).toHaveCount(7);
    await expect(nav.locator("a.pg-selected")).toHaveText("2");
  });

  test("filters by list", async ({ page }) => {
    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}`);
    await expect(subRow(page)).toHaveCount(1);
    await expect(subRow(page, SUB_NAMES.anon)).toBeVisible();
    await expect(page.locator(".page-heading")).toContainText("Opt-in list");

    await Promise.all([
      page.waitForURL(/\/admin\/subscribers$/),
      page.getByTestId("btn-remove-filter").click(),
    ]);
  });

  test("filters by subscriber status", async ({ page }) => {
    await data(await api(page, "/api/subscribers/blocklist", "PUT", { ids: [seed.JOHN] }));

    await page.goto(`${SUBSCRIBERS}?status=blocklisted`);
    await expect(subRow(page)).toHaveCount(1);
    await expect(subRow(page, SUB_NAMES.john)).toBeVisible();
    await expect(page.locator(".page-heading")).toContainText("Blocklisted");
  });

  test("filters a list by subscription status", async ({ page }) => {
    await data(
      await api(page, "/api/subscribers/lists", "PUT", {
        ids: [seed.ANON],
        action: "add",
        target_list_ids: [seed.LIST_OPTIN],
        status: "confirmed",
      }),
    );

    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}?subscription_status=confirmed`);
    await expect(page.locator(".page-heading")).toContainText("Confirmed");
    await expect(subRow(page)).toHaveCount(1);
    await expect(
      subRow(page, SUB_NAMES.anon).getByRole("link", {
        name: "View Opt-in list: Confirmed",
        exact: true,
      }),
    ).toBeVisible();
  });
});

test.describe("Subscribers: bulk actions", () => {
  let seed;
  test.beforeEach(async ({ page }) => {
    await login(page);
    if (seed) return;
    seed = await reset(page);
    // 45 fresh subscribers → 47 total, spanning three pages.
    await seedSubscribers(page, 45, { prefix: "bulk" });
  });

  test("adds a list to the selected (visible) page", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await expect(subRow(page)).toHaveCount(20);

    await bulkManageLists(page, { action: "add", lists: ["Default list"] });

    await expect(subRow(page)).toHaveCount(20);
    await expect(subRow(page).filter({ hasText: "Default list" })).toHaveCount(20);
  });

  test("adds a pre-confirmed list to all via select-all query", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await bulkManageLists(page, {
      action: "add",
      lists: ["Opt-in list"],
      preconfirm: true,
      selectAll: true,
    });

    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}`);
    await expectTotal(page, 47);
    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}?subscription_status=confirmed`);
    await expectTotal(page, 46);
  });

  test("unsubscribes all from a list via query", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await bulkManageLists(page, {
      action: "unsubscribe",
      lists: ["Opt-in list"],
      selectAll: true,
    });

    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}?subscription_status=unsubscribed`);
    await expectTotal(page, 47);
  });

  test("removes a list from all via query", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await bulkManageLists(page, { action: "remove", lists: ["Opt-in list"], selectAll: true });

    await page.goto(`${SUBSCRIBERS}/lists/${seed.LIST_OPTIN}`);
    await expect(page.locator(".empty-state")).toBeVisible();
  });

  test("blocklists the selected (visible) page", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await expect(subRow(page)).toHaveCount(20);

    await bulkConfirm(page, {
      testid: "btn-manage-blocklist",
      match: (r) =>
        /\/api\/subscribers\/blocklist$/.test(r.url()) && r.request().method() === "PUT",
    });

    await page.goto(`${SUBSCRIBERS}?status=blocklisted`);
    await expectTotal(page, 20);
  });

  test("blocklists all via query", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await bulkConfirm(page, {
      testid: "btn-manage-blocklist",
      selectAll: true,
      match: (r) =>
        /\/api\/subscribers\/query\/blocklist$/.test(r.url()) && r.request().method() === "PUT",
    });

    await page.goto(`${SUBSCRIBERS}?status=blocklisted`);
    await expectTotal(page, 47);
  });

  test("exports the selection via the UI", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await openBulkMenu(page, { selectAll: true });

    const download = await exportSelection(page);
    expect(download.suggestedFilename()).toBe("subscribers.csv");
  });

  test("deletes the selected (visible) page", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await expect(subRow(page)).toHaveCount(20);

    await bulkConfirm(page, {
      testid: "btn-delete-subscribers",
      match: (r) => /\/api\/subscribers\?/.test(r.url()) && r.request().method() === "DELETE",
    });

    await expectTotal(page, 27);
  });

  test("deletes everything via query", async ({ page }) => {
    await page.goto(SUBSCRIBERS);
    await bulkConfirm(page, {
      testid: "btn-delete-subscribers",
      selectAll: true,
      match: (r) =>
        /\/api\/subscribers\/query\/delete$/.test(r.url()) && r.request().method() === "POST",
    });

    await expect(page.locator(".empty-state")).toBeVisible();
    await expectTotal(page, 0);
  });
});

test.describe("Subscribers: filtered bulk actions", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const scope of [
    "status",
    "list",
    "orphan",
    "search",
    "query",
    "subscription",
    "list query params",
  ]) {
    for (const action of ["delete", "blocklist", "export", "add", "remove", "unsubscribe"]) {
      test(`${action} applies only to subscribers matching the ${scope} filter`, async ({
        page,
      }) => {
        const { LIST_DEFAULT, LIST_OPTIN } = await reset(page);
        await data(await api(page, "/api/subscribers/query/delete", "POST", { all: true }));
        const status =
          scope === "status" && ["delete", "export"].includes(action) ? "blocklisted" : "disabled";
        const sourceList = scope === "subscription" ? LIST_OPTIN : LIST_DEFAULT;
        const targetList = sourceList === LIST_DEFAULT ? LIST_OPTIN : LIST_DEFAULT;
        await seedSubscribers(page, 22, {
          prefix: "target",
          status,
          lists: scope === "orphan" ? [] : [sourceList],
        });
        await seedSubscribers(page, 3, {
          prefix: "unrelated",
          lists: ["list", "list query params", "orphan", "query"].includes(scope)
            ? [LIST_OPTIN]
            : [sourceList],
        });
        const getSubscribers = async () =>
          (await data(await api(page, "/api/subscribers?per_page=100"))).results;
        if (scope === "subscription") {
          const ids = (await getSubscribers())
            .filter((s) => s.status === "enabled")
            .map((s) => s.id);
          await data(
            await api(page, "/api/subscribers/lists", "PUT", {
              ids,
              action: "add",
              target_list_ids: [sourceList],
              status: "confirmed",
            }),
          );
        }
        const before = await getSubscribers();
        const unrelated = before.filter((s) => s.status === "enabled");
        expect(unrelated).toHaveLength(3);
        const url = {
          status: `?status=${status}`,
          list: `/lists/${sourceList}`,
          orphan: "?subscription_status=none",
          search: "?search=target",
          query: `/lists/${sourceList}?query=${encodeURIComponent("subscribers.email LIKE 'target%' OR subscribers.status = 'enabled'")}`,
          subscription: "?subscription_status=unconfirmed",
          "list query params": `?list_id=${sourceList}`,
        }[scope];
        await page.goto(`${SUBSCRIBERS}${url}`);
        await expectTotal(page, 22);

        if (action === "delete" || action === "blocklist") {
          await bulkConfirm(page, {
            testid: action === "delete" ? "btn-delete-subscribers" : "btn-manage-blocklist",
            selectAll: true,
            match: (r) =>
              r.url().endsWith(`/api/subscribers/query/${action}`) &&
              r.request().method() === (action === "delete" ? "POST" : "PUT"),
          });
          if (action === "delete" || scope === "status")
            await expect(page.locator(".empty-state")).toBeVisible();
        } else if (action === "export") {
          await openBulkMenu(page, { selectAll: true });
          const download = await exportSelection(page);
          const csv = await readFile(await download.path(), "utf8");
          expect(csv.trim().split("\n")).toHaveLength(23);
          for (const sub of before)
            expect(csv.includes(sub.email)).toBe(sub.email.startsWith("target"));
        } else {
          await bulkManageLists(page, {
            action,
            lists: [
              (action === "add" ? targetList : sourceList) === LIST_DEFAULT
                ? "Default list"
                : "Opt-in list",
            ],
            preconfirm: action === "add" && targetList === LIST_OPTIN,
            selectAll: true,
          });
        }

        const after = await getSubscribers();
        expect(after.filter((s) => unrelated.some((u) => u.id === s.id))).toEqual(unrelated);
        const targets = after.filter((s) => s.email.startsWith("target"));
        expect(targets).toHaveLength(action === "delete" ? 0 : 22);
        for (const sub of targets) {
          if (action === "blocklist") expect(sub.status).toBe("blocklisted");
          if (action === "add") {
            expect(sub.lists.find((l) => l.id === targetList)?.subscription_status).toBe(
              targetList === LIST_OPTIN ? "confirmed" : "unconfirmed",
            );
          } else if (action === "remove") {
            expect(sub.lists.some((l) => l.id === sourceList)).toBe(false);
          } else if (action === "unsubscribe" && scope !== "orphan") {
            expect(sub.lists.find((l) => l.id === sourceList)?.subscription_status).toBe(
              "unsubscribed",
            );
          }
        }
      });
    }
  }
});

test.describe("Subscriber detail: lists & subscriptions", () => {
  const listRow = (page, name) => page.locator(".subscriptions tbody tr").filter({ hasText: name });

  async function rowAction(page, name, testid) {
    const row = listRow(page, name);
    await openMenu(row);
    await Promise.all([
      page.waitForEvent("load"),
      (async () => {
        await row.getByTestId(testid).click();
        await confirm(page);
      })(),
    ]);
  }

  let seed;
  const here = () => `${SUBSCRIBERS}/${seed.JOHN}/lists`;
  test.beforeEach(async ({ page }) => {
    await login(page);
    seed ??= await reset(page);
  });

  test("adds a list via the manage dialog", async ({ page }) => {
    await page.goto(here());
    await page.getByTestId("btn-manage").click();

    const dialog = page.locator("dialog[open]");
    await dialog.getByTestId("check-list-add").check();
    await selectList(dialog, "Opt-in list");
    await Promise.all([page.waitForEvent("load"), dialog.locator("button[type=submit]").click()]);

    await expect(listRow(page, "Opt-in list")).toBeVisible();
    await expect(listRow(page, "Opt-in list").locator(".status-unconfirmed")).toBeVisible();
  });

  test("sends an opt-in confirmation email", async ({ page }) => {
    await page.goto(here());

    const btn = page.getByTestId("btn-send-optin");
    await expect(btn).toBeEnabled();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          new RegExp(`/api/subscribers/${seed.JOHN}/optin$`).test(r.url()) &&
          r.request().method() === "POST",
      ),
      (async () => {
        await btn.click();
        await confirm(page);
      })(),
    ]);

    expect((await mailFor(SUB_NAMES.john)).length).toBeGreaterThan(0);
  });

  test("confirms a double opt-in subscription", async ({ page }) => {
    await page.goto(here());
    await rowAction(page, "Opt-in list", "btn-confirm-sub");
    await expect(listRow(page, "Opt-in list").locator(".status-confirmed")).toBeVisible();
  });

  test("unsubscribes and re-subscribes a subscription", async ({ page }) => {
    await page.goto(here());
    await rowAction(page, "Opt-in list", "btn-unsubscribe");
    await expect(listRow(page, "Opt-in list").locator(".status-unsubscribed")).toBeVisible();

    await page.goto(here());
    await rowAction(page, "Opt-in list", "btn-resubscribe");
    await expect(listRow(page, "Opt-in list").locator(".status-unconfirmed")).toBeVisible();
  });

  test("deletes a subscription", async ({ page }) => {
    await page.goto(here());
    await rowAction(page, "Default list", "btn-delete-sub");
    await expect(listRow(page, "Opt-in list")).toBeVisible();
    await expect(listRow(page, "Default list")).toHaveCount(0);
  });
});

test.describe("Subscriber detail: overview", () => {
  test("subscriber overview links to edit and back to the overview", async ({ page }) => {
    await login(page);
    const { JOHN } = await reset(page);
    await page.goto(`${SUBSCRIBERS}/${JOHN}`);
    await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    await expect(page).toHaveURL(/\/subscribers\/\d+\/edit$/);
    await expect(page.locator("input[name=email]")).toBeVisible();
    await page.getByRole("tab", { name: "View", exact: true }).click();
    await expect(page).toHaveURL(/\/subscribers\/\d+$/);
    await expect(page.locator(".activity")).toContainText("John Doe");
  });
});

test.describe("Subscribers: bulk scope safeguards", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("exports the intersection of search and SQL filters", async ({ page }) => {
    await reset(page);
    await seedSubscribers(page, 22, { prefix: "target", status: "disabled" });
    await seedSubscribers(page, 1, { prefix: "target-other", status: "enabled" });
    await seedSubscribers(page, 1, { prefix: "other", status: "disabled" });
    await page.goto(
      `${SUBSCRIBERS}?search=target&query=${encodeURIComponent("subscribers.status = 'disabled'")}`,
    );
    await expectTotal(page, 22);
    await openBulkMenu(page, { selectAll: true });
    const csv = await readFile(await (await exportSelection(page)).path(), "utf8");
    expect(csv.trim().split("\n")).toHaveLength(23);
    expect(csv).not.toContain("other0@example.com");
  });

  test("all does not discard search or SQL filters, and empty list actions are rejected", async ({
    page,
  }) => {
    const { LIST_DEFAULT } = await reset(page);
    const original = (await data(await api(page, "/api/subscribers"))).results;
    for (const body of [
      { all: true, search: "no-such-subscriber" },
      { all: true, query: "1 = 0" },
    ]) {
      await data(await api(page, "/api/subscribers/query/delete", "POST", body));
      await data(await api(page, "/api/subscribers/query/blocklist", "PUT", body));
    }
    for (const action of ["add", "remove", "unsubscribe"]) {
      const res = await api(page, "/api/subscribers/query/lists", "PUT", {
        action,
        target_list_ids: [LIST_DEFAULT],
      });
      expect(res.status).toBe(400);
    }
    expect((await data(await api(page, "/api/subscribers"))).results).toEqual(original);
  });

  test("a list-scoped role sees only its lists and subscribers", async ({ page, browser }) => {
    const { LIST_DEFAULT, LIST_OPTIN, ANON } = await reset(page);
    const name = unique("scoped");
    const role = await data(
      await api(page, "/api/roles/users", "POST", {
        name,
        permissions: ["subscribers:get", "subscribers:manage"],
      }),
    );
    const listRole = await data(
      await api(page, "/api/roles/lists", "POST", {
        name,
        lists: [{ id: LIST_DEFAULT, permissions: ["list:get", "list:manage"] }],
      }),
    );
    await data(
      await api(page, "/api/users", "POST", {
        username: name,
        email: `${name}@example.test`,
        name,
        type: "user",
        status: "enabled",
        password_login: true,
        password: "e2e-user-password",
        password2: "e2e-user-password",
        user_role_id: role.id,
        list_role_id: listRole.id,
      }),
    );
    const context = await browser.newContext({ baseURL: ORIGIN });
    const scoped = await context.newPage();
    try {
      await scoped.setExtraHTTPHeaders({ "X-Forwarded-For": "203.0.113.200" });
      await login(scoped, name, "e2e-user-password");
      await scoped.goto("/admin/lists");
      await expect(scoped.getByTestId("list-row")).toHaveCount(1);
      await expect(scoped.getByTestId("list-row")).toContainText("Default list");
      await expect(scoped.getByTestId("btn-new")).toHaveCount(0);

      await scoped.goto(SUBSCRIBERS);
      await expect(subRow(scoped)).toHaveCount(1);
      await expect(subRow(scoped)).toContainText(SUB_NAMES.john);

      const denied = await scoped.goto(`/admin/lists/${LIST_OPTIN}`);
      expect(denied.status()).toBe(403);
      expect((await scoped.goto(`${SUBSCRIBERS}/lists/${LIST_OPTIN}`)).status()).toBe(403);
      await scoped.goto(`${SUBSCRIBERS}/${ANON}/edit`);
      await expect(scoped.getByTestId("error")).toBeVisible();
      await expect(scoped.locator("input[name=email]")).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
