// M3.4 through HTTP, the injected clock and a local receiver. The upstream-shared corpus is in
// test/contract/bounces.ts; these cover what needs the clock or a failure inside a transaction.
import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { HttpError } from "@/server/response";
import { createSubscriberStore, noSubscriberEffects } from "@/subscribers/store";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";

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
async function hooked(f: TxFixture) {
  const r = startReceiver();
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", { url: r.url(), events });
  expect(created.status).toBe(200);
  return { receiver: r, secret: created.body.data.secret as string };
}
const seconds = (f: TxFixture) => Math.floor(f.clock.now().getTime() / 1000);
const nextToken = () => crypto.randomUUID().replaceAll("-", "");
function signed(f: TxFixture, data: unknown, timestamp = seconds(f), token = nextToken()) {
  const signature = createHmac("sha256", f.bounceSettings.mailgun.key)
    .update(`${timestamp}${token}`)
    .digest("hex");
  return {
    signature: { timestamp: String(timestamp), token, signature },
    "event-data": data,
  };
}
const mailgun = (f: TxFixture, body: unknown) =>
  f.json("/webhooks/bounce/mailgun", "POST", body, {});
const failed = (recipient: string, extra: object = {}) => ({
  id: crypto.randomUUID(),
  event: "failed",
  severity: "permanent",
  recipient,
  ...extra,
});
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

test("a signature's age is judged by the injected clock, and receipts then expire", async () => {
  const f = await open();
  await f.subscriber("old@example.com");
  const signedAt = seconds(f);
  const atEdge = signed(f, failed("old@example.com"), signedAt);
  const late = signed(f, failed("old@example.com"), signedAt);
  f.clock.advance(15 * 60_000);
  expect((await mailgun(f, atEdge)).status).toBe(200);
  f.clock.advance(1000);
  expect((await mailgun(f, late)).status).toBe(406);
  expect(rowsOf(f).length).toBe(1);
  // Past its window a token cannot pass the age check, so its receipt can go.
  f.clock.advance(86_400_000);
  await mailgun(f, signed(f, { event: "delivered" }));
  const left = f.db.query("SELECT key FROM bounce_receipts").all() as { key: string }[];
  expect(left.length).toBe(1);
});

