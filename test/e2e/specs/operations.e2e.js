// Operations and data safety, as an operator and a reader meet them (docs/design/13-e2e-coverage.md,
// E3). Not an upstream spec: listmonk's suite does not read the admin mail, restore a backup or
// export a person's data through the public page. Each test makes its own uniquely named lists,
// subscribers, campaigns, templates and imports through the API, then asserts on the mail the SMTP
// sink holds for its own addresses or on the screen a person sees. The restore test starts a third
// instance from a snapshot the production `backup` command wrote; no test hook is involved.
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { startSink } from "../../tx/sink.ts";
import {
  ADMIN,
  ORIGIN,
  api,
  audience,
  makeList,
  mailCounts,
  mailFor,
  ok,
  requestAdmin,
  settledMail,
  signIn,
  test,
  unique,
} from "../helpers.js";
import { releaseHold, restoredInstance, stopOwnedInstances } from "../instance.js";

// The compiled executable the run built (`bun run e2e` builds it first).
const EXECUTABLE = fileURLToPath(new URL("../../../dist/iglo.email", import.meta.url));
const FINISH = { timeout: 30_000 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UNSUBSCRIBE = new RegExp(`/(subscription/${UUID}|m/${UUID}/unsubscribe)/${UUID}$`, "i");
const IMPORT_SUBJECT = "Finished: subscribers.csv import";
const IMPORT_FAILED = "Failed: subscribers.csv import";

const address = (prefix) => `${unique(prefix)}@example.com`;
// A client address of its own for the public pages and the logins, so their limits are not shared.
const peer = () => `203.0.113.${1 + Math.floor(Math.random() * 254)}`;

// Settings this file changed, as the server had them, and the instances and sinks it started.
// `afterEach` closes the started ones and puts the settings back, even after a timeout.
let changed = {};
let started = [];
// What a sending path answers while the restore hold stands: the hold's own reason, as `hold.ts`
// words it, so another 503 with a different message cannot pass for it.
const HOLD_MESSAGE =
  /^Sending is held\. Restored from a backup taken at .+\. Sending stays stopped until an operator reconciles them and releases it\.$/;

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.afterEach(async ({ request }) => {
  const failures = [];
  const step = async (label, run) => {
    try {
      await run();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };
  // Instances and sinks first: an instance holds its data directory while it runs.
  for (const item of started.splice(0)) await step("closing", () => item.close());
  // An instance whose test timed out never reached its `close` above; this sweep reaches it.
  await step("closing the instances this file started", stopOwnedInstances);
  const pending = changed;
  changed = {};
  await step("restoring settings", async () => {
    const call = await requestAdmin(request);
    for (const [key, value] of Object.entries(pending)) {
      const response = await call(`/api/settings/${key}`, "PUT", value);
      if (response.status !== 200) throw new Error(`${key} answered ${response.status}`);
    }
    await call("/api/import/subscribers", "DELETE");
  });
  if (failures.length) throw new Error(failures.join("\n"));
});

// Keeps what the server had for a setting, so `afterEach` puts it back. The first value kept wins.
function remember(settings, key) {
  if (!(key in changed)) changed[key] = settings[key];
}

// Changes a setting, remembering what the server had so `afterEach` puts it back.
async function change(page, key, value) {
  remember(await ok(page, "/api/settings"), key);
  await ok(page, `/api/settings/${key}`, "PUT", value);
}

const statusOf = async (page, id) => (await ok(page, `/api/campaigns/${id}`)).status;

async function campaign(page, lists, overrides = {}) {
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Operations campaign"),
    subject: unique("Operations subject"),
    type: "regular",
    content_type: "html",
    body: "<p>Operations body</p>",
    lists,
    ...overrides,
  });
}

// Starts a campaign and waits until the runner has finished it.
async function sendToEnd(page, item) {
  await ok(page, `/api/campaigns/${item.id}/status`, "PUT", { status: "running" });
  await expect.poll(() => statusOf(page, item.id), FINISH).toBe("finished");
}

