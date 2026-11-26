// Adapted from listmonk tests/specs/settings.spec.js at 6fcd95f. The run shares one database, so
// each test restores what it changed. A save needs no restart here (D44), so there is no health
// wait; messengers, bounce mailboxes and the other bounce providers have no admin control (D44, D89, 07-api-and-ui.md);
// the root URL belongs to the bootstrap flags. API-only cases live in `bun run contract:settings`.
// B139 (D154): the instance keys (SMTP, pacing, proxies, the session duration, bounce processing, the
// private-target block, the admin appearance and the inert keys) are on the instance Settings page,
// which the same script drives against /api/instance/settings; the project's page keeps the rest.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { startInstance } from "../instance.js";
import {
  ADMIN,
  ORIGIN,
  api,
  createUser,
  login,
  mailFor,
  signInInstance,
  test,
  unique,
} from "../helpers.js";

const SETTINGS = "/admin/settings";
const INSTANCE = "/admin/instance/settings";
// A save from either page: the project's keys or the instance's.
const saved = (r) =>
  ["/api/settings", "/api/instance/settings"].includes(new URL(r.url()).pathname) &&
  r.request().method() === "PUT";
const sentPut = (r) =>
  ["/api/settings", "/api/instance/settings"].includes(new URL(r.url()).pathname) &&
  r.method() === "PUT";

/** The instance Settings page, with the admin's instance session. */
async function onInstance(page) {
  await signInInstance(page);
  await page.goto(INSTANCE);
  await expect(page.getByTestId("settings-instance")).toBeVisible();
}
const smtpServers = (page) => page.locator(".mail-servers details");
const tab = (page, name) => page.getByRole("tab", { name, exact: true });

// The page saves an accordion's open state from its async `toggle` event, which can run after a
// click resolves. A reload that lands first discards the change, so wait for the saved value.
async function expectStoredOpen(page, index, open) {
  await expect
    .poll(() =>
      page.evaluate(
        (n) => JSON.parse(localStorage.getItem("settings.openBoxes") || "{}").smtp?.[n],
        index,
      ),
    )
    .toBe(open);
}

async function settings(page) {
  const res = await api(page, "/api/settings");
  expect(res.status).toBe(200);
  return res.body.data;
}

// Saving applies at once; the button comes back when the request is done. Oat stacks the toasts while
// the page is not hovered, so only the newest one shows its text. Clearing the toasts first makes the
// save's own toast the only one `getByText` can match.
async function save(page, status = 200) {
  await page.evaluate(() => window.ot.toast.clear());
  const response = page.waitForResponse(saved);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(status);
  if (status === 200) {
    await expect(page.getByText('"Settings" updated').first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
}

// The same save without the toast check: an upload's own toast can hide the save's before it is read.
async function saveQuietly(page) {
  const response = page.waitForResponse(saved);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
}

async function remove(page, item, accept = true) {
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: accept ? "Ok" : "Cancel", exact: true })
    .click();
}

let before;
test.beforeEach(async ({ page }) => {
  await login(page, ADMIN.user, ADMIN.password, SETTINGS);
  before = await settings(page);
});
// The next spec needs the sink and the trusted proxy: put back each key this test changed.
test.afterEach(async ({ page }) => {
  await page.goto("/admin");
  const now = await settings(page);
  for (const [key, value] of Object.entries(before)) {
    if (key === "app.root_url" || JSON.stringify(now[key]) === JSON.stringify(value)) {
      continue;
    }
    const res = await api(page, `/api/settings/${key}`, "PUT", value);
    expect(res.status, key).toBe(200);
  }
});

