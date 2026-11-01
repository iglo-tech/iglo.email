// B2 bounded retention through the HTTP API, the public pages and the injected clock.
import { afterEach, expect, test } from "bun:test";
import { createAnalyticsStore } from "@/analytics/store";
import type { Clock } from "@/clock";
import { permissions } from "@/roles/roles";
import { PURGE_INTERVAL_MS, startPurge, type Purge } from "@/loops/purge";
import { createSendCompaction } from "@/messaging/retention";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import { startReceiver } from "@/test/webhooks/receiver";

const day = 86_400_000;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Default credentials become an API user, so advancing the clock past a session keeps working. */
async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture(options);
  cleanups.push(() => f.close());
  const role = await f.json("/api/roles/users", "POST", {
    name: "retention-fixture",
    permissions: [...permissions, "sends:get", "sends:manage", "webhooks:manage"],
  });
  const user = await f.json("/api/users", "POST", {
    username: "retention-api",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  const headers = f.sessionHeaders as Record<string, string>;
  for (const key of Object.keys(headers)) delete headers[key];
  headers.authorization = `Basic ${btoa(`retention-api:${user.body.data.password}`)}`;
  return f;
}

/**
 * The fixture's time, with a retention loop's own sleeps: yields pass at once and record what is
 * left, and the idle interval, or the yield numbered `holdAfter`, holds until `again`, so one pass
 * can be told from the next.
 */
function paced(f: TxFixture, left: () => number, holdAfter = Infinity) {
  const yields: number[] = [];
  const pauses = new Set<number>();
  let idle = Promise.withResolvers<void>();
  let resume = () => {};
  const clock: Clock = {
    now: () => f.clock.now(),
    sleep(milliseconds, signal) {
      yields.push(left());
      pauses.add(milliseconds);
      if (milliseconds < PURGE_INTERVAL_MS && yields.length < holdAfter) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        resume = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        idle.resolve();
      });
    },
  };
  return {
    clock,
    yields,
    pauses,
    idle: () => idle.promise,
    again() {
      idle = Promise.withResolvers();
      resume();
      return idle.promise;
    },
  };
}
const purging = (f: TxFixture, clock: Clock, purges: Purge[], batchSize?: number) =>
  startPurge({
    db: f.db,
    clock,
    logger: logger(f),
    purges,
    ...(batchSize ? { batchSize } : {}),
  });
const scalar = (f: TxFixture, sql: string) => Number((f.db.query(sql).get() as { n: bigint }).n);
const logger = (f: TxFixture) => ({
  error: (error: unknown) => f.errors.push(error),
});
const stored = (f: TxFixture, id: number) =>
  f.db.query("SELECT payload, tracked_links FROM sends WHERE id = ?").get(id) as {
    payload: string | null;
    tracked_links: string | null;
  };
