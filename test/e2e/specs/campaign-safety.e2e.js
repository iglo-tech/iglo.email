// What M4.3 asks of these screens beyond upstream's cases: stored HTML cannot run on this origin,
// stored names stay text, a stale status shows the API's message, a second click sends nothing
// twice, and live stats stop when nothing runs. listmonk has no such spec at 6fcd95f.
import { expect } from "@playwright/test";
import { api, confirm, login, openMenu, PASSWORD, createUser, test, unique } from "../helpers.js";

const CAMPAIGNS = "/admin/campaigns";
const TEMPLATES = "/admin/templates";
const rows = (page) => page.locator("tbody tr[data-campaign-id]");
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const frame = (page) => page.locator(".preview-modal iframe");
const close = (page) => button(page.locator(".preview-modal"), "Close").click();

async function ok(page, path, method, body) {
  const response = await api(page, path, method, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function create(page, overrides = {}) {
  const lists = overrides.lists ?? [
    (
      await ok(page, "/api/lists", "POST", {
        name: unique("Safety"),
        type: "private",
        optin: "single",
      })
    ).id,
  ];
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Campaign"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "html",
    body: "<p>Body</p>",
    ...overrides,
    lists,
  });
}

// Every way an email could act on this origin, with `pwned` in what each would ask for.
const payload = `<p>visible marker</p>
<script>window.parent.pwned = document.cookie; fetch("/api/settings?pwned=script");</script>
<img src="/api/settings?pwned=image" onerror="window.parent.pwned = 'onerror'">
<svg onload="window.parent.pwned = 'svg'"></svg>
<form action="/api/settings?pwned=form" method="post"><button autofocus>go</button></form>
<script>document.forms[0].submit();</script>
<a href="javascript:window.parent.pwned='link'">x</a>`;

// What reached the server. A request the policy blocks still shows as a failed `request` event.
function watch(page) {
  const asked = [];
  page.on("response", (r) => {
    if (r.url().includes("pwned")) asked.push(r.url());
  });
  return asked;
}

async function harmless(page, asked) {
  await expect(page.frameLocator(".preview-modal iframe").locator("body")).toContainText(
    "visible marker",
  );
  await expect(frame(page)).toHaveAttribute("sandbox", "");
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(asked).toEqual([]);
}

test("a campaign or template body with script cannot act on the application's origin", async ({
  page,
}) => {
  const asked = watch(page);
  await login(page);
  const c = await create(page, { body: payload, archive_meta: {} });
  const body = `${payload}{{ content | raw }}`;
  const t = await ok(page, "/api/templates", "POST", {
    name: unique("Scripted"),
    type: "campaign",
    subject: "",
    body,
  });

  // Saved, from the listing: the API's sandbox CSP as well as the frame's.
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await openMenu(rows(page));
  await rows(page).getByRole("menuitem", { name: "Preview", exact: true }).click();
  await harmless(page, asked);
  await close(page);

  // Unsaved, from the editor: written to the frame, so the sandbox attribute and the injected
  // policy are all that hold it. The script is there, first after the policy, and does nothing.
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await button(page.locator(".page-header"), "Preview").click();
  await harmless(page, asked);
  const srcdoc = await frame(page).getAttribute("srcdoc");
  expect(srcdoc).toContain("<script>window.parent.pwned");
  expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<script>"));
  await close(page);

  // The archive preview, which only has a POST.
  await tab(page, "Archive").click();
  await page.getByRole("switch").filter({ visible: true }).check();
  await button(page.getByRole("tabpanel").filter({ hasText: "Slug" }), "Preview").click();
  await harmless(page, asked);
  await close(page);

  // A template, saved and unsaved.
  await page.goto(`${TEMPLATES}?query=${t.name}`);
  await openMenu(page.getByTestId("template-row"));
  await page.getByTestId("template-row").getByTestId("btn-preview").click();
  await harmless(page, asked);
  await close(page);
  await page.goto(`${TEMPLATES}/${t.id}`);
  await page.getByTestId("btn-preview").first().click();
  await harmless(page, asked);
});

