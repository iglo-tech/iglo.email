// Adapted from listmonk tests/helpers.js at 6fcd95f. The harness owns the servers, so there is
// no resetDB; each spec makes its own uniquely named data through the public API.
import { randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";

export { totp } from "./totp.ts";

export const ORIGIN = process.env.E2E_ORIGIN;
export const BLANK_ORIGIN = process.env.E2E_BLANK_ORIGIN;
export const ADMIN = { user: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASSWORD };
export const PASSWORD = "e2e-user-password";

// The client address each test page presents through the trusted proxy; see `test` below.
const peers = new WeakMap();

export const unique = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;

// Each test is its own client, through the trusted proxy run.ts configures, so a run of specs
// stays inside the real login limit of 20 posts a minute per client. Every page also reports what
// the admin policy (D71) refused and what Alpine's CSP build could not evaluate, and a test fails
// on either unless it sets `violations: "expected"`. A sandboxed preview runs no script, so what its
// own policy refuses there is not counted.
export const test = base.extend({
  violations: ["none", { option: true }],
  page: async ({ page, violations }, use) => {
    const peer = `203.0.113.${1 + (randomBytes(1)[0] % 254)}`;
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": peer });
    peers.set(page, peer);
    const seen = [];
    await page.exposeBinding("__reportViolation", (_source, text) => seen.push(text));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__reportViolation?.(
          `${event.effectiveDirective} ${event.blockedURI} on ${document.location.pathname}`,
        );
      });
    });
    page.on("console", (message) => {
      if (message.text().includes("Alpine Expression Error")) seen.push(message.text());
    });
    await use(page);
    if (violations === "none") expect(seen).toEqual([]);
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

// Start an administrator session the way `login` does, but without drawing the pages: fetch the
// login page for its nonce, post the form, and leave the page on a small same-origin document that
// holds the session and CSRF cookies, which is all `api` needs. The login, two-factor, reset and
// logout specs go through the form with `login`; every other test only needs the session, and
// each still gets a fresh one of its own. Navigate with `page.goto` afterwards.
export async function signIn(page, username = ADMIN.user, password = ADMIN.password) {
  const headers = { "X-Forwarded-For": peers.get(page) };
  const form = await page.request.get("/admin/login?next=%2Fadmin", { headers });
  const nonce = /name="nonce" value="([^"]+)"/.exec(await form.text())?.[1];
  expect(nonce, "the login page carries a nonce").toBeTruthy();
  const posted = await page.request.post("/admin/login", {
    headers,
    form: { username, password, next: "/admin", nonce },
    maxRedirects: 0,
  });
  expect(posted.status(), "the login form redirects to the admin").toBe(302);
  expect(posted.headers().location).toBe("/admin");
  await page.goto("/api/health");
}

// Log out through the user menu. After `signIn` the page holds no admin screen yet, so open one.
export async function logout(page) {
  if (!new URL(page.url()).pathname.startsWith("/admin")) await page.goto("/admin");
  await page.locator(".user-trigger").click();
  await Promise.all([
    page.waitForURL("**/admin/login"),
    page.getByRole("menuitem", { name: "Logout" }).click(),
  ]);
}

// Open a table row's "More" actions dropdown.
export async function openMenu(row) {
  await row.getByRole("button", { name: "More" }).click();
}

// Click the "Ok" button on the confirmation dialog.
export async function confirm(page) {
  await page.locator("dialog[open] [data-confirm-ok]").click();
}

// Pick a list by name in an <ot-taginput> list selector. Filling the input matches a datalist
// option, which the component turns into a badge. Upstream stops there; a run here can have more
// lists than the ten suggestions on focus, so an option that only filling brought up is handed to
// the component as the browser's own pick would be.
export async function selectList(scope, name) {
  const input = scope.locator("ot-taginput input");
  await input.click();
  await input.fill(name);
  await input.evaluate((el, wanted) => {
    const option = [...el.list.options].find((o) => o.value === wanted);
    if (option) el.closest("ot-taginput").add(option.data);
  }, name);
  await expect(scope.locator("ot-taginput .badge").filter({ hasText: name })).toBeVisible();
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
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() };
    },
    [path, method, body],
  );
}

// A session-authenticated API call that must succeed; returns `data`.
export async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

export const makeList = (page, name = unique("Audience"), optin = "single") =>
  ok(page, "/api/lists", "POST", { name, type: "private", optin });

// One subscriber on a new list, for mail the sink can be asked about.
export async function audience(page, count = 1) {
  const list = await makeList(page);
  const emails = Array.from({ length: count }, () => `${unique("reader")}@example.com`);
  // One round trip for all of them, in order; the first refusal is reported with its answer.
  const refused = await page.evaluate(
    async ([listID, addresses]) => {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice(5) ?? "";
      for (const [i, email] of addresses.entries()) {
        const response = await fetch("/api/subscribers", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ email, name: `Reader ${i}`, status: "enabled", lists: [listID] }),
        });
        if (response.status !== 200)
          return { status: response.status, body: await response.text() };
      }
      return null;
    },
    [list.id, emails],
  );
  expect(refused, "seeding the audience").toBeNull();
  return { list, emails };
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

// How many mails the sink holds for each address, right now.
export async function mailCounts(addresses) {
  return Promise.all(
    addresses.map(async (address) => {
      const response = await fetch(`${process.env.E2E_MAIL}?to=${encodeURIComponent(address)}`);
      return (await response.json()).length;
    }),
  );
}

// Counts per address once they have held still for `settle` ms of real time. Nothing is
// signalled when a send finishes, so a quiet window is the only evidence that no more are coming.
// Bounded by `timeout`, which fails the test rather than waiting for a count that keeps moving.
export async function settledMail(addresses, { settle = 1500, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let counts = await mailCounts(addresses);
  let stillSince = Date.now();
  while (Date.now() - stillSince < settle) {
    if (Date.now() > deadline)
      throw new Error(`mail counts kept changing for ${timeout} ms: ${counts.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await mailCounts(addresses);
    if (next.some((count, i) => count !== counts[i])) {
      counts = next;
      stillSince = Date.now();
    }
  }
  return counts;
}