async function compactAll(f: TxFixture) {
  const pace = paced(f, () => 0);
  const loop = purging(f, pace.clock, [createSendCompaction(f.db)]);
  await pace.idle();
  await loop.stop();
}
function addSession(f: TxFixture, id: string, data: object, createdAt = f.clock.now()) {
  f.db.run("INSERT INTO sessions(id, data, created_at) VALUES (?, ?, ?)", [
    id,
    JSON.stringify(data),
    createdAt.toISOString(),
  ]);
}
const sessionIds = (f: TxFixture) =>
  (f.db.query("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]).map((r) => r.id);

test("expired sessions go and valid ones stay", async () => {
  const f = await open();
  const login = async () =>
    (await f.auth.login("fixture-admin", "fixture-admin-password")) as {
      id: string;
    };
  const old = await login();
  f.clock.advance(6 * day);
  const fresh = await login();
  // Written before sessions captured an expiry: seven days from creation, as the owner reads it.
  addSession(f, "legacy-valid", { user_id: "1", csrf: "c".repeat(43) });
  f.clock.advance(day);
  addSession(
    f,
    "legacy-expired",
    { user_id: "1", csrf: "c".repeat(43) },
    new Date(f.clock.now().getTime() - 7 * day),
  );
  addSession(f, "ends-now", {
    user_id: "1",
    csrf: "c".repeat(43),
    expires_at: f.clock.now().getTime(),
  });
  addSession(f, "ends-later", {
    user_id: "1",
    csrf: "c".repeat(43),
    expires_at: f.clock.now().getTime() + 1,
  });
  const cookie = (id: string) => ({ cookie: `session=${id}` });
  expect((await f.json("/api/profile", "GET", undefined, cookie(old.id))).status).not.toBe(200);
  expect((await f.json("/api/profile", "GET", undefined, cookie(fresh.id))).status).toBe(200);

  const pace = paced(f, () => sessionIds(f).length);
  const loop = purging(f, pace.clock, [f.owners.users.purgeSessions]);
  await pace.idle();
  expect(sessionIds(f).sort()).toEqual(["ends-later", fresh.id, "legacy-valid"].sort());
  expect((await f.json("/api/profile", "GET", undefined, cookie(fresh.id))).status).toBe(200);
  // Time passes and the next hourly pass takes what has expired since.
  f.clock.advance(7 * day);
  await pace.again();
  expect(sessionIds(f)).toEqual([]);
  await loop.stop();
  expect(f.errors).toEqual([]);
});

test("a pass honors its batch size, and a restart resumes the backlog", async () => {
  const f = await open();
  const at = f.clock.now().getTime();
  for (let i = 0; i < 7; i++)
    addSession(f, `s${i}`, {
      user_id: "1",
      csrf: "c".repeat(43),
      expires_at: at - 1,
    });
  // Only these rows count here; the fixture's own login stays valid.
  const left = () => sessionIds(f).filter((id) => /^s\d$/.test(id)).length;
  const start = (clock: Clock) => purging(f, clock, [f.owners.users.purgeSessions], 3);
  const first = paced(f, left, 1);
  const stopped = start(first.clock);
  await first.idle();
  await stopped.stop();
  expect(first.yields).toEqual([4]);
  const second = paced(f, left);
  const loop = start(second.clock);
  await second.idle();
  expect(second.yields).toEqual([1, 0, 0]);
  // A pass with work pauses before the next, and one without waits for the interval.
  expect([...second.pauses]).toEqual([250, PURGE_INTERVAL_MS]);
  await loop.stop();
  expect(f.errors).toEqual([]);
});

test("owners take turns, one per pass, and an owner with nothing costs no pause", async () => {
  const f = await open();
  const left = [2, 0, 3];
  const taken: number[] = [];
  const owner =
    (index: number): Purge =>
    (_now, limit) => {
      const rows = Math.min(limit, left[index]!);
      left[index]! -= rows;
      if (rows) taken.push(index);
      return Array.from({ length: rows });
    };
  const pace = paced(f, () => left.reduce((a, b) => a + b));
  const loop = purging(f, pace.clock, [owner(0), owner(1), owner(2)], 1);
  await pace.idle();
  expect(taken).toEqual([0, 2, 0, 2, 2]);
  expect(pace.yields).toEqual([4, 3, 2, 1, 0, 0]);
  await loop.stop();
  expect(f.errors).toEqual([]);
});

test("finished deliveries go after 30 days, pending ones never, and the API stays consistent", async () => {
  const f = await open({ webhooks: {} });
  let status = 200;
  const r = startReceiver(() => new Response("x", { status }));
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", {
    url: r.url(),
    events: ["send.failed"],
  });
  const id = created.body.data.id as number;
  const queue = () =>
    f.db.transaction(() =>
      f.webhooks!.queueWebhook("send.failed", () => ({
        subscriber: null,
        list_ids: [],
      })),
    )();
  const list = async () => (await f.json(`/api/webhooks/${id}/deliveries?per_page=100`)).body.data;
  const until = async (check: (rows: any[]) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!check((await list()).results)) {
      if (Date.now() > deadline) throw new Error("Condition not reached");
      await Bun.sleep(2);
    }
  };
  queue();
  await until((rows) => rows[0]?.status === "delivered");
  status = 500;
  queue();
  await until((rows) =>
    rows.some((row) => row.attempts === 1 && row.status === "queued" && !row.claimed_until),
  );
  // A row whose retries run out ends failed a day after it was queued.
  f.clock.advance(day - 1);
  f.advanceWebhooks(1);
  await until((rows) => rows.every((row) => row.status !== "queued"));
  expect((await list()).results.map((row: any) => row.status)).toEqual(["failed", "delivered"]);

  // A row still pending, with its due time long past: the webhook is disabled at no time here.
  f.db.run("UPDATE webhooks SET enabled = 0 WHERE id = ?", [id]);
  f.clock.advance(29 * day + 1);
  f.db.run(
    `INSERT INTO webhook_deliveries (uuid, webhook_id, event, payload, next_attempt_at, created_at, updated_at, claimed_until)
     VALUES ('pending-old', ?1, 'send.failed', '{}', ?2, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL),
            ('claimed-old', ?1, 'send.failed', '{}', ?2, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', ?2)`,
    [id, "2999-01-01T00:00:00.000Z"],
  );
  const remaining = () => scalar(f, "SELECT count(*) AS n FROM webhook_deliveries");
  const pace = paced(f, remaining);
  const loop = purging(f, pace.clock, [f.webhooks!.purge], 1);
  await pace.idle();
  // The failed row finished 29 days ago and stays; the delivered one finished just over 30 ago.
  expect((await list()).results.map((row: any) => row.status)).toEqual([
    "queued",
    "queued",
    "failed",
  ]);
  expect((await list()).total).toBe(3);
  f.clock.advance(day + 1);
  await pace.again();
  const after = await list();
  expect(after.results.map((row: any) => row.uuid)).toEqual(["claimed-old", "pending-old"]);
  expect(after.total).toBe(2);
  expect(pace.yields.at(-1)).toBe(2);
  await loop.stop();
});

