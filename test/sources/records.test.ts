// B150d (15-external-sources sections 3, 4, 5 and 7, D173): source records into subscribers,
// consent and leaving, through the running stream against the real PocketBase 0.40.5 binary,
// observed through the subscribers, enrollments and send-log APIs, the SMTP sink and the stream's
// retry queue. The scheduler fixture's clock is the stream's: a test moves it only while the
// stream waits, or to run the scheduler.
//
// Two transport hooks: `failRecipients` answers the recipients view with a 503, a transient error
// the binary cannot produce on demand, and `hold` delays one recipients read (the binary's answer,
// unchanged) so a test can change SQLite between the handler's reads and its write transaction.
// Every source request also records whether a SQLite
// transaction was open when it was sent: none may be (no network call inside a transaction).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeTransaction } from "@/db/transaction";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import type { RecordOutcome } from "@/sources/records";
import { createSourceRecords } from "@/sources/records-stream";
import type { SourceRecords } from "@/sources/records-stream";
import type { GrantRule } from "@/sources/settings";
import { TOPIC_CHECK_MS } from "@/sources/stream";
import { adapter } from "@/test/conditions/source-fixture";
import type { JsonObject } from "@/test/json-object";
import { asBody } from "@/test/read-body";
import { minute, schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase, PocketBaseRecord } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

setDefaultTimeout(120_000);

let pb: PocketBase;
beforeAll(async () => {
  pb = await startPocketBase();
  // A second view whose address is a plain text field, so two live users can share one address.
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
afterAll(async () => {
  await pb?.close();
});

interface Harness {
  f: SchedulerFixture;
  records: SourceRecords;
  outcomes: Array<RecordOutcome>;
  attention: Array<string>;
  /** Source requests sent while a SQLite transaction was open (must stay empty). */
  inTransaction: Array<string>;
  failRecipients: { on: boolean };
  config: { current: PocketBaseConfig };
  rules: { current: Array<GrantRule> };
  /** Holds the next recipients-view read of `user` until `released` settles (once). */
  hold: { current: { user: string; reached: () => void; released: Promise<void> } | null };
  /**
   * This test's own record name for `name`. The tests share one PocketBase, and a new stream's first
   * catch-up starts at the source's `Date` (whole seconds), so a record another test made in the
   * same second may be read; a name of its own keeps each test to its own records.
   */
  ev: (name: string) => string;
}
const open: Array<Harness> = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.records.stop();
    await h.f.close();
    expect(h.inTransaction).toEqual([]);
  }
});

