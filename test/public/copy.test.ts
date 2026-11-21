// B126 (D123): the public pages and the subscriber mail read right for the person. Each copy change,
// the already-unsubscribed state, the wipe confirmation, the site URL and its back links, the label
// of the manage name field, and the branded data and opt-in mails with their text part. Through HTTP
// and the SMTP sink, on the public fixture that mounts the /m/ routes.
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

/** A marketing send to one list, to a subscriber on it. */
async function sendTo(f: PublicFixture, name = "News") {
  const list = await f.list(name);
  const id = await f.subscriber(`${name.toLowerCase()}@example.test`, "Ada", { lists: [list.id] });
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