test("validates sender defaults and offers the configured senders to a campaign", async ({
  page,
}) => {
  const first = "Default <default@example.com>";
  const second = "News <news@example.com>";
  const templated = "{{ .Subscriber.Attribs.sender }}";
  const current = await settings(page);
  const longSender = `${"a".repeat(2000)} <sender@example.com>`;
  for (const addresses of [
    null,
    [],
    [" "],
    ["invalid"],
    ["{{ .Subscriber.Email }}"],
    [" ", "{{ .Subscriber.Email }}"],
    ["{{ .Subscriber.Name }} <sender@example.com>"],
    [first, "invalid"],
    [longSender],
    [first, `${templated}${longSender}`],
    Array(251).fill(first),
  ]) {
    const res = await api(page, "/api/settings/app.from_email", "PUT", addresses);
    expect(res.status).toBe(400);
  }
  expect((await settings(page))["app.from_email"]).toEqual(current["app.from_email"]);

  await page
    .locator('[name="app.from_email"]')
    .fill(`\n ${first} \n${second}\n${first}\n${templated}\n`);
  await save(page);
  expect((await settings(page))["app.from_email"]).toEqual([first, second, templated]);
  await page.reload();
  await expect(page.locator('[name="app.from_email"]')).toHaveValue(
    `${first}\n${second}\n${templated}`,
  );

  // A refusal from the API shows, and nothing is stored.
  await page.locator('[name="app.from_email"]').fill("invalid");
  await save(page, 400);
  await expect(page.getByText("invalid from email address: invalid")).toBeVisible();

  await page.goto("/admin/campaigns/new");
  const input = page.locator('input[name="from_email"]');
  await expect(input).toHaveValue(first);
  const options = page.locator("#campaign-from-emails option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(2)).toHaveAttribute("value", templated);
});

// B117f (D136 item 1): the notification field holds one address per top-level comma, so a comma inside a quoted
// display name stays in its address. The form splits the field before it saves; the API keeps an array.
test("saves notification addresses whose display name holds a comma, one entry per address", async ({
  page,
}) => {
  const named = '"Ops, Team" <ops@example.test>';
  const other = "other@example.test";
  const field = page.locator('[name="app.notify_emails"]');
  await field.fill(`${named}, ${other}`);
  await save(page);
  expect((await settings(page))["app.notify_emails"]).toEqual([named, other]);
  await page.reload();
  await expect(field).toHaveValue(`${named}, ${other}`);

  // A save with nothing changed sends the same two entries back.
  await save(page);
  expect((await settings(page))["app.notify_emails"]).toEqual([named, other]);

  // An escaped quote inside the display name does not end it, so the comma after it is still inside.
  const escaped = String.raw`"A \"B, C\"" <a@example.test>`;
  await field.fill(`${escaped}, b@example.test`);
  await save(page);
  expect((await settings(page))["app.notify_emails"]).toEqual([escaped, "b@example.test"]);
});

test("saves edits across tabs, enables SMTP and deletes a server", async ({ page }) => {
  const favicon = `${ORIGIN}/public/static/logo.png`;
  // Deliberate difference: the root URL is a bootstrap flag (D44), shown read-only.
  const root = page.locator('[name="app.root_url"]');
  await expect(root).toHaveJSProperty("readOnly", true);
  await expect(page.getByText("Changing it needs a restart.")).toBeVisible();
  await page.locator('[name="app.favicon_url"]').fill(favicon);
  await save(page);
  // B139: the send rate and SMTP keys are on the instance page, which the project page links to.
  await expect(page.getByTestId("instance-settings-link")).toHaveAttribute(
    "href",
    `${ORIGIN}${INSTANCE}`,
  );
  await onInstance(page);
  await tab(page, "Performance").click();
  await page.locator('[name="messaging.max_send_rate"]').fill("15");
  await tab(page, "SMTP").click();
  await page.getByRole("button", { name: "Add new" }).click();
  const servers = smtpServers(page);
  const added = servers.nth(1);
  await added.getByPlaceholder("smtp.yourmailserver.net").fill("localhost");
  await added.getByRole("spinbutton", { name: /^Port/ }).fill("1025");
  await added
    .getByRole("group", { name: "TLS", exact: true })
    .getByRole("combobox")
    .selectOption("none");
  await added.getByRole("switch", { name: "Enabled", exact: true }).uncheck();
  await expect(added.getByPlaceholder("smtp.yourmailserver.net")).toBeDisabled();
  await expect(added.getByRole("button", { name: "Test connection" })).toBeDisabled();
  await added.getByRole("switch", { name: "Enabled", exact: true }).check();
  await remove(page, servers.first(), false);
  await expect(servers).toHaveCount(2);
  await remove(page, servers.first());
  await expect(servers).toHaveCount(1);
  await expect(servers.getByRole("button", { name: "Delete" })).toBeHidden();
  await save(page);
  expect(await settings(page)).toMatchObject({
    "app.root_url": before["app.root_url"],
    "app.favicon_url": favicon,
    "messaging.max_send_rate": 15,
    smtp: [{ enabled: true, host: "localhost", port: 1025, tls_type: "none" }],
  });
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(servers.getByRole("switch", { name: "Enabled", exact: true })).toBeChecked();
  await tab(page, "Performance").click();
  await expect(page.locator('[name="messaging.max_send_rate"]')).toHaveValue("15");
  await page.goto(SETTINGS);
  await tab(page, "General").click();
  await expect(page.locator('[name="app.favicon_url"]')).toHaveValue(favicon);
});

test("a logo or favicon path the API accepts saves, from any tab", async ({ page }) => {
  // The API stores these as given; an input pattern would hold back a save from another tab.
  const res = await api(page, "/api/settings/app.logo_url", "PUT", "/uploads/logo.png");
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "Performance").click();
  await page.locator('[name="app.max_send_errors"]').fill("8");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "app.logo_url": "/uploads/logo.png",
    "app.max_send_errors": 8,
  });
});

// A 1x1 PNG: the media upload accepts it, and the settings take its URL.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("uploads a logo and a favicon to media, saves their URLs, replaces and removes them", async ({
  page,
}) => {
  await tab(page, "General").click();
  for (const key of ["app.logo_url", "app.favicon_url"]) {
    const input = page.locator(`input[type="file"][name="${key}.upload"]`);
    const [upload] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/media") && r.request().method() === "POST",
      ),
      input.setInputFiles({ name: `${unique("brand")}.png`, mimeType: "image/png", buffer: PIXEL }),
    ]);
    expect(upload.status()).toBe(200);
    const url = (await upload.json()).data.url;
    expect(url).toBeTruthy();
    await expect(page.locator(`[name="${key}"]`)).toHaveValue(url);
    await saveQuietly(page);
    expect((await settings(page))[key]).toBe(url);

    // Replacing the image sets a new URL; Remove empties the field, and Save stores that.
    const [again] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/api/media") && r.request().method() === "POST",
      ),
      input.setInputFiles({ name: `${unique("brand")}.png`, mimeType: "image/png", buffer: PIXEL }),
    ]);
    expect(again.status()).toBe(200);
    const replaced = (await again.json()).data.url;
    expect(replaced).not.toBe(url);
    await expect(page.locator(`[name="${key}"]`)).toHaveValue(replaced);
    await input.locator("xpath=..").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.locator(`[name="${key}"]`)).toHaveValue("");
    await saveQuietly(page);
    expect((await settings(page))[key]).toBe("");
  }
});

