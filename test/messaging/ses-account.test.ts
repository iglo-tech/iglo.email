// B145a (14-projects sections 7 and 15, D159): the SES account snapshot on the injected clock,
// against a stand-in for SES v2 GetAccount. Tests never call AWS: the endpoint is injected.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  createSesAccount,
  effectiveRate,
  holdLine,
  quotaHeld,
  refreshDelay,
} from "@/messaging/ses-account";
import { createTestInstanceSettings } from "@/test/settings/instance-fixture";
import type { TestInstanceSettings } from "@/test/settings/instance-fixture";
import { TestClock } from "@/test/server/fixture";

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Answer this status with a body that never ends: 16 KiB chunks for as long as it is read. */
  endless?: boolean;
  /** Answer only once this settles: a read stays in flight until then. */
  gate?: Promise<void>;
}

const calls: Array<{ path: string; authorization: string; date: string }> = [];
let answer: Answer = { status: 200, body: {} };
let server: ReturnType<typeof Bun.serve>;

const quota = (max: number, sent: number, rate = 14) => ({
  status: 200,
  body: {
    SendQuota: { Max24HourSend: max, MaxSendRate: rate, SentLast24Hours: sent },
    ProductionAccessEnabled: true,
    SendingEnabled: true,
    EnforcementStatus: "HEALTHY",
  },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization") ?? "",
        date: request.headers.get("x-amz-date") ?? "",
      });
      await answer.gate;
      if (answer.endless) {
        const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"SendQuota":'));
          },
          pull(controller) {
            controller.enqueue(chunk);
          },
        });
        return new Response(body, {
          status: answer.status,
          headers: { "content-type": "application/json", ...answer.headers },
        });
      }
      return Response.json(answer.body, { status: answer.status, headers: answer.headers ?? {} });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

let open: Array<{ stop(): Promise<void> }> = [];
let stores: Array<TestInstanceSettings> = [];

afterEach(async () => {
  for (const item of open) {
    await item.stop();
  }
  for (const store of stores) {
    store.close();
  }
  open = [];
  stores = [];
  calls.length = 0;
});

function setup(options: { credentials?: boolean; rate?: number } = {}) {
  const clock = new TestClock();
  const settings = createTestInstanceSettings(clock);
  stores.push(settings);
  settings.update((current) => ({
    ...current,
    "messaging.max_send_rate": options.rate ?? 14,
    ...(options.credentials === false
      ? {}
      : {
          "ses.api_region": "eu-west-1",
          "ses.api_access_key_id": KEY_ID,
          "ses.api_secret_access_key": SECRET,
        }),
  }));
  const attention: Array<string> = [];
  /** The hold at each `onChange`. */
  const changes: Array<boolean> = [];
  const account = createSesAccount({
    clock,
    settings: settings.reader,
    endpoint: () => `http://127.0.0.1:${server.port}`,
    attention: (line) => attention.push(line),
    onChange: () => {
      changes.push(account.held());
    },
  });
  open.push(account);
  /** Moves the clock and waits for the loop to sleep again: a read it started is finished. */
  const step = async (ms: number) => {
    clock.advance(ms);
    await clock.whenSleeping();
  };
  return { clock, settings, account, attention, changes, step };
}

test("GetAccount is signed with SigV4 for ses in the instance's region, and its five fields are read", async () => {
  answer = quota(50_000, 1234, 14);
  const { account, clock } = setup();
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).toBe("/v2/email/account");
  expect(calls[0]!.date).toBe("20260102T030405Z");
  expect(calls[0]!.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260102\/eu-west-1\/ses\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  expect(account.current()).toEqual({
    configured: true,
    error: null,
    snapshot: {
      maxSendRate: 14,
      max24HourSend: 50_000,
      sentLast24Hours: 1234,
      productionAccessEnabled: true,
      sendingEnabled: true,
      readAt: "2026-01-02T03:04:05.000Z",
    },
  });
});

test("without the three API keys nothing is read and nothing is configured", async () => {
  answer = quota(50_000, 0);
  const { account, step } = setup({ credentials: false });
  account.start();
  await step(0);
  await step(10 * 60_000);
  expect(calls).toHaveLength(0);
  expect(await account.check()).toEqual({ configured: false, snapshot: null, error: null });
  expect(calls).toHaveLength(0);
});

