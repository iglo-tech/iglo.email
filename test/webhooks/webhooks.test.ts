// M2.6 outbound webhooks through the HTTP API, the injected clock and a local receiver.
import { afterEach, expect, test } from "bun:test";
import { writeTransaction } from "@/db/transaction";
import { blockedAddress } from "@/webhooks/address";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import {
  signatureTime,
  signatureValid,
  startReceiver,
  type Receiver,
} from "@/test/webhooks/receiver";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
type Options = Parameters<typeof txFixture>[0];
async function open(options: Options = {}) {
  const f = await txFixture({ webhooks: {}, ...options });
  cleanups.push(() => f.close());
  return f;
}
function receiver(respond?: Parameters<typeof startReceiver>[0]) {
  const r = startReceiver(respond);
  cleanups.push(() => r.close());
  return r;
}
const all = [
  "subscriber.unsubscribed",
  "subscriber.blocklisted",
  "subscriber.deleted",
  "send.failed",
  "bounce.recorded",
];
const hook = async (f: TxFixture, r: Receiver, events = all, extra: object = {}) => {
  const created = await f.json("/api/webhooks", "POST", { url: r.url(), events, ...extra });
  expect(created.status).toBe(200);
  return created.body.data as { id: number; secret: string };
};
const deliveries = async (f: TxFixture, id: number) =>
  (await f.json(`/api/webhooks/${id}/deliveries?per_page=100`)).body.data.results as any[];
/** Network I/O is real, so settling is awaited in real time; delays use the injected clock. */
async function until(check: () => unknown | Promise<unknown>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(2);
  }
}
const settled = (f: TxFixture, id: number, uuid: string, status: string, attempts?: number) =>
  until(async () => {
    const row = (await deliveries(f, id)).find((d) => d.uuid === uuid);
    return (
      row?.status === status &&
      !row.claimed_until &&
      (attempts === undefined || row.attempts === attempts)
    );
  });
const queued = (f: TxFixture, id: number, attempts: number) =>
  until(async () => {
    const [row] = await deliveries(f, id);
    return row?.attempts === attempts && row.status === "queued" && !row.claimed_until;
  });
const blocklist = (f: TxFixture, id: number) =>
  f.json(`/api/subscribers/${id}/blocklist`, "PUT", {});
const stored = (f: TxFixture) =>
  f.db.query("SELECT event, status, payload FROM webhook_deliveries ORDER BY id").all() as {
    event: string;
    status: string;
    payload: string;
  }[];

