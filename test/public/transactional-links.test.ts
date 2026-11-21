// B126 round 2 (D123, D126): what a transactional send's unsubscribe link says and does. Its page
// reads the subscriber's memberships: pending opt-ins are cancelled by its form (naming public lists
// only), a subscriber with no open membership sees the already-unsubscribed page, and a confirmed
// subscriber keeps the manage view (or, with preferences off, a page that points to a marketing mail's
// link). The page's export and wipe act through its own paired path. Through HTTP, on the public
// fixture, with private single and double opt-in lists beside public ones.
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const brandUrl = "https://brand.example.test/";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open(overrides: Partial<Record<string, unknown>> = {}) {
  const f = await publicFixture();
  fixtures.push(f);
  Object.assign(f.overrides, overrides);
  return f;
}

const receipt = (f: PublicFixture) => f.template("<p>Your receipt</p>", "Receipt");

/** A transactional send to one subscriber; its page and the subscriber's UUID. */
async function txPage(f: PublicFixture, template: number, id: number) {
  const uuid = (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const sent = await f.tx({ subscriber_id: id, template_id: template });
  expect(sent.status).toBe(200);
  const send = sent.body.data.sends[0].uuid as string;
  return { send, uuid, page: `/m/${send}/unsubscribe/${uuid}` };
}

/** An admin's change of a subscriber's lists, as the subscriber list API makes it. */
const change = (f: PublicFixture, id: number, action: string, lists: number[], status?: string) =>
  f.json("/api/subscribers/lists", "PUT", {
    ids: [id],
    action,
    target_list_ids: lists,
    ...(status ? { status } : {}),
  });

test("pending opt-ins are named for their public lists only, and the button cancels only them", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const monthly = await f.list("Monthly", "public", "double");
  const members = await f.list("Members", "private", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [monthly.id, members.id] });
  expect(await f.status(ada, monthly.id)).toBe("unconfirmed");
  const link = await txPage(f, template, ada);

  const asked = await (await f.request(link.page)).text();
  expect(asked).toContain(
    "You have not confirmed your subscription to Monthly. Do you want to cancel it?",
  );
  expect(asked).not.toContain("Members");
  expect(asked).not.toContain("You have unsubscribed successfully.");
  expect(asked).toContain('id="btn-unsub"');
  expect(asked).toContain("Cancel pending subscriptions");
  expect(asked).not.toContain('class="manage-form"');

  const cancelled = await (await f.fresh(link.page, "")).text();
  expect(cancelled).toContain("Your pending subscription was cancelled.");
  expect(cancelled).not.toContain("You have unsubscribed successfully.");
  expect(await f.status(ada, monthly.id)).toBe("unsubscribed");
  expect(await f.status(ada, members.id)).toBe("unsubscribed");
});

test("a pending opt-in on a private list is named generically", async () => {
  const f = await open();
  const template = await receipt(f);
  const members = await f.list("Members", "private", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [members.id] });
  const link = await txPage(f, template, ada);

  const asked = await (await f.request(link.page)).text();
  expect(asked).toContain("You have not confirmed a subscription. Do you want to cancel it?");
  expect(asked).not.toContain("Members");
  expect(asked).toContain("Cancel pending subscriptions");

  const cancelled = await (await f.fresh(link.page, "")).text();
  expect(cancelled).toContain("Your pending subscription was cancelled.");
  expect(await f.status(ada, members.id)).toBe("unsubscribed");

  // Nothing is pending now, and nothing is open: the page is the already-unsubscribed one.
  const again = await (await f.request(link.page)).text();
  expect(again).toContain("You are already unsubscribed from these emails.");
  expect(again).not.toContain("Members");
  expect(again).not.toContain("Cancel pending subscriptions");
});

test("the cancel form leaves a confirmed membership alone, and says so on the next visit", async () => {
  const f = await open();
  const template = await receipt(f);
  const monthly = await f.list("Monthly", "public", "double");
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [monthly.id, news.id] });
  expect((await change(f, ada, "add", [news.id], "confirmed")).status).toBe(200);
  expect(await f.status(ada, news.id)).toBe("confirmed");
  const link = await txPage(f, template, ada);

  // Pending opt-ins are still the open business, so the form cancels them and nothing else.
  expect(await (await f.request(link.page)).text()).toContain("Cancel pending subscriptions");
  expect(await (await f.fresh(link.page, "")).text()).toContain(
    "Your pending subscription was cancelled.",
  );
  expect(await f.status(ada, monthly.id)).toBe("unsubscribed");
  expect(await f.status(ada, news.id)).toBe("confirmed");

  const after = await (await f.request(link.page)).text();
  expect(after).toContain('class="manage-form"');
  expect(after).not.toContain("Cancel pending subscriptions");
  expect(after).not.toContain("You have unsubscribed successfully.");
});

