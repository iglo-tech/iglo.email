// Adapted from listmonk tests/specs/campaigns.spec.js at 6fcd95f. The run shares one database, so
// each test makes its own lists and uniquely named campaigns, and filters by them. Bodies are
// Liquid (D9). Dropped cases, with reasons, are in the M4.3 pull request: the visual format, dates
// set through psql, and the API-only bulk deletion cases the contract suite covers.
import { expect } from "@playwright/test";
import { api, confirm, login, mailFor, openMenu, selectList, test, unique } from "../helpers.js";

const CAMPAIGNS = "/admin/campaigns";
const expression = "Hello {{ subscriber.name }} from {{ subscriber.attribs.city }}";
const rendered = "Hello Demo Subscriber from Bengaluru";
const rows = (page) => page.locator("tbody tr[data-campaign-id]");
const row = (page, name) =>
  rows(page).filter({ has: page.getByRole("link", { name, exact: true }) });
const campaignNames = (page) =>
  rows(page).locator("td.name > .avatar > .avatar-label > div > a.unstyled");
const timestampHeading = (page) => page.locator(".cy-timestamp .timestamp-sort > a");
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const listField = (page) =>
  page.locator("fieldset").filter({ has: page.locator("#campaign-lists") });

async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

const makeList = (page, name = unique("Audience"), optin = "single") =>
  ok(page, "/api/lists", "POST", { name, type: "private", optin });

async function create(page, overrides = {}) {
  const lists = overrides.lists ?? [(await makeList(page)).id];
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "html",
    body: `<p>${expression}</p>`,
    ...overrides,
    lists,
  });
}

const campaign = (page, id) => ok(page, `/api/campaigns/${id}`);

