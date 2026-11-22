// B129 (D127): the operator's brand on the public pages and the subscriber mail, and no product
// credit anywhere. The accent, the font and the header mode reach the page's style attribute and
// its header, a Google font loads only when it is set, the default brand keeps today's blue, and the
// logo link never has an empty href. The subscriber mails carry the accent and the font inline, and
// every page and mail (HTML and text part) is free of a credit. Through HTTP and the SMTP sink, on
// the public fixture; the brand values are set as the page settings the fixture reads.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";

const brandUrl = "https://brand.example.test/";
const logo = "https://brand.example.test/logo.png";
const creditWords = ["Powered by", "poweredBy", "Based on", "listmonk", "iglo.email"];

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open(overrides: Partial<Record<string, unknown>> = {}) {
  const f = await publicFixture();
  fixtures.push(f);
  Object.assign(f.overrides, { siteName: "Brand Co", subscriptionPage: true, ...overrides });
  return f;
}

/** Decoded message text: unfolded headers plus a quoted-printable-decoded body. */
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  const headers = data.slice(0, at).replaceAll(/\r\n[ \t]+/g, " ");
  const body = data
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  return { headers, body, header };
}

/** A marketing send to a subscriber on a public list, with the link pages' paths. */
async function sendTo(f: PublicFixture, email = "ada@example.test") {
  const list = await f.list("News", "public");
  const id = await f.subscriber(email, "Ada", { lists: [list.id] });
  const uuid = (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const template = await f.template(`<a href="{{ unsubscribe_url }}">unsub</a>`, "News");
  const sent = await f.tx({
    subscriber_id: id,
    template_id: template,
    kind: "marketing",
    list_id: list.id,
    data: {},
  });
  return { id, uuid, send: sent.body.data.sends[0].uuid as string, email };
}

test("the default brand keeps today's look: the built-in blue, the system stack and the name", async () => {
  const f = await open();
  const html = await (await f.request("/subscription/form")).text();
  expect(html).toContain("--brand-accent: #0055d4;");
  expect(html).toContain("--brand-font: &quot;Inter&quot;, &quot;Open Sans&quot;");
  expect(html).not.toContain("branded");
  expect(html).not.toContain("fonts.googleapis.com");
  // No logo is set, so the automatic header shows the site name, not the bundled logo.
  expect(html).toContain('<span class="site-name">Brand Co</span>');
  expect(html).not.toContain('href=""');
});

test("an accent, a Google font and the site URL reach the page's style, header and logo link", async () => {
  const f = await open({
    accent: "#ff0066",
    font: "Noto Sans JP",
    header: "logo_and_name",
    logoUrl: logo,
    siteUrl: brandUrl,
  });
  const html = await (await f.request("/subscription/form")).text();
  expect(html).toContain("--brand-accent: #ff0066;");
  expect(html).toContain("--brand-font: &quot;Noto Sans JP&quot;, sans-serif;");
  expect(html).toContain('class="branded"');
  // The Google stylesheet loads only because a Google family is set; the URL carries the name.
  expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP');
  expect(html).toContain(`src="${logo}"`);
  expect(html).toContain('<span class="site-name">Brand Co</span>');
  expect(html).toContain(`<a href="${brandUrl}">`);
});

test("each header mode shows the logo, the name, or both, and the logo links only when it has a target", async () => {
  const modes = [
    ["logo", true, false],
    ["name", false, true],
    ["logo_and_name", true, true],
  ] as const;
  for (const [header, logoShown, nameShown] of modes) {
    const f = await open({ header, logoUrl: logo });
    const html = await (await f.request("/subscription/form")).text();
    expect(html.includes(`src="${logo}"`)).toBe(logoShown);
    expect(html.includes('<span class="site-name">Brand Co</span>')).toBe(nameShown);
  }
});

test("a logo with no site URL and no subscription page is not a link, and no empty href is written", async () => {
  const f = await open({ subscriptionPage: false, siteUrl: "", logoUrl: logo, header: "logo" });
  const html = await (await f.request("/subscription/form")).text();
  expect(html).toContain(`src="${logo}"`);
  expect(html).not.toContain('href=""');
  expect(html).not.toMatch(/<div class="logo"><a /);
});

test("the public pages and the 404 carry no product credit", async () => {
  const f = await open({ logoUrl: logo, accent: "#ff0066", font: "Lora", header: "logo_and_name" });
  const { uuid, send } = await sendTo(f);
  for (const path of [
    "/subscription/form",
    `/m/${send}/unsubscribe/${uuid}`,
    `/m/${send}/unsubscribe/${uuid}?manage=true`,
    "/no-such-public-page",
  ]) {
    const html = await (await f.request(path)).text();
    for (const word of creditWords) {
      expect(html).not.toContain(word);
    }
  }
});

test("the data mail carries the accent and the font inline, and no credit in either part", async () => {
  const f = await open({ logoUrl: logo, accent: "#ff0066", font: "Lora", siteUrl: brandUrl });
  const { uuid, send, email } = await sendTo(f, "branded@example.test");
  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  await f.drain();

  const message = f
    .mailTo(email)
    .find((m) => decoded(m.data).header("Subject") === "Your data from Brand Co");
  expect(message).toBeDefined();
  const mail = decoded(message!.data);
  expect(mail.body).toContain('style="color: #ff0066;"');
  // Liquid escapes the quotes of the stack, and the mail's style attribute reads them back.
  expect(mail.body).toContain("font-family: &#34;Lora&#34;, sans-serif;");
  for (const word of creditWords) {
    expect(mail.body).not.toContain(word);
  }
  // The text part names the site and its link, with no credit line.
  expect(message!.data).toContain("Brand Co <https://brand.example.test/>");
  expect(message!.data).not.toContain("listmonk");
});

test("the default brand's mail keeps the built-in blue and its own font", async () => {
  const f = await open({ logoUrl: logo, siteUrl: brandUrl });
  const { uuid, send, email } = await sendTo(f, "plain@example.test");
  expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
  await f.drain();
  const message = f
    .mailTo(email)
    .find((m) => decoded(m.data).header("Subject") === "Your data from Brand Co");
  expect(message).toBeDefined();
  const mail = decoded(message!.data);
  expect(mail.body).toContain('style="color: #0055d4;"');
  expect(mail.body).not.toContain("font-family: &#34;");
});

test("the opt-in mail's button takes the accent, and the mail carries no credit", async () => {
  const f = await open({ logoUrl: logo, accent: "#ff0066", font: "system-serif" });
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
  expect(mail.body).toContain('style="background: #ff0066;"');
  expect(mail.body).toContain("font-family: Georgia, &#34;Times New Roman&#34;, serif;");
  for (const word of creditWords) {
    expect(mail.body).not.toContain(word);
  }
  expect(message!.data).not.toContain("listmonk");
});
