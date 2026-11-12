// Outbound webhooks as a receiver sees them (docs/design/04-sending.md#outbound-webhooks, and E4 in
// docs/design/13-e2e-coverage.md). Not an upstream spec: listmonk has no webhooks. Every receiver is
// a loopback server this file started, closed when its test ends, and no test names a real endpoint.
// Deliveries are read through the API, the way the admin's own tooling reads them; what a reader
// does is done on the public pages, from the mail the sink holds for the reader's address.
import { createHmac, randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import {
  confirm,
  makeList,
  mailFor,
  ok,
  receiver,
  requestAdmin,
  signIn,
  test,
  unique,
} from "../helpers.js";
import { openBulkMenu, subRow, SUBSCRIBERS } from "../subscribers-helpers.js";

const WAIT = { timeout: 30_000 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UNSUBSCRIBE = new RegExp(`/(subscription/${UUID}|m/${UUID}/unsubscribe)/${UUID}$`, "i");
// A webhook URL nothing answers at: a refused delivery never connects, so it may stay unreachable.
const UNREACHED = "http://203.0.113.1/never";
// The first retry is 30 s after a failed attempt (src/webhooks/store.ts, FIRST_RETRY_MS).
const FIRST_RETRY = { timeout: 60_000 };

const address = (prefix) => `${unique(prefix)}@example.com`;

// Webhooks, receivers and settings this file made or changed. `afterEach` deletes, closes and puts
// them back, even after a timeout has closed the page.
let webhooks = [];
let receivers = [];
let changed = {};

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
  for (const target of receivers.splice(0)) await step("closing a receiver", () => target.close());
  const call = await requestAdmin(request);
  for (const id of webhooks.splice(0))
    await step(`deleting webhook ${id}`, async () => {
      const response = await call(`/api/webhooks/${id}`, "DELETE");
      if (response.status !== 200) throw new Error(`answered ${response.status}`);
    });
  const pending = changed;
  changed = {};
  for (const [key, value] of Object.entries(pending))
    await step(`restoring ${key}`, async () => {
      const response = await call(`/api/settings/${key}`, "PUT", value);
      if (response.status !== 200) throw new Error(`answered ${response.status}`);
    });
  if (failures.length) throw new Error(failures.join("\n"));
});

// Changes a setting, remembering what the server had so `afterEach` puts it back.
async function change(page, key, value) {
  const settings = await ok(page, "/api/settings");
  if (!(key in changed)) changed[key] = settings[key];
  await ok(page, `/api/settings/${key}`, "PUT", value);
}

// A receiver of this file's own, closed in `afterEach`.
async function listener(options) {
  const target = await receiver(options);
  receivers.push(target);
  return target;
}

// A webhook for `events`, delivered to `url`. Its secret is in the answer, which only creation gives.
async function hook(page, url, events, extra = {}) {
  const created = await ok(page, "/api/webhooks", "POST", { url, events, ...extra });
  webhooks.push(created.id);
  return created;
}

const deliveries = async (page, id) => (await ok(page, `/api/webhooks/${id}/deliveries`)).results;

// The bodies a receiver has been sent, parsed in arrival order.
const bodies = (target) => target.requests.map((request) => JSON.parse(request.body));

// The body of one event about one address, once the receiver has it.
async function eventFor(target, event, email) {
  let found;
  await expect
    .poll(() => {
      found = bodies(target).find(
        (body) => body.event === event && body.data.subscriber?.email === email,
      );
      return found !== undefined;
    }, WAIT)
    .toBe(true);
  return found;
}

// A public list, so a reader can unsubscribe from it through a mail link.
const publicList = (page) =>
  ok(page, "/api/lists", "POST", { name: unique("Hooks"), type: "public", optin: "single" });

async function reader(page, lists, { external_id } = {}) {
  return ok(page, "/api/subscribers", "POST", {
    email: address("reader"),
    name: "Hook Reader",
    status: "enabled",
    lists: lists.map((item) => item.id),
    ...(external_id ? { external_id } : {}),
  });
}

async function campaign(page, lists, body) {
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Hook campaign"),
    subject: unique("Hook subject"),
    type: "regular",
    content_type: "html",
    body,
    lists: lists.map((item) => item.id),
  });
}

async function sendCampaign(page, item) {
  await ok(page, `/api/campaigns/${item.id}/status`, "PUT", { status: "running" });
  await expect
    .poll(async () => (await ok(page, `/api/campaigns/${item.id}`)).status, WAIT)
    .toBe("finished");
}

// Every absolute link in a mail body, with HTML's `&amp;` read as `&`, as a reader's click would.
const linksIn = (mail) =>
  [...mail.body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0].replaceAll("&amp;", "&"),
  );

function unsubscribeLink(mail) {
  const found = linksIn(mail).find(
    (url) => UNSUBSCRIBE.test(new URL(url).pathname) && !new URL(url).searchParams.has("manage"),
  );
  expect(found, "the mail links to an unsubscribe page").toBeTruthy();
  return found;
}