test("refresh: every 5 minutes, every minute once at most max(10%, rate × 300 s) is left (10,000 at rate 14: 4,200)", async () => {
  // 5,000 left of 10,000 at rate 14: above the 4,200 line, so the next read is in 5 minutes.
  answer = quota(10_000, 5000);
  const { account, clock, step } = setup();
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  await step(4 * 60_000 + 59_999);
  expect(calls).toHaveLength(1);
  // Exactly 4,200 left: the fast refresh starts.
  answer = quota(10_000, 5800);
  await step(1);
  expect(calls).toHaveLength(2);
  await step(59_999);
  expect(calls).toHaveLength(2);
  // 4,201 left: back above the line after this read.
  answer = quota(10_000, 5799);
  await step(1);
  expect(calls).toHaveLength(3);
  await step(59_999 + 1);
  expect(calls).toHaveLength(3);
  await step(4 * 60_000 - 1);
  expect(calls).toHaveLength(3);
  await step(1);
  expect(calls).toHaveLength(4);
});

test("refresh: raising the rate mid-sleep brings the read forward to a minute after the last one (B164)", async () => {
  // 3,500 left of 10,000. At rate 10 the line is max(1,000, 3,000) = 3,000: a 5-minute wait.
  answer = quota(10_000, 6500, 20);
  const { account, clock, settings, step } = setup({ rate: 10 });
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  await step(30_000);
  // At rate 14 the line is 4,200: 3,500 left needs a read every minute, counted from the last read.
  settings.update((current) => ({ ...current, "messaging.max_send_rate": 14 }));
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  await step(29_999);
  expect(calls).toHaveLength(1);
  await step(1);
  expect(calls).toHaveLength(2);
  await step(60_000);
  expect(calls).toHaveLength(3);
});

test("refresh: a rate of 0 lifts the cap to SES's rate, which brings the read forward too (B164)", async () => {
  answer = quota(10_000, 6500, 14);
  const { account, clock, settings, step } = setup({ rate: 10 });
  account.start();
  await clock.whenSleeping();
  await step(90_000);
  settings.update((current) => ({ ...current, "messaging.max_send_rate": 0 }));
  expect(account.rate()).toBe(14);
  // The minute since the last read is already over: the read is due now.
  await clock.whenSleeping();
  expect(calls).toHaveLength(2);
  await step(59_999);
  expect(calls).toHaveLength(2);
  await step(1);
  expect(calls).toHaveLength(3);
});

test("refresh: a rate change that does not shorten the wait reads nothing extra (B164)", async () => {
  answer = quota(10_000, 6500, 20);
  const { account, clock, settings, step } = setup({ rate: 10 });
  account.start();
  await clock.whenSleeping();
  await step(60_000);
  // Rate 11: line 3,300, still under the 3,500 left. Rate 5: line 1,000. Both keep 5 minutes.
  settings.update((current) => ({ ...current, "messaging.max_send_rate": 11 }));
  await clock.whenSleeping();
  await step(60_000);
  settings.update((current) => ({ ...current, "messaging.max_send_rate": 5 }));
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  await step(3 * 60_000 - 1);
  expect(calls).toHaveLength(1);
  await step(1);
  expect(calls).toHaveLength(2);
});

test("refresh: a forecast's read that shortens the refresh brings the loop's read to a minute after it (B164)", async () => {
  // Rate setting 0: SES's MaxSendRate 10 applies. 3,500 left of 10,000, line max(1,000, 3,000) = 3,000.
  answer = quota(10_000, 6500, 10);
  const { account, clock, step } = setup({ rate: 0 });
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  await step(70_000);
  // MaxSendRate 20: line 6,000, so 3,500 left needs a read every minute from this read's start.
  answer = quota(10_000, 6500, 20);
  await account.fresh();
  expect(calls).toHaveLength(2);
  expect(account.rate()).toBe(20);
  await clock.whenSleeping();
  await step(59_999);
  expect(calls).toHaveLength(2);
  await step(1);
  expect(calls).toHaveLength(3);
});

test("refresh: a forecast's read that keeps the slow refresh adds no loop read; the next is 5 minutes after it (B164, D175)", async () => {
  answer = quota(10_000, 6500, 10);
  const { account, clock, step } = setup({ rate: 0 });
  account.start();
  await clock.whenSleeping();
  await step(70_000);
  await account.fresh();
  expect(calls).toHaveLength(2);
  await clock.whenSleeping();
  // The refresh counts from the last read's start: 70 s + 300 s.
  await step(300_000 - 1);
  expect(calls).toHaveLength(2);
  await step(1);
  expect(calls).toHaveLength(3);
});