async function save(page, id, action = () => button(page, "Save changes").click()) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/campaigns/${id}`) && r.request().method() === "PUT",
    ),
    action(),
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

async function menu(page, name, action) {
  const item = row(page, name).getByRole("menuitem", { name: action, exact: true });
  if (!(await item.isVisible())) await openMenu(row(page, name));
  await item.click();
}

async function switchFormat(page, format, accept = true) {
  const settings = page.locator('button[popovertarget="content-settings"]');
  await settings.click();
  await page.locator('#content-settings select[name="content_type"]').selectOption(format);
  if (accept) await confirm(page);
  else await button(page.locator("dialog[open]"), "Cancel").click();
  await settings.click();
}

async function editorReady(page) {
  await expect(page.locator(".editor-body")).not.toHaveClass(/is-loading/);
}

async function fillBody(page, format, text) {
  await editorReady(page);
  if (format === "richtext") {
    await page.locator('richtext-editor [contenteditable="true"]').fill(text);
  } else if (format === "plain") {
    await page.locator('textarea[name="content"]').fill(text);
  } else {
    await page
      .locator(".editor-body .cm-content")
      .fill(format === "html" ? `<strong>${text}</strong>` : `**${text}**`);
  }
}

// One subscriber on a new list, for mail the sink can be asked about.
async function audience(page, count = 1) {
  const list = await makeList(page);
  const emails = [];
  for (let i = 0; i < count; i += 1) {
    const email = `${unique("reader")}@example.com`;
    await ok(page, "/api/subscribers", "POST", {
      email,
      name: `Reader ${i}`,
      status: "enabled",
      lists: [list.id],
    });
    emails.push(email);
  }
  return { list, emails };
}

async function preview(page, text) {
  await button(page, "Preview").click();
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(text);
  await button(page.locator(".preview-modal"), "Close").click();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("shows a campaign and previews it from the listing", async ({ page }) => {
  const list = await makeList(page);
  const c = await create(page, { lists: [list.id] });
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Draft");
  await expect(rows(page).locator(".lists")).toContainText(list.name);
  await openMenu(rows(page));
  await rows(page).getByRole("menuitem", { name: "Preview", exact: true }).click();
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(rendered);
  await button(page.locator(".preview-modal"), "Close").click();
  await expect(page.locator(".preview-modal iframe")).not.toHaveAttribute("src");
});

for (const format of ["richtext", "html", "markdown", "plain"]) {
  for (const count of [1, 2]) {
    test(`creates, edits and previews ${format} with ${count} list(s)`, async ({ page }) => {
      const lists = [await makeList(page)];
      if (count > 1) lists.push(await makeList(page, unique("Opt-in list"), "double"));
      const name = unique(`New ${format}`);
      const subject = unique(`Subject ${format}`);
      await page.goto(CAMPAIGNS);
      await page.getByRole("link", { name: "New", exact: true }).click();
      await expect(tab(page, "Content")).toHaveAttribute("aria-disabled", "true");
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Subject", { exact: true }).fill(subject);
      await page.locator('input[name="from_email"]').fill("Sender <sender@example.com>");
      await page.getByRole("combobox", { name: "Format", exact: true }).selectOption(format);
      for (const list of lists) await selectList(listField(page), list.name);
      for (const tag of ["news", "monthly"]) {
        await page.getByPlaceholder("Tags", { exact: true }).fill(tag);
        await page.getByPlaceholder("Tags", { exact: true }).press("Enter");
      }
      await page.getByRole("switch", { name: "Custom headers", exact: true }).check();
      await page.locator('textarea[name="headers"]').fill('[{"X-Custom":"value"}]');
      await button(page, "Continue").click();
      await expect(page).toHaveURL(/\/campaigns\/\d+#tab=content$/);
      const id = Number(new URL(page.url()).pathname.split("/").pop());
      await expect(tab(page, "Content")).toHaveAttribute("aria-selected", "true");
      await fillBody(page, format, expression);
      await save(page, id);
      await page.reload();
      await editorReady(page);
      const saved = await campaign(page, id);
      expect(saved).toMatchObject({
        name,
        subject,
        status: "draft",
        content_type: format,
        from_email: "Sender <sender@example.com>",
        headers: [{ "X-Custom": "value" }],
        send_at: null,
        altbody: null,
      });
      expect(saved.tags.sort()).toEqual(["monthly", "news"]);
      expect(saved.lists.map((l) => l.id).sort()).toEqual(lists.map((l) => l.id).sort());
      expect(saved.body).toContain(expression);
      await preview(page, rendered);
      await page.goto(`${CAMPAIGNS}?query=${name}`);
      await expect(row(page, name)).toContainText(subject);
      await expect(row(page, name).locator(".lists a.avatar-label")).toHaveCount(count);
    });
  }
}

test("edits metadata, schedules in local time, unschedules and clears the schedule", async ({
  page,
}) => {
  const [before, after] = [await makeList(page), await makeList(page)];
  const c = await create(page, { lists: [before.id], tags: ["old"] });
  const name = unique("Scheduled newsletter");
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Subject", { exact: true }).fill("Updated subject");
  await page.locator('input[name="from_email"]').fill("New <new@example.com>");
  await listField(page).locator(".badge").hover();
  await button(listField(page), `Remove ${before.name}`).click();
  await selectList(listField(page), after.name);
  const tags = page.getByPlaceholder("Tags", { exact: true });
  await tags.press("Backspace");
  await tags.fill("new-tag");
  await tags.press("Enter");
  await page.getByRole("switch", { name: "Custom headers", exact: true }).check();
  await page.locator('textarea[name="headers"]').fill('[{"X-Custom":"Custom-Value"}]');
  await page.getByRole("switch", { name: "Send later", exact: true }).check();
  const when = `${new Date().getFullYear() + 1}-06-15T09:30`;
  await page.locator('input[name="send_at"]').fill(when);
  const iso = await page.evaluate((value) => new Date(value).toISOString(), when);
  await expect(button(page, "Start campaign")).toHaveCount(0);
  await tab(page, "Content").click();
  await switchFormat(page, "plain");
  await fillBody(page, "plain", "Scheduled body");
  await tab(page, "Campaign").click();
  await button(page, "Schedule campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await page.goto(`${CAMPAIGNS}?query=${name}`);
  await expect(row(page, name)).toContainText("Scheduled");
  const saved = await campaign(page, c.id);
  expect(saved).toMatchObject({
    status: "scheduled",
    name,
    subject: "Updated subject",
    from_email: "New <new@example.com>",
    content_type: "plain",
    body: "Scheduled body",
    altbody: null,
    tags: ["new-tag"],
    headers: [{ "X-Custom": "Custom-Value" }],
  });
  expect(new Date(saved.send_at).toISOString()).toBe(iso);
  expect(saved.lists.map((l) => l.id)).toEqual([after.id]);
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await expect(page.locator('input[name="send_at"]')).toHaveValue(when);
  await button(page, "Unschedule").click();
  await confirm(page);
  await expect(page.locator("header .status-draft")).toBeVisible();
  await page.getByRole("switch", { name: "Send later", exact: true }).uncheck();
  await save(page, c.id);
  expect((await campaign(page, c.id)).send_at).toBeNull();
  await expect(button(page, "Start campaign")).toBeVisible();
});

test("converts formats and cancels conversion without losing content", async ({ page }) => {
  const c = await create(page, { content_type: "richtext" });
  await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
  await editorReady(page);
  await switchFormat(page, "plain", false);
  await expect(page.locator("richtext-editor")).toBeVisible();
  for (const format of ["html", "markdown", "plain"]) {
    await switchFormat(page, format);
    await editorReady(page);
    await save(page, c.id);
    expect(await campaign(page, c.id)).toMatchObject({ content_type: format });
    await preview(page, rendered);
    await page.reload();
  }
});

test("previews and test-sends unsaved content without modifying the draft", async ({ page }) => {
  const { list, emails } = await audience(page);
  const c = await create(page, {
    lists: [list.id],
    content_type: "plain",
    body: "Saved body",
    subject: "Preview test",
  });
  await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
  await fillBody(page, "plain", "Unsaved hello {{ subscriber.name }}");
  await button(page, "Preview").click();
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(
    "Unsaved hello Demo Subscriber",
  );
  await button(page.locator(".preview-modal"), "Close").click();
  await button(page.locator(".page-header"), "Send test message").click();
  await page.locator('#campaign-test input[type="email"]').fill(emails[0]);
  await page.locator('#campaign-test input[type="email"]').press("Enter");
  await button(page.locator("#campaign-test"), "Send").click();
  const [mail] = await mailFor(emails[0]);
  expect(mail.body).toContain("Unsaved hello");
  expect(await campaign(page, c.id)).toMatchObject({ status: "draft", body: "Saved body" });
});

test("generates, persists and removes alternate text; plain format clears it", async ({ page }) => {
  const c = await create(page, { body: "<p>Alternate message</p>" });
  await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
  await editorReady(page);
  const toggle = page
    .getByRole("tabpanel")
    .filter({ has: page.locator(".editor-body") })
    .getByRole("switch");
  await toggle.check();
  const alt = page.getByRole("textbox", { name: "Add alternate plain text message", exact: true });
  await expect(alt).toHaveValue("Alternate message");
  await alt.fill("Custom alternate");
  await save(page, c.id);
  await page.reload();
  await expect(alt).toHaveValue("Custom alternate");
  await toggle.uncheck();
  await confirm(page);
  await save(page, c.id);
  expect((await campaign(page, c.id)).altbody).toBeNull();
  await toggle.check();
  await switchFormat(page, "plain");
  await save(page, c.id);
  expect((await campaign(page, c.id)).altbody).toBeNull();
});

test("persists attributes and archive settings with keyboard save", async ({ page }) => {
  const c = await create(page);
  const slug = unique("newsletter-edition");
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await tab(page, "Attributes").click();
  await page.getByRole("textbox", { name: "Attributes", exact: true }).fill('{"edition":42}');
  await tab(page, "Archive").click();
  await page.getByRole("switch").filter({ visible: true }).check();
  await page.locator('input[name="archive_slug"]').fill(slug);
  await page
    .locator('textarea[name="archive_meta"]')
    .fill('{"name":"Archive reader","attribs":{"city":"Mumbai"}}');
  await save(page, c.id, () =>
    page.locator('textarea[name="archive_meta"]').press("ControlOrMeta+s"),
  );
  await page.reload();
  await tab(page, "Archive").click();
  await expect(page.locator('input[name="archive_slug"]')).toHaveValue(slug);
  await button(
    page.getByRole("tabpanel").filter({ has: page.locator('input[name="archive_slug"]') }),
    "Preview",
  ).click();
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(
    "Hello Archive reader from Mumbai",
  );
  await button(page.locator(".preview-modal"), "Close").click();
  expect(await campaign(page, c.id)).toMatchObject({
    attribs: { edition: 42 },
    archive: true,
    archive_slug: slug,
    archive_meta: { name: "Archive reader", attribs: { city: "Mumbai" } },
  });
});

test("two campaigns can share a subject from the form", async ({ page }) => {
  // Upstream's form sends the subject as the slug, which refuses the second one (07-api-and-ui.md).
  const list = await makeList(page);
  const subject = unique("Monthly news");
  for (let i = 0; i < 2; i += 1) {
    await page.goto(`${CAMPAIGNS}/new`);
    await page.getByLabel("Name", { exact: true }).fill(unique("Same subject"));
    await page.getByLabel("Subject", { exact: true }).fill(subject);
    await selectList(listField(page), list.name);
    await button(page, "Continue").click();
    await expect(page).toHaveURL(/\/campaigns\/\d+#tab=content$/);
  }
});

test("rejects malformed JSON without overwriting saved metadata", async ({ page }) => {
  const c = await create(page, { headers: [{ "X-Custom": "saved" }], attribs: { edition: 1 } });
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  for (const [name, field, valid] of [
    ["Campaign", 'textarea[name="headers"]', '[{"X-Custom":"saved"}]'],
    ["Attributes", 'textarea[aria-labelledby="campaign-attribs-label"]', '{"edition":1}'],
  ]) {
    await tab(page, name).click();
    await page.locator(field).fill("{broken");
    await button(page, "Save changes").click();
    await expect(page.locator('output[data-variant="danger"]').last()).toContainText(
      /JSON|SyntaxError/,
    );
    expect(await campaign(page, c.id)).toMatchObject({
      headers: [{ "X-Custom": "saved" }],
      attribs: { edition: 1 },
    });
    await page.locator(field).fill(valid);
    await save(page, c.id);
  }
});

test("clones full content into a draft and cancels cloning and deletion", async ({ page }) => {
  const lists = [(await makeList(page)).id, (await makeList(page)).id];
  const c = await create(page, {
    tags: ["clone"],
    headers: [{ "X-Custom": "copy" }],
    attribs: { edition: 2 },
    altbody: "Alternative",
    lists,
  });
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await menu(page, c.name, "Clone");
  await expect(rows(page)).toHaveCount(1);
  const name = unique("Cloned newsletter");
  page.once("dialog", (dialog) => dialog.accept(name));
  await menu(page, c.name, "Clone");
  await expect(page).toHaveURL(/\/campaigns\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split("/").pop());
  const clone = await campaign(page, id);
  for (const key of ["subject", "body", "content_type", "altbody", "headers", "attribs", "tags"])
    expect(clone[key]).toEqual(c[key]);
  expect(clone).toMatchObject({ name, status: "draft" });
  expect(clone.uuid).not.toBe(c.uuid);
  expect(clone.lists.map((l) => l.id)).toEqual(lists);
  await page.goto(`${CAMPAIGNS}?query=${clone.name}`);
  await menu(page, clone.name, "Delete");
  await button(page.locator("dialog[open]"), "Cancel").click();
  await expect(row(page, clone.name)).toBeVisible();
  await menu(page, clone.name, "Delete");
  await confirm(page);
  await expect(row(page, clone.name)).toHaveCount(0);
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await expect(row(page, c.name)).toBeVisible();
});

test("searches and filters campaigns through the page URL", async ({ page }) => {
  const prefix = unique("filter");
  const [news, other] = [`${prefix}-news`, `${prefix}-other`];
  for (const [name, tag] of [
    ["Bravo", news],
    ["Alpha", news],
    ["Charlie", other],
  ])
    await create(page, { name: `${prefix} ${name}`, tags: [tag] });
  const alpha = `${prefix} Alpha`;
  const scheduled = await create(page, {
    name: `${prefix} Scheduled`,
    send_at: new Date(Date.now() + 86400000).toISOString(),
  });
  await ok(page, `/api/campaigns/${scheduled.id}/status`, "PUT", { status: "scheduled" });
  const search = page.getByRole("textbox", { name: "Search", exact: true });
  await page.goto(CAMPAIGNS);
  await search.fill(alpha);
  await search.press("Enter");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, alpha)).toBeVisible();
  await page.goto(`${CAMPAIGNS}?query=${prefix}`);
  await row(page, alpha)
    .getByRole("link", { name: `#${news}`, exact: true })
    .click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page).toHaveURL(/[?&]tag=/);
  await search.fill("Alpha");
  await search.press("Enter");
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]tag=/);
  await page.locator(".page-title").getByRole("link", { name: "Remove", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]tag=/);
  await expect(row(page, alpha)).toBeVisible();
  await page.goto(`${CAMPAIGNS}?query=${prefix}`);
  await row(page, alpha).getByTitle("Filter Draft", { exact: true }).click();
  await expect(page).toHaveURL(/[?&]status=draft/);
  await expect(rows(page)).toHaveCount(3);
});

