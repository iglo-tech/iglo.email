// The sending lifecycle, as the SMTP sink received it (docs/design/13-e2e-coverage.md, E1). Not an
// upstream spec: listmonk's suite does not drive a whole send to the sink. Each test makes its own
// uniquely named lists, subscribers, templates and campaigns through the API, drives the screens a
// user would use, and asserts on the mail the sink holds for its own addresses.
import { expect } from "@playwright/test";
import {
  api,
  audience,
  confirm,
  makeList,
  mailCounts,
  mailFor,
  ok,
  openMenu,
  settledMail,
  signIn,
  test,
  unique,
} from "../helpers.js";

const CAMPAIGNS = "/admin/campaigns";
const FINISH = { timeout: 30_000 };
const rows = (page) => page.locator("tbody tr[data-campaign-id]");
const row = (page, name) =>
  rows(page).filter({ has: page.getByRole("link", { name, exact: true }) });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const sum = (counts) => counts.reduce((total, count) => total + count, 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sending one message at a time, four a second, so a pause, a cancel or a schedule lands while
// mail is still going out. The app's defaults (ten workers at ten a second) finish a 40-reader
// send in under a second. The runner reads these when it picks a campaign up, so they are set
// before each test's campaign starts; `afterEach` puts back what the server had.
const SLOW = { "app.concurrency": 1, "app.message_rate": 4 };
let original = {};

test.beforeEach(async ({ page }) => {
  await signIn(page);
  const settings = await ok(page, "/api/settings");
  original = Object.fromEntries(Object.keys(SLOW).map((key) => [key, settings[key]]));
  for (const [key, value] of Object.entries(SLOW))
    await ok(page, `/api/settings/${key}`, "PUT", value);
});

test.afterEach(async ({ page }) => {
  for (const [key, value] of Object.entries(original))
    await ok(page, `/api/settings/${key}`, "PUT", value);
});

const address = (prefix) => `${unique(prefix)}@example.com`;

async function campaign(page, overrides) {
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Sending"),
    subject: unique("Subject"),
    type: "regular",
    content_type: "plain",
    body: "Sending body",
    ...overrides,
  });
}

const status = async (page, id) => (await ok(page, `/api/campaigns/${id}`)).status;

