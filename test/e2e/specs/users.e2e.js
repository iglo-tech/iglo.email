// Adapted from listmonk tests/specs/users.spec.js at 6fcd95f. The run shares one database, so roles
// and users carry unique names and counts are read as differences. Upstream's first-time setup is
// in login.e2e.js: D26 has no public first-account form. The screen does not change your own
// roles or password login (07-api-and-ui.md); the rest of the file follows upstream.
import { expect } from "@playwright/test";
import {
  ADMIN,
  ORIGIN,
  PASSWORD,
  api,
  confirm,
  createUser,
  login,
  openMenu,
  test,
  unique,
} from "../helpers.js";

const USERS = "/admin/users";
const USER_ROLES = "/admin/users/roles";
const LIST_ROLES = "/admin/users/roles/lists";

function roleRow(page, name) {
  const rows = page.getByTestId("role-row");
  return name ? rows.filter({ hasText: name }) : rows;
}

function userRow(page, name) {
  const rows = page.getByTestId("user-row");
  return name ? rows.filter({ hasText: name }) : rows;
}

// Open a role's edit view by name (via the listing), reloading it from the server.
async function gotoRoleEdit(page, base, name) {
  await page.goto(base);
  const id = await roleRow(page, name).getAttribute("data-id");
  await page.goto(`${base}/${id}`);
}

// Open a user's edit view by name, reloading it from the server.
async function gotoUserEdit(page, name) {
  await page.goto(USERS);
  const id = await userRow(page, name).first().getAttribute("data-id");
  await page.goto(`${USERS}/${id}`);
}