async function start(
  options: { config?: Partial<PocketBaseConfig>; rules?: Array<GrantRule> } = {},
): Promise<Harness> {
  const f = await schedulerFixture({ source: () => adapter(pb) });
  const outcomes: Array<RecordOutcome> = [];
  const attention: Array<string> = [];
  const inTransaction: Array<string> = [];
  const failRecipients = { on: false };
  const config = { current: { ...sourceConfig(pb.url, pb.service), ...options.config } };
  const rules = { current: options.rules ?? [] };
  const hold: Harness["hold"] = { current: null };
  const records = createSourceRecords({
    db: f.db,
    clock: f.clock,
    logger: {
      attention: (message) => attention.push(message),
      error: (error) => attention.push(`error: ${String(error)}`),
    },
    config: () => config.current,
    grantRules: () => rules.current,
    guard: openGuard,
    transport: {
      fetch(input: URL, init: RequestInit) {
        if (f.db.inTransaction) {
          inTransaction.push(`${init.method ?? "GET"} ${input.pathname}`);
        }
        if (
          failRecipients.on &&
          /^\/api\/collections\/(recipients|contacts)\/records\//.test(input.pathname)
        ) {
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        const held = hold.current;
        if (held && input.pathname === `/api/collections/recipients/records/${held.user}`) {
          hold.current = null;
          held.reached();
          return held.released.then(() => fetch(input, init));
        }
        return fetch(input, init);
      },
    },
    subscribers: f.stores.subscribers,
    enrollments: f.stores.enrollments,
    emailAllowed: () => true,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  records.start();
  const tag = crypto.randomUUID().slice(0, 8);
  const h: Harness = {
    f,
    records,
    outcomes,
    attention,
    inTransaction,
    failRecipients,
    config,
    rules,
    hold,
    ev: (name) => `${name}_${tag}`,
  };
  open.push(h);
  // Live, or idle when nothing is subscribed: the first session has read its names.
  await until(
    h,
    () => ["live", "idle"].includes(h.records.stream()?.state().state ?? ""),
    "the first session",
  );
  return h;
}

/** Waits (real time) for `check`; while the stream waits to reconnect, the clock moves on. */
async function until(h: Harness, check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what} (stream ${JSON.stringify(h.records.stream()?.state())})`,
      );
    }
    if (h.records.stream()?.state().state === "waiting") {
      h.f.clock.advance(1000);
    }
    await Bun.sleep(10);
  }
}
const live = (h: Harness) =>
  until(h, () => h.records.stream()?.state().state === "live", "the stream to be live");
const handled = (h: Harness, record: { id: string }) =>
  until(h, () => h.outcomes.some((o) => o.record === record.id), `record ${record.id}`);
const outcome = (h: Harness, record: { id: string }) => {
  const found = h.outcomes.find((o) => o.record === record.id);
  if (!found) {
    throw new Error(`no outcome for ${record.id}`);
  }
  return found;
};

/** An events record at the fixture clock's time, under this test's own name for `name`. */
const record = (h: Harness, user: PocketBaseRecord, name: string, data: JsonObject = {}) =>
  pb.event(user.id, h.ev(name), data, { occurredAt: h.f.clock.now().toISOString() });

type Subscriber = {
  id: number;
  email: string;
  name: string;
  status: string;
  external_id: string | null;
  lists: Array<{ id: number; subscription_status: string }>;
};
const emailOf = (user: PocketBaseRecord) => asBody<string>(user.email);
/** The subscriber linked to a source user, or null. */
async function linked(h: Harness, user: PocketBaseRecord) {
  const r = await h.f.json(`/api/subscribers/external/${user.id}`);
  return r.status === 200 ? asBody<Subscriber>(r.body.data) : null;
}
async function byId(h: Harness, id: number) {
  const r = await h.f.json(`/api/subscribers/${id}`);
  return r.status === 200 ? asBody<Subscriber>(r.body.data) : null;
}
const statusOn = (s: Subscriber | null, list: number) =>
  s?.lists.find((l) => l.id === list)?.subscription_status ?? null;
async function enrollmentsOf(h: Harness, subscriber: number) {
  const r = await h.f.json(`/api/enrollments?subscriber_id=${subscriber}&per_page=50`);
  return asBody<{ results: Array<Record<string, any>> }>(r.body.data).results;
}
async function createSubscriber(h: Harness, body: JsonObject) {
  const r = await h.f.json("/api/subscribers", "POST", { name: "Holder", ...body });
  if (r.status !== 200) {
    throw new Error(JSON.stringify(r.body));
  }
  return asBody<number>(r.body.data.id);
}
const unsubscribe = (h: Harness, id: number, list: number) =>
  h.f.json("/api/subscribers/lists", "PUT", {
    ids: [id],
    action: "unsubscribe",
    target_list_ids: [list],
  });
const tx = (template: number, extra: JsonObject = {}) => ({
  wait: "P1D",
  kind: "transactional",
  template_id: template,
  ...extra,
});
/** Waits until the stream has subscribed to the sequences' names as they are now. */
async function resubscribed(h: Harness) {
  const before = h.records.stream()?.state().sessions ?? 0;
  h.f.clock.advance(TOPIC_CHECK_MS);
  await until(h, () => (h.records.stream()?.state().sessions ?? 0) > before, "a new session");
  await live(h);
}

test("a subscribed record creates the subscriber from the view and starts the external sequence; an unsubscribed name creates nothing", async () => {
  const h = await start();
  const template = await h.f.template();
  const seq = await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid"), where: { "data.plan": "pro" } },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user({ name: "  Ana Maria  " });
  const bob = await pb.user();
  const cyd = await pb.user();
  await record(h, bob, "page_view");
  // Strict data match: "1" is not 1, and a plan other than "pro" does not start the sequence.
  const other = await record(h, cyd, "order_paid", { plan: "basic" });
  const paid = await record(h, ana, "order_paid", { plan: "pro" });
  await handled(h, paid);
  await handled(h, other);

  expect(h.outcomes.map((o) => o.record)).not.toContain(bob.id);
  expect(await linked(h, bob)).toBeNull();
  expect(await linked(h, cyd)).toBeNull();
  const subscriber = await linked(h, ana);
  expect(subscriber).toMatchObject({ email: ana.email, name: "Ana Maria", status: "enabled" });
  expect(outcome(h, other)).toMatchObject({ kind: "exits", subscriberId: null });

  const [enrollment] = await enrollmentsOf(h, subscriber?.id ?? 0);
  expect(enrollment).toMatchObject({
    sequence_id: seq.id,
    status: "active",
    trigger_external_id: paid.id,
    trigger_occurred_at: h.f.clock.now().toISOString(),
  });
});

test("trigger.condition is read before the write and counts the trigger; exit_on ends an external enrollment", async () => {
  const h = await start();
  const template = await h.f.template();
  const seq = await h.f.sequence({
    source: "external",
    trigger: {
      event: h.ev("order_paid"),
      condition: { event: h.ev("order_paid"), count: { gte: 2 } },
    },
    exit_on: [h.ev("refunded")],
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const first = await record(h, ana, "order_paid");
  await handled(h, first);
  // One order: the condition is false, and nothing is created for it.
  expect(outcome(h, first)).toMatchObject({ kind: "exits", started: 0 });
  expect(await linked(h, ana)).toBeNull();

  const second = await record(h, ana, "order_paid");
  await handled(h, second);
  expect(outcome(h, second)).toMatchObject({ kind: "written", started: 1 });
  const subscriber = await linked(h, ana);
  expect((await enrollmentsOf(h, subscriber?.id ?? 0))[0]).toMatchObject({
    sequence_id: seq.id,
    status: "active",
    trigger_external_id: second.id,
  });

  const refund = await record(h, ana, "refunded");
  await handled(h, refund);
  expect(outcome(h, refund)).toMatchObject({ kind: "exits", ended: 1 });
  expect((await enrollmentsOf(h, subscriber?.id ?? 0))[0]).toMatchObject({
    status: "exited",
    exit_reason: `event:${h.ev("refunded")}`,
  });
});

test("grant_lists: added, and refused for opt-out, unsubscribe, suppression, blocklist, double opt-in and a deleted list", async () => {
  const h = await start();
  const news = await h.f.list("News");
  const double = await h.f.list("Double", "double");
  const gone = await h.f.list("Gone");
  await h.f.json(`/api/lists/${gone}`, "DELETE");
  h.rules.current = [
    { event: h.ev("signup"), where: {}, lists: [news, double, gone] },
    // Strict: a text "1" in the data is not the number 1.
    { event: h.ev("signup"), where: { "data.tier": 1 }, lists: [news] },
  ];
  await resubscribed(h);

  const plain = await pb.user();
  const optedOut = await pb.user({ marketingOptOut: true });
  const left = await pb.user();
  const blocked = await pb.user();
  const suppressed = await pb.user();
  const leftId = await createSubscriber(h, {
    email: emailOf(left),
    external_id: left.id,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, leftId, news);
  await createSubscriber(h, {
    email: emailOf(blocked),
    external_id: blocked.id,
    status: "blocklisted",
  });
  const suppressedId = await createSubscriber(h, {
    email: emailOf(suppressed),
    external_id: suppressed.id,
  });
  // The public "all lists" option leaves a suppression (D125, D128).
  writeTransaction(h.f.db, () => h.f.stores.subscribers.unsubscribeAll(BigInt(suppressedId)));

  const results = new Map<string, Array<{ list_id: number; result: string }>>();
  for (const user of [plain, optedOut, left, blocked, suppressed]) {
    const signup = await record(h, user, "signup", { tier: "1" });
    await handled(h, signup);
    results.set(user.id, outcome(h, signup).grants);
  }
  const at = (user: PocketBaseRecord) => results.get(user.id);
  expect(at(plain)).toEqual([
    { list_id: news, result: "added" },
    { list_id: double, result: "unavailable" },
    { list_id: gone, result: "unavailable" },
  ]);
  expect(at(optedOut)?.[0]).toEqual({ list_id: news, result: "opted_out" });
  expect(at(left)?.[0]).toEqual({ list_id: news, result: "unsubscribed" });
  expect(at(blocked)?.[0]).toEqual({ list_id: news, result: "blocklisted" });
  expect(at(suppressed)?.[0]).toEqual({ list_id: news, result: "suppressed" });

  expect(statusOn(await linked(h, plain), news)).toBe("confirmed");
  expect(statusOn(await linked(h, plain), double)).toBeNull();
  expect(statusOn(await linked(h, optedOut), news)).toBeNull();
  // A grant never overrides an unsubscribe.
  expect(statusOn(await linked(h, left), news)).toBe("unsubscribed");
  expect(statusOn(await linked(h, blocked), news)).toBeNull();
  expect(statusOn(await linked(h, suppressed), news)).toBeNull();
});

test("a zero-wait marketing step sees the record's grant", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("order_paid"), where: {}, lists: [news] }];
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    list_id: news,
    trigger: { event: h.ev("order_paid") },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await handled(h, paid);
  expect(outcome(h, paid).grants).toEqual([{ list_id: news, result: "added" }]);
  await h.f.pass(0);
  await h.f.until(
    async () => (await h.f.sendLog()).some((row) => row.status !== "sending"),
    "the step's send",
  );
  const log = await h.f.sendLog();
  expect(log.map((row) => row.status)).toEqual(["sent"]);
  const subscriber = await linked(h, ana);
  expect((await enrollmentsOf(h, subscriber?.id ?? 0))[0]).toMatchObject({ status: "completed" });
});

test("address conflict: a holder whose user moved to another address follows it", async () => {
  const h = await start({ rules: [] });
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const holderUser = await pb.user();
  const address = emailOf(holderUser);
  const holder = await createSubscriber(h, { email: address, external_id: holderUser.id });
  const moved = `moved-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await pb.update("users", holderUser.id, { email: moved });
  const incoming = await pb.user({ email: address });
  const signup = await record(h, incoming, "signup");
  await handled(h, signup);

  expect(await byId(h, holder)).toMatchObject({ email: moved, external_id: holderUser.id });
  const created = await linked(h, incoming);
  expect(created).toMatchObject({ email: address });
  expect(created?.id).not.toBe(holder);
});

test("address conflict: a holder whose person is gone is re-pointed to a new user, keeping its blocklist and unsubscribes", async () => {
  const h = await start();
  const news = await h.f.list("News");
  const other = await h.f.list("Other");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news, other] }];
  const template = await h.f.template();
  const old = await h.f.sequence({ trigger: { event: "visit" }, steps: [tx(template)] });
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  // A holder without an external ID (an import), unsubscribed from News, then blocklisted.
  const holder = await createSubscriber(h, {
    email: address,
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, holder, news);
  await h.f.json("/api/subscribers/blocklist", "PUT", { ids: [holder] });
  // A second holder, unsubscribed only, with an enrollment of its former person running.
  const second = await pb.user();
  const secondHolder = await createSubscriber(h, {
    email: emailOf(second),
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, secondHolder, news);
  const enrolled = await h.f.json("/api/enrollments", "POST", {
    sequence_id: old.id,
    subscriber_id: secondHolder,
  });
  expect(enrolled.status).toBe(200);
  const signup = await record(h, incoming, "signup");
  const secondSignup = await record(h, second, "signup");
  await handled(h, signup);
  await handled(h, secondSignup);

  const row = await byId(h, holder);
  expect(row).toMatchObject({ external_id: incoming.id, email: address, status: "blocklisted" });
  expect(statusOn(row, news)).toBe("unsubscribed");
  expect(statusOn(row, other)).toBeNull();
  expect(outcome(h, signup).grants.map((g) => g.result)).toEqual(["blocklisted", "blocklisted"]);

  const repointed = await byId(h, secondHolder);
  expect(repointed).toMatchObject({ external_id: second.id, status: "enabled" });
  expect(statusOn(repointed, news)).toBe("unsubscribed");
  expect(statusOn(repointed, other)).toBe("confirmed");
  // The former person's enrollment ended before the row became the incoming user's.
  expect((await enrollmentsOf(h, secondHolder))[0]).toMatchObject({
    sequence_id: old.id,
    status: "canceled",
    exit_reason: "subscriber_deleted",
  });
});

