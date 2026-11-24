// B108 (D114): a test send is never a send, but a bounce or complaint of one is named once in the
// log, and a blocklisted-only test says why it sent nothing. Through HTTP, the SMTP sink, signed SNS
// notices and the injected clock, with no sleeps for time. Counts of bounces are read through the
// API; the one table read is the privacy check, since no route lists `test_sends`.
import { afterEach, expect, test } from "bun:test";
import type { ErrorLogger } from "@/app";
import { createPurge } from "@/loops/purge";
import { createLogBuffer } from "@/maintenance/log-buffer";
import type { LogBuffer } from "@/maintenance/log-buffer";
import { bounceMessage, envelope, network } from "@/test/bounces/ses-fixture";
import type { Network } from "@/test/bounces/ses-fixture";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { wireNotices } from "@/test/messaging/notice-fixture";
import { asBody } from "@/test/read-body";

const DELIVERED = "delivered@example.test";
const BLOCKED = "blocked@example.test";
const DAY = 86_400_000;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});

/** A fixture's router entry point: the request is answered as the server would answer it. */
type Requests = { request(path: string, init?: RequestInit): Promise<Response> };
type Api = { json(path: string): Promise<{ status: number; body: any }> };

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
  return { sequence: sequence.id, step: sequence.steps[0]!.id };
}

/** The Message-ID the sink received for the message to `to`: the one the test send used. */
function messageIdFor(messages: Array<{ to: Array<string>; data: string }>, to: string) {
  const message = messages.find((m) => m.to.includes(to));
  const match = /^Message-ID: (.+)$/im.exec(message?.data ?? "");
  if (!match) {
    throw new Error(`no Message-ID for ${to}`);
  }
  return match[1]!.trim();
}

const header = (value: string) => [{ name: "Message-ID", value }];

function complaintMessage(
  f: { clock: { now(): Date } },
  recipient: string,
  headers: Array<object>,
) {
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

/** Bounces the API lists: the rows the bounce path recorded. */
const bounceTotal = async (f: Api) =>
  asBody<number>((await f.json("/api/bounces")).body.data.total);

const logLines = async (f: Api, text: string) =>
  asBody<Array<string>>((await f.json("/api/logs")).body.data).filter((line) =>
    line.includes(text),
  );

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
  expect(await bounceTotal(f)).toBe(0);
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
  expect(await bounceTotal(f)).toBe(0);
  const status = await f.json(`/api/subscribers/${subscriber}`);
  expect(status.body.data.status).toBe("enabled");
});