test("searches across tabs using all terms", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search" });
  await expect(page.locator('[name="app.from_email"]')).toBeVisible();
  await search.fill("sender address");
  await expect(page.locator('[name="app.from_email"]')).toBeVisible();
  await search.fill("no-such-setting");
  await expect(tab(page, "Privacy")).toBeVisible();
  // B139: the instance page searches its own tabs the same way.
  await onInstance(page);
  await search.fill("  RATE   speed  ");
  await expect(page.locator('[name="messaging.max_send_rate"]')).toBeVisible();
  await expect(tab(page, "Security")).toBeHidden();
  await expect(tab(page, "Performance")).toBeVisible();
  await search.fill("outgoing");
  await expect(tab(page, "SMTP")).toBeVisible();
  await tab(page, "SMTP").click();
  await expect(search).toBeEmpty();
  await expect(smtpServers(page)).toBeVisible();
  await search.fill("no-such-setting");
  await expect(tab(page, "Performance")).toBeVisible();
  await expect(smtpServers(page)).toBeVisible();
  await search.fill("throughput");
  await search.fill("");
  await expect(smtpServers(page)).toBeVisible();
  await expect(page.locator('[name="messaging.max_send_rate"]')).toBeHidden();
});

test("SMTP presets reset credentials and preserve unrelated fields and accordion state", async ({
  page,
}) => {
  await onInstance(page);
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();
  await expect(server.getByPlaceholder("email-primary")).toBeVisible();
  await expectStoredOpen(page, 0, true);
  await server.getByPlaceholder("email-primary").fill("email-primary");
  const auth = server.getByRole("group", { name: "Auth protocol", exact: true });
  await auth.getByRole("combobox").selectOption("login");
  await server.getByRole("textbox", { name: /^Username/ }).fill("old-user");
  await server.getByLabel(/Password/).fill("old-secret");
  for (const [provider, host, port, protocol, tls] of [
    ["Gmail", "smtp.gmail.com", "465", "login", "TLS"],
    ["Postmark", "smtp.postmarkapp.com", "587", "cram", "STARTTLS"],
  ]) {
    await server.getByRole("link", { name: provider, exact: true }).click();
    await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toHaveValue(host);
    await expect(server.getByRole("spinbutton", { name: /^Port/ })).toHaveValue(port);
    await expect(auth.getByRole("combobox")).toHaveValue(protocol);
    await expect(
      server.getByRole("group", { name: "TLS", exact: true }).getByRole("combobox"),
    ).toHaveValue(tls);
    await expect(server.getByRole("textbox", { name: /^Username/ })).toBeFocused();
    await expect(server.getByRole("textbox", { name: /^Username/ })).toBeEmpty();
    await expect(server.getByLabel(/Password/)).toBeEmpty();
    await expect(server.getByPlaceholder("email-primary")).toHaveValue("email-primary");
  }
  await auth.getByRole("combobox").selectOption("none");
  await expect(server.getByRole("textbox", { name: /^Username/ })).toBeDisabled();
  await expect(server.getByLabel(/Password/)).toBeDisabled();
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toBeVisible();
  await server.locator("summary").click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toBeHidden();
  await expectStoredOpen(page, 0, false);
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toBeHidden();
});

test("a provider template on a saved server asks for its password before a save", async ({
  page,
}) => {
  await onInstance(page);
  const seeded = await settings(page);
  const res = await api(page, "/api/settings/smtp", "PUT", [
    {
      ...seeded.smtp[0],
      host: "old-host.example.test",
      port: 587,
      auth_protocol: "login",
      username: "old-user",
      password: "stored-smtp-secret",
      enabled: true,
    },
  ]);
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toHaveValue(
    "old-host.example.test",
  );
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);

  await server.getByRole("link", { name: "Gmail", exact: true }).click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toHaveValue("smtp.gmail.com");
  await expect(server.getByLabel(/Password/)).toBeEmpty();

  // The save is refused on the page: nothing is sent, so the old password goes nowhere.
  const sent = [];
  page.on("request", (r) => {
    if (sentPut(r)) {
      sent.push(r);
    }
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Enter the password again/)).toBeVisible();
  expect(sent).toHaveLength(0);
  expect((await settings(page)).smtp[0].host).toBe("old-host.example.test");

  await server.getByLabel(/Password/).fill("gmail-new-secret");
  await save(page);
  const stored = (await settings(page)).smtp[0];
  expect(stored.host).toBe("smtp.gmail.com");
  expect(stored.password).toBe("•".repeat("gmail-new-secret".length));
});

test("a provider template on a saved server with auth none saves without a password", async ({
  page,
}) => {
  await onInstance(page);
  const seeded = await settings(page);
  const res = await api(page, "/api/settings/smtp", "PUT", [
    {
      ...seeded.smtp[0],
      host: "old-host.example.test",
      port: 587,
      auth_protocol: "login",
      username: "old-user",
      password: "stored-smtp-secret",
      enabled: true,
    },
  ]);
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();

  await server.getByRole("link", { name: "Gmail Relay", exact: true }).click();
  await server
    .getByRole("group", { name: "Auth protocol", exact: true })
    .getByRole("combobox")
    .selectOption("none");
  await expect(server.getByLabel(/Password/)).toBeDisabled();

  // Auth none sends no password, so the save needs none re-entered.
  await save(page);
  const stored = (await settings(page)).smtp[0];
  expect(stored.host).toBe("smtp-relay.gmail.com");
  expect(stored.auth_protocol).toBe("none");
});

