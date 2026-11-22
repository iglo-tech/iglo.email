// B129 (D127): the operator's brand on the public pages and the subscriber mail, and no product
// credit anywhere. The accent, the font and the header mode reach the page's style attribute and
// its header, a Google font loads only when it is set, the default brand keeps today's blue, and the
// logo link never has an empty href. The subscriber mails carry the accent and the font inline, and
// every page and mail (HTML and text part) is free of a credit. Through HTTP and the SMTP sink, on
// the public fixture; the brand values are set as the page settings the fixture reads.
import { afterEach, expect, test } from "bun:test";
import { initialTemplates } from "@/templates/builtins";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";

const brandUrl = "https://brand.example.test/";
const logo = "https://brand.example.test/logo.png";
const creditWords = ["Powered by", "poweredBy", "Based on", "listmonk", "iglo.email"];
/** The same words as a pattern, for a rendered page and its archive. */
const credit = /Powered by|poweredBy|Based on|listmonk|iglo\.email/i;

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
  // The family is prepended to the page's own stack, so a missing web font falls back to it.
  expect(html).toContain(
    "--brand-font: &quot;Noto Sans JP&quot;, &quot;Inter&quot;, &quot;Open Sans&quot;, &quot;Helvetica Neue&quot;, sans-serif;",
  );
  expect(html).toContain('class="branded"');
  // The Google stylesheet loads only because a Google family is set; the URL names the family and
  // the 400, 600 and 700 weights, so headings and the site name are not faux-bold.
  expect(html).toContain(
    'href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700&amp;display=swap"',
  );
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
    // Both together are one lockup row, centred in the header (the CSS is served, not read here).
    expect(html.includes('<div class="logo logo-lockup">')).toBe(header === "logo_and_name");
  }
});

test("the focus ring is the accent when it has 3:1 against white, else near-black", async () => {
  for (const [accent, focus] of [
    ["", "#0055d4"],
    ["#ff0066", "#ff0066"],
    ["#ffff00", "#111"],
  ] as const) {
    const f = await open({ accent });
    const html = await (await f.request("/subscription/form")).text();
    expect(html).toContain(`--brand-focus: ${focus};`);
  }
  const css = await (await (await open()).request("/public/static/style.css")).text();
  expect(css).toContain(":focus-visible {\n  outline: 2px solid var(--brand-focus, #0055d4);");
  expect(css).not.toContain("outline: none");
});

