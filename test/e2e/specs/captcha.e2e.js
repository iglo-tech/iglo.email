// B4: the public form with ALTCHA, solved by the served widget in Chromium. Upstream has no such
// spec; its widget is the altcha npm build, ours is assets/public/static/altcha.umd.js (D72). The
// run shares one server, so the setting is put back after each test.
import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { ORIGIN, api, login, test, unique } from "../helpers.js";

const SUB_FORM = "/subscription/form";
let before;

async function ok(page, path, method = "GET", body = undefined) {
  const res = await api(page, path, method, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function subscribers(page, email) {
  const query = new URLSearchParams({ query: `subscribers.email = '${email}'` });
  return (await ok(page, `/api/subscribers?${query}`)).results;
}

// Only this test's list is ticked, so a signup touches no other spec's lists.
async function fillForm(page, list, email) {
  await page.goto(SUB_FORM);
  await page.locator("input[name=email]").fill(email);
  for (const box of await page.locator("ul.lists input[type=checkbox]").all()) await box.uncheck();
  await page.locator(`ul.lists input[value="${list.uuid}"]`).check();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  before = (await ok(page, "/api/settings"))["security.captcha"];
  await ok(page, "/api/settings/security.captcha", "PUT", {
    altcha: { enabled: true, complexity: 20000 },
    hcaptcha: { ...before.hcaptcha, enabled: false, secret: "" },
  });
});

test.afterEach(async ({ page }) => {
  await page.goto("/admin");
  await ok(page, "/api/settings/security.captcha", "PUT", {
    ...before,
    hcaptcha: { ...before.hcaptcha, secret: "" },
  });
});

test("the widget solves the challenge, the form subscribes, and a replay is refused", async ({
  page,
}) => {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("captcha"),
    type: "public",
    optin: "single",
  });
  const email = `${unique("altcha")}@example.com`;
  await fillForm(page, list, email);
  const widget = page.locator("altcha-widget");
  await expect(widget.getByText("I'm not a robot")).toBeVisible();
  const challenge = page.waitForResponse((r) => r.url().endsWith("/api/public/captcha/altcha"));
  await widget.getByRole("checkbox").check();
  expect((await challenge).status()).toBe(200);
  await expect(widget).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
  await expect(widget.getByText("Verified")).toBeVisible();
  const payload = await widget.locator('input[name="altcha"]').inputValue();
  const solved = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  expect(Object.keys(solved)).toEqual(["challenge", "solution"]);
  expect(Object.keys(solved.solution)).toEqual(["counter", "derivedKey", "time"]);
  expect(solved.solution.counter).toBeLessThanOrEqual(20000);
  await Promise.all([page.waitForLoadState(), page.locator("button[type=submit]").click()]);
  await expect(page.locator("body")).toContainText("Subscribed successfully.");
  const [row] = await subscribers(page, email);
  expect(row.lists.map((l) => l.uuid)).toEqual([list.uuid]);

  // The same solution again, from another address: refused, and nothing is stored.
  const replayEmail = `${unique("replay")}@example.com`;
  const replay = await page.request.post(SUB_FORM, {
    form: { email: replayEmail, l: list.uuid, altcha: payload },
  });
  expect(replay.status()).toBe(400);
  expect(await replay.text()).toContain("Invalid CAPTCHA.");
  expect(await subscribers(page, replayEmail)).toEqual([]);
});

test("submitting before ticking the box solves first, then submits", async ({ page }) => {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("captcha"),
    type: "public",
    optin: "single",
  });
  const email = `${unique("altcha")}@example.com`;
  await fillForm(page, list, email);
  const posted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === SUB_FORM && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.locator("button[type=submit]").click();
  const response = await posted;
  expect(response.status()).toBe(200);
  expect(response.request().postData()).toContain("altcha=");
  await expect(page.locator("body")).toContainText("Subscribed successfully.");
  expect(await subscribers(page, email)).toHaveLength(1);
});

