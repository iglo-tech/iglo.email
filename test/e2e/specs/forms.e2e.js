// Adapted from listmonk tests/specs/forms.spec.js at 6fcd95f. A run shares one server, so the lists
// are this file's own, found by name, instead of resetDB's seeded ones. `POST /subscription/form`
// is called with the page's request context, as upstream, and needs no session. Settings apply
// live here, so setting trusted URLs needs no wait for a reload.
import { expect } from "@playwright/test";
import { api, createUser, login, logout, mailFor, test, unique } from "../helpers.js";

const FORMS = "/admin/lists/forms";
const SUB_FORM = "/subscription/form";

const REDIRECT_URLS = ["http://localhost:9000/thank-you", "https://example.com/welcome"];

function publicLists(page, name) {
  return page.locator("ul[data-testid=lists] li").filter({ hasText: name });
}

function formHTML(page) {
  return page.locator("[data-testid=form] [role=textbox]");
}

function redirectURLs(page) {
  return page.locator("[data-testid=redirect-urls] input[type=radio]");
}

async function ok(page, path, method = "GET", body = undefined) {
  const res = await api(page, path, method, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function makeList(page, data = {}) {
  return ok(page, "/api/lists", "POST", {
    name: unique("form"),
    type: "public",
    optin: "single",
    ...data,
  });
}

async function setTrustedURLs(page, urls) {
  await ok(page, "/api/settings/security.trusted_urls", "PUT", urls);
}

async function subscribe(page, { email, name, lists }) {
  await page.goto(SUB_FORM);
  await page.locator("input[name=email]").fill(email);
  await page.locator("input[name=name]").fill(name);
  for (const list of lists) {
    await page.locator("ul.lists li").filter({ hasText: list.name }).locator("input").check();
  }
  await Promise.all([page.waitForLoadState(), page.locator("button[type=submit]").click()]);
  // A missing SMTP config surfaces a retry message instead of a success one.
  await expect(page.locator("body")).toContainText(/has been sent|successfully|retry/i);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("lists only public lists and hides the form until one is picked", async ({ page }) => {
  const open = await makeList(page);
  const closed = await makeList(page, { type: "private" });
  const archived = await makeList(page, { status: "archived" });
  await page.goto(FORMS);

  await expect(publicLists(page, open.name)).toHaveCount(1);
  await expect(publicLists(page, closed.name)).toHaveCount(0);
  await expect(publicLists(page, archived.name)).toHaveCount(0);
  await expect(formHTML(page)).toBeHidden();
});

test("hides the redirect URL options when none are whitelisted", async ({ page }) => {
  await setTrustedURLs(page, []);
  await makeList(page);
  await page.goto(FORMS);

  // No trusted URLs, so the picker isn't rendered at all.
  await expect(page.locator("[data-testid=redirect-urls]")).toHaveCount(0);
});

test("generates form HTML for the selected list", async ({ page }) => {
  const list = await makeList(page);
  await page.goto(FORMS);

  const checkbox = publicLists(page, list.name).locator("input");
  const uuid = await checkbox.inputValue();

  await checkbox.check();
  await expect(formHTML(page)).toBeVisible();
  await expect(formHTML(page)).toContainText(uuid);

  await checkbox.uncheck();
  await expect(formHTML(page)).toBeHidden();
});

test("the copied snippet escapes list text and points at the root URL", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `</label><img src=x onerror="window.pwned=1"> ' & ${unique("hostile")}`;
  const description = `<script>window.pwned=2</script> "${unique("description")}"`;
  const list = await makeList(page, { name, description });
  const settings = await ok(page, "/api/settings");
  await page.goto(FORMS);

  await publicLists(page, name).locator("input").check();
  await expect(formHTML(page)).toContainText("&lt;img");
  await expect(page.locator(".forms img, .forms script")).toHaveCount(0);
  await page.getByTestId("btn-copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(list.uuid);

  const parsed = await page.evaluate(async () => {
    const html = await navigator.clipboard.readText();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return {
      images: doc.querySelectorAll("img").length,
      scripts: doc.querySelectorAll("script").length,
      label: doc.querySelector("label").textContent,
      description: doc.querySelector("span").textContent,
      action: doc.querySelector("form").getAttribute("action"),
    };
  });
  expect(parsed).toEqual({
    images: 0,
    scripts: 0,
    label: name,
    description,
    action: `${settings["app.root_url"]}/subscription/form`,
  });
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a list scope limits the lists and a session is enough for the route", async ({ page }) => {
  const list = await makeList(page);
  const user = await createUser(page, ["campaigns:get"]);
  await logout(page);
  await login(page, user.username, "e2e-user-password");
  const answer = await page.goto(FORMS);
  expect(answer.status()).toBe(200);
  await expect(publicLists(page, list.name)).toHaveCount(0);
  await expect(page.getByTestId("no-lists")).toBeVisible();
});

test("subscribes new subscribers, then unsubscribes and manages preferences", async ({
  page,
  context,
}) => {
  const optin = await makeList(page, { optin: "double" });
  const single = await makeList(page);
  const a = `${unique("form")}@example.com`;
  const b = `${unique("form")}@example.com`;
  const campaign = await ok(page, "/api/campaigns", "POST", {
    name: unique("Form campaign"),
    subject: "Form campaign",
    type: "regular",
    content_type: "html",
    body: "Test",
    lists: [optin.id],
  });
  const lists = [optin, single];

  // The public pages are visited without the admin session.
  await context.clearCookies();
  await subscribe(page, { email: a, name: "test0", lists });
  await subscribe(page, { email: b, name: "test1", lists });
  // The double opt-in list sent each of them a confirmation email.
  await mailFor(a);
  await mailFor(b);

  await login(page);
  const sub = async (email) => {
    const query = encodeURIComponent(`subscribers.email = '${email}'`);
    const data = await ok(page, `/api/subscribers?query=${query}`);
    return data.results.find((s) => s.email === email);
  };
  const status = (s, list) => s.lists.find((l) => l.id === list.id).subscription_status;
  const first = await sub(a);
  const second = await sub(b);
  expect(first.lists).toHaveLength(2);
  expect(second.lists).toHaveLength(2);

  // Unsubscribe from the campaign's list only.
  const url = `/subscription/${campaign.uuid}/${first.uuid}`;
  await page.goto(url);
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);
  expect(status(await sub(a), optin)).toBe("unsubscribed");
  expect(status(await sub(a), single)).not.toBe("unsubscribed");

  // Unsubscribe from everything and blocklist.
  await page.goto(url);
  await page.locator("#privacy-blocklist").check();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);
  const blocked = await sub(a);
  expect(blocked.status).toBe("blocklisted");
  expect(status(blocked, optin)).toBe("unsubscribed");
  expect(status(blocked, single)).toBe("unsubscribed");

  // Manage subscription preferences.
  await page.goto(`/subscription/${campaign.uuid}/${second.uuid}?manage=true`);
  await page.locator("input[name=name]").fill("new-name");
  await page.locator("ul.lists li").filter({ hasText: optin.name }).locator("input").uncheck();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/updated|preferences/i);
  const managed = await sub(b);
  expect(managed.name).toBe("new-name");
  expect(status(managed, optin)).toBe("unsubscribed");
  expect(status(managed, single)).not.toBe("unsubscribed");
});

