// B108 (D114): a test send is never a send, but a bounce or complaint of one is named once in the
// log, and a blocklisted-only test says why it sent nothing. Through HTTP, the SMTP sink, signed SNS
// notices and the injected clock, with no sleeps for time.
import { afterEach, expect, test } from "bun:test";
import type { ErrorLogger } from "@/app";
import { createPurge } from "@/loops/purge";
import { createLogBuffer, type LogBuffer } from "@/maintenance/log-buffer";
import { bounceMessage, envelope, network, type Network } from "@/test/bounces/ses-fixture";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { schedulerFixture, type SchedulerFixture } from "@/test/scheduler/fixture";
import { wireNotices } from "@/test/messaging/notice-fixture";

const DELIVERED = "delivered@example.test";
const BLOCKED = "blocked@example.test";
const DAY = 86_400_000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** A fixture's router entry point: the request is answered as the server would answer it. */
type Requests = { request(path: string, init?: RequestInit): Promise<Response> };

async function open(net: Network = network()) {
  const f = await schedulerFixture({ snsFetch: net.fetch });
  cleanups.push(() => f.close());
  return f;
}

async function setup(f: SchedulerFixture) {
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Template subject");
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [{ wait: "P1D", kind: "transactional", template_id: template, subject: "Order update" }],
  });
  return { sequence: sequence.id as number, step: sequence.steps[0]!.id as number };
}

/** The Message-ID the sink received for the message to `to`: the one the test send used. */
function messageIdFor(messages: { to: string[]; data: string }[], to: string) {
  const message = messages.find((m) => m.to.includes(to));
  const match = /^Message-ID: (.+)$/im.exec(message?.data ?? "");
  if (!match) throw new Error(`no Message-ID for ${to}`);
  return match[1]!.trim();
}

const header = (value: string) => [{ name: "Message-ID", value }];

function complaintMessage(f: { clock: { now(): Date } }, recipient: string, headers: object[]) {
  return JSON.stringify({
    notificationType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: recipient }],
      complaintFeedbackType: "abuse",
      complaintSubType: null,
    },
    mail: {
      timestamp: f.clock.now().toISOString(),
      destination: [recipient],
      headersTruncated: false,
      headers,
    },
  });
}

/** POST one signed SNS notification body, as the provider does. */
const post = (f: Requests, body: string) =>
  f.request("/webhooks/service/ses", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-amz-sns-message-type": "Notification" },
    body,
  });

/** A new signed notification (a new SNS MessageId) carrying `message`. */
const notice = (f: Requests & { clock: { now(): Date } }, message: string) =>
  post(f, JSON.stringify(envelope(f, { Message: message })));

const rowCount = (f: { db: { query(sql: string): { get(): unknown } } }, table: string) =>
  Number((f.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint | number }).n);

const logLines = async (f: { json(path: string): Promise<{ body: any }> }, text: string) =>
  ((await f.json("/api/logs")).body.data as string[]).filter((line) => line.includes(text));

/** A step test to one address: the Message-ID it used, once the sink has it. */
async function stepTest(f: SchedulerFixture, to: string) {
  const { sequence, step } = await setup(f);
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [to],
  });
  expect(sent.status).toBe(200);
  await f.until(() => f.sink.messages.length === 1, "the test message");
  return { sequence, step, messageId: messageIdFor(f.sink.messages, to) };
}

test("a test to only blocklisted addresses answers 400 naming them, and sends nothing", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  await f.subscriber(BLOCKED, { status: "blocklisted" });
  await f.subscriber("second@example.test", { status: "blocklisted" });
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [BLOCKED, "second@example.test"],
  });
  expect(sent.status).toBe(400);
  expect(sent.body.message).toBe(`No recipients: blocklisted: ${BLOCKED}, second@example.test`);
  await Bun.sleep(20);
  expect(f.sink.messages).toHaveLength(0);
});

test("a mixed test list sends to the reachable addresses and answers true", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  await f.subscriber(BLOCKED, { status: "blocklisted" });
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [BLOCKED, DELIVERED],
  });
  expect(sent.status).toBe(200);
  expect(sent.body.data).toBe(true);
  await f.until(() => f.sink.messages.length === 1, "the test message");
  expect(f.sink.messages[0]!.to).toEqual([DELIVERED]);
});

test("a bounce of a step test is named once, in the log and on stderr, and records nothing", async () => {
  const f = await open();
  const subscriber = await f.subscriber(DELIVERED);
  const { sequence, step, messageId } = await stepTest(f, DELIVERED);
  // SNS delivers at least once: the same signed notice, posted again, is still one line.
  const body = JSON.stringify(
    envelope(f, { Message: bounceMessage(f, [DELIVERED], {}, header(messageId)) }),
  );
  expect((await post(f, body)).status).toBe(200);
  expect((await post(f, body)).status).toBe(200);

  const lines = await logLines(f, "A test send bounced");
  expect(lines).toHaveLength(1);
  const stderr = f.errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter((text) => text.includes("Test send bounced"));
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toContain(`sequence ${sequence} step ${step}`);
  expect(stderr[0]).toContain(DELIVERED);
  expect(stderr[0]).toContain("Permanent");
  expect(rowCount(f, "bounces")).toBe(0);
  const status = await f.json(`/api/subscribers/${subscriber}`);
  expect(status.body.data.status).toBe("enabled");
});