async function signedIn(page, username, password, next = "/admin/lists") {
  const context = await page.context().browser().newContext({ baseURL: ORIGIN });
  const other = await context.newPage();
  await other.setExtraHTTPHeaders({
    "X-Forwarded-For": `203.0.113.${1 + Math.floor(Math.random() * 254)}`,
  });
  await login(other, username, password, next);
  return other;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.describe("Users, roles & login", () => {
  test.describe.configure({ mode: "serial" });
  const first = unique("first");
  const second = unique("second");
  const third = unique("third");

  test("adds user roles", async ({ page }) => {
    await page.goto(USER_ROLES);
    const rows = await roleRow(page).count();
    // "first": accept the default permissions.
    await page.getByTestId("btn-new").click();
    await page.locator("input[name=name]").fill(first);
    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/users/roles")),
      page.getByTestId("btn-save").click(),
    ]);

    // "second": every permission checked.
    await page.getByTestId("btn-new").click();
    await page.locator("input[name=name]").fill(second);
    const boxes = page.locator("form input[type=checkbox]");
    for (let i = 0, n = await boxes.count(); i < n; i += 1) {
      await boxes.nth(i).check();
    }
    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/users/roles")),
      page.getByTestId("btn-save").click(),
    ]);

    await expect(roleRow(page)).toHaveCount(rows + 2);

    // Reopen "second": every permission checkbox came back checked.
    await gotoRoleEdit(page, USER_ROLES, second);
    await expect(page.locator("form input[type=checkbox]:checked")).not.toHaveCount(0);
    await expect(page.locator("form input[type=checkbox]:not(:checked)")).toHaveCount(0);
    // The permissions this project adds have boxes too, so a save cannot lose them unseen.
    for (const value of ["sequences:manage", "sends:get", "webhooks:manage"])
      await expect(page.locator(`input[value="${value}"]`)).toBeChecked();
  });

  test("edits a user role", async ({ page }) => {
    await page.goto(USER_ROLES);
    const row = roleRow(page, first);
    await openMenu(row);
    await row.getByTestId("btn-edit").click();

    await page.locator('input[value="users:get"]').check();
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/roles\/users\/\d+/.test(r.url()) && r.request().method() === "PUT",
      ),
      page.getByTestId("btn-save").click(),
    ]);

    // Reopen the role: "users:get" (not a default) is checked, proving the edit stuck.
    await gotoRoleEdit(page, USER_ROLES, first);
    await expect(page.locator('input[value="users:get"]')).toBeChecked();
  });

  test("clones and deletes a user role", async ({ page }) => {
    await page.goto(USER_ROLES);
    const rows = await roleRow(page).count();
    const copy = unique("second copy");

    const clone = roleRow(page, second);
    page.once("dialog", (d) => d.accept(copy));
    await openMenu(clone);
    await clone.getByTestId("btn-clone").click();
    await expect(roleRow(page)).toHaveCount(rows + 1);
    await expect(roleRow(page, copy)).toBeVisible();

    const last = roleRow(page, copy);
    await openMenu(last);
    await last.getByTestId("btn-delete").click();
    await confirm(page);
    await expect(roleRow(page)).toHaveCount(rows);
    await expect(roleRow(page, copy)).toHaveCount(0);
  });

  test("adds list roles", async ({ page }) => {
    await page.goto("/admin/lists");
    for (const name of [unique("role list"), unique("role list")]) {
      const made = await api(page, "/api/lists", "POST", {
        name,
        type: "public",
        optin: "single",
      });
      expect(made.status).toBe(200);
    }
    // "first": a single list.
    await page.goto(LIST_ROLES);
    await page.getByTestId("btn-new").click();
    await page.locator("input[name=name]").fill(first);
    await page.getByTestId("btn-add-list").click();
    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/roles/lists")),
      page.getByTestId("btn-save").click(),
    ]);

    // "second": two lists.
    await page.getByTestId("btn-new").click();
    await page.locator("input[name=name]").fill(second);
    await page.getByTestId("btn-add-list").click();
    await page.getByTestId("btn-add-list").click();
    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/roles/lists")),
      page.getByTestId("btn-save").click(),
    ]);

    // Reopen each: "first" lists one row, "second" lists both.
    await gotoRoleEdit(page, LIST_ROLES, first);
    await expect(page.locator('form input[value="list:get"]')).toHaveCount(1);
    await gotoRoleEdit(page, LIST_ROLES, second);
    await expect(page.locator('form input[value="list:get"]')).toHaveCount(2);
  });

  test("edits a list role", async ({ page }) => {
    await page.goto(LIST_ROLES);
    const row = roleRow(page, second);
    await openMenu(row);
    await row.getByTestId("btn-edit").click();

    // Drop the "manage" permission on the second list.
    await page.locator('input[value="list:manage"]').nth(1).uncheck();
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/roles\/lists\/\d+/.test(r.url()) && r.request().method() === "PUT",
      ),
      page.getByTestId("btn-save").click(),
    ]);

    // Reopen the role: both lists keep "view", exactly one lost "manage".
    await gotoRoleEdit(page, LIST_ROLES, second);
    await expect(page.locator('input[value="list:get"]:checked')).toHaveCount(2);
    await expect(page.locator('input[value="list:manage"]:checked')).toHaveCount(1);
  });

  test("clones and deletes a list role", async ({ page }) => {
    await page.goto(LIST_ROLES);
    const rows = await roleRow(page).count();
    const copy = unique("second copy");

    const clone = roleRow(page, second);
    page.once("dialog", (d) => d.accept(copy));
    await openMenu(clone);
    await clone.getByTestId("btn-clone").click();
    await expect(roleRow(page)).toHaveCount(rows + 1);
    await expect(roleRow(page, copy)).toBeVisible();

    const last = roleRow(page, copy);
    await openMenu(last);
    await last.getByTestId("btn-delete").click();
    await confirm(page);
    await expect(roleRow(page)).toHaveCount(rows);
    await expect(roleRow(page, copy)).toHaveCount(0);
  });

  test("adds users", async ({ page }) => {
    const cases = [
      { name: first, userRole: first, listRole: first },
      { name: second, userRole: second, listRole: second },
      { name: third, userRole: first, listRole: first },
    ];
    await page.goto(USERS);
    const rows = await userRow(page).count();

    for (const c of cases) {
      await page.goto(USERS);
      await page.getByTestId("btn-new").click();
      await page.locator("input[name=username]").fill(c.name);
      await page.locator("input[name=name]").fill(c.name);
      await page.locator("input[name=email]").fill(`${c.name}@domain.com`);
      await page.getByTestId("password-login").check();
      await page.locator("input[name=password]").fill(`${c.name}000000`);
      await page.locator("input[name=password2]").fill(`${c.name}000000`);
      await page.locator("select[name=user_role]").selectOption({ label: c.userRole });
      await page.locator("select[name=list_role]").selectOption({ label: c.listRole });
      await Promise.all([
        page.waitForURL((url) => url.pathname.endsWith("/admin/users")),
        page.getByTestId("btn-save").click(),
      ]);
    }

    await expect(userRow(page)).toHaveCount(rows + 3);

    // The listing renders each user's role badges. Read the rows and confirm the
    // roles match (usernames and role names overlap, so match on the username link).
    const found = await userRow(page).evaluateAll((els) =>
      els.map((el) => ({
        username: el.querySelector('.avatar-label > a[href*="/admin/users/"]').textContent.trim(),
        userRole: el.querySelector('a[href*="user_role_id"]')?.textContent.trim(),
        listRole: el.querySelector('a[href*="list_role_id"]')?.textContent.trim(),
      })),
    );
    for (const c of cases) {
      const row = found.find((r) => r.username === c.name);
      expect(row.userRole).toBe(c.userRole);
      expect(row.listRole).toBe(c.listRole);
    }
  });

  test("filters by what a row links to", async ({ page }) => {
    await page.goto(USERS);
    await userRow(page, third).locator('a[href*="list_role_id"]').click();
    await expect(userRow(page)).toHaveCount(2);
    await expect(page.locator(".filter-tag")).toContainText(first);
    await page.getByTestId("btn-remove-filter").click();
    await expect(userRow(page).first()).toBeVisible();
    await expect(page.locator(".filter-tag")).toHaveCount(0);
  });

  test("edits a user", async ({ page }) => {
    await gotoUserEdit(page, third);
    await expect(page.locator("input[name=username]")).toHaveValue(third);
    await page.getByTestId("password-login").uncheck();
    await page.locator("select[name=user_role]").selectOption({ label: second });
    await page.locator("select[name=list_role]").selectOption({ label: second });
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/users\/\d+/.test(r.url()) && r.request().method() === "PUT",
      ),
      page.getByTestId("btn-save").click(),
    ]);

    // Reopen the edit view: the new roles and disabled password login are reflected.
    await gotoUserEdit(page, third);
    await expect(page.getByTestId("password-login")).not.toBeChecked();
    await expect(page.locator("select[name=user_role] option:checked")).toContainText(second);
    await expect(page.locator("select[name=list_role] option:checked")).toContainText(second);
  });

  test("deletes a user", async ({ page }) => {
    await page.goto(USERS);
    const rows = await userRow(page).count();
    const row = userRow(page, third);
    await openMenu(row);
    await row.getByTestId("btn-delete").click();
    await confirm(page);

    await expect(userRow(page)).toHaveCount(rows - 1);
    await expect(userRow(page, third)).toHaveCount(0);
  });

  test("logs in as a single-list user", async ({ page }) => {
    const other = await signedIn(page, first, `${first}000000`);

    // Only the one list granted by the list role, with no create button.
    await expect(other.getByTestId("list-row")).toHaveCount(1);
    await expect(other.getByTestId("btn-new")).toHaveCount(0);
    await expect(other.getByTestId("list-row").getByTestId("btn-edit")).toHaveCount(1);
    await other.context().close();
  });

  test("logs in as an all-permissions user", async ({ page }) => {
    const other = await signedIn(page, second, `${second}000000`);

    // The superadmin-equivalent role sees every list with full actions.
    await expect(other.getByTestId("list-row").first()).toBeVisible();
    expect(await other.getByTestId("list-row").count()).toBeGreaterThan(1);
    await expect(other.getByTestId("btn-new")).toBeVisible();
    await other.context().close();
  });
});

