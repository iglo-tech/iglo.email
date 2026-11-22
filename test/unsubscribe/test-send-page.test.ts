// B112 (D116): the unsubscribe and manage links of a marketing test send carry the placeholder
// send UUID. Through HTTP only: the page answers for any subscriber UUID, a POST changes nothing,
// and no webhook is queued. A real send's links keep their behaviour (unsubscribe.test.ts).
import { afterEach, expect, test } from "bun:test";
import { startReceiver } from "@/test/webhooks/receiver";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const placeholder = "00000000-0000-0000-0000-000000000000";
const message =
  "This link is from a test send. Unsubscribing from a test does nothing; in a real message this link opens the unsubscribe page.";
const form = { "content-type": "application/x-www-form-urlencoded" };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture({ webhooks: {}, ...options });
  cleanups.push(() => f.close());
  return f;
}
const membership = async (f: TxFixture, subscriber: number, list: number) =>
  asBody<Array<{ id: number; subscription_status: string }>>(
    (await f.json(`/api/subscribers/${subscriber}`)).body.data.lists,
  ).find((l) => l.id === list)?.subscription_status;
const deliveries = async (f: TxFixture, hook: number) =>
  asBody<Array<unknown>>(
    (await f.json(`/api/webhooks/${hook}/deliveries?per_page=100`)).body.data.results,
  );

test("the placeholder unsubscribe and manage links answer the test page for any subscriber UUID", async () => {
  const f = await open();
  const list = asBody<number>(
    (await f.json("/api/lists", "POST", { name: "news", type: "public", optin: "single" })).body
      .data.id,
  );
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list] });
  const adaUuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const absent = crypto.randomUUID();
  const paths = [
    `/m/${placeholder}/unsubscribe/${adaUuid}`,
    `/m/${placeholder}/unsubscribe/${adaUuid}?manage=true`,
    `/m/${placeholder}/unsubscribe/${absent}`,
    `/m/${placeholder}/unsubscribe/${absent}?manage=true`,
    `/m/${placeholder}/unsubscribe/not-a-uuid`,
  ];
  const bodies: Array<string> = [];
  for (const path of paths) {
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    bodies.push(await response.text());
  }
  expect(bodies[0]).toContain(message);
  // Existence of the subscriber is not revealed: every answer is the same page.
  expect(new Set(bodies).size).toBe(1);
  expect(await membership(f, ada, list)).toBe("unconfirmed");
});

test("POST to the placeholder, as the page form or one-click, answers the same page and changes nothing", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const events: Array<unknown> = [];
  const f = await open({ effects: { unsubscribed: (event) => events.push(event) } });
  const hook = await f.json("/api/webhooks", "POST", {
    url: receiver.url(),
    events: ["subscriber.unsubscribed"],
  });
  expect(hook.status).toBe(200);
  const hookId = asBody<number>(hook.body.data.id);
  const list = asBody<number>(
    (await f.json("/api/lists", "POST", { name: "news", type: "public", optin: "single" })).body
      .data.id,
  );
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list] });
  const adaUuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const path = `/m/${placeholder}/unsubscribe/${adaUuid}`;

  for (const body of ["List-Unsubscribe=One-Click", "manage=true&blocklist=on", ""]) {
    const response = await f.request(path, { method: "POST", headers: form, body });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(message);
  }
  expect((await f.request(path, { method: "POST" })).status).toBe(200);

  expect(await membership(f, ada, list)).toBe("unconfirmed");
  expect((await f.json(`/api/subscribers/${ada}`)).body.data.status).toBe("enabled");
  expect(events).toEqual([]);
  expect(await deliveries(f, hookId)).toEqual([]);
});

test("a real one-click on a real send still unsubscribes and queues its webhook", async () => {
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const events: Array<unknown> = [];
  const f = await open({ effects: { unsubscribed: (event) => events.push(event) } });
  const hook = await f.json("/api/webhooks", "POST", {
    url: receiver.url(),
    events: ["subscriber.unsubscribed"],
  });
  const hookId = asBody<number>(hook.body.data.id);
  const list = asBody<number>(
    (await f.json("/api/lists", "POST", { name: "news", type: "public", optin: "single" })).body
      .data.id,
  );
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list] });
  const adaUuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const template = await f.template('<a href="{{ unsubscribe_url }}">u</a>', "News");
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list,
  });
  expect(sent.body.data.sends[0].status).toBe("sent");
  const send = asBody<string>(sent.body.data.sends[0].uuid);

  const response = await f.request(`/m/${send}/unsubscribe/${adaUuid}`, {
    method: "POST",
    headers: form,
    body: "List-Unsubscribe=One-Click",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("You have unsubscribed successfully.");
  expect(await membership(f, ada, list)).toBe("unsubscribed");
  expect(events).toHaveLength(1);
  expect(await deliveries(f, hookId)).toHaveLength(1);
  await receiver.waitFor(1);
});
