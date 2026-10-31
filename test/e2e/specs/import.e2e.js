// Adapted from listmonk tests/specs/import.spec.js at 6fcd95f. Each test builds its own CSV in
// memory with unique addresses instead of fixtures/subs.csv and resetDB, and clears the importer
// when it ends. The cases after upstream's two are this project's: polling bounds and refusals.
import { expect } from "@playwright/test";
import { api, confirm, createUser, login, logout, selectList, test, unique } from "../helpers.js";

const IMPORT = "/admin/subscribers/import";
const STATUS = "**/api/import/subscribers";
const LOGS = "**/api/import/subscribers/logs";

const fileOf = (text, name = "subs.csv") => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});

function csv(domain, rows = 100) {
  const lines = ["email,name,attributes"];
  for (let i = 0; i < rows; i += 1) lines.push(`user${i}@${domain},"User ${i}","{}"`);
  return lines.join("\n");
}

async function makeList(page) {
  const name = unique("import");
  const res = await api(page, "/api/lists", "POST", { name, type: "private" });
  expect(res.status).toBe(200);
  return res.body.data;
}

// Subscribers of one generated domain, through the API.
async function countOf(page, domain) {
  const query = encodeURIComponent(`subscribers.email LIKE '%@${domain}'`);
  const res = await api(page, `/api/subscribers?query=${query}&per_page=1`);
  return res.body.data.total;
}

async function finishImport(page) {
  await expect(page.getByTestId("btn-done")).toBeVisible();
  await page.getByTestId("btn-done").click();
  await expect(page.getByTestId("btn-upload")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await api(page, "/api/import/subscribers", "DELETE");
});
test.afterEach(async ({ page }) => {
  await api(page, "/api/import/subscribers", "DELETE");
});

test("imports subscribers across modes and statuses", async ({ page }) => {
  const list = await makeList(page);
  const domain = `${unique("import")}.example.com`;
  const cases = [
    { mode: "subscribe", subStatus: "unconfirmed", overwrite: true },
    { mode: "subscribe", subStatus: "confirmed", overwrite: true },
    { mode: "subscribe", subStatus: "unconfirmed", overwrite: false },
    { mode: "blocklist", subStatus: "unsubscribed", overwrite: false },
  ];

  for (const c of cases) {
    await page.goto(IMPORT);
    await page.getByTestId(`check-${c.mode}`).check();
    await page.getByTestId(`check-${c.subStatus}`).check();

    if (c.overwrite) {
      await page.getByTestId("overwrite-user-info").check();
      await page.getByTestId("overwrite-sub-status").check();
    }

    if (c.mode === "subscribe") {
      await selectList(page, list.name);
    }

    await page.locator("input[type=file]").setInputFiles(fileOf(csv(domain)));
    await page.getByTestId("btn-upload").click();

    // Overwriting the subscription status prompts for confirmation.
    if (c.overwrite) {
      await confirm(page);
    }

    // Wait for the import to finish, then clear it. Clearing reloads the page back to the form.
    await finishImport(page);

    await page.goto("/admin/subscribers");
    expect(await countOf(page, domain)).toBe(100);
  }
});

test("fails on a wrong delimiter", async ({ page }) => {
  const list = await makeList(page);
  await page.goto(IMPORT);
  await selectList(page, list.name);
  await page.locator("input[name=delim]").fill("|");
  await page.locator("input[type=file]").setInputFiles(fileOf(csv(unique("delim.example"))));
  await page.getByTestId("btn-upload").click();

  await expect(page.locator(".status .title").first()).toContainText("failed");
  await expect(page.getByTestId("import-logs")).not.toBeEmpty();
  await finishImport(page);
});

test("a list link preselects the list, and stop ends a running import", async ({ page }) => {
  test.setTimeout(60_000);
  const list = await makeList(page);
  await page.goto(`${IMPORT}?list_id=${list.id}`);
  await expect(page.locator("ot-taginput .badge")).toContainText(list.name);
  const domain = `${unique("stop")}.example.com`;
  await page.locator("input[type=file]").setInputFiles(fileOf(csv(domain, 500_000)));
  await page.getByTestId("btn-upload").click();
  await page.getByTestId("btn-stop").click();
  // Stopping ends "finished", as upstream: the log says it was asked to stop.
  await expect(page.locator(".status .title").first()).toHaveText("finished", { timeout: 40_000 });
  await expect(page.getByTestId("import-logs")).toContainText("stop request received");
  await expect(page.getByTestId("stopped-hint")).toContainText("stopped before the end");
  await finishImport(page);
  expect(await countOf(page, domain)).toBeLessThan(500_000);
});

test("a whole import shows no stopped hint", async ({ page }) => {
  const list = await makeList(page);
  await page.goto(`${IMPORT}?list_id=${list.id}`);
  await page
    .locator("input[type=file]")
    .setInputFiles(fileOf(csv(`${unique("whole")}.example.com`, 3)));
  await page.getByTestId("btn-upload").click();
  await expect(page.locator(".status .title").first()).toHaveText("finished");
  await expect(page.getByTestId("import-logs")).toContainText("imported finished");
  await expect(page.getByTestId("stopped-hint")).toBeHidden();
  await finishImport(page);
});