test("configuration needs webhooks:manage and the usual auth and CSRF", async () => {
  const f = await open();
  const anonymous = await f.json("/api/webhooks", "GET", undefined, {});
  expect(anonymous.status).toBe(403);
  const role = await f.json("/api/roles/users", "POST", {
    name: "no-hooks",
    permissions: ["subscribers:get"],
  });
  const user = await f.json("/api/users", "POST", {
    username: "no-hooks",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  const basic = { authorization: `Basic ${btoa(`no-hooks:${user.body.data.password}`)}` };
  for (const [path, method, body] of [
    ["/api/webhooks", "GET"],
    ["/api/webhooks", "POST", { url: "http://r.test/", events: all }],
    ["/api/webhooks/1", "PUT", { enabled: false }],
    ["/api/webhooks/1", "DELETE"],
    ["/api/webhooks/1/deliveries", "GET"],
  ] as const)
    expect((await f.json(path, method, body, basic)).status).toBe(403);
  const { "x-csrf-token": _csrf, ...noCsrf } = f.sessionHeaders as Record<string, string>;
  const forged = await f.json(
    "/api/webhooks",
    "POST",
    { url: "http://r.test/", events: all },
    noCsrf,
  );
  expect(forged.status).toBe(403);
  expect((await f.json("/api/webhooks")).body.data.total).toBe(0);
});

test("the secret is shown once at create and never again", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
  const supplied = await hook(f, r, all, { secret: "s".repeat(32) });
  expect(supplied.secret).toBe("s".repeat(32));
  const update = await f.json(`/api/webhooks/${created.id}`, "PUT", { enabled: false });
  expect(update.status).toBe(200);
  const listed = await f.json("/api/webhooks");
  const text = JSON.stringify([update.body, listed.body]);
  expect(text).not.toContain(created.secret);
  expect(text).not.toContain(supplied.secret);
  expect(text).not.toContain('"secret"');
  expect(listed.body.data.results.map((w: any) => w.enabled)).toEqual([false, true]);
  // Rotation is delete and recreate; a silently ignored new secret would mislead a caller.
  expect(
    (await f.json(`/api/webhooks/${created.id}`, "PUT", { secret: "x".repeat(32) })).status,
  ).toBe(400);
});

test("URLs, events and secrets are validated and a rejected write stores nothing", async () => {
  const f = await open();
  const url = "http://r.test/hook";
  for (const body of [
    { url: "ftp://r.test/", events: all },
    { url: "file:///etc/passwd", events: all },
    { url: "not a url", events: all },
    { url: "http://user:pass@r.test/", events: all },
    { url: "http://r.test/\nInjected: 1", events: all },
    { url: `http://r.test/${"a".repeat(2048)}`, events: all },
    { url, events: [] },
    { url, events: ["subscriber.nope"] },
    { url, events: "subscriber.deleted" },
    { url, events: all, enabled: "yes" },
    { url, events: all, secret: "short" },
    { url, events: all, secret: "s".repeat(257) },
    { url, events: all, secret: 12 },
  ])
    expect((await f.json("/api/webhooks", "POST", body)).status).toBe(400);
  expect((await f.json("/api/webhooks")).body.data.total).toBe(0);
  const made = await f.json("/api/webhooks", "POST", { url, events: all });
  expect(
    (await f.json(`/api/webhooks/${made.body.data.id}`, "PUT", { url: "ftp://x/" })).status,
  ).toBe(400);
  expect((await f.json("/api/webhooks/999", "PUT", { enabled: false })).status).toBe(404);
  expect((await f.json("/api/webhooks/999", "DELETE")).status).toBe(404);
  expect((await f.json("/api/webhooks/999/deliveries")).status).toBe(404);
  expect((await f.json("/api/webhooks?per_page=101")).status).toBe(400);
  expect((await f.json(`/api/webhooks/${made.body.data.id}/deliveries?per_page=101`)).status).toBe(
    400,
  );
});

test("configured webhooks are bounded, which bounds fan-out per event", async () => {
  const f = await open();
  const r = receiver();
  for (let i = 0; i < 20; i++) await hook(f, r, ["send.failed"]);
  const over = await f.json("/api/webhooks", "POST", { url: r.url(), events: all });
  expect(over.status).toBe(400);
});

test("every listed event reaches the receiver correctly signed", async () => {
  const f = await open({ reject: () => true });
  const r = receiver();
  const { secret } = await hook(f, r);
  const list = (await f.json("/api/lists", "POST", { name: "l", type: "public", optin: "single" }))
    .body.data.id as number;
  const email = (name: string, extra: object = {}) =>
    f.subscriber(`${name}@example.test`, name, { lists: [list], ...extra });

  const unsub = await email("unsub", { external_id: "app-1" });
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [unsub],
    action: "unsubscribe",
    target_list_ids: [list],
  });
  await r.waitFor(1);
  const blocked = await email("blocked");
  await blocklist(f, blocked);
  await r.waitFor(3);
  const deleted = await email("deleted", { external_id: "app-3" });
  await f.json(`/api/subscribers/${deleted}`, "DELETE");
  await r.waitFor(4);
  const failing = await email("failing");
  const template = await f.template("<p>hello</p>");
  await f.tx({ subscriber_id: failing, template_id: template });
  await r.waitFor(5);
  writeTransaction(f.db, () =>
    f.webhooks!.queueWebhook("bounce.recorded", () => ({
      subscriber: null,
      list_ids: [],
      bounce: { type: "hard" },
    })),
  );
  await r.waitFor(6);

  const seen = Object.fromEntries(r.received.toReversed().map((x) => [x.body.event, x]));
  for (const received of r.received) {
    expect(signatureValid(received, secret)).toBe(true);
    expect(Object.keys(received.body)).toEqual(["id", "event", "occurred_at", "data"]);
    expect(received.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(received.body.occurred_at).toBe(f.clock.now().toISOString());
  }
  const person = (await f.json(`/api/subscribers/${unsub}`)).body.data;
  expect(seen["subscriber.unsubscribed"]!.body.data).toEqual({
    subscriber: {
      id: unsub,
      uuid: person.uuid,
      email: "unsub@example.test",
      external_id: "app-1",
    },
    list_ids: [list],
  });
  expect(seen["subscriber.blocklisted"]!.body.data.subscriber.email).toBe("blocked@example.test");
  expect(seen["subscriber.blocklisted"]!.body.data.list_ids).toEqual([list]);
  expect(seen["subscriber.deleted"]!.body.data.subscriber.id).toBe(deleted);
  expect(seen["subscriber.deleted"]!.body.data.list_ids).toEqual([list]);
  const failed = seen["send.failed"]!.body.data;
  expect(failed.subscriber.email).toBe("failing@example.test");
  expect(failed.send).toMatchObject({ status: "failed", error: "not_accepted" });
  expect(failed.send.uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen["bounce.recorded"]!.body.data.bounce).toEqual({ type: "hard" });
  // The blocklisted subscriber's memberships ended too, so consent listeners also hear it.
  expect(
    r.received
      .filter((x) => x.body.event === "subscriber.unsubscribed")
      .map((x) => x.body.data.subscriber.email),
  ).toEqual(["unsub@example.test", "blocked@example.test"]);
});

