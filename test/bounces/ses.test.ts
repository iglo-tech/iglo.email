// B9: Amazon SES bounces through SNS. Messages are signed by a certificate issued by a test CA
// and served by an injected fetch, so no test calls AWS. The refusals that need no certificate
// also run against pinned upstream, and the signed cases against compiled production, in
// test/contract/bounces.ts (through a loopback certificate tunnel, test/bounces/sns-tunnel.ts).
import { afterEach, expect, test } from "bun:test";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import { startReceiver } from "@/test/webhooks/receiver";
import {
  CERT,
  OTHER_CERT,
  bounceMessage,
  envelope,
  good,
  issue,
  network,
  post,
  type Network,
} from "@/test/bounces/ses-fixture";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function open(net: Network = network()) {
  const f = await txFixture({ webhooks: {}, snsFetch: net.fetch });
  cleanups.push(() => f.close());
  return f;
}
const rows = (f: TxFixture) =>
  f.db.query("SELECT subscriber_id, type, source, meta FROM bounces ORDER BY id").all() as {
    subscriber_id: bigint | null;
    type: string;
    source: string;
    meta: string;
  }[];
const status = async (f: TxFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data?.status as string | undefined;

test("a signed permanent bounce is recorded and the hard action applies", async () => {
  const net = network();
  const f = await open(net);
  const id = await f.subscriber("gone@example.com");
  const response = await post(f, envelope(f, { Message: bounceMessage(f, ["Gone@Example.com"]) }));
  expect(response.status).toBe(200);
  expect(response.body.data).toBe(true);
  expect(rows(f).map((r) => [r.type, r.source])).toEqual([["hard", "ses"]]);
  expect(await status(f, id)).toBe("blocklisted");
  const meta = JSON.parse(rows(f)[0]!.meta);
  expect(meta.bounce_type).toBe("Permanent");
  expect(JSON.stringify(meta)).not.toContain("gone@example.com");
  expect(net.requests).toEqual([CERT]);
});

test("signature version 2 verifies, and the certificate is fetched once", async () => {
  const net = network();
  const f = await open(net);
  await f.subscriber("v2@example.com");
  for (let i = 0; i < 2; i++)
    expect(
      (
        await post(
          f,
          envelope(f, { Message: bounceMessage(f, ["v2@example.com"]) }, { version: "2" }),
        )
      ).status,
    ).toBe(200);
  expect(net.requests.length).toBe(1);
});

test("transient is soft, an invalid domain is hard, and a complaint deletes under the delete action", async () => {
  const f = await open();
  const soft = await f.subscriber("soft@example.com");
  const domain = await f.subscriber("domain@example.com");
  const angry = await f.subscriber("angry@example.com");
  await post(
    f,
    envelope(f, { Message: bounceMessage(f, ["soft@example.com"], { bounceType: "Transient" }) }),
  );
  const invalid = JSON.parse(bounceMessage(f, ["domain@example.com"], { bounceType: "Transient" }));
  invalid.bounce.bouncedRecipients[0].status = "5.4.4";
  await post(f, envelope(f, { Message: JSON.stringify(invalid) }));
  const complaint = {
    notificationType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: "angry@example.com" }],
      complaintFeedbackType: "abuse",
    },
    mail: { timestamp: f.clock.now().toISOString(), destination: ["angry@example.com"] },
  };
  await post(f, envelope(f, { Message: JSON.stringify(complaint) }));
  expect(
    rows(f)
      .map((r) => r.type)
      .sort(),
  ).toEqual(["hard", "soft"]);
  expect(await status(f, soft)).toBe("enabled");
  expect(await status(f, domain)).toBe("blocklisted");
  // The complaint action is delete.
  expect((await f.json(`/api/subscribers/${angry}`)).status).toBe(400);
});

test("event-publishing messages and several recipients are accepted", async () => {
  const f = await open();
  const a = await f.subscriber("a@example.com");
  const b = await f.subscriber("b@example.com");
  const published = JSON.parse(bounceMessage(f, ["a@example.com", "b@example.com"]));
  delete published.notificationType;
  published.eventType = "Bounce";
  expect((await post(f, envelope(f, { Message: JSON.stringify(published) }))).status).toBe(200);
  expect(rows(f).length).toBe(2);
  expect(await status(f, a)).toBe("blocklisted");
  expect(await status(f, b)).toBe("blocklisted");
  // Event publishing reports a complaint under its own event type.
  const c = await f.subscriber("c@example.com");
  const complaint = {
    eventType: "Complaint",
    complaint: { complainedRecipients: [{ emailAddress: "c@example.com" }] },
    mail: { timestamp: f.clock.now().toISOString(), destination: ["c@example.com"] },
  };
  expect((await post(f, envelope(f, { Message: JSON.stringify(complaint) }))).status).toBe(200);
  expect((await f.json(`/api/subscribers/${c}`)).status).toBe(400);
  // Another event type is not a bounce.
  const delivery = { eventType: "Delivery", mail: { destination: ["x@example.com"] } };
  expect((await post(f, envelope(f, { Message: JSON.stringify(delivery) }))).status).toBe(400);
});