test("a new server from a provider template saves without a password", async ({ page }) => {
  await onInstance(page);
  await tab(page, "SMTP").click();
  await page.getByRole("button", { name: "Add new", exact: true }).click();
  // A new server has no saved password to protect, so the template asks for none.
  const added = smtpServers(page).last();
  await added.getByRole("link", { name: "Gmail", exact: true }).click();
  await expect(added.getByPlaceholder("smtp.yourmailserver.net")).toHaveValue("smtp.gmail.com");
  await added.getByRole("textbox", { name: /^Username/ }).fill("new-user");

  await save(page);
  const stored = (await settings(page)).smtp.at(-1);
  expect(stored.host).toBe("smtp.gmail.com");
  expect(stored.username).toBe("new-user");
  // The API omits an empty password, so an absent or blank value both mean none is stored.
  expect(stored.password ?? "").toBe("");
});

test("a disabled SMTP server takes a password typed while it is off", async ({ page }) => {
  await onInstance(page);
  const seeded = await settings(page);
  const res = await api(page, "/api/settings/smtp", "PUT", [
    { ...seeded.smtp[0], password: "" },
    { ...seeded.smtp[1], enabled: false, auth_protocol: "login", password: "" },
  ]);
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "SMTP").click();
  const server = smtpServers(page).nth(1);
  await server.locator("summary").click();
  await expect(server.getByRole("switch", { name: /Enabled/ })).not.toBeChecked();

  const password = server.getByLabel(/Password/);
  await expect(password).toBeEnabled();
  await password.fill("disabled-typed-secret");
  await save(page);
  const stored = (await settings(page)).smtp[1];
  expect(stored.enabled).toBe(false);
  expect(stored.password).toBe("•".repeat("disabled-typed-secret".length));
});

test("the settings page never sends two servers with one uuid", async ({ page }) => {
  await onInstance(page);
  // A row saved before the duplicate refusal can hold two items with one uuid. The GET below
  // stands in for such a stored state; the API now refuses to store it again.
  const stored = (await settings(page)).smtp.length;
  await page.route("**/api/instance/settings", async (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }
    const response = await route.fetch();
    const body = await response.json();
    body.data.smtp.push({
      ...body.data.smtp[0],
      name: "",
      host: "twin.example.test",
      enabled: false,
      password: "•".repeat(8),
    });
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(smtpServers(page)).toHaveCount(stored + 1);

  const sent = page.waitForRequest(sentPut);
  await save(page);
  const body = (await sent).postDataJSON();
  await page.unroute("**/api/instance/settings");
  const uuids = body.smtp.map((item) => item.uuid).filter(Boolean);
  expect(body.smtp).toHaveLength(stored + 1);
  expect(new Set(uuids).size).toBe(uuids.length);
  expect((await settings(page)).smtp).toHaveLength(stored + 1);
});

test("tests custom SMTP headers and masks saved secrets", async ({ page }) => {
  await onInstance(page);
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();
  await server
    .getByRole("group", { name: "Auth protocol", exact: true })
    .getByRole("combobox")
    .selectOption("login");
  await server.getByRole("textbox", { name: /^Username/ }).fill("test-user");
  await server.getByLabel(/Password/).fill("settings-test-secret");
  await server.getByRole("link", { name: "Set custom headers" }).click();
  const headers = server.getByPlaceholder('[{"X-Custom": "value"}]');
  await headers.fill('[{"X-Settings-Test":"saved"}]');
  await save(page);
  // The form is read again after a save, so what was typed is masked straight away.
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);
  expect(JSON.parse(await headers.inputValue())).toEqual([{ "X-Settings-Test": "saved" }]);
  await server.getByLabel(/Password/).fill("••partial");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Clear and re-enter the full password/)).toBeVisible();
  await server.getByLabel(/Password/).fill("replacement-secret");
  await save(page);
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);
  // An unrelated save sends no replacement for the masked password.
  const request = page.waitForRequest(sentPut);
  await save(page);
  expect((await request).postDataJSON().smtp[0].password).toBe("");
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);
});

test("test connection uses the form's values and saves nothing", async ({ page }) => {
  await onInstance(page);
  const stored = (await settings(page)).smtp;
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();
  await server.getByRole("button", { name: "Test connection" }).click();
  const to = `${unique("smtp-test")}@example.test`;
  await server.getByPlaceholder("email@site.com").fill(to);
  // Nothing listens on this port, so a refused test proves the unsaved form value was used.
  const port = server.getByRole("spinbutton", { name: /^Port/ });
  const working = await port.inputValue();
  await port.fill("1");
  await server.getByRole("button", { name: "Send e-mail" }).click();
  await expect(server.locator("textarea[readonly]")).toHaveValue(/SMTP test/);
  expect((await settings(page)).smtp).toEqual(stored);
  await port.fill(working);
  await server.getByRole("button", { name: "Send e-mail" }).click();
  expect(await mailFor(to)).toHaveLength(1);
  expect((await settings(page)).smtp).toEqual(stored);
});

