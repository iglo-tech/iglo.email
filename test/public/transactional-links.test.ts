// B126 round 2 (D123, D126): what a transactional send's unsubscribe link says and does. Its page
// reads the subscriber's memberships: pending opt-ins are cancelled by its form (naming public lists
// only), a subscriber with no open membership sees the already-unsubscribed page, and a confirmed
// subscriber keeps the manage view (or, with preferences off, a page that points to a marketing mail's
// link). Its export acts through its own paired path, and its wipe is not offered (D123 item 8).
// Through HTTP, on the public
// fixture, with private single and double opt-in lists beside public ones.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";
import { asBody } from "@/test/read-body";

const brandUrl = "https://brand.example.test/";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
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
  const uuid = asBody<string>((await f.json(`/api/subscribers/${id}`)).body.data.uuid);
  const sent = await f.tx({ subscriber_id: id, template_id: template });
  expect(sent.status).toBe(200);
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  return { send, uuid, page: `/m/${send}/unsubscribe/${uuid}` };
}

/** An admin's change of a subscriber's lists, as the subscriber list API makes it. */
const change = (
  f: PublicFixture,
  id: number,
  action: string,
  lists: Array<number>,
  status?: string,
) =>
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
  expect(asked).toContain("<h2>Cancel pending subscriptions</h2>");
  expect(asked).toContain("<title>Cancel pending subscriptions - Brand Co</title>");
  expect(asked).not.toContain('class="manage-form"');

  // Two pending opt-ins were cancelled, so the result is plural.
  const cancelled = await (await f.fresh(link.page, "")).text();
  expect(cancelled).toContain("Your pending subscriptions were cancelled.");
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
  expect(asked).toContain("<title>Cancel pending subscriptions - Mailing list</title>");

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
    // Nothing to unsubscribe: the page is titled and headed as a marketing link's already-unsubscribed page.
    expect(html).toContain("<title>Unsubscribed - Brand Co</title>");
    expect(html).toContain("<h2>Unsubscribed</h2>");
    expect(html).not.toContain("Your email settings");
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

test("an active subscriber with preferences off gets the email settings page, reached by an API create and by a confirmed list", async () => {
  const f = await open({ siteName: "Brand Co", allowPreferences: false });
  const template = await receipt(f);
  // Created through the API without preconfirm_subscriptions: an unconfirmed membership of a single
  // opt-in list is an active subscription (D126).
  const weekly = await f.list("Weekly News", "public", "single");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [weekly.id] });
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");
  // A confirmed membership of a public single opt-in list.
  const news = await f.list("News", "public", "single");
  const bob = await f.subscriber("bob@example.test", "Bob", {});
  expect((await change(f, bob, "add", [news.id], "confirmed")).status).toBe(200);
  expect(await f.status(bob, news.id)).toBe("confirmed");

  for (const id of [ada, bob]) {
    const link = await txPage(f, template, id);
    for (const path of [link.page, `${link.page}?manage=true`]) {
      const html = await (await f.request(path)).text();
      expect(html).toContain("<title>Your email settings - Brand Co</title>");
      expect(html).toContain("<h2>Your email settings</h2>");
      expect(html).not.toContain("Unsubscribe from mailing list");
      expect(html).toContain(
        "This message was sent about your account with Brand Co. To stop other emails, use the unsubscribe link in one of them.",
      );
      expect(html).not.toContain('id="btn-unsub"');
    }
  }
});

test("with preferences on, an active subscriber's transactional manage view is titled and headed Your email settings", async () => {
  // B117b (D137 item 2): the manage view of a transactional link is the email settings page, not the
  // marketing unsubscribe page. Its title and heading are the same text as the preferences-off page.
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const weekly = await f.list("Weekly News", "public", "single");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [weekly.id] });
  const link = await txPage(f, template, ada);

  for (const path of [link.page, `${link.page}?manage=true`]) {
    const html = await (await f.request(path)).text();
    expect(html).toContain("<title>Your email settings - Brand Co</title>");
    expect(html).toContain("<h2>Your email settings</h2>");
    expect(html).not.toContain("Unsubscribe from mailing list");
    expect(html).toContain('class="manage-form"');
    expect(html).toContain('id="manage-name"');
  }
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

