// Campaign runner behavior through the campaigns API, the emailer seam and public pages,
// on the injected clock (docs/design/04-sending.md#campaigns).
import { afterEach, expect, test } from "bun:test";
import { runnerFixture, type RunnerFixture } from "@/test/campaigns/runner/fixture";
import { createSends } from "@/messaging/sends";
import { createMarketingPolicy } from "@/unsubscribe/policy";

let f: RunnerFixture;
afterEach(async () => {
  await f?.close();
});
const recipientsOf = () => f.pushes.map((p) => p.to).sort();
const header = (p: { message: { headers?: Record<string, string | string[]> } }, name: string) =>
  p.message.headers?.[name];

test("sends once to every eligible member and finishes", async () => {
  f = await runnerFixture();
  const single = await f.list("single", "single");
  const double = await f.list("double", "double");
  await f.member("a@x.test", [single], "unconfirmed");
  const sub = await f.member("b@x.test", [single, double], "confirmed");
  await f.member("c@x.test", [single], "unsubscribed");
  await f.member("d@x.test", [double], "unconfirmed");
  await f.member("e@x.test", [double], "confirmed");
  await f.member("f@x.test", [single], "confirmed", { status: "blocklisted" });
  const c = await f.campaign({
    name: "c",
    subject: "Hello {{ subscriber.name }}",
    lists: [single, double],
    content_type: "html",
    body: '<p>{{ unsubscribe_url }}</p><a href="{{ "https://example.test/x" | track_link }}">x</a>',
    headers: [{ "X-Custom": "1" }],
  });
  f.settings.batchSize = 2;
  expect((await f.status(c.id, "running")).status).toBe(200);
  f.start();
  await f.until(c.id, "finished");
  const read = await f.read(c.id);
  expect(recipientsOf()).toEqual(["a@x.test", "b@x.test", "e@x.test"]);
  expect(read.status).toBe("finished");
  expect(read.sent).toBe(3);
  expect(read.to_send).toBe(3);
  expect(read.started_at).not.toBeNull();
  const push = f.pushes.find((p) => p.to === "b@x.test")!;
  const unsubscribe = `http://fixture.test/subscription/${c.uuid}/${sub.uuid}`;
  expect(push.message.subject).toBe("Hello Ada Lovelace");
  expect(push.message.messageId).toBe(`<${c.uuid}.${sub.uuid}@fixture.test>`);
  expect(header(push, "List-Unsubscribe")).toBe(`<${unsubscribe}>`);
  expect(header(push, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  expect(header(push, "X-Listmonk-Campaign")).toBe(c.uuid);
  expect(header(push, "X-Custom")).toBe("1");
  const body = Buffer.from(push.message.body).toString();
  expect(body).toContain(unsubscribe);
  // The tracked link was registered for this campaign, so its redirect works.
  const link = /http:\/\/fixture\.test(\/link\/[^"]+)/.exec(body)![1]!;
  const redirect = await f.request(link);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("https://example.test/x");
});

test("an opt-in campaign targets unconfirmed members of double opt-in lists", async () => {
  f = await runnerFixture();
  const single = await f.list("single", "single");
  const double = await f.list("double", "double");
  await f.member("a@x.test", [single], "unconfirmed");
  await f.member("b@x.test", [double], "unconfirmed");
  await f.member("c@x.test", [double], "confirmed");
  await f.member("d@x.test", [double], "unsubscribed");
  const c = await f.campaign({ name: "o", subject: "s", lists: [single, double], type: "optin" });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  expect(recipientsOf()).toEqual(["b@x.test"]);
});

test("a scheduled campaign starts when send_at passes on the injected clock", async () => {
  f = await runnerFixture();
  const list = await f.list("l");
  await f.member("a@x.test", [list]);
  const sendAt = new Date(f.clock.now().getTime() + 60_000).toISOString();
  const c = await f.campaign({ name: "s", subject: "s", lists: [list], send_at: sendAt });
  expect((await f.status(c.id, "scheduled")).status).toBe(200);
  f.start();
  await f.drive(() => f.clock.now().getTime() >= Date.parse(sendAt) - 1000, 1000);
  expect(f.pushes.length).toBe(0);
  expect((await f.read(c.id)).status).toBe("scheduled");
  await f.until(c.id, "finished");
  expect(f.pushes.length).toBe(1);
  expect(f.pushes[0]!.at).toBeGreaterThanOrEqual(Date.parse(sendAt));
});

async function campaignOf(count: number) {
  const list = await f.list("l");
  for (let i = 0; i < count; i++) await f.member(`s${String(i).padStart(4, "0")}@x.test`, [list]);
  return f.campaign({ name: "bulk", subject: "s", lists: [list] });
}

test("concurrency and the per-worker message rate bound sends", async () => {
  f = await runnerFixture();
  const c = await campaignOf(40);
  Object.assign(f.settings, { concurrency: 2, messageRate: 3, batchSize: 7 });
  f.control.hold = true;
  await f.status(c.id, "running");
  f.start();
  await f.drive(async () => {
    // Each held message is accepted after 20 ms of SMTP time.
    for (const push of f.pushes) if (f.clock.now().getTime() - push.at >= 20) push.settle();
    return (await f.read(c.id)).status === "finished";
  }, 10);
  expect(recipientsOf().length).toBe(40);
  expect(new Set(recipientsOf()).size).toBe(40);
  expect(f.maxInFlight).toBeLessThanOrEqual(2);
  const times = f.pushes.map((p) => p.at).sort((a, b) => a - b);
  for (const t of times)
    expect(times.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(6);
  // 40 messages at no more than 6 per second take at least six seconds.
  expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(6000);
});

test("the sliding window holds sends until the window is over", async () => {
  f = await runnerFixture();
  const c = await campaignOf(25);
  Object.assign(f.settings, {
    slidingWindow: true,
    slidingWindowDuration: "10s",
    slidingWindowRate: 10,
    concurrency: 3,
  });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  const times = f.pushes.map((p) => p.at).sort((a, b) => a - b);
  expect(times.length).toBe(25);
  for (const t of times)
    expect(times.filter((u) => u >= t && u < t + 10_000).length).toBeLessThanOrEqual(10);
  expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(20_000);
});

test("the error threshold pauses the campaign and failed messages are never retried", async () => {
  f = await runnerFixture();
  const c = await campaignOf(10);
  Object.assign(f.settings, { maxSendErrors: 3, concurrency: 1, batchSize: 4 });
  f.control.outcome = "proven-not-accepted";
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "paused");
  expect(f.pushes.length).toBe(3);
  const read = await f.read(c.id);
  expect(read.sent).toBe(0);
  f.control.outcome = "accepted";
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "finished");
  // The three failures are not sent again; the fourth, never pushed, is.
  expect(f.pushes.length).toBe(10);
  expect(new Set(recipientsOf()).size).toBe(10);
  expect((await f.read(c.id)).sent).toBe(7);
});

test("ambiguous outcomes count as errors and are not resent", async () => {
  f = await runnerFixture();
  const c = await campaignOf(3);
  f.control.outcome = "ambiguous";
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  expect(recipientsOf().length).toBe(3);
  expect((await f.read(c.id)).sent).toBe(0);
});

test("pause takes effect mid-batch and resume sends only the unsent rest", async () => {
  f = await runnerFixture({ hold: true });
  const c = await campaignOf(12);
  Object.assign(f.settings, { concurrency: 2, batchSize: 10 });
  await f.status(c.id, "running");
  f.start();
  await f.drive(() => f.pushes.length === 2);
  expect((await f.status(c.id, "paused")).status).toBe(200);
  for (const push of f.pushes) push.settle();
  await f.drive(async () => (await f.read(c.id)).sent === 2);
  await f.drive(() => false, 1000, 10).catch(() => {});
  expect(f.pushes.length).toBe(2);
  expect((await f.status(c.id, "running")).status).toBe(200);
  f.control.hold = false;
  await f.until(c.id, "finished");
  expect(recipientsOf().length).toBe(12);
  expect(new Set(recipientsOf()).size).toBe(12);
  expect((await f.read(c.id)).sent).toBe(12);
});

test("cancel stops sending promptly", async () => {
  f = await runnerFixture({ hold: true });
  const c = await campaignOf(6);
  Object.assign(f.settings, { concurrency: 1 });
  await f.status(c.id, "running");
  f.start();
  await f.drive(() => f.pushes.length === 1);
  expect((await f.status(c.id, "cancelled")).status).toBe(200);
  f.control.hold = false;
  f.pushes[0]!.settle();
  await f.drive(() => false, 1000, 10).catch(() => {});
  expect(f.pushes.length).toBe(1);
  expect((await f.read(c.id)).status).toBe("cancelled");
});

test("shutdown returns the unsent rest and a restarted runner resumes without duplicates", async () => {
  f = await runnerFixture({ hold: true });
  const c = await campaignOf(9);
  Object.assign(f.settings, { concurrency: 3, batchSize: 9 });
  await f.status(c.id, "running");
  const first = f.start();
  await f.drive(() => f.pushes.length === 3);
  const stopping = first.stop();
  for (const push of f.pushes) push.settle();
  await stopping;
  expect(f.pushes.length).toBe(3);
  expect((await f.read(c.id)).status).toBe("running");
  f.control.hold = false;
  // The lease was released, so the next runner starts at once.
  f.start();
  await f.until(c.id, "finished");
  expect(recipientsOf().length).toBe(9);
  expect(new Set(recipientsOf()).size).toBe(9);
  expect(f.errors).toEqual([]);
});

test("a held lease keeps a second runner off the campaign", async () => {
  f = await runnerFixture({ hold: true });
  const c = await campaignOf(4);
  Object.assign(f.settings, { concurrency: 1, batchSize: 2 });
  await f.status(c.id, "running");
  f.start(3_000);
  await f.drive(() => f.pushes.length === 1);
  f.start(3_000);
  // Longer than the lease: the first runner's heartbeat keeps it.
  await f.drive(() => false, 500, 20).catch(() => {});
  expect(f.pushes.length).toBe(1);
  f.control.hold = false;
  f.pushes[0]!.settle();
  await f.until(c.id, "finished");
  expect(recipientsOf().length).toBe(4);
  expect(new Set(recipientsOf()).size).toBe(4);
});

test("an unknown messenger cancels the campaign", async () => {
  f = await runnerFixture();
  const list = await f.list("l");
  await f.member("a@x.test", [list]);
  const c = await f.campaign({ name: "m", subject: "s", lists: [list], messenger: "fixture" });
  await f.status(c.id, "running");
  // The named SMTP server was disabled after the campaign was created.
  f.settings.messengers = ["email"];
  f.start();
  await f.until(c.id, "cancelled");
  expect(f.pushes.length).toBe(0);
});

test("a campaign without recipients finishes", async () => {
  f = await runnerFixture();
  const list = await f.list("empty");
  const c = await f.campaign({ name: "e", subject: "s", lists: [list] });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  expect(f.pushes.length).toBe(0);
});

test("campaign deliveries count toward the marketing frequency cap", async () => {
  f = await runnerFixture();
  const list = await f.list("l");
  const a = await f.member("a@x.test", [list]);
  const b = await f.member("b@x.test", [list]);
  const c = await f.campaign({ name: "cap", subject: "s", lists: [list] });
  const minInterval = { value: "P1D" };
  const sends = createSends({
    db: f.db,
    clock: f.clock,
    subscribers: f.owners.subscribers,
    rootUrl: () => "http://fixture.test",
    marketingPolicy: createMarketingPolicy({
      subscribers: f.owners.subscribers,
      lists: f.owners.lists,
      settings: () => ({
        rootUrl: "http://fixture.test",
        siteName: "Fixture",
        minInterval: minInterval.value,
        unsubscribeHeader: true,
        allowBlocklist: false,
        individualTracking: false,
        disableTracking: false,
      }),
      campaignDeliveries: f.runnerStore,
    }),
  });
  try {
    expect(sends.marketingReason(BigInt(a.id), BigInt(list))).toBeNull();
    // Campaigns are not blocked by the cap: a second campaign still reaches everyone.
    await f.status(c.id, "running");
    f.start();
    await f.until(c.id, "finished");
    const sentAt = f.clock.now().getTime();
    expect(sends.marketingReason(BigInt(a.id), BigInt(list))).toBe("frequency_cap");
    expect(sends.marketingReason(BigInt(b.id), BigInt(list))).toBe("frequency_cap");
    expect(sends.capFreeAt(BigInt(a.id), new Date(sentAt)).getTime()).toBeGreaterThan(
      sentAt + 86_000_000,
    );
    const again = await f.campaign({ name: "cap2", subject: "s", lists: [list] });
    await f.status(again.id, "running");
    await f.until(again.id, "finished");
    expect(f.pushes.length).toBe(4);
    f.clock.advance(86_400_000 + 60_000);
    expect(sends.marketingReason(BigInt(a.id), BigInt(list))).toBeNull();
  } finally {
    sends.close();
  }
});

test("failed deliveries do not count toward the cap", async () => {
  f = await runnerFixture();
  const list = await f.list("l");
  const a = await f.member("a@x.test", [list]);
  const c = await f.campaign({ name: "f", subject: "s", lists: [list] });
  f.control.outcome = "proven-not-accepted";
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  expect(f.runnerStore.lastDelivery(BigInt(a.id))).toBeNull();
});
