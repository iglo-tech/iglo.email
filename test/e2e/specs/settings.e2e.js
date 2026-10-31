// Adapted from listmonk tests/specs/settings.spec.js at 6fcd95f. The run shares one database, so
// each test restores what it changed. A save needs no restart here (D44), so there is no health
// wait; messengers, bounce mailboxes and the other bounce providers are read-only (D44, 07-api-and-ui.md);
// the root URL belongs to the bootstrap flags. API-only cases live in `bun run contract:settings`.
import { generateKeyPairSync, createHmac } from "node:crypto";
import { expect } from "@playwright/test";
import { ADMIN, ORIGIN, api, createUser, login, mailFor, test, unique } from "../helpers.js";

const SETTINGS = "/admin/settings";
const smtpServers = (page) => page.locator(".mail-servers details");
const tab = (page, name) => page.getByRole("tab", { name, exact: true });

async function settings(page) {
  const res = await api(page, "/api/settings");
  expect(res.status).toBe(200);
  return res.body.data;
}

// Saving applies at once; the button comes back when the request is done.
async function save(page, status = 200) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(status);
  if (status === 200) await expect(page.getByText('"Settings" updated').first()).toBeVisible();
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
    if (key === "app.root_url" || JSON.stringify(now[key]) === JSON.stringify(value)) continue;
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

test("saves edits across tabs, enables SMTP and deletes a server", async ({ page }) => {
  const favicon = `${ORIGIN}/public/static/logo.png`;
  // Deliberate difference: the root URL is a bootstrap flag (D44), shown read-only.
  const root = page.locator('[name="app.root_url"]');
  await expect(root).toHaveJSProperty("readOnly", true);
  await expect(page.getByText("Changing it needs a restart.")).toBeVisible();
  await page.locator('[name="app.favicon_url"]').fill(favicon);
  await tab(page, "Performance").click();
  await page.locator('[name="app.concurrency"]').fill("9");
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
    "app.concurrency": 9,
    smtp: [{ enabled: true, host: "localhost", port: 1025, tls_type: "none" }],
  });
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(servers.getByRole("switch", { name: "Enabled", exact: true })).toBeChecked();
  await tab(page, "General").click();
  await expect(page.locator('[name="app.favicon_url"]')).toHaveValue(favicon);
  await tab(page, "Performance").click();
  await expect(page.locator('[name="app.concurrency"]')).toHaveValue("9");
});

test("a logo or favicon path the API accepts saves, from any tab", async ({ page }) => {
  // The API stores these as given; an input pattern would hold back a save from another tab.
  const res = await api(page, "/api/settings/app.logo_url", "PUT", "/uploads/logo.png");
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "Performance").click();
  await page.locator('[name="app.concurrency"]').fill("8");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "app.logo_url": "/uploads/logo.png",
    "app.concurrency": 8,
  });
});

test("searches across tabs using all terms", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search" });
  await expect(page.locator('[name="app.from_email"]')).toBeVisible();
  await search.fill("  RATE   workers  ");
  await expect(page.locator('[name="app.concurrency"]')).toBeVisible();
  await expect(tab(page, "General")).toBeHidden();
  await expect(tab(page, "Performance")).toBeVisible();
  await search.fill("email");
  await expect(page.locator('[name="app.from_email"]')).toBeVisible();
  await expect(tab(page, "SMTP")).toBeVisible();
  await tab(page, "SMTP").click();
  await expect(search).toBeEmpty();
  await expect(smtpServers(page)).toBeVisible();
  await search.fill("no-such-setting");
  await expect(tab(page, "General")).toBeVisible();
  await expect(smtpServers(page)).toBeVisible();
  await search.fill("concurrency");
  await search.fill("");
  await expect(smtpServers(page)).toBeVisible();
  await expect(page.locator('[name="app.concurrency"]')).toBeHidden();
});

test("SMTP presets reset credentials and preserve unrelated fields and accordion state", async ({
  page,
}) => {
  await tab(page, "SMTP").click();
  const server = smtpServers(page);
  await server.locator("summary").click();
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
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByPlaceholder("smtp.yourmailserver.net")).toBeHidden();
});

