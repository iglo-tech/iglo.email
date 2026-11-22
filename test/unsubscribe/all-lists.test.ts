// B130 (D128): the public "Unsubscribe from all mailing lists" option, through the public link, POST
// /api/tx and the SMTP sink, with a webhook receiver. It unsubscribes from every list and writes a
// marketing suppression; the status stays, so transactional mail keeps flowing and the webhook is the
// unsubscribe's, not the blocklist's. The admin blocklist still stops every mail, transactional included.
import { afterEach, expect, test } from "bun:test";
import { startReceiver } from "@/test/webhooks/receiver";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
const form = { "content-type": "application/x-www-form-urlencoded" };

async function open() {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());
  return f;
}

/** Two public lists, a subscriber on both, and a template that links its unsubscribe page. */
async function setup(f: TxFixture, address = "ada@example.test") {
  const list = async (name: string) =>
    asBody<number>(
      (await f.json("/api/lists", "POST", { name, type: "public", optin: "single" })).body.data.id,
    );
  const news = await list("News");
  const other = await list("Other");
  const id = await f.subscriber(address, "Ada", { lists: [news, other] });
  const uuid = asBody<string>((await f.json(`/api/subscribers/${id}`)).body.data.uuid);
  const template = await f.template(
    '<p>{{ data.n }} <a href="{{ unsubscribe_url }}">unsub</a></p>',
    "News {{ data.n }}",
  );
  return { news, other, id, uuid, template };
}

const lists = async (f: TxFixture, id: number) =>
  asBody<Array<{ subscription_status: string }>>(
    (await f.json(`/api/subscribers/${id}`)).body.data.lists,
  ).map((l) => l.subscription_status);

/** Sends the option through a marketing send's link, as the page's form and a one-click both do. */
async function chooseAllLists(f: TxFixture, s: Awaited<ReturnType<typeof setup>>) {
  const sent = await f.tx({
    subscriber_id: s.id,
    template_id: s.template,
    kind: "marketing",
    list_id: s.news,
    data: { n: "1" },
  });
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  return f.request(`/m/${send}/unsubscribe/${s.uuid}`, {
    method: "POST",
    headers: form,
    body: "List-Unsubscribe=One-Click&blocklist=true",
  });
}

test("the option unsubscribes from every list, keeps the status, and queues the unsubscribe webhook only", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const f = await open();
  const hook = await f.json("/api/webhooks", "POST", {
    url: receiver.url(),
    events: ["subscriber.unsubscribed", "subscriber.blocklisted"],
  });
  expect(hook.status).toBe(200);
  const s = await setup(f);

  const response = await chooseAllLists(f, s);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("You have unsubscribed successfully.");
  expect((await f.json(`/api/subscribers/${s.id}`)).body.data.status).toBe("enabled");
  expect(await lists(f, s.id)).toEqual(["unsubscribed", "unsubscribed"]);

  const [delivery] = await receiver.waitFor(1);
  expect(delivery!.body.event).toBe("subscriber.unsubscribed");
  // The payload names both lists and says the option wrote a marketing suppression (D128).
  expect([...delivery!.body.data.list_ids].sort()).toEqual([s.news, s.other].sort());
  expect(delivery!.body.data.suppressed).toBe(true);
  const events = receiver.received.map((r) => asBody<{ event: string }>(r.body).event);
  expect(events).not.toContain("subscriber.blocklisted");
});

test("a single-list unsubscribe's webhook names that list and carries no suppressed flag", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const f = await open();
  expect(
    (
      await f.json("/api/webhooks", "POST", {
        url: receiver.url(),
        events: ["subscriber.unsubscribed"],
      })
    ).status,
  ).toBe(200);
  const s = await setup(f);
  const sent = await f.tx({
    subscriber_id: s.id,
    template_id: s.template,
    kind: "marketing",
    list_id: s.news,
    data: { n: "1" },
  });
  const send = asBody<string>(sent.body.data.sends[0].uuid);
  // The mail's link without the option: one list, the form's plain unsubscribe.
  const response = await f.request(`/m/${send}/unsubscribe/${s.uuid}`, {
    method: "POST",
    headers: form,
    body: "List-Unsubscribe=One-Click",
  });
  expect(response.status).toBe(200);
  const statuses = new Map(
    asBody<Array<{ id: number; subscription_status: string }>>(
      (await f.json(`/api/subscribers/${s.id}`)).body.data.lists,
    ).map((l) => [l.id, l.subscription_status]),
  );
  expect(statuses.get(s.news)).toBe("unsubscribed");
  expect(statuses.get(s.other)).not.toBe("unsubscribed");

  const [delivery] = await receiver.waitFor(1);
  expect(delivery!.body.event).toBe("subscriber.unsubscribed");
  expect(delivery!.body.data.list_ids).toEqual([s.news]);
  expect(delivery!.body.data).not.toHaveProperty("suppressed");
});

test("after the option, a marketing send is skipped, and a transactional send still goes out", async () => {
  const f = await open();
  const s = await setup(f);
  expect((await chooseAllLists(f, s)).status).toBe(200);
  const mail = (address: string, marketing: boolean) =>
    f.sink.messages.filter(
      (m) => m.to.includes(address) && m.data.includes("List-Unsubscribe:") === marketing,
    ).length;
  const marketingBefore = mail("ada@example.test", true);

  // A marketing send to the other list it left: refused by consent, no mail.
  const marketing = await f.tx({
    subscriber_id: s.id,
    template_id: s.template,
    kind: "marketing",
    list_id: s.other,
    data: { n: "2" },
  });
  const row = (await f.json(`/api/sends/${marketing.body.data.sends[0].id}`)).body.data;
  expect(row).toMatchObject({ status: "skipped", skip_reason: "unsubscribed" });
  expect(mail("ada@example.test", true)).toBe(marketingBefore);

  // A transactional send: the status is enabled, so it is not refused.
  const transactional = await f.tx({
    subscriber_id: s.id,
    template_id: s.template,
    kind: "transactional",
    data: { n: "3" },
  });
  expect(transactional.body.data.sends[0].status).toBe("sent");
  expect(mail("ada@example.test", false)).toBe(1);
});

test("the admin blocklist is not the option: it still stops a transactional send", async () => {
  const f = await open();
  const s = await setup(f, "blocked@example.test");
  expect((await f.json("/api/subscribers/blocklist", "PUT", { ids: [s.id] })).status).toBe(200);
  const attempt = await f.tx({
    subscriber_id: s.id,
    template_id: s.template,
    kind: "transactional",
    data: { n: "4" },
  });
  const row = (await f.json(`/api/sends/${attempt.body.data.sends[0].id}`)).body.data;
  expect(row).toMatchObject({ status: "skipped", skip_reason: "subscriber_blocklisted" });
  expect(f.sink.messages.filter((m) => m.to.includes("blocked@example.test"))).toHaveLength(0);
});
