// B126 (D123): the public pages and the subscriber mail read right for the person. Each copy change,
// the already-unsubscribed state (decided by membership, whatever the list's type), the wipe
// confirmation, the site URL and its back links, the subscriber mails' footers, the campaign links,
// the disabled form's 404, the label of the manage name field and the `$` patterns in names. Through
// HTTP and the SMTP sink, on the public fixture that mounts the /m/ and /subscription/ routes.
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const placeholder = "00000000-0000-0000-0000-000000000000";
const form = { "content-type": "application/x-www-form-urlencoded" };
const brandUrl = "https://brand.example.test/";
const logo = "https://brand.example.test/logo.png";

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

/** A marketing send to one list of the given type, to a subscriber on it. */
async function sendTo(
  f: PublicFixture,
  name = "News",
  type = "public",
  email = `${name.toLowerCase()}@example.test`,
) {
  const list = await f.list(name, type);
  const id = await f.subscriber(email, "Ada", { lists: [list.id] });
  const uuid = (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const template = await f.template(`<a href="{{ unsubscribe_url }}">unsub</a>`, name);
  const sent = await f.tx({
    subscriber_id: id,
    template_id: template,
    kind: "marketing",
    list_id: list.id,
    data: {},
  });
  return { list, id, uuid, send: sent.body.data.sends[0].uuid as string };
}

/** Decoded message text: unfolded headers plus a quoted-printable-decoded body. */
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  const headers = data.slice(0, at).replace(/\r\n[ \t]+/g, " ");
  const body = data
    .slice(at + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  return { headers, body, header };
}

test("the error, expired, not-found and rate-limit pages say what happened", async () => {
  const f = await open();
  const { send, uuid } = await sendTo(f);

  const invalid = await f.request(`/m/${send}/unsubscribe/not-a-uuid`);
  expect(invalid.status).toBe(400);
  const invalidHtml = await invalid.text();
  expect(invalidHtml).toContain("This link is not valid.");
  expect(invalidHtml).not.toContain("Invalid UUID(s)");

  // A wipe removes the subscriber; the old link answers the expired copy, not "E-mail message".
  expect((await f.fresh(`/m/${send}/wipe/${uuid}?confirm=true`)).status).toBe(200);
  const expired = await f.request(`/m/${send}/unsubscribe/${uuid}`);
  expect(expired.status).toBe(404);
  const expiredHtml = await expired.text();
  expect(expiredHtml).toContain("This link has expired or the data was removed.");
  expect(expiredHtml).not.toContain("E-mail message not found");

  for (const path of ["/", "/no-such-public-page"]) {
    const missing = await f.request(path);
    expect(missing.status).toBe(404);
    const html = await missing.text();
    expect(html).toContain("<title>Page not found - Mailing list</title>");
    expect(html).toContain("<h2>Page not found</h2>");
    expect(html).not.toContain("404 - Not found");
  }

  // The optin limit is 5 a minute per peer in the public fixture; the sixth answers 429.
  let last: Response | undefined;
  for (let i = 0; i < 6; i++)
    last = await f.peer(`/subscription/optin/${placeholder}`, "192.0.2.77");
  expect(last!.status).toBe(429);
  expect(await last!.text()).toContain("Too many requests. Please try again in a minute.");
});

test("a revisited unsubscribe link says the person is already unsubscribed, and keeps the form for other lists", async () => {
  const f = await open();
  const news = await f.list("News");
  const other = await f.list("Other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, other.id] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  const template = await f.template(`<a href="{{ unsubscribe_url }}">unsub</a>`, "News");
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news.id,
    data: {},
  });
  const page = `/m/${sent.body.data.sends[0].uuid}/unsubscribe/${adaUuid}`;

  const first = await (await f.request(page)).text();
  expect(first).toContain("Do you want to unsubscribe from this mailing list?");

  const oneClick = await f.request(page, {
    method: "POST",
    headers: form,
    body: "List-Unsubscribe=One-Click",
  });
  expect(await oneClick.text()).toContain("You have unsubscribed successfully.");

  const again = await f.request(page);
  expect(again.status).toBe(200);
  const againHtml = await again.text();
  expect(againHtml).toContain("You are already unsubscribed from these emails: News.");
  expect(againHtml).not.toContain("Do you want to unsubscribe");
  expect(againHtml).not.toContain('id="btn-unsub"');
  expect(againHtml).not.toContain('name="blocklist"');

  // The other list is still subscribed, so the manage view still lists it.
  expect(await f.status(ada, other.id)).not.toBe("unsubscribed");
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).toContain('class="manage-form"');
  expect(manage).toContain(`value="${other.uuid}"`);
});