test("address conflict: a gone holder's blocklist and unsubscribes are carried onto the incoming user's row, and the holder is deleted", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  const oldAddress = `old-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const own = await createSubscriber(h, { email: oldAddress, external_id: incoming.id });
  // The holder's user is not in the view (an ID the source never had).
  const holder = await createSubscriber(h, {
    email: address,
    external_id: "ghostuser000001",
    lists: [news],
    preconfirm_subscriptions: true,
  });
  await unsubscribe(h, holder, news);
  await h.f.json("/api/subscribers/blocklist", "PUT", { ids: [holder] });
  expect((await byId(h, holder))?.status).toBe("blocklisted");
  const signup = await record(h, incoming, "signup");
  await handled(h, signup);

  expect(await byId(h, holder)).toBeNull();
  const row = await byId(h, own);
  expect(row).toMatchObject({ email: address, external_id: incoming.id, status: "blocklisted" });
  expect(statusOn(row, news)).toBe("unsubscribed");
  expect(outcome(h, signup).grants).toEqual([{ list_id: news, result: "blocklisted" }]);
});

test("address conflict: two live users with one address are a terminal conflict in attention, with nothing written", async () => {
  const h = await start({
    config: {
      recipients: { collection: "contacts", email: "email", name: "name", optOut: "optOut" },
    },
  });
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const shared = `shared-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const first = await pb.user({ contact: shared });
  const second = await pb.user({ contact: shared });
  const holder = await createSubscriber(h, { email: shared, external_id: first.id });
  const signup = await record(h, second, "signup");
  await until(
    h,
    () => (h.records.stream()?.retries() ?? []).some((row) => row.record_id === signup.id),
    "the terminal row",
  );
  const row = h.records
    .stream()
    ?.retries()
    .find((entry) => entry.record_id === signup.id);
  expect(Boolean(row?.terminal)).toBe(true);
  expect(h.attention.join("\n")).toContain("Two users in the source have one address");
  expect(await linked(h, second)).toBeNull();
  expect(await byId(h, holder)).toMatchObject({ email: shared, external_id: first.id });
});