async function selectTimestamp(page, label) {
  await page.locator('[popovertarget="camp-timestamp-sort"]').click();
  await page
    .locator("#camp-timestamp-sort")
    .getByRole("menuitem", { name: label, exact: true })
    .click();
}

test("sorts by name and by scheduled date through the timestamp dropdown", async ({ page }) => {
  const prefix = unique("Sort");
  const dates = {
    Alpha: "2099-01-11T12:00:00.000Z",
    Bravo: "2099-01-13T12:00:00.000Z",
    Charlie: "2099-01-12T12:00:00.000Z",
  };
  for (const [name, send_at] of Object.entries(dates))
    await create(page, { name: `${prefix} ${name}`, send_at });
  await page.goto(`${CAMPAIGNS}?query=${prefix}&page=2`);
  const names = (list) => list.map((name) => `${prefix} ${name}`);
  const heading = page.locator(".cy-name").getByRole("link", { name: "Name", exact: true });
  await heading.click();
  await expect(campaignNames(page)).toHaveText(names(["Alpha", "Bravo", "Charlie"]));
  await expect(page).not.toHaveURL(/[?&]page=/);
  await heading.click();
  await expect(campaignNames(page)).toHaveText(names(["Charlie", "Bravo", "Alpha"]));

  await selectTimestamp(page, "Scheduled");
  await expect(campaignNames(page)).toHaveText(names(["Alpha", "Charlie", "Bravo"]));
  await expect(timestampHeading(page)).toHaveText("Scheduled");
  await expect(timestampHeading(page)).toHaveAttribute("data-sorted", "asc");
  const cell = row(page, `${prefix} Alpha`).locator("td.timestamp");
  await expect(cell).toHaveAttribute("data-label", "Scheduled");
  await expect(cell).toContainText("11 Jan 2099");

  // Re-selecting the option and clicking its heading both toggle direction.
  await selectTimestamp(page, "Scheduled");
  await expect(campaignNames(page)).toHaveText(names(["Bravo", "Charlie", "Alpha"]));
  await timestampHeading(page).click();
  await expect(campaignNames(page)).toHaveText(names(["Alpha", "Charlie", "Bravo"]));

  await selectTimestamp(page, "All");
  await expect(page).not.toHaveURL(/order_by/);
  await expect(timestampHeading(page)).toHaveText("Timestamps");
  await expect(rows(page).locator("td.timestamp > span").first()).toHaveAttribute(
    "title",
    /Created:.*\nScheduled:/,
  );
});