test("an old email keeps working after its body is dropped, and only finished rows change", async () => {
  const f = await open({ webhooks: {} });
  f.bounceSettings.enabled = true;
  f.bounceSettings.webhooksEnabled = true;
  f.marketing.minInterval = "";
  const target = "https://example.test/landing?campaign=1";
  const template = await f.template(
    `<p>Secret body <a href="{{ '${target}' | track_link }}">go</a> <a href="{{ unsubscribe_url }}">unsub</a></p>`,
  );
  const list = (
    await f.json("/api/lists", "POST", {
      name: "news",
      type: "public",
      optin: "single",
    })
  ).body.data.id as number;
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list] });
  const key = "retained-idempotency-key";
  const first = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list,
    idempotency_key: key,
    data: {},
  });
  const send = first.body.data.sends[0];
  expect(send.status).toBe("sent");
  const mail = f.sink.messages[0]!.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
  const path = new RegExp(`/m/${send.uuid}/link/[0-9a-f-]{36}`).exec(mail)![0];
  const unsubscribe = new RegExp(`/m/${send.uuid}/unsubscribe/[0-9a-f-]{36}`).exec(mail)![0];
  expect((await f.request(path)).status).toBe(307);
  const before = await f.json(`/api/sends/${send.id}`);

  f.clock.advance(30 * day - 1);
  await compactAll(f);
  expect(stored(f, send.id).payload).not.toBeNull();
  f.clock.advance(2);
  await f.stopOutbox();
  f.db.run(
    `INSERT INTO sends(uuid, source, kind, status, to_email, smtp_message_id, payload, created_at)
     VALUES ('queued-old', 'tx', 'transactional', 'queued', 'q@example.test', 'q', '{"version":1}', '2000-01-01T00:00:00.000Z'),
            ('sending-old', 'tx', 'transactional', 'sending', 's@example.test', 's', '{"version":1}', '2000-01-01T00:00:00.000Z')`,
  );
  await compactAll(f);
  expect(stored(f, send.id).payload).toBeNull();
  expect(stored(f, send.id).tracked_links).toBe(path);
  expect(JSON.stringify(stored(f, send.id))).not.toContain("Secret");
  expect(
    scalar(f, "SELECT count(*) AS n FROM sends WHERE uuid LIKE '%-old' AND payload IS NOT NULL"),
  ).toBe(2);
  f.db.run("DELETE FROM sends WHERE uuid LIKE '%-old'");

  // The public row and the producer's retry are unchanged.
  expect(await f.json(`/api/sends/${send.id}`)).toEqual(before);
  const replay = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list,
    idempotency_key: key,
    data: {},
  });
  expect(replay.body.data.sends[0].id).toBe(send.id);
  expect(f.count()).toBe(1);

  // A tracked link and the pixel still work, and a link from another message still does not.
  const redirect = await f.request(path);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe(target);
  expect((await f.request(`/m/${send.uuid}/px.png`)).status).toBe(200);
  expect((await f.request(`/m/${send.uuid}/link/${crypto.randomUUID()}`)).status).toBe(400);
  // A bounce still finds the send and its recipient.
  const bounce = {
    type: "soft",
    source: "api",
    send_uuid: send.uuid,
    email: "ada@example.test",
  };
  expect((await f.json("/webhooks/bounce", "POST", bounce)).status).toBe(200);
  expect(f.db.query("SELECT subscriber_id, send_id FROM bounces").all()).toEqual([
    { subscriber_id: BigInt(ada), send_id: BigInt(send.id) },
  ]);
  // The frequency cap still counts it: a year-long cap sees this one.
  f.marketing.minInterval = "P1Y";
  const capped = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list,
    data: {},
  });
  expect(capped.body.data.sends[0]).toMatchObject({ status: "skipped" });
  // The unsubscribe link of a 30-day-old message still unsubscribes.
  const page = await f.request(unsubscribe, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(page.status).toBe(200);
  const lists = (await f.json(`/api/subscribers/${ada}`)).body.data.lists;
  expect(lists[0].subscription_status).toBe("unsubscribed");
  expect(f.errors).toEqual([]);
});

