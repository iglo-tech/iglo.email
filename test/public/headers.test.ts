// B125: every HTML answer of a personal page (under /m/, /subscription/ and /campaign/) carries
// the hardening headers, the 404 and 429 answers included, through HTTP on the public fixture.
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
  const adaUuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
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
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  const pages = [
    `/subscription/optin/${adaUuid}`,
    `/m/${send}/unsubscribe/${adaUuid}`,
    `/m/${send}/unsubscribe/${adaUuid}?manage=true`,
    `/subscription/${campaign}/${adaUuid}`,
    `/subscription/${campaign}/${adaUuid}?manage=true`,
    `/campaign/${campaign}/${adaUuid}`,
    `/m/${unknownSend}/unsubscribe/${adaUuid}`,
    `/subscription/${unknownCampaign}/${adaUuid}`,
  ];
  for (const path of pages) {
    expectHardened(await f.peer(path, "198.51.100.1"));
  }
});

/**
 * The signup form shows no subscriber data, and framing it is legitimate, so it keeps the two
 * caching and referrer headers only (B125, D122 revision).
 */
function expectFrameable(response: Response) {
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBeNull();
  expect(response.headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
}

test("the signup form may be framed: its GET, its POST answers and its limited answer keep no-store and no-referrer only", async () => {
  const f = await open();
  const news = await f.list("News");
  expectFrameable(await f.peer("/subscription/form", "198.51.100.3"));
  const bad = new URLSearchParams({ email: "bad", l: news.uuid }).toString();
  expectFrameable(await f.post("/subscription/form", bad, "192.0.2.71"));
  const accepted = new URLSearchParams({ email: "framed@example.test", l: news.uuid }).toString();
  const posted = await f.post("/subscription/form", accepted, "192.0.2.72");
  expect(posted.status).toBe(200);
  expectFrameable(posted);
  for (let i = 0; i < 5; i++) {
    await f.post("/subscription/form", bad, "192.0.2.70");
  }
  const limited = await f.post("/subscription/form", bad, "192.0.2.70");
  expect(limited.status).toBe(429);
  expectFrameable(limited);
});

test("a campaign page keeps its own Content-Security-Policy and gains frame-ancestors", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const adaUuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const campaign = f.deliveredCampaign([ada], [news.id]);
  const response = await f.peer(`/campaign/${campaign}/${adaUuid}`, "198.51.100.2");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
});