test("a user leaving in real time ends the enrollments and removes the subscriber", async () => {
  const h = await start();
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await handled(h, paid);
  const subscriber = await linked(h, ana);
  expect((await enrollmentsOf(h, subscriber?.id ?? 0)).length).toBe(1);
  await pb.update("users", ana.id, { deletedAt: new Date().toISOString() });
  await until(h, () => h.outcomes.some((o) => o.record === ana.id && o.kind === "left"), "leaving");
  expect(await byId(h, subscriber?.id ?? 0)).toBeNull();
  expect(await enrollmentsOf(h, subscriber?.id ?? 0)).toEqual([]);
});

test("leaving keeps withdrawn consent: a returning user who unsubscribed or was blocklisted is refused the grant and gets no marketing; one who withdrew nothing is granted again", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("order_paid"), where: {}, lists: [news] }];
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    list_id: news,
    trigger: { event: h.ev("order_paid") },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  await resubscribed(h);
  const left = await pb.user();
  const blocked = await pb.user();
  const plain = await pb.user();
  for (const user of [left, plain]) {
    await createSubscriber(h, {
      email: emailOf(user),
      external_id: user.id,
      lists: [news],
      preconfirm_subscriptions: true,
    });
  }
  const leftRow = await linked(h, left);
  await unsubscribe(h, leftRow?.id ?? 0, news);
  // Blocklisted with no membership at all: the status alone is the withdrawal.
  await createSubscriber(h, {
    email: emailOf(blocked),
    external_id: blocked.id,
    status: "blocklisted",
  });

  for (const user of [left, blocked, plain]) {
    await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
    await until(
      h,
      () => h.outcomes.some((o) => o.record === user.id && o.kind === "left"),
      "leaving",
    );
    expect(await linked(h, user)).toBeNull();
  }
  // Each comes back: the account restored, and a new record for it.
  const paid = new Map<string, { id: string }>();
  for (const user of [left, blocked, plain]) {
    await pb.update("users", user.id, { deletedAt: "" });
    const order = await record(h, user, "order_paid");
    await handled(h, order);
    paid.set(user.id, order);
  }
  const at = (user: PocketBaseRecord) => outcome(h, paid.get(user.id) ?? { id: "" });
  expect(at(left)).toMatchObject({ grants: [{ list_id: news, result: "suppressed" }], started: 0 });
  expect(at(blocked)).toMatchObject({
    grants: [{ list_id: news, result: "suppressed" }],
    started: 0,
  });
  expect(at(plain)).toMatchObject({ grants: [{ list_id: news, result: "added" }], started: 1 });
  expect(statusOn(await linked(h, left), news)).toBeNull();
  expect(statusOn(await linked(h, blocked), news)).toBeNull();
  expect(statusOn(await linked(h, plain), news)).toBe("confirmed");

  await h.f.pass(0);
  await h.f.until(
    async () => (await h.f.sendLog()).some((row) => row.status !== "sending"),
    "the step's send",
  );
  const log = await h.f.sendLog();
  expect(log.map((row) => [row.subscriber_id, row.status])).toEqual([
    [(await linked(h, plain))?.id ?? 0, "sent"],
  ]);
});

