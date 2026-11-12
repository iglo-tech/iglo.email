// Analytics on real data (docs/design/13-e2e-coverage.md, E6). Every view, click, unsubscribe and
// bounce here is one a reader or a provider made: the open pixel and tracked links are followed from
// the mail the SMTP sink received, the unsubscribe page is the one that mail links to, and bounces
// come through the webhook a provider posts to. Not an upstream spec: listmonk's suite has no case
// that follows a mail's links into its charts. Each test makes its own uniquely named list, reader
// and campaigns, and reads counts only for those, so other tests on the server leave them alone.
import { expect } from "@playwright/test";
import {
  TRACKED,
  api,
  linkTo,
  linksIn,
  mailAbout,
  makeList,
  ok,
  requestAdmin,
  signIn,
  test,
  unique,
} from "../helpers.js";

const FINISH = { timeout: 30_000 };
// The whole past and future, for the counts a test makes; the daily buckets are the default.
const RANGE = "from=2020-01-01&to=2099-01-01";
const DAILY = `${RANGE}&interval=day`;

// The dashboard shows counts with thousands separators ("2,738"), and a server is shared by the
// spec files that run on it, so a count can pass 1000. The shown digits are compared with the
// API total, not the text: no locale-dependent formatting is used here.
async function expectShownCount(locator, total) {
  await expect
    .poll(async () => {
      const digits = ((await locator.textContent()) ?? "").replace(/\D/g, "");
      return digits === "" ? null : Number(digits);
    })
    .toBe(Number(total));
}

// Settings this file changed. `afterEach` puts them back through the request fixture, since a test
// that timed out has closed its page by then.
let changed = {};
async function change(page, key, value) {
  if (!(key in changed)) changed[key] = (await ok(page, "/api/settings"))[key];
  await ok(page, `/api/settings/${key}`, "PUT", value);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.afterEach(async ({ request }) => {
  const pending = changed;
  changed = {};
  if (Object.keys(pending).length === 0) return;
  const call = await requestAdmin(request);
  // Every setting is attempted, so one that fails does not leave the others changed for the file's
  // later tests; the failures are reported together at the end.
  const failures = [];
  for (const [key, value] of Object.entries(pending)) {
    try {
      const response = await call(`/api/settings/${key}`, "PUT", value);
      if (response.status !== 200) failures.push(`${key} answered ${response.status}`);
    } catch (error) {
      failures.push(`${key}: ${error.message}`);
    }
  }
  expect(failures, "restoring settings").toEqual([]);
});

// Bounces count only while a subscriber is under its action's count, and an action runs past it.
// The counts are raised far past these tests' bounces and the action does nothing, so no subscriber
// changes status and no membership is unsubscribed by a bounce.
async function bouncesOn(page) {
  await change(page, "bounce.enabled", true);
  await change(page, "bounce.webhooks_enabled", true);
  const quiet = { count: 1000, action: "none" };
  await change(page, "bounce.actions", { soft: quiet, hard: quiet, complaint: quiet });
}

// A list with one reader on it, so every campaign made for it really sends to the reader.
async function audience(page) {
  const list = await makeList(page);
  const person = await ok(page, "/api/subscribers", "POST", {
    email: `${unique("reader")}@example.com`,
    name: "Reader Ann",
    status: "enabled",
    lists: [list.id],
  });
  return { list, person };
}

// A regular HTML campaign to the list. `body` is what the test needs in the mail, and a tracked link
// is `tracked(url)`: the only way a body gets one.
const tracked = (url) => `<p><a href="{{ '${url}' | track_link }}">Go</a></p>`;
async function make(page, list, body = "<p>Hello {{ subscriber.name }}.</p>") {
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Analytics campaign"),
    subject: unique("Analytics subject"),
    type: "regular",
    content_type: "html",
    body,
    lists: [list.id],
  });
}