test("hostile campaign, subject, template and tag names render as text", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const hostile = (kind) =>
    `<img src=x onerror="window.pwned='${kind}'"> "'\` {{ 7*7 }} \${7*7} x-on:click="window.pwned=1" ${unique(kind)}`;
  const name = hostile("campaign");
  const subject = hostile("subject").replaceAll("{{ 7*7 }}", "");
  const tag = `<b>${unique("tag")}</b>`;
  const list = await ok(page, "/api/lists", "POST", {
    name: hostile("list"),
    type: "private",
    optin: "single",
  });
  const c = await create(page, { name, subject, tags: [tag], lists: [list.id] });
  const templateName = hostile("template");
  const tx = hostile("txsubject").replaceAll("{{ 7*7 }}", "");
  const t = await ok(page, "/api/templates", "POST", {
    name: templateName,
    type: "tx",
    subject: tx,
    body: "<p>Hello</p>",
  });
  const campaignTemplate = await ok(page, "/api/templates", "POST", {
    name: hostile("layout"),
    type: "campaign",
    subject: "",
    body: "{{ content | raw }}",
  });

  const clean = async () => {
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    expect(await page.locator("section.campaigns img, section.campaign img").count()).toBe(0);
    expect(await page.locator("section.templates img, section b").count()).toBe(0);
    expect(errors).toEqual([]);
  };

  await page.goto(`${CAMPAIGNS}?tag=${encodeURIComponent(tag)}`);
  const row = rows(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator("td.name .avatar-label > div > a.unstyled")).toHaveText(name);
  await expect(row.locator(".subject a")).toHaveText(subject);
  await expect(row.locator("a.tag")).toHaveText(`#${tag}`);
  await expect(row.locator(".lists a.avatar-label")).toHaveText(list.name);
  await expect(page.locator(".page-title .badge")).toContainText(tag);
  await clean();

  // The preview title, the confirm and the toast it leads to are text as well.
  await openMenu(row);
  await row.getByRole("menuitem", { name: "Preview", exact: true }).click();
  await expect(page.locator(".preview-modal .dialog-title")).toHaveText(name);
  await close(page);
  await openMenu(row);
  await row.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.locator("dialog[open] [data-confirm-message]")).toContainText(name);
  await button(page.locator("dialog[open]"), "Cancel").click();
  await clean();

  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await expect(page.locator("h1.page-title")).toHaveText(name);
  await expect(page.locator(".breadcrumbs a[aria-current]")).toContainText(name);
  await expect(page.locator('input[name="subject"]')).toHaveValue(subject);
  await expect(page.locator("#campaign-lists").locator("..")).toContainText(list.name);
  await tab(page, "Content").click();
  await page.locator('button[popovertarget="content-settings"]').click();
  await expect(
    page.locator('#content-settings select[name="template"] option', {
      hasText: campaignTemplate.name,
    }),
  ).toHaveCount(1);
  await clean();

  await page.goto(`${TEMPLATES}/${t.id}`);
  await expect(page.locator("h1.page-title")).toHaveText(templateName);
  await expect(page.locator('input[name="subject"]')).toHaveValue(tx);
  await clean();

  await page.goto(`${TEMPLATES}?query=${encodeURIComponent(templateName.slice(-16))}`);
  await expect(page.getByTestId("template-row").getByTestId("btn-edit").first()).toHaveText(
    templateName,
  );
  await expect(page.getByTestId("template-row").locator("p")).toHaveText(tx);
  await clean();
});

test("a stale listing or form shows the API's message and offers what is true now", async ({
  page,
}) => {
  await login(page);
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Stale"),
    type: "private",
    optin: "single",
  });
  const c = await create(page, { lists: [list.id] });
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await expect(rows(page)).toHaveCount(1);

  // Another user starts it; with no subscribers it finishes at once or stays running.
  await ok(page, `/api/campaigns/${c.id}/status`, "PUT", { status: "running" });
  await openMenu(rows(page));
  await rows(page).getByRole("menuitem", { name: "Start campaign", exact: true }).click();
  await confirm(page);
  await expect(page.locator('output[data-variant="danger"]').last()).toContainText(
    /Only paused campaigns and drafts can be started/,
  );
  await expect(rows(page)).not.toHaveClass("status-draft");

  // The same from the form: the save is refused, and Start goes away.
  const other = await create(page, { lists: [list.id] });
  await page.goto(`${CAMPAIGNS}/${other.id}`);
  await expect(button(page, "Start campaign")).toBeVisible();
  await ok(page, `/api/campaigns/${other.id}/status`, "PUT", { status: "running" });
  await button(page, "Start campaign").click();
  await confirm(page);
  await expect(page.locator('output[data-variant="danger"]').last()).toContainText(/can't|cannot/i);
  await expect(button(page, "Start campaign")).toHaveCount(0);
});

test("a second click changes the status once", async ({ page }) => {
  await login(page);
  const puts = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().endsWith("/status")) puts.push(r.url());
  });
  const c = await create(page);
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await openMenu(rows(page));
  // Both clicks land before the confirm: one dialog, one request.
  await rows(page)
    .getByRole("menuitem", { name: "Start campaign", exact: true })
    .evaluate((el) => {
      el.click();
      el.click();
    });
  await expect(page.locator("dialog[open] [data-confirm-ok]")).toHaveCount(1);
  await page.locator("dialog[open] [data-confirm-ok]").dblclick();
  await expect(rows(page)).not.toHaveClass("status-draft");
  expect(puts).toHaveLength(1);

  puts.length = 0;
  const other = await create(page);
  await page.goto(`${CAMPAIGNS}/${other.id}`);
  await button(page, "Start campaign").evaluate((el) => {
    el.click();
    el.click();
  });
  await expect(page.locator("dialog[open] [data-confirm-ok]")).toHaveCount(1);
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  expect(puts).toHaveLength(1);
});