test("normalizes domain lists and retains tracking preferences while disabled", async ({
  page,
}) => {
  await tab(page, "Privacy").click();
  const individual = page.getByRole("switch", { name: /^Individual subscriber tracking/ });
  await individual.check();
  await page.getByRole("switch", { name: /^Disable tracking/ }).check();
  await expect(individual).toBeDisabled();
  await expect(individual).toBeChecked();
  const domainText = page.locator("textarea:visible");
  await domainText.fill("  EXAMPLE.COM  \n\n spam.test\n  ");
  await expect(page.getByRole("tab", { name: /Domain blocklist \(\s*2\s*\)/ })).toBeVisible();
  await page.getByRole("tab", { name: /^Domain allowlist/ }).click();
  await domainText.fill(" TRUSTED.TEST \n\n");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "privacy.domain_blocklist": ["example.com", "spam.test"],
    "privacy.domain_allowlist": ["trusted.test"],
    "privacy.disable_tracking": true,
    "privacy.individual_tracking": true,
  });
  await page.reload();
  await tab(page, "Privacy").click();
  await expect(domainText).toHaveValue("example.com\nspam.test");
  await page.getByRole("switch", { name: /^Disable tracking/ }).uncheck();
  await expect(individual).toBeEnabled();
  await expect(individual).toBeChecked();
});

test("persists trusted URLs and the native security settings", async ({ page }) => {
  await tab(page, "Security").click();
  const urls = page.getByPlaceholder("https://example.com", { exact: true });
  await urls.fill("https://one.example.com\nhttps://two.example.com/thanks");
  await page.getByRole("spinbutton", { name: "Subscribe", exact: true }).fill("31");
  await save(page);
  // B139: the proxies and the private-target block are instance keys, on the instance page.
  await onInstance(page);
  await tab(page, "Security").click();
  const proxies = page.locator('[name="security.trusted_proxies"]');
  await proxies.fill(`${(await proxies.inputValue()).trim()}\n10.0.0.0/8`);
  await page.getByRole("switch", { name: /^Block private webhook addresses/ }).check();
  await save(page);
  expect(await settings(page)).toMatchObject({
    "security.trusted_urls": ["https://one.example.com", "https://two.example.com/thanks"],
    "security.trusted_proxies": ["127.0.0.1", "10.0.0.0/8"],
    "security.public_rate_limit": { ...before["security.public_rate_limit"], subscribe: 31 },
    "webhooks.block_private_addresses": true,
  });
  await proxies.fill("0.0.0.0/0");
  await save(page, 400);
  await expect(page.getByText(/invalid trusted proxy/)).toBeVisible();
  await proxies.fill("127.0.0.1");
  await save(page);
  await page.goto(SETTINGS);
  await tab(page, "Security").click();
  await expect(urls).toHaveValue("https://one.example.com\nhttps://two.example.com/thanks");
  await urls.fill("");
  await save(page);
  await page.reload();
  await tab(page, "Security").click();
  await expect(urls).toBeEmpty();
});

test("the CAPTCHA card turns one provider on at a time and keeps the secret masked", async ({
  page,
}) => {
  await tab(page, "Security").click();
  const card = page.locator('fieldset[data-keywords^="captcha"]');
  await expect(card).toBeEnabled();
  await card.getByRole("switch", { name: /^Enable/ }).check();
  await expect(card.getByRole("radio", { name: "ALTCHA" })).toBeChecked();
  await card.getByRole("spinbutton", { name: /^Altcha Complexity/ }).fill("5000");
  await save(page);
  expect((await settings(page))["security.captcha"]).toEqual({
    altcha: { enabled: true, complexity: 5000 },
    hcaptcha: { ...before["security.captcha"].hcaptcha, enabled: false },
  });
  // A reload between saves, so each save's toast is the only one.
  await page.reload();
  await tab(page, "Security").click();
  await expect(card.getByRole("radio", { name: "ALTCHA" })).toBeChecked();
  await card.getByRole("radio", { name: /^hCaptcha/ }).check();
  await card.getByRole("textbox", { name: /^hCaptcha.com SiteKey/ }).fill("site-key");
  await card.getByLabel("hCaptcha.com secret").fill("hc-secret");
  await save(page);
  const stored = (await settings(page))["security.captcha"];
  expect(stored).toEqual({
    altcha: { enabled: false, complexity: 5000 },
    hcaptcha: { enabled: true, key: "site-key", secret: "•".repeat(9) },
  });
  await page.reload();
  await tab(page, "Security").click();
  await expect(card.getByRole("radio", { name: /^hCaptcha/ })).toBeChecked();
  await expect(card.getByLabel("hCaptcha.com secret")).toHaveValue("•".repeat(9));
  // A save without touching it keeps the stored secret; the public form uses the key.
  await save(page);
  // Fetched, not opened: a browser would load hCaptcha's script, and tests never reach hCaptcha.
  await api(page, "/api/lists", "POST", {
    name: unique("captcha"),
    type: "public",
    optin: "single",
  });
  const form = await page.request.get("/subscription/form");
  expect(await form.text()).toContain('<div class="h-captcha" data-sitekey="site-key"></div>');
  await page.reload();
  await tab(page, "Security").click();
  await card.getByRole("switch", { name: /^Enable/ }).uncheck();
  await save(page);
  const off = (await settings(page))["security.captcha"];
  expect([off.altcha.enabled, off.hcaptcha.enabled, off.hcaptcha.secret]).toEqual([
    false,
    false,
    "•".repeat(9),
  ]);
});

