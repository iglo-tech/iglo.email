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

/** A Message-ID as the mailer sets it, in the event Mailgun reports. */
const carrying = (id: string) => ({
  message: { headers: { "message-id": `<${id}@fixture.test>` } },
});
const complaint = (recipient: string, id: string) =>
  failed(recipient, {
    event: "complained",
    severity: undefined,
    ...carrying(id),
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

test("a signed event for a Cc recipient acts on nobody and does not read as the send's bounce", async () => {
  const f = await open();
  await hooked(f);
  const primary = await f.subscriber("primary@example.com");
  const copy = await f.subscriber("copy@example.com");
  const send = await sendTo(f, {
    subscriber_id: primary,
    headers: [{ Cc: "copy@example.com" }],
  });
  expect(f.sink.messages[0]!.to).toEqual(["primary@example.com", "copy@example.com"]);
  const answer = await mailgun(f, signed(f, complaint("copy@example.com", send.uuid)));
  expect(answer.status).toBe(200);
  const hard = failed("copy@example.com", {
    "delivery-status": { code: 550, message: "No such person: Ann Copy" },
    ...carrying(send.uuid),
  });
  expect((await mailgun(f, signed(f, hard))).status).toBe(200);
  // The delivery to the primary address worked, and the copy's owner was not the addressee.
  expect(await statusOf(f, primary)).toBe("enabled");
  expect(await statusOf(f, copy)).toBe("enabled");
  // Recorded, tied to the message by UUID only, without provider text no wipe could reach.
  const rows = rowsOf(f);
  expect(rows.map((row) => [row.subscriber_id, row.send_id, row.type])).toEqual([
    [null, null, "complaint"],
    [null, null, "hard"],
  ]);
  const meta = JSON.parse(rows[1]!.meta);
  expect(meta).toMatchObject({
    event: "failed",
    code: 550,
    send_uuid: send.uuid,
  });
  expect(meta.message).toBeUndefined();
  expect(meta.description).toBeUndefined();
  // Nothing tells an app or an operator that the send itself bounced.
  expect(deliveries(f)).toEqual([]);
  const listed = (await f.json("/api/bounces")).body.data.results;
  for (const row of listed) expect(row.email).toBeUndefined();
});

test("the addressed recipient still acts on a send, however the provider spells the address", async () => {
  const f = await open();
  const id = await f.subscriber("cased@example.com");
  const send = await sendTo(f, { subscriber_id: id });
  expect((await mailgun(f, signed(f, complaint(" Cased@Example.COM ", send.uuid)))).status).toBe(
    200,
  );
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
});

test("a campaign Message-ID binds its subscriber token to the provider's recipient", async () => {
  const f = await open();
  const id = await f.subscriber("reader@example.com");
  const uuid = await uuidOf(f, id);
  const campaign = crypto.randomUUID();
  const body = complaint("copy@example.com", `${campaign}.${uuid}`);
  expect((await mailgun(f, signed(f, body))).status).toBe(200);
  expect(await statusOf(f, id)).toBe("enabled");
  expect(rowsOf(f).map((row) => row.subscriber_id)).toEqual([null]);
  const own = complaint("reader@example.com", `${campaign}.${uuid}`);
  expect((await mailgun(f, signed(f, own))).status).toBe(200);
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
});

test("an event with a Message-ID but no recipient it can bind acts on nobody", async () => {
  const f = await open();
  const id = await f.subscriber("unnamed@example.com");
  const send = await sendTo(f, { subscriber_id: id });
  for (const recipient of [undefined, "not an address"]) {
    const body = { ...complaint("x@example.com", send.uuid), recipient };
    expect((await mailgun(f, signed(f, body))).status).toBe(200);
  }
  expect(await statusOf(f, id)).toBe("enabled");
  expect(rowsOf(f)).toEqual([]);
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
  expect((await mailgun(f, signed(f, complaint("again@example.com", send.uuid)))).status).toBe(200);
  const stale = complaint("again@example.com", `${crypto.randomUUID()}.${firstUuid}`);
  expect((await mailgun(f, signed(f, stale))).status).toBe(200);
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
  expect((await mailgun(f, signed(f, complaint("member@example.com", send.uuid)))).status).toBe(
    200,
  );
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
