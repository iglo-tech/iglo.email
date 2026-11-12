// The public archive, the web view, the open pixel, tracked links and the /m/ pages, as a reader
// meets them (docs/design/13-e2e-coverage.md, E5). Not an upstream spec: listmonk's suite does not
// open the links its mails carry. Each test makes its own uniquely named list, readers, templates
// and campaigns through the API, then takes every tracking and web-view URL it follows from the mail
// the SMTP sink received for its own address. No such URL is built from an API UUID, except where a
// test swaps one on purpose to show that a wrong one changes nothing.
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { corpus } from "../hostile-html.js";
import { api, makeList, mailFor, ok, requestAdmin, signIn, test, unique } from "../helpers.js";

const FINISH = { timeout: 30_000 };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The paths the mail's links take (src/campaigns/render.ts, src/campaigns/runner/runner.ts).
const VIEW = new RegExp(`^/campaign/${UUID}/${UUID}$`, "i");
const PIXEL = new RegExp(`^/campaign/${UUID}/${UUID}/px\\.png$`, "i");
const CLICK = new RegExp(`^/link/${UUID}/${UUID}/${UUID}$`, "i");
const MESSAGE_UNSUBSCRIBE = new RegExp(`^/m/${UUID}/unsubscribe/${UUID}$`, "i");

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
  for (const [key, value] of Object.entries(pending)) {
    const response = await call(`/api/settings/${key}`, "PUT", value);
    expect(response.status, `restoring ${key}`).toBe(200);
  }
});

// A reader on a list, made through the API. Its UUID is what the pages name.
const reader = (page, list, name = "Reader Ann") =>
  ok(page, "/api/subscribers", "POST", {
    email: `${unique("reader")}@example.com`,
    name,
    status: "enabled",
    lists: [list.id],
  });

// A list with one reader on it, so every campaign on it really sends and starts.
async function setup(page) {
  const list = await makeList(page);
  const person = await reader(page, list);
  return { list, person };
}

// A campaign layout with its marker, which the archive pages show when they use it.
const layout = (page, marker) =>
  ok(page, "/api/templates", "POST", {
    name: unique(marker),
    type: "campaign",
    body: `<p>${marker}</p>{{ content | raw }}`,
  });

// A regular HTML campaign to one list. Its body greets the reader, links out to `target` through the
// `track_link` filter (the only way a body gets a tracked link) and offers the web view, so one send
// yields every URL these tests follow.
function draft(list, { target = `https://example.com/${unique("target")}`, ...extra } = {}) {
  return {
    name: unique("Public campaign"),
    subject: unique("Public subject"),
    type: "regular",
    content_type: "html",
    body: `<p>Hello {{ subscriber.name }}.</p><p><a href="{{ '${target}' | track_link }}">Tracked link</a></p><p><a href="{{ message_url }}">View in browser</a></p>`,
    lists: [list.id],
    ...extra,
  };
}

const create = (page, body) => ok(page, "/api/campaigns", "POST", body);

// Starts the campaign and waits until it has finished sending.
async function send(page, made) {
  await ok(page, `/api/campaigns/${made.id}/status`, "PUT", { status: "running" });
  await expect
    .poll(async () => (await ok(page, `/api/campaigns/${made.id}`)).status, FINISH)
    .toBe("finished");
}

const views = async (page, id) => (await ok(page, `/api/campaigns/${id}`)).views;
const clicks = async (page, id) => (await ok(page, `/api/campaigns/${id}`)).clicks;
const activity = (page, subscriberID) => ok(page, `/api/subscribers/${subscriberID}/activity`);

// Every absolute link in a mail body, with HTML's `&amp;` read as `&`, as a reader's click would.
const linksIn = (mail) =>
  [...mail.body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0].replaceAll("&amp;", "&"),
  );

// The one link in a mail whose path matches; the test fails if the mail has none.
function linkTo(mail, pattern, what) {
  const found = linksIn(mail).find((url) => pattern.test(new URL(url).pathname));
  expect(found, `the mail links to ${what}`).toBeTruthy();
  return found;
}