/** The WCAG relative luminance of a `#rrggbb` colour, worked out from the rendered value. */
function luminanceOf(hex: string): number {
  const linear = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
function contrastRatio(a: string, b: string): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test("link text takes a link colour that reads on white: the accent when it has 4.5:1, else a darker shade of it", async () => {
  for (const [accent, link] of [
    ["", "#0055d4"],
    ["#003366", "#003366"],
    // #ffeb3b has about 1.3:1 against white; its lightness is stepped down until it has 4.5:1.
    ["#ffeb3b", "#857700"],
    // #ff0066 has 3.9:1 and #009688 has 3.7:1, so both darken; each keeps its hue.
    ["#ff0066", "#e8005d"],
    ["#009688", "#008478"],
  ] as const) {
    const f = await open({ accent });
    const html = await (await f.request("/subscription/form")).text();
    expect(html).toContain(`--brand-link: ${link};`);
    expect(contrastRatio(link, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // The fills and borders keep the accent itself; only the text takes the link colour.
    expect(html).toContain(`--brand-accent: ${accent || "#0055d4"};`);
  }
  const css = await (await (await open()).request("/public/static/style.css")).text();
  expect(css).toContain("color: var(--brand-link, var(--brand-accent, #0055d4));");
  // The outline button's text is brand-coloured on white, so it takes the link colour too.
  expect(css).toContain(
    "border: 1px solid var(--brand-accent, #0055d4);\n  color: var(--brand-link",
  );
});

test("button text is black or white by the accent's contrast, and links and form controls take the brand", async () => {
  for (const [accent, text] of [
    ["", "#ffffff"],
    ["#ffeb3b", "#111"],
    ["#009688", "#111"],
    ["#003366", "#ffffff"],
  ] as const) {
    const f = await open({ accent });
    const html = await (await f.request("/subscription/form")).text();
    expect(html).toContain(`--brand-on-accent: ${text};`);
  }
  const css = await (await (await open()).request("/public/static/style.css")).text();
  expect(css).toContain("font-family: inherit;");
  expect(css).toContain("text-decoration-color: currentColor;");
  expect(css).not.toContain("#abcbfb");
});

test("with no logo URL, the logo and logo_and_name headers show the name and no image (no bundled logo)", async () => {
  for (const header of ["logo", "logo_and_name", "auto"] as const) {
    const f = await open({ header, logoUrl: "" });
    const html = await (await f.request("/subscription/form")).text();
    const brandBlock = /<div class="logo">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(brandBlock).toContain('<span class="site-name">Brand Co</span>');
    expect(brandBlock).not.toContain("<img");
    expect(html).not.toContain("logo.svg");
  }
});

test("beside the name, the logo has no alt text, and a logo alone is named by the site", async () => {
  const both = await open({ header: "logo_and_name", logoUrl: logo });
  const bothHtml = await (await both.request("/subscription/form")).text();
  expect(bothHtml).toContain(`<img src="${logo}" alt="">`);
  const alone = await open({ header: "logo", logoUrl: logo });
  const aloneHtml = await (await alone.request("/subscription/form")).text();
  expect(aloneHtml).toContain(`<img src="${logo}" alt="Brand Co">`);
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

test("the archive index, an archived campaign's page and the opt-in page carry no credit; the page is branded", async () => {
  const f = await open({
    accent: "#ff0066",
    font: "Lora",
    header: "logo_and_name",
    logoUrl: logo,
    archive: true,
  });
  // The built-in archive layout, as a fresh install seeds it, on an archived and sent campaign.
  const layout = initialTemplates.find((item) => item.name === "Default archive template");
  const archiveTemplate = await f.template(layout!.body, "Archive");
  const list = await f.list("Archive readers", "public");
  const uuid = f.deliveredCampaign([], [list.id]);
  f.db.run(
    "UPDATE campaigns SET archive = 1, archive_slug = 'brand-check', archive_template_id = ?, status = 'finished' WHERE uuid = ?",
    [archiveTemplate, uuid],
  );
  const index = await (await f.request("/archive")).text();
  expect(index).not.toMatch(credit);
  const page = await (await f.request("/archive/brand-check")).text();
  expect(page).not.toMatch(credit);
  // The archive layout shows the logo beside the name, in the accent (B129, D127).
  expect(page).toContain(`<img src="${logo}" alt="" style=`);
  expect(page).toContain('<span style="font-size: 18px;');
  expect(page).toContain("#ff0066");
  // The archive's link text takes the link colour, the accent darkened to read on white (B129, D127).
  expect(page).toContain("color: #e8005d;");

  const double = await f.list("Double opt-in", "public", "double");
  const id = await f.subscriber("optin@example.test", "Opt", { lists: [double.id] });
  const { uuid: subscriber } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const optin = await (await f.request(`/subscription/optin/${subscriber}`)).text();
  expect(optin).not.toMatch(credit);
  expect(optin).toContain('<div class="logo logo-lockup">');
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
  // The site link takes the link colour: #ff0066 has 3.9:1 against white, so the mail darkens it.
  expect(mail.body).toContain('style="color: #e8005d;"');
  // Liquid escapes the quotes of the stack, and the mail's style attribute reads them back. The
  // family comes first, then the mail's own stack, not a bare sans-serif (B129 adopter check).
  expect(mail.body).toContain("font-family: &#34;Lora&#34;, system-ui, -apple-system,");
  for (const word of creditWords) {
    expect(mail.body).not.toContain(word);
  }
  // The text part names the site and its link, with no credit line.
  expect(message!.data).toContain("Brand Co <https://brand.example.test/>");
  expect(message!.data).not.toContain("listmonk");
});

test("a system mail's header follows the header mode: the logo, the name, or both, and the logo only when one is set", async () => {
  const cases = [
    ["logo", logo, true, false],
    ["name", logo, false, true],
    ["logo_and_name", logo, true, true],
    ["logo_and_name", "", false, true],
  ] as const;
  for (const [header, logoUrl, logoShown, nameShown] of cases) {
    const f = await open({ header, logoUrl });
    const email = `header-${header}-${logoUrl ? "logo" : "none"}@example.test`;
    const { uuid, send } = await sendTo(f, email);
    expect((await f.fresh(`/m/${send}/export/${uuid}`)).status).toBe(200);
    await f.drain();
    const message = f
      .mailTo(email)
      .find((m) => decoded(m.data).header("Subject") === "Your data from Brand Co");
    expect(message).toBeDefined();
    const body = decoded(message!.data).body;
    expect(body.includes(`src="${logo}"`)).toBe(logoShown);
    // The name is the header's own element; the footer's name is plain text.
    expect(body.includes('class="site-name"')).toBe(nameShown);
  }
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
  // #ff0066 gives black text (4.9:1 against 3.9:1 for white), so the button reads on the accent.
  expect(mail.body).toContain('style="background: #ff0066; color: #111;"');
  expect(mail.body).toContain("font-family: Georgia, &#34;Times New Roman&#34;, serif;");
  for (const word of creditWords) {
    expect(mail.body).not.toContain(word);
  }
  expect(message!.data).not.toContain("listmonk");
});

// A declaration left with no value (`background: ;`) is dropped by the browser, so the layout would
// show the browser's link blue and serif font. The template preview must fill every brand value.
const emptyDeclaration = /(background|color|font-family):\s*(!important)?\s*;/;

test("the template preview of the default layouts takes the operator's accent and no empty declaration", async () => {
  const f = await open({ accent: "#ff0066" });
  for (const id of [1, 2]) {
    const response = await f.request(`/api/templates/${id}/preview`, {
      headers: f.sessionHeaders,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("background: #ff0066;");
    expect(html).not.toMatch(emptyDeclaration);
  }
});

test("the template preview with the default brand keeps the built-in blue and no empty declaration", async () => {
  const f = await open();
  for (const id of [1, 2]) {
    const html = await (
      await f.request(`/api/templates/${id}/preview`, { headers: f.sessionHeaders })
    ).text();
    expect(html).toContain("background: #0055d4;");
    expect(html).not.toMatch(emptyDeclaration);
  }
});