// The admin mail with this subject that the sink holds for an address, waited for. Admin mail is
// a durable send, so it arrives after the event that caused it.
async function noticeFor(to, subject) {
  let found;
  await expect(async () => {
    const response = await fetch(`${process.env.E2E_MAIL}?to=${encodeURIComponent(to)}`);
    found = (await response.json()).find((mail) => mail.subject === subject);
    expect(found, `"${subject}" for ${to}`).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  return found;
}

// A message the sink of this file holds, by recipient and subject, waited for.
async function sinkMail(sink, to, subject) {
  let found;
  await expect(async () => {
    found = sink.messages.find(
      (message) =>
        message.to.includes(to) && message.data.split(/\r?\n/).includes(`Subject: ${subject}`),
    );
    expect(found, `"${subject}" for ${to}`).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  return found;
}

// Every absolute link in a mail body, with HTML's `&amp;` read as `&`, as a reader's click would.
const linksIn = (mail) =>
  [...mail.body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0].replaceAll("&amp;", "&"),
  );

// The unsubscribe link a reader sees: not the manage-preferences link, which has the same path.
function unsubscribeLink(mail) {
  const found = linksIn(mail).find(
    (url) => UNSUBSCRIBE.test(new URL(url).pathname) && !new URL(url).searchParams.has("manage"),
  );
  expect(found, "the mail links to an unsubscribe page").toBeTruthy();
  return found;
}

// The same link on another origin: a restored instance answers on its own address.
function onOrigin(url, origin) {
  const moved = new URL(url);
  const base = new URL(origin);
  moved.protocol = base.protocol;
  moved.host = base.host;
  return moved.toString();
}

// Open the page a mail linked to and submit its unsubscribe form, as a reader does.
async function unsubscribeInBrowser(page, url, { blocklist = false } = {}) {
  await page.goto(url);
  await expect(page.locator("#btn-unsub")).toBeVisible();
  if (blocklist) await page.locator("#privacy-blocklist").check();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);
}

// Signs in on an origin other than the page's base URL, through the login form's own requests.
async function signInAt(page, origin, client) {
  const headers = { "X-Forwarded-For": client };
  const form = await page.request.get(`${origin}/admin/login?next=%2Fadmin`, { headers });
  const nonce = /name="nonce" value="([^"]+)"/.exec(await form.text())?.[1];
  expect(nonce, "the login page carries a nonce").toBeTruthy();
  const posted = await page.request.post(`${origin}/admin/login`, {
    headers,
    form: { username: ADMIN.user, password: ADMIN.password, next: "/admin", nonce },
    maxRedirects: 0,
  });
  expect(posted.status(), "the login form redirects to the admin").toBe(302);
  await page.goto(`${origin}/admin`);
}

// Changes to the settings page's General tab, saved. The save answers with a toast.
async function saveGeneral(page) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText('"Settings" updated').first()).toBeVisible();
}

// A CSV upload to the import route, as the admin screen sends it: JSON parameters and a file.
async function startImport(page, { lists, delim, text }) {
  return page.evaluate(
    async ({ lists, delim, text }) => {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice(5) ?? "";
      const form = new FormData();
      form.set(
        "params",
        JSON.stringify({
          mode: "subscribe",
          subscription_status: "unconfirmed",
          delim,
          lists,
          overwrite_userinfo: false,
          overwrite_subscription_status: false,
        }),
      );
      form.set("file", new File([text], "subscribers.csv", { type: "text/csv" }));
      const response = await fetch("/api/import/subscribers", {
        method: "POST",
        body: form,
        headers: { "X-CSRF-Token": csrf },
      });
      return response.status;
    },
    { lists, delim, text },
  );
}

const importStatus = async (page) => (await ok(page, "/api/import/subscribers")).status;

test("the admin notification list saves what the form holds, a bad entry included, and reloads", async ({
  page,
}) => {
  const valid = address("ops");
  const second = address("ops");
  // The form saves this setting, not `change`, so record what the server had for `afterEach`.
  remember(await ok(page, "/api/settings"), "app.notify_emails");
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const field = page.locator('input[name="app.notify_emails"]');

  // The form checks no address, and nor does the server. The operations guide says an entry that
  // is not an address is skipped at each notification and the valid entries still get mail, so a
  // list with one bad entry saves as typed, and its valid entries are what reloads.
  await field.fill(`not-an-address, ${valid}`);
  await saveGeneral(page);
  expect((await ok(page, "/api/settings"))["app.notify_emails"]).toEqual(["not-an-address", valid]);
  await page.reload();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect(field).toHaveValue(new RegExp(valid));

  await field.fill(`${valid}, ${second}`);
  await saveGeneral(page);
  await page.reload();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect(field).toHaveValue(new RegExp(second));
  expect((await ok(page, "/api/settings"))["app.notify_emails"]).toEqual([valid, second]);
});

test("a campaign that finishes and one that is cancelled each mail the admin list", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const notify = address("admin");
  await change(page, "app.notify_emails", [notify]);
  // One message every half second, so a pause and a cancel land while the second campaign runs.
  await change(page, "app.concurrency", 1);
  await change(page, "app.message_rate", 2);

  const { list } = await audience(page, 1);
  const done = await campaign(page, [list.id]);
  await sendToEnd(page, done);
  const finished = await noticeFor(notify, `Finished: ${done.name}`);
  expect(finished.body).toContain(done.name);

  const { list: slow } = await audience(page, 10);
  const stopped = await campaign(page, [slow.id]);
  await ok(page, `/api/campaigns/${stopped.id}/status`, "PUT", { status: "running" });
  await ok(page, `/api/campaigns/${stopped.id}/status`, "PUT", { status: "paused" });
  await ok(page, `/api/campaigns/${stopped.id}/status`, "PUT", { status: "cancelled" });
  expect(await statusOf(page, stopped.id)).toBe("cancelled");
  const cancelled = await noticeFor(notify, `Cancelled: ${stopped.name}`);
  expect(cancelled.body).toContain(stopped.name);
});

