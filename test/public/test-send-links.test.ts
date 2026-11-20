// B115 (D117): the view-in-browser and opt-in links of a campaign test send name the test
// placeholder. They answer the test page and confirm nothing, where a real opt-in link confirms.
// Through HTTP, on the public fixture that mounts those routes.
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const testSend = "00000000-0000-0000-0000-000000000001";
// B121: each route says what its link does in a real message, not the unsubscribe wording.
const viewMessage =
  "This link is from a test send. It shows no message here; in a real message it opens the message in the browser.";
const optinMessage =
  "This link is from a test send. It confirms nothing here; in a real message it opens the subscription confirmation page.";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}

test("a test send's message and opt-in links answer the test page and confirm nothing", async () => {
  const f = await open();
  const double = await f.list("Double", "public", "double");
  const id = await f.subscriber("mia@example.test", "Mia", { lists: [double.id] });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  // Without the confirmation page, a POST that asks to confirm would confirm.
  f.overrides.showOptinPage = false;

  for (const [path, text] of [
    [`/campaign/${testSend}/${uuid}`, viewMessage],
    [`/subscription/optin/${testSend}`, optinMessage],
  ] as const) {
    const page = await f.peer(path, "192.0.2.20");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(await page.text()).toContain(text);
  }
  const posted = await f.fresh(`/subscription/optin/${testSend}`, `confirm=true&l=${double.uuid}`);
  expect(posted.status).toBe(200);
  expect(await posted.text()).toContain(optinMessage);
  expect(await f.status(id, double.id)).toBe("unconfirmed");

  // The control: a real opt-in link confirms, so the test above can fail.
  const real = await f.fresh(`/subscription/optin/${uuid}`, `confirm=true&l=${double.uuid}`);
  expect(real.status).toBe(200);
  expect(await f.status(id, double.id)).toBe("confirmed");
});