test("live stats update while a campaign runs and stop when nothing runs or the page is hidden", async ({
  page,
}) => {
  await login(page);
  const c = await create(page);
  // A running row without sending: the listing and the stats are this test's.
  let statuses = "running";
  await page.route("**/api/campaigns?*", async (route) => {
    const response = await route.fetch();
    const out = await response.json();
    for (const row of out.data.results) if (row.id === c.id) row.status = statuses;
    await route.fulfill({ response, json: out });
  });
  let reads = 0;
  let stats = [{ id: c.id, status: "running", to_send: 200, sent: 50, rate: 12, net_rate: 12 }];
  await page.route("**/api/campaigns/running/stats", (route) => {
    reads += 1;
    return route.fulfill({ json: { data: stats } });
  });

  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  const row = rows(page);
  await expect(row).toHaveClass("status-running");
  await expect(row.locator('[data-stat="sent"]')).toHaveText("50");
  await expect(row.locator('[data-stat="to_send"]')).toHaveText("200");
  await expect(row.locator('[data-stat="percent"]')).toHaveText("25%");
  await expect(row.locator('[data-stat="rate"]')).toHaveText("12");
  await expect(row.locator('[data-stat="progress"]')).toHaveAttribute("max", "200");

  // Hidden: no more reads. Visible again: reads at once.
  const hide = (hidden) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await hide(true);
  await page.waitForTimeout(300);
  const held = reads;
  await page.waitForTimeout(3000);
  expect(reads).toBe(held);
  await hide(false);
  await expect.poll(() => reads).toBeGreaterThan(held);

  // It left the running set: the page reads the rows, and with nothing running, stops.
  statuses = "finished";
  stats = [];
  await expect(row).toHaveClass("status-finished");
  const last = reads;
  await page.waitForTimeout(3000);
  expect(reads).toBe(last);
});

test("the templates chosen on a campaign show after a reload", async ({ page }) => {
  await login(page);
  const layout = await ok(page, "/api/templates", "POST", {
    name: `zz ${unique("layout")}`,
    type: "campaign",
    subject: "",
    body: "<div>layout marker</div>{{ content | raw }}",
  });
  const c = await create(page);
  await page.goto(`${CAMPAIGNS}/${c.id}#tab=content`);
  await page.locator('button[popovertarget="content-settings"]').click();
  await page.locator('#content-settings select[name="template"]').selectOption(String(layout.id));
  await page.locator('button[popovertarget="content-settings"]').click();
  await tab(page, "Archive").click();
  await page.getByRole("switch").filter({ visible: true }).check();
  await page.locator('select[name="archive_template"]').selectOption(String(layout.id));
  await button(page, "Save changes").click();
  await expect(page.locator('output:not([data-variant="danger"])').last()).toBeVisible();
  await expect
    .poll(async () => (await ok(page, `/api/campaigns/${c.id}`)).template_id)
    .toBe(layout.id);

  await page.reload();
  await tab(page, "Content").click();
  await page.locator('button[popovertarget="content-settings"]').click();
  await expect(page.locator('#content-settings select[name="template"]')).toHaveValue(
    String(layout.id),
  );
  await expect(page.locator('button[popovertarget="content-settings"]')).toContainText(layout.name);
  await page.locator('button[popovertarget="content-settings"]').click();
  await tab(page, "Archive").click();
  await expect(page.locator('select[name="archive_template"]')).toHaveValue(String(layout.id));
});

test("an opt-in campaign created from a list reaches the form", async ({ page }) => {
  await login(page);
  const name = unique("Double list");
  await ok(page, "/api/lists", "POST", { name, type: "private", optin: "double" });
  await page.goto(`/admin/lists?query=${name}`);
  const row = page.getByTestId("list-row");
  await openMenu(row);
  await row.getByTestId("btn-send-optin-campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns\/\d+/);
  await expect(page.locator("header .badge.optin")).toHaveText("Opt-in");
  await expect(page.locator('input[name="name"]')).toHaveValue(new RegExp(name));
  await tab(page, "Archive").click();
  await expect(page.getByRole("switch").filter({ visible: true })).toBeDisabled();
});

test("the screen offers what each permission allows", async ({ page, browser }) => {
  await login(page);
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Scoped"),
    type: "private",
    optin: "single",
  });
  const c = await create(page, { lists: [list.id] });
  const reader = await createUser(page, ["campaigns:get_all"]);
  const context = await browser.newContext({ baseURL: process.env.E2E_ORIGIN });
  const other = await context.newPage();
  try {
    await other.setExtraHTTPHeaders({ "X-Forwarded-For": "203.0.113.200" });
    await login(other, reader.username, PASSWORD);
    await other.goto(`${CAMPAIGNS}?query=${c.name}`);
    await expect(rows(other)).toHaveCount(1);
    await openMenu(rows(other));
    await expect(rows(other).getByRole("menuitem", { name: "Preview", exact: true })).toBeVisible();
    for (const hidden of ["Start campaign", "Clone", "Delete"])
      await expect(rows(other).getByRole("menuitem", { name: hidden, exact: true })).toHaveCount(0);
    await other.goto(`${CAMPAIGNS}/${c.id}`);
    await expect(other.locator('input[name="name"]')).toBeDisabled();
    await expect(button(other, "Save changes")).toHaveCount(0);
    await expect(button(other, "Start campaign")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
