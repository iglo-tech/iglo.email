// Adapted from listmonk tests/specs/templates.spec.js at 6fcd95f. The run shares one database, so
// each test clones the seeded templates under unique names instead of counting and deleting them;
// the seeded visual sample does not exist (D54) and bodies are Liquid (D9).
import { expect } from "@playwright/test";
import { api, confirm, login, openMenu, test, unique } from "../helpers.js";

const TEMPLATES = "/admin/templates";
const DEFAULT = "Default campaign template";
const TX = "Sample transactional template";

// Find a template row by name.
function tplRow(page, name) {
  const rows = page.getByTestId("template-row");
  return name ? rows.filter({ hasText: name }) : rows;
}

// Map of template name -> id from the API.
async function templateIDs(page) {
  const { body } = await api(page, "/api/templates");
  return Object.fromEntries(body.data.map((t) => [t.name, t.id]));
}

async function clone(page, source, name) {
  await page.goto(TEMPLATES);
  const row = tplRow(page, source);
  // The clone name is entered via a native prompt().
  page.once("dialog", (d) => d.accept(name));
  await openMenu(row.first());
  await row.first().getByTestId("btn-clone").click();
  await expect(tplRow(page, name)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("shows the seeded default templates", async ({ page }) => {
  await page.goto(TEMPLATES);
  for (const name of [DEFAULT, "Default archive template", TX]) {
    await expect(tplRow(page, name).first()).toBeVisible();
  }
});

test("clones campaign and transactional templates", async ({ page }) => {
  const campaign = unique("cloned campaign");
  await clone(page, DEFAULT, campaign);
  const tx = unique("cloned tx");
  await clone(page, TX, tx);
  await expect(tplRow(page, tx)).toContainText("Transactional");
  await expect(tplRow(page, campaign)).toContainText("HTML");
});

test("creates, edits and previews a template", async ({ page }) => {
  await page.goto(TEMPLATES);
  await page.getByTestId("btn-new").click();
  const name = unique("new template");
  await page.locator("input[name=name]").fill(name);
  await page.locator("code-editor").evaluate((el, v) => {
    el.value = v;
  }, '<span>made</span><div class="wrap">{{ content | raw }}</div>');
  await page.getByTestId("btn-save").click();
  await expect(tplRow(page, name)).toBeVisible();

  const ids = await templateIDs(page);
  await page.goto(`${TEMPLATES}/${ids[name]}`);
  await expect(page.locator("input[name=name]")).toHaveValue(name);
  await expect(page.locator(".cm-content")).toContainText("made");

  const edited = unique("edited");
  await page.locator("input[name=name]").fill(edited);
  const body = '<span>test</span><div class="wrap">{{ content | raw }}</div>';
  await page.locator("code-editor").evaluate((el, v) => {
    el.value = v;
  }, body);

  // The unsaved body previews in the frame.
  await page.getByTestId("btn-preview").first().click();
  await expect(page.locator(".preview-modal iframe")).toHaveAttribute("sandbox", "");
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText("test");
  await page.locator(".preview-modal").getByRole("button", { name: "Close" }).click();

  // Saving PUTs then reloads the same page; wait for the reload before navigating.
  await Promise.all([page.waitForEvent("load"), page.getByTestId("btn-save").click()]);
  await page.goto(TEMPLATES);
  await expect(tplRow(page, edited)).toBeVisible();
  const saved = await api(page, `/api/templates/${ids[name]}`);
  expect(saved.body.data.body).toBe(body);

  // The saved one previews from the listing.
  const row = tplRow(page, edited);
  await openMenu(row);
  await row.getByTestId("btn-preview").click();
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(
    "Hi there",
  );
  await page.locator(".preview-modal").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".preview-modal iframe")).not.toHaveAttribute("src");
});

test("previews templates with the cloned bodies", async ({ page }) => {
  const campaign = unique("preview campaign");
  await clone(page, DEFAULT, campaign);
  const tx = unique("preview tx");
  await clone(page, TX, tx);
  const ids = await templateIDs(page);
  const html = (id) =>
    page.evaluate(async (uri) => (await fetch(uri)).text(), `/api/templates/${id}/preview`);

  // The clone kept the full campaign template (wrapper + unsubscribe footer).
  const cloned = await html(ids[campaign]);
  expect(cloned).toContain("Hi there");
  expect(cloned).toContain("Unsubscribe");
  // The cloned transactional template renders its sample content.
  expect(await html(ids[tx])).toContain("Order number");
});

test("sets a new default template, which can't be deleted", async ({ page }) => {
  const name = unique("default");
  await clone(page, DEFAULT, name);
  const { body } = await api(page, "/api/templates");
  const previous = body.data.find((t) => t.is_default);

  const row = tplRow(page, name);
  await openMenu(row);
  await row.getByTestId("btn-set-default").click();
  await confirm(page);
  await expect(tplRow(page, name)).toContainText("Default");
  await expect(tplRow(page, name).getByTestId("btn-delete")).toHaveCount(0);
  await expect(tplRow(page, previous.name).getByTestId("btn-delete")).toHaveCount(1);

  // Leave the seeded default as the default for the other specs.
  expect((await api(page, `/api/templates/${previous.id}/default`, "PUT")).status).toBe(200);
});

test("deletes templates, and searching and filtering narrow the list", async ({ page }) => {
  const name = unique("to delete");
  await clone(page, TX, name);
  await page.goto(TEMPLATES);
  await page.getByTestId("query").fill(name);
  await page.getByTestId("btn-query").click();
  await expect(tplRow(page)).toHaveCount(1);

  await page.goto(`${TEMPLATES}?type=campaign`);
  await expect(tplRow(page, DEFAULT).first()).toBeVisible();
  await expect(tplRow(page, TX)).toHaveCount(0);

  await page.goto(TEMPLATES);
  const row = tplRow(page, name);
  await openMenu(row);
  await row.getByTestId("btn-delete").click();
  await confirm(page);
  await expect(row).toHaveCount(0);
});
