// listmonk has no media spec at 6fcd95f; this reads the gallery and its picker in the browser.
import { lstat, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { api, confirm, createUser, login, logout, openMenu, test, unique } from "../helpers.js";

const MEDIA = "/admin/campaigns/media";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>parent.pwned=1</script></svg>`;

function item(scope, filename) {
  return scope
    .getByTestId("media-item")
    .filter({ has: scope.getByTitle(filename, { exact: true }) });
}

// Upload through the gallery's own form, which reloads the page; returns the stored row, found by
// the last word of the name.
async function upload(page, name, buffer = PNG, mimeType = "image/png") {
  await page.getByTestId("btn-upload-menu").click();
  await page.locator("#media-upload input[type=file]").setInputFiles({ name, mimeType, buffer });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/media") && r.request().method() === "POST"),
    page.getByTestId("btn-upload").click(),
  ]);
  expect(response.status()).toBe(200);
  await page.getByTestId("media-item").first().waitFor();
  const word = name
    .split(" ")
    .pop()
    .replace(/\.\w+$/, "");
  const found = await api(page, `/api/media?query=${encodeURIComponent(word)}`);
  expect(found.body.data.results).toHaveLength(1);
  return found.body.data.results[0];
}

const search = (name) => `${MEDIA}?query=${encodeURIComponent(name)}`;

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("uploads, searches, copies a URL and deletes", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = `${unique("example")}.png`;
  await page.goto(MEDIA);
  const row = await upload(page, name);
  await page.goto(MEDIA);
  await page.getByTestId("query").fill(row.filename);
  await page.getByTestId("btn-query").click();
  await expect(page.getByTestId("media-item")).toHaveCount(1);
  await expect(page.locator(".page-title")).toContainText("(1)");
  const found = item(page, row.filename);

  await found.hover();
  await openMenu(found);
  await found.getByTestId("btn-copy-url").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(row.url);

  await found.hover();
  await openMenu(found);
  await found.getByTestId("btn-delete").click();
  await confirm(page);
  await expect(page.getByTestId("media-item")).toHaveCount(0);
  expect((await api(page, `/api/media/${row.id}`)).status).toBe(404);
});

test("the gallery sizes an original image and keeps an SVG out of the page", async ({ page }) => {
  await page.goto(MEDIA);
  const large = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
    canvas.getContext("2d").fillRect(0, 0, 3000, 2000);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const big = await upload(page, `${unique("large")}.png`, Buffer.from(large, "base64"));
  await page.goto(search(big.filename));
  const image = item(page, big.filename).locator("img");
  await expect(image).toBeVisible();
  expect(await image.evaluate((el) => el.naturalWidth)).toBe(3000);
  const box = await image.boundingBox();
  expect(box.width).toBeLessThan(400);
  expect(box.height).toBeLessThan(400);

  await page.goto(MEDIA);
  const svg = await upload(page, `${unique("vector")}.svg`, Buffer.from(SVG), "image/svg+xml");
  expect(svg.thumb_url).toBeTruthy();
  await page.goto(search(svg.filename));
  const vector = item(page, svg.filename);
  await expect(vector.locator(".ext")).toHaveText("SVG");
  await expect(vector.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test("hostile file names render as text and stay inside a copied URL", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const marker = unique("hostile");
  const name = `"><img src=x onerror="window.pwned=1"> ' x-on:click="pwned=2" ${marker}.png`;
  await page.goto(MEDIA);
  const row = await upload(page, name);
  await page.goto(search(marker));
  const found = page.getByTestId("media-item");
  await expect(found).toHaveCount(1);
  await expect(found.locator(".filename")).toContainText("onerror");
  await expect(page.locator(".gallery img")).toHaveAttribute("alt", row.filename);
  await expect(page.locator(".gallery img")).toHaveCount(1);

  await found.hover();
  await openMenu(found);
  await found.getByTestId("btn-copy-url").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(marker);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).not.toMatch(/["'<> `]/);
  expect((await page.request.get(copied)).status()).toBe(200);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a refused upload root shows the API's reason and keeps the page", async ({ page }) => {
  const uploads = join(process.env.E2E_DATA_DIR, "uploads");
  const moved = `${uploads}.e2e`;
  const outside = await mkdtemp(join(tmpdir(), "iglo-e2e-outside-"));
  await page.goto(MEDIA);
  await rename(uploads, moved);
  await symlink(outside, uploads);
  try {
    await page.getByTestId("btn-upload-menu").click();
    await page.locator("#media-upload input[type=file]").setInputFiles({
      name: `${unique("refused")}.png`,
      mimeType: "image/png",
      buffer: PNG,
    });
    await page.getByTestId("btn-upload").click();
    await expect(page.getByTestId("error")).toContainText("data directory");
    await expect(page.locator("#media-upload")).toBeHidden();
  } finally {
    await rm(uploads);
    await rename(moved, uploads);
    await rm(outside, { recursive: true });
  }
  expect((await lstat(uploads)).isDirectory()).toBe(true);
});

