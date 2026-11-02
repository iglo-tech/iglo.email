// The rich-text surface on the admin origin (D66, D71). listmonk has no such spec at 6fcd95f. The
// corpus runs twice: once without the page's policy, so the allow-list alone holds it, and once
// with the policy, the way an administrator meets it.
import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { corpus, audit } from "../hostile-html.js";
import { api, login, ORIGIN, test, unique } from "../helpers.js";

const EDITOR = 'richtext-editor [contenteditable="true"]';

async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function campaign(page, body = "<p>Body</p>") {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Containment"),
    type: "private",
    optin: "single",
  });
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "richtext",
    body,
    lists: [list.id],
  });
}

async function open(page, id, query = "") {
  await page.goto(`/admin/campaigns/${id}${query}#tab=content`);
  await expect(page.locator(EDITOR)).toBeVisible();
}

// Mounts, serializes and mounts that again, which is where a mutation shape would turn, then undoes
// and redoes through Squire's own innerHTML. A failed image has reported by the time a later one
// loads, so the wait is a real one. `value` is what the screen would store.
const exercise = (page, html) =>
  // As source text: the page's policy refuses `new Function`, and `audit` has to reach the page.
  page.evaluate(`(${mountAndAudit})(${JSON.stringify(html)}, ${audit})`);

async function mountAndAudit(html, check) {
  const host = document.querySelector("richtext-editor");
  const content = host.querySelector("[data-rte-content]");
  const settle = () =>
    new Promise((resolve) => {
      const probe = new Image();
      probe.onload = probe.onerror = () => setTimeout(resolve, 30);
      probe.src = `/admin/static/favicon.png?${Math.random()}`;
    });
  const bad = [];
  host.value = html;
  await settle();
  bad.push(...check(content));
  const once = host.value;
  host.value = "";
  host.value = once;
  await settle();
  bad.push(...check(content));
  const twice = host.value;
  host.editor.moveCursorToEnd();
  host.editor.insertPlainText("typed", false);
  host.editor.saveUndoState();
  host.editor.undo();
  await settle();
  bad.push(...check(content));
  host.editor.redo();
  await settle();
  bad.push(...check(content));
  return {
    bad,
    ran: window.__hostile,
    stable: once === twice,
    pathname: location.pathname,
    scripts: document.querySelectorAll("script").length,
    clobbered: [
      document.body instanceof HTMLBodyElement,
      typeof document.getElementById === "function",
      typeof document.cookie === "string",
      location instanceof Location,
      !!document.querySelector("body > template#confirm-dialog-template"),
    ].includes(false),
  };
}

for (const [mode, bypassCSP] of [
  ["the allow-list alone", true],
  ["the allow-list and the page's policy", false],
]) {
  test.describe(`${mode} holds the corpus`, () => {
    test.use({ bypassCSP, violations: "expected" });
    for (const [group, bodies] of Object.entries(corpus)) {
      test(group, async ({ page }) => {
        const outside = [];
        page.on("request", (request) => {
          if (/^https?:/.test(request.url()) && !request.url().startsWith(ORIGIN))
            outside.push(request.url());
        });
        await login(page);
        const c = await campaign(page);
        await open(page, c.id);
        const before = await page.evaluate(() => document.querySelectorAll("script").length);
        for (const body of bodies) {
          const result = await exercise(page, body);
          expect({ body, ...result }).toEqual({
            body,
            bad: [],
            ran: undefined,
            stable: true,
            pathname: `/admin/campaigns/${c.id}`,
            scripts: before,
            clobbered: false,
          });
        }
        expect(outside).toEqual([]);
      });
    }
  });
}