test("a campaign test's bounce is named once with its campaign, and records nothing", async () => {
  // The same logger the app holds: its lines are the log buffer's, and its errors are stderr's.
  const errors: Array<unknown> = [];
  let logs!: LogBuffer;
  const logger: ErrorLogger = {
    error(error) {
      errors.push(error);
      logs.add(error);
    },
    attention(message, safe) {
      errors.push(new Error(message));
      logs.attention(safe);
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
  const text = asBody<Error>(errors[0]).message;
  expect(text).toContain(`campaign ${campaign.id}`);
  expect(text).toContain(DELIVERED);
  expect(await bounceTotal(f)).toBe(0);
  const status = await f.json(`/api/subscribers/${subscriber.id}`);
  expect(status.body.data.status).toBe("enabled");
});

test("a bounce whose Message-ID no test recorded is recorded as before", async () => {
  const f = await open();
  await f.subscriber(DELIVERED);
  const notice1 = bounceMessage(f, [DELIVERED], {}, header("<unknown-1@elsewhere.test>"));
  expect((await notice(f, notice1)).status).toBe(200);
  // A real bounce is recorded as before: one row, and the hard action applies.
  expect(await bounceTotal(f)).toBe(1);
  expect(await logLines(f, "A test send")).toHaveLength(0);
  expect(f.errors).toHaveLength(0);
});

test("a deleted subscriber's address stays in no record B108 keeps", async () => {
  const f = await open();
  const id = await f.subscriber("wipe-me@example.test");
  const { messageId } = await stepTest(f, "wipe-me@example.test");
  expect((await f.json(`/api/subscribers/${id}`, "DELETE")).status).toBe(200);

  expect(
    (await notice(f, bounceMessage(f, ["wipe-me@example.test"], {}, header(messageId)))).status,
  ).toBe(200);
  expect(await logLines(f, "A test send bounced")).toHaveLength(1);
  expect(await bounceTotal(f)).toBe(0);
  // The log buffer holds fixed text only, so no line it returns carries the address.
  for (const line of await logLines(f, "")) {
    expect(line).not.toContain("wipe-me@example.test");
  }
  // The one table read: no route lists `test_sends`, so its stored values are read directly.
  const rows = asBody<Array<Record<string, unknown>>>(f.db.query("SELECT * FROM test_sends").all());
  expect(rows).toHaveLength(1);
  const values = rows.flatMap((row) => Object.values(row).map(String)).join("\n");
  expect(values).not.toContain("wipe-me@example.test");
});

test("a test record lasts seven days: a bounce within the window names it, and after the retention loop removes it, a bounce of the subscriber is recorded as before", async () => {
  const f = await open();
  const subscriber = await f.subscriber("expiring@example.test");
  const { messageId } = await stepTest(f, "expiring@example.test");

  f.clock.advance(6 * DAY);
  expect(
    (await notice(f, bounceMessage(f, ["expiring@example.test"], {}, header(messageId)))).status,
  ).toBe(200);
  expect(await logLines(f, "A test send bounced")).toHaveLength(1);
  // Within the window the notice is the test's: nothing is recorded, and the subscriber is kept.
  expect(await bounceTotal(f)).toBe(0);
  expect((await f.json(`/api/subscribers/${subscriber}`)).body.data.status).toBe("enabled");

  f.clock.advance(2 * DAY);
  // The retention loop runs the record's purge; the returned IDs show when it has removed it.
  const removed: Array<unknown> = [];
  const purge = createPurge({
    db: f.db,
    clock: f.clock,
    logger: { error: () => {}, attention: () => {} },
    purges: [
      (now, limit) => {
        const taken = f.testSends.purge(now, limit);
        removed.push(...taken);
        return taken;
      },
    ],
  });
  purge.start();
  await f.until(() => removed.length > 0, "the retention loop removed the record");
  await purge.stop();

  // Past the window the same Message-ID is no test's: the bounce is recorded as any other.
  expect(
    (await notice(f, bounceMessage(f, ["expiring@example.test"], {}, header(messageId)))).status,
  ).toBe(200);
  expect(await logLines(f, "A test send bounced")).toHaveLength(1);
  expect(await bounceTotal(f)).toBe(1);
  expect((await f.json(`/api/subscribers/${subscriber}/bounces`)).body.data).toHaveLength(1);
  expect((await f.json(`/api/subscribers/${subscriber}`)).body.data.status).toBe("blocklisted");
});

test("a step test whose Message-ID cannot be recorded answers 500 and sends nothing", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  f.db.run(
    "CREATE TRIGGER refuse_test_sends BEFORE INSERT ON test_sends BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  const failed = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [DELIVERED],
  });
  expect(failed.status).toBe(500);

  // Once the write can succeed, the same request is sent, so no in-flight slot was left behind.
  f.db.run("DROP TRIGGER refuse_test_sends");
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [DELIVERED],
  });
  expect(sent.status).toBe(200);
  await f.until(() => f.sink.messages.length >= 1, "the retried test message");
  // Settled: close() waits for every message the emailer started and starts none after, so a message
  // the refused request had pushed is in the sink by now. Only the retried one may be there.
  await f.emailer.close();
  expect(f.sink.messages).toHaveLength(1);
  expect(f.sink.messages[0]!.to).toEqual([DELIVERED]);
});

test("a campaign test whose Message-ID cannot be recorded answers 500 and sends nothing", async () => {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  const news = await f.list("news");
  await f.subscriber(DELIVERED, [news]);
  const campaign = await f.campaign({ name: "Weekly", subject: "Hi", lists: [news] });
  const body = {
    name: "Weekly",
    subject: "Hi",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: "<p>Hello</p>",
    subscribers: [DELIVERED],
  };
  f.db.run(
    "CREATE TRIGGER refuse_test_sends BEFORE INSERT ON test_sends BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  const failed = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", body);
  expect(failed.status).toBe(500);

  f.db.run("DROP TRIGGER refuse_test_sends");
  const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", body);
  expect(sent.status).toBe(200);
  await f.mail(1);
  // Settled, as in the step test above: close() drains what the emailer started, so only the
  // retried message can be in the sink.
  await f.owners.emailer.close();
  expect(f.sink.messages).toHaveLength(1);
  expect(f.sink.messages[0]!.to).toEqual([DELIVERED]);
});
