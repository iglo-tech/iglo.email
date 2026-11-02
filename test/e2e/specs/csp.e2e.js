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
