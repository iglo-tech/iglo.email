// The rich-text surface on the admin origin (D66, D71). listmonk has no such spec at 6fcd95f. The
// corpus runs twice: once without the page's policy, so the allow-list alone holds it, and once
// with the policy, the way an administrator meets it.
import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { corpus, audit } from "../hostile-html.js";
import { api, ORIGIN, test, unique, signIn } from "../helpers.js";

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
        await signIn(page);
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
    await signIn(page);
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
    await signIn(page);
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
    await signIn(page);
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
    await signIn(page);
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
    await signIn(page);
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
    await signIn(page);
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

  test("a style that fetches a remote address is held and noticed, and stored as written (B10)", async ({
    page,
  }) => {
    await signIn(page);
    const body = `<p style="background-image: url('${remote}/style.gif'); color: red">styled</p>`;
    const c = await campaign(page, body);
    await open(page, c.id);
    await expect(page.getByTestId("editor-held")).toBeVisible();
    // Only the declaration that would fetch waits; the rest stays live.
    const live = await page.locator(`${EDITOR} p`).first().getAttribute("style");
    expect(live).toContain("color: red");
    expect(live).not.toContain("url(");
    await page.locator(EDITOR).pressSequentially("x");
    const save = page.waitForResponse((r) => r.request().method() === "PUT");
    await page.keyboard.press("Control+s");
    expect((await save).status()).toBe(200);
    const stored = (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
    expect(stored).toContain(`url('${remote}/style.gif')`);
    expect(stored).not.toContain("data-rte-");
    expect(requests.filter((path) => /style\.gif/.test(path))).toEqual([]);
  });

  const saved = async (page, id) => {
    const save = page.waitForResponse((r) => r.request().method() === "PUT");
    await page.keyboard.press("Control+s");
    expect((await save).status()).toBe(200);
    return (await ok(page, `/api/campaigns/${id}`, "GET")).body;
  };

  test("aligning a block with a held background keeps the alignment and the background (B10)", async ({
    page,
  }) => {
    await signIn(page);
    const body = `<p style="background-image: url('${remote}/bg.gif'); padding: 16px">Hello</p>`;
    const c = await campaign(page, body);
    await open(page, c.id);
    await expect(page.getByTestId("editor-held")).toBeVisible();
    await page.locator(`${EDITOR} p`).first().click();
    await page.locator('richtext-editor [data-cmd="align"][data-value="center"]').click();
    const stored = await saved(page, c.id);
    expect(stored).toContain(`url('${remote}/bg.gif')`);
    expect(stored).toContain("padding: 16px");
    expect(stored).toMatch(/text-align:\s*center/);
    expect(stored).not.toContain("data-rte-");
    expect(requests.filter((path) => /bg\.gif/.test(path))).toEqual([]);
  });

  test("resizing an image with a held background keeps the size and the background (B10)", async ({
    page,
  }) => {
    await signIn(page);
    const body = `<p>text <img src="/admin/static/favicon.png" alt="b" style="background-image: url('${remote}/img-bg.gif'); padding: 2px"> more</p>`;
    const c = await campaign(page, body);
    await open(page, c.id);
    await page.locator(`${EDITOR} img`).click();
    const handle = page.locator(".squire-resize-handle-se");
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 80, { steps: 8 });
    await page.mouse.up();
    await page.locator(EDITOR).click({ position: { x: 5, y: 5 } });
    await page.locator(EDITOR).pressSequentially("x");
    const stored = await saved(page, c.id);
    const tag = /<img[^>]*>/.exec(stored)[0];
    expect(tag).toMatch(/width:\s*[1-9]\d*px/);
    expect(tag).toContain(`url('${remote}/img-bg.gif')`);
    expect(tag).toContain("padding: 2px");
    expect(tag).not.toContain("data-rte-");
  });

  // CSS order matters: a shorthand resets the longhands before it, so a held declaration stays
  // where it was and saving without a style edit stores the same declarations in the same order.
  const orderCells = (r) => [
    `background: url('${r}/hero.gif') center/cover no-repeat; background-color: #1a1a1a`,
    `background: url('${r}/size.gif'); background-size: cover`,
    `background-image: url('${r}/a.gif'); background-image: linear-gradient(red, blue)`,
  ];
  const styleOf = (html, index) =>
    new DOMParser()
      .parseFromString(html, "text/html")
      .querySelectorAll("td")
      [index].getAttribute("style");

  test("saving held background cells unedited keeps declaration order and values (B10)", async ({
    page,
    context,
  }) => {
    await signIn(page);
    const cells = orderCells(remote);
    const body = `<table><tbody><tr>${cells.map((c, i) => `<td style="${c}">cell${i}</td>`).join("")}</tr></tbody></table>`;
    const c = await campaign(page, body);
    await open(page, c.id);
    await expect(page.getByTestId("editor-held")).toBeVisible();
    // Only text is edited; every style is as it was.
    await page.locator(`${EDITOR} td`).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    const stored = await saved(page, c.id);
    expect(stored).not.toContain("data-rte-");
    expect(requests.filter((path) => /hero|size|a\.gif/.test(path))).toEqual([]);
    const probe = await context.newPage();
    for (const [i, original] of cells.entries()) {
      const got = await page.evaluate(`(${styleOf})(${JSON.stringify(stored)}, ${i})`);
      expect(got.replace(/\s+/g, " ")).toBe(original);
      const computed = (style) =>
        probe.evaluate((css) => {
          const el = document.body.appendChild(document.createElement("div"));
          el.setAttribute("style", css);
          const s = getComputedStyle(el);
          return [
            s.backgroundColor,
            s.backgroundSize,
            s.backgroundPosition,
            s.backgroundRepeat,
            s.backgroundImage,
          ];
        }, style);
      expect(await computed(got)).toEqual(await computed(original));
    }
    await probe.close();
  });

  test("centring a hero cell keeps the colour after the shorthand (B10)", async ({ page }) => {
    await signIn(page);
    const [hero] = orderCells(remote);
    const c = await campaign(
      page,
      `<table><tbody><tr><td style="${hero}">hero</td></tr></tbody></table>`,
    );
    await open(page, c.id);
    await page.locator(`${EDITOR} td`).first().click();
    await page.locator('richtext-editor [data-cmd="align"][data-value="center"]').click();
    const stored = await saved(page, c.id);
    const style = /<td[^>]*style="([^"]*)"/.exec(stored)[1];
    expect(style).toMatch(/text-align:\s*center/);
    expect(style.indexOf("background-color")).toBeGreaterThan(style.indexOf("background:"));
    expect(style).toMatch(/background-color:\s*(?:#1a1a1a|rgb\(26, 26, 26\))/);
    expect(style).toContain(`url('${remote}/hero.gif')`);
    expect(stored).not.toContain("data-rte-");
  });

  const storedStyle = (stored) => /<p[^>]*style="([^"]*)"/.exec(stored)[1].replace(/\s+/g, " ");

  test("repeated identical declarations in a held block keep their order (B12)", async ({
    page,
  }) => {
    await signIn(page);
    const style = `background-image: url('${remote}/rep.gif'); color: red; color: blue; color: red`;
    const c = await campaign(page, `<p style="${style}">repeat</p>`);
    await open(page, c.id);
    await page.locator(`${EDITOR} p`).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    const stored = await saved(page, c.id);
    expect(storedStyle(stored)).toBe(style);
    expect(stored).not.toContain("data-rte-");
  });

  test("a held block style with CSS comments is edited without breaking them (B12)", async ({
    page,
  }) => {
    await signIn(page);
    const style = `/* a; b */ color: red; background-image: url('${remote}/cm.gif'); /* it's; (c */ margin-top: 3px`;
    const c = await campaign(page, `<p style="${style}">comment</p>`);
    await open(page, c.id);
    await page.locator(`${EDITOR} p`).first().click();
    await page.locator('richtext-editor [data-cmd="align"][data-value="center"]').click();
    const got = storedStyle(await saved(page, c.id));
    // Each declaration once, the held one in its place, and no half of a comment left behind.
    expect(got.match(/color: red/g)).toHaveLength(1);
    expect(got.match(/margin-top: 3px/g)).toHaveLength(1);
    expect(got).toContain(`url('${remote}/cm.gif')`);
    expect(got).toMatch(/text-align: center/);
    expect(got.indexOf("color: red")).toBeLessThan(got.indexOf("background-image"));
    expect(got.replace(/\/\*.*?\*\//g, "")).not.toMatch(/\/\*|\*\/|[a-z-]+; [a-z]+ \*\//);
  });

  test("a shorthand the editor rewrites stays before a later held declaration (B12)", async ({
    page,
  }) => {
    await signIn(page);
    // The !important longhand makes the browser write the shorthand as its sides.
    const style = `margin: 0; margin-top: 3px !important; background-image: url('${remote}/sh.gif'); color: red`;
    const c = await campaign(page, `<p style="${style}">short</p>`);
    await open(page, c.id);
    await page.locator(`${EDITOR} p`).first().click();
    await page.locator('richtext-editor [data-cmd="align"][data-value="center"]').click();
    const got = storedStyle(await saved(page, c.id));
    expect(got).toMatch(/text-align:\s*center/);
    expect(got).toContain(`url('${remote}/sh.gif')`);
    // Whatever form the margin takes, it comes before the held background, as it did.
    expect(got.lastIndexOf("margin-")).toBeLessThan(got.indexOf("background-image"));
  });

  // Squire turns the font and text declarations of a span into markup, so the span's style is held
  // whole: an unedited save stores the span as it was.
  const spanStyles = [
    "font-weight: bold",
    "font-style: italic",
    "font-family: Arial",
    "font-size: 18px",
    "text-decoration: underline",
  ];

  for (const other of spanStyles) {
    test(`saving a span with a remote background and ${other} unedited keeps it (B10)`, async ({
      page,
    }) => {
      await signIn(page);
      const style = `background: url('${remote}/span.gif') no-repeat left center; ${other}`;
      const c = await campaign(page, `<p>Hi <span style="${style}">Sale</span> now</p>`);
      await open(page, c.id);
      await expect(page.getByTestId("editor-held")).toBeVisible();
      await page.locator(`${EDITOR} p`).first().click();
      await page.keyboard.press("End");
      await page.keyboard.type("x");
      const stored = await saved(page, c.id);
      const got = await page.evaluate(
        ([html]) => {
          const el = new DOMParser().parseFromString(html, "text/html").querySelector("span");
          return el && { style: el.getAttribute("style"), text: el.textContent };
        },
        [stored],
      );
      expect(got).toEqual({ style, text: "Sale" });
      expect(stored).not.toContain("data-rte-");
      expect(requests.filter((path) => /span\.gif/.test(path))).toEqual([]);
    });
  }

  test("bolding a word inside a span with a held background keeps the background (B10)", async ({
    page,
  }) => {
    await signIn(page);
    const style = `background: url('${remote}/span.gif') no-repeat; font-weight: normal`;
    const c = await campaign(page, `<p>Hi <span style="${style}">Sale today</span> now</p>`);
    await open(page, c.id);
    await page.locator(`${EDITOR} span`).first().dblclick();
    await page.locator('richtext-editor [data-cmd="bold"]').click();
    const stored = await saved(page, c.id);
    expect(stored).toContain(`url('${remote}/span.gif')`);
    expect(stored).toMatch(/<b>[^<]*<\/b>/);
    expect(stored).toContain("Sale");
    expect(stored).not.toContain("data-rte-");
    expect(requests.filter((path) => /span\.gif/.test(path))).toEqual([]);
  });

  test.describe("a block whose style is held, moved by the clipboard", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    test("a cut and paste keeps the background and the padding, and the notice (B10)", async ({
      page,
    }) => {
      await signIn(page);
      const body = `<p style="background-image: url('${remote}/moved-bg.gif'); padding: 16px">move me</p>`;
      const c = await campaign(page, body);
      await open(page, c.id);
      await page.locator(`${EDITOR} p`).first().click();
      for (const key of ["Control+a", "Control+x", "Control+v"]) await page.keyboard.press(key);
      await expect(page.getByTestId("editor-held")).toBeVisible();
      const stored = await saved(page, c.id);
      expect(stored).toContain(`url('${remote}/moved-bg.gif')`);
      expect(stored).toContain("padding: 16px");
      expect(stored).not.toContain("data-rte-");
    });

    test("a paste carrying both a style and its held declarations keeps both (B10)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(page);
      await open(page, c.id);
      await page.locator(EDITOR).evaluate((el, html) => {
        el.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", html);
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, `<p>head</p><p style="padding: 16px; text-align: center" data-rte-style="background-image: url('${remote}/both.gif'); padding: 99px">both</p>`);
      await expect(page.locator(EDITOR).getByText("both")).toHaveCount(1);
      await expect(page.getByTestId("editor-held")).toBeVisible();
      const stored = await saved(page, c.id);
      expect(stored).toContain(`url('${remote}/both.gif')`);
      expect(stored).toContain("padding: 16px");
      expect(stored).not.toContain("padding: 99px");
      expect(stored).toMatch(/text-align:\s*center/);
      expect(stored).not.toContain("data-rte-");
    });
  });

  test("an image from a root URL the policy cannot name is held (B10)", async ({ page }) => {
    await signIn(page);
    const c = await campaign(page);
    await open(page, c.id);
    // The page's own policy names no origin with `_` in its host, so the editor must not treat it
    // as loadable either.
    const held = await page.evaluate(() => {
      window._LM_CONFIG.root_url = "http://under_score.example.test";
      const host = document.querySelector("richtext-editor");
      host.value = '<p><img src="http://under_score.example.test/a.png" alt="a"></p>';
      return !!host.querySelector("img[data-rte-src]");
    });
    expect(held).toBe(true);
  });

  test.describe("a real cut and paste", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    test("keeps the addresses of held images and backgrounds", async ({ page }) => {
      await signIn(page);
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
      await signIn(page);
      const c = await campaign(page);
      await open(page, c.id);
      await page.locator(EDITOR).evaluate((el, html) => {
        el.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", html);
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
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
      await signIn(page);
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

  test.describe("the resize handles", () => {
    // One click selects an image for Squire's resizer; a drag on the corner handle resizes it.
    const dragCorner = async (page) => {
      const handle = page.locator(".squire-resize-handle-se");
      if (!(await handle.count())) return false;
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 80, { steps: 8 });
      await page.mouse.up();
      return true;
    };
    const afterDrag = async (page, stored) => {
      await signIn(page);
      const c = await campaign(page, `<p>text ${stored} more</p>`);
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      const dragged = await dragCorner(page);
      await page.locator(EDITOR).click({ position: { x: 5, y: 5 } });
      await page.locator(EDITOR).pressSequentially("x");
      const save = page.waitForResponse((r) => r.request().method() === "PUT");
      await page.keyboard.press("Control+s");
      expect((await save).status()).toBe(200);
      const body = (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
      return { dragged, tag: /<img[^>]*>/.exec(body)[0] };
    };

    for (const [label, stored] of [
      ["with a stored size", `<img src="REMOTE/sized.gif" alt="b" width="600" height="400">`],
      ["with no stored size", `<img src="REMOTE/plain.gif" alt="b">`],
    ])
      test(`are not offered on a held image ${label}, and a drag changes nothing`, async ({
        page,
      }) => {
        const html = stored.replace("REMOTE", remote);
        const { dragged, tag } = await afterDrag(page, html);
        expect(tag).not.toContain("style=");
        for (const name of ["src", "alt", "width", "height"]) {
          const want = new RegExp(`\\s${name}="([^"]*)"`).exec(html)?.[1] ?? null;
          expect(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null).toBe(want);
        }
        expect(dragged).toBe(false);
      });

    test("a click on a held image releases an image selected before", async ({ page }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<p>logo <img src="/admin/static/favicon.png" alt="logo"></p>` +
          `<p>banner <img src="${remote}/banner.gif" alt="banner"></p>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img[alt="logo"]`).click();
      await expect(page.locator(".squire-resize-handle-se")).toHaveCount(1);
      await page.locator(`${EDITOR} img[alt="banner"]`).click();
      await expect(page.locator(".squire-resize-handle-se")).toHaveCount(0);
      await page.keyboard.press("Delete");
      await page.locator(EDITOR).click({ position: { x: 5, y: 5 } });
      await page.locator(EDITOR).pressSequentially("x");
      const save = page.waitForResponse((r) => r.request().method() === "PUT");
      await page.keyboard.press("Control+s");
      expect((await save).status()).toBe(200);
      const body = (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
      expect(body).toContain('alt="logo"');
      expect(body).toContain('alt="banner"');
    });

    // D79: a click on a held image puts the caret just after it, and the arrow keys step over it.
    test("a click on a held image puts the caret after it, and an arrow steps over it (B13)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(page, `<p>one <img src="${remote}/caret.gif" alt="held"> two</p>`);
      await open(page, c.id);
      const typedAfter = async (key) => {
        await page.locator(`${EDITOR} img`).click();
        if (key) await page.keyboard.press(key);
        await page.keyboard.type("X");
        const save = page.waitForResponse((r) => r.request().method() === "PUT");
        await page.keyboard.press("Control+s");
        expect((await save).status()).toBe(200);
        return (await ok(page, `/api/campaigns/${c.id}`, "GET")).body;
      };
      const after = await typedAfter(null);
      expect(after).toMatch(/<img[^>]*alt="held"[^>]*>X/);
      const before = await typedAfter("ArrowLeft");
      expect(before).toMatch(/X<img[^>]*alt="held"[^>]*>X/);
    });

    const saveBody = async (page, id) => {
      const save = page.waitForResponse((r) => r.request().method() === "PUT");
      await page.keyboard.press("Control+s");
      expect((await save).status()).toBe(200);
      return (await ok(page, `/api/campaigns/${id}`, "GET")).body;
    };

    for (const [label, before] of [
      ["alone in it", ""],
      ["last in it", "Get "],
    ])
      test(`a click on a held image ${label} in a link types outside the link (B14)`, async ({
        page,
      }) => {
        await signIn(page);
        const c = await campaign(
          page,
          `<p>lead <a href="https://example.com/x">${before}<img src="${remote}/banner.gif" alt="banner"></a> tail</p>`,
        );
        await open(page, c.id);
        await page.locator(`${EDITOR} img`).click();
        await page.keyboard.type("X");
        const body = await saveBody(page, c.id);
        expect(body).toMatch(/<img[^>]*alt="banner"[^>]*><\/a>X(&nbsp;| )tail/);
      });

    test("Backspace after a click on a held image with text after it in a link removes only the image (B14)", async ({
      page,
    }) => {
      await signIn(page);
      const html = `<p>Get <a href="https://example.com/x"><img src="${remote}/icon.gif" alt="icon"> Download</a> now</p>`;
      const c = await campaign(page, html);
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.press("Backspace");
      const removed = await saveBody(page, c.id);
      expect(removed).not.toContain("<img");
      expect(removed).toMatch(/<a [^>]*>(&nbsp;| )Download<\/a>/);
    });

    test("typing after a click on a held image with text after it joins the link text (B14)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<p>Get <a href="https://example.com/x"><img src="${remote}/icon.gif" alt="icon"> Download</a> now</p>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.type("X");
      expect(await saveBody(page, c.id)).toMatch(
        /<img[^>]*alt="icon"[^>]*>X(&nbsp;| )Download<\/a>/,
      );
    });

    test("Backspace after a click on a held image removes the image (B14)", async ({ page }) => {
      await signIn(page);
      const c = await campaign(page, `<p>one <img src="${remote}/bs.gif" alt="held"> two</p>`);
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.press("Backspace");
      await page.keyboard.type("X");
      const body = await saveBody(page, c.id);
      expect(body).not.toContain("<img");
      expect(body).toMatch(/one X(&nbsp;| )two/);
    });

    test("a click beside a held image is the browser's own (B14)", async ({ page }) => {
      await signIn(page);
      const c = await campaign(page, `<p><img src="${remote}/beside.gif" alt="held"> two</p>`);
      await open(page, c.id);
      // Right next to the image: just past its right edge, before " two".
      const box = await page.locator(`${EDITOR} img`).boundingBox();
      await page.mouse.click(box.x + box.width + 2, box.y + box.height / 2);
      await page.keyboard.type("X");
      const body = await saveBody(page, c.id);
      expect(body).toMatch(/<img[^>]*alt="held"[^>]*>X(&nbsp;| )two/);
    });

    test("one Backspace after a click on a linked banner with whitespace in the link removes image and link (B15)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<p>lead <a href="https://example.com/x">\n  <img src="${remote}/ws.gif" alt="banner">\n</a> tail</p>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.press("Backspace");
      const body = await saveBody(page, c.id);
      expect(body).not.toContain("<img");
      expect(body).not.toContain("<a");
      expect(body).toMatch(/lead (&nbsp;| )?tail/);
    });

    test("a banner alone in its paragraph leaves no trailing br after typing (B15)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<p><a href="https://example.com/x"><img src="${remote}/alone.gif" alt="banner"></a></p>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.type("X");
      const body = await saveBody(page, c.id);
      expect(body).toMatch(/<\/a>X<\/p>/);
    });

    for (const [label, html] of [
      [
        "after bold link text",
        (src) =>
          `<p>first</p><p><a href="https://example.com/x"><b>Read more</b> <img src="${src}" alt="arrow"></a> tail</p>`,
      ],
      [
        "after text before the link",
        (src) =>
          `<p>first</p><p>Click<a href="https://example.com/x"> <img src="${src}" alt="arrow"></a></p>`,
      ],
    ])
      test(`a click on a held image keeps a visible space ${label} (B15)`, async ({ page }) => {
        await signIn(page);
        const c = await campaign(page, html(`${remote}/arrow.gif`));
        await open(page, c.id);
        await page.locator(`${EDITOR} img`).click();
        await page.locator(`${EDITOR} p`).first().click();
        await page.keyboard.press("End");
        await page.keyboard.type("Z");
        const body = await saveBody(page, c.id);
        expect(body).toMatch(/(<\/b>|<a [^>]*>)(&nbsp;| )<img/);
      });

    test("a click on a linked banner keeps the space before text after the link (B16)", async ({
      page,
    }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<p>one</p><p><a href="https://example.com/x"><img src="${remote}/tail.gif" alt="banner"> </a>tail</p>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.locator(`${EDITOR} p`).first().click();
      await page.keyboard.press("End");
      await page.keyboard.type("Z");
      expect(await saveBody(page, c.id)).toMatch(/<img[^>]*alt="banner"[^>]*>(&nbsp;| )<\/a>tail/);
    });

    test("a banner alone in a table cell keeps its br after typing (B16)", async ({ page }) => {
      await signIn(page);
      const c = await campaign(
        page,
        `<table><tbody><tr><td><a href="https://example.com/x"><img src="${remote}/cell.gif" alt="banner"></a></td></tr></tbody></table>`,
      );
      await open(page, c.id);
      await page.locator(`${EDITOR} img`).click();
      await page.keyboard.type("X");
      const body = await saveBody(page, c.id);
      // The trailing `<br>` does not render; a cell keeps it (D79).
      expect(body).toContain("</a>X<br></td>");
    });

    test("Enter at the end of a code block starts a new line (B15)", async ({ page }) => {
      await signIn(page);
      const c = await campaign(page, `<pre>code</pre>`);
      await open(page, c.id);
      await page.locator(`${EDITOR} pre`).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("x");
      expect(await saveBody(page, c.id)).toMatch(/<pre>code\nx<\/pre>/);
    });

    test("still resize an image that loaded", async ({ page }) => {
      const { dragged, tag } = await afterDrag(
        page,
        `<img src="/admin/static/favicon.png" alt="b">`,
      );
      expect(dragged).toBe(true);
      expect(tag).toMatch(/style="width: [1-9]\d*px/);
    });
  });

  test("an edit typed while a save is in flight is still unsaved", async ({ page }) => {
    await signIn(page);
    const c = await campaign(page, `<p><img src="${remote}/during.gif" alt="a"></p>`);
    await page.goto(`/admin/campaigns/${c.id}`);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/campaigns/${c.id}`, async (route) => {
      if (route.request().method() === "PUT") await held;
      await route.continue();
    });
    const subject = page.locator('input[name="subject"]');
    await subject.fill("Saved subject");
    const save = page.waitForResponse((r) => r.request().method() === "PUT");
    await page.keyboard.press("Control+s");
    await expect.poll(() => page.evaluate(() => document.activeElement?.name)).toBe("subject");
    await subject.fill("Typed during the save");
    release();
    expect((await save).status()).toBe(200);
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    await page.getByTestId("editor-held").getByRole("button").click();
    await expect(page.locator("dialog.confirm-dialog")).toBeVisible();
    await page.locator("dialog.confirm-dialog [data-confirm-cancel]").click();
    expect(page.url()).not.toContain("remote_images");
  });

  test("an archive slug typed while a save is in flight is still unsaved (B10)", async ({
    page,
  }) => {
    await signIn(page);
    const c = await campaign(page, `<p><img src="${remote}/slug.gif" alt="a"></p>`);
    await ok(page, `/api/campaigns/${c.id}/archive`, "PUT", {
      archive: true,
      archive_template_id: 0,
      archive_meta: {},
      archive_slug: unique("slug"),
    });
    await page.goto(`/admin/campaigns/${c.id}`);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/campaigns/${c.id}`, async (route) => {
      if (route.request().method() === "PUT") await held;
      await route.continue();
    });
    const slug = page.locator('input[name="archive_slug"]');
    await page.getByRole("tab", { name: "Archive", exact: true }).click();
    await slug.fill("first-slug");
    const save = page.waitForResponse((r) => r.request().method() === "PUT");
    await page.keyboard.press("Control+s");
    await expect.poll(() => page.evaluate(() => document.activeElement?.name)).toBe("archive_slug");
    await slug.fill("typed-during-the-save");
    release();
    expect((await save).status()).toBe(200);
    // The typed slug is still on screen, and the page knows it was not stored.
    await expect(slug).toHaveValue("typed-during-the-save");
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    await page.getByTestId("editor-held").getByRole("button").click();
    await expect(page.locator("dialog.confirm-dialog")).toBeVisible();
    await page.locator("dialog.confirm-dialog [data-confirm-cancel]").click();
  });

  test("a changed subject is asked about before the page reloads", async ({ page }) => {
    await signIn(page);
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
    await signIn(page);
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