// The same link URL with another link UUID in its path: `/link/<link>/<campaign>/<subscriber>`.
const withLink = (url, linkUUID) => {
  const parts = new URL(url).pathname.split("/");
  parts[2] = linkUUID;
  return `${new URL(url).origin}${parts.join("/")}`;
};
const linkUUIDOf = (url) => new URL(url).pathname.split("/")[2];

// The mail a campaign sent to one address, by its subject. Waited for: the reader may already have
// the mail of an earlier campaign, which is not the one asked for.
async function mailAbout(email, subject) {
  let found;
  await expect(async () => {
    found = (await mailFor(email)).find((mail) => mail.subject === subject);
    expect(found, `a mail with the subject "${subject}"`).toBeTruthy();
  }).toPass({ timeout: 15_000 });
  return found;
}

test("the archive index lists archived campaigns and not the others", async ({ page }) => {
  const { list } = await setup(page);
  const slug = unique("index");
  const archived = await create(page, draft(list, { archive: true, archive_slug: slug }));
  const hidden = await create(page, draft(list, { archive: false }));
  await send(page, archived);
  await send(page, hidden);

  await page.goto("/archive");
  await expect(page.getByRole("link", { name: archived.subject, exact: true })).toHaveAttribute(
    "href",
    new RegExp(`/archive/${slug}$`),
  );
  await expect(page.getByRole("link", { name: hidden.subject, exact: true })).toHaveCount(0);
});

test("the archive page renders the body with the archive template and the archive's own subscriber", async ({
  page,
}) => {
  const { list, person } = await setup(page);
  const campaignLayout = await layout(page, "CAMPAIGN LAYOUT");
  const archiveLayout = await layout(page, "ARCHIVE LAYOUT");
  const slug = unique("layout");
  const made = await create(
    page,
    draft(list, {
      template_id: campaignLayout.id,
      body: "<p>Dear {{ subscriber.name }} at {{ subscriber.email }}.</p>",
    }),
  );
  // The archive settings as the campaign's archive tab sends them, once the campaign exists.
  await ok(page, `/api/campaigns/${made.id}/archive`, "PUT", {
    archive: true,
    archive_slug: slug,
    archive_template_id: archiveLayout.id,
    // The archive shows this stored subscriber, never the reader the mail went to.
    archive_meta: { name: "Archive Editor", email: "archive-editor@example.test" },
  });
  await send(page, made);
  await mailFor(person.email);

  await page.goto(`/archive/${slug}`);
  await expect(page.locator("body")).toContainText("ARCHIVE LAYOUT");
  await expect(page.locator("body")).not.toContainText("CAMPAIGN LAYOUT");
  await expect(page.locator("body")).toContainText(
    "Dear Archive Editor at archive-editor@example.test.",
  );
  await expect(page.locator("body")).not.toContainText(person.name);
  await expect(page.locator("body")).not.toContainText(person.email);
});

test("/archive/latest and archive.xml show the newest archived campaign, and the feed parses", async ({
  page,
}) => {
  const { list } = await setup(page);
  const older = await create(page, draft(list, { archive: true, archive_slug: unique("older") }));
  await send(page, older);
  const marker = unique("Latest body");
  const slug = unique("newest");
  const newest = await create(
    page,
    draft(list, {
      archive: true,
      archive_slug: slug,
      body: `<p>${marker}</p>`,
    }),
  );
  await send(page, newest);

  await page.goto(`/archive/latest`);
  await expect(page.locator("body")).toContainText(marker);

  const feed = await page.request.get("/archive.xml");
  expect(feed.status()).toBe(200);
  const parsed = await page.evaluate(
    (text) => {
      const doc = new DOMParser().parseFromString(text, "text/xml");
      const items = [...doc.querySelectorAll("item")];
      return {
        error: doc.querySelector("parsererror") !== null,
        first: items[0] && {
          title: items[0].querySelector("title").textContent,
          link: items[0].querySelector("link").textContent,
        },
      };
    },
    await feed.text(),
  );
  expect(parsed.error, "archive.xml is well-formed XML").toBe(false);
  expect(parsed.first).toEqual({
    title: newest.subject,
    link: expect.stringMatching(new RegExp(`/archive/${slug}$`)),
  });
});

