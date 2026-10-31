// Adapted from the login and first-time setup cases of listmonk tests/specs/users.spec.js at
// 6fcd95f. D26 replaces upstream's public first-account form with provisioning instructions.
import { expect } from "@playwright/test";
import { ADMIN, BLANK_ORIGIN, PASSWORD, createUser, login, logout, test } from "../helpers.js";

test.describe("Login", () => {
  test("sends a page request to login and back to where it was going", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fusers$/);
    await page.getByLabel("Username").fill(ADMIN.user);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForURL("**/admin/users");
    await expect(page.getByTestId("user-row").first()).toBeVisible();
  });

  test("refuses a wrong password without saying which field was wrong", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Username").fill(ADMIN.user);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator(".error")).toHaveText("Invalid login or password");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("a user sees their name, can log out and is then out", async ({ page }) => {
    await login(page);
    const user = await createUser(page);
    await logout(page);

    await login(page, user.username, PASSWORD);
    await expect(page.locator(".user-label")).toHaveText(user.username);
    await logout(page);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("navigation shows a role only what it can reach", async ({ page }) => {
    await login(page);
    const user = await createUser(page, ["campaigns:get", "templates:get"]);
    await logout(page);

    await login(page, user.username, PASSWORD);
    const nav = page.locator("aside nav");
    await expect(nav.getByText("Campaigns", { exact: true })).toBeVisible();
    await expect(nav.getByText("Subscribers", { exact: true })).toHaveCount(0);
    await expect(nav.getByText("Users", { exact: true })).toHaveCount(0);
    await expect(nav.getByText("Settings", { exact: true })).toHaveCount(0);
    const denied = await page.goto("/admin/settings");
    expect(denied.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "Error" })).toBeVisible();
  });
});

test.describe("First-time setup", () => {
  test("a fresh install explains provisioning and offers no account claim", async ({ page }) => {
    await page.goto(`${BLANK_ORIGIN}/admin/login`);
    await expect(page.getByText("IGLO_EMAIL_ADMIN_USER")).toBeVisible();
    await expect(page.locator("input[name=email]")).toHaveCount(0);
    await expect(page.locator("input[name=password2]")).toHaveCount(0);
    await page.getByLabel("Username").fill("claim-this-install");
    await page.getByLabel("Password").fill("claim-this-password");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.locator(".error")).toHaveText("Invalid login or password");
  });
});