const snapshot = (max: number, sent: number, maxSendRate = 14) => ({
  maxSendRate,
  max24HourSend: max,
  sentLast24Hours: sent,
  productionAccessEnabled: true,
  sendingEnabled: true,
  readAt: "2026-01-02T03:04:05.000Z",
});

test("refresh: a large quota uses 10%, and the rate term is the effective rate", () => {
  // 1,000,000 quota: 10% = 100,000 beats 14 × 300 = 4,200.
  expect(refreshDelay(snapshot(1_000_000, 900_000), 14)).toBe(60_000);
  expect(refreshDelay(snapshot(1_000_000, 899_999), 14)).toBe(300_000);
  // 10,000 quota: 4,200 beats 1,000.
  expect(refreshDelay(snapshot(10_000, 5800), 14)).toBe(60_000);
  expect(refreshDelay(snapshot(10_000, 5799), 14)).toBe(300_000);
  // No 24-hour limit (-1): never fast.
  expect(refreshDelay(snapshot(-1, 5_000_000), 14)).toBe(300_000);
});

const ses = (maxSendRate: number) => ({ maxSendRate });

test("effective rate: the lower of the setting and SES's MaxSendRate; the setting alone without a snapshot", () => {
  expect(effectiveRate(14, ses(10))).toBe(10);
  expect(effectiveRate(5, ses(10))).toBe(5);
  expect(effectiveRate(0, ses(10))).toBe(10);
  expect(effectiveRate(14, null)).toBe(14);
  expect(effectiveRate(0, null)).toBe(0);
});

test("a failed read keeps the last snapshot and writes one attention line per hour", async () => {
  answer = quota(50_000, 100);
  const { account, clock, step, attention } = setup();
  account.start();
  await clock.whenSleeping();
  const kept = account.current().snapshot;
  expect(kept?.sentLast24Hours).toBe(100);
  answer = {
    status: 403,
    body: { message: "User is not authorized to perform: ses:GetAccount" },
    headers: { "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/" },
  };
  await step(5 * 60_000);
  expect(calls).toHaveLength(2);
  expect(account.current()).toEqual({
    configured: true,
    snapshot: kept,
    error:
      "SES GetAccount answered 403 AccessDeniedException: User is not authorized to perform: ses:GetAccount",
  });
  expect(attention).toHaveLength(1);
  expect(attention[0]).toContain("AccessDeniedException");
  expect(attention[0]).toContain("keeping the snapshot read at 2026-01-02T03:04:05.000Z");
  // Eleven more failures within the hour: no new line.
  for (let n = 0; n < 11; n++) {
    await step(5 * 60_000);
  }
  expect(calls).toHaveLength(13);
  expect(attention).toHaveLength(1);
  // An hour after the first line, the next failure writes the second.
  await step(5 * 60_000);
  expect(attention).toHaveLength(2);
  // A good read clears the error; the next failure writes a line at once.
  answer = quota(50_000, 200);
  await step(5 * 60_000);
  expect(account.current().error).toBeNull();
  expect(account.current().snapshot?.sentLast24Hours).toBe(200);
  answer = { status: 500, body: "not json" };
  await step(5 * 60_000);
  expect(attention).toHaveLength(3);
  expect(attention[2]).toStartWith("SES GetAccount answered 500");
});

test("on demand: a forecast reads again when the snapshot is older than a minute, not sooner", async () => {
  answer = quota(50_000, 100);
  const { account, clock } = setup();
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  clock.advance(60_000);
  await account.fresh();
  expect(calls).toHaveLength(1);
  answer = quota(50_000, 300);
  clock.advance(1);
  const state = await account.fresh();
  expect(calls).toHaveLength(2);
  expect(state.snapshot?.sentLast24Hours).toBe(300);
  expect(state.snapshot?.readAt).toBe("2026-01-02T03:05:05.001Z");
});