test("shows missing campaign timestamps as a dash and restores the default view", async ({
  page,
}) => {
  const c = await create(page, { name: unique("Unsent campaign") });
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  const cell = row(page, c.name).locator("td.timestamp");
  const defaultText = await cell.textContent();
  for (const label of ["Started", "Ended", "Scheduled"]) {
    await selectTimestamp(page, label);
    await expect(timestampHeading(page)).toHaveText(label);
    await expect(cell).toHaveText("—");
  }
  await selectTimestamp(page, "Created");
  await expect(cell.locator("span")).toBeVisible();
  await selectTimestamp(page, "All");
  await expect(timestampHeading(page)).toHaveText("Timestamps");
  await expect(cell).toHaveText(defaultText.trim());
});

for (const { label, all, filter } of [
  { label: "selected IDs", all: false, filter: "query" },
  { label: "all matching pages", all: true, filter: "query" },
  { label: "all tagged campaigns", all: true, filter: "tag" },
]) {
  test(`bulk deletes ${label} and preserves other campaigns`, async ({ page }) => {
    const prefix = unique("Bulk");
    const list = await makeList(page);
    const other = await create(page, { lists: [list.id], name: unique("Unrelated") });
    const made = [];
    for (let i = 0; i < (all ? 22 : 3); i += 1) {
      const c = await create(page, {
        lists: [list.id],
        name: `${prefix} ${i}`,
        tags: [`${prefix}-tag`],
      });
      made.push(c.id);
    }
    await page.goto(`${CAMPAIGNS}?${filter === "tag" ? `tag=${prefix}-tag` : `query=${prefix}`}`);
    await expect(rows(page).first()).toBeVisible();
    await page.locator('thead input[type="checkbox"]').check();
    await page.locator('button[popovertarget="camp-bulk-actions"]').click();
    if (all) await page.getByRole("menuitem", { name: /Select all/ }).click();
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
    await confirm(page);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator(".empty-state")).toBeVisible();
    expect((await campaign(page, other.id)).name).toBe(other.name);
  });
}

