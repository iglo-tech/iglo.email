// What the M4.3 review asked of the form: authored HTML never acts on this origin in any editor
// path, a posted preview fetches nothing whatever its first character is, a save keeps what it did
// not change, and starting a campaign takes only the right to send. listmonk has no such spec at
// 6fcd95f; docs/design/09-decisions.md#d66 lists what the sanitizer keeps.
import { expect } from "@playwright/test";
import { api, confirm, login, ORIGIN, test, unique } from "../helpers.js";

const CAMPAIGNS = "/admin/campaigns";
const EDITOR = 'richtext-editor [contenteditable="true"]';
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const notice = (page) => page.getByTestId("editor-removed");

async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

const stored = (page, id) => ok(page, `/api/campaigns/${id}`, "GET");

async function create(page, overrides = {}) {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Editor"),
    type: "private",
    optin: "single",
  });
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "richtext",
    body: "<p>Body</p>",
    lists: [list.id],
    ...overrides,
  });
}

async function open(page, c) {
  await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
  await expect(page.locator(".editor-body")).not.toHaveClass(/is-loading/);
}

// Handlers that would write the page's own origin to a marker, and an Alpine directive, which runs
// on any element added inside the component.
const hostile = (marker) =>
  `<p>visible ${marker}</p>` +
  `<img src="/missing-${marker}.png" onerror="window.${marker} = location.origin">` +
  `<div x-init="window.${marker}x = location.origin">directive ${marker}</div>`;

// The handler form runs on this page when something hands it to the document, and it has had the
// time to: a failed image reports before a later one does.
async function neverRan(page, marker) {
  const control = unique("control").replace("-", "");
  await page.evaluate((name) => {
    const div = document.createElement("div");
    div.innerHTML = `<img src="/missing-${name}.png" onerror="window.${name} = location.origin">`;
  }, control);
  await expect.poll(() => page.evaluate((name) => window[name], control)).toBe(ORIGIN);
  expect(await page.evaluate((name) => window[name], marker)).toBeUndefined();
  expect(await page.evaluate((name) => window[`${name}x`], marker)).toBeUndefined();
}

const marker = () => unique("mark").replace("-", "");

test("a stored handler does not run when the rich-text editor loads it", async ({ page }) => {
  await login(page);
  const mark = marker();
  const body = hostile(mark);
  const c = await create(page, { body });
  await open(page, c);
  await expect(page.locator(EDITOR)).toContainText(`visible ${mark}`);
  await neverRan(page, mark);
  await expect(page.locator(`${EDITOR} img`)).toHaveCount(1);
  expect(await page.locator(`${EDITOR} img`).getAttribute("onerror")).toBeNull();
  expect(await page.locator(`${EDITOR} [x-init]`).count()).toBe(0);

  // The author is told, a save without an edit stores what it read, and an edit stores the editor's.
  await expect(notice(page)).toContainText("onerror");
  await expect(notice(page)).toContainText("x-init");
  await page.locator('input[name="name"]').evaluate((el) => {
    el.value = `${el.value} renamed`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = page.waitForResponse((r) => r.request().method() === "PUT");
  await page.keyboard.press("Control+s");
  expect((await save).status()).toBe(200);
  expect((await stored(page, c.id)).body).toBe(body);

  await page.locator(EDITOR).pressSequentially("x");
  const again = page.waitForResponse((r) => r.request().method() === "PUT");
  await page.keyboard.press("Control+s");
  expect((await again).status()).toBe(200);
  const edited = (await stored(page, c.id)).body;
  expect(edited).toContain(`visible ${mark}`);
  expect(edited).not.toContain("onerror");
  expect(edited).not.toContain("x-init");
});

test("a pasted handler does not run", async ({ page }) => {
  await login(page);
  const c = await create(page);
  await open(page, c);
  const mark = marker();
  await page.locator(EDITOR).evaluate((el, html) => {
    el.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", html);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, hostile(mark));
  await expect(page.locator(EDITOR)).toContainText(`visible ${mark}`);
  await neverRan(page, mark);
  expect(await page.locator(`${EDITOR} img`).getAttribute("onerror")).toBeNull();
  await expect(notice(page)).toContainText("onerror");
});

test("a dropped handler does not run", async ({ page }) => {
  await login(page);
  const c = await create(page);
  await open(page, c);
  const mark = marker();
  await page.locator(EDITOR).evaluate((el, html) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", html);
    const box = el.querySelector("p").getBoundingClientRect();
    el.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        bubbles: true,
        cancelable: true,
        clientX: box.left + 2,
        clientY: box.top + 2,
      }),
    );
  }, hostile(mark));
  await expect(page.locator(EDITOR)).toContainText(`visible ${mark}`);
  await neverRan(page, mark);
  expect(await page.locator(`${EDITOR} img`).getAttribute("onerror")).toBeNull();
});

for (const to of ["richtext", "markdown", "plain"]) {
  test(`a handler does not run on switching html to ${to}`, async ({ page }) => {
    await login(page);
    const mark = marker();
    const c = await create(page, { content_type: "html", body: hostile(mark) });
    await open(page, c);
    await page.locator('button[popovertarget="content-settings"]').click();
    await page.locator('#content-settings select[name="content_type"]').selectOption(to);
    await confirm(page);
    if (to === "plain") {
      await expect(page.locator('textarea[name="content"]')).toHaveValue(/visible/);
    } else {
      await expect(page.locator(".editor-body")).toContainText(`visible ${mark}`);
    }
    await neverRan(page, mark);
  });
}

