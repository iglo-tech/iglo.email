// Multi-line text entered into a code editor or the rich-text body is what the screen stores. The
// editors' `x-on:input` bindings read `$el.value`, the host element's own value. Before that, they
// read `$event.target.value`: a native `input` from CodeMirror's or Squire's contenteditable bubbled
// through `<code-editor>` / `<richtext-editor>` with a target that has no `value`, so a typed (`fill`)
// edit left the bound field undefined and save threw. Input from inside an editor's host (its text, or
// CodeMirror's search field) must not overwrite what is stored; the last case pins that. listmonk has
// no such spec at 6fcd95f. Each case enters the text by typing it in one go (`fill`) and by pasting it
// (Ctrl+V, a real paste).
import { expect } from "@playwright/test";
import { api, ORIGIN, signIn, test, unique } from "../helpers.js";

const SEQUENCES = "/admin/sequences";
const TEMPLATES = "/admin/templates";
const CAMPAIGNS = "/admin/campaigns";

const MULTI_JSON = [
  "{",
  '  "items": { "event": "download_finished", "since": "P30D", "fn": "sum", "field": "data.items" },',
  '  "actions": { "event": "assistant_action", "since": "P30D" }',
  "}",
].join("\n");
const CONDITION_JSON = [
  "{",
  '  "attr": "status",',
  '  "op": "eq",',
  '  "value": "enabled"',
  "}",
].join("\n");
const WHERE_JSON = ["{", '  "data.kind": "y"', "}"].join("\n");
const TEMPLATE_HTML = [
  "<section>",
  "  <h1>Hello</h1>",
  "  <p>{{ subscriber.name }}</p>",
  "</section>",
  "<footer>Second line</footer>",
].join("\n");
const CAMPAIGN_HTML = "<div>\n  <p>First paragraph</p>\n  <p>Second paragraph</p>\n</div>";
const RICH_TEXT = "First rich line\nSecond rich line";

async function ok(page, path, method = "GET", body = undefined) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

// Types `text` into the editor the way the user does it. `fill` replaces the content in one input;
// `paste` selects the content and pastes the clipboard, which CodeMirror and Squire read themselves.
async function enter(page, editor, text, how) {
  await editor.click();
  if (how === "fill") {
    await editor.fill(text);
    return;
  }
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
}

// Clicks save and resolves with the PUT the page sent, or null when it sent none (a save that threw
// before the request, the failure this spec is about). Errors are checked by the caller first.
// Sequence and template saves reload the screen once the PUT succeeds (`reloads`). The reload is armed
// before the click and awaited here, so the stored value is never read while the page is navigating.
// Campaign saves only show a toast and do not reload.
async function save(page, button, path, { reloads = false } = {}) {
  const sent = page
    .waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(path), {
      timeout: 10_000,
    })
    .catch(() => null);
  const loaded = reloads ? page.waitForEvent("load", { timeout: 10_000 }).catch(() => null) : null;
  await button.click();
  const put = await sent;
  if (loaded && put?.ok()) await loaded;
  return put;
}

function collectPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function sequence(page, steps) {
  return ok(page, "/api/sequences", "POST", {
    name: unique("editor-input"),
    status: "draft",
    trigger: { event: unique("evt") },
    reentry: "always",
    steps,
  });
}

async function template(page) {
  return ok(page, "/api/templates", "POST", {
    name: unique("editor-tx"),
    type: "tx",
    subject: "Editor input",
    body: "<p>{{ subscriber.name }}</p>",
  });
}

async function campaign(page, contentType, body) {
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("EditorInput"),
    type: "private",
    optin: "single",
  });
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: contentType,
    body,
    lists: [list.id],
  });
}