test("a wipe asks for confirmation on its own page and deletes only when confirmed", async () => {
  const f = await open();
  const { send, uuid, id } = await sendTo(f);

  const manage = await (await f.request(`/m/${send}/unsubscribe/${uuid}?manage=true`)).text();
  expect(manage).toContain(
    "Delete your email data: your address, name and list memberships here. This does not close your account with Mailing list.",
  );
  expect(manage).not.toContain("Delete all your subscriptions");
  expect(manage).not.toContain("Wipe your data");
  // No browser dialog: the page's script never calls confirm().
  expect(manage).not.toContain("confirm(");

  const asked = await f.fresh(`/m/${send}/wipe/${uuid}`);
  expect(asked.status).toBe(200);
  const askedHtml = await asked.text();
  expect(askedHtml).toContain("Delete your email data?");
  expect(askedHtml).toContain(`action="/m/${send}/wipe/${uuid}?confirm=true"`);
  // Keep my data leads back to the manage page, which still answers the person's address.
  expect(askedHtml).toContain(
    `<a href="/m/${send}/unsubscribe/${uuid}?manage=true">Keep my data</a>`,
  );
  expect(await (await f.request(`/m/${send}/unsubscribe/${uuid}?manage=true`)).text()).toContain(
    'class="manage-form"',
  );
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(200);

  const removed = await f.fresh(`/m/${send}/wipe/${uuid}?confirm=true`);
  expect(removed.status).toBe(200);
  const removedHtml = await removed.text();
  expect(removedHtml).toContain("Your email data has been deleted.");
  expect(removedHtml).not.toContain("Your subscriptions and all associated data");
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
});

test("the header logo has no empty link, and the done, unsubscribed and removed pages link back only with a site URL", async () => {
  const f = await open({ subscriptionPage: false });
  const { send, uuid, list, id } = await sendTo(f);
  const page = `/m/${send}/unsubscribe/${uuid}`;

  // No subscription page and no site URL: the logo is not a link, and no page has an empty href.
  const bare = await (await f.request(`${page}?manage=true`)).text();
  expect(bare).not.toContain('href=""');
  expect(bare).not.toContain("Back to Mailing list");

  // The operator's site: the logo and the back links point to it.
  Object.assign(f.overrides, { siteUrl: brandUrl });
  const manage = await (await f.request(`${page}?manage=true`)).text();
  expect(manage).toContain(`<a href="${brandUrl}"><img`);
  expect(manage).not.toContain('href=""');

  const saved = await f.fresh(page, `manage=true&name=Ada+Two&l=${list.uuid}`);
  expect(saved.status).toBe(200);
  const savedHtml = await saved.text();
  expect(savedHtml).toContain("Your preferences have been saved.");
  expect(savedHtml).toContain(`<a href="${brandUrl}">Back to Mailing list</a>`);

  const unsubscribed = await f.fresh(page, "List-Unsubscribe=One-Click");
  expect(await unsubscribed.text()).toContain(`<a href="${brandUrl}">Back to Mailing list</a>`);

  const removed = await f.fresh(`/m/${send}/wipe/${uuid}?confirm=true`);
  expect(removed.status).toBe(200);
  expect(await removed.text()).toContain(`<a href="${brandUrl}">Back to Mailing list</a>`);
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
});

test("the header logo links to the subscription page when there is no site URL, as before", async () => {
  const f = await open();
  const { send, uuid } = await sendTo(f);
  const html = await (await f.request(`/m/${send}/unsubscribe/${uuid}?manage=true`)).text();
  expect(html).toContain('<a href="http://fixture.test/subscription/form"><img');
  expect(html).not.toContain('href=""');
});

test("the manage page's name field has its label", async () => {
  const f = await open();
  const { send, uuid } = await sendTo(f);
  const html = await (await f.request(`/m/${send}/unsubscribe/${uuid}?manage=true`)).text();
  const label = /<label for="(manage-name)">Name<\/label>/.exec(html);
  expect(label).not.toBeNull();
  expect(html).toContain(`<input id="${label![1]}" type="text" name="name"`);
});

test("the public pages carry no product credit", async () => {
  const f = await open();
  const { send, uuid } = await sendTo(f);
  for (const path of [`/m/${send}/unsubscribe/${uuid}?manage=true`, "/no-such-public-page"]) {
    const html = await (await f.request(path)).text();
    expect(html).not.toContain("Powered by");
    expect(html).not.toContain("Based on");
    expect(html).not.toContain("iglo.email");
    expect(html).not.toContain("listmonk");
  }
});