test.describe("Users: bulk deletion", () => {
  test("deletes only checked users in the filtered view", async ({ page }) => {
    await page.goto(USERS);
    const users = [];
    for (let i = 0; i < 3; i += 1) {
      const { body } = await api(page, "/api/users", "POST", {
        username: unique("bulk"),
        type: "api",
        status: i < 2 ? "disabled" : "enabled",
        user_role_id: 1,
      });
      users.push(body.data);
    }
    await page.goto(`${USERS}?status=disabled`);
    await expect(userRow(page, users[0].username)).toBeVisible();
    await expect(userRow(page, users[2].username)).toHaveCount(0);
    await userRow(page, users[0].username).locator("input[name=id]").check();
    await page.getByTestId("btn-bulk-actions").click();
    await page.getByTestId("btn-delete-users").click();
    await confirm(page);
    await expect(userRow(page, users[0].username)).toHaveCount(0);
    await page.goto(USERS);
    await expect(userRow(page, users[0].username)).toHaveCount(0);
    await expect(userRow(page, users[1].username)).toBeVisible();
    await expect(userRow(page, users[2].username)).toBeVisible();
  });
});

test.describe("Your own account", () => {
  test("the last administrator is refused, on the screen", async ({ page }) => {
    await page.goto(USERS);
    const { body } = await api(page, "/api/users");
    const me = body.data.find((u) => u.username === ADMIN.user);
    for (const u of body.data)
      if (u.id !== me.id && u.user_role.id === 1 && u.status === "enabled" && u.type === "user")
        expect((await api(page, `/api/users/${u.id}`, "DELETE")).status).toBe(200);

    await page.goto(`${USERS}/${me.id}`);
    await page.locator("select[name=status]").selectOption("disabled");
    await page.getByTestId("btn-save").click();
    await expect(page.getByText("at least one active Super Admin")).toBeVisible();

    await page.goto(USERS);
    const row = userRow(page).filter({ has: page.getByRole("link", { name: ADMIN.user }) });
    await openMenu(row);
    await row.getByTestId("btn-delete").click();
    await confirm(page);
    await expect(page.getByText("at least one active Super Admin")).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();

    // Password login is not on offer either, because the API would take it.
    await page.goto(`${USERS}/${me.id}`);
    await expect(page.getByTestId("password-login")).toBeDisabled();
    await expect(page.locator("select[name=user_role]")).toBeDisabled();
  });

  test("the screen does not raise your own permissions", async ({ page }) => {
    await page.goto(USERS);
    const manager = await createUser(page, [
      "users:get",
      "users:manage",
      "roles:get",
      "roles:manage",
    ]);
    const other = await signedIn(page, manager.username, PASSWORD, `${USERS}/${manager.id}`);
    const roleSelect = other.locator("select[name=user_role]");
    await expect(roleSelect).toBeDisabled();
    await expect(other.locator("select[name=list_role]")).toBeDisabled();
    // A save of the rest sends "keep", not the stale role.
    await other.locator("input[name=name]").fill("Renamed");
    const request = other.waitForRequest((r) => r.method() === "PUT");
    await other.getByTestId("btn-save").click();
    const sent = (await request).postDataJSON();
    expect([sent.user_role_id, sent.list_role_id]).toEqual([0, 0]);

    const { body } = await api(page, `/api/users/${manager.id}`);
    expect(body.data.name).toBe("Renamed");
    await other.goto(`${USER_ROLES}/${body.data.user_role.id}`);
    await expect(other.getByTestId("own-role")).toBeVisible();
    await expect(other.getByTestId("btn-save")).toBeHidden();
    await expect(other.locator('input[value="settings:manage"]')).toBeDisabled();
    await other.goto(`${USER_ROLES}/1`);
    await expect(other.getByTestId("btn-save")).toBeHidden();
    await other.context().close();
  });

  test("a route asks for what its endpoint asks for, whatever the navigation shows", async ({
    page,
  }) => {
    await page.goto(USERS);
    const viewer = await createUser(page, ["users:get"]);
    const other = await signedIn(page, viewer.username, PASSWORD, USERS);
    await expect(userRow(other).first()).toBeVisible();
    await expect(other.getByTestId("btn-new")).toHaveCount(0);
    await expect(other.locator("input[name=id]")).toHaveCount(0);
    for (const path of [
      `${USERS}/new`,
      USER_ROLES,
      `${USER_ROLES}/new`,
      LIST_ROLES,
      "/admin/settings",
    ])
      expect((await other.goto(path)).status(), path).toBe(403);
    await other.goto(`${USERS}/${viewer.id}`);
    await expect(other.locator("input[name=username]")).toHaveValue(viewer.username);
    await expect(other.getByTestId("btn-save")).toHaveCount(0);
    await other.context().close();
  });
});

