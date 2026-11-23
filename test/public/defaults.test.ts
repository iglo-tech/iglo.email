// B130 (D128): public page defaults. A subscriber with no public list to manage has no manage link and no
// preference form, and the manage view keeps the privacy actions; `privacy.allow_preferences` stays the
// explicit switch. The archive index links its feed in text (no broken icon), an archive page is
// embeddable (D122 leaves the archive unchanged), and an archived page's Google font link sits after the
// doctype when its template has no head. Through HTTP on the public fixture, with the SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open(overrides: Partial<Record<string, unknown>> = {}) {
  const f = await publicFixture();
  fixtures.push(f);
  Object.assign(f.overrides, { siteName: "Defaults Co", subscriptionPage: true, ...overrides });
  return f;
}

/** A subscriber on one list, and the unsubscribe page of a marketing send to that list. */
async function pageFor(f: PublicFixture, email: string, listId: number, name: string) {
  const id = await f.subscriber(email, "Ada", { lists: [listId] });
  const uuid = asBody<string>((await f.json(`/api/subscribers/${id}`)).body.data.uuid);
  const template = await f.template(`<a href="{{ unsubscribe_url }}">unsub</a>`, name);
  const sent = await f.tx({
    subscriber_id: id,
    template_id: template,
    kind: "marketing",
    list_id: listId,
    data: {},
  });
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  return { id, template, page: `/m/${send}/unsubscribe/${uuid}` };
}

test("a subscriber with a public list to manage gets the manage link, and the manage view its preference form", async () => {
  const f = await open();
  const news = await f.list("News", "public");
  const { page } = await pageFor(f, "ada@example.test", news.id, "News");

  const unsubscribe = await (await f.request(page)).text();
  expect(unsubscribe).toContain('href="?manage=true"');
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).toContain('class="manage-form"');
  expect(manage).toContain('name="name"');
  expect(manage).toContain('id="data-form"');
});

test("with no public list to manage, there is no manage link and no preference form, and the privacy actions stay", async () => {
  const f = await open();
  const members = await f.list("Members", "private");
  const { page } = await pageFor(f, "ada@example.test", members.id, "Members");

  const unsubscribe = await (await f.request(page)).text();
  expect(unsubscribe).toContain('id="data-form"');
  expect(unsubscribe).not.toContain('href="?manage=true"');
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).toContain('id="data-form"');
  expect(manage).not.toContain('class="manage-form"');
  expect(manage).not.toContain('name="name"');
  expect(manage).not.toContain('name="l"');
  // The privacy actions are the view's content, so it does not say there is nothing to manage.
  expect(manage).not.toContain("There is nothing to manage here.");
});

test("privacy.allow_preferences off hides the manage link and the manage view even with a public list", async () => {
  const f = await open({ allowPreferences: false });
  const news = await f.list("News", "public");
  const { page } = await pageFor(f, "ada@example.test", news.id, "News");

  const unsubscribe = await (await f.request(page)).text();
  expect(unsubscribe).not.toContain('href="?manage=true"');
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).not.toContain('class="manage-form"');
});

test("the archive index links its feed in text, and an archive page can be framed, as D122 leaves it", async () => {
  const f = await open({ archive: true });
  const template = await f.template("<!doctype html>\n<p>{{ content | raw }}</p>", "Bare archive");
  const index = await f.request("/archive");
  expect(index.status).toBe(200);
  const html = await index.text();
  // The text link replaces the icon that was never shipped: no image points at rss.svg.
  expect(html).toContain(">RSS</a>");
  expect(html).not.toContain("rss.svg");
  expect(index.headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
  expect(index.headers.get("x-frame-options")).toBeNull();

  const list = await f.list("Archive readers", "public");
  const uuid = f.deliveredCampaign([], [list.id]);
  f.db.run(
    "UPDATE campaigns SET archive = 1, archive_slug = 'framed', archive_template_id = ?, status = 'finished' WHERE uuid = ?",
    [template, uuid],
  );
  const page = await f.request("/archive/framed");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
  expect(page.headers.get("x-frame-options")).toBeNull();
});

test("an archived page whose template has no head gets the font link after the doctype, not before it", async () => {
  const f = await open({ font: "Lora", archive: true });
  const template = await f.template("<!doctype html>\n<p>{{ content | raw }}</p>", "Bare archive");
  const list = await f.list("Bare readers", "public");
  const uuid = f.deliveredCampaign([], [list.id]);
  f.db.run(
    "UPDATE campaigns SET archive = 1, archive_slug = 'bare', archive_template_id = ?, status = 'finished' WHERE uuid = ?",
    [template, uuid],
  );
  const html = await (await f.request("/archive/bare")).text();
  // The doctype stays first, so the page is not parsed in quirks mode; the link follows it.
  expect(
    html.startsWith('<!doctype html><link rel="stylesheet" href="https://fonts.googleapis.com/'),
  ).toBe(true);
  expect(html).toContain("<p>");
});

test("a double opt-in subscriber who confirmed and opens the opt-in mail's manage link gets a page that says so, not a blank one", async () => {
  const f = await open({ siteUrl: "https://example.test/" });
  const list = await f.list("Double", "public", "double");
  const id = await f.subscriber("ada@example.test", "Ada", { lists: [list.id] });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  await f.fresh(`/subscription/optin/${uuid}`, `confirm=true&l=${list.uuid}`);
  expect(await f.status(id, list.id)).toBe("confirmed");

  // The opt-in mail's manage link pairs the dummy campaign UUID with the subscriber (D128).
  const manage = await (
    await f.request(`/subscription/00000000-0000-0000-0000-000000000000/${uuid}?manage=true`)
  ).text();
  expect(manage).toContain("There is nothing to manage here.");
  expect(manage).toContain('href="https://example.test/"');
  expect(manage).not.toContain('class="manage-form"');
  expect(manage).not.toContain('id="data-form"');
});

test("with no privacy action offered, a private-only subscriber's manage view says there is nothing to manage", async () => {
  const f = await open({ allowExport: false, allowWipe: false });
  const members = await f.list("Members", "private");
  const { page } = await pageFor(f, "ada@example.test", members.id, "Members");

  const unsubscribe = await (await f.request(page)).text();
  expect(unsubscribe).not.toContain('href="?manage=true"');
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).toContain("There is nothing to manage here.");
  expect(manage).not.toContain('id="data-form"');
  expect(manage).not.toContain('class="manage-form"');
});