test("the data mail is branded, titled for the site, and has a text part", async () => {
  const f = await open({ siteName: "Brand Co", logoUrl: logo });
  const { send, uuid, id } = await sendTo(f, "Noa");
  const email = (await f.json(`/api/subscribers/${id}`)).body.data.email as string;

  const exported = await f.fresh(`/m/${send}/export/${uuid}`);
  expect(exported.status).toBe(200);
  await f.drain();

  // The subscriber also has the campaign's marketing mail; the data mail is the one with its subject.
  const message = f.mailTo(email).find((m) => decoded(m.data).header("Subject") !== "Noa");
  expect(message).toBeDefined();
  const mail = decoded(message!.data);
  expect(mail.header("Subject")).toBe("Your data from Brand Co");
  // The attachment makes the top level mixed; the bodies are an alternative pair (B120, D118).
  expect(message!.data).toContain("multipart/alternative");
  expect(mail.body).toContain("Content-Type: text/plain");
  expect(mail.body).toContain(`src="${logo}"`);
  expect(mail.body).toContain("Brand Co");
  expect(mail.body).toContain("the data this mailing service holds about you");
  expect(mail.body).not.toContain("all data recorded");
  expect(mail.body).not.toContain("Powered by");
  expect(mail.body).not.toContain("listmonk");
  expect(message!.data).toContain("filename=data.json");
});

test("the opt-in mail is branded and carries no product credit", async () => {
  const f = await open({ siteName: "Brand Co", logoUrl: logo, subscriptionPage: true });
  const list = await f.list("Monthly", "public", "double");
  const response = await f.fresh(
    "/subscription/form",
    new URLSearchParams({ email: "opt@example.test", name: "Opt", l: list.uuid }).toString(),
  );
  expect(response.status).toBe(200);
  await f.drain();

  const [message] = f.mailTo("opt@example.test");
  expect(message).toBeDefined();
  const mail = decoded(message!.data);
  expect(mail.header("Subject")).toBe("Confirm subscription");
  expect(mail.body).toContain(`src="${logo}"`);
  expect(mail.body).toContain("Brand Co");
  expect(mail.body).not.toContain("Powered by");
  expect(mail.body).not.toContain("listmonk");
});

test("a private list's revisited link says so from the membership, and never names the private list", async () => {
  const f = await open();
  const { list, id, uuid, send } = await sendTo(f, "Members", "private");
  const page = `/m/${send}/unsubscribe/${uuid}`;
  expect(await (await f.request(page)).text()).toContain(
    "Do you want to unsubscribe from this mailing list?",
  );

  expect((await f.fresh(page, "List-Unsubscribe=One-Click")).status).toBe(200);
  expect(await f.status(id, list.id)).toBe("unsubscribed");

  const again = await (await f.request(page)).text();
  expect(again).toContain("You are already unsubscribed from these emails.");
  expect(again).not.toContain("Members");
  expect(again).not.toContain("Do you want to unsubscribe");
  expect(again).not.toContain('id="btn-unsub"');
});

test("the already-unsubscribed page keeps the export, wipe and manage links, and links back when the site URL is set", async () => {
  const f = await open({ siteName: "Brand Co" });
  const { send, uuid } = await sendTo(f, "Members", "private");
  const page = `/m/${send}/unsubscribe/${uuid}`;
  await f.fresh(page, "List-Unsubscribe=One-Click");

  const without = await (await f.request(page)).text();
  expect(without).toContain('id="data-form"');
  expect(without).toContain('href="?manage=true"');
  expect(without).not.toContain("Back to Brand Co");

  Object.assign(f.overrides, { siteUrl: brandUrl });
  const withSite = await (await f.request(page)).text();
  expect(withSite).toContain('id="data-form"');
  expect(withSite).toContain(`<a href="${brandUrl}">Back to Brand Co</a>`);
  // The manage link leads to the manage view, so the page is not a dead end.
  expect(await (await f.request(`${page}?manage=true`)).text()).toContain('class="manage-form"');
});