test("a handler does not run on leaving the rich-text format or adding alt text", async ({
  page,
}) => {
  await login(page);
  const mark = marker();
  const c = await create(page, { body: hostile(mark) });
  await open(page, c);
  const alt = page.getByRole("switch").filter({ visible: true }).first();
  await alt.check();
  await expect(page.locator("textarea").filter({ visible: true }).first()).toHaveValue(
    new RegExp(`visible ${mark}`),
  );
  await neverRan(page, mark);
  await page.locator('button[popovertarget="content-settings"]').click();
  await page.locator('#content-settings select[name="content_type"]').selectOption("html");
  await confirm(page);
  await expect(page.locator(".editor-body .cm-content")).toContainText(`visible ${mark}`);
  await neverRan(page, mark);
});

for (const [cmd, title] of [
  ["insert-html", "insert HTML"],
  ["source", "source"],
]) {
  test(`a handler does not run from the ${title} dialog`, async ({ page }) => {
    await login(page);
    const c = await create(page);
    await open(page, c);
    const mark = marker();
    await page.locator("richtext-editor").evaluate((el, name) => {
      el.querySelector(`[data-cmd="${name}"]`).click();
    }, cmd);
    const dialog = page.locator("richtext-editor dialog[open]");
    await dialog.locator(".cm-content").fill(hostile(mark));
    await dialog.locator('[data-rte-act="submit"]').click();
    await expect(page.locator(EDITOR)).toContainText(`visible ${mark}`);
    await neverRan(page, mark);
    expect(await page.locator(`${EDITOR} img`).getAttribute("onerror")).toBeNull();
  });
}

test("links and images cannot carry a script or a data document", async ({ page }) => {
  await login(page);
  const body =
    '<p><a href="java&#9;script:window.pwned=1" id="tab">tab</a>' +
    '<a href="JaVaScRiPt:window.pwned=1" id="case">case</a>' +
    '<a href="data:text/html,x" id="doc">doc</a>' +
    '<a href="data:image/png;base64,iVBOR" id="linked">linked</a>' +
    '<img src="data:text/html,x" id="frame" alt="a">' +
    '<img src="data:image/svg+xml,x" id="vector" alt="b">' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" id="pixel" alt="c"></p>';
  const c = await create(page, { body });
  await open(page, c);
  const attr = (id, name) => page.locator(`${EDITOR} #${id}`).getAttribute(name);
  await expect(page.locator(`${EDITOR} #pixel`)).toHaveCount(1);
  for (const id of ["tab", "case", "doc", "linked"]) expect(await attr(id, "href")).toBeNull();
  for (const id of ["frame", "vector"]) expect(await attr(id, "src")).toBeNull();
  expect(await attr("pixel", "src")).toMatch(/^data:image\/gif/);

  // The link dialog refuses what the sanitizer would strip.
  await page.locator(EDITOR).pressSequentially("word");
  await page.keyboard.press("Control+k");
  const dialog = page.locator("richtext-editor dialog[open]");
  await dialog.locator('[name="url"]').fill("javascript:window.pwned=1");
  await dialog.locator('[name="text"]').fill("bad");
  await dialog.locator('[data-rte-act="submit"]').click();
  expect(await page.locator(`${EDITOR} a[href^="javascript"]`).count()).toBe(0);
});

test("an ordinary newsletter comes through the rich-text editor unchanged", async ({ page }) => {
  await login(page);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
  const body = `<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse:collapse;font-family:Arial,sans-serif"><thead><tr><th colspan="2" align="left" style="padding:8px;background:#003366;color:#ffffff">April news</th></tr></thead><tbody><tr><td width="200" valign="top" style="padding:8px"><a href="https://example.test/shop?a=1&amp;b=2" target="_blank" rel="noopener" title="Shop"><img src="https://example.test/logo.png" alt="Logo" width="120" height="40" style="display:block;border:0"></a></td><td valign="top" style="padding:8px;font-size:14px;line-height:20px"><h2 id="news" style="margin:0 0 8px;color:#003366">Hello {{ subscriber.name }}</h2><p style="margin:0 0 8px">Read <a href="https://example.test/post@TrackLink" style="color:#0066cc">the post</a>, mail <a href="mailto:team@example.test">the team</a> or call <a href="tel:+48123456789">us</a>.</p><ul style="padding-left:16px"><li>One</li><li><b>Two</b></li></ul><img src="${png}" alt="Dot" width="1" height="1"></td></tr></tbody><tfoot><tr><td colspan="2" align="center" style="font-size:11px"><a href="{{ unsubscribe_url }}">Unsubscribe</a> <a href="#news">Top</a> <a href="/archive/latest">Archive</a></td></tr></tfoot></table>`;
  const c = await create(page, { body });
  await open(page, c);
  const same = () =>
    page.locator("richtext-editor").evaluate((el, original) => {
      // Squire ends a block holding only an image with a <br> for the caret.
      const shape = (html) =>
        [
          ...new DOMParser().parseFromString(html, "text/html").body.querySelectorAll(":not(br)"),
        ].map((n) =>
          [
            n.localName,
            ...[...n.attributes].map((a) => `${a.name}=${a.value}`).sort(),
            n.childElementCount ? "" : n.textContent,
          ].join("|"),
        );
      return { want: shape(original), got: shape(el.value) };
    }, body);
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
  const { want, got } = await same();
  expect(got).toEqual(want);
  await expect(notice(page)).toBeHidden();

  // It stays so through an edit and a save.
  await page.locator(`${EDITOR} ul li`).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("s");
  const save = page.waitForResponse((r) => r.request().method() === "PUT");
  await page.keyboard.press("Control+s");
  expect((await save).status()).toBe(200);
  const saved = (await stored(page, c.id)).body;
  expect(saved).toContain("<li>Ones</li>");
  expect(saved.replace("<li>Ones</li>", "<li>One</li>")).toContain('href="{{ unsubscribe_url }}"');
  await expect(notice(page)).toBeHidden();
});