test("a subscriber row changed between the record's reads and its transaction rolls the write back and retries it", async () => {
  const h = await start();
  const news = await h.f.list("News");
  h.rules.current = [{ event: h.ev("signup"), where: {}, lists: [news] }];
  await resubscribed(h);
  const incoming = await pb.user();
  const address = emailOf(incoming);
  // The address's holder names a user the view does not have: its read decides "gone".
  const ghost = "ghostuser000002";
  const holder = await createSubscriber(h, { email: address, external_id: ghost });
  const atHold = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  h.hold.current = { user: ghost, reached: atHold.resolve, released: released.promise };
  const signup = await record(h, incoming, "signup");
  await atHold.promise;
  // While the holder's read is out, the incoming user's own subscriber is created.
  const own = await createSubscriber(h, {
    email: `own-${crypto.randomUUID().slice(0, 8)}@example.com`,
    external_id: incoming.id,
  });
  released.resolve();
  await until(
    h,
    () => (h.records.stream()?.retries() ?? []).some((row) => row.record_id === signup.id),
    "the rolled-back record",
  );
  expect(Boolean(h.records.stream()?.retries()[0]?.terminal)).toBe(false);
  expect(h.outcomes.some((o) => o.record === signup.id)).toBe(false);
  expect(await byId(h, holder)).toMatchObject({ email: address, external_id: ghost });

  h.f.clock.advance(minute + 1000);
  h.records.stream()?.wakeRetries();
  await handled(h, signup);
  // The retry read again and carried the gone holder onto the user's own row.
  expect(await byId(h, holder)).toBeNull();
  const row = await byId(h, own);
  expect(row).toMatchObject({ email: address, external_id: incoming.id });
  expect(statusOn(row, news)).toBe("confirmed");
  expect(h.records.stream()?.retries()).toEqual([]);
});