test("a send to an address outside the subscribers carries no address", async () => {
  const f = await open({ reject: () => true });
  const r = receiver();
  await hook(f, r, ["send.failed"]);
  const template = await f.template("<p>hello</p>");
  await f.tx({ subscriber_email: "stranger@example.test", template_id: template });
  await r.waitFor(1);
  expect(r.received[0]!.body.data.subscriber).toBeNull();
  expect(r.received[0]!.text).not.toContain("stranger");
});

test("one delivery per enabled webhook subscribed to the event", async () => {
  const f = await open();
  const r = receiver();
  const wanted = await hook(f, r, ["subscriber.blocklisted"]);
  const other = await hook(f, r, ["send.failed"]);
  const off = await hook(f, r, ["subscriber.blocklisted"], { enabled: false });
  const second = await hook(f, r, ["subscriber.blocklisted", "subscriber.deleted"]);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(2);
  expect((await deliveries(f, wanted.id)).length).toBe(1);
  expect((await deliveries(f, second.id)).length).toBe(1);
  expect((await deliveries(f, other.id)).length).toBe(0);
  expect((await deliveries(f, off.id)).length).toBe(0);
  const [a] = await deliveries(f, wanted.id);
  const [b] = await deliveries(f, second.id);
  expect(a.uuid).not.toBe(b.uuid);
});

test("a rollback queues nothing and repeats of a consent change queue nothing new", async () => {
  const f = await open();
  const r = receiver();
  const { id } = await hook(f, r);
  const subscriber = await f.subscriber("a@example.test");
  expect(() =>
    writeTransaction(f.db, () => {
      f.webhooks!.queueWebhook("subscriber.deleted", () => ({ subscriber: null, list_ids: [] }));
      throw new Error("rolled back");
    }),
  ).toThrow("rolled back");
  expect(stored(f)).toEqual([]);
  await blocklist(f, subscriber);
  await r.waitFor(1);
  await blocklist(f, subscriber);
  await f.json(`/api/subscribers/${subscriber}`, "PUT", {
    email: "a@example.test",
    name: "a",
    status: "blocklisted",
  });
  await settled(f, id, r.received[0]!.body.id, "delivered");
  expect((await deliveries(f, id)).length).toBe(1);
  expect(() =>
    f.webhooks!.queueWebhook("send.failed", () => ({ subscriber: null, list_ids: [] })),
  ).toThrow();
});