test("uploads an attachment, persists it and delivers it when starting from the editor", async ({
  page,
}) => {
  const { list, emails } = await audience(page);
  const c = await create(page, { lists: [list.id], subject: "Attachment delivery" });
  const filename = `${unique("campaign-example")}.pdf`;
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await tab(page, "Attachments").click();
  await button(page, "Add attachments").click();
  const picker = page.locator(".media-picker-modal");
  const frame = picker.frameLocator("iframe");
  await frame.getByTestId("btn-upload-menu").click();
  await frame.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 attachment"),
  });
  await frame.getByTestId("btn-upload").click();
  await frame
    .locator("a.thumb")
    .and(frame.getByTitle(filename, { exact: true }))
    .click();
  await expect(picker).not.toBeVisible();
  await save(page, c.id);
  await page.reload();
  await expect(page.locator(".attachments .filename").first()).toHaveText(filename);
  expect((await campaign(page, c.id)).media).toHaveLength(1);
  await tab(page, "Campaign").click();
  await button(page, "Start campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  const [mail] = await mailFor(emails[0]);
  expect(mail.body).toContain(filename);
  await expect
    .poll(async () => (await campaign(page, c.id)).status, { timeout: 20000 })
    .toBe("finished");
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await expect(row(page, c.name)).toContainText("Finished");
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(button(page, "Start campaign")).toHaveCount(0);
  await tab(page, "Archive").click();
  await page.getByRole("switch").filter({ visible: true }).check();
  const slug = unique("delivered-newsletter");
  await page.locator('input[name="archive_slug"]').fill(slug);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/campaigns/${c.id}/archive`) && r.request().method() === "PUT",
    ),
    button(page, "Save changes").click(),
  ]);
  expect(response.ok()).toBeTruthy();
  expect(await campaign(page, c.id)).toMatchObject({
    status: "finished",
    archive: true,
    archive_slug: slug,
  });
});

test("starts, pauses, resumes and cancels from the listing", async ({ page }) => {
  // Keep sending long enough to change status at the configured rate.
  const { list } = await audience(page, 150);
  const c = await create(page, { lists: [list.id] });
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  for (const [action, status] of [
    ["Start campaign", "running"],
    ["Pause", "paused"],
    ["Send", "running"],
    ["Cancel", "cancelled"],
  ]) {
    await menu(page, c.name, action);
    await confirm(page);
    await expect(row(page, c.name)).toHaveClass(`status-${status}`);
    expect((await campaign(page, c.id)).status).toBe(status);
  }
  await openMenu(row(page, c.name));
  await expect(
    row(page, c.name).getByRole("menuitem", { name: "Start campaign", exact: true }),
  ).toHaveCount(0);
});

test("an image can embed as an inline part or stay a URL after reload", async ({ page }) => {
  for (const embed of [true, false]) {
    const { list, emails } = await audience(page);
    const c = await create(page, {
      lists: [list.id],
      content_type: "richtext",
      body: "",
      subject: `richtext image ${embed}`,
    });
    const [media] = await page.evaluate(async () => {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
      const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
      const form = new FormData();
      form.append("file", new File([bytes], "campaign-pixel.png", { type: "image/png" }));
      const csrf = document.cookie
        .split("; ")
        .find((v) => v.startsWith("csrf="))
        .slice(5);
      const response = await fetch("/api/media", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: form,
      });
      return [(await response.json()).data];
    });
    await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
    await editorReady(page);
    await button(page, "Image").click();
    const dialog = page.locator("richtext-editor dialog[open]");
    await button(dialog, "Media").click();
    await page
      .locator(".media-picker-modal")
      .frameLocator("iframe")
      .getByTitle(media.filename, { exact: true })
      .first()
      .click();
    await expect(dialog.locator('input[name="src"]')).toHaveValue(media.url);
    await dialog.getByRole("checkbox", { name: "Embed", exact: true }).setChecked(embed);
    await button(dialog, "Insert").click();
    await expect(page.locator("richtext-editor [contenteditable] img")).toHaveAttribute(
      "src",
      media.url,
    );
    await save(page, c.id);
    await page.reload();
    await editorReady(page);
    await page.locator("richtext-editor [contenteditable] img").click();
    await button(page, "Image").click();
    await expect(
      page.locator("richtext-editor dialog[open]").getByRole("checkbox", {
        name: "Embed",
        exact: true,
      }),
    ).toBeChecked({ checked: embed });
    await button(page.locator("richtext-editor dialog[open]"), "Close").click();
    await tab(page, "Campaign").click();
    await button(page, "Start campaign").click();
    await confirm(page);
    const [mail] = await mailFor(emails[0]);
    expect(mail.body.includes("image/png")).toBe(embed);
    expect(mail.body.includes("cid:")).toBe(embed);
  }
});

for (const tracked of [true, false]) {
  test(`richtext link tracking follows the URL (${tracked ? "on" : "off"}) and persists toggles`, async ({
    page,
  }) => {
    const url = "https://example.com/docs?edition=42#intro";
    const href = (track) => `${url}${track ? "@TrackLink" : ""}`;
    const c = await create(page, {
      content_type: "richtext",
      body: `<p><a href="${href(tracked)}">Documentation</a> <a href="${href(!tracked)}">Other link</a></p>`,
    });
    await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
    await editorReady(page);

    // Existing links must override the remembered preference for newly inserted links.
    await page.evaluate((value) => localStorage.setItem("trackLink", String(value)), !tracked);
    const link = page
      .locator("richtext-editor [contenteditable]")
      .getByRole("link", { name: "Documentation", exact: true });
    const dialog = page.locator("richtext-editor dialog[open]");
    const checkbox = dialog.getByRole("checkbox", { name: "Track link?", exact: true });
    await link.click();
    await button(page, "Link").click();
    await expect(dialog.locator('input[name="url"]')).toHaveValue(url);
    await expect(checkbox).toBeChecked({ checked: tracked });
    await button(dialog, "Close").click();

    // Reusing the URL dialog for another link must recompute the checkbox state.
    await page
      .locator("richtext-editor [contenteditable]")
      .getByRole("link", { name: "Other link", exact: true })
      .click();
    await button(page, "Link").click();
    await expect(checkbox).toBeChecked({ checked: !tracked });
    await button(dialog, "Close").click();
    await link.click();
    await button(page, "Link").click();
    await expect(checkbox).toBeChecked({ checked: tracked });
    await checkbox.setChecked(!tracked);
    await button(dialog, "Apply").click();
    await expect(link).toHaveAttribute("href", href(!tracked));
    await save(page, c.id);
    expect((await campaign(page, c.id)).body).toContain(`href="${href(!tracked)}"`);
    await page.reload();
    await editorReady(page);
    await link.click();
    await button(page, "Link").click();
    await expect(dialog.locator('input[name="url"]')).toHaveValue(url);
    await expect(checkbox).toBeChecked({ checked: !tracked });
    await button(dialog, "Close").click();
  });
}
