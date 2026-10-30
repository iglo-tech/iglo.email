// The flow of listmonk's forgot-password.html and reset-password.html at 6fcd95f, with the link
// taken from the mail the SMTP sink received; upstream has no spec for it.
import { expect } from "@playwright/test";
import { PASSWORD, createUser, login, logout, mailFor, totp, api, test } from "../helpers.js";

const sent = "If the account is active, you will receive a password reset email.";

function link(mail) {
  const href = /href="([^"]+\/admin\/reset\?[^"]+)"/.exec(mail.body)[1];
  return new URL(href.replaceAll("&amp;", "&"));
}
async function request(page, email) {
  await page.goto("/admin/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(sent)).toBeVisible();
}

test("an unknown address gets the same answer and no mail", async ({ page }) => {
  await request(page, "nobody-here@example.test");
  await page.waitForTimeout(300);
  const mails = await (await fetch(`${process.env.E2E_MAIL}?to=nobody-here@example.test`)).json();
  expect(mails).toEqual([]);
});

test("the mailed link sets a new password and logs in, once", async ({ page }) => {
  await login(page);
  const user = await createUser(page);
  await logout(page);

  await request(page, user.email);
  const [mail] = await mailFor(user.email);
  expect(mail.subject).toBe("Reset your password");
  const target = link(mail);
  await page.goto(target.pathname + target.search);

  await page.getByLabel("New password").fill("e2e-new-password");
  await page.getByLabel("Repeat password").fill("e2e-other-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator(".error")).toHaveText("Passwords don't match");

  await page.getByLabel("New password").fill("e2e-new-password");
  await page.getByLabel("Repeat password").fill("e2e-new-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.waitForURL("**/admin");
  await expect(page.locator(".user-label")).toHaveText(user.username);
  await logout(page);

  await page.goto(target.pathname + target.search);
  await expect(page.getByText("Invalid or expired reset link")).toBeVisible();

  await page.goto("/admin/login");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.locator(".error")).toHaveText("Invalid login or password");
  await login(page, user.username, "e2e-new-password");
});

test("a reset does not skip the second factor", async ({ page }) => {
  await login(page);
  const user = await createUser(page);
  await logout(page);
  await login(page, user.username, PASSWORD);
  const { body } = await api(page, `/api/users/${user.id}/twofa/totp`);
  const code = totp(body.data.secret);
  const enabled = await api(page, `/api/users/${user.id}/twofa`, "PUT", {
    secret: body.data.secret,
    code,
  });
  expect(enabled.status).toBe(200);
  await page.goto("/admin");
  await logout(page);

  await request(page, user.email);
  const [mail] = await mailFor(user.email);
  const target = link(mail);
  await page.goto(target.pathname + target.search);
  await page.getByLabel("New password").fill("e2e-new-password");
  await page.getByLabel("Repeat password").fill("e2e-new-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.waitForURL("**/admin/login/twofa?**");
  await page.locator("#totp_code").fill(totp(body.data.secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/admin");
  await expect(page.locator(".user-label")).toHaveText(user.username);
});