test.describe("what the editor keeps from a hostile body", () => {
  test.use({ violations: "expected" });
  test("a head is named in the warning, with what a body removed", async ({ page }) => {
    await login(page);
    const c = await campaign(
      page,
      "<html><head><title>t</title><style>p{color:red}</style><meta charset=utf-8>" +
        "<base href=/x/></head><body><p>kept</p><script>1</script></body></html>",
    );
    await open(page, c.id);
    const notice = page.getByTestId("editor-removed");
    for (const name of ["title", "style", "meta", "base", "script"])
      await expect(notice).toContainText(name);
  });

  test("a body holding the confirm template's id leaves the dialog working", async ({ page }) => {
    await login(page);
    const c = await campaign(page, '<div id="confirm-dialog-template">x</div><p>y</p>');
    await open(page, c.id);
    await page.locator(EDITOR).pressSequentially("x");
    await page.evaluate(() =>
      document
        .querySelector("richtext-editor")
        .dispatchEvent(new CustomEvent("richtext-held", { bubbles: true })),
    );
    await page.getByTestId("editor-held").getByRole("button").click();
    await expect(page.locator("dialog.confirm-dialog")).toBeVisible();
  });
});

test.describe("foreign content and undo", () => {
  test("editing around markup that foreign content would reparse stays in the allow-list", async ({
    page,
  }) => {
    await login(page);
    const body =
      "<p>one</p><table><tr><td>cell<svg><title>a</title></svg></td></tr></table>" +
      "<p>two<math><mi>x</mi></math></p>";
    const c = await campaign(page, body);
    await open(page, c.id);
    const editor = page.locator(EDITOR);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" more");
    await page.keyboard.press("Enter");
    await page.keyboard.type("line");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    for (const key of ["Control+z", "Control+z", "Control+z", "Control+Shift+z", "Control+Shift+z"])
      await page.keyboard.press(key);
    const bad = await page.evaluate(`(${audit})(document.querySelector("[data-rte-content]"))`);
    expect(bad).toEqual([]);
    await expect(editor).toContainText("cell");
    await expect(editor).toContainText("two");
  });
});

test.describe("a refused URL", () => {
  test("stays in the link dialog with a message", async ({ page }) => {
    await login(page);
    const c = await campaign(page);
    await open(page, c.id);
    await page.locator(EDITOR).click();
    await page.keyboard.press("Control+k");
    const dialog = page.locator('richtext-editor dialog[data-rte-dialog="link"]');
    const message = dialog.locator("[data-rte-url-error]");
    await expect(message).toBeHidden();
    await dialog.locator('[name="url"]').fill("javascript:window.pwned=1");
    await dialog.locator('[data-rte-act="submit"]').click();
    await expect(message).toBeVisible();
    await expect(dialog).toHaveAttribute("open");
    await dialog.locator('[name="url"]').fill("https://example.test/");
    await expect(message).toBeHidden();
    await dialog.locator('[name="text"]').fill("fine");
    await dialog.locator('[data-rte-act="submit"]').click();
    await expect(dialog).not.toHaveAttribute("open");
    await expect(page.locator(`${EDITOR} a[href^="https://example.test/"]`)).toHaveCount(1);
  });

  test("stays in the image dialog with a message", async ({ page }) => {
    await login(page);
    const c = await campaign(page);
    await open(page, c.id);
    await page.locator('richtext-editor [data-cmd="image"]').first().click();
    const dialog = page.locator('richtext-editor dialog[data-rte-dialog="image"]');
    await dialog.locator('[name="src"]').fill("data:text/html,x");
    await dialog.locator('[data-rte-act="submit"]').click();
    await expect(dialog.locator("[data-rte-url-error]")).toBeVisible();
    await expect(dialog).toHaveAttribute("open");
  });
});

