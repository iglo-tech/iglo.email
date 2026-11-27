// B150e (15-external-sources section 7, D174): a source-linked subscriber's address and name are
// read from the source at send time, for sequence steps and campaign batches, against the real
// PocketBase 0.40.5 binary. Observed through the subscribers, enrollments and campaigns APIs, the
// SMTP sink, and (for the campaign outage) the pushes the runner hands to the emailer.
//
// One protocol stub: `fail.from` answers the recipients view with a 503 from the n-th read on, a
// transient error at an exact point of a batch that the binary cannot produce on demand. Every
// source request also records whether a SQLite transaction was open when it was sent: none may be.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { createEnrollments } from "@/sequences/enrollments";
import type { Guard } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import type { SourceProvider } from "@/sources/project";
import { createSendTimeLookup } from "@/sources/send-time";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import type { RunnerFixture } from "@/test/campaigns/runner/fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";
import { day, hour, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase, PocketBaseRecord } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

setDefaultTimeout(120_000);

let pb: PocketBase;
beforeAll(async () => {
  pb = await startPocketBase();
  // A second recipients view whose address is a plain text field, so a user can have none.
  const users = await pb.api("GET", "/api/collections/users");
  await pb.api("PATCH", "/api/collections/users", {
    fields: [...users.fields, { name: "contact", type: "text", required: false }],
  });
  const rule = '@request.auth.collectionName = "services"';
  await pb.api("POST", "/api/collections", {
    name: "contacts",
    type: "view",
    listRule: rule,
    viewRule: rule,
    viewQuery:
      "SELECT u.id, u.contact AS email, u.name, u.marketingOptOut AS optOut FROM users u WHERE u.deletedAt = '' OR u.deletedAt IS NULL",
  });
});
/** Recipients from `contacts` (address: the `contact` text field). */
const CONTACTS: Partial<PocketBaseConfig> = {
  recipients: { collection: "contacts", email: "email", name: "name", optOut: "optOut" },
};
/** A recipients view the source does not have: every read is a 404 (a `SettingsMismatch`). */
const REFUSED: Partial<PocketBaseConfig> = {
  recipients: { collection: "nowhere", email: "email", name: "name", optOut: "" },
};
afterAll(async () => {
  await pb?.close();
});

interface Observed {
  provider: SourceProvider;
  /** The database whose open transactions the transport checks. */
  db: { current: Database | null };
  /** Source requests sent while a SQLite transaction was open (must stay empty). */
  inTransaction: Array<string>;
  /** Recipients-view reads so far. */
  reads: { count: number };
  /** From this read on (1-based), the recipients view answers 503; null: never. */
  fail: { from: number | null };
  /** Holds the next recipients-view read of `user` (the binary's answer, unchanged) until released. */
  hold: { current: { user: string; reached: () => void; released: Promise<void> } | null };
  /** Called with each recipients-view read's number as it is sent (it has passed the guard). */
  onRead: { current: (count: number) => void };
}
const observed: Array<Observed> = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const o of observed.splice(0)) {
    expect(o.inTransaction).toEqual([]);
  }
});

function observedSource(
  config: Partial<PocketBaseConfig> = {},
  guard: Guard = openGuard,
): Observed {
  const o: Observed = {
    provider: () => null,
    db: { current: null },
    inTransaction: [],
    reads: { count: 0 },
    fail: { from: null },
    hold: { current: null },
    onRead: { current: () => {} },
  };
  const source = createPocketBaseSource({
    config: { ...sourceConfig(pb.url, pb.service), ...config },
    clock: createRealClock(),
    guard,
    transport: {
      fetch(input: URL, init: RequestInit) {
        if (o.db.current?.inTransaction) {
          o.inTransaction.push(`${init.method ?? "GET"} ${input.pathname}`);
        }
        if (/^\/api\/collections\/(recipients|contacts|nowhere)\/records\//.test(input.pathname)) {
          o.reads.count++;
          o.onRead.current(o.reads.count);
          if (o.fail.from !== null && o.reads.count >= o.fail.from) {
            return Promise.resolve(new Response("unavailable", { status: 503 }));
          }
          const held = o.hold.current;
          if (held && input.pathname.endsWith(`/records/${held.user}`)) {
            o.hold.current = null;
            held.reached();
            return held.released.then(() => fetch(input, init));
          }
        }
        return fetch(input, init);
      },
    },
  });
  o.provider = () => source;
  observed.push(o);
  return o;
}

/** A mail's decoded body (quoted-printable soft breaks and escapes). */
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  return Buffer.from(
    data
      .slice(at + 4)
      .replaceAll("=\r\n", "")
      .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) => `%${hex}`),
  )
    .toString()
    .replaceAll(/(%[0-9A-F]{2})+/g, (run) => decodeURIComponent(run));
}
const emailOf = (user: PocketBaseRecord) => asBody<string>(user.email);
/** `GET /api/subscribers/:id` of a removed subscriber: listmonk's 400 for an unknown ID. */
const GONE = 400;
const fresh = () => `moved-${crypto.randomUUID().slice(0, 8)}@example.com`;

