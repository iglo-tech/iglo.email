// What the M4.3 review asked of the form: authored HTML never acts on this origin in any editor
// path, a posted preview fetches nothing whatever its first character is, a save keeps what it did
// not change, and starting a campaign takes only the right to send. listmonk has no such spec at
// 6fcd95f; docs/design/09-decisions.md#d66 lists what the sanitizer keeps.
import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { api, confirm, createUser, login, ORIGIN, PASSWORD, test, unique } from "../helpers.js";

// These prove the sanitizer on its own, and `neverRan` needs a handler that does run: the policy
// would stop both. editor-containment.e2e.js holds the corpus with and without it.
test.use({ bypassCSP: true });

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

// The address gets the request or it does not; the browser's own events can miss a blocked one.
// Only the paths count: anything on this host may probe a new port.
async function receiver() {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The image in the frame has settled, and a request the page makes afterwards arrives.
async function nothingFetched(page, place) {
  const image = page.frameLocator(".preview-modal iframe").locator("img");
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate((el) => el.complete)).toBe(true);
  // From a blank page of the same browser: the admin's own policy refuses this request.
  const blank = await page.context().newPage();
  await blank.evaluate((url) => fetch(`${url}/control`, { mode: "no-cors" }), place.url);
  await blank.close();
  await expect.poll(() => place.hits.includes("/control")).toBe(true);
  expect(place.hits.filter((hit) => hit.startsWith("/pixel"))).toEqual([]);
}

// These are about the frame's own policy, which `bypassCSP` would switch off too.
test.describe("previews", () => {
  test.use({ bypassCSP: false });

  for (const start of [" ", " ", "﻿", "text ", "<!-- a -->", ""]) {
    const label = [...start].map((ch) => ch.codePointAt(0).toString(16)).join(" ") || "nothing";
    test(`a template preview starting with ${label} reaches no receiver`, async ({ page }) => {
      await login(page);
      const place = await receiver();
      try {
        const t = await ok(page, "/api/templates", "POST", {
          name: unique("Preview"),
          type: "tx",
          subject: "Preview",
          body: `${start}<!doctype html><html><body><img src="${place.url}/pixel.gif"></body></html>`,
        });
        await page.goto(`/admin/templates/${t.id}`);
        await page.getByTestId("btn-preview").first().click();
        await nothingFetched(page, place);
      } finally {
        await place.close();
      }
    });
  }

  test("the campaign and archive previews reach no receiver either", async ({ page }) => {
    await login(page);
    const place = await receiver();
    try {
      const t = await ok(page, "/api/templates", "POST", {
        name: unique("Preview"),
        type: "campaign",
        subject: "",
        body: ` <!doctype html><img src="${place.url}/pixel.gif">{{ content | raw }}`,
      });
      const c = await create(page, { content_type: "html", template_id: t.id });
      await page.goto(`${CAMPAIGNS}/${c.id}`);
      await button(page.locator(".page-header"), "Preview").click();
      await nothingFetched(page, place);
      await button(page.locator(".preview-modal"), "Close").click();
      place.hits.length = 0;

      await page.getByRole("tab", { name: "Archive", exact: true }).click();
      await page.getByRole("switch").filter({ visible: true }).check();
      await page.locator(".campaign select").filter({ visible: true }).first().selectOption(t.name);
      await button(page.getByRole("tabpanel").filter({ hasText: "Slug" }), "Preview").click();
      await nothingFetched(page, place);
    } finally {
      await place.close();
    }
  });
});

async function saveName(page, c) {
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await expect(page.locator('input[name="name"]')).toHaveValue(c.name);
  await page.locator('input[name="name"]').fill(`${c.name} renamed`);
  const save = page.waitForResponse((r) => r.request().method() === "PUT");
  await button(page.locator(".page-header"), "Save changes").click();
  expect((await save).status()).toBe(200);
  return stored(page, c.id);
}

test("an unrelated save keeps hidden archive metadata", async ({ page }) => {
  await login(page);
  const archive_meta = { name: "Keep me", attribs: { city: "Warsaw" } };
  const c = await create(page, { archive: false, archive_meta });
  expect((await stored(page, c.id)).archive_meta).toEqual(archive_meta);
  const saved = await saveName(page, c);
  expect(saved.name).toBe(`${c.name} renamed`);
  expect(saved.archive).toBe(false);
  expect(saved.archive_meta).toEqual(archive_meta);
});

test("an unrelated save keeps the instant of a schedule, and the control still changes it", async ({
  page,
}) => {
  await login(page);
  const at = new Date(Date.now() + 7 * 86_400_000);
  at.setUTCSeconds(9, 152);
  const c = await create(page, { send_at: at.toISOString() });
  expect(Date.parse((await stored(page, c.id)).send_at)).toBe(at.getTime());
  const saved = await saveName(page, c);
  expect(saved.name).toBe(`${c.name} renamed`);
  expect(Date.parse(saved.send_at)).toBe(at.getTime());

  // A changed control sends what it shows, and so does turning it off.
  await page.locator('input[name="send_at"]').fill("2036-05-04T03:02");
  const save = page.waitForResponse((r) => r.request().method() === "PUT");
  await button(page.locator(".page-header"), "Save changes").click();
  expect((await save).status()).toBe(200);
  const local = await page.evaluate(() => new Date("2036-05-04T03:02").getTime());
  expect(Date.parse((await stored(page, c.id)).send_at)).toBe(local);
});

test("a role that can send and not manage starts a saved campaign from the form", async ({
  page,
  browser,
}) => {
  await login(page);
  const c = await create(page);
  const sender = await createUser(page, [
    "campaigns:get_all",
    "campaigns:send",
    "lists:get_all",
    "lists:manage_all",
  ]);
  const context = await browser.newContext({ baseURL: ORIGIN });
  const other = await context.newPage();
  try {
    await other.setExtraHTTPHeaders({ "X-Forwarded-For": "203.0.113.201" });
    await login(other, sender.username, PASSWORD);
    const writes = [];
    other.on("request", (r) => {
      if (r.method() !== "GET") writes.push(new URL(r.url()).pathname);
    });
    await other.goto(`${CAMPAIGNS}/${c.id}`);
    await expect(other.locator('input[name="name"]')).toHaveValue(c.name);
    const name = await other.locator('input[name="name"]').isDisabled();
    await button(other, "Start campaign").click();
    await confirm(other);
    await expect(other).toHaveURL(/\/admin\/campaigns$/);
    expect(writes).toEqual([`/api/campaigns/${c.id}/status`]);
    expect((await stored(page, c.id)).status).not.toBe("draft");
    expect(name).toBe(true);
  } finally {
    await context.close();
  }
});

test("a role that can manage still saves its edits before starting", async ({ page }) => {
  await login(page);
  const c = await create(page);
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await page.locator('input[name="name"]').fill(`${c.name} edited`);
  await button(page, "Start campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  const saved = await stored(page, c.id);
  expect(saved.name).toBe(`${c.name} edited`);
  expect(saved.status).not.toBe("draft");
});