test("persists bounce actions and SES settings; only SES is shown", async ({ page }) => {
  // B139: the actions are this project's; bounce processing and SES are the instance's.
  await tab(page, "Bounces").click();
  const hard = page.getByRole("group", { name: "Hard", exact: true });
  await hard.getByRole("spinbutton").fill("3");
  await hard.getByRole("combobox").selectOption("unsubscribe");
  await save(page);
  await onInstance(page);
  await tab(page, "Bounces").click();
  await page.getByRole("switch", { name: "Enable bounce processing", exact: true }).check();
  const webhooks = page.getByRole("switch", { name: /^Enable bounce webhooks/ });
  await webhooks.check();
  const ses = page.getByRole("group", { name: /SES/ });
  await ses.getByRole("switch").check();
  await ses.getByLabel(/Allowed SNS topic ARNs/).fill("arn:aws:sns:*:123456789012:*");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "bounce.enabled": true,
    "bounce.ses_enabled": true,
    "bounce.ses_topic_arns": ["arn:aws:sns:*:123456789012:*"],
    "bounce.webhooks_enabled": true,
    "bounce.actions": { hard: { count: 3, action: "unsubscribe" } },
  });
  await page.reload();
  await tab(page, "Bounces").click();
  await expect(ses.getByRole("switch")).toBeChecked();
  await expect(page.getByRole("group", { name: "Enable Mailgun", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Other bounce providers", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Enable bounce mailbox" })).toHaveCount(0);
  await webhooks.uncheck();
  await expect(ses).toHaveCount(0);
  await page.goto(SETTINGS);
  await tab(page, "Bounces").click();
  await expect(hard.getByRole("spinbutton")).toHaveValue("3");
  await expect(hard.getByRole("combobox")).toHaveValue("unsubscribe");
});