test("refresh counts from a read's start: an answer after the next read is due starts it at once, one at a time", async () => {
  // B151 (D175): 1,000 left of 10,000 at rate 14 is below the 4,200 line, so reads are a minute
  // apart, counted from when each began.
  answer = quota(10_000, 9000);
  const { account, clock, step } = setup();
  account.start();
  await clock.whenSleeping();
  expect(calls).toHaveLength(1);
  // The second read begins a minute later and answers only 70 s after it began.
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  answer = { ...quota(10_000, 9000), gate };
  clock.advance(60_000);
  while (calls.length < 2) {
    await Bun.sleep(1);
  }
  clock.advance(70_000);
  await Bun.sleep(5);
  // No second read starts while one is in flight.
  expect(calls).toHaveLength(2);
  answer = quota(10_000, 9000);
  release();
  // It was due at 03:06:05, a minute after the second began: the third begins at once, at 03:06:15.
  await clock.whenSleeping();
  expect(calls.map((call) => call.date)).toEqual([
    "20260102T030405Z",
    "20260102T030505Z",
    "20260102T030615Z",
  ]);
  // No burst: the next read is a minute after the third began.
  await step(59_999);
  expect(calls).toHaveLength(3);
  await step(1);
  expect(calls).toHaveLength(4);
  expect(calls[3]!.date).toBe("20260102T030715Z");
});

test("an answer longer than 64 KiB is read only to the limit and fails the read at once", async () => {
  answer = quota(50_000, 100);
  const { account, clock } = setup();
  account.start();
  await clock.whenSleeping();
  for (const status of [200, 403]) {
    answer = {
      status,
      body: null,
      endless: true,
      headers: status === 200 ? {} : { "x-amzn-errortype": "AccessDeniedException:" },
    };
    const started = performance.now();
    const checked = await account.check();
    // Well inside the 10-second timeout: the client stops reading, it does not wait it out.
    expect(performance.now() - started).toBeLessThan(3000);
    expect(checked.error).toBe(
      status === 200
        ? "SES GetAccount answered more than 64 KiB"
        : "SES GetAccount answered 403 AccessDeniedException",
    );
    // The snapshot from the good read is kept.
    expect(checked.snapshot?.sentLast24Hours).toBe(100);
  }
});

test("the check button reads now and shows the AWS error; new credentials drop the old snapshot", async () => {
  answer = quota(50_000, 100);
  const { account, clock, settings } = setup();
  account.start();
  await clock.whenSleeping();
  answer = {
    status: 403,
    body: { message: "The security token included in the request is invalid." },
  };
  const checked = await account.check();
  expect(calls).toHaveLength(2);
  expect(checked.error).toBe(
    "SES GetAccount answered 403: The security token included in the request is invalid.",
  );
  expect(checked.snapshot?.sentLast24Hours).toBe(100);
  settings.update((current) => ({ ...current, "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLF" }));
  expect(account.current()).toEqual({ configured: true, snapshot: null, error: null });
});

test("a key change during a read: the loop reads again with the new keys at once, not after 5 minutes", async () => {
  // B149b (B145a r1): the read in flight uses the old keys and is discarded.
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  answer = { ...quota(50_000, 100), gate };
  const { account, clock, settings } = setup();
  account.start();
  while (calls.length === 0) {
    await Bun.sleep(1);
  }
  settings.update((current) => ({ ...current, "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLF" }));
  answer = quota(50_000, 200);
  release();
  // No time passes on the clock: the new keys are read before the loop sleeps.
  await clock.whenSleeping();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.authorization).toContain("Credential=AKIAIOSFODNN7EXAMPLF/");
  expect(account.current().snapshot?.sentLast24Hours).toBe(200);
});

test("on demand: two forecasts during one read both get its snapshot, with one GetAccount (B170, D198)", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  answer = { ...quota(50_000, 100), gate };
  const { account } = setup();
  const first = account.fresh();
  while (calls.length === 0) {
    await Bun.sleep(1);
  }
  // The read is in flight and began just now: the second forecast shares it, not the empty state.
  const second = account.fresh();
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.snapshot?.sentLast24Hours).toBe(100);
  expect(b.snapshot?.sentLast24Hours).toBe(100);
  expect(calls).toHaveLength(1);
});

test("a key change during a read: a forecast's read waits for it, then reads with the new keys", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  answer = { ...quota(50_000, 100), gate };
  const { account, settings } = setup();
  const first = account.fresh();
  while (calls.length === 0) {
    await Bun.sleep(1);
  }
  settings.update((current) => ({ ...current, "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLF" }));
  const second = account.fresh();
  answer = quota(50_000, 200);
  release();
  await first;
  expect((await second).snapshot?.sentLast24Hours).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.authorization).toContain("Credential=AKIAIOSFODNN7EXAMPLF/");
});