test("an update that blocklists a subscriber reports the memberships it ended", async () => {
  const f = await open();
  const r = receiver();
  await hook(f, r, ["subscriber.unsubscribed", "subscriber.blocklisted"]);
  const list = (await f.json("/api/lists", "POST", { name: "l", type: "public", optin: "single" }))
    .body.data.id as number;
  const subscriber = await f.subscriber("a@example.test", "a", { lists: [list] });
  await f.json(`/api/subscribers/${subscriber}`, "PUT", {
    email: "a@example.test",
    name: "a",
    status: "blocklisted",
    lists: [list],
  });
  await r.waitFor(2);
  expect(r.received.map((x) => [x.body.event, x.body.data.list_ids])).toEqual([
    ["subscriber.unsubscribed", [list]],
    ["subscriber.blocklisted", [list]],
  ]);
  // Created blocklisted: an admin blocklisting, with no membership that ended.
  await f.subscriber("b@example.test", "b", { lists: [list], status: "blocklisted" });
  await r.waitFor(3);
  expect(r.received[2]!.body.event).toBe("subscriber.blocklisted");
});

test("one-click unsubscribes queue once, inside the unsubscribe transaction", async () => {
  const f = await open();
  const r = receiver();
  const { id } = await hook(f, r, ["subscriber.unsubscribed"]);
  f.marketing.minInterval = "";
  const list = (await f.json("/api/lists", "POST", { name: "l", type: "public", optin: "single" }))
    .body.data.id as number;
  const subscriber = await f.subscriber("a@example.test", "A", { lists: [list] });
  const template = await f.template('<a href="{{ unsubscribe_url }}">u</a>');
  const sent = await f.tx({
    subscriber_id: subscriber,
    template_id: template,
    kind: "marketing",
    list_id: list,
  });
  expect(sent.body.data.sends[0].status).toBe("sent");
  const send = sent.body.data.sends[0].uuid as string;
  const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid as string;
  const post = () =>
    f.request(`/m/${send}/unsubscribe/${uuid}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
  expect((await post()).status).toBe(200);
  await r.waitFor(1);
  expect((await post()).status).toBe(200);
  await settled(f, id, r.received[0]!.body.id, "delivered");
  expect((await deliveries(f, id)).length).toBe(1);
  expect(r.received[0]!.body.data.list_ids).toEqual([list]);
});

test("retries follow the injected clock with the same id and bytes and a fresh timestamp", async () => {
  const f = await open();
  const r = receiver((_, count) => new Response("no", { status: count < 3 ? 500 : 200 }));
  const { id, secret } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  await queued(f, id, 1);
  const [first] = await deliveries(f, id);
  expect(first.last_error).toBe("http_500");
  expect(Date.parse(first.next_attempt_at) - f.clock.now().getTime()).toBe(30_000);

  f.advanceWebhooks(29_000);
  await Bun.sleep(20);
  expect(r.received.length).toBe(1);
  f.advanceWebhooks(1_000);
  await r.waitFor(2);
  await queued(f, id, 2);
  const [second] = await deliveries(f, id);
  expect(Date.parse(second.next_attempt_at) - f.clock.now().getTime()).toBe(60_000);
  f.advanceWebhooks(60_000);
  await r.waitFor(3);
  await settled(f, id, first.uuid, "delivered", 3);

  const [a, b, c] = r.received;
  expect(new Set([a!.text, b!.text, c!.text]).size).toBe(1);
  expect(a!.body.id).toBe(first.uuid);
  for (const x of r.received) expect(signatureValid(x, secret)).toBe(true);
  expect(signatureTime(b!) - signatureTime(a!)).toBe(30);
  expect(signatureTime(c!) - signatureTime(b!)).toBe(60);
  const [done] = await deliveries(f, id);
  expect(done.next_attempt_at).toBeNull();
  expect(done.last_error).toBeNull();
  expect(done).not.toHaveProperty("payload");
});

test("a delivery fails safely 24 hours after queueing and stops retrying", async () => {
  const f = await open();
  const r = receiver(() => new Response("secret body", { status: 503 }));
  const { id, secret } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  const start = f.clock.now().getTime();
  let row: any;
  for (let n = 1; ; n++) {
    await until(async () => {
      [row] = await deliveries(f, id);
      return row.attempts === n && !row.claimed_until;
    });
    if (row.status === "failed") break;
    expect(Date.parse(row.next_attempt_at)).toBeLessThanOrEqual(start + 86_400_000);
    f.advanceWebhooks(Date.parse(row.next_attempt_at) - f.clock.now().getTime());
  }
  expect(f.clock.now().getTime()).toBe(start + 86_400_000);
  expect(row.last_error).toBe("http_503");
  expect(row.next_attempt_at).toBeNull();
  const count = r.received.length;
  f.advanceWebhooks(86_400_000);
  await Bun.sleep(20);
  expect(r.received.length).toBe(count);
  const logged = f.errors.map(String).join("\n");
  expect(logged).toContain(`Webhook ${id}`);
  expect(logged).not.toContain(secret);
  expect(logged).not.toContain(r.url());
  expect(logged).not.toContain("secret body");
  // Repeated failure is reported for attention, not once per attempt.
  expect(f.errors.length).toBeLessThan(count);
});

test("redirects are not followed and count as failures", async () => {
  const f = await open();
  const r = receiver(
    () => new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
  );
  const { id } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  await queued(f, id, 1);
  expect((await deliveries(f, id))[0].last_error).toBe("redirect_302");
  expect(r.received.map((x) => x.path)).toEqual(["/hook"]);
});

test("a hung receiver times out on the injected clock and starves no other receiver", async () => {
  const f = await open();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(() => release());
  const hung = receiver(async () => {
    await held;
    return new Response("late");
  });
  const healthy = receiver();
  const stuck = await hook(f, hung, ["subscriber.blocklisted"]);
  await hook(f, healthy, ["subscriber.blocklisted"]);
  for (let i = 0; i < 12; i++) await blocklist(f, await f.subscriber(`a${i}@example.test`));
  // The healthy receiver gets everything while the hung one holds its slots.
  await healthy.waitFor(12);
  await hung.waitFor(4);
  await Bun.sleep(20);
  expect(hung.received.length).toBe(4);
  f.advanceWebhooks(10_000);
  await until(async () => (await deliveries(f, stuck.id)).some((d) => d.last_error === "timeout"));
});

test("a large response body is not read to its end", async () => {
  const f = await open();
  let sent = 0;
  const r = receiver(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 65_536;
            controller.enqueue(new Uint8Array(65_536));
            if (sent > 512 * 1048576) controller.close();
          },
        }),
      ),
  );
  const { id } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  await settled(f, id, r.received[0]!.body.id, "delivered", 1);
  expect(sent).toBeLessThan(256 * 1048576);
});

test("a disabled webhook holds its deliveries, resumes when enabled, and fails after 24 hours", async () => {
  const f = await open();
  const r = receiver();
  const { id } = await hook(f, r);
  // Queued while enabled, disabled before the loop can run.
  writeTransaction(f.db, () => {
    f.webhooks!.queueWebhook("send.failed", () => ({ subscriber: null, list_ids: [] }));
    f.webhooks!.update(BigInt(id), { url: r.url(), events: all, enabled: false });
  });
  await blocklist(f, await f.subscriber("skipped@example.test"));
  expect((await deliveries(f, id)).length).toBe(1);
  f.advanceWebhooks(1000);
  await until(async () => (await deliveries(f, id))[0].last_error === "webhook_disabled");
  expect(r.received.length).toBe(0);
  // Enabled again within the window: everything still queued arrives.
  await f.json(`/api/webhooks/${id}`, "PUT", { enabled: true });
  f.advanceWebhooks(3_600_000);
  await until(async () => (await deliveries(f, id)).every((d) => d.status === "delivered"));

  const before = r.received.length;
  writeTransaction(f.db, () => {
    f.webhooks!.queueWebhook("send.failed", () => ({ subscriber: null, list_ids: [] }));
    f.webhooks!.update(BigInt(id), { url: r.url(), events: all, enabled: false });
  });
  for (let i = 0; i < 30; i++) {
    f.advanceWebhooks(3_600_000);
    await until(async () => {
      const [row] = await deliveries(f, id);
      return row.status === "failed" || Date.parse(row.next_attempt_at) > f.clock.now().getTime();
    });
  }
  await until(async () =>
    (await deliveries(f, id)).some(
      (d) => d.last_error === "webhook_disabled" && d.status === "failed",
    ),
  );
  expect(r.received.length).toBe(before);
});

test("deleting a webhook removes its deliveries and an in-flight attempt settles harmlessly", async () => {
  const f = await open();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(() => release());
  const r = receiver(async () => {
    await held;
    return new Response("ok");
  });
  const { id } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  expect((await f.json(`/api/webhooks/${id}`, "DELETE")).status).toBe(200);
  release();
  await Bun.sleep(20);
  expect(stored(f)).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("a restart resumes queued and in-flight deliveries from durable state", async () => {
  const f = await open();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(() => release());
  const r = receiver(async () => {
    await held;
    return new Response("lost");
  });
  const { id, secret } = await hook(f, r);
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  // An abrupt end: the attempt never settles, and only the row's lease remains.
  await f.crashWebhooks();
  await f.startWebhooks();
  r.respond(() => new Response("ok"));
  await r.waitFor(2);
  await settled(f, id, r.received[0]!.body.id, "delivered", 2);
  expect(r.received[1]!.body.id).toBe(r.received[0]!.body.id);
  expect(signatureValid(r.received[1]!, secret)).toBe(true);
});

test("deleting a subscriber clears personal data from every stored delivery", async () => {
  const f = await open();
  const r = receiver((_, count) => new Response("x", { status: count === 2 ? 500 : 200 }));
  const { id } = await hook(f, r);
  const subscriber = await f.subscriber("private@example.test", "P", {
    external_id: "app-private",
  });
  const other = await f.subscriber("other@example.test");
  // One delivered, one still pending a retry.
  await blocklist(f, subscriber);
  await r.waitFor(1);
  await settled(f, id, r.received[0]!.body.id, "delivered");
  await blocklist(f, other);
  await r.waitFor(2);
  await queued(f, id, 1);
  const pendingOf = await f.subscriber("pending@example.test", "P", { external_id: "app-p" });
  r.respond(() => new Response("x", { status: 500 }));
  await blocklist(f, pendingOf);
  await r.waitFor(3);
  await until(async () => (await deliveries(f, id)).every((d) => !d.claimed_until));
  r.respond(() => new Response("ok"));

  await f.json(`/api/subscribers/${subscriber}`, "DELETE");
  await f.json(`/api/subscribers/${pendingOf}`, "DELETE");
  const body = () =>
    stored(f)
      .map((row) => row.payload)
      .join("\n");
  expect(body()).not.toContain("private@example.test");
  expect(body()).not.toContain("pending@example.test");
  expect(body()).toContain("other@example.test");

  // The clock jump would time out a request still in flight.
  await until(async () => (await deliveries(f, id)).every((d) => !d.claimed_until));
  f.advanceWebhooks(3_600_000);
  await until(async () => (await deliveries(f, id)).every((d) => d.status === "delivered"));
  const retried = r.received.filter(
    (x) => x.body.event === "subscriber.blocklisted" && x.body.data.subscriber.email === "",
  );
  expect(retried.length).toBe(1);
  expect(retried[0]!.body.data.subscriber.external_id).toBeNull();
  expect(retried[0]!.body.data.subscriber.id).toBe(pendingOf);

  const events = r.received.filter((x) => x.body.event === "subscriber.deleted");
  expect(events.length).toBe(2);
  const event = events.find((x) => x.body.data.subscriber.id === subscriber)!;
  // The receiver's own key goes out, once, so it can match its record; the address never does.
  expect(event.body.data.subscriber.email).toBe("");
  expect(event.body.data.subscriber.external_id).toBe("app-private");
  expect(event.body.data.subscriber.uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(body()).not.toContain("app-private");
  expect(body()).not.toContain("app-p");
});

test("a retry of a pending subscriber.deleted keeps its bytes until the delivery ends", async () => {
  const f = await open();
  const r = receiver((_, count) => new Response("x", { status: count === 1 ? 500 : 200 }));
  const { id } = await hook(f, r, ["subscriber.deleted"]);
  const subscriber = await f.subscriber("a@example.test", "A", { external_id: "app-a" });
  await f.json(`/api/subscribers/${subscriber}`, "DELETE");
  await r.waitFor(1);
  await queued(f, id, 1);
  expect(stored(f)[0]!.payload).toContain("app-a");
  f.advanceWebhooks(30_000);
  await r.waitFor(2);
  await settled(f, id, r.received[0]!.body.id, "delivered", 2);
  expect(r.received[1]!.text).toBe(r.received[0]!.text);
  expect(stored(f)[0]!.payload).not.toContain("app-a");
});

test("block_private_addresses refuses private targets after resolution, without a request", async () => {
  const names: Record<string, string[]> = { "rebind.test": ["93.184.216.34", "10.0.0.8"] };
  const f = await open({
    webhooks: {
      lookup: async (host: string) => names[host] ?? ["127.0.0.1"],
    },
  });
  const r = receiver();
  f.blockPrivate.value = true;
  const targets = [r.url(), `http://localhost:${r.port}/`, "http://rebind.test/", "http://[::1]/"];
  const ids: number[] = [];
  for (const url of targets)
    ids.push(
      (await f.json("/api/webhooks", "POST", { url, events: ["subscriber.blocklisted"] })).body.data
        .id,
    );
  await blocklist(f, await f.subscriber("a@example.test"));
  for (const id of ids) await queued(f, id, 1);
  for (const id of ids) expect((await deliveries(f, id))[0].last_error).toBe("blocked_address");
  expect(r.received.length).toBe(0);
  // Off (the default), a self-hosted receiver on a private address works.
  f.blockPrivate.value = false;
  f.advanceWebhooks(30_000);
  await r.waitFor(1);
});

test("a resolver that never answers cannot outlast the request deadline", async () => {
  const f = await open({ webhooks: { lookup: () => new Promise(() => {}) } });
  const r = receiver();
  f.blockPrivate.value = true;
  const { id } = await hook(f, r);
  await f.json(`/api/webhooks/${id}`, "PUT", { url: "http://never.test/" });
  await blocklist(f, await f.subscriber("a@example.test"));
  await until(async () => (await deliveries(f, id))[0]?.claimed_until);
  f.advanceWebhooks(10_000);
  await queued(f, id, 1);
  expect((await deliveries(f, id))[0].last_error).toBe("timeout");
});

test("with blocking on, the request goes to the checked address, not a fresh lookup", async () => {
  let lookups = 0;
  const f = await open({
    webhooks: {
      lookup: async () => {
        lookups++;
        return lookups === 1 ? ["127.0.0.1"] : ["10.9.9.9"];
      },
      // The test's loopback receiver stands in for a public address.
      blocked: (address: string) => address !== "127.0.0.1",
    },
  });
  const r = receiver();
  f.blockPrivate.value = true;
  await f.json("/api/webhooks", "POST", {
    url: `http://receiver.test:${r.port}/pinned?x=1`,
    events: ["subscriber.blocklisted"],
  });
  await blocklist(f, await f.subscriber("a@example.test"));
  await r.waitFor(1);
  expect(r.received[0]!.host).toBe(`receiver.test:${r.port}`);
  expect(r.received[0]!.path).toBe("/pinned");
  expect(lookups).toBe(1);
});

test("non-public addresses are classified as blocked", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:a00:1",
    "::10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:a00:1::",
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "100::1",
    "not-an-address",
  ])
    expect([address, blockedAddress(address)]).toEqual([address, true]);
  for (const address of [
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::",
  ])
    expect([address, blockedAddress(address)]).toEqual([address, false]);
});