test("with no open membership, the page says already unsubscribed, on private and public lists alike", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const members = await f.list("Members", "private");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, members.id] });
  expect((await change(f, ada, "unsubscribe", [news.id, members.id])).status).toBe(200);
  const bob = await f.subscriber("bob@example.test", "Bob", {});
  const adaLink = await txPage(f, template, ada);
  const bobLink = await txPage(f, template, bob);

  for (const link of [adaLink, bobLink]) {
    const html = await (await f.request(link.page)).text();
    expect(html).toContain("You are already unsubscribed from these emails.");
    expect(html).not.toContain("News");
    expect(html).not.toContain("Members");
    expect(html).not.toContain('id="btn-unsub"');
    expect(html).not.toContain("Do you want to unsubscribe");
    expect(html).toContain('id="data-form"');
    expect(html).toContain('href="?manage=true"');
    expect(html).not.toContain("Back to Brand Co");
  }

  // The page keeps its back link once the operator sets a site URL.
  Object.assign(f.overrides, { siteUrl: brandUrl });
  expect(await (await f.request(adaLink.page)).text()).toContain(
    `<a href="${brandUrl}">Back to Brand Co</a>`,
  );
  // With ?manage=true the manage view is shown, as preferences allow.
  expect(await (await f.request(`${adaLink.page}?manage=true`)).text()).toContain(
    'class="manage-form"',
  );
});

test("with preferences off, the already-unsubscribed page has no manage link", async () => {
  const f = await open({ allowPreferences: false });
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  expect((await change(f, ada, "unsubscribe", [news.id])).status).toBe(200);
  const link = await txPage(f, template, ada);

  for (const path of [link.page, `${link.page}?manage=true`]) {
    const html = await (await f.request(path)).text();
    expect(html).toContain("You are already unsubscribed from these emails.");
    expect(html).not.toContain('class="manage-form"');
    expect(html).not.toContain('href="?manage=true"');
    expect(html).toContain('id="data-form"');
  }
});

test("a confirmed subscriber gets the manage view, and with preferences off a pointer to a marketing link", async () => {
  const f = await open({ siteName: "Brand Co", siteUrl: brandUrl });
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const members = await f.list("Members", "private");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, members.id] });
  expect((await change(f, ada, "add", [news.id, members.id], "confirmed")).status).toBe(200);
  const link = await txPage(f, template, ada);

  // Preferences on: the manage view lists the public list, with no unsubscribe button.
  const manage = await (await f.request(link.page)).text();
  expect(manage).toContain('class="manage-form"');
  expect(manage).toContain(`value="${news.uuid}"`);
  expect(manage).not.toContain("Members");
  expect(manage).not.toContain("Cancel pending subscriptions");
  expect(manage).not.toContain("Do you want to unsubscribe");
  expect(manage).toContain('id="data-form"');

  // Preferences off: the page says where to unsubscribe, and keeps the privacy forms and back link.
  Object.assign(f.overrides, { allowPreferences: false });
  for (const path of [link.page, `${link.page}?manage=true`]) {
    const html = await (await f.request(path)).text();
    expect(html).toContain(
      "This message was sent about your account with Brand Co. To stop other emails, use the unsubscribe link in one of them.",
    );
    expect(html).not.toContain('class="manage-form"');
    expect(html).not.toContain("Cancel pending subscriptions");
    expect(html).not.toContain('id="btn-unsub"');
    expect(html).toContain('id="data-form"');
    expect(html).toContain(`<a href="${brandUrl}">Back to Brand Co</a>`);
  }

  // A POST here cannot end a confirmed membership: the page answers the same pointer.
  const posted = await (await f.fresh(link.page, "")).text();
  expect(posted).toContain("To stop other emails, use the unsubscribe link in one of them.");
  expect(await f.status(ada, news.id)).toBe("confirmed");
  expect(await f.status(ada, members.id)).toBe("confirmed");
});

test("a transactional send's privacy forms act through its own paired path", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const link = await txPage(f, template, ada);

  const page = await (await f.request(link.page)).text();
  expect(page).toContain(`/m/${link.send}/export/${link.uuid}`);
  expect(page).toContain(`/m/${link.send}/wipe/${link.uuid}`);

  const exported = await f.fresh(`/m/${link.send}/export/${link.uuid}`);
  expect(exported.status).toBe(200);
  expect(await exported.text()).toContain("Your data has been e-mailed to you as an attachment.");

  // The wipe asks first, and "Keep my data" returns to this page's manage view (preferences on).
  const asked = await (await f.fresh(`/m/${link.send}/wipe/${link.uuid}`)).text();
  expect(asked).toContain(
    `<a href="/m/${link.send}/unsubscribe/${link.uuid}?manage=true">Keep my data</a>`,
  );
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(200);
  expect((await f.fresh(`/m/${link.send}/wipe/${link.uuid}?confirm=true`)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(400);
});

test("a transactional send cannot blocklist, and a random subscriber UUID pairs nobody", async () => {
  const f = await open();
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news.id] });
  await change(f, ada, "add", [news.id], "confirmed");
  const link = await txPage(f, template, ada);
  const bobUuid = (await f.json(`/api/subscribers/${bob}`)).body.data.uuid as string;

  expect((await f.fresh(link.page, "blocklist=true")).status).toBe(404);
  expect((await f.json(`/api/subscribers/${ada}`)).body.data.status).toBe("enabled");
  expect(await f.status(ada, news.id)).toBe("confirmed");
  expect((await f.request(`/m/${link.send}/unsubscribe/${bobUuid}`)).status).toBe(404);
});