// Same as the menu helper in campaigns.e2e.js: a closing menu still reads as open, so retry.
async function menu(page, name, action) {
  const item = row(page, name).getByRole("menuitem", { name: action, exact: true });
  await expect(async () => {
    if (!(await item.isVisible())) await openMenu(row(page, name));
    await item.click({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

// Starts a draft from the listing, as a user does, and leaves the listing showing it.
async function startFromListing(page, c) {
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await menu(page, c.name, "Start campaign");
  await confirm(page);
}

// The page's date control is local time at whole seconds, as the browser sees it.
const pad = (n) => String(n).padStart(2, "0");
const localInput = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

test("a campaign started from its page sends one mail to each subscriber, and the listing counts them", async ({
  page,
}) => {
  const { list, emails } = await audience(page, 3);
  const c = await campaign(page, { lists: [list.id] });
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await button(page, "Start campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await expect.poll(() => status(page, c.id), FINISH).toBe("finished");
  expect(await settledMail(emails)).toEqual([1, 1, 1]);
  await page.goto(`${CAMPAIGNS}?query=${c.name}`);
  await expect(row(page, c.name)).toContainText("Finished");
  await expect(row(page, c.name).locator('[data-stat="sent"]')).toHaveText("3");
});

test("a subscriber on two of the campaign's lists receives one mail", async ({ page }) => {
  const [first, second] = [await makeList(page), await makeList(page)];
  const [both, onlyFirst] = [address("both"), address("first")];
  await ok(page, "/api/subscribers", "POST", {
    email: both,
    name: "On Both",
    status: "enabled",
    lists: [first.id, second.id],
  });
  await ok(page, "/api/subscribers", "POST", {
    email: onlyFirst,
    name: "On First",
    status: "enabled",
    lists: [first.id],
  });
  const c = await campaign(page, { lists: [first.id, second.id] });
  await startFromListing(page, c);
  await expect.poll(() => status(page, c.id), FINISH).toBe("finished");
  expect(await settledMail([both, onlyFirst])).toEqual([1, 1]);
});

test("unsubscribed from the list and blocklisted subscribers receive nothing", async ({ page }) => {
  const list = await makeList(page);
  const [reader, left, blocked] = [address("reader"), address("left"), address("blocked")];
  await ok(page, "/api/subscribers", "POST", {
    email: reader,
    name: "Reader",
    status: "enabled",
    lists: [list.id],
  });
  const leaving = await ok(page, "/api/subscribers", "POST", {
    email: left,
    name: "Left",
    status: "enabled",
    lists: [list.id],
  });
  await ok(page, "/api/subscribers/lists", "PUT", {
    ids: [leaving.id],
    action: "unsubscribe",
    target_list_ids: [list.id],
  });
  await ok(page, "/api/subscribers", "POST", {
    email: blocked,
    name: "Blocked",
    status: "blocklisted",
    lists: [list.id],
  });
  const c = await campaign(page, { lists: [list.id] });
  await startFromListing(page, c);
  await expect.poll(() => status(page, c.id), FINISH).toBe("finished");
  expect(await settledMail([reader, left, blocked])).toEqual([1, 0, 0]);
});

test("pause stops mail within the settle window, and resume delivers the rest once each", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { list, emails } = await audience(page, 40);
  const c = await campaign(page, { lists: [list.id] });
  await startFromListing(page, c);
  await expect.poll(async () => sum(await mailCounts(emails)), FINISH).toBeGreaterThanOrEqual(2);
  await menu(page, c.name, "Pause");
  await confirm(page);
  await expect(row(page, c.name)).toHaveClass(/status-paused/);
  const paused = await settledMail(emails);
  expect(sum(paused)).toBeLessThan(40);
  await menu(page, c.name, "Send");
  await confirm(page);
  await expect.poll(() => status(page, c.id), FINISH).toBe("finished");
  expect(await settledMail(emails)).toEqual(emails.map(() => 1));
});

test("cancel stops mail, and nothing arrives after the settle window", async ({ page }) => {
  test.setTimeout(60_000);
  const { list, emails } = await audience(page, 40);
  const c = await campaign(page, { lists: [list.id] });
  await startFromListing(page, c);
  await expect.poll(async () => sum(await mailCounts(emails)), FINISH).toBeGreaterThanOrEqual(2);
  await menu(page, c.name, "Cancel");
  await confirm(page);
  await expect(row(page, c.name)).toHaveClass(/status-cancelled/);
  const atCancel = await settledMail(emails);
  expect(sum(atCancel)).toBeLessThan(40);
  expect(await settledMail(emails, { settle: 2000 })).toEqual(atCancel);
  expect(await status(page, c.id)).toBe("cancelled");
});

test("a scheduled campaign fires within one scan of its send_at", async ({ page }) => {
  test.setTimeout(60_000);
  const { list, emails } = await audience(page, 1);
  const c = await campaign(page, { lists: [list.id] });
  // Whole seconds, a few seconds out. The runner scans for due campaigns every five seconds
  // (src/campaigns/runner/runner.ts, scanInterval), so the first mail must follow within that.
  const at = new Date(Math.ceil((Date.now() + 8000) / 1000) * 1000);
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await page.getByRole("switch", { name: "Send later", exact: true }).check();
  await page.locator('input[name="send_at"]').fill(localInput(at));
  await button(page, "Schedule campaign").click();
  await confirm(page);
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  const scheduled = await ok(page, `/api/campaigns/${c.id}`);
  expect(scheduled).toMatchObject({ status: "scheduled" });
  expect(new Date(scheduled.send_at).getTime()).toBe(at.getTime());
  // Sample every 250 ms until 200 ms before send_at: no mail may appear at any sample.
  while (Date.now() < at.getTime() - 200) {
    expect(await mailCounts(emails)).toEqual([0]);
    await sleep(250);
  }
  expect(await status(page, c.id)).toBe("scheduled");
  await expect.poll(async () => (await mailCounts(emails))[0], FINISH).toBe(1);
  const arrived = Date.now();
  expect(arrived - at.getTime()).toBeLessThan(5000 + 3000);
  await expect.poll(() => status(page, c.id), FINISH).toBe("finished");
});

test("the mail carries the campaign's subject, body and layout, with subscriber fields filled in", async ({
  page,
}) => {
  const list = await makeList(page);
  const reader = address("ada");
  await ok(page, "/api/subscribers", "POST", {
    email: reader,
    name: "Ada Layout",
    status: "enabled",
    lists: [list.id],
    attribs: { city: "Krakow" },
  });
  const layout = await ok(page, "/api/templates", "POST", {
    name: unique("Layout"),
    type: "campaign",
    body: '<div class="e2e-layout"><h2>Layout head</h2>{{ content | raw }}<p>Layout foot</p></div>',
  });
  const subject = unique("Layout subject");
  const c = await campaign(page, {
    lists: [list.id],
    template_id: layout.id,
    subject: `${subject} for {{ subscriber.name }}`,
    content_type: "html",
    body: "<p>Hello {{ subscriber.name }} from {{ subscriber.attribs.city }}</p>",
  });
  await startFromListing(page, c);
  const [mail] = await mailFor(reader);
  expect(mail.subject).toBe(`${subject} for Ada Layout`);
  expect(mail.body).toContain('class="e2e-layout"');
  expect(mail.body).toContain("Layout head");
  expect(mail.body).toContain("Hello Ada Layout from Krakow");
  expect(mail.body).toContain("Layout foot");
  expect(mail.body).not.toContain("{{");
});

test("POST /api/tx delivers its template with the attachment intact, and refuses an unknown template", async ({
  page,
}) => {
  const [receipt, refused] = [address("receipt"), address("refused")];
  const subject = unique("Receipt");
  const template = await ok(page, "/api/templates", "POST", {
    name: unique("Tx"),
    type: "tx",
    subject,
    body: "<p>Thanks for the order.</p>",
  });
  // 3000 bytes encode to base64 with no padding, which the mail reader in helpers.js would mangle.
  const bytes = Buffer.alloc(3000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 255;
  const sent = await page.evaluate(
    async ([data, base64]) => {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice(5) ?? "";
      const form = new FormData();
      form.set("data", data);
      const file = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      form.append("file", new File([file], "report.bin", { type: "application/octet-stream" }));
      const response = await fetch("/api/tx", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: form,
      });
      return { status: response.status, body: await response.text() };
    },
    [
      JSON.stringify({ subscriber_emails: [receipt], template_id: template.id }),
      bytes.toString("base64"),
    ],
  );
  expect(sent.status, sent.body).toBe(200);
  const [mail] = await mailFor(receipt);
  expect(mail.subject).toBe(subject);
  expect(mail.body).toContain("Thanks for the order.");
  expect(mail.body).toContain("report.bin");
  expect(mail.body.replace(/\s+/g, "")).toContain(bytes.toString("base64"));

  const missing = await api(page, "/api/tx", "POST", {
    subscriber_emails: [refused],
    template_id: 987654321,
  });
  expect(missing.status).toBe(400);
  expect(JSON.stringify(missing.body)).toContain("template");
  expect(await settledMail([refused])).toEqual([0]);
});

test("the test-send button delivers to the given address only", async ({ page }) => {
  const { list, emails } = await audience(page, 2);
  const c = await campaign(page, { lists: [list.id], body: "Test body" });
  await page.goto(`${CAMPAIGNS}/${c.id}`);
  await button(page.locator(".page-header"), "Send test message").click();
  await page.locator('#campaign-test input[type="email"]').fill(emails[0]);
  await page.locator('#campaign-test input[type="email"]').press("Enter");
  await button(page.locator("#campaign-test"), "Send").click();
  const [mail] = await mailFor(emails[0]);
  expect(mail.body).toContain("Test body");
  expect(await settledMail(emails)).toEqual([1, 0]);
  expect(await ok(page, `/api/campaigns/${c.id}`)).toMatchObject({ status: "draft", sent: 0 });
});