test("with the public archive off, its pages and feed answer not found", async ({ page }) => {
  const { list } = await setup(page);
  const slug = unique("off");
  const made = await create(page, draft(list, { archive: true, archive_slug: slug }));
  await send(page, made);
  await expect.poll(async () => (await page.request.get(`/archive/${slug}`)).status()).toBe(200);

  await change(page, "app.enable_public_archive", false);
  for (const path of ["/archive", "/archive/latest", `/archive/${slug}`, "/archive.xml"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(404);
  }
  expect((await page.request.get("/api/public/archive")).status()).toBe(404);
});

test("a hostile archived name or subject renders as text on the archive pages", async ({
  page,
}) => {
  // The corpus entries from hostile-html.js: a script element and an image whose error handler
  // sets a flag. Neither may become markup or run on the archive pages.
  const hostileName = corpus["script forms"][0];
  const hostileSubject = corpus["event handlers"][0];
  const { list } = await setup(page);
  const slug = unique("hostile");
  const made = await create(
    page,
    draft(list, {
      name: hostileName,
      subject: hostileSubject,
      archive: true,
      archive_slug: slug,
      body: "<p>Named {{ campaign.name }}</p>",
    }),
  );
  await send(page, made);

  await page.goto("/archive");
  await expect(page.getByRole("link", { name: hostileSubject, exact: true })).toBeVisible();
  expect(await page.locator("img[src=x]").count()).toBe(0);

  await page.goto(`/archive/${slug}`);
  await expect(page.locator("body")).toContainText(`Named ${hostileName}`);
  expect(await page.locator("img[src=x]").count()).toBe(0);
  expect(await page.locator("script", { hasText: "__hostile" }).count()).toBe(0);
  expect(await page.evaluate(() => window.__hostile)).toBeUndefined();

  const feed = await page.request.get("/archive.xml");
  const title = await page.evaluate(
    (text) => {
      const doc = new DOMParser().parseFromString(text, "text/xml");
      return doc.querySelector("item title")?.textContent ?? null;
    },
    await feed.text(),
  );
  expect(title).toBe(hostileSubject);
});

test("the web view link in a received mail opens the message for that reader and records no view", async ({
  page,
}) => {
  const { list, person } = await setup(page);
  const made = await create(page, draft(list));
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  const view = linkTo(mail, VIEW, "the web view");

  await page.goto(view);
  await expect(page.locator("body")).toContainText("Hello Reader Ann.");
  // The web view is a sandboxed document with no access to the origin, so the API is read from a
  // same-origin page once the view is closed.
  await page.goto("/api/health");
  // A web view is a page, not a tracking event: only the open pixel counts a view.
  expect(await views(page, made.id)).toBe(0);
  expect((await activity(page, person.id)).campaign_views).toEqual([]);
});

test("the open pixel from a received mail is a PNG and records a view; with tracking disabled it records nothing", async ({
  page,
}) => {
  const { list, person } = await setup(page);
  const made = await create(page, draft(list));
  await send(page, made);
  const mail = await mailAbout(person.email, made.subject);
  const pixel = linkTo(mail, PIXEL, "the open pixel");
  expect(await views(page, made.id)).toBe(0);

  const counted = await page.request.get(pixel);
  expect(counted.status()).toBe(200);
  expect(counted.headers()["content-type"]).toBe("image/png");
  expect([...(await counted.body()).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(await views(page, made.id)).toBe(1);

  await change(page, "privacy.disable_tracking", true);
  const silent = await page.request.get(pixel);
  expect(silent.status()).toBe(200);
  expect(silent.headers()["content-type"]).toBe("image/png");
  expect([...(await silent.body()).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(await views(page, made.id)).toBe(1);
});

test("with individual tracking off a view or click is counted without the reader; with it on, it is tied to the reader", async ({
  page,
}) => {
  const { list, person } = await setup(page);

  await change(page, "privacy.individual_tracking", false);
  const offTarget = `https://example.com/${unique("off")}`;
  const off = await create(page, draft(list, { target: offTarget }));
  await send(page, off);
  const offMail = await mailAbout(person.email, off.subject);
  await page.request.get(linkTo(offMail, PIXEL, "the open pixel"));
  const offClick = await page.request.get(linkTo(offMail, CLICK, "a tracked link"), {
    maxRedirects: 0,
  });
  expect(offClick.status()).toBe(307);
  expect(await views(page, off.id)).toBe(1);
  expect(await clicks(page, off.id)).toBe(1);
  const anonymous = await activity(page, person.id);
  expect(anonymous.campaign_views).toEqual([]);
  expect(anonymous.link_clicks).toEqual([]);

  await change(page, "privacy.individual_tracking", true);
  const onTarget = `https://example.com/${unique("on")}`;
  const on = await create(page, draft(list, { target: onTarget }));
  await send(page, on);
  const onMail = await mailAbout(person.email, on.subject);
  await page.request.get(linkTo(onMail, PIXEL, "the open pixel"));
  await page.request.get(linkTo(onMail, CLICK, "a tracked link"), { maxRedirects: 0 });
  expect(await views(page, on.id)).toBe(1);
  expect(await clicks(page, on.id)).toBe(1);
  const tied = await activity(page, person.id);
  expect(tied.campaign_views.find((item) => item.subject === on.subject)?.view_count).toBe(1);
  expect(tied.link_clicks.find((item) => item.url === onTarget)?.click_count).toBe(1);
});

test("a tracked link in a received mail redirects to its target and records a click; an unknown link or another campaign's link is refused", async ({
  page,
}) => {
  const { list, person } = await setup(page);
  const target = `https://example.com/${unique("destination")}`;
  const made = await create(page, draft(list, { target }));
  const other = await create(page, draft(list));
  await send(page, made);
  await send(page, other);
  const mail = await mailAbout(person.email, made.subject);
  const click = linkTo(mail, CLICK, "a tracked link");

  const redirected = await page.request.get(click, { maxRedirects: 0 });
  expect(redirected.status()).toBe(307);
  expect(redirected.headers().location).toBe(target);
  expect(await clicks(page, made.id)).toBe(1);

  // A link UUID the server never issued: refused, and nothing is recorded.
  const unknown = withLink(click, randomUUID());
  expect((await page.request.get(unknown, { maxRedirects: 0 })).status()).toBe(400);

  // Another campaign's registered link under this campaign's path: not found, and nothing is recorded.
  const otherMail = await mailAbout(person.email, other.subject);
  const foreign = withLink(click, linkUUIDOf(linkTo(otherMail, CLICK, "another campaign's link")));
  expect((await page.request.get(foreign, { maxRedirects: 0 })).status()).toBe(404);
  expect(await clicks(page, made.id)).toBe(1);
});

test("the unsubscribe page from a received marketing mail shows its list; another reader's UUID on it is not found", async ({
  page,
}) => {
  const { list, person } = await setup(page);
  const other = await reader(page, list, "Reader Bo");
  const template = await ok(page, "/api/templates", "POST", {
    name: unique("Marketing"),
    type: "tx",
    subject: unique("Marketing subject"),
    body: '<p>Marketing news for {{ subscriber.name }}.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  });
  const sent = await api(page, "/api/tx", "POST", {
    kind: "marketing",
    list_id: list.id,
    template_id: template.id,
    subscriber_emails: [person.email],
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  const [mail] = await mailFor(person.email);
  const unsubscribe = linkTo(mail, MESSAGE_UNSUBSCRIBE, "the unsubscribe page");
  await page.goto(unsubscribe);
  await expect(page.locator("#btn-unsub")).toBeVisible();
  await expect(page.locator("body")).toContainText(
    "Do you want to unsubscribe from this mailing list?",
  );

  const wrong = unsubscribe.replace(new RegExp(`${UUID}$`, "i"), other.uuid);
  expect((await page.request.get(wrong)).status()).toBe(404);
});