test.describe("API users", () => {
  test("shows a token once", async ({ page }) => {
    await page.goto(`${USERS}/new`);
    const name = unique("api-user");
    await page.locator("select[name=type]").selectOption("api");
    await page.locator("input[name=username]").fill(name);
    await page.getByTestId("btn-save").click();
    const token = page.getByTestId("api-token");
    await expect(token).toBeVisible();
    const value = (await token.innerText()).trim();
    expect(value).toMatch(/^[0-9A-Za-z]{48}$/);
    const check = await fetch(`${ORIGIN}/api/profile`, {
      headers: { Authorization: `token ${name}:${value}` },
    });
    expect(check.status).toBe(200);
    await page.getByRole("button", { name: "Close" }).click();
    await page.waitForURL("**/admin/users");
    await gotoUserEdit(page, name);
    await expect(page.locator("input[name=username]")).toHaveValue(name);
    expect(await page.content()).not.toContain(value);
  });
});

test.describe("Stored text", () => {
  test("names are text on every screen", async ({ page }) => {
    await page.goto(USERS);
    const hostile = '<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"';
    const role = await api(page, "/api/roles/users", "POST", {
      name: `${unique("role")} ${hostile}`,
      permissions: ["lists:get_all"],
    });
    const listRole = await api(page, "/api/roles/lists", "POST", {
      name: `${unique("list role")} ${hostile}`,
      lists: [],
    });
    const name = unique("hostile");
    const user = await api(page, "/api/users", "POST", {
      username: name,
      name: hostile,
      email: `${name}@example.test`,
      type: "user",
      status: "enabled",
      user_role_id: role.body.data.id,
      list_role_id: listRole.body.data.id,
    });
    expect(user.status).toBe(200);
    for (const path of [
      USERS,
      `${USERS}/${user.body.data.id}`,
      `${USERS}?user_role_id=${role.body.data.id}&list_role_id=${listRole.body.data.id}`,
      USER_ROLES,
      `${USER_ROLES}/${role.body.data.id}`,
      LIST_ROLES,
      `${LIST_ROLES}/${listRole.body.data.id}`,
    ]) {
      await page.goto(path);
      await expect(page.getByText("onerror").first()).toBeAttached();
      expect(await page.evaluate(() => window.pwned), path).toBeUndefined();
      await expect(page.locator("main img[src=x]")).toHaveCount(0);
    }
  });
});