test("a campaign's revisited link covers its own lists only, and its unsubscribed page links back", async () => {
  const f = await open({ siteName: "Brand Co", siteUrl: brandUrl });
  const news = await f.list("News");
  const other = await f.list("Other");
  const id = await f.subscriber("camp@example.test", "Cam", { lists: [news.id, other.id] });
  const uuid = (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const camp = f.deliveredCampaign([id], [news.id]);
  const page = `/subscription/${camp}/${uuid}`;

  const asked = await (await f.fresh(`/subscription/${camp}/wipe/${uuid}`)).text();
  expect(asked).toContain(`<a href="/subscription/${camp}/${uuid}?manage=true">Keep my data</a>`);

  const done = await (await f.fresh(page, "List-Unsubscribe=One-Click")).text();
  expect(done).toContain("You have unsubscribed successfully.");
  expect(done).toContain(`<a href="${brandUrl}">Back to Brand Co</a>`);
  expect(await f.status(id, news.id)).toBe("unsubscribed");

  // The campaign's list is unsubscribed, and the person is still on Other: the link still says so.
  expect(await f.status(id, other.id)).not.toBe("unsubscribed");
  const again = await (await f.request(page)).text();
  expect(again).toContain("You are already unsubscribed from these emails: News.");
  expect(again).not.toContain("Do you want to unsubscribe");
});

test("the error, expired, invalid and not-found pages link back to the site when the site URL is set", async () => {
  const f = await open({ siteName: "Brand Co", siteUrl: brandUrl });
  const { send, uuid } = await sendTo(f);
  const back = `<a href="${brandUrl}">Back to Brand Co</a>`;

  expect(await (await f.request(`/m/${send}/unsubscribe/not-a-uuid`)).text()).toContain(back);
  for (const path of ["/", "/no-such-public-page"]) {
    const missing = await f.request(path);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain(back);
  }

  expect((await f.fresh(`/m/${send}/wipe/${uuid}?confirm=true`)).status).toBe(200);
  const expired = await f.request(`/m/${send}/unsubscribe/${uuid}`);
  expect(expired.status).toBe(404);
  expect(await expired.text()).toContain(back);
});

test("a site name and a list name with $ patterns are printed as typed, wherever they are substituted", async () => {
  const name = "Shop $& Co $$ $1 x";
  const f = await open({ siteName: name, siteUrl: brandUrl });
  const { send, uuid } = await sendTo(f, "Deals $& $1", "public", "deals@example.test");
  const page = `/m/${send}/unsubscribe/${uuid}`;
  // The text is escaped as HTML, so `&` reads `&amp;` on the page; the `$` patterns stay as typed.
  const shown = "Shop $&amp; Co $$ $1 x";

  await f.fresh(page, "List-Unsubscribe=One-Click");
  const already = await (await f.request(page)).text();
  expect(already).toContain("You are already unsubscribed from these emails: Deals $&amp; $1.");
  expect(already).toContain(`<a href="${brandUrl}">Back to ${shown}</a>`);

  const wipe = await (await f.fresh(`/m/${send}/wipe/${uuid}`)).text();
  expect(wipe).toContain(`This does not close your account with ${shown}.`);

  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  await f.drain();
  const subjects = f.mailTo("deals@example.test").map((m) => decoded(m.data).header("Subject"));
  expect(subjects).toContain(`Your data from ${name}`);
});

test("the subscriber mails name the site and link it when the site URL is set, and the text part prints the link", async () => {
  const f = await open({ siteName: "Brand Co", logoUrl: logo, siteUrl: brandUrl });
  const { send, uuid, id } = await sendTo(f, "Noa");
  const email = (await f.json(`/api/subscribers/${id}`)).body.data.email as string;
  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  const list = await f.list("Monthly", "public", "double");
  await f.fresh(
    "/subscription/form",
    new URLSearchParams({ email: "opt@example.test", name: "Opt", l: list.uuid }).toString(),
  );
  await f.drain();

  const data = f
    .mailTo(email)
    .map((m) => decoded(m.data))
    .find((m) => m.header("Subject") === "Your data from Brand Co");
  expect(data).toBeDefined();
  expect(data!.body).toContain(`<a href="${brandUrl}">Brand Co</a>`);
  expect(data!.body).toContain(`Brand Co <${brandUrl}>`);

  const optin = f.mailTo("opt@example.test").map((m) => decoded(m.data));
  expect(optin.length).toBeGreaterThan(0);
  expect(optin[0]!.body).toContain(`<a href="${brandUrl}">Brand Co</a>`);
  expect(optin[0]!.body).toContain(`Brand Co <${brandUrl}>`);
});

test("without a site URL the subscriber mails name the site as plain text", async () => {
  const f = await open({ siteName: "Brand Co", logoUrl: logo });
  const { send, uuid, id } = await sendTo(f, "Noa");
  const email = (await f.json(`/api/subscribers/${id}`)).body.data.email as string;
  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  await f.drain();

  const data = f
    .mailTo(email)
    .map((m) => decoded(m.data))
    .find((m) => m.header("Subject") === "Your data from Brand Co");
  expect(data).toBeDefined();
  expect(data!.body).toContain("Brand Co</p>");
  expect(data!.body).not.toContain(`href="${brandUrl}"`);
  expect(data!.body).not.toContain("Brand Co <");
});

test("the subscription form's 404 is the branded page, on GET and POST, when the public form is off", async () => {
  const f = await open({ subscriptionPage: false });
  const got = await f.request("/subscription/form");
  expect(got.status).toBe(404);
  const gotHtml = await got.text();
  expect(gotHtml).toContain("<h2>Page not found</h2>");
  expect(gotHtml).not.toContain("That feature is not available.");

  const posted = await f.fresh("/subscription/form", "email=off@example.test");
  expect(posted.status).toBe(404);
  expect(await posted.text()).toContain("<h2>Page not found</h2>");
});