test("the campaign delivery in the headers selects the subscriber", async () => {
  const f = await open();
  const id = await f.subscriber("named@example.com");
  const uuid = (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const headers = [{ name: "x-listmonk-subscriber", value: uuid }];
  await post(f, envelope(f, { Message: bounceMessage(f, ["named@example.com"], {}, headers) }));
  expect(rows(f)[0]!.subscriber_id).toBe(BigInt(id));
  // A copy: the subscriber is named but the address is another's, so nobody is acted on.
  const other = await f.subscriber("other@example.com");
  await post(
    f,
    envelope(f, {
      Message: bounceMessage(f, ["stranger@example.com"], {}, [
        {
          name: "X-Listmonk-Subscriber",
          value: (await f.json(`/api/subscribers/${other}`)).body.data.uuid,
        },
      ]),
    }),
  );
  expect(await status(f, other)).toBe("enabled");
});

test("a replayed MessageId is recorded once, and a restart-proof receipt is kept", async () => {
  const f = await open();
  const id = await f.subscriber("replay@example.com");
  await f.json(`/api/subscribers/${id}`, "PUT", {
    email: "replay@example.com",
    name: "r",
    status: "enabled",
    lists: [],
  });
  const message = envelope(f, {
    Message: bounceMessage(f, ["replay@example.com"], { bounceType: "Transient" }),
  });
  expect((await post(f, message)).status).toBe(200);
  expect((await post(f, message)).status).toBe(200);
  expect(rows(f).length).toBe(1);
  // Past a day the signature is stale and refused.
  f.clock.advance(86_400_000 + 1000);
  expect((await post(f, message)).status).toBe(400);
  expect(rows(f).length).toBe(1);
});

test("refused messages change nothing", async () => {
  const net = network({ [CERT]: good.pem, [OTHER_CERT]: issue().pem });
  const f = await open(net);
  const id = await f.subscriber("victim@example.com");
  const message = bounceMessage(f, ["victim@example.com"]);
  const attacker = issue();
  const refused = [
    // Signed by a key that is not the certificate's.
    envelope(f, { Message: message }, { key: attacker.key }),
    // A certificate from a host outside the pattern.
    envelope(
      f,
      { Message: message },
      {
        cert: "https://sns.eu-west-1.amazonaws.com.evil.test/SimpleNotificationService-abc123.pem",
      },
    ),
    envelope(
      f,
      { Message: message },
      { cert: "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem" },
    ),
    envelope(
      f,
      { Message: message },
      { cert: "https://evil.test/SimpleNotificationService-abc123.pem" },
    ),
    envelope(
      f,
      { Message: message },
      { cert: "https://sns.eu-west-1.amazonaws.com:8443/SimpleNotificationService-abc123.pem" },
    ),
    // The S3 bucket named `sns` matches upstream's pattern but is not an SNS endpoint.
    envelope(
      f,
      { Message: message },
      { cert: "https://sns.s3.amazonaws.com/SimpleNotificationService-abc123.pem" },
    ),
    envelope(
      f,
      { Message: message },
      { cert: "https://sns.s3-website.amazonaws.com/SimpleNotificationService-abc123.pem" },
    ),
    // A valid certificate that is not the one that signed.
    envelope(f, { Message: message }, { cert: OTHER_CERT }),
    // An unknown signature version, a message altered after signing, a stale one.
    envelope(f, { Message: message }, { version: "3" }),
    { ...envelope(f, { Message: message }), Message: bounceMessage(f, ["someone@example.com"]) },
    envelope(f, {
      Message: message,
      Timestamp: new Date(f.clock.now().getTime() - 2 * 86_400_000).toISOString(),
    }),
  ];
  for (const body of refused) expect((await post(f, body)).status).toBe(400);
  // The header is not signed, so it must agree with the signed type; unknown types are refused.
  expect(
    (await post(f, envelope(f, { Message: message }), "SubscriptionConfirmation")).status,
  ).toBe(400);
  expect((await post(f, envelope(f, { Message: message }), "Other")).status).toBe(400);
  expect((await post(f, null, "Notification", "{")).status).toBe(400);
  expect(rows(f).length).toBe(0);
  expect(await status(f, id)).toBe("enabled");
  expect(net.requests.every((url) => url.startsWith("https://sns.eu-west-1.amazonaws.com/"))).toBe(
    true,
  );
});

test("an expired certificate is refused", async () => {
  const short = issue("20260102000000Z");
  const f = await open(network({ [CERT]: short.pem }));
  await f.subscriber("late@example.com");
  const body = envelope(f, { Message: bounceMessage(f, ["late@example.com"]) }, { key: short.key });
  expect((await post(f, body)).status).toBe(400);
  expect(rows(f).length).toBe(0);
});

test("an oversized body is refused", async () => {
  const f = await open();
  const response = await post(f, null, "Notification", "x".repeat(300_000));
  expect(response.status).toBe(413);
});

test("a verified subscription confirmation fetches only its own SNS URL", async () => {
  const net = network();
  const f = await open(net);
  const url =
    "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn&Token=t";
  const confirm = (subscribeUrl: string, options = {}) =>
    envelope(
      f,
      {
        Type: "SubscriptionConfirmation",
        Message: "confirm",
        SubscribeURL: subscribeUrl,
        Token: "t",
      },
      options,
    );
  expect((await post(f, confirm(url), "SubscriptionConfirmation")).status).toBe(200);
  expect(net.requests).toEqual([CERT, url]);
  const before = net.requests.length;
  const off = [
    "https://evil.test/?Action=ConfirmSubscription",
    "http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription",
    "https://sns.eu-west-1.amazonaws.com.evil.test/?x=1",
    "https://user@sns.eu-west-1.amazonaws.com/?x=1",
    "https://sns.eu-west-1.amazonaws.com@evil.test/?x=1",
    "https://sns.s3.amazonaws.com/?x=1",
  ];
  for (const bad of off)
    expect((await post(f, confirm(bad), "SubscriptionConfirmation")).status).toBe(400);
  // An unverified confirmation fetches nothing, not even its certificate again.
  expect(
    (await post(f, confirm(url, { key: issue().key }), "SubscriptionConfirmation")).status,
  ).toBe(400);
  expect(net.requests.length).toBe(before);
});

test("the route answers as a disabled provider does until SES is enabled", async () => {
  const f = await open();
  f.setBounce({ "bounce.ses_enabled": false });
  const r = await post(f, envelope(f, { Message: "{}" }));
  expect(r.status).toBe(400);
  expect(r.body.message).toBe("Unknown service.");
});

const foreign = "arn:aws:sns:us-east-1:999999999999:attacker-topic";

test("a topic that is not on the list is refused, and a foreign confirmation is never fetched", async () => {
  const net = network();
  const f = await open(net);
  const id = await f.subscriber("topic@example.com");
  const url = "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";
  const message = bounceMessage(f, ["topic@example.com"]);
  const attempts = (topics: string[]) => {
    f.setBounce({ "bounce.ses_topic_arns": topics });
    return [
      () => post(f, envelope(f, { Message: message, TopicArn: foreign })),
      () =>
        post(
          f,
          envelope(f, {
            Type: "SubscriptionConfirmation",
            Message: "confirm",
            SubscribeURL: url,
            Token: "t",
            TopicArn: foreign,
          }),
          "SubscriptionConfirmation",
        ),
    ];
  };
  // Another account's topic, with the operator's account allowed.
  for (const run of attempts(["arn:aws:sns:*:123456789012:*"]))
    expect((await run()).status).toBe(400);
  // An exact ARN does not match its neighbour; an empty list accepts nothing, even the right topic.
  const own = "arn:aws:sns:eu-west-1:123456789012:bounces";
  f.setBounce({ "bounce.ses_topic_arns": [`${own}-other`] });
  expect((await post(f, envelope(f, { Message: message }))).status).toBe(400);
  f.setBounce({ "bounce.ses_topic_arns": [] });
  expect((await post(f, envelope(f, { Message: message }))).status).toBe(400);
  expect(
    (
      await post(
        f,
        envelope(f, {
          Type: "SubscriptionConfirmation",
          Message: "c",
          SubscribeURL: url,
          Token: "t",
        }),
        "SubscriptionConfirmation",
      )
    ).status,
  ).toBe(400);
  expect(rows(f).length).toBe(0);
  expect(await status(f, id)).toBe("enabled");
  expect(net.requests.includes(url)).toBe(false);
  // The exact ARN and the account pattern both accept.
  f.setBounce({ "bounce.ses_topic_arns": [own] });
  expect((await post(f, envelope(f, { Message: message }))).status).toBe(200);
  expect(rows(f).length).toBe(1);
});

test("a message naming thousands of recipients records at most 50", async () => {
  const f = await open();
  const real: string[] = [];
  for (let i = 0; i < 52; i++) {
    const email = `real${i}@example.com`;
    await f.subscriber(email);
    real.push(email);
  }
  const fake = Array.from({ length: 3948 }, (_, i) => `fake${i}@example.net`);
  const message = JSON.stringify({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Transient",
      bouncedRecipients: [...real, ...fake].map((emailAddress) => ({ emailAddress })),
    },
    mail: { timestamp: f.clock.now().toISOString(), destination: real.slice(0, 1) },
  });
  const body = envelope(f, { Message: message });
  expect(JSON.stringify(body).length).toBeLessThan(256 * 1024);
  expect((await post(f, body)).status).toBe(200);
  // Only the first 50 are acted on; the rest of the list is ignored.
  expect(rows(f).length).toBe(50);
});