test.describe("Profile", () => {
  test("edits name, email and password, and ends the other sessions", async ({ page }) => {
    await page.goto(USERS);
    const user = await createUser(page, ["lists:get_all"]);
    const profile = "/admin/user/profile";
    const here = await signedIn(page, user.username, PASSWORD, profile);
    const elsewhere = await signedIn(page, user.username, PASSWORD, profile);

    await expect(here.getByText(`@${user.username}`)).toBeVisible();
    await expect(here.locator("input[name=email]")).toHaveValue(user.email);
    await here.locator("input[name=name]").fill("New name");
    await here.locator("input[name=password]").fill("a-new-password");
    await here.locator("input[name=password2]").fill("not-the-same");
    await here.getByRole("button", { name: "Save", exact: true }).click();
    await expect(here.getByText("Passwords don't match")).toBeVisible();
    expect((await elsewhere.reload()).ok()).toBeTruthy();
    await expect(elsewhere).toHaveURL(new RegExp(`${profile}$`));

    await here.locator("input[name=password2]").fill("a-new-password");
    await here.getByRole("button", { name: "Save", exact: true }).click();
    await expect(here.getByText(`"${user.username}" updated`)).toBeVisible();
    await expect(here.locator("input[name=password]")).toBeEmpty();

    // This session stays; the other one is gone, as PUT /api/profile does it.
    await here.reload();
    await expect(here.locator("input[name=name]")).toHaveValue("New name");
    await elsewhere.reload();
    await expect(elsewhere).toHaveURL(/\/admin\/login/);
    await here.context().close();
    await elsewhere.context().close();

    const again = await signedIn(page, user.username, "a-new-password", profile);
    await expect(again.locator("input[name=name]")).toHaveValue("New name");
    await again.context().close();
  });
});