test("a complaint about a step test is named once, and the subscriber is not unsubscribed", async () => {
  const f = await open();
  const subscriber = await f.subscriber(DELIVERED);
  const { messageId } = await stepTest(f, DELIVERED);
  const complaint = complaintMessage(f, DELIVERED, header(messageId));
  expect((await notice(f, complaint)).status).toBe(200);
  expect(await logLines(f, "A test send got a complaint")).toHaveLength(1);
  expect(await logLines(f, "A test send bounced")).toHaveLength(0);
  expect(rowCount(f, "bounces")).toBe(0);
  const status = await f.json(`/api/subscribers/${subscriber}`);
  expect(status.body.data.status).toBe("enabled");
});

test("a campaign test's bounce is named once with its campaign, and records nothing", async () => {
  // The same logger the app holds: its lines are the log buffer's, and its errors are stderr's.
  const errors: unknown[] = [];
  let logs!: LogBuffer;
  const logger: ErrorLogger = {
    error(error, safe) {
      errors.push(error);
      logs.add(error, safe);
    },
  };
  const f = await campaignsFixture({
    logger: (clock) => {
      logs = createLogBuffer(clock);
      return logger;
    },
  });
  cleanups.push(() => f.close());
  const notices = wireNotices(f.router, {
    db: f.db,
    clock: f.clock,
    subscribers: f.owners.subscribers,
    sendTarget: () => null,
    roles: f.owners.roles,
    auth: f.owners.auth,
    testSends: f.testSends,
    snsFetch: network().fetch,
    logs,
    logger,
  });
  cleanups.push(() => notices.close());

  const news = await f.list("news");
  const subscriber = await f.subscriber(DELIVERED, [news]);
  const campaign = await f.campaign({ name: "Weekly", subject: "Hi", lists: [news] });
  const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: "<p>Hello</p>",
    subscribers: [DELIVERED],
  });
  expect(sent.status).toBe(200);
  await f.mail(1);
  const messageId = messageIdFor(f.sink.messages, DELIVERED);

  expect((await notice(f, bounceMessage(f, [DELIVERED], {}, header(messageId)))).status).toBe(200);
  const lines = await logLines(f, "A test send bounced");
  expect(lines).toHaveLength(1);
  expect(errors).toHaveLength(1);
  const text = (errors[0] as Error).message;
  expect(text).toContain(`campaign ${campaign.id}`);
  expect(text).toContain(DELIVERED);
  expect(rowCount(f, "bounces")).toBe(0);
  const status = await f.json(`/api/subscribers/${subscriber.id}`);
  expect(status.body.data.status).toBe("enabled");
});

test("a bounce whose Message-ID no test recorded changes nothing about the test path", async () => {
  const f = await open();
  await f.subscriber(DELIVERED);
  const notice1 = bounceMessage(f, [DELIVERED], {}, header("<unknown-1@elsewhere.test>"));
  expect((await notice(f, notice1)).status).toBe(200);
  // A real bounce is recorded as before: one row, and the hard action applies.
  expect(rowCount(f, "bounces")).toBe(1);
  expect(await logLines(f, "A test send")).toHaveLength(0);
  expect(f.errors).toHaveLength(0);
});

test("a test record lasts seven days: a bounce within the window names it, and after the retention loop removes it a bounce changes nothing", async () => {
  const f = await open();
  const { messageId } = await stepTest(f, "stranger@example.test");

  f.clock.advance(6 * DAY);
  expect(
    (await notice(f, bounceMessage(f, ["stranger@example.test"], {}, header(messageId)))).status,
  ).toBe(200);
  expect(await logLines(f, "A test send bounced")).toHaveLength(1);

  f.clock.advance(2 * DAY);
  expect(rowCount(f, "test_sends")).toBe(1);
  const purge = createPurge({
    db: f.db,
    clock: f.clock,
    logger: { error: () => {} },
    purges: [f.testSends.purge],
  });
  purge.start();
  await f.until(() => rowCount(f, "test_sends") === 0, "the retention loop removed the record");
  await purge.stop();

  expect(
    (await notice(f, bounceMessage(f, ["stranger@example.test"], {}, header(messageId)))).status,
  ).toBe(200);
  expect(await logLines(f, "A test send bounced")).toHaveLength(1);
  expect(rowCount(f, "bounces")).toBe(0);
});