test("the permissions decide the actions, and the routes need media:get", async ({ page }) => {
  await page.goto(MEDIA);
  const row = await upload(page, `${unique("viewer")}.png`);
  const viewer = await createUser(page, ["media:get"]);
  const none = await createUser(page, ["lists:get_all"]);
  await logout(page);

  await login(page, viewer.username, "e2e-user-password");
  await page.goto(search(row.filename));
  const found = item(page, row.filename);
  await expect(found).toBeVisible();
  await expect(page.getByTestId("btn-upload-menu")).toHaveCount(0);
  await expect(found.getByTestId("btn-delete")).toHaveCount(0);
  await expect(found.getByTestId("btn-copy-url")).toHaveCount(1);
  await logout(page);

  await login(page, none.username, "e2e-user-password");
  expect((await page.goto(MEDIA)).status()).toBe(403);
  expect((await page.goto(`${MEDIA}/fragment`)).status()).toBe(403);
});

test("the picker frames the gallery and uploads inside it", async ({ page }) => {
  const list = await api(page, "/api/lists", "POST", { name: unique("picker"), type: "private" });
  const campaign = await api(page, "/api/campaigns", "POST", {
    name: unique("Picker"),
    subject: "Picker",
    type: "regular",
    content_type: "html",
    body: "Test",
    lists: [list.body.data.id],
  });
  const name = `${unique("picked")}.svg`;
  await page.goto(`/admin/campaigns/${campaign.body.data.id}`);
  await page.locator("#attachments").click();
  await page.getByRole("button", { name: "Add attachments" }).click();
  const frame = page.frameLocator(".media-picker-modal iframe");

  // The fragment has no sidebar of its own.
  await expect(frame.locator(".media-files")).toBeVisible();
  await expect(frame.locator("[data-sidebar]")).toHaveCount(0);
  await frame.getByTestId("btn-upload-menu").click();
  await frame.locator("#media-upload input[type=file]").setInputFiles({
    name,
    mimeType: "image/svg+xml",
    buffer: Buffer.from(SVG),
  });
  await frame.getByTestId("btn-upload").click();
  await frame.getByTestId("query").fill(name);
  await frame.getByTestId("btn-query").click();
  await expect(frame.getByTestId("media-item")).toHaveCount(1);
  await expect(frame.locator(".gallery img")).toHaveCount(0);
  await frame.locator("a.thumb").click();

  await expect(page.locator(".media-picker-modal")).not.toBeVisible();
  const attached = page.locator(".attachments figure").filter({ hasText: name });
  await expect(attached.locator(".ext")).toHaveText("SVG");
  await expect(attached.locator("img")).toHaveCount(0);
});

test("a message from elsewhere does not pick a file", async ({ page }) => {
  const list = await api(page, "/api/lists", "POST", { name: unique("picker"), type: "private" });
  const campaign = await api(page, "/api/campaigns", "POST", {
    name: unique("Picker"),
    subject: "Picker",
    type: "regular",
    content_type: "html",
    body: "Test",
    lists: [list.body.data.id],
  });
  await page.goto(`/admin/campaigns/${campaign.body.data.id}`);
  await page.locator("#attachments").click();
  await page.getByRole("button", { name: "Add attachments" }).click();
  await page.evaluate(() =>
    window.postMessage(
      {
        type: "media-select",
        media: { id: 1, filename: "forged", url: "http://example.test/forged" },
      },
      window.location.origin,
    ),
  );
  await page.waitForTimeout(200);
  await expect(page.locator(".media-picker-modal")).toBeVisible();
  await expect(page.locator(".attachments figure")).toHaveCount(0);
});
