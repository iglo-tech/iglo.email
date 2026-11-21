// B125: every HTML answer of a personal page (under /m/, /subscription/ and /campaign/) carries
// the hardening headers, the 404 and 429 answers included, through HTTP on the public fixture.
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}

/** A well-formed UUID that no send or campaign has. */
const unknownSend = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const unknownCampaign = "3f6b1c2d-8e4a-4b7c-9d1e-2a5f6b7c8d9e";

function expectHardened(response: Response) {
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
}

test("every personal page answers with the hardening headers, its 404 included", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  const campaign = f.deliveredCampaign([ada], [news.id]);
  // A marketing send's own page, paired through its journal row.
  const template = await f.template("<p>Hi</p>", "Hi");
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news.id,
    data: {},
  });
  const send = sent.body.data.sends[0].uuid as string;
  const pages = [
    "/subscription/form",
    `/subscription/optin/${adaUuid}`,
    `/m/${send}/unsubscribe/${adaUuid}`,
    `/m/${send}/unsubscribe/${adaUuid}?manage=true`,
    `/subscription/${campaign}/${adaUuid}`,
    `/subscription/${campaign}/${adaUuid}?manage=true`,
    `/campaign/${campaign}/${adaUuid}`,
    `/m/${unknownSend}/unsubscribe/${adaUuid}`,
    `/subscription/${unknownCampaign}/${adaUuid}`,
  ];
  for (const path of pages) expectHardened(await f.peer(path, "198.51.100.1"));
});

test("the limited answer of a personal page carries the headers too", async () => {
  const f = await open();
  const news = await f.list("News");
  const bad = new URLSearchParams({ email: "bad", l: news.uuid }).toString();
  for (let i = 0; i < 5; i++)
    expect((await f.post("/subscription/form", bad, "192.0.2.70")).status).toBe(400);
  const limited = await f.post("/subscription/form", bad, "192.0.2.70");
  expect(limited.status).toBe(429);
  expectHardened(limited);
});

test("a campaign page keeps its own Content-Security-Policy and gains frame-ancestors", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  const campaign = f.deliveredCampaign([ada], [news.id]);
  const response = await f.peer(`/campaign/${campaign}/${adaUuid}`, "198.51.100.2");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
});