test("a campaign that the error threshold pauses mails the admin list", async ({ page }) => {
  test.setTimeout(120_000);
  const notify = address("admin");
  // The stack's own sink takes every message, so the trigger needs a sink of this file's own, which
  // refuses one recipient with a 550: a proven rejection. With the threshold at one, that pauses the
  // campaign. The SMTP setting points here only for this test, and `afterEach` points it back.
  const sink = await startSink({ reject: (to) => to.startsWith("refused-") });
  started.push({ close: () => sink.close() });
  const [server] = (await ok(page, "/api/settings")).smtp;
  await change(page, "smtp", [{ ...server, port: sink.port }]);
  await change(page, "app.notify_emails", [notify]);
  await change(page, "app.max_send_errors", 1);

  const list = await makeList(page);
  const refused = `refused-${unique("pause")}@example.com`;
  await ok(page, "/api/subscribers", "POST", {
    email: refused,
    name: "Refused Reader",
    status: "enabled",
    lists: [list.id],
  });
  const paused = await campaign(page, [list.id]);
  await ok(page, `/api/campaigns/${paused.id}/status`, "PUT", { status: "running" });
  await expect.poll(() => statusOf(page, paused.id), FINISH).toBe("paused");
  const notice = await sinkMail(sink, notify, `Paused: ${paused.name}`);
  expect(notice.data).toContain("Too many errors");
});

test("an import that finishes and one that fails each mail the admin list", async ({ page }) => {
  test.setTimeout(120_000);
  const notify = address("admin");
  await change(page, "app.notify_emails", [notify]);
  const list = await makeList(page);
  const domain = `${unique("import")}.example.com`;
  const rows = ["email,name,attributes"];
  for (let i = 0; i < 3; i += 1) rows.push(`reader${i}@${domain},"Reader ${i}","{}"`);

  expect(await startImport(page, { lists: [list.id], delim: ",", text: rows.join("\n") })).toBe(
    200,
  );
  await expect.poll(() => importStatus(page), FINISH).toBe("finished");
  await noticeFor(notify, IMPORT_SUBJECT);

  // A wrong delimiter leaves the header without an email column: the import ends failed.
  await api(page, "/api/import/subscribers", "DELETE");
  expect(await startImport(page, { lists: [list.id], delim: "|", text: rows.join("\n") })).toBe(
    200,
  );
  await expect.poll(() => importStatus(page), FINISH).toBe("failed");
  await noticeFor(notify, IMPORT_FAILED);
});

async function reader(page, lists, prefix) {
  return ok(page, "/api/subscribers", "POST", {
    email: address(prefix),
    name: "Held Reader",
    status: "enabled",
    lists: lists.map((item) => item.id),
  });
}