async function unsubscribeInBrowser(page, url, { blocklist = false } = {}) {
  await page.goto(url);
  await expect(page.locator("#btn-unsub")).toBeVisible();
  if (blocklist) await page.locator("#privacy-blocklist").check();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);
}

// An administrative delete of a new subscriber, which queues `subscriber.deleted`.
async function deleteReader(page, person) {
  await ok(page, `/api/subscribers/${person.id}`, "DELETE");
}

test("a reader's unsubscribe and a blocklist through the mail each reach the receiver with that person", async ({
  page,
}) => {
  const target = await listener();
  await hook(page, `${target.url}/hook`, ["subscriber.unsubscribed", "subscriber.blocklisted"]);
  const pub = await publicList(page);
  const leaving = await reader(page, [pub]);
  const blocked = await reader(page, [pub]);
  await sendCampaign(
    page,
    await campaign(
      page,
      [pub],
      '<p>News</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
    ),
  );
  const [leavingMail] = await mailFor(leaving.email);
  const [blockedMail] = await mailFor(blocked.email);
  await unsubscribeInBrowser(page, unsubscribeLink(leavingMail));
  await unsubscribeInBrowser(page, unsubscribeLink(blockedMail), { blocklist: true });

  const unsubscribed = await eventFor(target, "subscriber.unsubscribed", leaving.email);
  expect(unsubscribed.data.subscriber.id).toBe(leaving.id);
  expect(unsubscribed.data.list_ids).toEqual([pub.id]);
  expect(unsubscribed.id).toMatch(new RegExp(`^${UUID}$`, "i"));

  const blocklisted = await eventFor(target, "subscriber.blocklisted", blocked.email);
  expect(blocklisted.data.subscriber.id).toBe(blocked.id);
  expect(blocklisted.data.list_ids).toEqual([pub.id]);
});

test("each delivery is signed with its webhook's secret over the timestamp and the exact body", async ({
  page,
}) => {
  const target = await listener();
  const secret = randomBytes(16).toString("hex");
  await hook(page, `${target.url}/hook`, ["subscriber.deleted"], { secret });
  const person = await reader(page, []);
  await deleteReader(page, person);
  await expect.poll(() => target.requests.length, WAIT).toBeGreaterThan(0);

  const [request] = target.requests;
  expect(request.method).toBe("POST");
  expect(request.headers["content-type"]).toBe("application/json");
  const [, unix, digest] =
    /^t=(\d+),v1=([0-9a-f]+)$/.exec(request.headers["x-iglo-email-signature"] ?? "") ?? [];
  expect(digest, "the header has a timestamp and a v1 digest").toBeTruthy();
  expect(Math.abs(Date.now() / 1000 - Number(unix))).toBeLessThan(300);

  const sign = (key) => createHmac("sha256", key).update(`${unix}.${request.body}`).digest("hex");
  expect(digest).toBe(sign(secret));
  expect(digest).not.toBe(sign(`${secret}x`));
  // The secret signs the delivery; it is never sent in one.
  expect(request.body).not.toContain(secret);
});

test("a deletion names the person by ID and never by address, and a wipe also clears the external ID and memberships", async ({
  page,
}) => {
  const target = await listener();
  await hook(page, `${target.url}/hook`, ["subscriber.deleted"]);
  const pub = await publicList(page);

  // An administrator's delete keeps the external ID and the memberships, which a receiver matches on.
  const external = unique("ext");
  const deleted = await reader(page, [pub], { external_id: external });
  const deletedAddress = deleted.email;
  await deleteReader(page, deleted);
  await expect
    .poll(() => bodies(target).some((body) => body.data.subscriber?.id === deleted.id), WAIT)
    .toBe(true);
  const admin = bodies(target).find((body) => body.data.subscriber?.id === deleted.id);
  expect(admin.event).toBe("subscriber.deleted");
  expect(admin.data.subscriber.email).toBe("");
  expect(admin.data.subscriber.external_id).toBe(external);
  expect(admin.data.list_ids).toEqual([pub.id]);
  expect(JSON.stringify(admin)).not.toContain(deletedAddress);

  // A reader's own wipe from the privacy page clears all three, and sends no address either.
  const wiped = await reader(page, [pub], { external_id: unique("ext") });
  const mailed = await campaign(
    page,
    [pub],
    '<p>Hello</p><p><a href="{{ manage_url }}">Manage</a></p>',
  );
  await sendCampaign(page, mailed);
  const [mail] = await mailFor(wiped.email);
  const manage = linksIn(mail).find((url) => new URL(url).searchParams.get("manage") === "true");
  expect(manage, "the mail links to the manage page").toBeTruthy();
  await page.goto(manage);
  await page.locator("#privacy-wipe").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#data-form input[type=submit]").click();
  await expect(page.locator("body")).toContainText(
    "Your subscriptions and all associated data have been removed.",
  );

  await expect
    .poll(() => bodies(target).some((body) => body.data.subscriber?.id === wiped.id), WAIT)
    .toBe(true);
  const gdpr = bodies(target).find((body) => body.data.subscriber?.id === wiped.id);
  expect(gdpr.event).toBe("subscriber.deleted");
  expect(gdpr.data.subscriber.email).toBe("");
  expect(gdpr.data.subscriber.external_id).toBeNull();
  expect(gdpr.data.list_ids).toEqual([]);
  expect(JSON.stringify(gdpr)).not.toContain(wiped.email);
});