test("a form without the widget's answer is refused", async ({ page }) => {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("captcha"),
    type: "public",
    optin: "single",
  });
  const response = await page.request.post(SUB_FORM, {
    form: { email: `${unique("bot")}@example.com`, l: list.uuid },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("Invalid CAPTCHA.");
});

test("the forms snippet carries the widget, as upstream's", async ({ page }) => {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("captcha"),
    type: "public",
    optin: "single",
  });
  await page.goto("/admin/lists/forms");
  await page
    .locator("ul[data-testid=lists] li")
    .filter({ hasText: list.name })
    .locator("input")
    .check();
  const html = page.locator("[data-testid=form] [role=textbox]");
  await expect(html).toContainText('/api/public/captcha/altcha"></altcha-widget>');
  await expect(html).toContainText('/public/static/altcha.umd.js" async defer></script>');
});

// A pasted form: the Lists -> Forms snippet served by another site. That site's origin is in
// security.trusted_urls, so the module script and the challenge carry CORS headers for it, as
// upstream; the same page from an origin that is not trusted gets none, and its widget never loads.
test("a snippet pasted on a trusted site loads the widget, solves and subscribes", async ({
  page,
  browser,
}) => {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("pasted"),
    type: "public",
    optin: "single",
  });
  await page.goto("/admin/lists/forms");
  await page
    .locator("ul[data-testid=lists] li")
    .filter({ hasText: list.name })
    .locator("input")
    .check();
  const editor = page.locator("[data-testid=form] [role=textbox]");
  await expect(editor).toContainText("</form>");
  const snippet = await editor.innerText();
  expect(snippet).toContain(`<altcha-widget challenge="${ORIGIN}/api/public/captcha/altcha">`);

  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>${snippet}</body></html>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = site.address().port;
  const trusted = `http://localhost:${port}`;
  const untrusted = `http://127.0.0.1:${port}`;
  const urls = (await ok(page, "/api/settings"))["security.trusted_urls"];
  await ok(page, "/api/settings/security.trusted_urls", "PUT", [...urls, `${trusted}/`]);
  try {
    // A visitor of the other site: a context of its own, without the harness's X-Forwarded-For,
    // which would make every cross-origin request a preflight no real browser sends.
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      const script = (response) =>
        new URL(response.url()).pathname === "/public/static/altcha.umd.js";
      const loaded = visitor.waitForResponse(script);
      await visitor.goto(`${trusted}/`);
      expect((await loaded).headers()["access-control-allow-origin"]).toBe(trusted);
      const email = `${unique("pasted")}@example.com`;
      await visitor.locator("input[name=email]").fill(email);
      const widget = visitor.locator("altcha-widget");
      await widget.getByRole("checkbox").check();
      await expect(widget).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
      await Promise.all([
        visitor.waitForURL(`${ORIGIN}/subscription/form`),
        visitor.locator("input[type=submit]").click(),
      ]);
      await expect(visitor.locator("body")).toContainText("Subscribed successfully.");
      const [row] = await subscribers(page, email);
      expect(row.lists.map((l) => l.uuid)).toEqual([list.uuid]);

      // The same page from an origin that is not trusted: no header, so no widget.
      // The browser blocks the script, so it is a failed request; its answer has no header.
      const refused = visitor.waitForEvent("requestfailed", script);
      await visitor.goto(`${untrusted}/`);
      await refused;
      const direct = await visitor.request.get(`${ORIGIN}/public/static/altcha.umd.js`, {
        headers: { origin: untrusted },
      });
      expect(direct.status()).toBe(200);
      expect(direct.headers()["access-control-allow-origin"]).toBeUndefined();
      await visitor.waitForLoadState("networkidle");
      expect(await visitor.evaluate(() => customElements.get("altcha-widget") === undefined)).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  } finally {
    site.close();
    await page.goto("/admin");
    await ok(page, "/api/settings/security.trusted_urls", "PUT", urls);
  }
});