test("the row, the action and the deliveries commit together, and a failure frees the token", async () => {
  const f = await open();
  await hooked(f);
  const id = await f.subscriber("atomic@example.com");
  f.db.run(`CREATE TRIGGER fail_blocklist BEFORE INSERT ON webhook_deliveries
    WHEN NEW.event = 'subscriber.blocklisted' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  const body = signed(f, failed("atomic@example.com"));
  expect((await mailgun(f, body)).status).toBe(500);
  expect(f.errors.length).toBe(1);
  expect(rowsOf(f)).toEqual([]);
  expect(await statusOf(f, id)).toBe("enabled");
  expect(deliveries(f)).toEqual([]);
  expect(f.db.query("SELECT 1 FROM bounce_receipts").all()).toEqual([]);
  // Mailgun's retry of the same signed delivery then succeeds, and only once.
  f.db.run("DROP TRIGGER fail_blocklist");
  expect((await mailgun(f, body)).status).toBe(200);
  expect(rowsOf(f).length).toBe(1);
  expect(await statusOf(f, id)).toBe("blocklisted");
  expect(deliveries(f).map((d) => d.event)).toEqual(["bounce.recorded", "subscriber.blocklisted"]);
  expect((await mailgun(f, body)).status).toBe(406);
  expect(rowsOf(f).length).toBe(1);
});

test("a repeated event under a new signature does not count again", async () => {
  const f = await open();
  f.bounceSettings.actions.soft = { count: 2, action: "blocklist" };
  const id = await f.subscriber("twice@example.com");
  const event = failed("twice@example.com", { severity: "temporary" });
  expect((await mailgun(f, signed(f, event))).status).toBe(200);
  expect((await mailgun(f, signed(f, event))).status).toBe(200);
  expect(rowsOf(f).length).toBe(1);
  expect(await statusOf(f, id)).toBe("enabled");
  const another = failed("twice@example.com", { severity: "temporary" });
  expect((await mailgun(f, signed(f, another))).status).toBe(200);
  expect(await statusOf(f, id)).toBe("blocklisted");
});

test("stored meta keeps the reason and drops the message and addresses", async () => {
  const f = await open();
  await f.subscriber("private@example.com");
  await mailgun(
    f,
    signed(
      f,
      failed("private@example.com", {
        reason: "bounce",
        "delivery-status": {
          code: 550,
          message: `5.1.1 <private@example.com> ${"long ".repeat(400)}`,
          description: "Mailbox of other.person@example.org is full",
        },
        message: {
          headers: {
            subject: "Your private order",
            from: "shop@example.com",
            to: "private@example.com",
            "message-id": "unrelated@example.test",
          },
        },
        envelope: { sender: "shop@example.com", "sending-ip": "192.0.2.1" },
        "user-variables": { order: "A-1" },
        geolocation: { city: "Warsaw" },
      }),
    ),
  );
  const [row] = rowsOf(f);
  const meta = JSON.parse(row!.meta);
  expect(Object.keys(meta).sort()).toEqual([
    "code",
    "description",
    "event",
    "event_id",
    "message",
    "reason",
    "severity",
  ]);
  expect(meta.message.startsWith("5.1.1 <[address]> long")).toBe(true);
  expect(meta.message.length).toBeLessThanOrEqual(1000);
  expect(meta.description).toBe("Mailbox of [address] is full");
  expect(row!.meta).not.toContain("private@example.com");
});

test("native meta spellings are stored as objects", async () => {
  const f = await open();
  await f.subscriber("meta@example.com");
  f.bounceSettings.actions.soft = { count: 9, action: "none" };
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
  await mailgun(f, signed(f, failed("hooked@example.com")));
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
    bounce: { id: expect.any(Number), type: "hard", source: "mailgun" },
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
  await mailgun(f, signed(f, { ...failed("gone@example.com"), event: "complained" }));
  const [recorded, deleted] = deliveries(f);
  expect(recorded!.event).toBe("bounce.recorded");
  expect(recorded!.body.data.subscriber.email).toBe("");
  expect(recorded!.body.data.subscriber.external_id).toBe(null);
  expect(recorded!.body.data.list_ids).toEqual([list.body.data.id]);
  expect(deleted!.event).toBe("subscriber.deleted");
  // The administrative path keeps the app's own key on the deletion event (D61).
  expect(deleted!.body.data.subscriber.external_id).toBe("app-2");

  f.bounceSettings.actions.soft = { count: 9, action: "none" };
  const wiped = await f.json("/api/subscribers", "POST", {
    email: "wiped@example.com",
    name: "Wiped",
    external_id: "app-3",
    lists: [list.body.data.id],
  });
  await mailgun(f, signed(f, failed("wiped@example.com", { severity: "temporary" })));
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
  expect((await mailgun(f, signed(f, failed("limit@example.com")))).status).toBe(200);
  const answer = await mailgun(f, signed(f, failed("limit@example.com")));
  expect(answer.status).toBe(429);
  expect(rowsOf(f).length).toBe(1);
});
test("a missing key refuses everything, whatever the request claims", async () => {
  const f = await open();
  await f.subscriber("off@example.com");
  const body = signed(f, failed("off@example.com"));
  f.bounceSettings.mailgun = { enabled: true, key: "" };
  expect((await mailgun(f, body)).status).toBe(400);
  f.bounceSettings.mailgun = { enabled: false, key: "fixture-mailgun-key" };
  expect((await mailgun(f, body)).status).toBe(400);
  f.bounceSettings.mailgun = { enabled: true, key: "fixture-mailgun-key" };
  f.bounceSettings.enabled = false;
  expect((await mailgun(f, body)).status).toBe(503);
  f.bounceSettings.enabled = true;
  f.bounceSettings.webhooksEnabled = false;
  const hidden = await f.request("/webhooks/bounce/mailgun", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(hidden.status).toBe(404);
  expect(rowsOf(f)).toEqual([]);
});