test.describe("text typed or pasted into an editor is stored as entered", () => {
  for (const how of ["fill", "paste"]) {
    test(`a sequence step's aggregates (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const tx = await template(page);
      const seq = await sequence(page, [
        { wait: "P1D", kind: "transactional", template_id: tx.id },
      ]);
      await page.goto(`${SEQUENCES}/${seq.id}`);
      const editor = page.getByTestId("step-aggregates").locator(".cm-content");
      await expect(editor).toBeVisible();
      await enter(page, editor, MULTI_JSON, how);
      const put = await save(page, page.getByTestId("btn-save"), "/api/sequences/", {
        reloads: true,
      });
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      const stored = await ok(page, `/api/sequences/${seq.id}`);
      expect(stored.steps[0].aggregates).toMatchObject(JSON.parse(MULTI_JSON));
    });

    test(`a step's condition (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const tx = await template(page);
      const seq = await sequence(page, [
        { wait: "P1D", kind: "transactional", template_id: tx.id },
      ]);
      await page.goto(`${SEQUENCES}/${seq.id}`);
      const editor = page.locator(".step-card .cm-content").first();
      await expect(editor).toBeVisible();
      await enter(page, editor, CONDITION_JSON, how);
      const put = await save(page, page.getByTestId("btn-save"), "/api/sequences/", {
        reloads: true,
      });
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      const stored = await ok(page, `/api/sequences/${seq.id}`);
      expect(stored.steps[0].condition).toEqual({ attr: "status", op: "eq", value: "enabled" });
    });

    test(`a trigger's where (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const tx = await template(page);
      const seq = await sequence(page, [
        { wait: "P1D", kind: "transactional", template_id: tx.id },
      ]);
      await page.goto(`${SEQUENCES}/${seq.id}`);
      const editor = page.getByTestId("trigger-where").locator(".cm-content");
      await expect(editor).toBeVisible();
      await enter(page, editor, WHERE_JSON, how);
      const put = await save(page, page.getByTestId("btn-save"), "/api/sequences/", {
        reloads: true,
      });
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      const stored = await ok(page, `/api/sequences/${seq.id}`);
      expect(stored.trigger.where).toEqual({ "data.kind": "y" });
    });

    test(`a transactional template's body (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const tx = await template(page);
      await page.goto(`${TEMPLATES}/${tx.id}`);
      const editor = page.locator("code-editor .cm-content");
      await expect(editor).toBeVisible();
      await enter(page, editor, TEMPLATE_HTML, how);
      const put = await save(page, page.getByTestId("btn-save"), "/api/templates/", {
        reloads: true,
      });
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      expect((await put?.request().postDataJSON())?.body, "body sent").toBe(TEMPLATE_HTML);
      const stored = await ok(page, `/api/templates/${tx.id}`);
      expect(stored.body).toBe(TEMPLATE_HTML);
    });

    test(`a campaign's HTML body (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const c = await campaign(page, "html", "<p>Body</p>");
      await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
      const editor = page.locator(".editor-body .cm-content");
      await expect(editor).toBeVisible();
      await enter(page, editor, CAMPAIGN_HTML, how);
      const put = await save(
        page,
        page.getByRole("button", { name: "Save changes", exact: true }).first(),
        "/api/campaigns/",
      );
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      expect((await put?.request().postDataJSON())?.body, "body sent").toBe(CAMPAIGN_HTML);
      const stored = await ok(page, `/api/campaigns/${c.id}`);
      expect(stored.body).toBe(CAMPAIGN_HTML);
    });

    test(`a campaign's rich-text body (${how})`, async ({ page }) => {
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const errors = collectPageErrors(page);
      await signIn(page);
      const c = await campaign(page, "richtext", "<p>Body</p>");
      await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
      const editor = page.locator('richtext-editor [contenteditable="true"]');
      await expect(editor).toBeVisible();
      await enter(page, editor, RICH_TEXT, how);
      const put = await save(
        page,
        page.getByRole("button", { name: "Save changes", exact: true }).first(),
        "/api/campaigns/",
      );
      expect(errors, "page errors").toEqual([]);
      expect(put?.status(), "save request").toBe(200);
      const stored = await ok(page, `/api/campaigns/${c.id}`);
      expect(stored.body).toContain("First rich line");
      expect(stored.body).toContain("Second rich line");
    });
  }

  // CodeMirror's search panel is rendered inside `<code-editor>`, so its `input` events bubble through
  // the same binding. Text typed there is search text, not body: the stored body stays as entered.
  test("typing into a code editor's search box does not change the stored body", async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await signIn(page);
    const c = await campaign(page, "html", "<p>Body</p>");
    await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
    const editor = page.locator(".editor-body .cm-content");
    await expect(editor).toBeVisible();
    await enter(page, editor, CAMPAIGN_HTML, "fill");
    await page.keyboard.press("ControlOrMeta+f");
    const search = page.locator(".cm-search input[name=search]");
    await expect(search).toBeVisible();
    await search.pressSequentially("needle-not-body");
    await expect(search).toHaveValue("needle-not-body");
    const put = await save(
      page,
      page.getByRole("button", { name: "Save changes", exact: true }).first(),
      "/api/campaigns/",
    );
    expect(errors, "page errors").toEqual([]);
    expect(put?.status(), "save request").toBe(200);
    expect((await put?.request().postDataJSON())?.body, "body sent").toBe(CAMPAIGN_HTML);
    const stored = await ok(page, `/api/campaigns/${c.id}`);
    expect(stored.body).toBe(CAMPAIGN_HTML);
  });
});