test.describe("Forms redirect URL whitelist", () => {
  test.beforeEach(async ({ page }) => {
    await setTrustedURLs(page, REDIRECT_URLS);
  });
  test.afterEach(async ({ page }) => {
    await setTrustedURLs(page, []);
  });

  test("lists whitelisted URLs as redirect options", async ({ page }) => {
    await makeList(page);
    await page.goto(FORMS);

    // A "None" radio plus one per whitelisted URL, with "None" selected by default.
    await expect(redirectURLs(page)).toHaveCount(REDIRECT_URLS.length + 1);
    await expect(page.locator('[data-testid=redirect-urls] input[value=""]')).toBeChecked();
    for (const url of REDIRECT_URLS) {
      await expect(page.locator(`[data-testid=redirect-urls] input[value="${url}"]`)).toHaveCount(
        1,
      );
    }
  });

  test('injects the selected redirect URL as a hidden "next" field', async ({ page }) => {
    const list = await makeList(page);
    await page.goto(FORMS);

    // A list has to be picked before any form HTML is generated.
    await publicLists(page, list.name).locator("input").check();
    await expect(formHTML(page)).toBeVisible();
    await expect(formHTML(page)).not.toContainText('name="next"');

    await page.locator(`[data-testid=redirect-urls] input[value="${REDIRECT_URLS[1]}"]`).check();
    await expect(formHTML(page)).toContainText(
      `<input type="hidden" name="next" value="${REDIRECT_URLS[1]}" />`,
    );

    // Switching back to "None" removes it again.
    await page.locator('[data-testid=redirect-urls] input[value=""]').check();
    await expect(formHTML(page)).not.toContainText('name="next"');
  });

  test('redirects to a whitelisted "next" URL after submission', async ({ page }) => {
    const list = await makeList(page);
    const res = await page.request.post(SUB_FORM, {
      form: {
        email: `${unique("redirect")}@test.com`,
        name: "redirect",
        l: list.uuid,
        next: REDIRECT_URLS[0],
      },
      maxRedirects: 0,
    });

    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe(REDIRECT_URLS[0]);
  });

  test('ignores a non-whitelisted "next" URL to prevent open redirects', async ({ page }) => {
    const list = await makeList(page);
    const res = await page.request.post(SUB_FORM, {
      form: {
        email: `${unique("noredirect")}@test.com`,
        name: "noredirect",
        l: list.uuid,
        next: "https://evil.example.com/phish",
      },
      maxRedirects: 0,
    });

    // No redirect: the normal confirmation page is rendered instead.
    expect(res.status()).toBe(200);
    expect(res.headers().location).toBeUndefined();
    expect(await res.text()).toMatch(/subscri|confirm/i);
  });
});
