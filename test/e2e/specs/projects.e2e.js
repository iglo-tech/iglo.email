// B143a (14-projects sections 13 and 15 "e2e", D157): native, no upstream spec. The instance admin
// creates a project on the Projects page, opens the primary project through the handoff, switches to
// the new project with the header's switcher, changes one of its settings and sends a test from it.
// The new project's hostname resolves to the stack's loopback address through Chromium's resolver
// rules, so no test depends on DNS; its root URL keeps the stack's port (14-projects section 2).
import { expect } from "@playwright/test";
import { ADMIN, ORIGIN, audience, mailFor, ok, test, unique } from "../helpers.js";

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.example.test 127.0.0.1"] } });

const PROJECTS = "/admin/instance/projects";

test("creates a project, switches to it, changes a setting and sends a test from it", async ({
  page,
}) => {
  const slug = unique("e2e");
  const name = `Project ${slug}`;
  const host = `${slug}.example.test`;
  const projectOrigin = `http://${host}:${new URL(ORIGIN).port}`;

  // The instance login lands on the Projects page.
  await page.goto("/admin/instance/login");
  await page.getByLabel("Username").fill(ADMIN.user);
  await page.getByLabel("Password").fill(ADMIN.password);
  await Promise.all([
    page.waitForURL(`**${PROJECTS}`),
    page.locator('form[action="/admin/instance/login"] button[type=submit]').click(),
  ]);
  await expect(page.locator('[data-testid="project-row"][data-slug="main"]')).toBeVisible();

  // Create the project; the page reloads with its row.
  await page.getByTestId("project-new").click();
  const dialog = page.getByTestId("project-new-dialog");
  await dialog.getByTestId("project-slug").fill(slug);
  await dialog.getByTestId("project-name-input").fill(name);
  await dialog.getByTestId("project-hostname").fill(host);
  await dialog.getByTestId("project-create").click();
  const row = page.locator(`[data-testid="project-row"][data-slug="${slug}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(host);
  await expect(row.getByTestId("project-queued")).toHaveText("0");

  // Open the primary project through the handoff: its header names it and lists every project.
  await Promise.all([
    page.waitForURL(`${ORIGIN}/admin`),
    page
      .locator('[data-testid="project-row"][data-slug="main"]')
      .getByTestId("project-open")
      .click(),
  ]);
  await expect(page.getByTestId("project-switcher")).toBeVisible();

  // Switch to the new project: its link goes through the instance host's handoff.
  await page.getByTestId("project-switcher-button").click();
  await Promise.all([
    page.waitForURL(`${projectOrigin}/admin`),
    page.getByRole("menuitem", { name, exact: true }).click(),
  ]);
  await expect(page.getByTestId("project-name")).toHaveText(name);

  // Change one of its settings: the default sender.
  const sender = `News <news@${host}>`;
  await page.goto(`${projectOrigin}/admin/settings`);
  await page.locator('[name="app.from_email"]').fill(sender);
  const saved = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.locator('[name="app.from_email"]')).toHaveValue(sender);

  // Send a test from it: the new sender, and links on the project's own host.
  const { list, emails } = await audience(page);
  const campaign = await ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "html",
    body: '<p>Hello <a href="{{ unsubscribe_url }}">unsubscribe</a></p>',
    lists: [list.id],
  });
  await page.goto(`${projectOrigin}/admin/campaigns/${campaign.id}`);
  await page
    .locator(".page-header")
    .getByRole("button", { name: "Send test message", exact: true })
    .click();
  await page.locator('#campaign-test input[type="email"]').fill(emails[0]);
  await page.locator('#campaign-test input[type="email"]').press("Enter");
  await page.locator("#campaign-test").getByRole("button", { name: "Send", exact: true }).click();
  const [mail] = await mailFor(emails[0]);
  expect(mail.from).toContain(`news@${host}`);
  expect(mail.listUnsubscribe).toContain(`${projectOrigin}/subscription/`);

  // Clean up: the stack's next spec sees only its own projects.
  await page.goto(`${ORIGIN}${PROJECTS}`);
  await row.getByTestId("project-delete").click();
  const remove = page.getByTestId("project-delete-dialog");
  await expect(remove.getByTestId("project-delete-submit")).toBeDisabled();
  await remove.getByTestId("project-delete-confirm").fill(slug);
  await remove.getByTestId("project-delete-submit").click();
  await expect(row).toHaveCount(0);
});