// A bounce appears on the bounces screen and its metadata dialog renders escaped.
test("a bounce appears on the bounces screen like any other", async ({ page }) => {
  await api(page, "/api/settings", "PUT", {
    ...before,
    "bounce.enabled": true,
    "bounce.webhooks_enabled": true,
  });
  const list = await api(page, "/api/lists", "POST", { name: unique("mailgun"), type: "private" });
  const email = `${unique("mailgun")}@example.com`;
  const sub = await api(page, "/api/subscribers", "POST", {
    email,
    name: email,
    status: "enabled",
    lists: [list.body.data.id],
  });
  expect(sub.status).toBe(200);
  const message = `<img src=x onerror="window.pwned=1"> ${unique("delivery")}`;
  const posted = await api(page, "/webhooks/bounce", "POST", {
    email,
    type: "hard",
    source: "mailgun",
    meta: { message },
  });
  expect(posted.status).toBe(200);
  await page.goto("/admin/subscribers/bounces?source=mailgun");
  const row = page.getByTestId("bounce-row").filter({ hasText: email });
  await expect(row).toContainText("mailgun");
  await row.getByRole("button", { name: "More" }).click();
  await row.getByTestId("btn-meta").click();
  await expect(page.locator("dialog[open] pre")).toContainText("onerror");
  await expect(page.locator("dialog[open] img")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test("saves independent admin and public appearance editors", async ({ page }) => {
  // B139: the public editors are this project's; the admin editors are the instance's.
  await tab(page, "Appearance").click();
  // The warning names the admin pages, whose code is the instance's.
  await expect(page.getByTestId("appearance-warning")).toHaveCount(0);
  const css = page.getByRole("group", { name: "Custom CSS", exact: true }).getByRole("textbox");
  const js = page
    .getByRole("group", { name: "Custom JavaScript", exact: true })
    .getByRole("textbox");
  await css.fill("/* public settings test */");
  await js.fill("window.publicCustom = 1;");
  await save(page);
  await onInstance(page);
  await tab(page, "Appearance").click();
  await expect(page.getByTestId("appearance-warning")).toContainText("every signed-in admin page");
  await css.fill("/* admin settings test */");
  await js.fill("window.adminCustom = 1;");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "appearance.admin.custom_css": "/* admin settings test */",
    "appearance.admin.custom_js": "window.adminCustom = 1;",
    "appearance.public.custom_css": "/* public settings test */",
    "appearance.public.custom_js": "window.publicCustom = 1;",
  });
  await page.reload();
  await tab(page, "Appearance").click();
  await expect(css).toHaveText("/* admin settings test */");
  await expect(js).toHaveText("window.adminCustom = 1;");
  await page.goto(SETTINGS);
  await tab(page, "Appearance").click();
  await expect(css).toHaveText("/* public settings test */");
  await expect(js).toHaveText("window.publicCustom = 1;");

  // Each runs where it is meant to, and nowhere else.
  await page.goto("/admin/lists");
  await expect.poll(() => page.evaluate(() => window.adminCustom)).toBe(1);
  expect(await page.evaluate(() => window.publicCustom)).toBeUndefined();
  await page.goto("/subscription/form");
  await expect.poll(() => page.evaluate(() => window.publicCustom)).toBe(1);
  expect(await page.evaluate(() => window.adminCustom)).toBeUndefined();
  await page.goto("/admin/nothing-here");
  const signedOut = await page.context().browser().newContext();
  const stranger = await signedOut.newPage();
  await stranger.goto(`${ORIGIN}/admin/forgot`);
  expect(await stranger.evaluate(() => window.adminCustom)).toBeUndefined();
  const custom = await stranger.goto(`${ORIGIN}/admin/custom.js`);
  expect(new URL(custom.url()).pathname).toBe("/admin/login");
  await signedOut.close();
});

test("a save without edits leaves unshown values and untouched secrets alone", async ({ page }) => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const put = async (key, value) => {
    const res = await api(page, `/api/settings/${key}`, "PUT", value);
    expect(res.status, key).toBe(200);
  };
  const seeded = await settings(page);
  await put("smtp", [
    {
      ...seeded.smtp[0],
      password: "smtp-secret",
      max_msg_retries: 7,
      msg_retry_delay: "3s",
      dkim: { domain_name: "example.test", key_selector: "s1", private_key: privateKey },
    },
  ]);
  await put("app.lang", "de");
  await put("upload.s3.bucket", "e2e-bucket");
  await put("messengers", [
    { name: "postback", root_url: "http://messenger.test", enabled: false, password: "m-secret" },
  ]);
  await put("privacy.exportable", ["profile"]);
  await put("upload.s3.aws_secret_access_key", "s3-secret");
  await put("upload.s3.bucket_domain", "bucket.example.test");
  await put("bounce.sendgrid_key", "sendgrid-secret");
  await put("bounce.azure", { enabled: false, shared_secret: "azure", shared_secret_header: "X" });
  await put("bounce.postmark", { enabled: false, username: "u", password: "postmark-secret" });
  await put("bounce.forwardemail", { enabled: false, key: "fe-secret" });
  await put("bounce.lettermint", { enabled: false, key: "lm-secret" });
  await put("security.captcha", {
    altcha: { enabled: false, complexity: 123_456 },
    hcaptcha: { enabled: false, key: "site", secret: "hc-secret" },
  });
  await put("security.oidc", {
    ...seeded["security.oidc"],
    provider_url: "https://id.example.test",
    client_id: "client",
    client_secret: "oidc-secret",
    roles: [{ claim: "groups", match: "editors" }],
  });
  await put("maintenance.db", { vacuum: true, vacuum_cron_interval: "0 4 * * *" });
  try {
    const stored = await settings(page);
    // B139: each page saves its own side, and together they send back every key.
    await page.reload();
    await expect(page.locator('[name="app.from_email"]')).toBeVisible();
    const request = page.waitForRequest(sentPut);
    await save(page);
    const project = (await request).postDataJSON();
    await onInstance(page);
    const instanceRequest = page.waitForRequest(sentPut);
    await save(page);
    const shared = (await instanceRequest).postDataJSON();
    expect(await settings(page)).toEqual(stored);
    // Every secret goes back empty, which the API reads as "keep": a bullet never reaches storage.
    for (const sent of [project, shared]) {
      expect(JSON.stringify(sent)).not.toContain("•");
    }
    expect(shared.smtp[0].dkim.private_key).toBe("");
    expect(shared.smtp[0].uuid).toBe(stored.smtp[0].uuid);
    expect(shared["security.oidc"].client_secret).toBe("");
    expect(project["privacy.exportable"]).toEqual(["profile"]);
    expect(Object.keys(project).some((key) => Object.hasOwn(shared, key))).toBe(false);
    expect([...Object.keys(project), ...Object.keys(shared)].sort()).toEqual(
      Object.keys(stored).sort(),
    );
  } finally {
    await put("smtp", [{ ...before.smtp[0], dkim: null }]);
  }
});

test("messengers have no control, a save keeps them, and the media provider is read-only", async ({
  page,
}) => {
  await onInstance(page);
  const res = await api(page, "/api/settings/messengers", "PUT", [
    { name: "sms-test", root_url: "http://localhost:9999/send", enabled: false },
  ]);
  expect(res.status).toBe(200);
  await page.reload();
  await expect(tab(page, "Messengers")).toHaveCount(0);
  await expect(page.locator('[name="upload.provider"]')).toBeEditable({ editable: false });
  await save(page);
  expect((await settings(page)).messengers).toMatchObject([{ name: "sms-test", enabled: false }]);
});