test("a restored snapshot sends nothing until an operator releases it", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const list = await makeList(page);
  // The first reader unsubscribes on the restored instance; the second stays, and is who a send
  // after release must reach.
  const leaving = await reader(page, [list], "leaving");
  const staying = await reader(page, [list], "staying");
  const addresses = [leaving.email, staying.email];

  const before = await campaign(page, [list.id], {
    body: '<p>Before the snapshot</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  });
  await sendToEnd(page, before);
  const [mail] = await mailFor(leaving.email);
  const link = unsubscribeLink(mail);
  // A draft the held instance must refuse to start, and a transactional template it must refuse to send.
  const pending = await campaign(page, [list.id], { body: "<p>Held campaign</p>" });
  const template = await ok(page, "/api/templates", "POST", {
    name: unique("Held template"),
    type: "tx",
    subject: unique("Held subject"),
    body: "<p>Held transactional.</p>",
  });
  // Each reader has had the one mail before the snapshot.
  expect(await settledMail(addresses)).toEqual([1, 1]);

  const restored = await restoredInstance(EXECUTABLE, process.env.E2E_DATA_DIR);
  started.push(restored);
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": peer() },
  });
  try {
    const held = await context.newPage();
    await signInAt(held, restored.origin, peer());

    // The admin shell shows the hold and its reason on every page.
    await expect(held.getByTestId("restore-hold")).toContainText(
      "Sending stays stopped until an operator reconciles them and releases it.",
    );

    // /health answers the bytes the stack answers, with the hold in a header.
    const health = await fetch(`${restored.origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-iglo-email-hold")).toBeTruthy();
    expect(await health.text()).toBe(await (await fetch(`${ORIGIN}/health`)).text());

    // Every path that would send is refused with 503.
    const refused = async (what, path, method, body) => {
      const response = await api(held, path, method, body);
      expect(response.status, what).toBe(503);
      expect(response.body.message, what).toMatch(HOLD_MESSAGE);
    };
    await refused("starting a campaign", `/api/campaigns/${pending.id}/status`, "PUT", {
      status: "running",
    });
    await refused("a test send", `/api/campaigns/${pending.id}/test`, "POST", {
      subscribers: [staying.email],
    });
    await refused("a transactional send", "/api/tx", "POST", {
      kind: "transactional",
      template_id: template.id,
      subscriber_emails: [staying.email],
    });
    expect(await statusOf(held, pending.id)).toBe("draft");

    // A reader's unsubscribe still lands while the hold stands.
    await unsubscribeInBrowser(held, onOrigin(link, restored.origin));
    const after = await ok(held, `/api/subscribers/${leaving.id}`);
    expect(after.lists.find((item) => item.id === list.id)?.subscription_status).toBe(
      "unsubscribed",
    );

    // Nothing reaches either address over a settle window longer than the loops' polls.
    expect(await settledMail(addresses, { settle: 7000 })).toEqual([1, 1]);

    // Stop, release with the operator's acknowledgement, and start the same instance again.
    expect(await restored.stop()).toBe(0);
    const released = await releaseHold(EXECUTABLE, restored.dataDir);
    expect(released.code, released.stderr).toBe(0);
    expect(released.stdout).toContain("Hold released");
    await restored.start();

    await held.goto(`${restored.origin}/admin`);
    await expect(held.getByTestId("restore-hold")).toHaveCount(0);

    // A campaign started now sends to the reader who stayed, and not to the one who left.
    await sendToEnd(held, pending);
    await expect.poll(() => mailCounts(addresses), FINISH).toEqual([1, 2]);
    expect(await settledMail(addresses)).toEqual([1, 2]);
  } finally {
    await context.close();
    await restored.close();
  }
});

// The public privacy page's export mails a data.json attachment, base64 after its part headers. The
// next boundary follows the last line with no line break ("...fQ----_NmP..."), so only the leading
// run of base64 characters and line breaks is the attachment.
function attachedJSON(mail, name) {
  const start = mail.body.indexOf(name);
  expect(start, `an attachment named ${name}`).toBeGreaterThan(-1);
  const rest = mail.body.slice(start);
  const body = rest.slice(rest.search(/\r?\n\r?\n/)).replace(/^\r?\n\r?\n/, "");
  const encoded = /^[A-Za-z0-9+/=\s]*/.exec(body)[0];
  return JSON.parse(Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8"));
}

test("the privacy page e-mails a person's data and wipes it, after which no campaign reaches them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A public list: the export names a private list "Private list" (src/subscribers/store.ts, and
  // the OpenAPI schema), so only a public one shows its name in the data a person receives.
  const list = await ok(page, "/api/lists", "POST", {
    name: unique("Public"),
    type: "public",
    optin: "single",
  });
  const person = await reader(page, [list], "privacy");
  const sent = await campaign(page, [list.id], {
    body: '<p>Hello</p><p><a href="{{ manage_url }}">Manage</a></p>',
  });
  await sendToEnd(page, sent);
  const [mail] = await mailFor(person.email);
  const manage = linksIn(mail).find((url) => new URL(url).searchParams.get("manage") === "true");
  expect(manage, "the mail links to the manage page").toBeTruthy();

  await page.goto(manage);
  await page.locator("#privacy-export").check();
  await page.locator("#data-form input[type=submit]").click();
  await expect(page.locator("body")).toContainText(
    "Your data has been e-mailed to you as an attachment.",
  );
  const mails = await mailFor(person.email, 2);
  const exported = mails.find((item) => item.subject === "Your data");
  expect(exported, "the export mail").toBeTruthy();
  const data = attachedJSON(exported, "data.json");
  expect(data.profile[0].email).toBe(person.email);
  expect(JSON.stringify(data.subscriptions)).toContain(list.name);

  await page.goto(manage);
  await page.locator("#privacy-wipe").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#data-form input[type=submit]").click();
  await expect(page.locator("body")).toContainText(
    "Your subscriptions and all associated data have been removed.",
  );
  // A missing subscriber answers 400 "Subscriber (<id>: ) not found", as listmonk's API does;
  // AGENTS.md keeps that contract, so this is not a 404.
  const gone = await api(page, `/api/subscribers/${person.id}`);
  expect(gone.status).toBe(400);
  expect(gone.body.message).toMatch(/not found/);

  // The next campaign to their former list has no one on it to send to.
  const next = await campaign(page, [list.id]);
  await sendToEnd(page, next);
  expect(await settledMail([person.email])).toEqual([2]);
});