// ---------------------------------------------------------------------------------------------
// Sequence steps.

async function scheduler(
  config: Partial<PocketBaseConfig> = {},
): Promise<{ f: SchedulerFixture; o: Observed }> {
  const o = observedSource(config);
  const f = await schedulerFixture({ source: o.provider, sendTime: true });
  o.db.current = f.db;
  closers.push(() => f.close());
  return { f, o };
}
const tx = (template: number, extra: JsonObject = {}) => ({
  wait: "P1D",
  kind: "transactional",
  template_id: template,
  ...extra,
});
async function enrolled(f: SchedulerFixture, steps: Array<JsonObject>, subscriber: number) {
  const seq = await f.sequence({ source: "external", trigger: { event: "order_paid" }, steps });
  const r = await f.json("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriber,
  });
  expect(r.status).toBe(200);
  return asBody<number>(r.body.data.id);
}
const subscriberOf = async (f: SchedulerFixture, user: PocketBaseRecord) => {
  const r = await f.json(`/api/subscribers/external/${user.id}`);
  return r.status === 200
    ? asBody<{ id: number; email: string; name: string; status: string }>(r.body.data)
    : null;
};

test("a step renders with the source's current name and address; first_name in a real template", async () => {
  const { f } = await scheduler();
  const ana = await pb.user({ name: "Ana Maria" });
  const id = await f.subscriber(emailOf(ana), { external_id: ana.id, name: "Stale Name" });
  const template = await f.template(
    '<p>Hi {{ subscriber.name | first_name | default: "there" }}|{{ subscriber.email }}</p>',
  );
  const enrollment = await enrolled(f, [tx(template), tx(template), tx(template)], id);

  // Renamed in the source before the first step: the step and the subscriber take the new name.
  await pb.update("users", ana.id, { name: "Zoë Novak" });
  await f.pass(day);
  await f.until(() => f.sink.messages.length === 1, "the first step");
  expect(f.sink.messages[0]!.to).toEqual([emailOf(ana)]);
  expect(decoded(f.sink.messages[0]!.data)).toContain(`Hi Zoë|${emailOf(ana)}`);
  expect(await subscriberOf(f, ana)).toMatchObject({ id, name: "Zoë Novak" });

  // A new address mid-sequence: the next step goes there, and the subscriber keeps its ID.
  const moved = fresh();
  await pb.update("users", ana.id, { email: moved, name: "" });
  await f.pass(day);
  await f.until(() => f.sink.messages.length === 2, "the second step");
  expect(f.sink.messages[1]!.to).toEqual([moved]);
  expect(decoded(f.sink.messages[1]!.data)).toContain(`Hi there|${moved}`);
  expect(await subscriberOf(f, ana)).toMatchObject({ id, email: moved, name: "" });

  // A name that is not a first name (an address) renders the default.
  await pb.update("users", ana.id, { name: "ana@example.com" });
  await f.pass(day);
  await f.until(() => f.sink.messages.length === 3, "the third step");
  expect(decoded(f.sink.messages[2]!.data)).toContain(`Hi there|${moved}`);
  await f.until(async () => (await f.enrollment(enrollment)).status === "completed", "completed");
});

test("a user deleted from the source is removed at send time and gets nothing", async () => {
  const { f } = await scheduler();
  const bob = await pb.user({ name: "Bob" });
  const id = await f.subscriber(emailOf(bob), { external_id: bob.id });
  const template = await f.template();
  const enrollment = await enrolled(f, [tx(template)], id);
  // A hard delete: PocketBase broadcasts nothing for it, so send time is the backstop.
  await pb.remove("users", bob.id);
  await f.pass(day);
  await f.until(async () => (await subscriberOf(f, bob)) === null, "the removal");
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(GONE);
  const ended = await f.json(`/api/enrollments/${enrollment}`);
  expect(ended.status === 404 || ended.body.data.status === "canceled").toBe(true);
  await f.pass(day);
  expect(f.sink.messages).toEqual([]);
});

test("a transient source failure at send time waits with nothing sent, then sends once", async () => {
  const { f, o } = await scheduler();
  const cyd = await pb.user({ name: "Cyd" });
  const id = await f.subscriber(emailOf(cyd), { external_id: cyd.id });
  const template = await f.template();
  const enrollment = await enrolled(f, [tx(template)], id);
  o.fail.from = 1;
  await f.pass(day);
  const failed = o.reads.count;
  expect(failed).toBeGreaterThan(0);
  expect(f.sink.messages).toEqual([]);
  expect((await f.enrollment(enrollment)).status).toBe("active");
  // The retry waits the condition backoff; the source answers again.
  o.fail.from = null;
  await f.pass(3_600_000);
  await f.until(() => f.sink.messages.length === 1, "the step");
  await f.until(async () => (await f.enrollment(enrollment)).status === "completed", "completed");
  await f.pass(day);
  expect(f.sink.messages.length).toBe(1);
});