test.describe("remote images load on request", () => {
  let server;
  let remote;
  let requests;
  test.beforeAll(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader("Content-Type", "image/gif");
      response.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    remote = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterAll(() => new Promise((resolve) => server.close(resolve)));

  test("a body fetches nothing, reports nothing and is stored as written until asked", async ({
    page,
  }) => {
    await login(page);
    const body =
      `<p>before</p><p><img src="${remote}/banner.gif" alt="banner"></p>` +
      `<table><tbody><tr><td background="${remote}/cell.gif">cell</td></tr></tbody></table>`;
    const c = await campaign(page, body);
    await open(page, c.id);
    const notice = page.getByTestId("editor-held");
    await expect(notice).toBeVisible();
    expect(requests).toEqual([]);

    // An edit stores the addresses as they were written.
    await page.locator(EDITOR).pressSequentially("x");
    const save = page.waitForResponse((r) => r.request().method() === "PUT");
    await page.keyboard.press("Control+s");
    expect((await save).status()).toBe(200);
    const stored = (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
    expect(stored).toContain(`src="${remote}/banner.gif"`);
    expect(stored).toContain(`background="${remote}/cell.gif"`);
    expect(stored).not.toContain("data-rte-");
    expect(requests).toEqual([]);

    // Asking reloads the page under a policy that allows them.
    await notice.getByRole("button").click();
    await expect(page).toHaveURL(/remote_images=1/);
    await expect(page.locator(`${EDITOR} img[src="${remote}/banner.gif"]`)).toHaveCount(1);
    await expect(notice).toBeHidden();
    await expect.poll(() => requests).toContain("/banner.gif");
  });

  test.describe("a real cut and paste", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    test("keeps the addresses of held images and backgrounds", async ({ page }) => {
      await login(page);
      const body =
        `<p>first</p><p>move <img src="${remote}/moved.gif" alt="banner"> me</p>` +
        `<table><tbody><tr><td background="${remote}/moved-cell.gif">cell</td></tr></tbody></table>` +
        "<p>last</p>";
      const c = await campaign(page, body);
      await open(page, c.id);
      await page.locator(`${EDITOR} p`).first().click();
      for (const key of ["Control+a", "Control+x"]) await page.keyboard.press(key);
      await expect(page.locator(`${EDITOR} img`)).toHaveCount(0);
      await page.keyboard.press("Control+v");
      await expect(page.locator(`${EDITOR} img`)).toHaveCount(1);
      await expect(page.getByTestId("editor-removed")).toBeHidden();

      const save = page.waitForResponse((r) => r.request().method() === "PUT");
      await page.keyboard.press("Control+s");
      expect((await save).status()).toBe(200);
      const stored = (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
      expect(stored).toContain(`src="${remote}/moved.gif"`);
      expect(stored).toContain(`background="${remote}/moved-cell.gif"`);
      expect(stored).not.toContain("data-rte-");
      expect(requests.filter((path) => /moved/.test(path))).toEqual([]);
    });

    test("a pasted internal attribute is an address like any other", async ({ page }) => {
      await login(page);
      const c = await campaign(page);
      await open(page, c.id);
      await page.locator(EDITOR).evaluate((el, html) => {
        el.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", html);
        el.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      }, `<img id="moved" data-rte-src="javascript:window.__hostile=1" alt="x">`);
      await expect(page.locator(`${EDITOR} #moved`)).toHaveCount(1);
      expect(await page.locator(`${EDITOR} #moved`).getAttribute("data-rte-src")).toBeNull();
      expect(await page.locator(`${EDITOR} #moved`).getAttribute("src")).toBeNull();
      await expect(page.getByTestId("editor-removed")).toContainText('src="javascript');
      await expect(page.getByTestId("editor-removed")).not.toContainText("data-rte");
    });
  });

  test.describe("the image dialog on a held image", () => {
    const imageAfter = async (page, stored, change) => {
      await login(page);
      const c = await campaign(page, `<p>${stored}</p>`);
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).dblclick();
      const dialog = page.locator('richtext-editor dialog[data-rte-dialog="image"]');
      await expect(dialog).toHaveAttribute("open");
      await change(dialog);
      await dialog.locator('[data-rte-act="submit"]').click();
      await expect(dialog).not.toHaveAttribute("open");
      const save = page.waitForResponse((r) => r.request().method() === "PUT");
      await page.keyboard.press("Control+s");
      expect((await save).status()).toBe(200);
      return /<img[^>]*>/.exec((await ok(page, `/api/campaigns/${c.id}`, "GET")).body)[0];
    };
    const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
    const alt = (dialog) => dialog.locator('[name="alt"]').fill("edited");

    test("a stored image with no size keeps none", async ({ page }) => {
      const tag = await imageAfter(page, `<img src="${remote}/none.gif" alt="a">`, alt);
      expect(attribute(tag, "alt")).toBe("edited");
      expect(attribute(tag, "src")).toBe(`${remote}/none.gif`);
      expect(attribute(tag, "width")).toBeNull();
      expect(attribute(tag, "height")).toBeNull();
    });

    test("a stored width stays alone, with no height added", async ({ page }) => {
      const tag = await imageAfter(page, `<img src="${remote}/w.gif" alt="a" width="600">`, alt);
      expect(attribute(tag, "width")).toBe("600");
      expect(attribute(tag, "height")).toBeNull();
    });

    test("a size only in style, or as a percentage, stays as stored", async ({ page }) => {
      const stored = `<img src="${remote}/s.gif" alt="a" width="100%" style="height: 80px;">`;
      const tag = await imageAfter(page, stored, alt);
      expect(attribute(tag, "width")).toBe("100%");
      expect(attribute(tag, "height")).toBeNull();
      expect(attribute(tag, "style")).toContain("height: 80px");
    });

    test("the proportion comes from the stored size, not the placeholder", async ({ page }) => {
      const stored = `<img src="${remote}/r.gif" alt="a" width="600" height="400">`;
      const tag = await imageAfter(page, stored, (dialog) =>
        dialog.locator('[name="width"]').fill("300"),
      );
      expect(attribute(tag, "width")).toBe("300");
      expect(attribute(tag, "height")).toBe("200");
    });

    test("with one stored side, a change leaves the other alone", async ({ page }) => {
      const stored = `<img src="${remote}/o.gif" alt="a" width="600">`;
      const tag = await imageAfter(page, stored, (dialog) =>
        dialog.locator('[name="width"]').fill("300"),
      );
      expect(attribute(tag, "width")).toBe("300");
      expect(attribute(tag, "height")).toBeNull();
    });
  });

  test("a changed subject is asked about before the page reloads", async ({ page }) => {
    await login(page);
    const c = await campaign(page, `<p><img src="${remote}/subject.gif" alt="a"></p>`);
    await page.goto(`/admin/campaigns/${c.id}`);
    await page.locator('input[name="subject"]').fill("Changed subject");
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    const held = page.getByTestId("editor-held");
    await held.getByRole("button").click();
    const dialog = page.locator("dialog.confirm-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-confirm-cancel]").click();
    expect(page.url()).not.toContain("remote_images");
    await page.getByRole("tab", { name: "Campaign", exact: true }).click();
    await expect(page.locator('input[name="subject"]')).toHaveValue("Changed subject");

    await page.getByRole("tab", { name: "Content", exact: true }).click();
    await held.getByRole("button").click();
    await page.locator("dialog.confirm-dialog [data-confirm-ok]").click();
    await expect(page).toHaveURL(/remote_images=1/);
  });

  test("a typed address waits the same way, and unsaved changes are asked about", async ({
    page,
  }) => {
    await login(page);
    requests.length = 0;
    const c = await campaign(page);
    await open(page, c.id);
    await page.locator('richtext-editor [data-cmd="image"]').first().click();
    const dialog = page.locator('richtext-editor dialog[data-rte-dialog="image"]');
    await dialog.locator('[name="src"]').fill(`${remote}/typed.gif`);
    await dialog.locator('[name="alt"]').fill("typed");
    await dialog.locator('[data-rte-act="submit"]').click();
    await expect(page.locator(`${EDITOR} img[data-rte-src]`)).toHaveCount(1);
    expect(await page.locator(`${EDITOR} img`).getAttribute("src")).toBeNull();
    expect(requests).toEqual([]);

    await page.getByTestId("editor-held").getByRole("button").click();
    await page.locator("dialog.confirm-dialog [data-confirm-cancel]").click();
    expect(page.url()).not.toContain("remote_images");
    expect(requests).toEqual([]);
  });
});