test("a disabled webhook receives nothing for an event that would otherwise fire", async ({
  page,
}) => {
  const live = await listener();
  const off = await listener();
  await hook(page, `${live.url}/hook`, ["subscriber.deleted"]);
  const disabled = await hook(page, `${off.url}/hook`, ["subscriber.deleted"], { enabled: false });
  const person = await reader(page, []);
  await deleteReader(page, person);

  // The enabled webhook gets the event, so the same delete has reached the delivery loop; a settle
  // window after it then covers the disabled webhook's delivery, had one been made.
  await expect.poll(() => live.requests.length, WAIT).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(off.requests).toEqual([]);
  expect(await deliveries(page, disabled.id)).toEqual([]);
});

test("a receiver that answers 500 is recorded as failed, then gets the same delivery again and the 200 ends it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const target = await listener({ statuses: [500, 200] });
  const made = await hook(page, `${target.url}/hook`, ["subscriber.deleted"]);
  const person = await reader(page, []);
  await deleteReader(page, person);

  // The refusal is logged on the row, which waits for its retry.
  await expect
    .poll(async () => (await deliveries(page, made.id))[0]?.last_error, WAIT)
    .toBe("http_500");
  const [failed] = await deliveries(page, made.id);
  expect(failed).toMatchObject({ status: "queued", attempts: 1 });
  expect(failed.next_attempt_at).toBeTruthy();

  // The retry carries the same event, with the same ID and the same bytes.
  await expect
    .poll(async () => (await deliveries(page, made.id))[0]?.status, FIRST_RETRY)
    .toBe("delivered");
  expect(target.requests).toHaveLength(2);
  expect(target.requests[1].body).toBe(target.requests[0].body);
  expect(bodies(target)[1].id).toBe(bodies(target)[0].id);
  const [done] = await deliveries(page, made.id);
  expect(done).toMatchObject({ status: "delivered", attempts: 2, last_error: null });
});

test("over the webhook budget the bulk delete screen shows the API's message and deletes nothing", async ({
  page,
}) => {
  test.setTimeout(150_000);
  // 20 webhooks on subscriber.deleted and 2,501 subscribers: 50,020 deliveries, over 50,000. The
  // refusal comes before anything is queued, so no request leaves for these addresses.
  for (let i = 0; i < 20; i += 1) await hook(page, UNREACHED, ["subscriber.deleted"]);

  const list = await makeList(page);
  const domain = `${unique("budget")}.example.com`;
  const rows = ["email,name,attributes"];
  for (let i = 0; i < 2501; i += 1) rows.push(`reader${i}@${domain},"Reader ${i}","{}"`);
  const started = await page.evaluate(
    async ([listID, text]) => {
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
          delim: ",",
          lists: [listID],
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
    [list.id, rows.join("\n")],
  );
  expect(started).toBe(200);
  await expect
    .poll(async () => (await ok(page, "/api/import/subscribers")).status, { timeout: 90_000 })
    .toBe("finished");
  await expect
    .poll(async () => (await ok(page, `/api/subscribers?list_id=${list.id}&per_page=1`)).total)
    .toBe(2501);

  await page.goto(`${SUBSCRIBERS}/lists/${list.id}`);
  await expect(subRow(page).first()).toBeVisible();
  await openBulkMenu(page, { selectAll: true });
  await page.getByTestId("btn-delete-subscribers").click();
  const [answer] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/subscribers/query/delete"),
    ),
    confirm(page),
  ]);
  expect(answer.status()).toBe(400);
  await expect(page.locator("body")).toContainText(
    "This action would queue 50,020 webhook deliveries",
  );
  await expect(page.locator("body")).toContainText("over the limit of 50,000 per bulk action");
  expect((await ok(page, `/api/subscribers?list_id=${list.id}&per_page=1`)).total).toBe(2501);
});

test("with private addresses blocked, a loopback receiver gets nothing and the delivery says why", async ({
  page,
}) => {
  const target = await listener();
  await change(page, "webhooks.block_private_addresses", true);
  const made = await hook(page, `${target.url}/hook`, ["subscriber.deleted"]);
  const person = await reader(page, []);
  await deleteReader(page, person);

  await expect
    .poll(async () => (await deliveries(page, made.id))[0]?.last_error, WAIT)
    .toBe("blocked_address");
  const [refused] = await deliveries(page, made.id);
  expect(refused).toMatchObject({ status: "queued", attempts: 1 });
  expect(target.requests).toEqual([]);
});