// Starts the campaign and waits until it has finished sending.
async function send(page, made) {
  await ok(page, `/api/campaigns/${made.id}/status`, "PUT", { status: "running" });
  await expect
    .poll(async () => (await ok(page, `/api/campaigns/${made.id}`)).status, FINISH)
    .toBe("finished");
}

// The rows of one analytics read, as the API answers them: `ids` name campaigns or lists.
const read = (page, resource, type, ids, query) =>
  ok(page, `/api/${resource}/analytics/${type}?${ids.map((id) => `id=${id}`).join("&")}&${query}`);
const total = (rows) => rows.reduce((sum, row) => sum + row.count, 0);
const activity = (page, subscriberID) => ok(page, `/api/subscribers/${subscriberID}/activity`);

// A tracked link followed the way a reader's browser follows it: the redirect is not followed, so
// the test sees the target the link names and the click it counts.
const follow = (page, url) => page.request.get(url, { maxRedirects: 0 });

// Page errors the screen raised, collected for the test to check at its end.
function watch(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

// The bucket a UTC instant falls in, as the analytics store names it for each interval.
const dayStart = (date) => `${date.toISOString().slice(0, 10)}T00:00:00Z`;
const monthStart = (date) => `${date.toISOString().slice(0, 7)}-01T00:00:00Z`;
function weekStart(date) {
  const monday = new Date(dayStart(date));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return dayStart(monday);
}

test("campaign clicks and the links chart count real clicks, per link URL", async ({ page }) => {
  const errors = watch(page);
  await change(page, "privacy.individual_tracking", false);
  const { list, person } = await audience(page);
  const first = `https://example.com/${unique("first")}`;
  const second = `https://example.com/${unique("second")}`;
  const made = await make(page, list, `${tracked(first)}${tracked(second)}`);
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  // The mail's links come in the body's order, first then second; each redirect names its target.
  const [firstClick, secondClick] = [
    ...new Set(linksIn(mail).filter((url) => TRACKED.click.test(new URL(url).pathname))),
  ];
  expect(secondClick, "the mail has two tracked links").toBeTruthy();
  for (const [url, target] of [
    [firstClick, first],
    [firstClick, first],
    [secondClick, second],
  ]) {
    const redirect = await follow(page, url);
    expect(redirect.status()).toBe(307);
    expect(redirect.headers().location).toBe(target);
  }

  expect(total(await read(page, "campaigns", "clicks", [made.id], DAILY))).toBe(3);
  expect(await ok(page, `/api/campaigns/analytics/links?id=${made.id}&${RANGE}`)).toEqual([
    { url: first, count: 2 },
    { url: second, count: 1 },
  ]);
  await page.goto(`/admin/campaigns/analytics?id=${made.id}&${RANGE}`);
  await expect(page.getByTestId("chart-clicks").locator(".title")).toContainText("(3)");
  await expect(page.getByTestId("chart-links").locator("canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the bounces chart counts a bounce the webhook takes for that campaign, and no other", async ({
  page,
}) => {
  const errors = watch(page);
  await bouncesOn(page);
  const { list, person } = await audience(page);
  const named = await make(page, list);
  const other = await make(page, list);
  await ok(page, "/webhooks/bounce", "POST", {
    email: person.email,
    campaign_uuid: named.uuid,
    type: "soft",
    source: unique("analytics"),
  });

  expect(total(await read(page, "campaigns", "bounces", [named.id], DAILY))).toBe(1);
  expect(await read(page, "campaigns", "bounces", [other.id], DAILY)).toEqual([]);
  await page.goto(`/admin/campaigns/analytics?id=${named.id}&${RANGE}`);
  await expect(page.getByTestId("chart-bounces").locator(".title")).toContainText("(1)");
  await page.goto(`/admin/campaigns/analytics?id=${other.id}&${RANGE}`);
  await expect(page.getByTestId("chart-bounces")).toContainText("Nothing here");
  expect(errors).toEqual([]);
});

test("the unique toggle with individual tracking on: two readers, one opening twice, count 3 in total and 2 unique", async ({
  page,
}) => {
  const errors = watch(page);
  await change(page, "privacy.individual_tracking", true);
  const { list, person } = await audience(page);
  const other = await ok(page, "/api/subscribers", "POST", {
    email: `${unique("reader")}@example.com`,
    name: "Reader Ben",
    status: "enabled",
    lists: [list.id],
  });
  const made = await make(page, list);
  await send(page, made);
  // Each reader's own pixel: Ann opens twice, Ben once. A unique count grouped per campaign, rather
  // than per reader, would read 1 here instead of 2.
  const ann = linkTo(await mailAbout(person.email, made.subject), TRACKED.pixel, "the pixel");
  const ben = linkTo(await mailAbout(other.email, made.subject), TRACKED.pixel, "the pixel");
  for (const pixel of [ann, ann, ben]) expect((await page.request.get(pixel)).status()).toBe(200);

  expect(total(await read(page, "campaigns", "views", [made.id], DAILY))).toBe(3);
  expect(total(await read(page, "campaigns", "views", [made.id], `${DAILY}&unique=true`))).toBe(2);
  // The page's own toggle: it is offered only with individual tracking on.
  await page.goto(`/admin/campaigns/analytics?id=${made.id}&${RANGE}`);
  await expect(page.getByTestId("chart-views").locator(".title")).toContainText("(3)");
  await expect(page.getByTestId("chart-unique_views")).toHaveCount(0);
  await page.getByLabel("Show unique counts?").check();
  await Promise.all([
    page.waitForURL(/unique=true/),
    page.getByRole("button", { name: "Search" }).click(),
  ]);
  await expect(page.getByTestId("chart-views").locator(".title")).toContainText("(3)");
  await expect(page.getByTestId("chart-unique_views").locator(".title")).toContainText("(2)");
  expect(errors).toEqual([]);
});

test("day, week, month and hour buckets hold known dates alike, and a bounce now lands in today's bucket", async ({
  page,
}) => {
  await bouncesOn(page);
  const { list, person } = await audience(page);
  const made = await make(page, list);
  // The webhook takes `created_at`, so these bounces sit on known dates inside a fixed range.
  for (const createdAt of ["2026-10-07T12:00:00Z", "2026-10-08T09:00:00Z", "2026-10-14T08:00:00Z"])
    await ok(page, "/webhooks/bounce", "POST", {
      email: person.email,
      campaign_uuid: made.uuid,
      type: "soft",
      created_at: createdAt,
    });

  const october = "from=2026-10-01T00:00&to=2026-10-31T23:59";
  const series = async (interval) =>
    (await read(page, "campaigns", "bounces", [made.id], `${october}&interval=${interval}`)).map(
      ({ timestamp, count }) => [timestamp, count],
    );
  // Seventh and eighth fall in one Monday-based week; the month holds all three.
  expect(await series("hour")).toEqual([
    ["2026-10-07T12:00:00Z", 1],
    ["2026-10-08T09:00:00Z", 1],
    ["2026-10-14T08:00:00Z", 1],
  ]);
  expect(await series("day")).toEqual([
    ["2026-10-07T00:00:00Z", 1],
    ["2026-10-08T00:00:00Z", 1],
    ["2026-10-14T00:00:00Z", 1],
  ]);
  expect(await series("week")).toEqual([
    ["2026-10-05T00:00:00Z", 2],
    ["2026-10-12T00:00:00Z", 1],
  ]);
  expect(await series("month")).toEqual([["2026-10-01T00:00:00Z", 3]]);

  // A bounce with no `created_at` is dated by the server's clock. The range starts today, so the
  // October bounces stay out, and the one row must sit in the bucket that holds the clock's now.
  const before = new Date();
  await ok(page, "/webhooks/bounce", "POST", {
    email: person.email,
    campaign_uuid: made.uuid,
    type: "soft",
  });
  const after = new Date();
  const today = `from=${before.toISOString().slice(0, 10)}&to=2099-01-01`;
  for (const [interval, bucket] of [
    ["day", dayStart],
    ["week", weekStart],
    ["month", monthStart],
  ]) {
    const rows = await read(
      page,
      "campaigns",
      "bounces",
      [made.id],
      `${today}&interval=${interval}`,
    );
    expect(rows, interval).toHaveLength(1);
    expect(rows[0].count, interval).toBe(1);
    // The clock may pass midnight between the two reads, so either side of it is today.
    expect([bucket(before), bucket(after)], interval).toContain(rows[0].timestamp);
  }
});

test("a range that excludes today shows nothing, and one that includes it shows the counts", async ({
  page,
}) => {
  const errors = watch(page);
  const { list, person } = await audience(page);
  const made = await make(page, list, tracked(`https://example.com/${unique("range")}`));
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  await page.request.get(linkTo(mail, TRACKED.pixel, "the open pixel"));
  await follow(page, linkTo(mail, TRACKED.click, "a tracked link"));

  const past = "from=2020-01-01&to=2020-01-02&interval=day";
  expect(await read(page, "campaigns", "views", [made.id], past)).toEqual([]);
  await page.goto(`/admin/campaigns/analytics?id=${made.id}&from=2020-01-01&to=2020-01-02`);
  await expect(page.getByTestId("chart-views").getByText("Nothing here")).toBeVisible();
  await expect(page.getByTestId("chart-clicks").getByText("Nothing here")).toBeVisible();

  await page.goto(`/admin/campaigns/analytics?id=${made.id}&${RANGE}`);
  await expect(page.getByTestId("chart-views").locator(".title")).toContainText("(1)");
  await expect(page.getByTestId("chart-clicks").locator(".title")).toContainText("(1)");
  expect(errors).toEqual([]);
});

test("the list's unsubscriptions chart counts a reader who unsubscribes through the mail's link", async ({
  page,
}) => {
  const errors = watch(page);
  const { list, person } = await audience(page);
  const made = await make(
    page,
    list,
    '<p>Hello {{ subscriber.name }}.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  );
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  // The unsubscribe link itself, not the preferences link that has the same path.
  const unsubscribe = linksIn(mail).find((url) => {
    const found = new URL(url);
    return TRACKED.unsubscribe.test(found.pathname) && !found.searchParams.has("manage");
  });
  expect(unsubscribe, "the mail links to the unsubscribe page").toBeTruthy();
  await page.goto(unsubscribe);
  await expect(page.locator("#btn-unsub")).toBeVisible();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);

  expect(total(await read(page, "lists", "unsubscriptions", [list.id], DAILY))).toBe(1);
  await page.goto(`/admin/lists/analytics?id=${list.id}&${RANGE}`);
  await expect(page.getByTestId("chart-subscriptions")).toContainText("(Unsubscribed: 1)");
  expect(errors).toEqual([]);
});

test("the dashboard's counts and charts move after a real view and click", async ({ page }) => {
  const errors = watch(page);
  const dashboard = async () => ({
    counts: (await api(page, "/api/dashboard/counts")).body.data,
    charts: (await api(page, "/api/dashboard/charts")).body.data,
  });
  const sum = (days) => days.reduce((running, day) => running + day.count, 0);
  const before = await dashboard();

  const { list, person } = await audience(page);
  const made = await make(page, list, tracked(`https://example.com/${unique("dashboard")}`));
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  await page.request.get(linkTo(mail, TRACKED.pixel, "the open pixel"));
  await follow(page, linkTo(mail, TRACKED.click, "a tracked link"));

  const after = await dashboard();
  expect(after.counts.campaigns.total).toBe(before.counts.campaigns.total + 1);
  expect(after.counts.messages).toBe((before.counts.messages ?? 0) + 1);
  expect(sum(after.charts.campaign_views) - sum(before.charts.campaign_views)).toBe(1);
  expect(sum(after.charts.link_clicks) - sum(before.charts.link_clicks)).toBe(1);

  await page.goto("/admin");
  await expectShownCount(page.getByTestId("stat-campaigns"), after.counts.campaigns.total);
  await expectShownCount(page.getByTestId("stat-messages"), after.counts.messages ?? 0);
  await expect(page.locator(".chart-box").nth(0).locator("canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("two campaigns selected together show both series, each with its own count", async ({
  page,
}) => {
  const errors = watch(page);
  const { list, person } = await audience(page);
  const first = await make(page, list);
  const second = await make(page, list);
  await send(page, first);
  await send(page, second);
  // The reader opens the first campaign's mail twice and the second's once.
  const firstPixel = linkTo(
    await mailAbout(person.email, first.subject),
    TRACKED.pixel,
    "the first pixel",
  );
  const secondPixel = linkTo(
    await mailAbout(person.email, second.subject),
    TRACKED.pixel,
    "the second pixel",
  );
  await page.request.get(firstPixel);
  await page.request.get(firstPixel);
  await page.request.get(secondPixel);

  const rows = await read(page, "campaigns", "views", [first.id, second.id], DAILY);
  expect(total(rows)).toBe(3);
  const views = page.getByTestId("chart-views");
  await page.goto(`/admin/campaigns/analytics?id=${first.id}&id=${second.id}&${RANGE}`);
  await expect(views.locator(".title")).toContainText("(3)");
  await expect(views).toContainText(first.name);
  await expect(views).toContainText(second.name);
  // The legend lists the campaigns in the order they were selected; each count leads its entry.
  await expect(views.getByTestId("legend-count")).toHaveText([/^2\b/, /^1\b/]);
  expect(errors).toEqual([]);
});

test("a mail sent with individual tracking on keeps counting after it is turned off, but not for the reader", async ({
  page,
}) => {
  const errors = watch(page);
  await change(page, "privacy.individual_tracking", true);
  const { list, person } = await audience(page);
  const target = `https://example.com/${unique("private")}`;
  const made = await make(page, list, tracked(target));
  await send(page, made);
  // Tracking was on when this was sent, so its pixel and link name the reader.
  const mail = await mailAbout(person.email, made.subject);
  const pixel = linkTo(mail, TRACKED.pixel, "the open pixel");
  const click = linkTo(mail, TRACKED.click, "a tracked link");

  await change(page, "privacy.individual_tracking", false);
  expect((await page.request.get(pixel)).status()).toBe(200);
  const redirect = await follow(page, click);
  expect(redirect.status()).toBe(307);
  expect(redirect.headers().location).toBe(target);

  // Both events are counted for the campaign, and neither is tied to the reader.
  expect(total(await read(page, "campaigns", "views", [made.id], DAILY))).toBe(1);
  expect(total(await read(page, "campaigns", "clicks", [made.id], DAILY))).toBe(1);
  const reader = await activity(page, person.id);
  expect(reader.campaign_views.find((item) => item.subject === made.subject)).toBeUndefined();
  expect(reader.link_clicks.find((item) => item.url === target)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("the analytics screens and the dashboard render with real data, with no page error and no refused chart", async ({
  page,
}) => {
  const errors = watch(page);
  const { list, person } = await audience(page);
  const made = await make(page, list, tracked(`https://example.com/${unique("sweep")}`));
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  await page.request.get(linkTo(mail, TRACKED.pixel, "the open pixel"));
  await follow(page, linkTo(mail, TRACKED.click, "a tracked link"));

  await page.goto(`/admin/campaigns/analytics?id=${made.id}&${RANGE}`);
  await expect(page.getByTestId("chart-views").locator(".title")).toContainText("(1)");
  await expect(page.locator(".analytics [role=alert]:visible")).toHaveCount(0);

  await page.goto(`/admin/lists/analytics?id=${list.id}&${RANGE}`);
  await expect(page.getByTestId("chart-subscriptions").locator(".title")).toContainText("(1)");
  await expect(page.locator(".analytics [role=alert]:visible")).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.getByTestId("stat-messages")).not.toHaveText("0");
  await expect(page.locator("[role=alert]:visible")).toHaveCount(0);
  expect(errors).toEqual([]);
});
