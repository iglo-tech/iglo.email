// Adapted from listmonk tests/helpers.js at 6fcd95f. The harness owns the servers, so there is
// no resetDB; each spec makes its own uniquely named data through the public API.
import { randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";

export { totp } from "./totp.ts";

export const ORIGIN = process.env.E2E_ORIGIN;
export const BLANK_ORIGIN = process.env.E2E_BLANK_ORIGIN;
export const ADMIN = { user: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASSWORD };
export const PASSWORD = "e2e-user-password";

export const unique = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;

// Each test is its own client, through the trusted proxy run.ts configures, so a run of specs
// stays inside the real login limit of 20 posts a minute per client.
export const test = base.extend({
  page: async ({ page }, use) => {
    const peer = `203.0.113.${1 + (randomBytes(1)[0] % 254)}`;
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": peer });
    await use(page);
  },
});

// Log in through the form and wait for the destination.
export async function login(
  page,
  username = ADMIN.user,
  password = ADMIN.password,
  next = "/admin",
) {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL(`**${next}`),
    page.locator('form[action="/admin/login"] button[type=submit]').click(),
  ]);
}

// Log out through the user menu.
export async function logout(page) {
  await page.locator(".user-trigger").click();
  await Promise.all([
    page.waitForURL("**/admin/login"),
    page.getByRole("menuitem", { name: "Logout" }).click(),
  ]);
}

// A session-authenticated API call from the logged in page, with its CSRF header.
export function api(page, path, method = "GET", body = undefined) {
  return page.evaluate(
    async ([uri, verb, data]) => {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice(5) ?? "";
      const response = await fetch(uri, {
        method: verb,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, body: await response.json() };
    },
    [path, method, body],
  );
}

// Create a user with its own role. The page must hold an admin session.
export async function createUser(page, permissions = null) {
  const name = unique("e2e");
  let role = 1;
  if (permissions) {
    const created = await api(page, "/api/roles/users", "POST", { name, permissions });
    expect(created.status).toBe(200);
    role = created.body.data.id;
  }
  const email = `${name}@example.test`;
  const user = await api(page, "/api/users", "POST", {
    username: name,
    email,
    name,
    type: "user",
    status: "enabled",
    password_login: true,
    password: PASSWORD,
    password2: PASSWORD,
    user_role_id: role,
  });
  expect(user.status).toBe(200);
  return { id: user.body.data.id, username: name, email };
}

// Mail the sink received for one address, waited for.
export async function mailFor(address, count = 1) {
  let mails = [];
  await expect(async () => {
    const response = await fetch(`${process.env.E2E_MAIL}?to=${encodeURIComponent(address)}`);
    mails = await response.json();
    expect(mails.length).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 15000 });
  return mails;
}