test("a transactional send's page offers export and no wipe, and a wipe POST is refused", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const link = await txPage(f, template, ada);

  const page = await (await f.request(link.page)).text();
  expect(page).toContain(`/m/${link.send}/export/${link.uuid}`);
  expect(page).not.toContain(`/wipe/${link.uuid}`);
  expect(page).not.toContain("Delete your email data");

  const exported = await f.fresh(`/m/${link.send}/export/${link.uuid}`);
  expect(exported.status).toBe(200);
  expect(await exported.text()).toContain("Your data has been e-mailed to you as an attachment.");

  // The wipe is refused as it was before B126: the same not-found page, with or without confirm=true,
  // and nothing is deleted.
  for (const path of [
    `/m/${link.send}/wipe/${link.uuid}`,
    `/m/${link.send}/wipe/${link.uuid}?confirm=true`,
  ]) {
    const refused = await f.fresh(path);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toContain("This link has expired or the data was removed.");
  }
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(200);
});

test("a transactional send cannot blocklist, and a random subscriber UUID pairs nobody", async () => {
  const f = await open();
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news.id] });
  await change(f, ada, "add", [news.id], "confirmed");
  const link = await txPage(f, template, ada);
  const bobUuid = asBody<string>((await f.json(`/api/subscribers/${bob}`)).body.data.uuid);

  expect((await f.fresh(link.page, "blocklist=true")).status).toBe(404);
  expect((await f.json(`/api/subscribers/${ada}`)).body.data.status).toBe("enabled");
  expect(await f.status(ada, news.id)).toBe("confirmed");
  expect((await f.request(`/m/${link.send}/unsubscribe/${bobUuid}`)).status).toBe(404);
});

test("a Cc or Bcc copy of a transactional send cannot wipe the subscriber; export mails the address on record", async () => {
  const f = await open();
  const template = await receipt(f);
  const news = await f.list("News", "public");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const uuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    headers: [{ Cc: "copy@third.example.test" }, { Bcc: "hidden@third.example.test" }],
  });
  expect(sent.status).toBe(200);
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  await f.drain();
  const before = f.mailTo("ada@example.test").length;

  // The copy holder's wipe, asked or confirmed, is refused and deletes nothing.
  expect((await f.fresh(`/m/${send}/wipe/${uuid}`)).status).toBe(404);
  expect((await f.fresh(`/m/${send}/wipe/${uuid}?confirm=true`)).status).toBe(404);
  const subscriber = await f.json(`/api/subscribers/${ada}`);
  expect(subscriber.status).toBe(200);
  expect(subscriber.body.data.name).toBe("Ada");
  expect(await f.status(ada, news.id)).toBe("unconfirmed");

  // Export mails the address on record, and only that address.
  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  await f.drain();
  const mailed = f.mailTo("ada@example.test");
  expect(mailed).toHaveLength(before + 1);
  expect(mailed.at(-1)!.to).toEqual(["ada@example.test"]);
});

test("an unconfirmed membership on a single opt-in list is active: no cancel form, the cancel POST leaves it, and marketing still reaches it", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const weekly = await f.list("Weekly News", "public", "single");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [weekly.id] });
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");
  const link = await txPage(f, template, ada);

  const manage = await (await f.request(link.page)).text();
  expect(manage).toContain('class="manage-form"');
  expect(manage).toContain(`value="${weekly.uuid}"`);
  expect(manage).not.toContain("Cancel pending subscriptions");
  expect(manage).not.toContain("You have not confirmed");
  expect(manage).not.toContain("Do you want to unsubscribe");
  expect(manage).toContain('id="data-form"');

  // The link's cancel POST ends nothing on a single opt-in list: the page answers the manage view again.
  const posted = await (await f.fresh(link.page, "")).text();
  expect(posted).toContain('class="manage-form"');
  expect(posted).not.toContain("Your pending subscription");
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");

  // The next marketing send to the list still reaches them.
  await f.drain();
  const before = f.mailTo("ada@example.test").length;
  const marketing = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: weekly.id,
  });
  expect(marketing.status).toBe(200);
  expect(marketing.body.data.sends[0].status).toBe("sent");
  await f.drain();
  expect(f.mailTo("ada@example.test")).toHaveLength(before + 1);
});

test("a confirmed subscriber with only private lists sees the account sentence above the manage view", async () => {
  const f = await open({ siteName: "Brand Co" });
  const template = await receipt(f);
  const members = await f.list("Members", "private");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [members.id] });
  expect((await change(f, ada, "add", [members.id], "confirmed")).status).toBe(200);
  const link = await txPage(f, template, ada);

  const html = await (await f.request(link.page)).text();
  expect(html).toContain('class="manage-form"');
  expect(html).toContain('name="name"');
  expect(html).not.toContain("Members");
  expect(html).toContain(
    "This message was sent about your account with Brand Co. To stop other emails, use the unsubscribe link in one of them.",
  );
});
