// B121 (D119): every public page renders through the branded shell with the site's settings:
// the logo, the favicon and the custom CSS link, and the site name. Through HTTP only, on the
// public fixture that mounts the /m/ routes (txFixture), the campaign and archive routes.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";

const logo = "https://brand.example.test/logo.png";
const favicon = "https://brand.example.test/favicon.ico";
const placeholder = "00000000-0000-0000-0000-000000000000";
const form = { "content-type": "application/x-www-form-urlencoded" };

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  Object.assign(f.overrides, {
    logoUrl: logo,
    faviconUrl: favicon,
    customCss: "body { color: rebeccapurple; }",
  });
  return f;
}

/** The custom logo, the custom favicon and the custom CSS link, and not the default logo. */
function branded(html: string) {
  expect(html).toContain(`src="${logo}"`);
  expect(html).toContain(`href="${favicon}"`);
  expect(html).toContain('href="/public/custom.css?v=');
  expect(html).not.toContain("/public/static/logo.svg");
  expect(html).not.toContain("/public/static/favicon.png");
}

test("the /m/ unsubscribe page, its manage view, the test send and the error and result pages are branded", async () => {
  const f = await open();
  const list = (
    await f.json("/api/lists", "POST", { name: "news", type: "public", optin: "single" })
  ).body.data.id as number;
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  const template = await f.template('<p><a href="{{ unsubscribe_url }}">unsub</a></p>', "News");
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list,
    data: {},
  });
  const sendUuid = sent.body.data.sends[0].uuid as string;
  const page = `/m/${sendUuid}/unsubscribe/${adaUuid}`;

  for (const path of [
    page,
    `${page}?manage=true`,
    `/m/${placeholder}/unsubscribe/${adaUuid}`,
    `/m/${sendUuid}/unsubscribe/not-a-uuid`,
  ]) {
    const response = await f.request(path);
    expect(response.status).toBe(path.endsWith("not-a-uuid") ? 400 : 200);
    branded(await response.text());
  }
  // The POST result page, from the page form and from a one-click.
  for (const body of ["List-Unsubscribe=One-Click", ""]) {
    const posted = await f.request(page, { method: "POST", headers: form, body });
    expect(posted.status).toBe(200);
    branded(await posted.text());
  }
});

test("a 404 from an unknown public path is branded, and a HEAD answers no body", async () => {
  const f = await open();
  const response = await f.request("/no-such-public-page");
  expect(response.status).toBe(404);
  branded(await response.text());
  const head = await f.request("/no-such-public-page", { method: "HEAD" });
  expect(head.status).toBe(404);
  expect(await head.text()).toBe("");
});

test("the archive's hidden page, when the archive is off, is branded", async () => {
  const f = await open();
  Object.assign(f.overrides, { archive: false });
  const response = await f.request("/archive");
  expect(response.status).toBe(404);
  branded(await response.text());
});

test("the 429 page of a limited public route is branded", async () => {
  const f = await open();
  // The optin limit is 5 a minute per peer in the public fixture; the sixth answers 429.
  let last: Response | undefined;
  for (let i = 0; i < 6; i++) {
    last = await f.peer(`/subscription/optin/${placeholder}`, "192.0.2.77");
  }
  expect(last!.status).toBe(429);
  branded(await last!.text());
});

test("the empty public subscription form answers 200 with the branded message, not 500", async () => {
  const f = await open();
  Object.assign(f.overrides, { subscriptionPage: true });
  const response = await f.request("/subscription/form");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("No lists available to subscribe.");
  // A 200 page is not an error: it carries the form's own title, not "Error".
  expect(html).toContain("<title>Subscribe - Mailing list</title>");
  branded(html);
});

test("the test-send placeholder page is branded too", async () => {
  const f = await open();
  const response = await f.request(`/m/${placeholder}/unsubscribe/${crypto.randomUUID()}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("This link is from a test send.");
  branded(html);
});