test("an address change at send time takes the conflict path: a gone holder's blocklist is carried", async () => {
  const { f } = await scheduler();
  const dee = await pb.user({ name: "Dee" });
  const id = await f.subscriber(emailOf(dee), { external_id: dee.id });
  const moved = fresh();
  // The new address is held by a blocklisted subscriber no source user owns.
  const holder = await f.subscriber(moved, { status: "blocklisted" });
  const template = await f.template();
  const enrollment = await enrolled(f, [tx(template)], id);
  await pb.update("users", dee.id, { email: moved });
  await f.pass(day);
  await f.until(async () => (await f.enrollment(enrollment)).status === "exited", "the exit");
  expect(await subscriberOf(f, dee)).toMatchObject({ id, email: moved, status: "blocklisted" });
  expect((await f.json(`/api/subscribers/${holder}`)).status).toBe(GONE);
  expect(f.sink.messages).toEqual([]);
});

test("the view's opt-out field ends a marketing step unsent with no membership change; a transactional step to the user still sends", async () => {
  const { f } = await scheduler();
  const list = await f.list("News");
  const opted = await pb.user({ name: "Opal" });
  // Already in step with the view (same address and name): the send-time read finds nothing to
  // update, and the opt-out must still be seen.
  const id = await f.subscriber(emailOf(opted), {
    name: "Opal",
    external_id: opted.id,
    lists: [list],
    preconfirm_subscriptions: true,
  });
  // Out of step with the view (a stale local name): the read updates the subscriber, and the
  // opt-out must be seen on that path too.
  const stale = await pb.user({ name: "Olga" });
  const staleId = await f.subscriber(emailOf(stale), {
    name: "Old",
    external_id: stale.id,
    lists: [list],
    preconfirm_subscriptions: true,
  });
  const template = await f.template();
  const news = await f.sequence({
    source: "external",
    list_id: list,
    trigger: { event: "order_paid" },
    steps: [{ wait: "P1D", kind: "marketing", template_id: template }],
  });
  const marketing = asBody<number>(
    (await f.json("/api/enrollments", "POST", { sequence_id: news.id, subscriber_id: id })).body
      .data.id,
  );
  const staleMarketing = asBody<number>(
    (await f.json("/api/enrollments", "POST", { sequence_id: news.id, subscriber_id: staleId }))
      .body.data.id,
  );
  const receipt = await enrolled(f, [tx(template)], id);
  // Opted out in the source after the enrollment: only the send-time read can see it.
  await pb.update("users", opted.id, { marketingOptOut: true });
  await pb.update("users", stale.id, { marketingOptOut: true });
  await f.pass(day);
  await f.until(async () => (await f.enrollment(marketing)).status !== "active", "the exit");
  await f.until(
    async () => (await f.enrollment(staleMarketing)).status !== "active",
    "the stale exit",
  );
  for (const e of [marketing, staleMarketing]) {
    expect(await f.enrollment(e)).toMatchObject({
      status: "exited",
      exit_reason: "unsubscribed",
    });
  }
  expect(await subscriberOf(f, stale)).toMatchObject({ id: staleId, name: "Olga" });
  await f.until(async () => (await f.enrollment(receipt)).status === "completed", "the receipt");
  await f.until(() => f.sink.messages.length === 1, "the receipt mail");
  await f.pass(day);
  expect(f.sink.messages.map((m) => m.to)).toEqual([[emailOf(opted)]]);
  expect(f.sink.messages[0]!.data).not.toContain("List-Unsubscribe:");
  // The source owns the flag: the list membership is left as it was.
  const lists = asBody<Array<{ id: number; subscription_status: string }>>(
    (await f.json(`/api/subscribers/${id}`)).body.data.lists,
  );
  expect(lists.find((l) => l.id === list)?.subscription_status).toBe("confirmed");
});

test("a user the source has no valid address for ends the enrollment source_error at once, with nothing sent", async () => {
  const { f } = await scheduler(CONTACTS);
  const nobody = await pb.user({ name: "Ned", contact: "" });
  const id = await f.subscriber(`ned-${crypto.randomUUID().slice(0, 8)}@example.com`, {
    external_id: nobody.id,
  });
  const template = await f.template();
  const enrollment = await enrolled(f, [tx(template)], id);
  await f.pass(day);
  await f.until(async () => (await f.enrollment(enrollment)).status !== "active", "the end");
  expect(await f.enrollment(enrollment)).toMatchObject({
    status: "exited",
    exit_reason: "source_error",
  });
  expect(f.errors.map(String).join("\n")).toContain(
    `Sequence enrollment ${enrollment} ended with source_error`,
  );
  expect(f.errors.map(String).join("\n")).toContain("has no valid address");
  expect(f.sink.messages).toEqual([]);
});

