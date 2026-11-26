// Native screens with no upstream spec (15-external-sources section 4, B155f, D181): the source
// stream's retry queue. A test stack has no source, so the page says no stream is running and
// lists nothing; the queue's rows are covered through the API in test/admin/source-retries.test.ts.
import { expect } from "@playwright/test";
import { createUser, login, logout, PASSWORD, signIn, test } from "../helpers.js";

test("the retry queue is reached from the settings menu and says when no stream runs", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/admin/settings");
  await page.locator('a[href="/admin/settings/source-retries"]').first().click();
  await expect(page).toHaveURL(/\/admin\/settings\/source-retries$/);
  await expect(page.getByRole("heading", { name: "Source retry queue" })).toBeVisible();
  await expect(page.getByTestId("retries-help")).toContainText("waiting for settings");
  await expect(page.getByTestId("retries-no-source")).toBeVisible();
  await expect(page.getByTestId("retries-no-source")).toContainText("No source stream is running");
  await expect(page.getByTestId("retry-row")).toHaveCount(0);
  await expect(page.getByTestId("error")).toBeHidden();
  expect(errors).toEqual([]);
});

/** A queue row in the API's shape (src/openapi/schemas.ts SourceRetryQueue). */
const row = (id, status, extra) => ({
  id,
  kind: "event",
  record_id: `rec${id}`,
  stamp: "2026-11-26 10:00:00.000Z",
  status,
  attempts: 2,
  first_failed_at: "2026-11-26T10:00:01.000Z",
  next_attempt_at: "2026-11-26T10:04:01.000Z",
  last_error: `error ${id}`,
  ...extra,
});

// The rows a running stream lists: a test stack has no source to fail records on, and a `waiting`
// row needs a retry a real minute after its first failure. Record IDs and errors reach the page as
// text only.
test("each queue row shows its record, status, attempts and error", async ({ page }) => {
  await page.route("**/api/settings/source/retries", (route) =>
    route.fulfill({
      json: {
        data: {
          stream: "live",
          more: true,
          results: [
            row(1, "queued"),
            row(2, "waiting", { kind: "user", last_error: '<img src=x onerror="window.pwned=1">' }),
            row(3, "terminal", { next_attempt_at: null }),
          ],
        },
      },
    }),
  );
  await signIn(page);
  await page.goto("/admin/settings/source-retries");
  const rows = page.getByTestId("retry-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("rec1");
  await expect(rows.nth(0).getByTestId("retry-status")).toHaveText("Retrying");
  await expect(rows.nth(1).getByTestId("retry-status")).toHaveText("Waiting for settings");
  await expect(rows.nth(1)).toContainText("Leaving user");
  await expect(rows.nth(1).getByTestId("retry-error")).toHaveText(
    '<img src=x onerror="window.pwned=1">',
  );
  await expect(rows.nth(2).getByTestId("retry-status")).toHaveText("Failed for good");
  await expect(rows.nth(2)).toContainText("-");
  await expect(page.getByTestId("retries-more")).toBeVisible();
  await expect(page.getByTestId("retries-no-source")).toBeHidden();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.locator("section.source-retries img").count()).toBe(0);
});

test("a settings reader sees no retry queue link and is refused the page", async ({ page }) => {
  await signIn(page);
  const reader = await createUser(page, ["settings:get"]);
  await logout(page);
  await login(page, reader.username, PASSWORD, "/admin/settings/logs");
  await expect(page.locator('a[href="/admin/settings/logs"]').first()).toBeVisible();
  await expect(page.locator('a[href="/admin/settings/source-retries"]')).toHaveCount(0);
  const refused = await page.goto("/admin/settings/source-retries");
  expect(refused?.status()).toBe(403);
});