test("a message dated ahead is still recorded once when replayed at the end of its window", async () => {
  const f = await open();
  await f.subscriber("ahead@example.com");
  const ahead = envelope(f, {
    Message: bounceMessage(f, ["ahead@example.com"], { bounceType: "Transient" }),
    Timestamp: new Date(f.clock.now().getTime() + 14 * 60_000).toISOString(),
  });
  expect((await post(f, ahead)).status).toBe(200);
  // 24 h after its Timestamp it still verifies; its receipt must too.
  f.clock.advance(14 * 60_000 + 86_400_000 - 60_000);
  expect((await post(f, ahead)).status).toBe(200);
  expect(rows(f).length).toBe(1);
  f.clock.advance(120_000);
  expect((await post(f, ahead)).status).toBe(400);
  expect(rows(f).length).toBe(1);
});

test("the row, the action and the deliveries commit together, and a failure leaves no receipt", async () => {
  const f = await open();
  const r = startReceiver();
  cleanups.push(() => r.close());
  const hookRes = await f.json("/api/webhooks", "POST", {
    url: r.url(),
    events: ["bounce.recorded", "subscriber.blocklisted", "subscriber.deleted"],
  });
  expect(hookRes.status).toBe(200);

  const id = await f.subscriber("atomic@example.com");
  f.db.run(`CREATE TRIGGER fail_blocklist BEFORE INSERT ON webhook_deliveries
    WHEN NEW.event = 'subscriber.blocklisted' BEGIN SELECT RAISE(ABORT, 'refused'); END`);

  const message = envelope(f, {
    Message: bounceMessage(f, ["atomic@example.com"], { bounceType: "Permanent" }),
  });

  expect((await post(f, message)).status).toBe(500);
  expect(f.errors.length).toBe(1);
  expect(rows(f)).toEqual([]);
  expect(await status(f, id)).toBe("enabled");
  expect(
    f.db.query("SELECT key FROM bounce_receipts WHERE key = ?").all(`sns:${message.MessageId}`),
  ).toEqual([]);
  // The failed request committed no delivery, so the receiver hears nothing, even as time passes.
  f.advanceWebhooks(60_000);
  await Bun.sleep(20);
  expect(r.received.length).toBe(0);

  f.db.run("DROP TRIGGER fail_blocklist");
  expect((await post(f, message)).status).toBe(200);
  expect(rows(f).length).toBe(1);
  expect(await status(f, id)).toBe("blocklisted");
  const receipts = f.db
    .query("SELECT key FROM bounce_receipts WHERE key = ?")
    .all(`sns:${message.MessageId}`);
  expect(receipts.length).toBe(1);
  // The retry's row and action each reach the receiver once. The clock is not moved while the
  // first attempt is in flight: a jump past its lease would count that attempt as abandoned.
  await r.waitFor(2);
  await Bun.sleep(20);
  expect(r.received.map((delivery) => delivery.body.event).sort()).toEqual([
    "bounce.recorded",
    "subscriber.blocklisted",
  ]);

  // A provider's repeat of the same message adds no row and no delivery.
  expect((await post(f, message)).status).toBe(200);
  expect(rows(f).length).toBe(1);
  expect(await status(f, id)).toBe("blocklisted");
  expect(f.db.query("SELECT count(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 2n });
  expect(r.received.length).toBe(2);
});