test("settings values are text, and viewing needs no more than settings:get", async ({ page }) => {
  const hostile = '<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"';
  await api(page, "/api/settings/app.site_name", "PUT", hostile);
  await page.reload();
  await expect(page.locator('[name="app.site_name"]')).toHaveValue(hostile);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();

  await page.goto("/admin");
  const viewer = await createUser(page, ["settings:get"]);
  const context = await page.context().browser().newContext({ baseURL: ORIGIN });
  const other = await context.newPage();
  await other.setExtraHTTPHeaders({ "X-Forwarded-For": "203.0.113.200" });
  await login(other, viewer.username, "e2e-user-password", SETTINGS);
  await expect(other.locator('[name="app.from_email"]')).toBeVisible();
  await expect(other.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  // B139: SMTP is on the instance page, which only the instance admin reaches.
  await expect(tab(other, "SMTP")).toHaveCount(0);
  await other.goto(INSTANCE);
  await expect(other.getByTestId("instance-login")).toBeVisible();
  await context.close();
});

const EXECUTABLE = fileURLToPath(new URL("../../../dist/iglo.email", import.meta.url));
const SES_REGION = "eu-west-1";

/**
 * A test-only stand-in for SES v2 GetAccount (SES allows 5/s), for the compiled executable: the
 * process reaches `email.<region>.amazonaws.com` only through HTTPS_PROXY; this loopback proxy
 * accepts CONNECT for that host alone, terminates TLS with a certificate issued here (trusted
 * through NODE_EXTRA_CA_CERTS), and answers every request with the account. Nothing leaves the
 * machine. Node only, like the rest of a spec (test/bounces/sns-tunnel.ts is the Bun original).
 */
async function sesStandIn() {
  const host = `email.${SES_REGION}.amazonaws.com`;
  const dir = await mkdtemp(join(tmpdir(), "iglo-e2e-ses-"));
  const keyPath = join(dir, "tls.key");
  const certPath = join(dir, "tls.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-days",
      "2",
    ],
    { stdio: "ignore" },
  );
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const account = JSON.stringify({
    SendQuota: { Max24HourSend: 50_000, MaxSendRate: 5, SentLast24Hours: 0 },
    ProductionAccessEnabled: true,
    SendingEnabled: true,
  });
  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    client.once("data", (request) => {
      if (!request.toString("latin1").startsWith(`CONNECT ${host}:443 HTTP/1.1\r\n`)) {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const secure = new TLSSocket(client, { isServer: true, key, cert });
      sockets.add(secure);
      secure.on("error", () => {});
      let head = "";
      secure.on("data", (chunk) => {
        const done = head.includes("\r\n\r\n");
        head += chunk.toString("latin1");
        if (done || !head.includes("\r\n\r\n")) {
          return;
        }
        secure.end(
          "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n" +
            `content-length: ${Buffer.byteLength(account)}\r\nconnection: close\r\n\r\n${account}`,
        );
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    environment: {
      HTTPS_PROXY: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certPath,
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the send-rate line follows the field: emptied no warning, 0 the no-cap line, above SES's rate the warning", async ({
  page,
}) => {
  // B155a item 7 (D164, D176): the line's Alpine bindings, which the server-rendered tests cannot
  // reach. A fresh instance of its own reads SES's rate (5/s) from the stand-in.
  const standIn = await sesStandIn();
  const directory = await mkdtemp(join(tmpdir(), "iglo-e2e-ses-rate-"));
  const own = await startInstance(
    EXECUTABLE,
    join(directory, "data"),
    directory,
    standIn.environment,
  );
  const context = await page.context().browser().newContext();
  try {
    const other = await context.newPage();
    const alpineErrors = [];
    other.on("console", (message) => {
      if (message.text().includes("Alpine Expression Error")) {
        alpineErrors.push(message.text());
      }
    });
    await other.goto(`${own.origin}/admin/instance/login`);
    await signInInstance(other, own.origin);
    const call = (path, method, body) =>
      other.evaluate(
        async ([uri, verb, data]) => {
          const csrf =
            document.cookie
              .split("; ")
              .find((c) => c.startsWith("instance_csrf="))
              ?.slice("instance_csrf=".length) ?? "";
          const response = await fetch(uri, {
            method: verb,
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          return { status: response.status, text: await response.text() };
        },
        [path, method, body],
      );
    // The three SES keys are saved together.
    const current = await call("/api/instance/settings", "GET");
    expect(current.status, current.text).toBe(200);
    const saved = await call("/api/instance/settings", "PUT", {
      ...JSON.parse(current.text).data,
      "messaging.max_send_rate": 3,
      "ses.api_region": SES_REGION,
      "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
      "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(saved.status, saved.text).toBe(200);
    const checked = await call("/api/instance/settings/ses/check", "POST", {});
    expect(checked.status, checked.text).toBe(200);
    await other.goto(`${own.origin}${INSTANCE}`);
    await tab(other, "Performance").click();
    const field = other.locator('[name="messaging.max_send_rate"]');
    const line = other.getByTestId("ses-rate");
    const warning = other.getByTestId("ses-rate-warning");
    const unpaced = other.getByTestId("ses-rate-unpaced");
    await expect(line).toContainText("SES allows 5/s.");
    // Saved 3, under SES's rate: neither line (the server's render).
    await expect(warning).toBeHidden();
    await expect(unpaced).toBeHidden();
    // Alpine applies an edit on its next tick, so each step starts from the line it must hide:
    // a hidden line checked before that tick would pass whatever the expression says.
    // Above SES's rate: the warning.
    await field.fill("6");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("sending runs at 5/s");
    await expect(unpaced).toBeHidden();
    // Emptied from there: no number, so no warning and no 0 line.
    await field.fill("");
    await expect(warning).toBeHidden();
    await expect(unpaced).toBeHidden();
    // 0: no cap of its own, not a rate above SES's.
    await field.fill("0");
    await expect(unpaced).toBeVisible();
    await expect(unpaced).toContainText("The setting is 0, no cap of its own");
    await expect(warning).toBeHidden();
    // Emptied from 0: the 0 line goes too ("" is not 0).
    await field.fill("");
    await expect(unpaced).toBeHidden();
    await expect(warning).toBeHidden();
    // At SES's rate, from above it: neither.
    await field.fill("6");
    await expect(warning).toBeVisible();
    await field.fill("5");
    await expect(warning).toBeHidden();
    await expect(unpaced).toBeHidden();
    expect(alpineErrors).toEqual([]);
  } finally {
    await context.close();
    await own.close();
    await standIn.close();
  }
});