test("a recipients view the source refuses makes a step wait inside the 72-hour window, then end source_error; nothing is sent", async () => {
  const { f, o } = await scheduler(REFUSED);
  const rae = await pb.user({ name: "Rae" });
  const id = await f.subscriber(emailOf(rae), { external_id: rae.id });
  const template = await f.template();
  const enrollment = await enrolled(f, [tx(template)], id);
  await f.pass(day);
  await f.until(async () => (await f.enrollment(enrollment)).error_since !== null, "the wait");
  const failedAt = Date.parse(asBody<string>((await f.enrollment(enrollment)).error_since));
  expect(o.reads.count).toBeGreaterThan(0);
  while (f.clock.now().getTime() + hour < failedAt + 72 * hour) {
    await f.pass(hour);
  }
  expect((await f.enrollment(enrollment)).status).toBe("active");
  await f.pass(hour);
  await f.until(async () => (await f.enrollment(enrollment)).status !== "active", "the end");
  expect(await f.enrollment(enrollment)).toMatchObject({
    status: "exited",
    exit_reason: "source_error",
  });
  expect(f.sink.messages).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Campaigns.

async function runner(
  realEmailer: boolean,
  config: Partial<PocketBaseConfig> = {},
  emailAllowed: (email: string) => boolean = () => true,
  guard: Guard = openGuard,
): Promise<{ f: RunnerFixture; o: Observed }> {
  const o = observedSource(config, guard);
  const f = await runnerFixture({
    realEmailer,
    sendTime: (fixture) =>
      createSendTimeLookup({
        db: fixture.db,
        source: o.provider,
        subscribers: fixture.owners.subscribers,
        enrollments: createEnrollments(fixture.db, fixture.clock),
        emailAllowed,
      }),
  });
  o.db.current = f.db;
  closers.push(() => f.close());
  return { f, o };
}

test("a campaign batch reads names and addresses fresh; a user gone from the source is skipped and removed", async () => {
  const { f } = await runner(true);
  const list = await f.list("news");
  const renamed = await pb.user({ name: "Old" });
  const moving = await pb.user({ name: "Mo" });
  const gone = await pb.user({ name: "Gus" });
  const same = await pb.user({ name: "Sam Lee" });
  const linked = async (user: PocketBaseRecord) =>
    (await f.member(emailOf(user), [list], "confirmed", { external_id: user.id, name: "Stale" }))
      .id;
  const ids = {
    renamed: await linked(renamed),
    moving: await linked(moving),
    gone: await linked(gone),
    same: await linked(same),
  };
  // Not source-linked: never looked up, sent with its stored name.
  await f.member("local@example.test", [list], "confirmed", { name: "Lou Local" });
  await pb.update("users", renamed.id, { name: "Rita Renamed" });
  const moved = fresh();
  await pb.update("users", moving.id, { email: moved });
  await pb.remove("users", gone.id);

  const c = await f.campaign({
    name: "fresh",
    subject: 'Hello {{ subscriber.name | first_name | default: "there" }}',
    lists: [list],
    content_type: "html",
    messenger: "email",
    body: "<p>{{ subscriber.email }}</p>",
  });
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "finished");
  const mail = (await f.mail(4)).filter((m) => !m.to.includes("copy@fixture.test"));
  const subjects = Object.fromEntries(
    mail.map((m) => [m.to[0], /^Subject: (.*)$/m.exec(m.data)?.[1] ?? ""]),
  );
  expect(subjects).toEqual({
    [emailOf(renamed)]: "Hello Rita",
    [moved]: "Hello Mo",
    [emailOf(same)]: "Hello Sam",
    "local@example.test": "Hello Lou",
  });
  expect((await f.json(`/api/subscribers/${ids.gone}`)).status).toBe(GONE);
  expect(asBody<string>((await f.json(`/api/subscribers/${ids.moving}`)).body.data.email)).toBe(
    moved,
  );
  expect((await f.read(c.id)).sent).toBe(4);
});

test("a source outage in a campaign batch hands the batch back; every recipient gets the campaign exactly once", async () => {
  const { f, o } = await runner(false);
  const list = await f.list("news");
  const users: Array<PocketBaseRecord> = [];
  for (let i = 0; i < 12; i++) {
    const user = await pb.user({ name: `User ${i}` });
    users.push(user);
    await f.member(emailOf(user), [list], "confirmed", { external_id: user.id });
  }
  const c = await f.campaign({
    name: "outage",
    subject: "Hi {{ subscriber.name }}",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  // Batches of five; the outage starts at the seventh read, inside the second batch.
  f.control.grant = 5;
  o.fail.from = 7;
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  // The second batch's reads keep failing: it is handed back each time, and retried.
  await f.drive(() => o.reads.count > 20);
  const during = { pushes: f.pushes.length, status: (await f.read(c.id)).status };

  o.fail.from = null;
  await f.until(c.id, "finished");
  const counts = new Map<string, number>();
  for (const push of f.pushes) {
    counts.set(push.to, (counts.get(push.to) ?? 0) + 1);
  }
  expect(Object.fromEntries(counts)).toEqual(
    Object.fromEntries(users.map((user) => [emailOf(user), 1])),
  );
  expect((await f.read(c.id)).sent).toBe(12);
  // While the source was down the campaign stayed running and sent only the first batch, and one
  // attention line said so.
  expect(during).toEqual({ pushes: 5, status: "running" });
  expect(
    f.errors.filter((e) => e instanceof Error && e.message.includes("could not be read")).length,
  ).toBe(1);
});

/** The campaign's skipped deliveries as [subscriber id, reason], by subscriber ID. */
async function skippedOf(f: RunnerFixture, campaign: number): Promise<Array<[number, string]>> {
  const r = await f.json(`/api/campaigns/${campaign}/skipped`);
  expect(r.status).toBe(200);
  return asBody<Array<{ subscriber_id: number; reason: string }>>(r.body.data.results)
    .map((row): [number, string] => [row.subscriber_id, row.reason])
    .sort((x, y) => x[0] - y[0]);
}
const messages = (f: RunnerFixture, part: string) =>
  f.errors.filter((e) => e instanceof Error && e.message.includes(part)).length;
const pushCounts = (f: RunnerFixture) => {
  const counts: Record<string, number> = {};
  for (const push of f.pushes) {
    counts[push.to] = (counts[push.to] ?? 0) + 1;
  }
  return counts;
};

test("a campaign recipient whose view row has the opt-out field set is skipped unsubscribed, with no membership change", async () => {
  const { f } = await runner(false);
  const list = await f.list("news");
  const opted = await pb.user({ name: "Opal", marketingOptOut: true });
  const kept = await pb.user({ name: "Kit" });
  // Both already in step with the view (same address and name): the send-time read finds nothing
  // to update, and the opt-out must still be seen.
  const optedId = (
    await f.member(emailOf(opted), [list], "confirmed", { external_id: opted.id, name: "Opal" })
  ).id;
  await f.member(emailOf(kept), [list], "confirmed", { external_id: kept.id, name: "Kit" });
  // A second opted-out user with a stale local name: the read updates the name and still skips.
  const stale = await pb.user({ name: "Olga", marketingOptOut: true });
  const staleId = (
    await f.member(emailOf(stale), [list], "confirmed", { external_id: stale.id, name: "Old" })
  ).id;
  const c = await f.campaign({
    name: "opt-out",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual({ [emailOf(kept)]: 1 });
  expect(await skippedOf(f, c.id)).toEqual([
    [optedId, "unsubscribed"],
    [staleId, "unsubscribed"],
  ]);
  expect(await f.listStatus(optedId, list)).toBe("confirmed");
  expect(await f.listStatus(staleId, list)).toBe("confirmed");
  expect(asBody<string>((await f.json(`/api/subscribers/${staleId}`)).body.data.name)).toBe("Olga");
});

test("a campaign recipient the source has no valid address for is skipped subscriber_unavailable; the rest are sent once", async () => {
  const { f } = await runner(false, CONTACTS);
  const list = await f.list("news");
  const good: Array<string> = [];
  for (let i = 0; i < 3; i++) {
    const address = `good${i}-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await pb.user({ contact: address });
    await f.member(address, [list], "confirmed", { external_id: user.id });
    good.push(address);
  }
  const nobody = await pb.user({ contact: "" });
  const nobodyId = (
    await f.member(`ned-${crypto.randomUUID().slice(0, 8)}@example.com`, [list], "confirmed", {
      external_id: nobody.id,
    })
  ).id;
  const c = await f.campaign({
    name: "no address",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual(Object.fromEntries(good.map((address) => [address, 1])));
  expect(await skippedOf(f, c.id)).toEqual([[nobodyId, "subscriber_unavailable"]]);
  expect(messages(f, `subscriber ${nobodyId} skipped`)).toBe(1);
  expect(messages(f, "has no valid address")).toBe(1);
});

for (const kind of ["own address", "moved holder's address", "gone holder's address"] as const) {
  test(`a domain blocklisted while a campaign batch is read refuses an address the reads allowed (${kind}): nothing is written or sent there`, async () => {
    await policyRace(kind);
  });
}

/**
 * B155d item 1 (D179): the batch reads every recipient before it writes any, so a policy change
 * between one recipient's read and the batch's writes must be seen by the write transaction. The
 * mover's new address is in the domain (`own address`), or the mover takes an allowed address
 * whose holder's user moved into the domain (`moved holder's address`), or the mover takes an
 * address in the domain held by a subscriber whose user is gone (`gone holder's address`: not the
 * re-point a gone holder's address may skip the policy for, B163 D191). B159a (D182): the refused
 * write skips that recipient only, as the read path does; the source is up, so there is no outage
 * line, no wait and no second read of the batch.
 */
async function policyRace(
  kind: "own address" | "moved holder's address" | "gone holder's address",
) {
  const domain = `held-${crypto.randomUUID().slice(0, 8)}.example.com`;
  const blocked = new Set<string>();
  const checked = new Set<string>();
  const { f, o } = await runner(false, {}, (email) => {
    checked.add(email);
    return !blocked.has(email.slice(email.lastIndexOf("@") + 1));
  });
  const list = await f.list("news");
  const mover = await pb.user({ name: "Mo" });
  const other = await pb.user({ name: "Ot" });
  const moverAddress = emailOf(mover);
  const moverId = (await f.member(moverAddress, [list], "confirmed", { external_id: mover.id })).id;
  await f.member(emailOf(other), [list], "confirmed", { external_id: other.id });
  let target: string;
  let holder: { id: number; email: string } | null = null;
  if (kind === "own address") {
    target = `mo@${domain}`;
    await pb.update("users", mover.id, { email: target });
  } else if (kind === "gone holder's address") {
    const holderUser = await pb.user({ name: "Hol" });
    target = `hol@${domain}`;
    holder = {
      id: (await f.member(target, [], "confirmed", { external_id: holderUser.id })).id,
      email: target,
    };
    await pb.remove("users", holderUser.id);
    await pb.update("users", mover.id, { email: target });
  } else {
    const holderUser = await pb.user({ name: "Hol" });
    const wanted = emailOf(holderUser);
    holder = {
      id: (await f.member(wanted, [], "confirmed", { external_id: holderUser.id })).id,
      email: wanted,
    };
    target = `hol@${domain}`;
    await pb.update("users", holderUser.id, { email: target });
    await pb.update("users", mover.id, { email: wanted });
  }
  let reached = false;
  const released = Promise.withResolvers<void>();
  o.hold.current = {
    user: other.id,
    reached: () => {
      reached = true;
    },
    released: released.promise,
  };
  const c = await f.campaign({
    name: "policy",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  // The mover's reads have passed the policy; the other recipient's read is still out.
  await f.drive(() => reached && checked.has(target));
  blocked.add(domain);
  const releasedAt = f.clock.now().getTime();
  released.resolve();
  await f.until(c.id, "finished");

  expect(pushCounts(f)).toEqual({ [emailOf(other)]: 1 });
  expect(await skippedOf(f, c.id)).toEqual([[moverId, "subscriber_unavailable"]]);
  // Each recipients-view read once (the mover, the holder when there is one, the other): the
  // batch was not handed back and read again, and the other recipient was pushed before any
  // source wait (5 s) could have passed.
  expect(o.reads.count).toBe(holder ? 3 : 2);
  expect((f.pushes[0]?.at ?? Infinity) - releasedAt).toBeLessThan(5000);
  expect(messages(f, "could not be read")).toBe(0);
  expect(messages(f, `subscriber ${moverId} skipped`)).toBe(1);
  expect(messages(f, "blocklisted domain")).toBe(1);
  const stored = async (id: number) =>
    asBody<string>((await f.json(`/api/subscribers/${id}`)).body.data.email);
  expect(await stored(moverId)).toBe(moverAddress);
  if (holder) {
    expect(await stored(holder.id)).toBe(holder.email);
  }
}

test("a recipients view the source refuses pauses the campaign with one attention line and nothing pushed", async () => {
  const { f } = await runner(false, REFUSED);
  const list = await f.list("news");
  for (let i = 0; i < 3; i++) {
    const user = await pb.user();
    await f.member(emailOf(user), [list], "confirmed", { external_id: user.id });
  }
  const c = await f.campaign({
    name: "refused",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "paused");
  // Stays paused: nothing is claimed again until a resume.
  await f.drive(() => false, 1000, 60).catch(() => {});
  expect((await f.read(c.id)).status).toBe("paused");
  expect(f.pushes).toEqual([]);
  expect(messages(f, "the source refused a recipient read")).toBe(1);
  expect((await f.read(c.id)).sent).toBe(0);
});

test("a campaign waiting for its source retries after 5 s, doubling to a 5-minute cap, with one attention line", async () => {
  const { f, o } = await runner(false);
  const list = await f.list("news");
  const user = await pb.user();
  await f.member(emailOf(user), [list], "confirmed", { external_id: user.id });
  const c = await f.campaign({
    name: "backoff",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  o.fail.from = 1;
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  // One recipient: each attempt is one recipients-view read. The time between attempts is the
  // wait, plus at most the runner's 5 s scan and the drive's step.
  const step = 250;
  const waits = [5, 10, 20, 40, 80, 160, 300, 300].map((s) => s * 1000);
  await f.drive(() => o.reads.count >= 1, step);
  let last = f.clock.now().getTime();
  const gaps: Array<number> = [];
  for (let n = 2; n <= waits.length + 1; n++) {
    await f.drive(() => o.reads.count >= n, step, 10_000_000, 30_000);
    const now = f.clock.now().getTime();
    gaps.push(now - last);
    last = now;
  }
  for (const [i, wait] of waits.entries()) {
    expect(gaps[i]).toBeGreaterThanOrEqual(wait - step);
    expect(gaps[i]).toBeLessThanOrEqual(wait + 5000 + 4 * step);
  }
  expect(f.pushes).toEqual([]);
  expect((await f.read(c.id)).status).toBe("running");
  expect(messages(f, "could not be read")).toBe(1);
  // The source answers: the next attempt sends, once.
  o.fail.from = null;
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual({ [emailOf(user)]: 1 });
});

test("a campaign paused while it waits for its source starts afresh on resume: no leftover wait, a new attention line", async () => {
  const { f, o } = await runner(false);
  const list = await f.list("news");
  const user = await pb.user();
  await f.member(emailOf(user), [list], "confirmed", { external_id: user.id });
  const c = await f.campaign({
    name: "paused wait",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  o.fail.from = 1;
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  // Up to the 5-minute wait: the ninth read is followed by another 300 s wait.
  const step = 250;
  await f.drive(() => o.reads.count >= 9, step, 10_000_000, 30_000);
  expect(messages(f, "could not be read")).toBe(1);
  // Paused right after that read, past a scan, then resumed with the source still down.
  expect((await f.status(c.id, "paused")).status).toBe(200);
  const paused = f.clock.now().getTime();
  await f.drive(() => f.clock.now().getTime() - paused >= 10_000, step);
  const reads = o.reads.count;
  expect((await f.status(c.id, "running")).status).toBe(200);
  const resumed = f.clock.now().getTime();
  // The next read comes at the next scan, not after the rest of the old 300 s wait, and the new
  // outage writes its own attention line.
  await f.drive(() => o.reads.count > reads, step);
  expect(f.clock.now().getTime() - resumed).toBeLessThanOrEqual(5000 + 4 * step);
  expect(messages(f, "could not be read")).toBe(2);
  // The source answers: sent once.
  o.fail.from = null;
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual({ [emailOf(user)]: 1 });
  expect((await f.read(c.id)).sent).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// B166 (D194).

const plainCampaign = (f: RunnerFixture, name: string, lists: Array<number>) =>
  f.campaign({
    name,
    subject: "Hi {{ subscriber.name }}",
    lists,
    content_type: "html",
    body: "<p>x</p>",
  });
/** Holds the next recipients-view read of `user`; `reached` settles when it is out. */
function holdRead(o: Observed, user: PocketBaseRecord) {
  let reached!: () => void;
  let release!: () => void;
  const out = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  o.hold.current = { user: user.id, reached, released };
  return { out, release };
}

for (const how of ["left", "wiped"] as const) {
  test(`B166: a subscriber moving onto the address of a person who ${how === "left" ? "unsubscribed and left" : "wiped their data"} is unsubscribed from every list at the batch's lookup and gets no campaign`, async () => {
    const { f } = await runner(false);
    const news = await f.list("news");
    const other = await f.list("other");
    f.start();
    const gone = await pb.user({ name: "Gone" });
    const address = emailOf(gone);
    const goneId = (await f.member(address, [news, other], "confirmed", { external_id: gone.id }))
      .id;
    if (how === "left") {
      // Unsubscribed from one list, then gone from the source: a campaign to the other list
      // removes the subscriber and keeps the withdrawal as a suppression (D125, D173).
      const left = await f.json("/api/subscribers/lists", "PUT", {
        ids: [goneId],
        action: "unsubscribe",
        target_list_ids: [news],
      });
      expect(left.status).toBe(200);
      await pb.remove("users", gone.id);
      const first = await plainCampaign(f, "first", [other]);
      expect((await f.status(first.id, "running")).status).toBe(200);
      await f.until(first.id, "finished");
    } else {
      writeTransaction(f.db, () => f.owners.subscribers.remove([BigInt(goneId)], { wipe: true }));
      await pb.remove("users", gone.id);
    }
    expect((await f.json(`/api/subscribers/${goneId}`)).status).toBe(GONE);

    // Another user's subscriber, confirmed on both lists, takes the address in the source.
    const mover = await pb.user({ name: "Mover" });
    const moverId = (
      await f.member(emailOf(mover), [news, other], "confirmed", {
        external_id: mover.id,
        name: "Mover",
      })
    ).id;
    await pb.update("users", mover.id, { email: address });
    const c = await plainCampaign(f, "after", [news, other]);
    expect((await f.status(c.id, "running")).status).toBe(200);
    await f.until(c.id, "finished");

    expect(pushCounts(f)).toEqual({});
    expect(await skippedOf(f, c.id)).toEqual([[moverId, "unsubscribed"]]);
    const moved = asBody<{ email: string; status: string }>(
      (await f.json(`/api/subscribers/${moverId}`)).body.data,
    );
    expect(moved).toMatchObject({ email: address, status: "enabled" });
    expect(await f.listStatus(moverId, news)).toBe("unsubscribed");
    expect(await f.listStatus(moverId, other)).toBe("unsubscribed");
  });
}

test("B166: a source host the private-address block refuses mid-campaign pauses it with nothing skipped; listed again and resumed, every recipient gets it once", async () => {
  const hosts = { current: ["localhost"] };
  const { f, o } = await runner(false, { url: `http://localhost:${pb.port}` }, () => true, {
    blockPrivate: () => true,
    privateHosts: () => hosts.current,
  });
  const list = await f.list("news");
  const users: Array<PocketBaseRecord> = [];
  for (let i = 0; i < 4; i++) {
    const user = await pb.user({ name: `User ${i}` });
    users.push(user);
    await f.member(emailOf(user), [list], "confirmed", { external_id: user.id });
  }
  // Batches of two: an instance admin removes the host from `sources.private_hosts` once the
  // first batch's reads are out, so every read of the second batch is refused.
  f.control.grant = 2;
  o.onRead.current = (count) => {
    if (count === 2) {
      hosts.current = [];
    }
  };
  const c = await plainCampaign(f, "refused host", [list]);
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "paused");
  expect(f.pushes.length).toBe(2);
  expect(await skippedOf(f, c.id)).toEqual([]);
  expect(messages(f, "the source refused a recipient read")).toBe(1);
  expect(messages(f, "block_private_addresses")).toBe(1);

  hosts.current = ["localhost"];
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual(Object.fromEntries(users.map((user) => [emailOf(user), 1])));
  expect(await skippedOf(f, c.id)).toEqual([]);
  expect((await f.read(c.id)).sent).toBe(4);
});

test("B166: a subscriber updated between the claim and the lookup gets the campaign once, at the new address with the new name", async () => {
  const { f, o } = await runner(false);
  const list = await f.list("news");
  const user = await pb.user({ name: "Nina New" });
  const id = (
    await f.member(fresh(), [list], "confirmed", { external_id: user.id, name: "Old Name" })
  ).id;
  // The batch is claimed with the old values; while its lookup is out, the subscriber takes the
  // source's address and name (as the stream or a sequence step writes them), so the lookup finds
  // nothing to write.
  const held = holdRead(o, user);
  const c = await plainCampaign(f, "updated", [list]);
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.drive(async () => {
    await Promise.race([held.out, Bun.sleep(1)]);
    return o.hold.current === null;
  });
  const updated = await f.json(`/api/subscribers/${id}`, "PATCH", {
    email: emailOf(user),
    name: "Nina New",
  });
  expect(updated.status).toBe(200);
  held.release();
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual({ [emailOf(user)]: 1 });
  expect(f.pushes[0]?.message.subject).toBe("Hi Nina New");
  expect(await skippedOf(f, c.id)).toEqual([]);
});

test("B166: a subscriber whose external ID is cleared while its user's absent read is out is read again and gets the campaign once", async () => {
  const { f, o } = await runner(false);
  const list = await f.list("news");
  const user = await pb.user({ name: "Una" });
  const id = (await f.member(emailOf(user), [list], "confirmed", { external_id: user.id })).id;
  // While the read is out, the user goes from the source and an operator unlinks the subscriber.
  const held = holdRead(o, user);
  const c = await plainCampaign(f, "unlinked", [list]);
  f.start();
  expect((await f.status(c.id, "running")).status).toBe(200);
  await f.drive(async () => {
    await Promise.race([held.out, Bun.sleep(1)]);
    return o.hold.current === null;
  });
  await pb.remove("users", user.id);
  const unlinked = await f.json(`/api/subscribers/${id}`, "PATCH", { external_id: null });
  expect(unlinked.status).toBe(200);
  held.release();
  await f.until(c.id, "finished");
  expect(pushCounts(f)).toEqual({ [emailOf(user)]: 1 });
  expect(await skippedOf(f, c.id)).toEqual([]);
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(200);
});
