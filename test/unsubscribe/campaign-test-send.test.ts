// B115 (D117): a campaign test send's unsubscribe and manage links name the test placeholder and
// answer the test page. Following them changes no subscriber, queues no webhook and records no
// click or view, and the test's own links are plain: no tracked link, no view pixel. Through HTTP
// and the SMTP sink. A real send to the same subscriber keeps its behaviour (last test). The
// message and opt-in links are checked in test/public/test-send-links.test.ts, which mounts those
// routes.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";
import type { CampaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { startReceiver } from "@/test/webhooks/receiver";

const testSend = "00000000-0000-0000-0000-000000000001";
const message =
  "This link is from a test send. Unsubscribing from a test does nothing; in a real message this link opens the unsubscribe page.";
const form = { "content-type": "application/x-www-form-urlencoded" };

// The sink keeps latin1 octets; decode quoted-printable and then UTF-8.
const decode = (data: string) =>
  Buffer.from(
    data
      .replaceAll("=\r\n", "")
      .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    "latin1",
  ).toString("utf8");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function open(options: Parameters<typeof campaignsFixture>[0] = {}) {
  const f = await campaignsFixture({ webhooks: {}, ...options });
  cleanups.push(() => f.close());
  return f;
}
const subscriberState = async (f: CampaignsFixture, id: number) =>
  JSON.stringify((await f.json(`/api/subscribers/${id}`)).body.data);
const counters = async (f: CampaignsFixture, id: number) => {
  const data = (await f.json(`/api/campaigns/${id}`)).body.data;
  return { views: data.views, clicks: data.clicks, sent: data.sent };
};

test("a test send's links name the test page, and its message has no tracking", async () => {
  const f = await open();
  const news = await f.list("news");
  const ada = await f.subscriber("ada@example.test", [news]);
  const c = await f.campaign({ name: "Weekly", subject: "Stored", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body:
      '<a href="{{ unsubscribe_url }}">u</a> <a href="{{ manage_url }}">m</a> ' +
      '<a href="{{ message_url }}">v</a> <a href="{{ optin_url }}">o</a> ' +
      '<a href="{{ "https://example.test/o?a=1" | track_link }}">x</a>{{ track_view }}',
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const [mail] = await f.mail(1);
  const data = decode(mail!.data).replaceAll(/\r\n[ \t]+/g, " ");
  const unsubscribe = `http://fixture.test/subscription/${testSend}/${ada.uuid}`;
  expect(data).toContain(`List-Unsubscribe: <${unsubscribe}>`);
  expect(data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  expect(data).toContain(`href="${unsubscribe}"`);
  expect(data).toContain(`href="${unsubscribe}?manage=true"`);
  expect(data).toContain(`href="http://fixture.test/campaign/${testSend}/${ada.uuid}"`);
  expect(data).toContain(`href="http://fixture.test/subscription/optin/${testSend}"`);
  expect(data).toContain('href="https://example.test/o?a=1"');
  expect(data).not.toMatch(/\/link\/|px\.png/);
  expect(await counters(f, c.id)).toEqual({ views: 0, clicks: 0, sent: 0 });
});

test("following a test send's links changes no subscriber, queues no webhook and records nothing", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const f = await open();
  const hookId = (
    await f.json("/api/webhooks", "POST", {
      url: receiver.url(),
      events: ["subscriber.unsubscribed"],
    })
  ).body.data.id as number;
  const news = await f.list("news");
  const double = await f.list("double", "double");
  const ada = await f.subscriber("ada@example.test", [news, double]);
  const before = await subscriberState(f, ada.id);
  const c = await f.campaign({ name: "Weekly", subject: "Stored", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: '<p><a href="{{ track_view }}">v</a>{{ optin_url }} {{ unsubscribe_url }}</p>',
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  await f.mail(1);

  const base = `/subscription/${testSend}/${ada.uuid}`;
  for (const path of [base, `${base}?manage=true`]) {
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain(message);
  }
  const posts: Array<[string, string]> = [
    [base, "List-Unsubscribe=One-Click"],
    [base, "manage=true&blocklist=on"],
    [`${base}?manage=true`, "manage=true&lists=1&lists=2"],
  ];
  for (const [path, body] of posts) {
    const response = await f.request(path, { method: "POST", headers: form, body });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(message);
  }
  expect(await subscriberState(f, ada.id)).toBe(before);
  expect(f.unsubscribed).toEqual([]);
  expect(
    (await f.json(`/api/webhooks/${hookId}/deliveries?per_page=100`)).body.data.results,
  ).toEqual([]);
  expect(await counters(f, c.id)).toEqual({ views: 0, clicks: 0, sent: 0 });
});

test("a real send to the same subscriber still unsubscribes, tracks and queues its webhook", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const f = await runnerFixture({ webhooks: {} });
  cleanups.push(() => f.close());
  await f.json("/api/webhooks", "POST", {
    url: receiver.url(),
    events: ["subscriber.unsubscribed"],
  });
  const single = await f.list("single", "single");
  const sub = await f.member("b@x.test", [single], "confirmed");
  const c = await f.campaign({
    name: "c",
    subject: "s",
    lists: [single],
    content_type: "html",
    body: '<p>{{ unsubscribe_url }}</p><a href="{{ "https://example.test/x" | track_link }}">x</a>{{ track_view }}',
  });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  const push = f.pushes.find((p) => p.to === "b@x.test")!;
  const body = Buffer.from(push.message.body).toString();
  expect(body).toContain(`http://fixture.test/subscription/${c.uuid}/${sub.uuid}`);
  const pixel = /http:\/\/fixture\.test(\/campaign\/[^"]+\/px\.png)/.exec(body)![1]!;
  expect((await f.request(pixel)).status).toBe(200);
  const link = /http:\/\/fixture\.test(\/link\/[^"]+)/.exec(body)![1]!;
  expect((await f.request(link)).status).toBe(307);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data).toMatchObject({ views: 1, clicks: 1 });

  const unsubscribe = await f.request(`/subscription/${c.uuid}/${sub.uuid}`, {
    method: "POST",
    headers: form,
    body: "List-Unsubscribe=One-Click",
  });
  expect(unsubscribe.status).toBe(200);
  expect(await unsubscribe.text()).not.toContain(message);
  const data = (await f.json(`/api/subscribers/${sub.id}`)).body.data;
  expect(data.lists.find((l: { id: number }) => l.id === single)?.subscription_status).toBe(
    "unsubscribed",
  );
  await receiver.waitFor(1);
});