test("analytics totals match before and after a compaction", async () => {
  const f = await open();
  const template = await f.template(`<a href="{{ 'https://example.test/a' | track_link }}">a</a>`);
  const sent: { uuid: string }[] = [];
  for (let i = 0; i < 3; i++)
    sent.push(
      (
        await f.tx({
          subscriber_emails: [`p${i}@example.test`],
          subscriber_mode: "external",
          template_id: template,
          data: {},
        })
      ).body.data.sends[0],
    );
  const failing = f.sink.messages.length;
  const mail = f.sink.messages[failing - 1]!.data.replace(/=\r\n/g, "");
  const path = new RegExp(`/m/${sent[2]!.uuid}/link/[0-9a-f-]{36}`).exec(mail)![0];
  await f.request(path);
  await f.request(path);
  await f.request(`/m/${sent[0]!.uuid}/px.png`);
  const analytics = createAnalyticsStore(f.db);
  cleanups.push(() => analytics.close());
  const range = { from: "2000-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z" };
  const read = () => ({
    template: analytics.sends("template", range),
    step: analytics.sends("step", range),
    listed: f.sends.list({ page: 1, perPage: 100 }),
  });
  const before = read();
  expect(before.template[0]).toMatchObject({
    sends: 3,
    views: 1,
    clicks: 2,
    unique_clicks: 1,
  });
  f.clock.advance(31 * day);
  await compactAll(f);
  expect(scalar(f, "SELECT count(*) AS n FROM sends WHERE payload IS NOT NULL")).toBe(0);
  expect(read()).toEqual(before);
  expect(f.errors).toEqual([]);
});

test("deleting a subscriber still stops an old tracked link", async () => {
  const f = await open();
  const template = await f.template(`<a href="{{ 'https://example.test/a' | track_link }}">a</a>`);
  const ada = await f.subscriber("ada@example.test");
  const send = (await f.tx({ subscriber_id: ada, template_id: template, data: {} })).body.data
    .sends[0];
  const mail = f.sink.messages[0]!.data.replace(/=\r\n/g, "");
  const path = new RegExp(`/m/${send.uuid}/link/[0-9a-f-]{36}`).exec(mail)![0];
  f.clock.advance(31 * day);
  await compactAll(f);
  expect((await f.request(path)).status).toBe(307);
  expect((await f.json(`/api/subscribers/${ada}`, "DELETE")).status).toBe(200);
  expect(stored(f, send.id)).toEqual({ payload: null, tracked_links: null });
  expect((await f.request(path)).status).toBe(400);
});

test("a failed send can be resent until retention, and a resent one stays traceable", async () => {
  let rejecting = true;
  const f = await open({ reject: () => rejecting });
  const template = await f.template(`<a href="{{ 'https://example.test/a' | track_link }}">a</a>`);
  const subject = {
    subscriber_mode: "external",
    template_id: template,
    data: {},
  };
  const kept = (await f.tx({ ...subject, subscriber_emails: ["a@example.test"] })).body.data
    .sends[0];
  const dropped = (await f.tx({ ...subject, subscriber_emails: ["b@example.test"] })).body.data
    .sends[0];
  expect([kept.status, dropped.status]).toEqual(["failed", "failed"]);
  rejecting = false;
  f.clock.advance(day);
  const child = await f.json(`/api/sends/${kept.id}/resend`, "POST");
  expect(child.status).toBe(200);
  const until = Date.now() + 10_000;
  while (f.sink.messages.length < 1 && Date.now() < until) {
    await Bun.sleep(2);
  }
  // The copy carries its parent's links, so the parent's row answers for them.
  const mail = f.sink.messages[0]!.data.replace(/=\r\n/g, "");
  const path = new RegExp(`/m/${kept.uuid}/link/[0-9a-f-]{36}`).exec(mail)![0];
  f.clock.advance(31 * day);
  await compactAll(f);
  expect((await f.request(path)).status).toBe(307);
  // Past retention the same resend answers as it does for a row without a message.
  expect((await f.json(`/api/sends/${dropped.id}/resend`, "POST")).status).toBe(409);
  expect((await f.json(`/api/sends/${kept.id}/resend`, "POST")).body.data.id).toBe(
    child.body.data.id,
  );
  expect(f.count()).toBe(3);
});

test("a pass reads a bounded number of payload bytes", async () => {
  const f = await open();
  const big = "x".repeat(1536 * 1024);
  for (let i = 0; i < 4; i++)
    f.db.run(
      `INSERT INTO sends(uuid, source, kind, status, to_email, smtp_message_id, payload, created_at)
       VALUES (?, 'tx', 'transactional', 'sent', 'q@example.test', ?, json_object('pad', ?), '2000-01-01T00:00:00.000Z')`,
      [`row-${i}`, `id-${i}`, big],
    );
  const compact = createSendCompaction(f.db);
  const now = f.clock.now();
  expect(compact(now, 100)).toHaveLength(2);
  expect(compact(now, 1)).toHaveLength(1);
  expect(compact(now, 100)).toHaveLength(1);
  expect(compact(now, 100)).toHaveLength(0);
});
