// Injected clock and a local receiver. The upstream-shared corpus is in
// test/contract/bounces.ts; these cover what needs the clock or a failure inside a transaction.
import { afterEach, expect, test } from "bun:test";
import { HttpError } from "@/server/response";
import { createSubscriberStore, noSubscriberEffects } from "@/subscribers/store";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";
import { bounceMessage, envelope, network, post } from "@/test/bounces/ses-fixture";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const events = ["bounce.recorded", "subscriber.blocklisted", "subscriber.deleted"];
async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture({ webhooks: {}, ...options });
  cleanups.push(() => f.close());
  return f;
}
async function hooked(f: TxFixture, subscribed: string[] = events) {
  const r = startReceiver();
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", { url: r.url(), events: subscribed });
  expect(created.status).toBe(200);
  return { receiver: r, secret: created.body.data.secret as string };
}
const rowsOf = (f: TxFixture) =>
  f.db.query("SELECT subscriber_id, send_id, type, meta FROM bounces ORDER BY id").all() as {
    subscriber_id: bigint | null;
    send_id: bigint | null;
    type: string;
    meta: string;
  }[];
const statusOf = async (f: TxFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data?.status as string | undefined;
const deliveries = (f: TxFixture) =>
  (
    f.db.query("SELECT event, payload FROM webhook_deliveries ORDER BY id").all() as {
      event: string;
      payload: string;
    }[]
  ).map((row) => ({ event: row.event, body: JSON.parse(row.payload) }));

test("native meta spellings are stored as objects", async () => {
  const f = await open();
  await f.subscriber("meta@example.com");
  f.setBounceAction("soft", { count: 9, action: "none" });
  for (const meta of ['{"a":1}', "plain text", 7, ["x"], null])
    expect(
      (
        await f.json("/webhooks/bounce", "POST", {
          email: "meta@example.com",
          type: "soft",
          source: "api",
          meta,
        })
      ).status,
    ).toBe(200);
  expect(rowsOf(f).map((row) => JSON.parse(row.meta))).toEqual([
    { a: 1 },
    { value: "plain text" },
    { value: 7 },
    { value: ["x"] },
    {},
  ]);
});

test("actions fire signed webhooks at the receiver", async () => {
  const f = await open();
  const { receiver, secret } = await hooked(f);
  const list = await f.json("/api/lists", "POST", { name: "hooked", type: "private" });
  const id = await f.subscriber("hooked@example.com", "Hooked", {
    external_id: "app-1",
    lists: [list.body.data.id],
  });
  await f.json("/webhooks/bounce", "POST", {
    email: "hooked@example.com",
    type: "hard",
    source: "api",
  });
  await receiver.waitFor(2);
  const bounce = receiver.received.find((r) => r.body.event === "bounce.recorded")!;
  expect(signatureValid(bounce, secret)).toBe(true);
  expect(bounce.body.data).toEqual({
    subscriber: {
      id,
      uuid: expect.any(String),
      email: "hooked@example.com",
      external_id: "app-1",
    },
    list_ids: [list.body.data.id],
    bounce: { id: expect.any(Number), type: "hard", source: "api" },
  });
  const blocklisted = receiver.received.find((r) => r.body.event === "subscriber.blocklisted")!;
  expect(signatureValid(blocklisted, secret)).toBe(true);
});

test("a stored bounce delivery is cleared by the delete action and by a wipe", async () => {
  const f = await open();
  await hooked(f);
  const list = await f.json("/api/lists", "POST", { name: "cleared", type: "private" });
  await f.subscriber("gone@example.com", "Gone", {
    external_id: "app-2",
    lists: [list.body.data.id],
  });
  await f.json("/webhooks/bounce", "POST", {
    email: "gone@example.com",
    type: "complaint",
    source: "api",
  });
  const [recorded, deleted] = deliveries(f);
  expect(recorded!.event).toBe("bounce.recorded");
  expect(recorded!.body.data.subscriber.email).toBe("");
  expect(recorded!.body.data.subscriber.external_id).toBe(null);
  expect(recorded!.body.data.list_ids).toEqual([list.body.data.id]);
  expect(deleted!.event).toBe("subscriber.deleted");
  // The administrative path keeps the app's own key on the deletion event (D61).
  expect(deleted!.body.data.subscriber.external_id).toBe("app-2");

  f.setBounceAction("soft", { count: 9, action: "none" });
  const wiped = await f.json("/api/subscribers", "POST", {
    email: "wiped@example.com",
    name: "Wiped",
    external_id: "app-3",
    lists: [list.body.data.id],
  });
  await f.json("/webhooks/bounce", "POST", {
    email: "wiped@example.com",
    type: "soft",
    source: "api",
  });
  const response = await f.request(`/subscription/wipe/${wiped.body.data.uuid}`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(rowsOf(f)).toEqual([]);
  const after = deliveries(f).filter((d) => d.body.data.subscriber.uuid === wiped.body.data.uuid);
  expect(after.length).toBe(2);
  for (const { body } of after) {
    expect(body.data.subscriber.email).toBe("");
    expect(body.data.subscriber.external_id).toBe(null);
    expect(body.data.list_ids).toEqual([]);
  }
});

test("an action on an existing subscriber goes through the consent effects once", async () => {
  const f = await open();
  const calls: unknown[][] = [];
  const store = createSubscriberStore(f.db, f.clock, f.owners.lists, {
    ...noSubscriberEffects,
    blocklisted: (ids) => calls.push(["blocklisted", ids]),
    unsubscribed: (ids, lists) => calls.push(["unsubscribed", ids, lists]),
    changed: (change) => calls.push(["changed", change]),
  });
  cleanups.push(() => store.close());
  const list = await f.json("/api/lists", "POST", { name: "effects", type: "private" });
  const listId = BigInt(list.body.data.id);
  const id = BigInt(await f.subscriber("effects@example.com", "E", { lists: [list.body.data.id] }));
  f.db.transaction(() => store.bounceUnsubscribe(id))();
  f.db.transaction(() => store.bounceUnsubscribe(id))();
  expect(calls).toEqual([
    ["unsubscribed", [id], [listId]],
    ["changed", { id, blocklisted: false, listIds: [listId] }],
  ]);
  calls.length = 0;
  f.db.transaction(() => store.bounceBlocklist(id))();
  expect(calls).toEqual([
    ["blocklisted", [id]],
    ["changed", { id, blocklisted: true, listIds: [] }],
  ]);
});

test("the provider route takes its rate limit before reading the body", async () => {
  let used = 0;
  const f = await open({
    bounceLimit: (_context, next) => {
      if (used++) throw new HttpError(429, "Too many requests");
      return next();
    },
  });
  await f.subscriber("limit@example.com");
  expect((await f.request("/webhooks/service/ses", { method: "POST", body: "{}" })).status).toBe(
    400,
  );
  const answer = await f.request("/webhooks/service/ses", { method: "POST", body: "{}" });
  expect(answer.status).toBe(429);
  expect(rowsOf(f).length).toBe(0);
});

const sendTo = async (f: TxFixture, body: object) => {
  const sent = await f.tx({
    template_id: await f.template("<p>x</p>"),
    ...body,
  });
  expect(sent.status).toBe(200);
  const [row] = sent.body.data.sends as { id: number; status: string }[];
  expect(row!.status).toBe("sent");
  return (await f.json(`/api/sends/${row!.id}`)).body.data as {
    id: number;
    uuid: string;
  };
};
const uuidOf = async (f: TxFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
const wipe = async (f: TxFixture, uuid: string) =>
  expect((await f.request(`/subscription/wipe/${uuid}`, { method: "POST" })).status).toBe(200);

test("a bounce of a left address names no list, so a wipe has none to clear", async () => {
  const f = await open();
  await hooked(f);
  const list = (await f.json("/api/lists", "POST", { name: "l", type: "public", optin: "single" }))
    .body.data.id;
  const moved = await f.subscriber("old@example.com", "M", { lists: [list] });
  const send = await sendTo(f, { subscriber_id: moved, kind: "marketing", list_id: list });
  await f.json(`/api/subscribers/${moved}`, "PATCH", { email: "new@example.com" });
  await f.json("/webhooks/bounce", "POST", {
    send_uuid: send.uuid,
    email: "old@example.com",
    type: "hard",
    source: "api",
  });
  const [delivery] = deliveries(f).filter((d) => d.body.event === "bounce.recorded");
  expect(delivery!.body.data.send.uuid).toBe(send.uuid);
  expect(delivery!.body.data.list_ids).toEqual([]);
});

test("a row no wipe can reach keeps no free-form source", async () => {
  const f = await open();
  const primary = await f.subscriber("primary@example.com");
  const send = await sendTo(f, { subscriber_id: primary, headers: [{ Cc: "copy@example.com" }] });
  const answer = await f.json("/webhooks/bounce", "POST", {
    send_uuid: send.uuid,
    email: "copy@example.com",
    type: "soft",
    source: "customer mailbox copy@example.com",
  });
  expect(answer.status).toBe(200);
  const [row] = rowsOf(f);
  expect(row!.subscriber_id).toBeNull();
  expect(row!.send_id).toBeNull();
  expect(JSON.stringify((await f.json("/api/bounces")).body)).not.toContain("copy@example.com");
});

test("a delayed complaint for a wiped address leaves the address's new subscriber alone", async () => {
  const f = await open();
  await hooked(f);
  const first = await f.subscriber("again@example.com");
  const firstUuid = await uuidOf(f, first);
  const send = await sendTo(f, { subscriber_id: first });
  await wipe(f, firstUuid);
  const second = await f.subscriber("again@example.com");
  expect(second).not.toBe(first);
  const before = deliveries(f).length;
  expect(
    (
      await f.json("/webhooks/bounce", "POST", {
        send_uuid: send.uuid,
        email: "again@example.com",
        type: "complaint",
        source: "api",
      })
    ).status,
  ).toBe(200);
  expect(await statusOf(f, second)).toBe("enabled");
  expect(rowsOf(f)).toEqual([]);
  expect(deliveries(f).length).toBe(before);
});

test("an external send to a subscriber's address stays unlinked and acts on nobody", async () => {
  const f = await open();
  await hooked(f);
  const id = await f.subscriber("member@example.com");
  const send = await sendTo(f, {
    subscriber_mode: "external",
    subscriber_emails: ["member@example.com"],
  });
  expect(
    (
      await f.json("/webhooks/bounce", "POST", {
        send_uuid: send.uuid,
        email: "member@example.com",
        type: "complaint",
        source: "api",
      })
    ).status,
  ).toBe(200);
  expect(await statusOf(f, id)).toBe("enabled");
  expect(rowsOf(f).map((row) => [row.subscriber_id, row.send_id])).toEqual([
    [null, BigInt(send.id)],
  ]);
  const [recorded] = deliveries(f);
  expect(recorded!.body.data.subscriber).toBe(null);
  expect(recorded!.body.data.send.uuid).toBe(send.uuid);
});

test("POST /webhooks/bounce: a send_uuid is authoritative, and only then is the address bound", async () => {
  const f = await open();
  const post = (body: object) =>
    f.json("/webhooks/bounce", "POST", {
      type: "complaint",
      source: "api",
      ...body,
    });
  const linked = await f.subscriber("linked@example.com");
  const other = await f.subscriber("other@example.com");
  const send = await sendTo(f, { subscriber_id: linked });

  // An address or a UUID that contradicts the send moves nobody.
  expect((await post({ send_uuid: send.uuid, email: "other@example.com" })).status).toBe(200);
  const otherUuid = await uuidOf(f, other);
  expect((await post({ send_uuid: send.uuid, subscriber_uuid: otherUuid })).status).toBe(200);
  expect(await statusOf(f, linked)).toBe("enabled");
  expect(await statusOf(f, other)).toBe("enabled");
  expect(rowsOf(f).map((row) => [row.subscriber_id, row.send_id])).toEqual([
    [null, null],
    [null, null],
  ]);

  // An unlinked send does not fall back to the UUID or the address it was given.
  const unlinked = await sendTo(f, {
    subscriber_mode: "external",
    subscriber_emails: ["other@example.com"],
  });
  expect((await post({ send_uuid: unlinked.uuid, email: "other@example.com" })).status).toBe(200);
  expect((await post({ send_uuid: unlinked.uuid, subscriber_uuid: otherUuid })).status).toBe(200);
  expect(await statusOf(f, other)).toBe("enabled");

  // Nor does an anonymized one.
  const gone = await f.subscriber("gone-api@example.com");
  const goneSend = await sendTo(f, { subscriber_id: gone });
  await wipe(f, await uuidOf(f, gone));
  const back = await f.subscriber("gone-api@example.com");
  const stored = rowsOf(f).length;
  const backUuid = await uuidOf(f, back);
  expect((await post({ send_uuid: goneSend.uuid, email: "gone-api@example.com" })).status).toBe(
    200,
  );
  expect((await post({ send_uuid: goneSend.uuid, subscriber_uuid: backUuid })).status).toBe(200);
  expect(await statusOf(f, back)).toBe("enabled");
  expect(rowsOf(f).length).toBe(stored);

  // The send alone, or with its own address, names its subscriber.
  expect((await post({ send_uuid: send.uuid })).status).toBe(200);
  expect((await f.json(`/api/subscribers/${linked}`)).status).toBe(400);

  // Without a send, the caller's explicit claim stands, UUID over address, as upstream.
  const named = await f.subscriber("named@example.com");
  const uuid = await uuidOf(f, named);
  expect((await post({ subscriber_uuid: uuid, email: "other@example.com" })).status).toBe(200);
  expect((await f.json(`/api/subscribers/${named}`)).status).toBe(400);
  expect(await statusOf(f, other)).toBe("enabled");
});

test("a bounce unsubscribe stamps when consent changed, on the injected clock", async () => {
  const f = await open();
  f.setBounceAction("hard", { count: 1, action: "unsubscribe" });
  const list = await f.json("/api/lists", "POST", {
    name: "stamped",
    type: "private",
  });
  const id = await f.subscriber("stamped@example.com", "S", {
    lists: [list.body.data.id],
    preconfirm_subscriptions: true,
  });
  f.clock.advance(60_000);
  const at = f.clock.now().toISOString();
  await f.json("/webhooks/bounce", "POST", {
    email: "stamped@example.com",
    type: "hard",
  });
  const [membership] = (await f.json(`/api/subscribers/${id}`)).body.data.lists;
  expect(membership.subscription_status).toBe("unsubscribed");
  expect(membership.subscription_updated_at).toBe(at);
});

test("one request prunes a bounded batch of expired receipts, and a backlog still drains", async () => {
  const net = network();
  const f = await open({ snsFetch: net.fetch });
  const seed = 1000;
  const expired = new Date(f.clock.now().getTime() - 1000).toISOString();
  const insert = f.db.query("INSERT INTO bounce_receipts (key, expires_at) VALUES (?, ?)");
  f.db.transaction(() => {
    for (let i = 0; i < seed; i++) insert.run(`sns:seed-${i}`, expired);
  })();
  const expiredLeft = () =>
    Number(
      (
        f.db
          .query("SELECT count(*) AS n FROM bounce_receipts WHERE expires_at <= ?")
          .get(f.clock.now().toISOString()) as { n: bigint }
      ).n,
    );

  // A signed SNS notification to /webhooks/service/ses prunes a bounded batch
  const msg1 = envelope(f, {
    Message: bounceMessage(f, ["prune-1@example.com"], { bounceType: "Transient" }),
  });
  expect((await post(f, msg1)).status).toBe(200);
  const first = expiredLeft();
  expect(first).toBeLessThan(seed);
  expect(first).toBeGreaterThanOrEqual(seed - 200);

  // An expired key awaiting its turn does not hold a new delivery of that key back
  await f.subscriber("again-event@example.com");
  const repeat = envelope(f, {
    MessageId: `seed-${seed - 1}`,
    Message: bounceMessage(f, ["again-event@example.com"], { bounceType: "Permanent" }),
  });
  expect((await post(f, repeat)).status).toBe(200);
  expect(rowsOf(f).length).toBe(1);

  // Advance the injected clock past the receipt expiry and drain the backlog
  f.clock.advance(86_400_000 + 2000);
  for (let i = 0; i < 20 && expiredLeft(); i++) {
    const drainMsg = envelope(f, {
      Message: bounceMessage(f, [`drain-${i}@example.com`], { bounceType: "Transient" }),
    });
    expect((await post(f, drainMsg)).status).toBe(200);
  }
  expect(expiredLeft()).toBe(0);
});

test("D81: the automatic blocklist action leaves the memberships unsubscribed", async () => {
  const f = await open();
  f.setBounceAction("hard", { count: 1, action: "blocklist" });
  const list = (await f.json("/api/lists", "POST", { name: "L", type: "public" })).body.data.id;
  const id = await f.subscriber("bouncy@example.com", "B", {
    lists: [list],
    preconfirm_subscriptions: true,
  });
  expect(
    (
      await f.json("/webhooks/bounce", "POST", {
        email: "bouncy@example.com",
        type: "hard",
        source: "api",
      })
    ).status,
  ).toBe(200);
  const body = (await f.json(`/api/subscribers/${id}`)).body.data;
  expect(body.status).toBe("blocklisted");
  expect(body.lists.map((l: { subscription_status: string }) => l.subscription_status)).toEqual([
    "unsubscribed",
  ]);
});

test("D81: the automatic blocklist action queues subscriber.unsubscribed for the memberships it ends", async () => {
  const f = await open();
  await hooked(f, ["subscriber.unsubscribed", "subscriber.blocklisted"]);
  f.setBounceAction("hard", { count: 1, action: "blocklist" });
  const list = (await f.json("/api/lists", "POST", { name: "L", type: "public" })).body.data.id;
  await f.subscriber("hook@example.com", "H", {
    lists: [list],
    preconfirm_subscriptions: true,
  });
  expect(
    (
      await f.json("/webhooks/bounce", "POST", {
        email: "hook@example.com",
        type: "hard",
        source: "api",
      })
    ).status,
  ).toBe(200);
  const seen = deliveries(f).filter((d) => d.event !== "bounce.recorded");
  expect(seen.map((d) => d.event)).toEqual(["subscriber.unsubscribed", "subscriber.blocklisted"]);
  expect(seen[0]!.body.data.list_ids).toEqual([list]);
});