test("a failed settings switch does not stop later ones: the next change applies and stop() stops the stream", async () => {
  const h = await start();
  const first = h.records.stream();
  Object.defineProperty(h.config, "current", {
    configurable: true,
    get() {
      throw new Error("settings unreadable");
    },
  });
  const failed = await h.records.refresh().then(
    () => null,
    (error: unknown) => error,
  );
  expect(String(failed)).toContain("settings unreadable");
  Object.defineProperty(h.config, "current", {
    configurable: true,
    writable: true,
    value: { ...sourceConfig(pb.url, pb.service), users: { collection: "", leavingFilter: "" } },
  });
  await h.records.refresh();
  const second = h.records.stream();
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  expect(first?.state().state).toBe("stopped");
  await h.records.stop();
  expect(second?.state().state).toBe("stopped");
  expect(h.records.stream()).toBeNull();
});

test("a record whose user the recipients view no longer has creates nothing and removes a linked subscriber", async () => {
  // No users topic: only the record's own recipient read sees the user gone.
  const h = await start({ config: { users: { collection: "", leavingFilter: "" } } });
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const bob = await pb.user();
  const bobId = await createSubscriber(h, { email: emailOf(bob), external_id: bob.id });
  for (const user of [ana, bob]) {
    await pb.update("users", user.id, { deletedAt: new Date().toISOString() });
  }
  const anaPaid = await record(h, ana, "order_paid");
  const bobPaid = await record(h, bob, "order_paid");
  await handled(h, anaPaid);
  await handled(h, bobPaid);
  expect(outcome(h, anaPaid)).toMatchObject({ kind: "left", subscriberId: null });
  expect(outcome(h, bobPaid)).toMatchObject({ kind: "left" });
  expect(await linked(h, ana)).toBeNull();
  expect(await byId(h, bobId)).toBeNull();
});

