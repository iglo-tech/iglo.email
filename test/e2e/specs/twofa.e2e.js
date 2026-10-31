// The flow of listmonk's profile 2FA section and twofa.html at 6fcd95f; upstream has no spec for
// it. Codes are computed in helpers.js, so this also proves the secret on the screen is real.
import { expect } from "@playwright/test";
import { PASSWORD, api, createUser, login, logout, totp, test } from "../helpers.js";

test("enrols, is challenged at login, and disables", async ({ page }) => {
  await login(page);
  const user = await createUser(page);
  await logout(page);
  await login(page, user.username, PASSWORD);

  await page.goto("/admin/user/profile");
  await page.getByRole("switch", { name: "Two-factor authentication" }).check();
  await expect(page.locator(".totp-setup img")).toBeVisible();
  const secret = await page.getByTestId("totp-secret").textContent();

  await page.getByLabel("TOTP code").fill("000000");
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.locator(".totp-setup")).toBeVisible();
  await page.getByLabel("TOTP code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByTestId("twofa-enabled")).toBeVisible();
  await logout(page);

  await page.goto("/admin/login");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL("**/admin/login/twofa?**");

  await page.locator("#totp_code").fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".error")).toBeVisible();

  await page.locator("#totp_code").fill(totp(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/admin");
  await expect(page.locator(".user-label")).toHaveText(user.username);

  await page.goto("/admin/user/profile");
  await page.getByRole("switch", { name: "Two-factor authentication" }).uncheck();
  await page.getByTestId("twofa-enabled").getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId("twofa-enabled")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Two-factor authentication" })).not.toBeChecked();
  const profile = await api(page, "/api/profile");
  expect(profile.body.data.twofa_type).toBe("none");
});
