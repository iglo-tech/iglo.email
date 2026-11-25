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
import { createEnrollments } from "@/sequences/enrollments";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { SourceProvider } from "@/sources/project";
import { createSendTimeLookup } from "@/sources/send-time";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import type { RunnerFixture } from "@/test/campaigns/runner/fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";
import { day, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase, PocketBaseRecord } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

setDefaultTimeout(120_000);

let pb: PocketBase;
beforeAll(async () => {
  pb = await startPocketBase();
});
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

function observedSource(): Observed {
  const o: Observed = {
    provider: () => null,
    db: { current: null },
    inTransaction: [],
    reads: { count: 0 },
    fail: { from: null },
  };
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: openGuard,
    transport: {
      fetch(input: URL, init: RequestInit) {
        if (o.db.current?.inTransaction) {
          o.inTransaction.push(`${init.method ?? "GET"} ${input.pathname}`);
        }
        if (/^\/api\/collections\/recipients\/records\//.test(input.pathname)) {
          o.reads.count++;
          if (o.fail.from !== null && o.reads.count >= o.fail.from) {
            return Promise.resolve(new Response("unavailable", { status: 503 }));
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

async function scheduler(): Promise<{ f: SchedulerFixture; o: Observed }> {
  const o = observedSource();
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

// ---------------------------------------------------------------------------------------------
// Campaigns.

async function runner(realEmailer: boolean): Promise<{ f: RunnerFixture; o: Observed }> {
  const o = observedSource();
  const f = await runnerFixture({
    realEmailer,
    sendTime: (fixture) =>
      createSendTimeLookup({
        db: fixture.db,
        source: o.provider,
        subscribers: fixture.owners.subscribers,
        enrollments: createEnrollments(fixture.db, fixture.clock),
        emailAllowed: () => true,
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