test("tests custom SMTP headers and masks saved secrets", async ({ page }) => {
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
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  );
  await save(page);
  expect((await request).postDataJSON().smtp[0].password).toBe("");
  await page.reload();
  await tab(page, "SMTP").click();
  await expect(server.getByLabel(/Password/)).toHaveValue(/^•+$/);
});

test("test connection uses the form's values and saves nothing", async ({ page }) => {
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

test("enables sliding window controls and persists their values", async ({ page }) => {
  await tab(page, "Performance").click();
  const group = page.getByRole("group", { name: "Enable sliding window limit", exact: true });
  await expect(group.getByRole("textbox", { name: /^Duration/ })).toBeDisabled();
  await group.getByRole("switch").check();
  await group.getByRole("spinbutton", { name: /^Max. messages/ }).fill("42");
  await group.getByRole("textbox", { name: /^Duration/ }).fill("2h");
  await save(page);
  await page.reload();
  await tab(page, "Performance").click();
  await expect(group.getByRole("switch")).toBeChecked();
  await expect(group.getByRole("spinbutton", { name: /^Max. messages/ })).toHaveValue("42");
  await expect(group.getByRole("textbox", { name: /^Duration/ })).toHaveValue("2h");
  await group.getByRole("switch").uncheck();
  await expect(group.getByRole("textbox", { name: /^Duration/ })).toBeDisabled();
  await expect(group.getByRole("textbox", { name: /^Duration/ })).toHaveValue("2h");
});

test("persists trusted URLs and the native security settings", async ({ page }) => {
  await tab(page, "Security").click();
  const urls = page.getByPlaceholder("https://example.com", { exact: true });
  await urls.fill("https://one.example.com\nhttps://two.example.com/thanks");
  const proxies = page.locator('[name="security.trusted_proxies"]');
  await proxies.fill(`${(await proxies.inputValue()).trim()}\n10.0.0.0/8`);
  await page.getByRole("spinbutton", { name: "Subscribe", exact: true }).fill("31");
  await page.getByRole("switch", { name: /^Block private webhook addresses/ }).check();
  await save(page);
  expect(await settings(page)).toMatchObject({
    "security.trusted_urls": ["https://one.example.com", "https://two.example.com/thanks"],
    "security.trusted_proxies": ["127.0.0.1", "10.0.0.0/8"],
    "security.public_rate_limit": { ...before["security.public_rate_limit"], subscribe: 31 },
    "webhooks.block_private_addresses": true,
  });
  await page.reload();
  await tab(page, "Security").click();
  await expect(urls).toHaveValue("https://one.example.com\nhttps://two.example.com/thanks");
  await urls.fill("");
  await proxies.fill("0.0.0.0/0");
  await save(page, 400);
  await expect(page.getByText(/invalid trusted proxy/)).toBeVisible();
  await proxies.fill("127.0.0.1");
  await save(page);
  await page.reload();
  await tab(page, "Security").click();
  await expect(urls).toBeEmpty();
});

test("persists bounce actions and the Mailgun key; other providers stay read-only", async ({
  page,
}) => {
  await tab(page, "Bounces").click();
  await page.getByRole("switch", { name: "Enable bounce processing", exact: true }).check();
  const hard = page.getByRole("group", { name: "Hard", exact: true });
  await hard.getByRole("spinbutton").fill("3");
  await hard.getByRole("combobox").selectOption("unsubscribe");
  const webhooks = page.getByRole("switch", { name: /^Enable bounce webhooks/ });
  await webhooks.check();
  const mailgun = page.getByRole("group", { name: "Enable Mailgun", exact: true });
  await mailgun.getByRole("switch").check();
  await save(page, 400);
  await expect(page.getByText("A Mailgun signing key is required.")).toBeVisible();
  await mailgun.getByLabel(/signing key/).fill("mailgun-signing-key");
  await save(page);
  expect(await settings(page)).toMatchObject({
    "bounce.enabled": true,
    "bounce.webhooks_enabled": true,
    "bounce.actions": { hard: { count: 3, action: "unsubscribe" } },
    "bounce.mailboxes": before["bounce.mailboxes"],
    "bounce.mailgun": { enabled: true, key: "•".repeat("mailgun-signing-key".length) },
  });
  await page.reload();
  await tab(page, "Bounces").click();
  await expect(hard.getByRole("spinbutton")).toHaveValue("3");
  await expect(hard.getByRole("combobox")).toHaveValue("unsubscribe");
  await expect(mailgun.getByLabel(/signing key/)).toHaveValue(/^•+$/);
  const others = page.getByRole("group", { name: "Other bounce providers", exact: true });
  await expect(others.getByText("Not available in this version.")).toBeVisible();
  await expect(others.getByRole("switch", { name: /SES/ })).toBeDisabled();
  await expect(
    page.getByRole("group", { name: "Enable bounce mailbox" }).getByRole("switch"),
  ).toBeDisabled();
  await webhooks.uncheck();
  await expect(mailgun).toHaveCount(0);
  await webhooks.check();

  // The stored key survives a save of the masked field: a signature made with it still passes.
  await save(page);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = unique("token");
  const signature = createHmac("sha256", "mailgun-signing-key")
    .update(timestamp + token)
    .digest("hex");
  const post = (signed) =>
    page.request.post("/webhooks/bounce/mailgun", {
      data: {
        signature: { timestamp, token, signature: signed },
        "event-data": {
          event: "failed",
          severity: "permanent",
          id: unique("event"),
          timestamp: Number(timestamp),
          recipient: "nobody@example.test",
        },
      },
    });
  expect((await post("0".repeat(64))).status()).toBe(406);
  expect((await post(signature)).status()).toBe(200);
});

test("saves independent admin and public appearance editors", async ({ page }) => {
  await tab(page, "Appearance").click();
  await expect(page.getByTestId("appearance-warning")).toContainText("every signed-in admin page");
  const css = page.getByRole("group", { name: "Custom CSS", exact: true }).getByRole("textbox");
  const js = page
    .getByRole("group", { name: "Custom JavaScript", exact: true })
    .getByRole("textbox");
  await css.fill("/* admin settings test */");
  await js.fill("window.adminCustom = 1;");
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  await css.fill("/* public settings test */");
  await js.fill("window.publicCustom = 1;");
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
  await page.getByRole("tab", { name: "Public", exact: true }).click();
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
      dkim: { domain_name: "example.test", key_selector: "s1", private_key: privateKey },
    },
  ]);
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
  await put("bounce.mailgun", { enabled: false, key: "mg-secret" });
  await put("security.captcha", {
    altcha: { enabled: false, complexity: 123456 },
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
    await page.reload();
    await expect(page.locator('[name="app.from_email"]')).toBeVisible();
    const request = page.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
    );
    await save(page);
    const sent = (await request).postDataJSON();
    expect(await settings(page)).toEqual(stored);
    // Every secret goes back empty, which the API reads as "keep": a bullet never reaches storage.
    expect(JSON.stringify(sent)).not.toContain("•");
    expect(sent.smtp[0].dkim.private_key).toBe("");
    expect(sent.smtp[0].uuid).toBe(stored.smtp[0].uuid);
    expect(sent["security.oidc"].client_secret).toBe("");
    expect(sent["privacy.exportable"]).toEqual(["profile"]);
    expect(Object.keys(sent).sort()).toEqual(Object.keys(stored).sort());
  } finally {
    await put("smtp", [{ ...before.smtp[0], dkim: null }]);
  }
});

test("messengers are shown and kept, not edited", async ({ page }) => {
  const res = await api(page, "/api/settings/messengers", "PUT", [
    { name: "sms-test", root_url: "http://localhost:9999/send", enabled: false },
  ]);
  expect(res.status).toBe(200);
  await page.reload();
  await tab(page, "Messengers").click();
  const messenger = page.getByTestId("messenger");
  await expect(messenger).toHaveCount(1);
  await expect(messenger.getByRole("textbox", { name: "Name" })).toHaveValue("sms-test");
  await expect(messenger.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add new" }).locator("visible=true")).toHaveCount(
    0,
  );
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
  await tab(other, "SMTP").click();
  await expect(other.getByRole("button", { name: "Test connection" })).toHaveCount(0);
  await context.close();
});