test("hold line: max(2% of the quota, effective rate × 60 s); never without a snapshot or a daily limit", () => {
  // 1,000,000 quota: 2% = 20,000 beats 14 × 60 = 840.
  expect(holdLine(snapshot(1_000_000, 0), 14)).toBe(20_000);
  expect(quotaHeld(snapshot(1_000_000, 980_000), 14)).toBe(true);
  expect(quotaHeld(snapshot(1_000_000, 979_999), 14)).toBe(false);
  // 10,000 quota at rate 14: 840 beats 2% = 200.
  expect(holdLine(snapshot(10_000, 0), 14)).toBe(840);
  expect(quotaHeld(snapshot(10_000, 9160), 14)).toBe(true);
  expect(quotaHeld(snapshot(10_000, 9159), 14)).toBe(false);
  // Past the quota is held too.
  expect(quotaHeld(snapshot(10_000, 12_000), 14)).toBe(true);
  expect(quotaHeld(null, 14)).toBe(false);
  expect(quotaHeld(snapshot(-1, 5_000_000), 14)).toBe(false);
});

test("guard: one line when holding starts and one when it stops; a failed read keeps the hold and writes no guard line", async () => {
  answer = quota(10_000, 9160);
  const { account, attention, changes, step } = setup();
  expect(account.held()).toBe(false);
  account.start();
  await step(0);
  expect(account.held()).toBe(true);
  expect(changes).toEqual([true]);
  expect(attention).toEqual([
    "SES quota guard: holding marketing and campaign sends: 840 of the 24-hour quota of 10000 left, at or below the hold line of 840 (snapshot read at 2026-01-02T03:04:05.000Z)",
  ]);
  // Unchanged reads every minute: no repeat line, no wake.
  await step(60_000);
  await step(60_000);
  expect(calls).toHaveLength(3);
  expect(attention).toHaveLength(1);
  expect(changes).toEqual([true]);
  // A failed read keeps the last snapshot, so the hold stays; only the read's own line is written.
  answer = { status: 500, body: { message: "Internal" } };
  await step(60_000);
  expect(account.held()).toBe(true);
  expect(attention).toHaveLength(2);
  expect(attention[1]).toStartWith("SES GetAccount answered 500");
  expect(changes).toEqual([true]);
  // A newer snapshot above the line lifts it.
  answer = quota(10_000, 9159);
  await step(60_000);
  expect(account.held()).toBe(false);
  expect(changes).toEqual([true, false]);
  expect(attention).toHaveLength(3);
  expect(attention[2]).toBe(
    "SES quota guard: resuming marketing and campaign sends: 841 of the 24-hour quota of 10000 left, above the hold line of 840 (snapshot read at 2026-01-02T03:08:05.000Z)",
  );
});

test("guard: removing the API keys ends a hold, with its line; a rate change wakes the dispatcher", async () => {
  // 200 left: held at rate 14 (line 840) and at rate 5 (line 300).
  answer = quota(10_000, 9800, 14);
  const { account, attention, changes, settings, step } = setup({ rate: 20 });
  account.start();
  await step(0);
  // Effective rate min(20, 14) = 14: the rate moved and the hold started, one wake.
  expect(account.rate()).toBe(14);
  expect(account.held()).toBe(true);
  expect(changes).toEqual([true]);
  // The setting lowered under SES's rate: the rate moves again, the hold stays.
  settings.update((current) => ({ ...current, "messaging.max_send_rate": 5 }));
  expect(account.rate()).toBe(5);
  expect(changes).toEqual([true, true]);
  // An unrelated setting: no wake.
  settings.update((current) => ({
    ...current,
    "bounce.ses_enabled": !current["bounce.ses_enabled"],
  }));
  expect(changes).toEqual([true, true]);
  settings.update((current) => ({
    ...current,
    "ses.api_region": "",
    "ses.api_access_key_id": "",
    "ses.api_secret_access_key": "",
  }));
  expect(account.held()).toBe(false);
  expect(changes).toEqual([true, true, false]);
  expect(attention.at(-1)).toBe(
    "SES quota guard: resuming marketing and campaign sends: the SES API keys changed",
  );
  expect(attention.filter((line) => line.startsWith("SES quota guard"))).toHaveLength(2);
});