test("a transient failure of the recipient read queues the record with nothing written; the retry writes it", async () => {
  const h = await start();
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  h.failRecipients.on = true;
  const paid = await record(h, ana, "order_paid");
  await until(
    h,
    () => (h.records.stream()?.retries() ?? []).some((row) => row.record_id === paid.id),
    "the queued record",
  );
  expect(Boolean(h.records.stream()?.retries()[0]?.terminal)).toBe(false);
  expect(await linked(h, ana)).toBeNull();
  h.failRecipients.on = false;
  h.f.clock.advance(minute + 1000);
  h.records.stream()?.wakeRetries();
  await handled(h, paid);
  expect((await linked(h, ana))?.email).toBe(emailOf(ana));
  expect(h.records.stream()?.retries()).toEqual([]);
});

test("a recipients view the settings misname refuses the stream without consuming the record; fixing the settings delivers it", async () => {
  const h = await start({
    config: { recipients: { collection: "nowhere", email: "email", name: "name", optOut: "" } },
  });
  const template = await h.f.template();
  await h.f.sequence({
    source: "external",
    trigger: { event: h.ev("order_paid") },
    steps: [tx(template)],
  });
  await resubscribed(h);
  const ana = await pb.user();
  const paid = await record(h, ana, "order_paid");
  await until(h, () => h.attention.some((line) => line.includes("refused")), "the refusal");
  expect(h.records.stream()?.retries()).toEqual([]);
  expect(await linked(h, ana)).toBeNull();
  h.config.current = sourceConfig(pb.url, pb.service);
  await h.records.refresh();
  await live(h);
  await handled(h, paid);
  expect((await linked(h, ana))?.email).toBe(emailOf(ana));
});