test("a refused file shows the API's message and keeps the form", async ({ page }) => {
  const list = await makeList(page);
  await page.goto(IMPORT);
  await selectList(page, list.name);
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "subs.zip", mimeType: "application/zip", buffer: Buffer.from("PK") });
  await page.getByTestId("btn-upload").click();
  await expect(page.getByTestId("error")).toContainText("ZIP files are not supported");
  await expect(page.getByTestId("btn-upload")).toBeDisabled();
  await expect(page.locator("input[type=file]")).toHaveValue("");

  const logs = await api(page, "/api/import/subscribers");
  expect(logs.body.data.status).toBe("none");
});

test("a file over the webhook budget ends failed with the reason in the log", async ({ page }) => {
  // 20 webhooks on two events is 40 deliveries a row, so 1,251 rows are over 50,000.
  const hooks = [];
  try {
    for (let i = 0; i < 20; i += 1) {
      const hook = await api(page, "/api/webhooks", "POST", {
        url: "http://203.0.113.1/never",
        events: ["subscriber.blocklisted", "subscriber.unsubscribed"],
      });
      expect(hook.status).toBe(200);
      hooks.push(hook.body.data.id);
    }
    const domain = `${unique("budget")}.example.com`;
    await page.goto(IMPORT);
    await page.getByTestId("check-blocklist").check();
    await page.locator("input[type=file]").setInputFiles(fileOf(csv(domain, 1251)));
    await page.getByTestId("btn-upload").click();
    await expect(page.locator(".status .title").first()).toContainText("failed");
    await expect(page.getByTestId("import-logs")).toContainText("50,000");
    expect(await countOf(page, domain)).toBe(0);
    await finishImport(page);
  } finally {
    for (const id of hooks) await api(page, `/api/webhooks/${id}`, "DELETE");
  }
});

test("a CSV that produces log lines renders as text", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const list = await makeList(page);
  const hostile = `<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"`;
  await page.goto(IMPORT);
  await selectList(page, list.name);
  // Real log lines hold no cell of the file, so the second half of this test puts one in the reply.
  await page
    .locator("input[type=file]")
    .setInputFiles(
      fileOf(
        `email,name,"${hostile.replaceAll('"', '""')}"\nnot-an-address,"${hostile.replaceAll('"', '""')}",x\n`,
      ),
    );
  await page.getByTestId("btn-upload").click();
  await expect(page.getByTestId("btn-done")).toBeVisible();
  await expect(page.getByTestId("import-logs").locator(".line").first()).toBeVisible();
  await expect(page.locator(".log-view img")).toHaveCount(0);

  await page.route(LOGS, (route) =>
    route.fulfill({
      json: {
        data: `2026/10/31 12:00:00.000 ${hostile}\nno stamp <script>window.pwned=2</script>\n`,
      },
    }),
  );
  await page.reload();
  const lines = page.getByTestId("import-logs").locator(".line");
  await expect(lines).toHaveCount(2);
  await expect(lines.first().locator(".timestamp")).toHaveText("2026/10/31 12:00:00.000");
  await expect(lines.first().locator(".log-message")).toHaveText(hostile);
  await expect(lines.last()).toContainText("<script>");
  await expect(page.locator(".log-view img, .log-view script")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

// The running states come from a route, so the bounds do not race a real import.
async function running(page, status = () => "importing") {
  const seen = { status: 0, logs: 0 };
  await page.route(STATUS, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    seen.status += 1;
    return route.fulfill({
      json: { data: { name: "subscribers.csv", total: 10, imported: 3, status: status(seen) } },
    });
  });
  await page.route(LOGS, (route) => {
    seen.logs += 1;
    return route.fulfill({ json: { data: "" } });
  });
  return seen;
}

test("polling stops when the import ends", async ({ page }) => {
  const seen = await running(page, ({ status }) => (status < 3 ? "importing" : "finished"));
  await page.goto(IMPORT);
  await expect(page.locator(".status .title").first()).toContainText("finished");
  const polls = seen.status;
  await page.waitForTimeout(2500);
  expect(seen.status).toBe(polls);
});

test("polling pauses while the page is hidden and resumes when shown", async ({ page }) => {
  const seen = await running(page);
  await page.goto(IMPORT);
  await expect.poll(() => seen.status).toBeGreaterThan(2);

  const setHidden = (hidden) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  await page.waitForTimeout(1200);
  const paused = seen.status;
  await page.waitForTimeout(2500);
  expect(seen.status).toBe(paused);

  await setHidden(false);
  await expect.poll(() => seen.status).toBeGreaterThan(paused + 1);
});

test("polling gives up after repeated failures and keeps the last status", async ({ page }) => {
  await running(page);
  await page.goto(IMPORT);
  await expect(page.locator(".status .title").first()).toContainText("importing");

  let failed = 0;
  await page.route(STATUS, (route) => {
    failed += 1;
    return route.fulfill({ status: 500, json: { message: "the server is unwell" } });
  });
  await expect(page.getByTestId("error")).toContainText("Stopped watching", { timeout: 15_000 });
  await expect(page.getByTestId("error")).toContainText("the server is unwell");
  await expect(page.locator(".status .title").first()).toContainText("importing");
  const polls = failed;
  expect(polls).toBeLessThanOrEqual(5);
  await page.waitForTimeout(2500);
  expect(failed).toBe(polls);
});

test("the route needs subscribers:import", async ({ page }) => {
  const none = await createUser(page, ["lists:get_all"]);
  await logout(page);
  await login(page, none.username, "e2e-user-password");
  const denied = await page.goto(IMPORT);
  expect(denied.status()).toBe(403);
});
